import test from 'node:test'
import assert from 'node:assert/strict'
import { runToolLoop, type ToolLoopInput } from '../src/tool-loop.ts'
import { SessionStore } from '../src/sessions.ts'
import { ToolJournal } from '../src/tool-journal.ts'
import { ToolRuntime, type ToolDefinition } from '../src/tools.ts'
import { EventBus } from '../src/events.ts'
import { estimateMessagesTokens, estimateTextTokens } from '../src/model/context-budget.ts'
import type { ChatMessage, ModelClient, ModelStreamEvent, ToolCall, ToolSchema } from '../src/model/types.ts'

const call = (id: string, name = 'read', args = '{}'): ToolCall => ({ id, name, arguments: args })
const response = (...calls: ToolCall[]): ModelStreamEvent[] => [
  ...calls.map(call => ({ type: 'tool-call' as const, call })), { type: 'finish', reason: 'tool-calls' },
]
const final: ModelStreamEvent[] = [{ type: 'text', text: 'Final answer' }, { type: 'finish', reason: 'stop' }]
type Script = ModelStreamEvent[] | (() => AsyncGenerator<ModelStreamEvent>)
function fixture(t: test.TestContext, scripts: Script[]) {
  const sessions = new SessionStore({ file: ':memory:' })
  t.after(() => sessions.close())
  const journal = new ToolJournal(sessions)
  const sessionId = sessions.create().id, turnId = 'turn'
  sessions.beginTurn(sessionId, turnId, 'Question', 'test')
  const executed: string[] = []
  let definitions: ToolDefinition[] = [{ name: 'read', description: 'Read', parameters: { type: 'object' }, definitionHash: 'v1',
    usage: 'shared', permission: 'allow', effect: 'read', destination: 'local',
    execute: async (_, context) => { executed.push(context.callId); return { content: 'Result ' + context.callId } } }]
  const bus = new EventBus()
  const runtime = new ToolRuntime({ definitions: () => definitions, journal, bus })
  const requests: ChatMessage[][] = []
  const requestedSchemas: ToolSchema[][] = []
  const client: ModelClient = {
    model: 'fake', visionModel: 'fake', embedModel: 'fake', isLocal: true,
    health: async () => ({ ok: true, models: [] }),
    async *chatStream() { throw new Error('unexpected plain stream') },
    chatOnce: async () => { throw new Error('unexpected chatOnce') },
    vision: async () => { throw new Error('unexpected vision') }, embed: async () => null,
    async *toolStream(messages, options) {
      requestedSchemas.push(structuredClone(options?.tools ?? []))
      requests.push(structuredClone(messages))
      const script = scripts[requests.length - 1]
      assert.ok(script, 'unexpected extra model request')
      if (typeof script === 'function') yield* script()
      else yield* script
    },
  }
  const controller = new AbortController(), deltas: string[] = [], notices: string[] = []
  const input: ToolLoopInput = {
    client, options: { signal: controller.signal }, messages: [{ role: 'user', content: 'Question' }],
    schemas: runtime.schemas({ allowRemote: true, allowLocalResults: true }), allowedDefinitions: new Map([['read', 'v1']]),
    runtime, journal, sessionId, turnId, allowRemote: true, allowLocalResults: true,
    contextWindow: 32768, maxTokens: 1024,
    check: () => controller.signal.throwIfAborted(), delta: text => deltas.push(text), notice: text => notices.push(text),
  }
  const setDefinitions = (next: ToolDefinition[]) => {
    definitions = next
    input.schemas = runtime.schemas(input)
    input.allowedDefinitions = new Map(next.map(d => [d.name, d.definitionHash]))
  }
  return { input, sessions, journal, runtime, bus, controller, executed, requests, requestedSchemas, deltas, notices,
    definition: definitions[0], setDefinitions, setCatalogue: (next: ToolDefinition[]) => { definitions = next }, run: () => runToolLoop(input) }
}

test('successful memory mutations end with acknowledgement without replaying invalidated context or later calls', async t => {
  const f=fixture(t,[response(call('change','memory_correct'),call('later'))])
  let changed=false
  f.setDefinitions([{...f.definition,name:'memory_correct',effect:'write',usage:'local',execute:async()=>{changed=true;return {content:'{"id":"memory","status":"confirmed"}'}}},f.definition])
  f.input.check=()=>{if(changed)throw new Error('old context invalid')}
  const result=await f.run()
  assert.equal(f.requests.length,1)
  assert.deepEqual(f.executed,[])
  assert.equal(result.localOnly,true)
  assert.match(result.text,/已订正/)
  f.journal.closeTurn(f.input.sessionId,f.input.turnId)
  assert.equal(f.journal.getCall(f.input.sessionId,f.input.turnId,'later')?.status,'cancelled')
})

