import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { createDeviceIdentity } from '../dist/pairing.js'

const gateway = process.env.JARVIS_GATEWAY_URL
const ownerToken = process.env.JARVIS_OWNER_TOKEN
if (gateway === undefined || ownerToken === undefined) throw new Error('runtime Gateway URL and Owner token are required')

async function request(path, options = {}) {
  const response = await fetch(`${gateway}${path}`, options)
  const text = await response.text()
  assert.match(response.headers.get('x-correlation-id') ?? '', /^[0-9a-f-]{36}$/)
  return { response, text, body: text.length === 0 ? undefined : JSON.parse(text) }
}

async function openEvents(accessToken, cursor) {
  const endpoint = `${gateway.replace(/^http/, 'ws')}/v1/events`
  const socket = new WebSocket(endpoint)
  const queued = []
  const waiters = []
  socket.on('message', data => {
    const value = JSON.parse(data.toString())
    const waiter = waiters.shift()
    if (waiter === undefined) queued.push(value)
    else waiter(value)
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({
    type: 'events.authenticate',
    accessToken,
    ...(cursor === undefined ? {} : { cursor }),
  }))
  return {
    socket,
    next(timeoutMs = 5_000) {
      const value = queued.shift()
      if (value !== undefined) return Promise.resolve(value)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for Gateway event')), timeoutMs)
        waiters.push(event => {
          clearTimeout(timer)
          resolve(event)
        })
      })
    },
    close() {
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
      return new Promise(resolve => {
        socket.once('close', resolve)
        socket.close()
      })
    },
  }
}

async function nextMatching(events, predicate) {
  for (let count = 0; count < 20; count += 1) {
    const event = await events.next()
    if (predicate(event)) return event
  }
  throw new Error('expected Gateway event was not observed')
}

const identity = createDeviceIdentity()
const ownerHeaders = { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }
const pairing = await request('/v1/pairing/requests', {
  method: 'POST',
  headers: ownerHeaders,
  body: JSON.stringify({
    nodeId: 'runtime-node',
    publicKey: identity.publicKey,
    displayName: 'Runtime verifier',
    platform: 'macos',
  }),
})
assert.equal(pairing.response.status, 201)

const confirmed = await request('/v1/pairing/requests/confirm', {
  method: 'POST',
  headers: ownerHeaders,
  body: JSON.stringify({ requestId: pairing.body.requestId, verificationCode: pairing.body.verificationCode }),
})
assert.equal(confirmed.response.status, 200)

const issued = await request('/v1/sessions', {
  method: 'POST',
  headers: { authorization: `Device ${confirmed.body.credential}`, 'content-type': 'application/json' },
  body: JSON.stringify({ nodeId: 'runtime-node' }),
})
assert.equal(issued.response.status, 201)
const sessionHeaders = { authorization: `Session ${issued.body.accessToken}` }

const events = await openEvents(issued.body.accessToken)
const ready = await events.next()
assert.equal(ready.type, 'events.ready')
assert.match(ready.cursor, /^[A-Za-z0-9_-]{22}\.[0-9]+$/)
if (ready.reason === 'harness_unavailable') {
  await nextMatching(events, event => event.type === 'sync.required' && event.reason === 'gateway_restarted')
}

const created = await request('/v1/conversations', { method: 'POST', headers: sessionHeaders })
assert.equal(created.response.status, 201)
assert.match(created.body.conversation.id, /^session-[A-Za-z0-9-]+$/)
const createdEvent = await nextMatching(events, event => event.type === 'conversation.created'
  && event.conversation.id === created.body.conversation.id)
assert.deepEqual(createdEvent.conversation, { id: created.body.conversation.id, blank: true })
assert.doesNotMatch(JSON.stringify(createdEvent), /cwd|agentPreset|projections|reasoning|tool\//)
events.socket.send(JSON.stringify({ type: 'events.ack', cursor: createdEvent.cursor }))

const listed = await request('/v1/conversations', { headers: sessionHeaders })
assert.equal(listed.response.status, 200)
assert.equal(listed.body.conversations.some(item => item.id === created.body.conversation.id), true)
assert.doesNotMatch(listed.text, /"cwd"|"agentPreset"|"projections"/)

const history = await request(`/v1/conversations/${created.body.conversation.id}?maxMessages=10`, { headers: sessionHeaders })
assert.equal(history.response.status, 200)
assert.deepEqual(history.body.messages, [])
assert.equal(history.body.hasMore, false)
assert.equal(history.body.nextBeforeSequence, null)
assert.doesNotMatch(history.text, /"events"|"projections"|"tool\/|"reasoning"/)

await events.close()
const resumedEvents = await openEvents(issued.body.accessToken, ready.cursor)
const resumedReady = await resumedEvents.next()
assert.equal(resumedReady.type, 'events.ready')
assert.equal(resumedReady.requiresSnapshot, false)
assert.equal(resumedReady.replayCount >= 1, true)
const replayed = await nextMatching(resumedEvents, event => event.eventId === createdEvent.eventId)
assert.deepEqual(replayed, createdEvent)
await resumedEvents.close()

console.log('Gateway-to-Harness HTTP and retained-event runtime verification passed without invoking a model')
