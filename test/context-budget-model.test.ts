import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextLimitsFor, estimateMessagesTokens, estimateTextTokens, isContextOverflow } from '../src/model/context-budget.ts'
import { classifyModelError } from '../src/model/failover.ts'
import { ModelSettingsStore, type ModelProfile, type ModelSettings } from '../src/model/settings.ts'
import { createModelClient, ModelRouter } from '../src/model/router.ts'
import type { ModelClient } from '../src/model/types.ts'

const profile: ModelProfile = { id: 'local', label: 'local', kind: 'ollama', protocol: 'chat-completions', baseUrl: 'http://localhost:11434', model: 'm', apiKey: '', visionModel: '', embedModel: '', keepAlive: '' }
const messages = [{ role: 'user' as const, content: 'hi' }]

test('conservative text estimate and validated output budgets', () => {
  assert.equal(estimateTextTokens('abcd'), 2)
  assert.equal(estimateTextTokens('中文🙂'), 5)
  assert.ok(estimateMessagesTokens(messages) > estimateTextTokens('hi'))
  assert.throws(() => estimateMessagesTokens([{ ...messages[0], images: ['image'] }]), /text messages only/)
  assert.deepEqual(contextLimitsFor(undefined), { contextWindow: 4096, maxOutputTokens: 1024 })
  assert.equal(contextLimitsFor(8192, { maxTokens: 99999 }).maxOutputTokens, 4096)
  assert.equal(contextLimitsFor(8192, { model: 'unknown' }, 'known').contextWindow, 4096)
  for (const invalid of [0, -1, 2047, 2_000_001, 8192.5, NaN]) assert.throws(() => contextLimitsFor(invalid))
})

test('context configuration roundtrips and omitted UI fields preserve capacity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-context-model-'))
  const file = join(dir, 'models.json')
  const defaults = { local: { baseUrl: profile.baseUrl, model: 'm', visionModel: '', embedModel: '', keepAlive: '' } }
  try {
    const store = new ModelSettingsStore(file, defaults)
    await store.upsert({ id: 'local', contextWindow: 16384 })
    await store.upsert({ id: 'local', label: 'renamed' })
    assert.equal(store.publicView(await store.load()).profiles[0].contextWindow, 16384)
    assert.equal((await new ModelSettingsStore(file, defaults).load()).profiles[0].contextWindow, 16384)
    await assert.rejects(store.upsert({ id: 'local', contextWindow: 1 }), /contextWindow/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('overflow recognition is narrow and precedes quota classification', () => {
  for (const error of [
    { error: { code: 'context_length_exceeded', message: 'request rejected' } },
    new Error('This model maximum context length is 4096 tokens'),
    new Error('prompt is too long: 10000 tokens > 4096 maximum'),
    new Error('input length exceeds the context window limit'),
  ]) { assert.equal(isContextOverflow(error), true); assert.equal(classifyModelError(error), 'client') }
  for (const error of [{ status: 400 }, new Error('insufficient_quota'), new Error('rate limit exceeded'), new Error('invalid max_tokens')]) assert.equal(isContextOverflow(error), false)
})

for (const protocol of ['ollama', 'chat-completions', 'responses', 'anthropic'] as const) {
  test(`${protocol} adapter caps payload and rejects only opted-in truncated output`, async t => {
    const client = createModelClient({ ...profile, kind: protocol === 'ollama' ? 'ollama' : 'openai', protocol: protocol === 'ollama' ? 'chat-completions' : protocol, contextWindow: 8192 })
    assert.deepEqual(await client.contextLimits?.(), { contextWindow: 8192, maxOutputTokens: 2048 })
    let payload: any
    const data = protocol === 'ollama' ? { message: { content: 'partial' }, done: true, done_reason: 'length' }
      : protocol === 'anthropic' ? { content: [{ text: 'partial' }], stop_reason: 'max_tokens' }
      : protocol === 'responses' ? { output_text: 'partial', incomplete_details: { reason: 'max_output_tokens' } }
      : { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      payload = JSON.parse(String(init.body))
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
    })
    assert.equal(await client.chatOnce(messages, { maxTokens: 99999 }), 'partial')
    assert.equal(payload.options?.num_predict ?? payload.max_tokens ?? payload.max_output_tokens, 4096)
    if (protocol === 'ollama') assert.equal(payload.options.num_ctx, 8192)
    await assert.rejects(client.chatOnce(messages, { requireComplete: true }), /Summary truncated/)
  })

  test(`${protocol} adapter standardizes actual HTTP context overflow`, async t => {
    const client = createModelClient({ ...profile, kind: protocol === 'ollama' ? 'ollama' : 'openai', protocol: protocol === 'ollama' ? 'chat-completions' : protocol })
    const error = protocol === 'anthropic' ? { type: 'invalid_request_error', message: 'prompt is too long: 5000 > 4096 tokens' }
      : protocol === 'ollama' ? 'input length exceeds the context window' : { code: 'context_length_exceeded', message: 'request rejected' }
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error }), { status: 400 }))
    await assert.rejects(client.chatOnce(messages), (err: any) => err.code === 'CONTEXT_WINDOW_EXCEEDED')
  })
}