function discoveryFixture(t: test.TestContext, overrides: Partial<ToolDefinition> = {}, scripts: Script[] = [response(call('search', 'tool_search')), response(call('use', 'mcp_read')), final]) {
  const f = fixture(t, scripts)
  const discovered: ToolDefinition = { ...f.definition, name: 'mcp_read', ...overrides }
  const search: ToolDefinition = { ...f.definition, name: 'tool_search', execute: async () => ({ content: JSON.stringify({ tools: [{ name: 'mcp_read' }] }) }) }
  f.setCatalogue([search, discovered])
  f.input.schemas = [{ name: search.name, description: search.description, parameters: search.parameters }]
  f.input.allowedDefinitions = new Map([[search.name, search.definitionHash]])
  return { ...f, search, discovered }
}

test('discovery loads MCP schema for next request and pins its definition before execution', async t => {
  const f = discoveryFixture(t)
  await f.run()
  assert.deepEqual(f.requestedSchemas[0].map(s => s.name), ['tool_search'])
  assert.ok(f.requestedSchemas[1].some(s => s.name === 'mcp_read'))
  assert.equal(f.input.allowedDefinitions.get('mcp_read'), 'v1')
  assert.deepEqual(f.executed, ['use'])
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'use')?.status, 'succeeded')
})

test('discovery cannot retroactively authorize a same-batch call but authorizes the next step', async t => {
  const f = discoveryFixture(t, {}, [response(call('search', 'tool_search'), call('too-early', 'mcp_read')), response(call('later', 'mcp_read')), final])
  await f.run()
  assert.equal(f.requestedSchemas[0].some(s => s.name === 'mcp_read'), false)
  assert.ok(f.requestedSchemas[1].some(s => s.name === 'mcp_read'))
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'too-early')?.status, 'denied')
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'later')?.status, 'succeeded')
  assert.deepEqual(f.executed, ['later'])
})

test('schema evicted by discovery cannot execute through historical pinned authorization', async t => {
  const f = discoveryFixture(t, { description: 'd'.repeat(700) }, [response(call('search', 'tool_search')), response(call('evicted', 'read'), call('loaded', 'mcp_read')), final])
  const old: ToolDefinition = { ...f.definition, description: 'o'.repeat(700) }
  f.setCatalogue([f.search, old, f.discovered])
  f.input.schemas.push({ name: old.name, description: old.description, parameters: old.parameters })
  f.input.allowedDefinitions.set(old.name, old.definitionHash)
  f.input.contextWindow = 2048; f.input.maxTokens = 256
  await f.run()
  assert.ok(f.requestedSchemas[0].some(s => s.name === 'read'))
  assert.equal(f.requestedSchemas[1].some(s => s.name === 'read'), false)
  assert.equal(f.input.allowedDefinitions.get('read'), 'v1')
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'evicted')?.status, 'denied')
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'loaded')?.status, 'succeeded')
  assert.deepEqual(f.executed, ['loaded'])
})

test('discovery cannot activate local-only tools when local results are forbidden', async t => {
  const f = discoveryFixture(t, { usage: 'local' })
  f.input.allowLocalResults = false
  await f.run()
  assert.equal(f.requestedSchemas[1].some(s => s.name === 'mcp_read'), false)
  assert.equal(f.input.allowedDefinitions.has('mcp_read'), false)
  assert.deepEqual(f.executed, [])
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'use')?.status, 'denied')
})

test('oversized discovered schema is not loaded or authorized', async t => {
  const f = discoveryFixture(t, { description: 'x'.repeat(20000) })
  f.input.contextWindow = 2048; f.input.maxTokens = 256
  await f.run()
  assert.equal(f.requestedSchemas[1].some(s => s.name === 'mcp_read'), false)
  assert.equal(f.input.allowedDefinitions.has('mcp_read'), false)
  assert.deepEqual(f.executed, [])
})

test('discovery skips an oversized first definition and still loads a later fitting tool', async t => {
  const f = discoveryFixture(t)
  const huge: ToolDefinition = { ...f.discovered, name: 'mcp_huge', description: 'x'.repeat(20000) }
  const search: ToolDefinition = { ...f.search, execute: async () => ({ content: JSON.stringify({ tools: [{ name: 'mcp_huge' }, { name: 'mcp_read' }] }) }) }
  f.setCatalogue([search, huge, f.discovered])
  f.input.contextWindow = 2048; f.input.maxTokens = 256
  await f.run()
  assert.equal(f.requestedSchemas[1].some(s => s.name === 'mcp_huge'), false)
  assert.ok(f.requestedSchemas[1].some(s => s.name === 'mcp_read'))
  assert.equal(f.input.allowedDefinitions.has('mcp_huge'), false)
  assert.deepEqual(f.executed, ['use'])
})

