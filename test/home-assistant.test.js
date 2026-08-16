import assert from 'node:assert/strict'
import test from 'node:test'
import { HomeAssistantAdapter } from '../dist/home-assistant.js'

class FakeSocket {
  listeners = new Map()
  sent = []
  closed = false

  addEventListener(type, listener) {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.closed = true
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  frame(message) {
    this.emit('message', { data: JSON.stringify(message) })
  }
}

const entity = (overrides = {}) => ({
  entity_id: 'light.living_room',
  state: 'off',
  last_updated: '2026-08-17T01:00:00.000Z',
  attributes: { friendly_name: 'Living room light', area_name: 'Living room' },
  ...overrides,
})

const createAdapter = (overrides = {}) => {
  const sockets = []
  const snapshots = []
  const stateEvents = []
  const unavailable = []
  const statuses = []
  const timers = []
  const adapter = new HomeAssistantAdapter({
    url: 'wss://ha.example.test/api/websocket',
    accessToken: 'secret-home-assistant-token',
    socketFactory: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onSnapshot: snapshot => snapshots.push(snapshot),
    onState: (source, externalEntityId, state) => stateEvents.push({ source, externalEntityId, state }),
    onUnavailable: (source, externalEntityId) => unavailable.push({ source, externalEntityId }),
    onStatus: status => statuses.push(status),
    timers: {
      setTimeout: callback => {
        timers.push(callback)
        return callback
      },
      clearTimeout: callback => {
        const index = timers.indexOf(callback)
        if (index >= 0) timers.splice(index, 1)
      },
    },
    reconnectBaseMs: 10,
    reconnectMaxMs: 100,
    ...overrides,
  })
  return { adapter, sockets, snapshots, stateEvents, unavailable, statuses, timers }
}

const completeHandshake = (socket, result = [entity()]) => {
  socket.frame({ type: 'auth_required', ha_version: '2026.1' })
  socket.frame({ type: 'auth_ok', ha_version: '2026.1' })
  socket.frame({ type: 'result', id: 1, success: true, result })
  socket.frame({ type: 'result', id: 2, success: true, result: null })
}

test('authenticates, normalizes a deterministic snapshot, and becomes ready after subscription', () => {
  const context = createAdapter()
  context.adapter.start()
  const socket = context.sockets[0]
  completeHandshake(socket)
  assert.deepEqual(socket.sent, [
    { type: 'auth', access_token: 'secret-home-assistant-token' },
    { id: 1, type: 'get_states' },
    { id: 2, type: 'subscribe_events', event_type: 'state_changed' },
  ])
  assert.equal(context.adapter.getStatus(), 'ready')
  assert.equal(context.snapshots[0][0].externalEntityId, 'light.living_room')
  assert.deepEqual(context.snapshots[0][0].reportedState, { value: 'off', sourceTimestamp: 1786928400000 })
  assert.equal(JSON.stringify(context.adapter).includes('secret-home-assistant-token'), false)
})

test('filters unrelated events and rejects older state timestamps', () => {
  const context = createAdapter()
  context.adapter.start()
  completeHandshake(context.sockets[0])
  const socket = context.sockets[0]
  socket.frame({ type: 'event', id: 2, event: { event_type: 'call_service', data: {} } })
  socket.frame({ type: 'event', id: 2, event: { event_type: 'state_changed', data: { entity_id: 'sensor.unknown', new_state: entity({ entity_id: 'sensor.unknown' }) } } })
  socket.frame({ type: 'event', id: 2, event: { event_type: 'state_changed', data: { entity_id: 'light.living_room', new_state: entity({ state: 'on', last_updated: '2026-08-17T00:59:00.000Z' }) } } })
  socket.frame({ type: 'event', id: 2, event: { event_type: 'state_changed', data: { entity_id: 'light.living_room', new_state: entity({ state: 'on', last_updated: '2026-08-17T01:01:00.000Z' }) } } })
  assert.equal(context.stateEvents.length, 1)
  assert.deepEqual(context.stateEvents[0].state, { value: 'on', sourceTimestamp: 1786928460000 })
  socket.frame({ type: 'event', id: 2, event: { event_type: 'state_changed', data: { entity_id: 'light.living_room', new_state: null } } })
  assert.deepEqual(context.unavailable[0].externalEntityId, 'light.living_room')
})

test('reconnects with one fresh auth, snapshot, and subscription sequence', () => {
  const context = createAdapter()
  context.adapter.start()
  completeHandshake(context.sockets[0])
  context.sockets[0].emit('close')
  assert.equal(context.adapter.getStatus(), 'degraded')
  assert.equal(context.timers.length, 1)
  context.timers.shift()()
  assert.equal(context.sockets.length, 2)
  completeHandshake(context.sockets[1], [entity({ state: 'on', last_updated: '2026-08-17T01:02:00.000Z' })])
  assert.equal(context.adapter.getStatus(), 'ready')
  assert.deepEqual(context.sockets[1].sent, [
    { type: 'auth', access_token: 'secret-home-assistant-token' },
    { id: 1, type: 'get_states' },
    { id: 2, type: 'subscribe_events', event_type: 'state_changed' },
  ])
  assert.deepEqual(context.statuses, ['connecting', 'syncing', 'ready', 'degraded', 'connecting', 'syncing', 'ready'])
})

test('fails closed on malformed protocol frames and invalid configuration', () => {
  assert.throws(() => createAdapter({ url: 'http://ha.example.test/api/websocket' }), /ws\/wss/)
  assert.throws(() => createAdapter({ url: 'wss://user:pass@ha.example.test/api/websocket' }), /embedded credentials/)
  const context = createAdapter()
  context.adapter.start()
  context.sockets[0].emit('message', { data: '{not-json' })
  assert.equal(context.adapter.getStatus(), 'degraded')
  assert.equal(context.timers.length, 1)
})

test('rejects duplicate entities and authentication failures without exposing provider data', () => {
  const context = createAdapter()
  context.adapter.start()
  const socket = context.sockets[0]
  socket.frame({ type: 'auth_required' })
  socket.frame({ type: 'auth_ok' })
  socket.frame({ type: 'result', id: 1, success: true, result: [entity(), entity()] })
  assert.equal(context.adapter.getStatus(), 'degraded')
  assert.equal(context.snapshots.length, 0)

  const failed = createAdapter()
  failed.adapter.start()
  failed.sockets[0].frame({ type: 'auth_required' })
  failed.sockets[0].frame({ type: 'auth_invalid', message: 'provider-secret-details' })
  assert.equal(failed.adapter.getStatus(), 'degraded')
  assert.equal(JSON.stringify(failed.adapter).includes('provider-secret-details'), false)
})
