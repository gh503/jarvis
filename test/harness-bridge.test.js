import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { HarnessBridge, HarnessBridgeError } from '../dist/harness-bridge.js'

async function startHarness(handler) {
  const server = createServer((request, response) => { void handler(request, response) })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock Harness did not bind')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))),
  }
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendEnvelope(response, request, result) {
  const body = JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result })
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

test('accepts only an exact loopback HTTP Harness origin', () => {
  for (const origin of [
    'https://127.0.0.1:3080',
    'http://localhost:3080',
    'http://0.0.0.0:3080',
    'http://127.0.0.1:3080/api',
    'http://user@127.0.0.1:3080',
    'http://127.0.0.1:3080/?target=other',
  ]) assert.throws(() => new HarnessBridge({ origin }), /exact http/)
  assert.doesNotThrow(() => new HarnessBridge({ origin: 'http://127.0.0.1:3080' }))
})

test('uses only allowlisted Harness methods and returns normalized public conversations', async () => {
  const requests = []
  const harness = await startHarness(async (request, response) => {
    const body = await readJson(request)
    requests.push({ path: request.url, authorization: request.headers.authorization, body })
    if (body.method === 'session.list') {
      sendEnvelope(response, body, { ok: true, value: { items: [{
        sessionId: 'session-one',
        updatedAt: 1_000,
        running: false,
        blank: false,
        cwd: '/private/owner/path',
        agentPreset: 'internal-preset',
        projections: { asOfSeq: 9, values: { title: 'Visible title', secretProjection: 'hidden' } },
      }] } })
      return
    }
    if (body.method === 'session.create') {
      sendEnvelope(response, body, { ok: true, value: { sessionId: 'session-created', agentPreset: 'standard' } })
      return
    }
    if (body.method === 'session.history') {
      sendEnvelope(response, body, { ok: true, value: {
        events: [
          { event: { type: 'turn/start', seq: 4, time: 1, data: { turn: 1 } } },
          { event: { type: 'user/message', seq: 5, time: 2, surfaceOp: 'append', data: {
            id: 'message-user', role: 'user', source: { kind: 'user' },
            content: [{ type: 'text', text: 'Hello' }, { type: 'reasoning', text: 'private' }],
          } } },
          { event: { type: 'user/message', seq: 6, time: 3, surfaceOp: 'append', data: {
            id: 'message-plugin', role: 'user', source: { kind: 'plugin', plugin: 'internal' },
            content: [{ type: 'text', text: 'hidden context' }],
          } } },
          { event: { type: 'assistant/message', seq: 7, time: 4, surfaceOp: 'append', data: {
            message: { id: 'message-assistant', role: 'assistant', source: { kind: 'model' },
              content: [{ type: 'reasoning', text: 'hidden thought' }, { type: 'text', text: 'Hi there' }] },
          } } },
          { event: { type: 'assistant/message', seq: 8, time: 5, surfaceOp: { op: 'replace', start: 5, end: 7 }, data: {
            message: { id: 'message-replacement', role: 'assistant', source: { kind: 'model' },
              content: [{ type: 'text', text: 'hidden compaction' }] },
          } } },
          { event: { type: 'tool/result', seq: 9, time: 6, surfaceOp: 'append', data: {
            message: { id: 'message-tool', role: 'user', source: { kind: 'tool' },
              content: [{ type: 'text', text: 'hidden tool output' }] },
          } } },
        ],
        hasMore: true,
        projections: { values: { private: 'hidden' } },
      } })
      return
    }
    if (body.method === 'session.prompt' || body.method === 'session.cancel') {
      sendEnvelope(response, body, { ok: true, value: { accepted: true } })
      return
    }
    response.writeHead(404).end()
  })
  try {
    const bridge = new HarnessBridge({ origin: harness.origin })
    assert.deepEqual(await bridge.listConversations(), [{
      id: 'session-one', title: 'Visible title', updatedAt: 1_000, running: false, blank: false,
    }])
    assert.deepEqual(await bridge.createConversation(), { id: 'session-created' })
    assert.deepEqual(await bridge.getConversationHistory('session-one', 20, 25), {
      messages: [
        { id: 'message-user', sequence: 5, createdAt: 2, role: 'user', text: 'Hello' },
        { id: 'message-assistant', sequence: 7, createdAt: 4, role: 'assistant', text: 'Hi there' },
      ],
      hasMore: true,
      nextBeforeSequence: 4,
    })
    assert.deepEqual(await bridge.sendText('session-one', 'New message', 'queue'), { accepted: true })
    assert.deepEqual(await bridge.cancelConversation('session-one'), { accepted: true })

    assert.deepEqual(requests.map(item => item.path), [
      '/api/session.list', '/api/session.create', '/api/session.history', '/api/session.prompt', '/api/session.cancel',
    ])
    assert.equal(requests.every(item => item.authorization === undefined), true)
    assert.equal(requests.every(item => item.body.type === 'client-request' && item.body.method === item.path.slice(5)), true)
    assert.deepEqual(requests[2].body.payload, { sessionId: 'session-one', beforeSeq: 20, maxMessages: 25 })
    assert.deepEqual(requests[3].body.payload, {
      sessionId: 'session-one', mode: 'queue', content: [{ type: 'text', text: 'New message' }],
    })
  } finally {
    await harness.close()
  }
})

