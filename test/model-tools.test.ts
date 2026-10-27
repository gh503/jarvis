import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenAICompatibleClient, OpenAIError } from '../src/model/openai.ts'
import { AnthropicClient } from '../src/model/anthropic.ts'
import { OllamaClient } from '../src/model/ollama.ts'
import { ModelRouter } from '../src/model/router.ts'
import { estimateMessagesTokens } from '../src/model/context-budget.ts'
import { ToolCallBuffer, type ChatMessage, type ModelClient, type ModelStreamEvent } from '../src/model/types.ts'
import type { ModelProfile, ModelSettings } from '../src/model/settings.ts'

const tools = [{ name: 'lookup', description: 'Look up a value', parameters: { type: 'object' } }]
const history: ChatMessage[] = [{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{"q":1}' }] }, { role: 'tool', content: 'result', toolCallId: 'c1', name: 'lookup' }]
const collect = async (stream: AsyncGenerator<ModelStreamEvent>) => { const events: ModelStreamEvent[] = []; for await (const e of stream) events.push(e); return events }
const sse = (events: unknown[]) => events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('')
function mock(t: any, wire: string, contentType = 'text/event-stream') {
  let body: any
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body))
    const bytes = new TextEncoder().encode(wire)
    let offset = 0
    return new Response(new ReadableStream({ pull(controller) { if (offset >= bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + 7)); offset += 7 } }, cancel() { cancelled = true } }), { headers: { 'content-type': contentType } })
  })
  return { body: () => body, cancelled: () => cancelled }
}
const chat = () => new OpenAICompatibleClient({ baseUrl: 'http://localhost', model: 'test' })
const cc = (delta: unknown, finish_reason?: string) => ({ choices: [{ delta, finish_reason }] })

test('chat tool fragments are assembled, raw invalid JSON remains runtime responsibility, and replay uses native fields', async t => {
  const wire = mock(t, sse([cc({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'unknown', arguments: '{' } }] }), cc({ tool_calls: [{ index: 0, function: { arguments: 'bad' } }] }), cc({}, 'tool_calls')]))
  const client = chat()
  assert.equal(await client.supportsTools(), false)
  const result = await collect(client.toolStream(history, { tools }))
  assert.deepEqual(result, [{ type: 'tool-call', call: { id: 'c', name: 'unknown', arguments: '{bad' } }, { type: 'finish', reason: 'tool-calls' }])
  assert.equal(wire.body().messages[0].tool_calls[0].function.arguments, '{"q":1}')
  assert.equal(wire.body().messages[1].tool_call_id, 'c1')
  assert.equal(wire.body().tools[0].function.name, 'lookup')
})

test('length finish discards pending tool calls', async t => {
  mock(t, sse([cc({ tool_calls: [{ index: 0, id: 'c', function: { name: 'lookup', arguments: '{' } }] }), cc({}, 'length')]))
  assert.deepEqual(await collect(chat().toolStream([], { tools })), [{ type: 'finish', reason: 'length' }])
})

test('missing finish and malformed provider JSON fail without dispatching partial calls', async t => {
  mock(t, sse([cc({ tool_calls: [{ index: 0, id: 'c', function: { name: 'lookup', arguments: '{}' } }] })]))
  await assert.rejects(collect(chat().toolStream([])), /without finish/)
  t.mock.restoreAll()
  mock(t, 'data: {not-json}\n\n')
  await assert.rejects(collect(chat().toolStream([])), /Malformed provider JSON/)
})

test('tool buffer validates all IDs and bounds before dispatch', () => {
  const buffer = new ToolCallBuffer()
  buffer.patch(0, { id: 'a', name: 'x', arguments: '{}' })
  buffer.patch(1, { id: 'a', name: 'y', arguments: '{}' })
  assert.throws(() => buffer.complete(), /duplicate/)
  assert.throws(() => new ToolCallBuffer().patch(0, { arguments: '你'.repeat(90000) }), /256KB/)
  const many = new ToolCallBuffer()
  for (let i = 0; i < 32; i++) many.patch(i, { id: String(i), name: 'x', arguments: '{}' })
  assert.throws(() => many.patch(32, {}), /32 calls/)
})

