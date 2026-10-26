import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { OllamaClient } from '../src/model/ollama.ts'

test('chat and embed requests keep the local model warm', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'application/json' })
      if (request.url === '/api/embed') {
        response.end(JSON.stringify({ embeddings: [[0.1, 0.2]] }))
      } else {
        response.end(`${JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true })}\n`)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no test port')
  const client = new OllamaClient(`http://127.0.0.1:${address.port}`, {
    model: 'qwen2.5:3b',
    visionModel: 'qwen2.5vl:3b',
    embedModel: 'nomic-embed-text',
    keepAlive: '24h',
  })
  try {
    assert.equal(await client.chatOnce([{ role: 'user', content: 'hi' }]), 'ok')
    await client.embed('warmup')
    assert.equal(bodies[0].keep_alive, '24h')
    assert.equal((bodies[0].options as Record<string, unknown>).num_ctx, 4096)
    assert.equal(bodies[1].keep_alive, '24h')
  } finally {
    server.close()
  }
})