test('rejects unsafe local inputs before contacting Harness', async () => {
  let calls = 0
  const bridge = new HarnessBridge({ fetch: async () => { calls += 1; throw new Error('must not fetch') } })
  await assert.rejects(bridge.getConversationHistory('../private'), /conversation id/)
  await assert.rejects(bridge.getConversationHistory('session-one', -1), /beforeSequence/)
  await assert.rejects(bridge.sendText('session-one', '   ', 'queue'), /conversation text/)
  await assert.rejects(bridge.sendText('session-one', '/settings', 'queue'), /slash commands/)
  await assert.rejects(bridge.sendText('session-one', `value\0hidden`, 'queue'), /conversation text/)
  await assert.rejects(bridge.sendText('session-one', 'x'.repeat(16 * 1024 + 1), 'queue'), /conversation text/)
  assert.equal(calls, 0)
})

test('distinguishes Harness rejection, malformed response, timeout, and unavailability', async () => {
  const envelopeFetch = result => async (_input, init) => {
    const request = JSON.parse(init.body)
    return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result }), {
      headers: { 'content-type': 'application/json' },
    })
  }
  await assert.rejects(
    new HarnessBridge({ fetch: envelopeFetch({ ok: false, error: { code: 'session-not-found', message: 'private', details: {} } }) })
      .createConversation(),
    error => error instanceof HarnessBridgeError && error.code === 'rejected' && error.upstreamCode === 'session-not-found',
  )
  await assert.rejects(
    new HarnessBridge({ fetch: async () => new Response(JSON.stringify({ type: 'server-response', rpcId: 'wrong', result: { ok: true, value: {} } }), {
      headers: { 'content-type': 'application/json' },
    }) }).createConversation(),
    error => error instanceof HarnessBridgeError && error.code === 'protocol',
  )
  await assert.rejects(
    new HarnessBridge({ maxResponseBytes: 8, fetch: async () => new Response('123456789', {
      headers: { 'content-type': 'application/json' },
    }) }).createConversation(),
    error => error instanceof HarnessBridgeError && error.code === 'protocol',
  )
  await assert.rejects(
    new HarnessBridge({ timeoutMs: 5, fetch: async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
      },
    }), { headers: { 'content-type': 'application/json' } }) }).createConversation(),
    error => error instanceof HarnessBridgeError && error.code === 'timeout',
  )
  await assert.rejects(
    new HarnessBridge({ fetch: async () => { throw new Error('connection refused') } }).createConversation(),
    error => error instanceof HarnessBridgeError && error.code === 'unavailable' && !error.message.includes('connection refused'),
  )
})