for (const protocol of ['ollama', 'chat-completions', 'responses', 'anthropic'] as const) {
  test(`${protocol} streaming finish reason rejects incomplete summaries`, async t => {
    const client = createModelClient({ ...profile, kind: protocol === 'ollama' ? 'ollama' : 'openai', protocol: protocol === 'ollama' ? 'chat-completions' : protocol })
    const events = protocol === 'ollama'
      ? [{ message: { content: 'partial' } }, { done: true, done_reason: 'length' }]
      : protocol === 'anthropic'
      ? [{ type: 'content_block_delta', delta: { text: 'partial' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }]
      : protocol === 'responses'
      ? [{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]
      : [{ choices: [{ delta: { content: 'partial' } }] }, { choices: [{ finish_reason: 'length' }] }]
    const body = events.map(event => `${protocol === 'ollama' ? '' : 'data: '}${JSON.stringify(event)}\n\n`).join('')
    t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-type': protocol === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' } }))
    assert.equal(await client.chatOnce(messages), 'partial')
    await assert.rejects(client.chatOnce(messages, { requireComplete: true }), /Summary truncated/)
  })
}

test('router refreshes cached inactive and current clients after capacity changes', async t => {
  const first = { ...profile, contextWindow: 4096 }
  const second = { ...profile, id: 'second', contextWindow: 4096 }
  const settings = { profiles: [first, second], priority: ['local', 'second'], cooldowns: {} } as ModelSettings
  const router = new ModelRouter(createModelClient(first), first, undefined, undefined, { loadSettings: async () => settings, persistCooldown: async () => {} })
  const windows: number[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    windows.push(JSON.parse(String(init.body)).options.num_ctx)
    return new Response(JSON.stringify({ message: { content: 'ok' }, done: true }))
  })
  await router.chatOnce(messages, { profileIds: ['second'] })
  await router.chatOnce(messages, { profileIds: ['local'] })
  settings.profiles[1] = { ...second, contextWindow: 16384 }
  await router.chatOnce(messages, { profileIds: ['second'] })
  settings.profiles[1] = { ...second, contextWindow: 8192 }
  await router.chatOnce(messages, { profileIds: ['second'] })
  assert.deepEqual(windows, [4096, 4096, 16384, 8192])
})

test('router rejects oversized text at send time without parking and leaves images alone', async t => {
  const first = { ...profile, contextWindow: 16384 }
  const settings = { profiles: [first], priority: ['local'], cooldowns: {} } as ModelSettings
  let parked = 0
  let requests = 0
  const router = new ModelRouter(createModelClient(first), first, undefined, undefined, { loadSettings: async () => settings, persistCooldown: async () => { parked++ } })
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return new Response(JSON.stringify({ message: { content: 'ok' }, done: true }))
  })
  assert.equal((await router.contextLimits()).contextWindow, 16384)
  settings.profiles[0] = { ...first, contextWindow: 4096 }
  const oversized = [{ role: 'user' as const, content: 'x'.repeat(9000) }]
  const overflow = (error: any) => error.code === 'CONTEXT_WINDOW_EXCEEDED'
  await assert.rejects(router.chatOnce(oversized), overflow)
  await assert.rejects(async () => { for await (const _ of router.chatStream(oversized)) {} }, overflow)
  await assert.rejects(router.chatOnce(messages, { numCtx: 16, maxTokens: 4 }), overflow)
  assert.equal(requests, 0)
  assert.equal(parked, 0)
  assert.equal(await router.chatOnce([{ ...oversized[0], images: ['image'] }]), 'ok')
  assert.equal(requests, 1)
})

test('router uses actual scenario chain minimum and never parks or retries overflow', async () => {
  const first = { ...profile, contextWindow: 16384 }
  const second = { ...profile, id: 'second', contextWindow: 8192 }
  const settings = { profiles: [first, second], priority: ['local', 'second'], cooldowns: {} } as ModelSettings
  let calls = 0
  let parked = 0
  const fail = () => { calls++; throw new Error('maximum context length exceeded') }
  const client: ModelClient = { model: 'm', visionModel: '', embedModel: '', health: async () => ({ ok: true, models: [] }), chatOnce: async () => fail(), chatStream: async function* () { fail() }, vision: async () => '', embed: async () => null }
  const router = new ModelRouter(client, first, undefined, undefined, { loadSettings: async () => settings, persistCooldown: async () => { parked++ } })
  assert.deepEqual(await router.contextLimits(), { contextWindow: 8192, maxOutputTokens: 2048 })
  assert.equal((await router.contextLimits({ profileIds: ['local'] })).contextWindow, 16384)
  assert.equal((await router.contextLimits({ model: 'unknown' })).contextWindow, 4096)
  await assert.rejects(router.chatOnce(messages), /context length/)
  await assert.rejects(async () => { for await (const _ of router.chatStream(messages)) {} }, /context length/)
  assert.equal(calls, 2)
  assert.equal(parked, 0)
})
