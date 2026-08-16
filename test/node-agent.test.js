import assert from 'node:assert/strict'
import test from 'node:test'
import { NodeAgent } from '../dist/node-agent.js'
import { MAC_NODE_CAPABILITIES } from '../dist/node-capabilities.js'
import { NodePolicy } from '../dist/node-command.js'

class FakeSocket {
  readyState = 0
  sent = []
  listeners = new Map()

  addEventListener(type, listener) {
    const handlers = this.listeners.get(type) ?? []
    handlers.push(listener)
    this.listeners.set(type, handlers)
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3
    this.emit('close', {})
  }

  open() {
    this.readyState = 1
    this.emit('open', {})
  }

  receive(message) {
    this.emit('message', { data: JSON.stringify(message) })
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class FakeTimers {
  callbacks = []

  setTimeout(callback, delayMs) {
    this.callbacks.push({ callback, delayMs })
    return callback
  }

  clearTimeout(handle) {
    this.callbacks = this.callbacks.filter(item => item.callback !== handle)
  }

  runNext() {
    this.callbacks.shift()?.callback()
  }
}

const config = (overrides = {}) => ({
  endpoint: 'wss://gateway.invalid/node',
  credential: 'opaque-test-credential',
  registration: {
    nodeId: 'node-1',
    platform: 'macos',
    softwareVersion: '0.2.0-dev',
    capabilities: Object.values(MAC_NODE_CAPABILITIES),
  },
  policy: new NodePolicy({ capabilities: { system_status: { version: 1 } } }),
  execute: async () => ({ hostname: 'test-mac' }),
  ...overrides,
})

function makeReadySocket(agentSocket) {
  agentSocket.open()
  assert.deepEqual(agentSocket.sent[0], {
    type: 'node.authenticate',
    protocolVersion: 1,
    nodeId: 'node-1',
    credential: 'opaque-test-credential',
  })
  agentSocket.receive({ type: 'node.authenticated' })
  assert.equal(agentSocket.sent[1].type, 'node.register')
  agentSocket.receive({ type: 'node.ready' })
}

test('connects outbound, authenticates before registration, and executes ready commands', async () => {
  const socket = new FakeSocket()
  const agent = new NodeAgent(config({ socketFactory: () => socket }))
  agent.start()
  assert.equal(agent.state, 'connecting')
  makeReadySocket(socket)
  assert.equal(agent.state, 'ready')
  socket.receive({
    type: 'command.requested',
    command: {
      commandId: 'command-1',
      idempotencyKey: 'idempotency-1',
      nodeId: 'node-1',
      capability: 'system_status',
      capabilityVersion: 1,
      arguments: {},
      expiresAt: Date.now() + 60_000,
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(socket.sent.slice(2).map(message => message.type), [
    'command.acknowledged',
    'command.running',
    'command.outcome',
  ])
  assert.equal(socket.sent.at(-1).outcome.state, 'succeeded')
  agent.stop()
})

test('does not execute before ready and reconnects with the same node identity', async () => {
  const sockets = []
  const timers = new FakeTimers()
  let executions = 0
  const agent = new NodeAgent(config({
    socketFactory: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    timers,
    execute: async () => {
      executions += 1
      return true
    },
  }))
  agent.start()
  sockets[0].open()
  sockets[0].receive({ type: 'command.requested', command: {} })
  assert.equal(executions, 0)
  sockets[0].receive({ type: 'node.authenticated' })
  sockets[0].receive({ type: 'node.ready' })
  sockets[0].close()
  assert.equal(agent.state, 'backoff')
  assert.equal(timers.callbacks[0].delayMs, 1_000)
  timers.runNext()
  makeReadySocket(sockets[1])
  sockets[1].receive({
    type: 'command.requested',
    command: {
      commandId: 'command-1',
      idempotencyKey: 'idempotency-1',
      nodeId: 'node-1',
      capability: 'system_status',
      capabilityVersion: 1,
      arguments: {},
      expiresAt: Date.now() + 60_000,
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(executions, 1)
  assert.equal(sockets[1].sent[0].nodeId, 'node-1')
  agent.stop()
})

test('rejects non-TLS endpoints and does not create an inbound server', () => {
  assert.throws(() => new NodeAgent(config({ endpoint: 'ws://gateway.invalid/node' })), /wss/)
})

test('fails closed on authentication rejection and does not schedule reconnect', () => {
  const socket = new FakeSocket()
  const timers = new FakeTimers()
  const agent = new NodeAgent(config({ socketFactory: () => socket, timers }))
  agent.start()
  socket.open()
  socket.receive({ type: 'node.rejected' })
  assert.equal(agent.state, 'stopped')
  assert.equal(timers.callbacks.length, 0)
  assert.equal(socket.sent.at(-1).type, 'node.error')
})
