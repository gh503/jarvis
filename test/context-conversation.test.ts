import test from 'node:test';
import assert from 'node:assert/strict';
import { Conversation, type ConversationDeps } from '../src/conversation.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { HashEmbedder } from '../src/memory/embedding.ts';
import { ProfileStore } from '../src/profile.ts';
import { SessionStore } from '../src/sessions.ts';
import { EventBus } from '../src/events.ts';
import { estimateMessagesTokens } from '../src/model/context-budget.ts';
import type { ChatMessage, ChatOptions, ModelClient } from '../src/model/types.ts';

const SUMMARY = '项目目标：核对资料。已决定保留原文并按主题整理；完成目录检查，缺失材料仍待确认。';
const overflow = () => Object.assign(new Error('maximum context length exceeded'), { code: 'context_length_exceeded' });
type Request = { messages: ChatMessage[]; options: ChatOptions };
function fixture(stream: (attempt: number) => AsyncGenerator<string> = async function* () { yield 'ordinary answer'; }) {
  const memory = new MemoryStore({ file: ':memory:', embedder: new HashEmbedder() });
  const profile = new ProfileStore(memory);
  const sessions = new SessionStore({ file: ':memory:' });
  const requests: Request[] = [], summaries: Request[] = [], extractions: ChatMessage[][] = [];
  const local = {
    model: 'local', isLocal: true,
    async contextLimits() { return { contextWindow: 4096, maxOutputTokens: 512 }; },
    async *chatStream() { yield 'private answer'; },
    async chatOnce(messages: ChatMessage[], options: ChatOptions = {}) {
      if (messages[0]?.content.includes('你负责整理会话背景')) {
        assert.equal(messages.at(-1)?.role, 'user', 'local summary must end with a generation directive');
        assert.match(messages.at(-1)!.content, /只输出精简摘要/);
        summaries.push({ messages: structuredClone(messages), options: { ...options } });
        return SUMMARY;
      }
      extractions.push(structuredClone(messages));
      return '{"memories":[{"content":"我喜欢每天早上喝绿茶。"}]}';
    },
  } as unknown as ModelClient;
  const model = {
    model: 'test', isLocal: false, servingRemote: () => false, localClient: () => local,
    async contextLimits() { return { contextWindow: 4096, maxOutputTokens: 512 }; },
    async health() { return { ok: true, models: [] }; },
    async *chatStream(messages: ChatMessage[], options: ChatOptions = {}) {
      requests.push({ messages: structuredClone(messages), options: { ...options } });
      yield* stream(requests.length);
    },
    async chatOnce() { assert.fail('summary and extraction must remain local'); },
  } as unknown as ModelClient;
  const bus = new EventBus();
  const deps = { sessions, memory, profile, model, bus, config: { dataDir: '/tmp' },
    attention: { getState: () => 'idle', send() {}, reset() {} }, policy: { noteInteraction() {} },
    tuning: { number: (key: string) => ({ 'conversation.maxHistory': 20, 'conversation.maxContextMessages': 20,
      'conversation.contextChars': 4000, 'conversation.recallLimit': 5, 'conversation.followupMs': 1000,
      'conversation.streamTimeoutMs': 10000 }[key] ?? 10) },
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as ConversationDeps;
  let conversation = new Conversation(deps);
  const sessionId = sessions.create().id;
  return { sessions, profile, requests, summaries, extractions, bus, sessionId,
    seed(count = 4) {
      for (let i = 0; i < count; i++) {
        sessions.beginTurn(sessionId, `seed-${i}`, `Question ${i}: ${'source material constraints; '.repeat(16)}`, 'text');
        sessions.finishTurn(`seed-${i}`, { status: 'complete', text: `Answer ${i}: ${'confirmed decisions pending checks; '.repeat(16)}` });
      }
    },
    async turn(text: string, turnId: string) {
      await conversation.refreshModel();
      return conversation.handleText(text, { sessionId, turnId, skipAttention: true });
    },
    restart() { conversation.reset(); conversation = new Conversation(deps); },
    close() { conversation.reset(); sessions.close(); memory.close(); },
  };
}
function bounded(requests: Request[], reserve = .08) {
  assert.ok(requests.length > 0);
  for (const { messages, options } of requests) {
    assert.equal(options.numCtx, 4096);
    assert.ok(estimateMessagesTokens(messages) + options.maxTokens! + Math.max(128, Math.ceil(4096 * reserve)) <= 4096,
      'actual provider payload plus output and safety reserve fits capacity');
  }
}

test('provider overflow before a delta retries once with smaller bounded context and the same current user', async () => {
  const f = fixture(async function* (attempt) { if (attempt === 1) throw overflow(); yield 'recovered answer'; });
  try {
    f.seed();
    const raw = f.sessions.exportSession(f.sessionId).messages;
    const result = await f.turn('CURRENT: 检查项目资料', 'retry-once');
    assert.equal(result.error, undefined);
    assert.equal(result.reply, 'recovered answer');
    assert.equal(f.requests.length, 2);
    bounded(f.requests); bounded(f.summaries, .1);
    assert.ok(estimateMessagesTokens(f.requests[1].messages) < estimateMessagesTokens(f.requests[0].messages));
    for (const request of f.requests) {
      assert.deepEqual(request.messages.at(-1), { role: 'user', content: 'CURRENT: 检查项目资料' });
      assert.equal(request.messages.filter(m => m.content === 'CURRENT: 检查项目资料').length, 1);
    }
    assert.deepEqual(f.sessions.exportSession(f.sessionId).messages.slice(0, raw.length), raw);
    assert.equal(f.sessions.getTurn('retry-once')?.assistant.status, 'complete');
    assert.equal(f.bus.history().filter(e => e.type === 'assistant.delta').length, 1);
  } finally { f.close(); }
});

test('provider overflow after a delta never retries and persists the partial error', async () => {
  const f = fixture(async function* () { yield 'partial answer'; throw overflow(); });
  try {
    f.seed();
    const result = await f.turn('检查项目资料', 'partial');
    assert.match(result.error!, /context length/);
    assert.equal(result.reply, 'partial answer');
    assert.equal(f.requests.length, 1);
    bounded(f.requests);
    const saved = f.sessions.getTurn('partial')!.assistant;
    assert.equal(saved.status, 'error'); assert.equal(saved.content, 'partial answer');
    assert.equal(f.bus.history().filter(e => e.type === 'assistant.delta').length, 1);
  } finally { f.close(); }
});

test('repeated provider overflow stops after the single retry', async () => {
  const f = fixture(async function* () { throw overflow(); });
  try {
    f.seed();
    const result = await f.turn('检查项目资料', 'repeat-overflow');
    assert.match(result.error!, /context length/);
    assert.equal(f.requests.length, 2);
    bounded(f.requests);
    assert.ok(estimateMessagesTokens(f.requests[1].messages) < estimateMessagesTokens(f.requests[0].messages));
    assert.equal(f.sessions.getTurn('repeat-overflow')?.assistant.status, 'error');
    assert.equal(f.bus.history().filter(e => e.type === 'assistant.delta').length, 0);
  } finally { f.close(); }
});

test('a fresh Conversation uses the persisted summary on the next turn without re-summarizing', async () => {
  const f = fixture();
  try {
    f.seed(10);
    assert.equal((await f.turn('检查项目资料', 'first')).error, undefined);
    assert.ok(f.summaries.length > 0);
    bounded(f.summaries, .1);
    const count = f.summaries.length;
    f.restart();
    assert.equal((await f.turn('还有什么需要确认？', 'next')).error, undefined);
    assert.equal(f.summaries.length, count);
    assert.ok(f.requests.at(-1)!.messages.some(m => m.role === 'system' && m.content.includes(SUMMARY)));
    assert.equal(f.requests.at(-1)!.messages.at(-1)?.content, '还有什么需要确认？');
    bounded(f.requests);
  } finally { f.close(); }
});

test('a learned profile source is excluded from subsequent local summaries and provider history', async () => {
  const f = fixture();
  try {
    const source = '我喜欢每天早上喝绿茶。';
    assert.equal((await f.turn(source, 'profile-source')).error, undefined);
    assert.ok(f.extractions.length > 0, 'exercise real extraction and source exclusion');
    assert.equal(f.sessions.getTurn('profile-source')?.assistant.metadata?.contextExcluded, true);
    assert.ok(f.profile.snapshot().entries.length > 0);
    f.seed(10);
    const rawCount = f.sessions.get(f.sessionId)!.messageCount;
    assert.equal((await f.turn('核对项目缺失材料', 'after-profile')).error, undefined);
    assert.ok(f.summaries.length > 0);
    for (const request of [...f.summaries, f.requests.at(-1)!]) {
      assert.doesNotMatch(JSON.stringify(request.messages), /我喜欢每天早上喝绿茶/);
    }
    assert.equal(f.sessions.getTurn('profile-source')?.user.content, source);
    assert.equal(f.sessions.get(f.sessionId)!.messageCount, rawCount + 2);
    bounded(f.requests); bounded(f.summaries, .1);
  } finally { f.close(); }
});