test('discovery uses privacy policy after a local result and cannot activate remote tools', async t => {
  const f = discoveryFixture(t, { destination: 'remote' }, [response(call('private', 'private'), call('search', 'tool_search')), response(call('use', 'mcp_read')), final])
  const privateTool: ToolDefinition = { ...f.definition, name: 'private', usage: 'local' }
  f.setCatalogue([privateTool, f.search, f.discovered])
  f.input.schemas.push({ name: privateTool.name, description: privateTool.description, parameters: privateTool.parameters })
  f.input.allowedDefinitions.set(privateTool.name, privateTool.definitionHash)
  const result = await f.run()
  assert.equal(result.localOnly, true)
  assert.equal(f.input.allowRemote, false)
  assert.equal(f.requestedSchemas[1].some(s => s.name === 'mcp_read'), false)
  assert.equal(f.input.allowedDefinitions.has('mcp_read'), false)
  assert.deepEqual(f.executed, ['private'])
})

test('discovery never refreshes a pinned hash to authorize a revoked later call in the same batch', async t => {
  const f = discoveryFixture(t, {}, [response(call('search', 'tool_search'), call('old', 'read')), final])
  const previous = f.definition
  const search: ToolDefinition = { ...f.search, execute: async () => {
    f.setCatalogue([search, f.discovered, { ...previous, definitionHash: 'revoked-v2' }])
    return { content: JSON.stringify({ tools: [{ name: 'mcp_read' }, { name: 'read' }] }) }
  } }
  f.setCatalogue([search, f.discovered, previous])
  f.input.schemas.push({ name: previous.name, description: previous.description, parameters: previous.parameters })
  f.input.allowedDefinitions.set(previous.name, previous.definitionHash)
  await f.run()
  assert.equal(f.input.allowedDefinitions.get('read'), 'v1')
  assert.deepEqual(f.executed, [])
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'old')?.status, 'denied')
})

test('multi-step tools retain assistant/result pairs and publish only final text', async t => {
  const f = fixture(t, [[{ type: 'text', text: 'Intermediate plan' }, ...response(call('a'))], response(call('b')), final])
  const result = await f.run()
  assert.deepEqual(result, { text: 'Final answer', calls: ['a', 'b'], localOnly: false, uncertain: false })
  assert.deepEqual(f.deltas, ['Final answer'])
  assert.deepEqual(f.executed, ['a', 'b'])
  assert.deepEqual(f.requests[2].map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool'])
  assert.equal(f.requests[1][1].content, 'Intermediate plan')
  assert.equal(f.requests[1][2].toolCallId, 'a')
  assert.equal(f.journal.listCalls(f.input.sessionId).length, 2)
})

for (const [label, events] of [
  ['missing finish', [{ type: 'tool-call', call: call('a') }]],
  ['length with calls', [...response(call('a')).slice(0, -1), { type: 'finish', reason: 'length' }]],
  ['length without calls', [{ type: 'text', text: 'Incomplete answer' }, { type: 'finish', reason: 'length' }]],
  ['tool finish without calls', [{ type: 'finish', reason: 'tool-calls' }]],
  ['stop finish with calls', [{ type: 'tool-call', call: call('a') }, { type: 'finish', reason: 'stop' }]],
] as Array<[string, ModelStreamEvent[]]>) {
  test(`rejects ${label} without dispatch or final display`, async t => {
    const f = fixture(t, [events])
    await assert.rejects(f.run())
    assert.deepEqual(f.executed, [])
    assert.deepEqual(f.deltas, [])
    assert.deepEqual(f.journal.listCalls(f.input.sessionId), [])
  })
}

test('provider stream failure after call proposal cannot execute it', async t => {
  const f = fixture(t, [async function* () { yield { type: 'tool-call', call: call('a') }; throw new Error('broken stream') }])
  await assert.rejects(f.run(), /broken stream/)
  assert.deepEqual(f.executed, [])
})

test('budget shrink preserves call arguments and result IDs, retaining complete durable results', async t => {
  const f = fixture(t, [response(call('a', 'read', '{"keep":"argument"}')), final])
  const full = 'x'.repeat(12000)
  f.setDefinitions([{ ...f.definition, execute: async () => ({ content: full }) }])
  f.input.contextWindow = 2048; f.input.maxTokens = 256
  await f.run()
  const next = f.requests[1]
  assert.deepEqual(next[1].toolCalls, [call('a', 'read', '{"keep":"argument"}')])
  assert.equal(next[2].toolCallId, 'a')
  assert.ok(next[2].content.length < 700)
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'a')?.content, full)
  const budget = 2048 - 256 - Math.ceil(2048 * .08) - estimateTextTokens(JSON.stringify(f.input.schemas)) - 32
  assert.ok(estimateMessagesTokens(next) <= budget)
})

