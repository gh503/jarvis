import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { prepareContext, type ContextInput, type ContextPlan } from '../src/context.ts';
import { estimateMessagesTokens, estimateTextTokens } from '../src/model/context-budget.ts';
import type { ChatMessage, ChatOptions, ModelClient } from '../src/model/types.ts';
import { SessionStore, type SessionMessage } from '../src/sessions.ts';

const SUMMARY = '目标：整理项目资料。约束：资料留在本机，保留原文。已决定按主题整理；已完成目录核对，尚需确认缺失材料。';
const SCOPE = 'test:local';
type Call = { messages: ChatMessage[]; options: ChatOptions };
function model(local = true, capacity = 4096, respond?: (call: Call) => Promise<string>) {
  const calls: Call[] = [];
  const client: ModelClient = {
    model: 'test', visionModel: 'test', embedModel: 'test', isLocal: local,
    async contextLimits() { return { contextWindow: capacity, maxOutputTokens: 512 }; },
    async health() { return { ok: true, models: [] }; },
    async *chatStream() { throw new Error('prepareContext must not stream'); },
    async chatOnce(messages, options = {}) {
      const call = { messages: structuredClone(messages), options: { ...options } };
      calls.push(call);
      return respond ? respond(call) : SUMMARY;
    },
    async vision() { throw new Error('unexpected vision'); },
    async embed() { throw new Error('unexpected embedding'); },
  };
  return { client, calls };
}
function fixture(t: TestContext, count = 8, file = ':memory:') {
  const store = new SessionStore({ file });
  t.after(() => store.close());
  const sessionId = store.create('Context regression').id;
  for (let i = 0; i < count; i++) {
    const id = `turn-${i}`;
    store.beginTurn(sessionId, id, `Question ${i}: ${'project constraints and source material; '.repeat(18)}`, 'text');
    store.finishTurn(id, { status: 'complete', text: `Answer ${i}: ${'confirmed decisions and pending checks; '.repeat(18)}` });
  }
  return { store, sessionId };
}
function input(store?: SessionStore, sessionId = 'no-session'): ContextInput {
  return {
    client: model(false).client, summarizer: model().client, options: { maxTokens: 512 },
    sessions: store, sessionId, scope: SCOPE,
    system: { role: 'system', content: 'Follow the current user request. Keep source material local.' },
    user: { role: 'user', content: 'CURRENT: Which project materials still need checking?' },
    optional: [], fallback: [], maxRecentMessages: 20, check() {}, notice() {},
  };
}
function bounded(plan: ContextPlan, request: ContextInput) {
  assert.equal(plan.estimatedTokens, estimateMessagesTokens(plan.messages));
  assert.ok(plan.estimatedTokens + plan.maxTokens + Math.max(128, Math.ceil(plan.numCtx * .08)) <= plan.numCtx,
    'actual final messages plus output and safety reserve must fit');
  assert.deepEqual(plan.messages[0], request.system);
  assert.deepEqual(plan.messages.at(-1), request.user);
  assert.equal(plan.messages.filter(m => m.content === request.user.content).length, 1);
}
function completePairs(messages: ChatMessage[], raw: SessionMessage[]) {
  assert.ok(messages.length > 0, 'expected retained transcript pairs');
  assert.equal(messages.length % 2, 0);
  for (let i = 0; i < messages.length; i += 2) {
    const user = raw.find(m => m.role === 'user' && m.content === messages[i].content);
    const assistant = raw.find(m => m.role === 'assistant' && m.content === messages[i + 1].content);
    assert.ok(user && assistant, 'transcript messages must be unmodified source messages');
    assert.equal(messages[i].role, 'user');
    assert.equal(messages[i + 1].role, 'assistant');
    assert.equal(user.turnId, assistant.turnId);
    assert.equal(assistant.status, 'complete');
  }
}
function localBudget(calls: Call[], capacity: number) {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.options.numCtx, capacity);
    assert.equal(call.options.requireComplete, true);
    assert.equal(call.options.temperature, 0);
    assert.equal(call.messages.at(-1)?.role, 'user', 'summary request must prompt a new response, not end on historical assistant text');
    assert.match(call.messages.at(-1)!.content, /只输出精简摘要/);
    assert.ok(estimateMessagesTokens(call.messages) + call.options.maxTokens! + Math.max(128, Math.ceil(capacity * .1)) <= capacity,
      'actual summary request plus output and safety reserve must fit local capacity');
    assert.ok(estimateTextTokens(SUMMARY) <= call.options.maxTokens!);
  }
}

