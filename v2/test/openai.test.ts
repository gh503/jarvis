import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { OpenAICompatibleClient } from '../src/model/openai.ts'

test('OpenAI-compatible client streams, normalizes model ids and embeds', async () => {
  const requests: Array<{ url?: string; body: string; auth?: string }> = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      requests.push({ url: request.url, body: raw, auth: String(request.headers.authorization ?? '') })
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'mock-chat' }] }))
        return
      }
      if (request.url === '/v1/embeddings') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ embedding: [0.25, 0.75] }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const text of ['你', '好']) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
      }
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const client = new OpenAICompatibleClient({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'mock-chat',
    apiKey: 'sk-test',
    embedModel: 'mock-embed',
  })
  try {
    const health = await client.health()
    assert.equal(health.ok, true)
    assert.deepEqual(health.models.map(item => item.name), ['mock-chat'])
    assert.equal(await client.chatOnce([{ role: 'user', content: 'hello' }]), '你好')
    const vector = await client.embed('hello')
    assert.deepEqual([...vector ?? []], [0.25, 0.75])
    assert.equal(requests.every(item => item.auth === 'Bearer sk-test'), true)
    assert.equal(requests.some(item => item.body.includes('sk-test')), false)
    assert.equal(requests.find(item => item.url === '/v1/chat/completions')?.body.includes('"stream":true'), true)
  } finally {
    server.close()
  }
})
