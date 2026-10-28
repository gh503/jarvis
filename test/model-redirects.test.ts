import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { OllamaClient } from '../src/model/ollama.ts'
import { OpenAICompatibleClient } from '../src/model/openai.ts'
import { AnthropicClient } from '../src/model/anthropic.ts'
import { listCloudflareModels } from '../src/model/cloudflare.ts'
import type { ChatMessage } from '../src/model/types.ts'

const prompt = 'private-inference-prompt'
const image = Buffer.from('private-image-bytes')
const apiKey = 'test-only-private-api-key'
const messages: ChatMessage[] = [{ role: 'user', content: prompt, images: [image.toString('base64')] }]
const tools = [{ name: 'inspect', description: 'Inspect an item', parameters: { type: 'object', properties: {} } }]

type RecordedRequest = { path: string; method?: string; headers: IncomingHttpHeaders; body: string }

async function listen(server: Server, t: TestContext): Promise<string> {
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

async function fixture(t: TestContext, status: number) {
  const received: RecordedRequest[] = []
  const leaked: RecordedRequest[] = []
  // A real second origin catches redirected requests, including body and headers.
  // Neither server ever contacts a remote host or production service.
  const sink = await listen(createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    leaked.push({ path: req.url ?? '', method: req.method, headers: req.headers, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'unexpected success' } }], embeddings: [[1]], embedding: [1] }))
  }), t)
  const behavior = { legacy: false, success: false }
  const baseUrl = await listen(createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    received.push({ path: req.url ?? '', method: req.method, headers: req.headers, body })
    if (behavior.legacy && req.url === '/api/embed') {
      res.writeHead(404)
      res.end('legacy endpoint required')
    } else if (behavior.success) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ embedding: [0.25, 0.5] }))
    } else {
      res.writeHead(status, { location: `${sink}/inference-sink` })
      res.end()
    }
  }), t)
  return { baseUrl, received, leaked, behavior }
}

async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) assert.fail('redirect emitted an inference event')
}