test('Responses maps calls/results and waits for response.completed', async t => {
  const item = { type: 'function_call', id: 'item', call_id: 'call', name: 'lookup', arguments: '{"q":1}' }
  const wire = mock(t, sse([
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"q":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '1}' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { status: 'completed', output: [item] } },
  ]))
  const client = new OpenAICompatibleClient({ baseUrl: 'http://localhost', model: 'test', protocol: 'responses' })
  assert.deepEqual(await collect(client.toolStream(history, { tools })), [{ type: 'tool-call', call: { id: 'call', name: 'lookup', arguments: '{"q":1}' } }, { type: 'finish', reason: 'tool-calls' }])
  assert.equal(wire.body().input[0].type, 'function_call')
  assert.equal(wire.body().input[1].type, 'function_call_output')
  assert.equal(wire.body().tools[0].name, 'lookup')
})

test('Anthropic maps parallel results and JSON fragments', async t => {
  const wire = mock(t, sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'lookup', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '2}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ]))
  const client = new AnthropicClient({ baseUrl: 'http://localhost', model: 'test' })
  assert.deepEqual(await collect(client.toolStream(history, { tools })), [{ type: 'tool-call', call: { id: 'a', name: 'lookup', arguments: '{"q":2}' } }, { type: 'finish', reason: 'tool-calls' }])
  assert.equal(wire.body().messages[0].content[0].type, 'tool_use')
  assert.equal(wire.body().messages[1].content[0].tool_use_id, 'c1')
  assert.equal(wire.body().tools[0].input_schema.type, 'object')
})

test('Ollama native tool calls get unique generated IDs and native replay', async t => {
  const wire = mock(t, [{ message: { tool_calls: [{ function: { name: 'lookup', arguments: { q: 3 } } }] }, done: false }, { done: true, done_reason: 'stop' }].map(x => JSON.stringify(x)).join('\n'), 'application/x-ndjson')
  const client = new OllamaClient('http://localhost', { model: 'test', visionModel: '', embedModel: '' })
  const result = await collect(client.toolStream(history, { tools }))
  assert.equal(result[0].type, 'tool-call')
  if (result[0].type !== 'tool-call') throw new Error('missing call')
  assert.match(result[0].call.id, /^ollama_/)
  assert.equal(result[0].call.arguments, '{"q":3}')
  assert.deepEqual(result[1], { type: 'finish', reason: 'tool-calls' })
  assert.equal(wire.body().messages[0].tool_calls[0].function.arguments.q, 1)
  assert.equal(wire.body().messages[1].tool_name, 'lookup')
})

test('abort after text cancels stream before tool dispatch', async t => {
  const wire = mock(t, sse([cc({ content: 'hello' }), cc({ tool_calls: [{ index: 0, id: 'c', function: { name: 'lookup', arguments: '{}' } }] }), cc({}, 'tool_calls')]))
  const controller = new AbortController()
  const stream = chat().toolStream([], { signal: controller.signal })
  assert.deepEqual((await stream.next()).value, { type: 'text', text: 'hello' })
  controller.abort()
  await assert.rejects(stream.next(), { name: 'AbortError' })
  assert.equal(wire.cancelled(), true)
})

function profile(id: string, supportsTools = true): ModelProfile {
  return { id, supportsTools, label: id, kind: 'openai', protocol: 'chat-completions', baseUrl: 'http://localhost', model: id, apiKey: '', visionModel: '', embedModel: '', keepAlive: '' }
}
function stub(stream: () => AsyncGenerator<ModelStreamEvent>): ModelClient {
  return { model: 'a', visionModel: '', embedModel: '', supportsTools: async () => true, toolStream: stream, chatStream: async function* () {}, chatOnce: async () => '', health: async () => ({ ok: true, models: [] }), vision: async () => '', embed: async () => null }
}
function router(first: ModelClient, profiles = [profile('a'), profile('unsupported', false), profile('b')]) {
  const settings: ModelSettings = { active: 'a', profiles, priority: profiles.map(p => p.id), scenarios: [], scenarioAuto: false, defaultScenario: '', cooldowns: {} }
  return new ModelRouter(first, profiles[0], undefined, undefined, { loadSettings: async () => settings, persistCooldown: async () => {} })
}

test('router retries empty failure only on supported profiles', async t => {
  const wire = mock(t, sse([cc({ content: 'fallback' }), cc({}, 'stop')]))
  const routed = router(stub(async function* () { throw new OpenAIError('503', 503) }))
  assert.equal(await routed.supportsTools(), true)
  assert.equal((await collect(routed.toolStream([])))[0].type, 'text')
  assert.equal(wire.body().model, 'b')
})

for (const event of [{ type: 'text', text: '' }, { type: 'tool-call', call: { id: 'c', name: 'lookup', arguments: '{}' } }, { type: 'finish', reason: 'stop' }] as ModelStreamEvent[]) {
  test(`router never retries after ${event.type}`, async t => {
    let fetched = false
    t.mock.method(globalThis, 'fetch', async () => { fetched = true; throw new Error('unexpected fallback') })
    const routed = router(stub(async function* () { yield event; throw new OpenAIError('503', 503) }))
    await assert.rejects(collect(routed.toolStream([])), /503/)
    assert.equal(fetched, false)
  })
}

test('unsupported first selection disables tools and schema budget is guarded', async () => {
  const routed = router(stub(async function* () {}), [profile('a', false), profile('b')])
  assert.equal(await routed.supportsTools(), false)
  await assert.rejects(collect(routed.toolStream([])), /does not support/)
  const guarded = router(stub(async function* () { throw new Error('should not run') }), [profile('a')])
  await assert.rejects(collect(guarded.toolStream([], { tools: [{ ...tools[0], description: 'x'.repeat(12000) }] })), /context window/)
  assert.ok(estimateMessagesTokens(history, tools) > estimateMessagesTokens(history))
  assert.ok(estimateMessagesTokens(history) > estimateMessagesTokens(history.map(m => ({ role: m.role, content: m.content }))))
})

for (const protocol of ['responses', 'anthropic', 'ollama']) {
  test(`${protocol} truncation never publishes buffered tool calls`, async t => {
    let client: ModelClient
    if (protocol === 'responses') {
      mock(t, sse([{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'lookup', arguments: '' } }, { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }]))
      client = new OpenAICompatibleClient({ baseUrl: 'http://localhost', model: 'test', protocol: 'responses' })
    } else if (protocol === 'anthropic') {
      mock(t, sse([{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'c', name: 'lookup', input: {} } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }]))
      client = new AnthropicClient({ baseUrl: 'http://localhost', model: 'test' })
    } else {
      mock(t, JSON.stringify({ message: { tool_calls: [{ function: { name: 'lookup', arguments: {} } }] }, done: true, done_reason: 'length' }), 'application/x-ndjson')
      client = new OllamaClient('http://localhost', { model: 'test', visionModel: '', embedModel: '' })
    }
    assert.deepEqual(await collect(client.toolStream!([], { tools })), [{ type: 'finish', reason: 'length' }])
  })
}

