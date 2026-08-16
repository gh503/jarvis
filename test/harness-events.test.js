import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { HarnessEventBridge } from '../dist/harness-events.js'

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function startHarnessEvents() {
  const server = createServer()
  const sockets = { mux: [], host: [] }
  const websocket = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    const channel = request.url === '/api/events.mux' ? 'mux' : request.url === '/api/events.host' ? 'host' : undefined
    if (channel === undefined) return socket.destroy()
    websocket.handleUpgrade(request, socket, head, accepted => {
      sockets[channel].push(accepted)
      websocket.emit('connection', accepted, request)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock Harness did not bind')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    sockets,
    send(channel, payload) {
      const socket = sockets[channel].at(-1)
      if (socket === undefined) throw new Error(`${channel} stream is not connected`)
      socket.send(JSON.stringify({ type: 'server-request', rpcId: `rpc-${Date.now()}`, method: payload.type, payload }))
    },
    async close() {
      for (const socket of websocket.clients) socket.terminate()
      await new Promise(resolve => websocket.close(resolve))
      await new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    },
  }
}

test('normalizes only visible conversation events and tracks stream availability', async () => {
  const harness = await startHarnessEvents()
  const events = []
  const availability = []
  const bridge = new HarnessEventBridge({
    origin: harness.origin,
    reconnectDelayMs: 20,
    listVisibleConversations: async () => [{
      id: 'session-root', title: null, updatedAt: 1, running: false, blank: false,
    }],
  })
  try {
    bridge.start({ onEvent: event => events.push(event), onAvailability: value => availability.push(value) })
    await waitFor(() => availability.includes(true), 'Harness event bridge did not become available')
    harness.send('host', {
      type: 'host/session-added', sessionId: 'session-new', blank: true,
      cwd: '/private/path', agentPreset: 'internal',
    })
    harness.send('host', {
      type: 'host/session-added', sessionId: 'session-child', blank: true, origin: 'subagent', cwd: '/private/child',
    })
    harness.send('host', { type: 'host/session-status', sessionId: 'session-root', running: true })
    harness.send('host', { type: 'host/agent-error', sessionId: 'session-root', message: 'private provider failure' })
    harness.send('mux', { type: 'session/event', sessionId: 'session-root', event: {
      type: 'user/message', seq: 2, time: 3, surfaceOp: 'append',
      data: { id: 'user-one', source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] },
    } })
    harness.send('mux', { type: 'session/event', sessionId: 'session-root', event: {
      type: 'assistant/message', seq: 4, time: 5, surfaceOp: 'append',
      data: { message: { id: 'assistant-one', content: [
        { type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'Visible' },
      ] } },
    } })
    harness.send('mux', { type: 'session/event', sessionId: 'session-child', event: {
      type: 'assistant/message', seq: 1, time: 2, surfaceOp: 'append',
      data: { message: { id: 'child-message', content: [{ type: 'text', text: 'hidden child' }] } },
    } })
    harness.send('mux', { type: 'session/event', sessionId: 'session-root', event: {
      type: 'tool/result', seq: 6, time: 7, surfaceOp: 'append',
      data: { message: { id: 'tool-one', content: [{ type: 'text', text: 'hidden tool' }] } },
    } })
    await waitFor(() => events.length === 5, 'normalized Harness events were not delivered')

    assert.deepEqual(events, [
      { type: 'conversation.created', conversation: { id: 'session-new', blank: true } },
      { type: 'conversation.status', conversationId: 'session-root', running: true },
      { type: 'conversation.error', conversationId: 'session-root', code: 'harness_agent_error' },
      { type: 'conversation.message.committed', conversationId: 'session-root',
        message: { id: 'user-one', sequence: 2, createdAt: 3, role: 'user', text: 'Hello' } },
      { type: 'conversation.message.committed', conversationId: 'session-root',
        message: { id: 'assistant-one', sequence: 4, createdAt: 5, role: 'assistant', text: 'Visible' } },
    ])
    assert.doesNotMatch(JSON.stringify(events), /private|internal|reasoning|hidden|tool/)

    harness.sockets.host.at(-1).terminate()
    await waitFor(() => availability.at(-1) === false, 'Harness disconnect was not observed')
    await waitFor(() => availability.at(-1) === true, 'Harness event bridge did not reconnect')
  } finally {
    await bridge.stop()
    await harness.close()
  }
})

test('accepts only an exact loopback HTTP Harness event origin', () => {
  const options = { listVisibleConversations: async () => [] }
  for (const origin of ['https://127.0.0.1:3080', 'http://localhost:3080', 'http://127.0.0.1:3080/api']) {
    assert.throws(() => new HarnessEventBridge({ ...options, origin }), /exact http/)
  }
})