test('irreducible argument budget stops next model request without dropping call pairs', async t => {
  const f = fixture(t, [response(call('a', 'read', JSON.stringify({ large: 'x'.repeat(5000) }))), final])
  f.input.contextWindow = 2048; f.input.maxTokens = 256
  await assert.rejects(f.run(), /容量|上下文/)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.executed, ['a'])
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'a')?.status, 'succeeded')
})

test('per-turn call cap rejects an oversized batch before any dispatch', async t => {
  const f = fixture(t, [response(...Array.from({ length: 17 }, (_, i) => call(String(i))))])
  await assert.rejects(f.run(), /数量上限/)
  assert.deepEqual(f.executed, [])
})

test('eight-step cap stops further model requests and reports incomplete outcome', async t => {
  const f = fixture(t, Array.from({ length: 8 }, (_, i) => response(call(String(i)))))
  const result = await f.run()
  assert.equal(f.requests.length, 8)
  assert.equal(f.executed.length, 8)
  assert.equal(result.uncertain, true)
  assert.match(result.text, /步骤上限/)
})

test('unknown write outcome stops remaining batch calls and model continuation', async t => {
  const f = fixture(t, [response(call('write'), call('must-not-run')), final])
  f.setDefinitions([{ ...f.definition, effect: 'write', execute: async (_, context) => {
    f.executed.push(context.callId); throw new Error('connection lost after dispatch')
  } }])
  const result = await f.run()
  assert.deepEqual(f.executed, ['write'])
  assert.equal(f.requests.length, 1)
  assert.equal(result.uncertain, true)
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'write')?.status, 'unknown')
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'must-not-run'), undefined)
  assert.match(result.text, /不会自动重试/)
})

test('cancellation during stream prevents dispatch', async t => {
  const f = fixture(t, [async function* () {
    yield { type: 'tool-call', call: call('a') }
    f.controller.abort(new Error('cancelled stream'))
    yield { type: 'finish', reason: 'tool-calls' }
  }])
  await assert.rejects(f.run(), /cancelled stream/)
  assert.deepEqual(f.executed, [])
})

test('cancellation during write dispatch journals unknown and prevents remaining calls', async t => {
  const f = fixture(t, [response(call('a'), call('b')), final])
  f.setDefinitions([{ ...f.definition, effect: 'write', execute: async (_, context) => {
    f.executed.push(context.callId)
    f.controller.abort(new Error('cancelled write'))
    return { content: 'late success' }
  } }])
  await assert.rejects(f.run(), /cancelled write/)
  assert.deepEqual(f.executed, ['a'])
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'a')?.status, 'unknown')
  assert.deepEqual(f.deltas, [])
})

test('local result blocks later remote tool dispatch in the same batch', async t => {
  const f = fixture(t, [response(call('private', 'private'), call('remote', 'remote')), final])
  f.setDefinitions([
    { ...f.definition, name: 'private', usage: 'local', execute: async (_, context) => {
      f.executed.push(context.callId); return { content: 'local secret' }
    } },
    { ...f.definition, name: 'remote', destination: 'remote', execute: async (_, context) => {
      f.executed.push(context.callId); return { content: 'sent remotely' }
    } },
  ])
  const result = await f.run()
  assert.deepEqual(f.executed, ['private'])
  assert.equal(result.localOnly, true)
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'remote')?.status, 'denied')
  assert.equal(f.input.allowRemote, false)
})

test('route mutation during model stream is checked before any dispatch', async t => {
  let changed = false
  const f = fixture(t, [async function* () {
    yield { type: 'tool-call', call: call('a') }
    changed = true
    yield { type: 'finish', reason: 'tool-calls' }
  }])
  f.input.check = () => { if (changed) throw new Error('route changed') }
  await assert.rejects(f.run(), /route changed/)
  assert.deepEqual(f.executed, [])
})

test('route mutation after first result stops remaining batch and next model request', async t => {
  const f = fixture(t, [response(call('a'), call('b')), final])
  let changed = false
  f.setDefinitions([{ ...f.definition, execute: async (_, context) => {
    f.executed.push(context.callId); changed = true; return { content: 'completed before route changed' }
  } }])
  f.input.check = () => { if (changed) throw new Error('route changed') }
  await assert.rejects(f.run(), /route changed/)
  assert.deepEqual(f.executed, ['a'])
  assert.equal(f.requests.length, 1)
  assert.equal(f.journal.getCall(f.input.sessionId, f.input.turnId, 'a')?.status, 'succeeded')
})
