import test from 'node:test'
import assert from 'node:assert/strict'
import { Conversation, type ConversationDeps } from '../src/conversation.ts'
import { SessionStore } from '../src/sessions.ts'
import { EventBus } from '../src/events.ts'
import { estimateMessagesTokens } from '../src/model/context-budget.ts'
import type { ChatMessage } from '../src/model/ollama.ts'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(stream: (messages: ChatMessage[]) => AsyncGenerator<string> = async function* () { yield 'answer' }) {
  const sessions = new SessionStore({ file: ':memory:' })
  const bus = new EventBus()
  const deps = {
    sessions, bus, config: { dataDir: '/tmp' },
    model: { model: 'test', health: async () => ({ ok: true, models: [] }), chatStream: stream, chatOnce: async () => '{"memories":[]}' },
    attention: { getState: () => 'idle', send() {}, reset() {}, snapshot: () => ({}) },
    memory: { list: () => [], recall: async () => ({ items: [] }), contextFor: () => '', addEpisode() {}, add: async () => ({}) },
    transcriber: { transcribe: async () => ({ text: 'voice question', language: 'zh', durationMs: 1 }) },
    synthesizer: { available: async () => false },
    policy: { noteInteraction() {}, isFocus: () => false, isQuiet: () => false },
    tuning: { number: (key: string) => ({ 'conversation.maxHistory': 20, 'conversation.maxContextMessages': 20,
      'conversation.contextChars': 80, 'conversation.followupMs': 1000 }[key] ?? 10) },
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as ConversationDeps
  return { conversation: new Conversation(deps), sessions, bus, deps }
}

test('selected session context is bounded, isolated, and terminal retries are idempotent', async () => {
  const seen: ChatMessage[][] = []
  const f = fixture(async function* (messages) { seen.push(messages); yield 'answer' })
  try {
    await f.conversation.refreshModel()
    const a = f.sessions.create('A').id, b = f.sessions.create('B').id
    await f.conversation.handleText('alpha secret', { sessionId: a, turnId: 'a1', skipAttention: true })
    await f.conversation.handleText('beta secret', { sessionId: b, turnId: 'b1', skipAttention: true })
    await f.conversation.handleText('next', { sessionId: a, turnId: 'a2', skipAttention: true })
    assert.deepEqual(seen[1].filter(x => x.role !== 'system').map(x => x.content), ['beta secret'])
    assert.deepEqual(seen[2].filter(x => x.role !== 'system').map(x => x.content), ['alpha secret', 'answer', 'next'])
    assert.equal((await f.conversation.handleText('next', { sessionId: a, turnId: 'a2' })).reply, 'answer')
    assert.equal(seen.length, 3)
    f.sessions.setArchived(b, true)
    await assert.rejects(f.conversation.handleText('blocked', { sessionId: b, turnId: 'archived' }), /取消归档/)
    assert.equal(f.sessions.getTurn('archived'), undefined)
    await assert.rejects(f.conversation.handleText('different', { sessionId: a, turnId: 'a2' }), /conflicts/)
    for (const event of f.bus.history(100).filter(e => /^(turn\.|assistant\.|user\.)/.test(e.type))) {
      assert.ok((event.data as {sessionId: string}).sessionId)
      assert.ok((event.data as {turnId: string}).turnId)
    }
    f.sessions.beginTurn(a, 'long', 'x'.repeat(100), 'text')
    f.sessions.finishTurn('long', { text: 'y'.repeat(100), status: 'complete' })
    await f.conversation.handleText('bounded', { sessionId: a, turnId: 'a3', skipAttention: true })
    assert.ok(estimateMessagesTokens(seen[3]) + 1024 + Math.ceil(4096 * .08) <= 4096)
    assert.equal(seen[3].at(-1)?.content, 'bounded')
  } finally { f.conversation.reset(); f.sessions.close() }
})

test('partial stream errors persist and are excluded from subsequent context', async () => {
  let calls = 0
  const seen: ChatMessage[][] = []
  const f = fixture(async function* (messages) {
    seen.push(messages)
    if (++calls === 1) { yield 'partial'; throw new Error('stream broke') }
    yield 'ok'
  })
  try {
    await f.conversation.refreshModel()
    const sessionId = f.sessions.create().id
    const result = await f.conversation.handleText('failed question', { sessionId, turnId: 'error', skipAttention: true })
    assert.equal(result.error, 'stream broke')
    assert.equal(f.sessions.getTurn('error')?.assistant.status, 'error')
    assert.equal(f.sessions.getTurn('error')?.assistant.content, 'partial')
    await f.conversation.handleText('retry', { sessionId, turnId: 'retry', skipAttention: true })
    assert.deepEqual(seen[1].filter(x => x.role !== 'system').map(x => x.content), ['retry'])
  } finally { f.conversation.reset(); f.sessions.close() }
})

test('ASR owns admission and cancellation reserves until the old work drains', async () => {
  const started = deferred(), asr = deferred<{text: string; language: string; durationMs: number}>()
  const f = fixture()
  f.deps.transcriber.transcribe = async () => { started.resolve(); return asr.promise }
  try {
    await f.conversation.refreshModel()
    const sessionId = f.sessions.create().id
    const pending = f.conversation.handleAudio(Buffer.alloc(1), 'audio/wav', { sessionId, turnId: 'voice' })
    await started.promise
    assert.deepEqual(f.conversation.status().activeTurn, { sessionId, turnId: 'voice' })
    assert.equal(f.conversation.cancel({ sessionId: 'other', turnId: 'voice' }), false)
    assert.equal((await f.conversation.handleText('overlap', { sessionId })).busy, true)
    assert.equal(f.bus.history().filter(e => e.type === 'assistant.done').length, 0)
    assert.equal(f.conversation.cancel({ sessionId, turnId: 'voice' }), true)
    assert.equal(f.conversation.status().busy, true)
    assert.equal((await f.conversation.handleText('still overlap', { sessionId })).busy, true)
    asr.resolve({ text: 'late transcript', language: 'zh', durationMs: 1 })
    assert.equal((await pending).cancelled, true)
    assert.equal(f.sessions.getTurn('voice')?.assistant.status, 'cancelled')
    assert.equal(f.bus.history().filter(e => e.type === 'voice.transcribed').length, 0)
    assert.equal((await f.conversation.handleText('new', { sessionId, turnId: 'new', skipAttention: true })).reply, 'answer')
    assert.equal(f.sessions.getTurn('new')?.assistant.status, 'complete')
  } finally { f.conversation.reset(); f.sessions.close() }
})

test('quiesce drains extraction and reset suppresses late writes and events', async () => {
  const started = deferred(), extraction = deferred<string>()
  let writes = 0
  const f = fixture()
  f.deps.model.chatOnce = async () => { started.resolve(); return extraction.promise }
  f.deps.memory.add = async () => { writes++; return {} as never }
  try {
    await f.conversation.refreshModel()
    const sessionId = f.sessions.create().id
    const turn = f.conversation.handleText('我以后喜欢每天喝一杯绿茶。', { sessionId, turnId: 'extract', skipAttention: true })
    await started.promise
    let drained = false
    const drain = f.conversation.quiesce().then(() => { drained = true })
    await Promise.resolve()
    assert.equal(drained, false)
    assert.equal((await f.conversation.handleText('blocked', { sessionId })).busy, true)
    f.conversation.reset()
    f.bus.clear()
    extraction.resolve('{"memories":[{"content":"我以后喜欢每天喝一杯绿茶。"}]}')
    await turn
    await drain
    assert.equal(writes, 0)
    assert.equal(f.bus.history().length, 0)
    assert.equal((await f.conversation.handleText('blocked', { sessionId })).busy, true)
    f.conversation.resumeAdmissions()
    assert.equal((await f.conversation.handleText('new', { sessionId, skipAttention: true })).reply, 'answer')
  } finally { f.conversation.reset(); f.sessions.close() }
})


test('cancelled model late completion cannot write output or clear the next owner', async () => {
  const firstStarted = deferred(), releaseFirst = deferred(), secondStarted = deferred(), releaseSecond = deferred()
  let calls = 0
  const f = fixture(async function* () {
    if (++calls === 1) { yield 'partial'; firstStarted.resolve(); await releaseFirst.promise; yield 'late' }
    else { secondStarted.resolve(); await releaseSecond.promise; yield 'fresh' }
  })
  try {
    await f.conversation.refreshModel()
    const sessionId = f.sessions.create().id
    const first = f.conversation.handleText('old question', { sessionId, turnId: 'old', skipAttention: true })
    await firstStarted.promise
    f.conversation.cancel({ sessionId, turnId: 'old' })
    assert.equal((await f.conversation.handleText('early', { sessionId })).busy, true)
    releaseFirst.resolve()
    assert.equal((await first).cancelled, true)
    assert.equal(f.sessions.getTurn('old')?.assistant.content, 'partial')
    assert.deepEqual(f.sessions.context(sessionId, 20), [])
    const second = f.conversation.handleText('new question', { sessionId, turnId: 'second', skipAttention: true })
    await secondStarted.promise
    assert.equal(f.conversation.cancel({ sessionId, turnId: 'old' }), false)
    assert.deepEqual(f.conversation.status().activeTurn, { sessionId, turnId: 'second' })
    assert.equal(f.conversation.status().busy, true)
    releaseSecond.resolve()
    assert.equal((await second).reply, 'fresh')
  } finally { f.conversation.reset(); f.sessions.close() }
})


test('quiesce waits for in-flight speech before allowing erase', async () => {
  const started = deferred(), speech = deferred()
  const f = fixture()
  f.deps.synthesizer.available = async () => true
  f.deps.synthesizer.synthesize = async () => { started.resolve(); await speech.promise }
  ;(f.conversation as unknown as { voiceReady: { asr: boolean; tts: boolean } }).voiceReady = { asr: false, tts: true }
  try {
    const sessionId = f.sessions.create().id
    const pending = f.conversation.handleText('/time', { sessionId, turnId: 'speech', voice: true, skipAttention: true })
    await started.promise
    let drained = false
    const drain = f.conversation.quiesce().then(() => { drained = true })
    await Promise.resolve()
    assert.equal(drained, false)
    assert.equal(f.conversation.status().busy, true)
    speech.resolve()
    assert.equal((await pending).cancelled, true)
    await drain
    assert.equal(drained, true)
    assert.equal(f.bus.history().filter(e => e.type === 'assistant.audio' || e.type === 'assistant.done').length, 0)
  } finally { f.conversation.reset(); f.sessions.close() }
})


test('standalone speech is drained and blocked during privacy quiescence', async () => {
  const started = deferred(), speech = deferred()
  let calls = 0
  const f = fixture()
  f.deps.synthesizer.available = async () => true
  f.deps.synthesizer.synthesize = async () => { calls++; started.resolve(); await speech.promise }
  ;(f.conversation as unknown as { voiceReady: { asr: boolean; tts: boolean } }).voiceReady = { asr: false, tts: true }
  try {
    const pending = f.conversation.speakText('standalone')
    await started.promise
    let drained = false
    const drain = f.conversation.quiesce().then(() => { drained = true })
    await Promise.resolve()
    assert.equal(drained, false)
    assert.equal(await f.conversation.speakText('blocked'), undefined)
    assert.equal(calls, 1)
    speech.resolve()
    assert.equal(await pending, undefined)
    await drain
    assert.equal(drained, true)
  } finally { f.conversation.reset(); f.sessions.close() }
})