test('cancellation between complete parallel calls prevents the remaining dispatches', async t => {
  mock(t, sse([cc({ tool_calls: [0, 1].map(index => ({ index, id: `c${index}`, function: { name: 'lookup', arguments: '{}' } })) }), cc({}, 'tool_calls')]))
  const controller = new AbortController()
  const stream = chat().toolStream([], { signal: controller.signal })
  assert.equal((await stream.next()).value.type, 'tool-call')
  controller.abort()
  await assert.rejects(stream.next(), { name: 'AbortError' })
})

test('Responses retains opaque reasoning items for the next tool round', async t => {
  const reasoning = { type: 'reasoning', id: 'r1', encrypted_content: 'opaque', summary: [] }
  const call = { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{}' }
  const wire = mock(t, sse([{ type: 'response.completed', response: { status: 'completed', output: [reasoning, call] } }]))
  const client = new OpenAICompatibleClient({ baseUrl: 'http://localhost', model: 'test', protocol: 'responses' })
  await collect(client.toolStream([], { tools }))
  await collect(client.toolStream(history, { tools }))
  assert.deepEqual(wire.body().input[0], reasoning)
})

test('Anthropic retains signed thinking and empty object arguments', async t => {
  const thinking = { type: 'thinking', thinking: 'reason', signature: 'signed' }
  const wire = mock(t, sse([
    { type: 'content_block_start', index: 0, content_block: thinking }, { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'c1', name: 'lookup', input: {} } }, { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
  ]))
  const client = new AnthropicClient({ baseUrl: 'http://localhost', model: 'test' })
  const events = await collect(client.toolStream([], { tools }))
  assert.equal(events[0].type === 'tool-call' && events[0].call.arguments, '{}')
  await collect(client.toolStream(history, { tools }))
  assert.deepEqual(wire.body().messages[0].content[0], thinking)
})


test('tool history remains on its issuing profile despite priority changes and empty failure', async t => {
  let fetched = false
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; throw new Error('privacy leak') })
  let rounds = 0
  const first = stub(async function* () {
    if (++rounds === 1) {
      yield { type: 'tool-call', call: { id: 'c1', name: 'lookup', arguments: '{}' } }
      yield { type: 'finish', reason: 'tool-calls' }
    } else throw new OpenAIError('503', 503)
  })
  const routed = router(first)
  await collect(routed.toolStream([]))
  await assert.rejects(collect(routed.toolStream(history, { profileIds: ['b', 'a'] })), /503/)
  assert.equal(fetched, false)
  assert.equal(rounds, 2)
})

