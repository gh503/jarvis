import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyModelError, cooldownMs, shouldFailover } from '../src/model/failover.ts'
import { ModelRouter } from '../src/model/router.ts'
import { ModelSettingsStore, type ModelSettings } from '../src/model/settings.ts'
import { OpenAIError } from '../src/model/openai.ts'

test('classifyModelError separates quota, rate limit, auth, network and client faults', () => {
  assert.equal(classifyModelError(new OpenAIError('HTTP 402 insufficient balance', 402)), 'quota')
  assert.equal(classifyModelError(new Error('insufficient_user_quota 额度不足')), 'quota')
  assert.equal(classifyModelError(new OpenAIError('HTTP 429 too many requests', 429)), 'rate-limit')
  assert.equal(classifyModelError(new OpenAIError('HTTP 401 invalid api key', 401)), 'auth')
  assert.equal(classifyModelError(new Error('fetch failed')), 'network')
  assert.equal(classifyModelError(new OpenAIError('HTTP 503', 503)), 'server')
  assert.equal(classifyModelError(new OpenAIError('HTTP 400 bad request', 400)), 'client')
  assert.equal(shouldFailover('client'), false)
  assert.equal(shouldFailover('quota'), true)
  assert.ok(cooldownMs('quota') > cooldownMs('rate-limit'))
})

type Mock = { quotaHits: number; okHits: number }

async function mockProvider(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ base: string; close(): void }> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { base: `http://127.0.0.1:${address.port}/v1`, close: () => server.close() }
}

async function makeRouter(baseA: string, baseB: string, mock: Mock) {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-failover-'))
  const store = new ModelSettingsStore(join(dir, 'model-config.json'), {
    local: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', visionModel: '', embedModel: '', keepAlive: '24h' },
  })
  await store.addProfile({ id: 'quota-a', label: 'A 供应商', baseUrl: baseA, model: 'a-model' })
  await store.addProfile({ id: 'ok-b', label: 'B 供应商', baseUrl: baseB, model: 'b-model' })
  await store.setPriority(['quota-a', 'ok-b'])
  const events: Array<{ event: string; payload: Record<string, unknown> }> = []
  const settings = await store.load()
  const profileA = settings.profiles.find(item => item.id === 'quota-a')
  if (!profileA) throw new Error('missing profile')
  const router = new ModelRouter(
    // The "current" client is a thin stub; the failover chain drives real HTTP.
    {
      model: 'a-model', visionModel: '', embedModel: '',
      health: async () => ({ ok: true, models: [] }),
      chatStream: async function* () {
        mock.quotaHits += 1
        throw new OpenAIError('HTTP 402 insufficient balance', 402)
      },
      chatOnce: async () => { mock.quotaHits += 1; throw new OpenAIError('HTTP 402 insufficient balance', 402) },
      vision: async () => { throw new Error('no vision') },
      embed: async () => null,
    },
    profileA,
    undefined,
    undefined,
    {
      loadSettings: () => store.load(),
      persistCooldown: (id, entry) => store.setCooldown(id, entry),
      emit: (event, payload) => events.push({ event, payload }),
    },
  )
  return { router, store, events, dir }
}

function sseHandler(mock: Mock) {
  return (request: IncomingMessage, response: ServerResponse) => {
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'b-model' }] }))
      return
    }
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      mock.okHits += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"B 应答"}}]}\n\ndata: [DONE]\n\n')
    })
  }
}