test('persistent summaries use only the local model, shrink history and survive reopening', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-context-'));
  const file = join(dir, 'sessions.db');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { store, sessionId } = fixture(t, 8, file);
  const raw = store.exportSession(sessionId).messages;
  const local = model(); const remote = model(false);
  const request = { ...input(store, sessionId), client: remote.client, summarizer: local.client };
  const plan = await prepareContext(request);
  bounded(plan, request); localBudget(local.calls, 4096);
  assert.equal(remote.calls.length, 0);
  assert.equal(plan.summarized, true);
  const summary = store.contextState(sessionId, SCOPE).summary!;
  assert.equal(summary.text, SUMMARY);
  const sources = raw.filter(m => summary.sourceIds.includes(m.id));
  completePairs(sources, raw);
  assert.ok(estimateMessagesTokens(plan.messages.filter(m => m.content.includes(SUMMARY))) < estimateMessagesTokens(sources));
  assert.deepEqual(store.exportSession(sessionId).messages, raw, 'compaction must never delete or rewrite raw history');
  completePairs(plan.messages.slice(1, -1).filter(m => m.role !== 'system'), raw);
  store.close();
  const reopened = new SessionStore({ file });
  try {
    assert.deepEqual(reopened.contextState(sessionId, SCOPE).summary, summary);
    const next = { ...request, sessions: reopened };
    const callsBefore = local.calls.length;
    const reused = await prepareContext(next);
    bounded(reused, next);
    assert.equal(local.calls.length, callsBefore, 'a fitting persistent summary must be reused');
    assert.ok(reused.messages.some(m => m.content.includes(SUMMARY)));
  } finally { reopened.close(); }
});

test('incremental chunks remain within a smaller local budget and accumulate exact complete-pair provenance', async t => {
  const { store, sessionId } = fixture(t, 18);
  const raw = store.exportSession(sessionId).messages;
  const local = model(true, 3072);
  const request = { ...input(store, sessionId), summarizer: local.client };
  const plan = await prepareContext(request);
  bounded(plan, request); localBudget(local.calls, 3072);
  assert.ok(local.calls.length > 1, 'fixture must require multiple summary chunks');
  const summarizedIds: number[] = [];
  for (const call of local.calls) {
    const sourceMessages = call.messages.filter(m => raw.some(r => r.content === m.content));
    completePairs(sourceMessages, raw);
    summarizedIds.push(...sourceMessages.map(m => raw.find(r => r.content === m.content)!.id));
    assert.ok(!call.messages.some(m => m.content === request.user.content));
  }
  assert.equal(new Set(summarizedIds).size, summarizedIds.length, 'no raw message is summarized twice');
  const summary = store.contextState(sessionId, SCOPE).summary!;
  assert.deepEqual(summary.sourceIds, summarizedIds);
  assert.equal(summary.throughMessageId, summarizedIds.at(-1));
  assert.deepEqual(store.exportSession(sessionId).messages, raw);
});

for (const failure of ['throws', 'empty', 'oversized'] as const) {
  test(`summary ${failure} falls back to bounded complete pairs without deleting history`, async t => {
    const { store, sessionId } = fixture(t);
    const raw = store.exportSession(sessionId).messages;
    const local = model(true, 4096, async () => {
      if (failure === 'throws') throw new Error('local unavailable');
      return failure === 'empty' ? '   ' : 'uncompressed '.repeat(1000);
    });
    const request = { ...input(store, sessionId), summarizer: local.client };
    const plan = await prepareContext(request);
    bounded(plan, request);
    assert.equal(local.calls.length, 1);
    assert.equal(plan.summarized, false); assert.equal(plan.trimmed, true);
    assert.equal(store.contextState(sessionId, SCOPE).summary, null);
    completePairs(plan.messages.slice(1, -1), raw);
    assert.deepEqual(plan.messages.at(-2)?.content, raw.at(-1)?.content);
    assert.deepEqual(store.exportSession(sessionId).messages, raw);
  });
}

for (const availability of ['missing', 'remote'] as const) {
  test(`${availability} local summarizer trims safely and never calls a remote summarizer`, async t => {
    const { store, sessionId } = fixture(t);
    const raw = store.exportSession(sessionId).messages;
    const remote = model(false);
    const request = { ...input(store, sessionId), summarizer: availability === 'remote' ? remote.client : undefined };
    const plan = await prepareContext(request);
    bounded(plan, request);
    assert.equal(remote.calls.length, 0);
    assert.equal(plan.trimmed, true); assert.equal(plan.summarized, false);
    completePairs(plan.messages.slice(1, -1), raw);
    assert.deepEqual(store.exportSession(sessionId).messages, raw);
  });
}

test('an oversized current message rejects before any model call and preserves raw history', async t => {
  const { store, sessionId } = fixture(t);
  const raw = store.exportSession(sessionId).messages;
  const local = model(); const remote = model(false);
  const request = { ...input(store, sessionId), summarizer: local.client, client: remote.client,
    user: { role: 'user' as const, content: '当前请求'.repeat(3000) } };
  await assert.rejects(prepareContext(request), /上下文|容量|输入/);
  assert.equal(local.calls.length, 0); assert.equal(remote.calls.length, 0);
  assert.deepEqual(store.exportSession(sessionId).messages, raw);
});

test('cancellation during local generation rejects the candidate and preserves raw history', async t => {
  const { store, sessionId } = fixture(t);
  const raw = store.exportSession(sessionId).messages;
  const controller = new AbortController();
  const local = model(true, 4096, async call => {
    assert.equal(call.options.signal, controller.signal);
    controller.abort(new Error('cancelled during summary'));
    return SUMMARY;
  });
  const request = { ...input(store, sessionId), summarizer: local.client,
    options: { maxTokens: 512, signal: controller.signal }, check() { controller.signal.throwIfAborted(); } };
  await assert.rejects(prepareContext(request), /cancelled during summary/);
  assert.equal(local.calls.length, 1);
  assert.equal(store.contextState(sessionId, SCOPE).summary, null);
  assert.deepEqual(store.exportSession(sessionId).messages, raw);
});