test('unknown tool history and conflicting explicit pin fail before network access', async t => {
  let fetched = false
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; throw new Error('privacy leak') })
  const routed = router(stub(async function* () {
    yield { type: 'tool-call', call: { id: 'c1', name: 'lookup', arguments: '{}' } }
    yield { type: 'finish', reason: 'tool-calls' }
  }))
  await assert.rejects(collect(routed.toolStream(history)), /origin unavailable/)
  await collect(routed.toolStream([]))
  await assert.rejects(collect(routed.toolStream(history, { pinnedProfileId: 'b' })), /different provider/)
  assert.equal(fetched, false)
})

test('explicit provider pin disables first-round failover', async t => {
  let fetched = false
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; throw new Error('privacy leak') })
  const routed = router(stub(async function* () { throw new OpenAIError('503', 503) }))
  await assert.rejects(collect(routed.toolStream([], { pinnedProfileId: 'a' })), /503/)
  assert.equal(fetched, false)
  assert.equal((routed as ModelClient).isLocal, undefined)
})


test('toolClient resolves scenario head without network or skipping unsupported head', async t => {
  let fetched = false
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; throw new Error('unexpected network') })
  const routed = router(stub(async function* () {}))
  const selected = await routed.toolClient({ profileIds: ['b', 'a'] })
  assert.equal(selected?.model, 'b')
  assert.notEqual(selected, routed)
  assert.equal(await routed.toolClient({ profileIds: ['unsupported', 'b'] }), undefined)
  assert.equal(fetched, false)
})

test('toolClient honors cooldowns and returns selected native locality', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network') })
  const a = profile('a')
  const local = { ...profile('local-tools'), kind: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434' }
  const settings: ModelSettings = { active: 'a', profiles: [a, local], priority: ['a', local.id], scenarios: [], scenarioAuto: false, defaultScenario: '', cooldowns: { a: { until: Date.now() + 60000, kind: 'server', reason: 'test' } } }
  const routed = new ModelRouter(stub(async function* () {}), a, undefined, undefined, { loadSettings: async () => settings, persistCooldown: async () => {} })
  const selected = await routed.toolClient()
  assert.equal(selected?.model, local.model)
  assert.equal(selected?.isLocal, true)
  settings.priority = ['a']
  settings.cooldowns = {}
  assert.equal(selected?.model, local.model, 'returned adapter stays pinned after settings changes')
  assert.equal((await routed.toolClient())?.model, 'a')
})