test('quota failure fails over to the next provider and parks the first', async () => {
  const mock: Mock = { quotaHits: 0, okHits: 0 }
  const b = await mockProvider(sseHandler(mock))
  try {
    const { router, store, events, dir } = await makeRouter('http://127.0.0.1:1/v1', b.base, mock)
    try {
      const reply = await router.chatOnce([{ role: 'user', content: 'hi' }], { timeoutMs: 5000 })
      assert.equal(reply, 'B 应答')
      assert.equal(mock.quotaHits, 1)
      assert.equal(mock.okHits, 1)
      // The failing provider is parked with a persisted quota cooldown.
      const settings = await store.load()
      const parked = settings.cooldowns['quota-a']
      assert.ok(parked && parked.until > Date.now() && parked.kind === 'quota')
      // The UI is notified which provider took over.
      assert.equal(events.length, 1)
      assert.equal(events[0].event, 'model.failover')
      assert.equal(events[0].payload.from, 'quota-a')
      assert.equal(events[0].payload.to, 'ok-b')
      // Subsequent requests go straight to the working provider.
      assert.equal(router.status().id, 'ok-b')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  } finally {
    b.close()
  }
})

test('a parked provider is skipped until its cooldown expires', async () => {
  const mock: Mock = { quotaHits: 0, okHits: 0 }
  const b = await mockProvider(sseHandler(mock))
  try {
    const { router, store, dir } = await makeRouter('http://127.0.0.1:1/v1', b.base, mock)
    try {
      await store.setCooldown('quota-a', { until: Date.now() + 60_000, kind: 'quota', reason: 'test' })
      const reply = await router.chatOnce([{ role: 'user', content: 'hi' }], { timeoutMs: 5000 })
      assert.equal(reply, 'B 应答')
      assert.equal(mock.quotaHits, 0, 'parked provider must not be hit')

      // Expired cooldown => preferred provider is tried first again, fails,
      // and the chain transparently recovers through the next provider.
      await store.setCooldown('quota-a', { until: Date.now() - 1, kind: 'quota', reason: 'stale' })
      const again = await router.chatOnce([{ role: 'user', content: 'hi' }], { timeoutMs: 5000 })
      assert.equal(again, 'B 应答')
      assert.equal(mock.quotaHits, 1, 'recovered slot is retried')
      assert.equal(mock.okHits, 2, 'then it still fails over to B')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  } finally {
    b.close()
  }
})

test('mid-stream failure is not retried on the next provider', async () => {
  const mock: Mock = { quotaHits: 0, okHits: 0 }
  const b = await mockProvider(sseHandler(mock))
  try {
    const dir = await mkdtemp(join(tmpdir(), 'jarvis-failover-mid-'))
    const store = new ModelSettingsStore(join(dir, 'model-config.json'), {
      local: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', visionModel: '', embedModel: '', keepAlive: '24h' },
    })
    await store.addProfile({ id: 'flaky', label: 'flaky', baseUrl: 'http://127.0.0.1:1/v1', model: 'x' })
    await store.addProfile({ id: 'ok-b', label: 'B', baseUrl: b.base, model: 'b-model' })
    await store.setPriority(['flaky', 'ok-b'])
    const settings: ModelSettings = await store.load()
    const flaky = settings.profiles.find(item => item.id === 'flaky')
    if (!flaky) throw new Error('missing')
    const router = new ModelRouter(
      {
        model: 'x', visionModel: '', embedModel: '',
        health: async () => ({ ok: true, models: [] }),
        chatStream: async function* () {
          yield '半句'
          throw new OpenAIError('HTTP 402 insufficient balance', 402)
        },
        chatOnce: async () => 'unused',
        vision: async () => { throw new Error('no') },
        embed: async () => null,
      },
      flaky,
      undefined,
      undefined,
      { loadSettings: () => store.load(), persistCooldown: (id, entry) => store.setCooldown(id, entry) },
    )
    try {
      let seen = ''
      await assert.rejects(async () => {
        for await (const delta of router.chatStream([{ role: 'user', content: 'hi' }], { timeoutMs: 5000 })) seen += delta
      }, /402/)
      assert.equal(seen, '半句')
      assert.equal(mock.okHits, 0, 'no silent retry after partial output')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  } finally {
    b.close()
  }
})

test('scenario model override is dropped after failing over to another provider', async () => {
  const mock: Mock = { quotaHits: 0, okHits: 0 }
  let servedModel = ''
  const b = await mockProvider((request, response) => {
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'b-model' }] }))
      return
    }
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      mock.okHits += 1
      servedModel = JSON.parse(raw).model
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    })
  })
  try {
    const { router, dir } = await makeRouter('http://127.0.0.1:1/v1', b.base, mock)
    try {
      // Scenario pins a model that only exists on the first provider.
      const reply = await router.chatOnce([{ role: 'user', content: 'hi' }], { timeoutMs: 5000, model: 'scenario-only-model' })
      assert.equal(reply, 'ok')
      assert.equal(servedModel, 'b-model', 'fallback provider must use its own default model')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  } finally {
    b.close()
  }
})
