import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { AnthropicClient } from '../src/model/anthropic.ts'
import { createModelClient } from '../src/model/router.ts'
import type { ModelProfile } from '../src/model/settings.ts'

test('Anthropic Messages client uses x-api-key, system messages and SSE text deltas', async () => {
  const requests: Array<{ url?: string; body: Record<string, unknown>; key?: string; version?: string }> = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet' }] }))
        return
      }
      requests.push({
        url: request.url,
        body: JSON.parse(raw) as Record<string, unknown>,
        key: String(request.headers['x-api-key'] ?? ''),
        version: String(request.headers['anthropic-version'] ?? ''),
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const text of ['你', '好']) {
        response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`)
      }
      response.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const client = new AnthropicClient({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'claude-sonnet-4-5',
    apiKey: 'sk-ant-test',
  })
  try {
    const health = await client.health()
    assert.equal(health.ok, true)
    assert.deepEqual(health.models.map(item => item.name), ['claude-sonnet-4-5'])
    assert.equal(await client.chatOnce([
      { role: 'system', content: '你是 Jarvis。' },
      { role: 'user', content: 'hello' },
    ]), '你好')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/v1/messages')
    assert.equal(requests[0].key, 'sk-ant-test')
    assert.equal(requests[0].version, '2023-06-01')
    assert.equal(requests[0].body.system, '你是 Jarvis。')
    assert.equal(requests[0].body.stream, true)
    assert.ok(Number(requests[0].body.max_tokens) > 0)
  } finally {
    server.close()
  }
})

test('router creates an Anthropic client from a profile', () => {
  const profile: ModelProfile = {
    id: 'remote', label: 'Claude', kind: 'openai', protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5',
    apiKey: 'k', visionModel: '', embedModel: '', keepAlive: '',
  }
  const client = createModelClient(profile)
  assert.equal(client.status?.().protocol, 'anthropic')
  assert.equal(client.model, 'claude-sonnet-4-5')
})
