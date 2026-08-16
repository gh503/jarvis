import assert from 'node:assert/strict'
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

const created = await request('/v1/conversations', { method: 'POST', headers: sessionHeaders })
assert.equal(created.response.status, 201)
assert.match(created.body.conversation.id, /^session-[A-Za-z0-9-]+$/)

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

console.log('Gateway-to-Harness runtime verification passed without invoking a model')