for (const status of [307, 308]) {
  test(`model clients never follow HTTP ${status} redirects`, async t => {
    const { baseUrl, received, leaked, behavior } = await fixture(t, status)
    const ollama = new OllamaClient(baseUrl, { model: 'chat', visionModel: 'vision', embedModel: 'embed', supportsTools: true })
    assert.equal(ollama.isLocal, true, 'exercise the local-only trust boundary')
    const openai = (protocol: 'chat-completions' | 'responses') => new OpenAICompatibleClient({
      baseUrl, apiKey, protocol, model: 'chat', visionModel: 'vision', embedModel: 'embed', supportsTools: true,
    })
    const anthropic = new AnthropicClient({ baseUrl, apiKey, model: 'chat', visionModel: 'vision', supportsTools: true })
    type Case = { name: string; path: string; run: () => Promise<unknown>; result?: 'null' | 'health'; image?: boolean; auth?: 'authorization' | 'x-api-key'; legacy?: boolean }
    const cases: Case[] = [
      { name: 'Ollama vision', path: '/api/chat', run: () => ollama.vision(image, prompt), image: true },
      { name: 'Ollama chat', path: '/api/chat', run: () => ollama.chatOnce([{ role: 'user', content: prompt }]) },
      { name: 'Ollama tool stream', path: '/api/chat', run: () => consume(ollama.toolStream(messages, { tools })), image: true },
      { name: 'Ollama embed', path: '/api/embed', run: () => ollama.embed(prompt), result: 'null' },
      { name: 'Ollama legacy embed', path: '/api/embeddings', run: () => ollama.embed(prompt), result: 'null', legacy: true },
      { name: 'Ollama discovery', path: '/api/tags', run: () => ollama.health(), result: 'health' },
      ...(['chat-completions', 'responses'] as const).flatMap(protocol => {
        const client = openai(protocol)
        const path = protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions'
        return [
          { name: `OpenAI ${protocol} vision`, path, run: () => client.vision(image, prompt), image: true, auth: 'authorization' as const },
          { name: `OpenAI ${protocol} tool stream`, path, run: () => consume(client.toolStream(messages, { tools })), image: true, auth: 'authorization' as const },
        ]
      }),
      { name: 'OpenAI embed', path: '/v1/embeddings', run: () => openai('chat-completions').embed(prompt), result: 'null', auth: 'authorization' },
      { name: 'OpenAI discovery', path: '/v1/models', run: () => openai('chat-completions').health(), result: 'health', auth: 'authorization' },
      { name: 'Anthropic vision', path: '/v1/messages', run: () => anthropic.vision(image, prompt), image: true, auth: 'x-api-key' },
      { name: 'Anthropic tool stream', path: '/v1/messages', run: () => consume(anthropic.toolStream(messages, { tools })), image: true, auth: 'x-api-key' },
      { name: 'Anthropic discovery', path: '/v1/models', run: () => anthropic.health(), result: 'health', auth: 'x-api-key' },
      { name: 'Cloudflare discovery', path: '/client/v4/accounts/test/ai/models/search?per_page=100', run: () => listCloudflareModels(`${baseUrl}/client/v4/accounts/test/ai/v1`, apiKey), result: 'health', auth: 'authorization' },
    ]
    for (const item of cases) {
      await t.test(item.name, async () => {
        received.length = 0
        behavior.legacy = item.legacy ?? false
        if (item.result === 'null') {
          assert.equal(await item.run(), null, 'embedding failure remains null')
        } else if (item.result === 'health') {
          const health = await item.run() as { ok: boolean; models: unknown[]; error?: string }
          assert.equal(health.ok, false)
          assert.deepEqual(health.models, [])
          assert.ok(health.error)
        } else {
          await assert.rejects(item.run, TypeError, 'redirect must reject, not return successful inference')
        }
        assert.deepEqual(received.map(request => request.path), item.legacy ? ['/api/embed', item.path] : [item.path], 'only configured endpoints receive requests')
        const request = received.at(-1)!
        assert.equal(request.method, item.result === 'health' ? 'GET' : 'POST')
        if (item.result !== 'health') assert.ok(request.body.includes(prompt), 'source received sensitive prompt')
        if (item.image) assert.ok(request.body.includes(image.toString('base64')), 'source received sensitive image')
        if (item.auth) assert.equal(request.headers[item.auth], item.auth === 'authorization' ? `Bearer ${apiKey}` : apiKey)
        assert.deepEqual(leaked, [], 'redirect sink must receive zero requests, bodies, images, prompts, or credentials')
      })
    }
  })
}

test('Ollama recognizes IPv6 loopback without treating remote hosts as local', () => {
  for (const [baseUrl, local] of [
    ['http://[::1]:11434', true],
    ['http://127.0.0.1:11434', true],
    ['http://localhost:11434', true],
    ['http://192.0.2.1:11434', false],
    ['http://[2001:db8::1]:11434', false],
    ['http://localhost.example:11434', false],
    ['http://127.0.0.1.example:11434', false],
    ['http://localhost@remote.example:11434', false],
  ] as const) {
    const client = new OllamaClient(baseUrl, { model: 'chat', visionModel: 'vision', embedModel: 'embed' })
    assert.equal(client.isLocal, local, baseUrl)
  }
})

test('Ollama preserves legacy embedding fallback on an ordinary HTTP error', async t => {
  const { baseUrl, behavior, received, leaked } = await fixture(t, 307)
  behavior.legacy = true
  behavior.success = true
  const client = new OllamaClient(baseUrl, { model: 'chat', visionModel: 'vision', embedModel: 'embed' })
  assert.deepEqual(await client.embed(prompt), new Float32Array([0.25, 0.5]))
  assert.deepEqual(received.map(request => request.path), ['/api/embed', '/api/embeddings'])
  assert.deepEqual(leaked, [])
})