test('a revision invalidated during generation rejects the stale summary instead of falling back', async t => {
  const { store, sessionId } = fixture(t);
  const raw = store.exportSession(sessionId).messages;
  const revision = store.contextState(sessionId, SCOPE).revision;
  const local = model(true, 4096, async () => {
    store.invalidateSummaries(sessionId);
    return SUMMARY;
  });
  await assert.rejects(prepareContext({ ...input(store, sessionId), summarizer: local.client }), /变更|revision|stale|changed/i);
  assert.equal(local.calls.length, 1);
  assert.ok(store.contextState(sessionId, SCOPE).revision > revision);
  assert.equal(store.contextState(sessionId, SCOPE).summary, null);
  assert.deepEqual(store.exportSession(sessionId).messages, raw);
});

test('optional material cannot displace the current system and user messages', async () => {
  const request = { ...input(), optional: [
    { role: 'system' as const, content: 'Retrieved material '.repeat(10000) },
    { role: 'system' as const, content: 'A short relevant source.' },
  ], fallback: [
    { role: 'user' as const, content: 'Previous question' },
    { role: 'assistant' as const, content: 'Previous answer' },
  ] };
  const plan = await prepareContext(request);
  bounded(plan, request);
  assert.ok(!plan.messages.some(m => m.content === request.optional[0].content));
  assert.ok(plan.messages.some(m => m.content === request.optional[1].content));
  assert.deepEqual(plan.messages.slice(-3, -1), request.fallback);
});

test('a summary within its output cap is still rejected when it does not shrink its source', async t => {
  const { store, sessionId } = fixture(t, 0);
  for (let i = 0; i < 4; i++) {
    store.beginTurn(sessionId, `short-${i}`, `Q${i}`, 'text');
    store.finishTurn(`short-${i}`, { status: 'complete', text: `A${i}` });
  }
  const raw = store.exportSession(sessionId).messages;
  const local = model(true, 4096, async call => {
    const candidate = 'A verbose restatement without compression. '.repeat(15);
    assert.ok(estimateTextTokens(candidate) <= call.options.maxTokens!);
    return candidate;
  });
  const request = { ...input(store, sessionId), summarizer: local.client, maxRecentMessages: 2 };
  const plan = await prepareContext(request);
  bounded(plan, request);
  assert.equal(local.calls.length, 1);
  assert.equal(plan.summarized, false);
  assert.equal(store.contextState(sessionId, SCOPE).summary, null);
  assert.deepEqual(plan.messages.slice(1, -1), raw.slice(-2).map(({ role, content }) => ({ role, content })));
  assert.deepEqual(store.exportSession(sessionId).messages, raw);
});

test('history beyond the context-state page retains the newest complete pairs', async t => {
  const { store, sessionId } = fixture(t, 0);
  for (let i = 0; i < 5001; i++) {
    store.beginTurn(sessionId, `page-${i}`, `Question ${i}`, 'text');
    store.finishTurn(`page-${i}`, { status: 'complete', text: `Answer ${i}` });
  }
  assert.equal(store.contextState(sessionId, SCOPE).hasMore, true);
  const local = model();
  const request = { ...input(store, sessionId), summarizer: local.client, maxRecentMessages: 4 };
  const plan = await prepareContext(request);
  bounded(plan, request);
  assert.equal(plan.trimmed, true);
  assert.equal(local.calls.length, 0, 'incomplete source pages must not produce misleading summaries');
  assert.deepEqual(plan.messages.slice(1, -1), [
    { role: 'user', content: 'Question 4999' }, { role: 'assistant', content: 'Answer 4999' },
    { role: 'user', content: 'Question 5000' }, { role: 'assistant', content: 'Answer 5000' },
  ]);
  assert.equal(store.get(sessionId)?.messageCount, 10002);
});

test('cancelled, failed, unfinished and context-excluded turns never enter summaries or recent context', async t => {
  const { store, sessionId } = fixture(t);
  for (const status of ['cancelled', 'error', 'streaming', 'excluded'] as const) {
    store.beginTurn(sessionId, status, `INELIGIBLE-${status}`, 'text');
    if (status !== 'streaming') store.finishTurn(status, { status: status === 'excluded' ? 'complete' : status, text: `INELIGIBLE-ANSWER-${status}` });
    if (status === 'excluded') store.excludeTurnFromContext(status);
  }
  const local = model();
  const request = { ...input(store, sessionId), summarizer: local.client };
  const plan = await prepareContext(request);
  bounded(plan, request);
  for (const messages of [plan.messages, ...local.calls.map(c => c.messages)]) {
    assert.ok(messages.every(m => !m.content.includes('INELIGIBLE')));
  }
  assert.equal(store.exportSession(sessionId).messages.length, 24);
});
