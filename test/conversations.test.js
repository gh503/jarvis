import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationsClient } from '../web/conversations.js'

const cursor = `${'A'.repeat(22)}.1`
const conversation = { id: 'session-one', title: 'Jarvis plan', updatedAt: 1_000, running: false, blank: false }
const message = { id: 'message-one', sequence: 1, createdAt: 1_000, role: 'assistant', text: 'Ready' }

function memoryStore() {
  const values = new Map()
  return {
    values,
    read: async key => structuredClone(values.get(key)),
    write: async (key, value) => { values.set(key, structuredClone(value)) },
    delete: async key => { values.delete(key) },
  }
}

class FakeSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? []
    listeners.push(listener)
    this.listeners.set(name, listeners)
  }

  dispatch(name, value = {}) {
    for (const listener of this.listeners.get(name) ?? []) listener(value)
  }

  open() {
    this.readyState = 1
    this.dispatch('open')
  }

  message(value) {
    this.dispatch('message', { data: JSON.stringify(value) })
  }

  send(value) {
    this.sent.push(JSON.parse(value))
  }

  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatch('close')
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

function gatewayPairing(calls, overrides = {}) {
  return {
    accessSession: async force => {
      calls.push(['session', force])
      return { accessToken: 'S'.repeat(43) }
    },
    authenticatedRequest: async (path, init = {}) => {
      calls.push(['request', path, init.method ?? 'GET'])
      if (overrides.request !== undefined) {
        const result = await overrides.request(path, init)
        if (result !== undefined) return result
      }
      if (path === '/v1/conversations') return { ok: true, status: 200, value: { conversations: [conversation] } }
      if (path.startsWith('/v1/conversations/session-one?')) {
        return { ok: true, status: 200, value: { messages: [message], hasMore: false, nextBeforeSequence: null } }
      }
      throw new Error(`unexpected request ${path}`)
    },
  }
}

test('loads an authenticated snapshot and keeps the access token out of the event URL', async () => {
  const calls = []
  const states = []
  const sockets = []
  const store = memoryStore()
  const client = new ConversationsClient(gatewayPairing(calls), state => states.push(state), {
    store,
    location: { origin: 'https://jarvis.internal' },
    socketFactory: url => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
  })
  await client.start()
  await tick()

  assert.equal(states.at(-1).phase, 'ready')
  assert.equal(states.at(-1).selectedId, 'session-one')
  assert.deepEqual(states.at(-1).messages, [message])
  assert.equal(sockets[0].url, 'wss://jarvis.internal/v1/events')
  assert.doesNotMatch(sockets[0].url, /S{10}/)

  sockets[0].open()
  await tick()
  assert.deepEqual(sockets[0].sent[0], { type: 'events.authenticate', accessToken: 'S'.repeat(43) })
  sockets[0].message({ type: 'events.ready', cursor, replayCount: 0, requiresSnapshot: false })
  await tick()
  assert.equal(store.values.get('event-cursor'), cursor)
})

test('refreshes the authoritative snapshot when the event stream requires synchronization', async () => {
  const calls = []
  const sockets = []
  const client = new ConversationsClient(gatewayPairing(calls), () => {}, {
    store: memoryStore(),
    location: { origin: 'http://127.0.0.1:3190' },
    socketFactory: url => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
  })
  await client.start()
  await tick()
  const initialLists = calls.filter(call => call[1] === '/v1/conversations').length
  sockets[0].open()
  sockets[0].message({ type: 'events.ready', cursor, replayCount: 0, requiresSnapshot: true, reason: 'initial' })
  await tick()
  await tick()
  assert.equal(calls.filter(call => call[1] === '/v1/conversations').length, initialLists + 1)
})

test('shows a cached snapshot as stale while offline without contacting the Gateway', async () => {
  const store = memoryStore()
  await store.write('conversation-cache', {
    version: 1, conversations: [conversation], selectedId: conversation.id, messages: [message], cachedAt: 2_000,
  })
  const states = []
  const client = new ConversationsClient({
    accessSession: async () => { throw new Error('must not authenticate offline') },
    authenticatedRequest: async () => { throw new Error('must not request offline') },
  }, state => states.push(state), { store, location: { origin: 'https://jarvis.internal' } })
  client.setOnline(false)
  await client.start()
  assert.equal(states.at(-1).phase, 'stale')
  assert.deepEqual(states.at(-1).messages, [message])
})

test('allows only one in-flight submission for the same draft', async () => {
  const calls = []
  const states = []
  let release
  const accepted = new Promise(resolve => { release = resolve })
  const pairing = gatewayPairing(calls, {
    request: async (path, init) => {
      if (path.endsWith('/messages') && init.method === 'POST') return accepted
      return undefined
    },
  })
  const client = new ConversationsClient(pairing, state => states.push(state), {
    store: memoryStore(), location: { origin: 'https://jarvis.internal' }, socketFactory: url => new FakeSocket(url),
  })
  await client.start()
  const first = client.send('Hello Jarvis')
  const duplicate = await client.send('Hello Jarvis')
  assert.equal(duplicate, false)
  assert.equal(calls.filter(call => typeof call[1] === 'string' && call[1].endsWith('/messages')).length, 1)
  release({ ok: true, status: 202, value: { accepted: true } })
  assert.equal(await first, true)
  assert.equal(states.at(-1).sending, false)
  assert.equal(states.at(-1).phase, 'ready')
})

test('keeps the composer usable after rejecting an unsafe draft locally', async () => {
  const states = []
  const client = new ConversationsClient(gatewayPairing([]), state => states.push(state), {
    store: memoryStore(), location: { origin: 'https://jarvis.internal' }, socketFactory: url => new FakeSocket(url),
  })
  await client.start()
  assert.equal(await client.send('/local-command'), false)
  assert.equal(states.at(-1).phase, 'ready')
  assert.match(states.at(-1).message, /斜杠命令/)
})

test('does not advance the event cursor when a required snapshot fails', async () => {
  const calls = []
  const sockets = []
  const store = memoryStore()
  let failSnapshot = false
  const pairing = gatewayPairing(calls, {
    request: async path => {
      if (failSnapshot && path === '/v1/conversations') return { ok: false, status: 503, value: {} }
      return undefined
    },
  })
  const client = new ConversationsClient(pairing, () => {}, {
    store,
    location: { origin: 'https://jarvis.internal' },
    socketFactory: url => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
  })
  await client.start()
  await tick()
  sockets[0].open()
  failSnapshot = true
  sockets[0].message({ type: 'events.ready', cursor, replayCount: 0, requiresSnapshot: true, reason: 'cursor_expired' })
  await tick()
  await tick()
  assert.equal(store.values.has('event-cursor'), false)
  assert.equal(sockets[0].readyState, 3)
})
