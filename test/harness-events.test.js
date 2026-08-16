import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { APPROVAL_TTL_MS, MobileApprovalDecisionError, commandDigest } from '../dist/approval.js'
import { HarnessEventBridge } from '../dist/harness-events.js'

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function startHarnessEvents() {
  const responses = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/respond') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      responses.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ accepted: true }))
    })
  })
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
    responses,
    send(channel, payload, rpcId = `rpc-${Date.now()}`) {
      const socket = sockets[channel].at(-1)
      if (socket === undefined) throw new Error(`${channel} stream is not connected`)
      socket.send(JSON.stringify({ type: 'server-request', rpcId, method: payload.type, payload }))
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

test('correlates and answers one exact Jarvis app approval through the upstream receipt', async () => {
  const harness = await startHarnessEvents()
  const events = []
  let now = 10_000
  const bridge = new HarnessEventBridge({
    origin: harness.origin,
    now: () => now,
    listVisibleConversations: async () => [{
      id: 'session-root', title: null, updatedAt: 1, running: true, blank: false,
    }],
  })
  try {
    bridge.start({ onEvent: event => events.push(event), onAvailability() {} })
    await waitFor(() => harness.sockets.mux.length === 1 && harness.sockets.host.length === 1, 'Harness streams did not connect')
    harness.send('mux', { type: 'session/event', sessionId: 'session-root', event: {
      type: 'tool/call', seq: 10, time: now,
      data: { callId: 'call-open-notes', name: 'jarvis_open_app', arguments: '{"application":"notes"}' },
    } })
    harness.send('mux', { type: 'session/event', sessionId: 'session-root', event: {
      type: 'approval/asked', seq: 11, time: now,
      data: { id: 'approval-one', callId: 'call-open-notes', toolName: 'jarvis_open_app' },
    } })
    harness.send('mux', {
      type: 'approval/requested', sessionId: 'session-root', approvalId: 'approval-one',
      callId: 'call-open-notes', toolName: 'jarvis_open_app', reason: 'Open Notes',
    }, 'rpc-approval-one')
    await waitFor(() => bridge.listApprovals().length === 1, 'approval was not normalized')

    const approval = bridge.listApprovals()[0]
    assert.deepEqual(approval, {
      id: 'approval-one', conversationId: 'session-root', toolName: 'jarvis_open_app',
      callId: 'call-open-notes', action: 'open_app', target: 'notes', arguments: { application: 'notes' },
      digest: commandDigest({ action: 'open_app', application: 'notes' }), risk: 'high',
      requestedAt: now, expiresAt: now + APPROVAL_TTL_MS, canAllow: true, blockReason: null,
    })
    assert.equal(events.at(-1).type, 'approval.pending')

    const idempotencyKey = '00000000-0000-4000-8000-000000000001'
    const first = bridge.decideApproval(approval.id, approval.digest, 'allowed-once', idempotencyKey)
    const retry = bridge.decideApproval(approval.id, approval.digest, 'allowed-once', idempotencyKey)
    assert.deepEqual(await first, { approvalId: 'approval-one', outcome: 'allowed-once', accepted: true })
    assert.deepEqual(await retry, { approvalId: 'approval-one', outcome: 'allowed-once', accepted: true })
    assert.equal(harness.responses.length, 1)
    assert.deepEqual(harness.responses[0], {
      type: 'client-response', rpcId: 'rpc-approval-one', result: { ok: true, value: {
        sessionId: 'session-root', approvalId: 'approval-one', outcome: 'allowed-once',
      } },
    })
    await assert.rejects(
      bridge.decideApproval(approval.id, approval.digest, 'rejected', idempotencyKey),
      error => error instanceof MobileApprovalDecisionError && error.code === 'conflict',
    )

    harness.send('mux', {
      type: 'approval/resolved', sessionId: 'session-root', approvalId: 'approval-one', outcome: 'allowed-once',
    })
    await waitFor(() => bridge.listApprovals().length === 0, 'resolved approval remained pending')
    assert.deepEqual(events.at(-1), {
      type: 'approval.resolved', approvalId: 'approval-one', conversationId: 'session-root', outcome: 'allowed-once',
    })
    now += 1
  } finally {
    await bridge.stop()
    await harness.close()
  }
})

test('fails closed for changed, expired, unsupported, and replay-only approvals', async () => {
  const harness = await startHarnessEvents()
  let now = 20_000
  const bridge = new HarnessEventBridge({
    origin: harness.origin,
    now: () => now,
    listVisibleConversations: async () => [{
      id: 'session-root', title: null, updatedAt: 1, running: true, blank: false,
    }],
  })
  try {
    bridge.start({ onEvent() {}, onAvailability() {} })
    await waitFor(() => harness.sockets.mux.length === 1 && harness.sockets.host.length === 1, 'Harness streams did not connect')
    harness.send('mux', { type: 'session/event', sessionId: 'session-root', event: {
      type: 'tool/call', seq: 1, time: now,
      data: { callId: 'call-expiring', name: 'jarvis_open_app', arguments: '{"application":"notes"}' },
    } })
    harness.send('mux', { type: 'session/event', sessionId: 'session-root', event: {
      type: 'approval/asked', seq: 2, time: now,
      data: { id: 'approval-expiring', callId: 'call-expiring', toolName: 'jarvis_open_app' },
    } })
    harness.send('mux', {
      type: 'approval/requested', sessionId: 'session-root', approvalId: 'approval-expiring',
      callId: 'call-expiring', toolName: 'jarvis_open_app',
    }, 'rpc-expiring')
    harness.send('mux', {
      type: 'approval/requested', sessionId: 'session-root', approvalId: 'approval-unsupported',
      callId: 'call-shell', toolName: 'bash',
    }, 'rpc-unsupported')
    harness.send('mux', {
      type: 'approval/requested', sessionId: 'session-root', approvalId: 'approval-replayed',
      callId: 'call-missing', toolName: 'jarvis_open_app',
    }, 'rpc-replayed')
    await waitFor(() => bridge.listApprovals().length === 3, 'approval set was not captured')

    const expiring = bridge.listApprovals().find(item => item.id === 'approval-expiring')
    await assert.rejects(
      bridge.decideApproval(expiring.id, '0'.repeat(64), 'allowed-once', '00000000-0000-4000-8000-000000000002'),
      error => error instanceof MobileApprovalDecisionError && error.code === 'mismatch',
    )
    now += APPROVAL_TTL_MS
    assert.equal(bridge.listApprovals().find(item => item.id === 'approval-expiring').blockReason, 'expired')
    await assert.rejects(
      bridge.decideApproval(expiring.id, expiring.digest, 'allowed-once', '00000000-0000-4000-8000-000000000003'),
      error => error instanceof MobileApprovalDecisionError && error.code === 'expired',
    )
    for (const approvalId of ['approval-unsupported', 'approval-replayed']) {
      const approval = bridge.listApprovals().find(item => item.id === approvalId)
      assert.equal(approval.canAllow, false)
      await assert.rejects(
        bridge.decideApproval(approval.id, null, 'allowed-once', `00000000-0000-4000-8000-00000000000${approvalId.endsWith('unsupported') ? '4' : '5'}`),
        error => error instanceof MobileApprovalDecisionError && error.code === 'unsupported',
      )
    }
    assert.equal(harness.responses.length, 0)
    assert.deepEqual(await bridge.decideApproval(
      'approval-replayed', null, 'rejected', '00000000-0000-4000-8000-000000000006',
    ), { approvalId: 'approval-replayed', outcome: 'rejected', accepted: true })
  } finally {
    await bridge.stop()
    await harness.close()
  }
})
