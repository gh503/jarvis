import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import { Conversation, type ConversationDeps, type TurnOptions } from '../src/conversation.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { HashEmbedder } from '../src/memory/embedding.ts';
import { ProfileStore } from '../src/profile.ts';
import { SessionStore } from '../src/sessions.ts';
import { ToolJournal } from '../src/tool-journal.ts';
import { ToolRuntime, type ToolDefinition } from '../src/tools.ts';
import { EventBus } from '../src/events.ts';
import { estimateTextTokens } from '../src/model/context-budget.ts';
import type { ChatMessage, ChatOptions, ModelClient, ModelStreamEvent } from '../src/model/types.ts';

const SUMMARY = '项目资料已核对，后续仍需检查缺失材料。';
type Request = { messages: ChatMessage[]; options: ChatOptions };
type Script = ModelStreamEvent[] | (() => AsyncGenerator<ModelStreamEvent>);
const calls = (...ids: string[]): ModelStreamEvent[] => [
  ...ids.map(id => ({ type: 'tool-call' as const, call: { id, name: 'inspect', arguments: '{}' } })),
  { type: 'finish', reason: 'tool-calls' },
];
const final = (text = 'Verified final answer'): ModelStreamEvent[] => [
  { type: 'text', text }, { type: 'finish', reason: 'stop' },
];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fakeModel(scripts: Script[], isLocal = true, supported = true) {
  const requests: Request[] = [], plain: Request[] = [], summaries: Request[] = [];
  const client: ModelClient = {
    model: isLocal ? 'local-test' : 'remote-test', visionModel: '', embedModel: '', isLocal,
    health: async () => ({ ok: true, models: [] }),
    contextLimits: async () => ({ contextWindow: 4096, maxOutputTokens: 512 }),
    supportsTools: async () => supported,
    async *toolStream(messages, options = {}) {
      requests.push({ messages: structuredClone(messages), options: { ...options } });
      const script = scripts[requests.length - 1];
      assert.ok(script, 'unexpected extra tool model request');
      if (typeof script === 'function') yield* script();
      else yield* script;
    },
    async *chatStream(messages, options = {}) {
      plain.push({ messages: structuredClone(messages), options: { ...options } });
      yield 'Plain text fallback';
    },
    async chatOnce(messages, options = {}) {
      if (messages[0]?.content.includes('你负责整理会话背景')) {
        assert.equal(isLocal, true, 'summaries stay local');
        summaries.push({ messages: structuredClone(messages), options: { ...options } });
        return SUMMARY;
      }
      return '{"memories":[]}';
    },
    vision: async () => { throw new Error('unexpected vision'); },
    embed: async () => null,
  };
  return { client, requests, plain, summaries };
}
function fixture(t: test.TestContext, scripts: Script[], options: {
  isLocal?: boolean; supported?: boolean; definition?: Partial<ToolDefinition>;
} = {}) {
  const memory = new MemoryStore({ file: ':memory:', embedder: new HashEmbedder() });
  const profile = new ProfileStore(memory);
  const sessions = new SessionStore({ file: ':memory:' });
  const journal = new ToolJournal(sessions), bus = new EventBus();
  const executed: string[] = [];
  const definition: ToolDefinition = {
    name: 'inspect', description: 'Inspect source material', parameters: { type: 'object', additionalProperties: false },
    definitionHash: 'inspect-v1', usage: 'shared', permission: 'allow', effect: 'read', destination: 'local',
    execute: async (_, context) => { executed.push(context.callId); return { content: `Result ${context.callId}` }; },
    ...options.definition,
  };
  const runtime = new ToolRuntime({ definitions: () => [definition], journal, bus });
  const model = fakeModel(scripts, options.isLocal ?? true, options.supported ?? true);
  const local = model.client.isLocal ? model : fakeModel([], true, false);
  model.client.localClient = () => local.client;
  model.client.servingRemote = () => model.client.isLocal !== true;
  const deps = {
    sessions, memory, profile, model: model.client, bus, tools: runtime, toolJournal: journal,
    config: { dataDir: '/tmp' },
    attention: { getState: () => 'idle', send() {}, reset() {} }, policy: { noteInteraction() {} },
    tuning: { number: (key: string) => ({
      'conversation.maxHistory': 20, 'conversation.maxContextMessages': 20,
      'conversation.contextChars': 4000, 'conversation.recallLimit': 5,
      'conversation.followupMs': 1000, 'conversation.streamTimeoutMs': 10000,
    }[key] ?? 10) },
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as ConversationDeps;
  let conversation = new Conversation(deps);
  const sessionId = sessions.create().id;
  t.after(async () => { await conversation.quiesce(); conversation.reset(); sessions.close(); memory.close(); });
  return {
    sessions, journal, bus, runtime, model, local, definition, executed, deps, sessionId,
    get conversation() { return conversation; },
    async turn(text: string, turnId: string, extra: TurnOptions = {}) {
      await conversation.refreshModel();
      return conversation.handleText(text, { sessionId, turnId, skipAttention: true, ...extra });
    },
    restart() { conversation.reset(); conversation = new Conversation(deps); },
    seed() {
      for (let i = 0; i < 10; i++) {
        sessions.beginTurn(sessionId, `seed-${i}`, `Question ${i}: ${'source material constraints; '.repeat(16)}`, 'text');
        sessions.finishTurn(`seed-${i}`, { status: 'complete', text: `Answer ${i}: ${'confirmed decisions pending checks; '.repeat(16)}` });
      }
    },
    done(turnId: string) {
      return bus.history(200).filter(event => event.type === 'assistant.done')
        .map(event => event.data as Record<string, unknown>).filter(data => data.turnId === turnId);
    },
  };
}

test('conversation integrates multi-step tools, final-only deltas and durable toolUsed metadata', async t => {
  const f = fixture(t, [[{ type: 'text', text: 'Private intermediate plan' }, ...calls('first')], calls('second'), final()]);
  const result = await f.turn('核对项目材料', 'multi');
  assert.equal(result.error, undefined);
  assert.equal(result.reply, 'Verified final answer');
  assert.deepEqual(result.toolUsed, ['first', 'second']);
  assert.deepEqual(f.executed, ['first', 'second']);
  assert.equal(f.model.requests.length, 3);
  assert.equal(f.model.plain.length, 0);
  const continuation = f.model.requests[2].messages.slice(-4);
  assert.deepEqual(continuation.map(m => m.role), ['assistant', 'tool', 'assistant', 'tool']);
  assert.deepEqual(continuation.filter(m => m.role === 'tool').map(m => [m.toolCallId, m.content]),
    [['first', 'Result first'], ['second', 'Result second']]);
  assert.deepEqual(f.bus.history(200).filter(e => e.type === 'assistant.delta').map(e => (e.data as { text: string }).text), ['Verified final answer']);
  assert.equal(f.done('multi').length, 1);
  assert.deepEqual(f.done('multi')[0].toolUsed, result.toolUsed);
  const saved = f.sessions.getTurn('multi')!.assistant;
  assert.equal(saved.status, 'complete');
  assert.equal(saved.content, result.reply);
  assert.deepEqual(saved.metadata?.toolUsed, result.toolUsed);
  assert.equal(saved.metadata?.contextExcluded, false);
  assert.deepEqual(f.journal.listCalls(f.sessionId, 'multi').map(c => [c.callId, c.status]),
    [['first', 'succeeded'], ['second', 'succeeded']]);
});

test('local tool results and their user/assistant turn never enter subsequent history or summaries', async t => {
  const secret = 'LOCAL_RESULT_SENTINEL';
  const f = fixture(t, [calls('private'), final(secret), final('Safe next answer')], {
    definition: { usage: 'local', execute: async () => ({ content: secret }) },
  });
  const result = await f.turn('PRIVATE_TURN_SENTINEL 核对材料', 'private');
  assert.equal(result.error, undefined);
  assert.equal(f.journal.getCall(f.sessionId, 'private', 'private')?.content, secret);
  assert.equal(f.sessions.getTurn('private')!.assistant.metadata?.contextExcluded, true);
  assert.ok(f.model.requests[1].messages.some(m => m.role === 'tool' && m.content === secret));
  f.seed();
  f.restart();
  assert.equal((await f.turn('核对剩余材料', 'next')).error, undefined);
  assert.ok(f.local.summaries.length > 0, 'exercise actual context compaction');
  for (const request of [...f.local.summaries, f.model.requests[2]]) {
    assert.doesNotMatch(JSON.stringify(request.messages), /LOCAL_RESULT_SENTINEL|PRIVATE_TURN_SENTINEL/);
  }
  assert.equal(f.sessions.getTurn('private')!.assistant.content, secret, 'raw transcript stays available');
});

test('remote model without native tool support uses text fallback without dispatch', async t => {
  const f = fixture(t, [], { isLocal: false, supported: false });
  const result = await f.turn('核对项目材料', 'fallback');
  assert.equal(result.error, undefined);
  assert.equal(result.reply, 'Plain text fallback');
  assert.deepEqual(result.toolUsed, []);
  assert.equal(f.model.plain.length, 1);
  assert.equal(f.model.requests.length, 0);
  assert.equal(f.local.plain.length, 0);
  assert.deepEqual(f.executed, []);
  assert.deepEqual(f.journal.listCalls(f.sessionId), []);
  assert.deepEqual(f.done('fallback')[0].toolUsed, []);
  assert.deepEqual(f.sessions.getTurn('fallback')!.assistant.metadata?.toolUsed, []);
});

for (const selectedLocal of [true, false]) {
  test(`scenario toolClient selects concrete ${selectedLocal ? 'local' : 'remote'} locality over router status`, async t => {
    const f = fixture(t, [], { isLocal: !selectedLocal, definition: { usage: 'local' } });
    const selected = fakeModel(selectedLocal ? [calls('selected'), final('Selected local answer')] : [], selectedLocal);
    const selections: ChatOptions[] = [];
    f.model.client.toolClient = async options => { selections.push({ ...options }); return selected.client; };
    f.deps.modelSettings = { load: async () => ({
      active: 'global-provider', profiles: [], priority: ['global-provider'], cooldowns: {},
      scenarioAuto: false, defaultScenario: 'chat', scenarios: [{
        id: 'review', label: 'Review', profileIds: ['scenario-provider'], model: 'scenario-model',
        temperature: 0.2, maxTokens: 512, systemExtra: 'Review source material.', patterns: [], enabled: true, custom: true,
      }],
    }) };
    const result = await f.turn('核对项目材料', 'scenario', { scenario: 'review' });
    assert.equal(result.error, undefined);
    assert.deepEqual(selections, [{ profileIds: ['scenario-provider'], model: 'scenario-model' }]);
    assert.equal(f.model.requests.length + f.model.plain.length, 0, 'router must not handle the selected request');
    if (selectedLocal) {
      assert.equal(result.reply, 'Selected local answer');
      assert.deepEqual(f.executed, ['selected']);
      const schemas = selected.requests[0].options.tools!;
      assert.deepEqual(schemas, [{ name: f.definition.name, description: f.definition.description, parameters: f.definition.parameters }]);
      assert.ok(estimateTextTokens(JSON.stringify(schemas)) + 32 <= Math.floor(4096 * .2),
        'the concrete client receives the arbitrary tool schema within the catalogue budget');
      assert.equal(f.sessions.getTurn('scenario')!.assistant.metadata?.contextExcluded, true);
    } else {
      assert.equal(result.reply, 'Plain text fallback');
      assert.equal(selected.requests.length, 0, 'remote client cannot receive local-only tools');
      assert.equal(selected.plain.length, 1);
      assert.deepEqual(f.executed, []);
      assert.deepEqual(f.journal.listCalls(f.sessionId), []);
    }
    const request = selected.requests[0] ?? selected.plain[0];
    assert.equal(request.options.model, 'scenario-model');
    assert.deepEqual(request.options.profileIds, ['scenario-provider']);
  });
}

test('cancelling an in-flight write records unknown and quiesce waits for its actual effect', { timeout: 15000 }, async t => {
  const started = deferred(), release = deferred();
  let effects = 0, executorSignal: AbortSignal | undefined;
  const f = fixture(t, [calls('write', 'must-not-run'), final()], {
    definition: { effect: 'write', execute: async (_, context) => {
      executorSignal = context.signal;
      started.resolve();
      await release.promise; // Deliberately ignores abort: dispatch may already have taken effect.
      effects++;
      return { content: 'Late success' };
    } },
  });
  const pending = f.turn('处理项目材料', 'cancel');
  let quiescing: Promise<void> | undefined;
  try {
    await started.promise;
    assert.equal(f.conversation.cancel({ sessionId: f.sessionId, turnId: 'cancel' }), true);
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(executorSignal?.aborted, true);
    assert.deepEqual(result.toolUsed, ['write', 'must-not-run']);
    const saved = f.sessions.getTurn('cancel')!.assistant;
    assert.equal(saved.status, 'cancelled');
    assert.deepEqual(saved.metadata?.toolUsed, ['write', 'must-not-run']);
    assert.equal(saved.metadata?.contextExcluded, true);
    assert.equal(f.journal.getCall(f.sessionId, 'cancel', 'write')?.status, 'unknown');
    const notStarted = f.journal.getCall(f.sessionId, 'cancel', 'must-not-run');
    assert.equal(notStarted?.status, 'cancelled');
    assert.equal(notStarted?.errorCode, 'TOOL_NOT_STARTED');
    assert.match(notStarted!.content, /No operation was dispatched/);
    assert.equal(f.model.requests.length, 1);
    assert.equal(f.done('cancel').length, 0);
    let drained = false;
    quiescing = f.conversation.quiesce().then(() => { drained = true; });
    await nextTick();
    assert.equal(drained, false, 'quiesce must retain the pending actual execution');
    assert.equal(effects, 0);
    assert.equal((await f.turn('后续材料', 'blocked')).busy, true);
    release.resolve();
    await quiescing;
    assert.equal(effects, 1);
    assert.equal(f.journal.getCall(f.sessionId, 'cancel', 'write')?.status, 'unknown', 'late success cannot rewrite an uncertain outcome');
  } finally {
    release.resolve();
    await pending;
    await quiescing;
  }
});

test('provider error after a successful tool preserves toolUsed in result, event and transcript', async t => {
  const f = fixture(t, [calls('completed'), async function* () { throw new Error('provider failed after tool success'); }]);
  const result = await f.turn('核对项目材料', 'error');
  assert.match(result.error!, /provider failed after tool success/);
  assert.deepEqual(result.toolUsed, ['completed']);
  assert.deepEqual(f.executed, ['completed']);
  assert.equal(f.journal.getCall(f.sessionId, 'error', 'completed')?.status, 'succeeded');
  const saved = f.sessions.getTurn('error')!.assistant;
  assert.equal(saved.status, 'error');
  assert.deepEqual(saved.metadata?.toolUsed, ['completed']);
  assert.equal(saved.metadata?.contextExcluded, true);
  assert.equal(f.done('error').length, 1);
  assert.deepEqual(f.done('error')[0].toolUsed, ['completed']);
  assert.equal(f.done('error')[0].error, result.error);
});
