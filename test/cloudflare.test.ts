import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { cloudflareModelsUrl, isCloudflareBaseUrl, listCloudflareModels } from '../src/model/cloudflare.ts'

test('Cloudflare base detection and model search URL', () => {
  const base = 'https://api.cloudflare.com/client/v4/accounts/acct-1/ai/v1'
  assert.equal(isCloudflareBaseUrl(base), true)
  assert.equal(isCloudflareBaseUrl('https://api.groq.com/openai/v1'), false)
  assert.equal(cloudflareModelsUrl(base), 'https://api.cloudflare.com/client/v4/accounts/acct-1/ai/models/search?per_page=100')
})

test('Cloudflare model discovery keeps text models and drops audio/embedding models', async () => {
  let auth = ''
  const server = createServer((request, response) => {
    auth = String(request.headers.authorization ?? '')
    assert.equal(request.url, '/client/v4/accounts/acct-1/ai/models/search?per_page=100')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      success: true,
      result: [
        { name: '@cf/openai/gpt-oss-120b', task: { name: 'Text Generation' } },
        { name: '@cf/qwen/qwen3.8-27b', task: { name: 'Text Generation' } },
        { name: '@cf/openai/whisper', task: { name: 'Automatic Speech Recognition' } },
        { name: '@cf/baai/bge-m3', task: { name: 'Text Embeddings' } },
      ],
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  try {
    const result = await listCloudflareModels(`http://127.0.0.1:${address.port}/client/v4/accounts/acct-1/ai/v1`, 'cf-key')
    assert.equal(result.ok, true)
    assert.deepEqual(result.models.map(item => item.name), ['@cf/openai/gpt-oss-120b', '@cf/qwen/qwen3.8-27b'])
    assert.equal(auth, 'Bearer cf-key')
  } finally {
    server.close()
  }
})

test('Cloudflare model discovery surfaces token permission errors', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(403, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ success: false, errors: [{ message: 'Authentication error' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  try {
    const result = await listCloudflareModels(`http://127.0.0.1:${address.port}/client/v4/accounts/acct-1/ai/v1`, 'bad')
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /Workers AI 权限/)
  } finally {
    server.close()
  }
})
