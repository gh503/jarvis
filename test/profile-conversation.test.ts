import test from 'node:test'
import assert from 'node:assert/strict'
import { Conversation, type ConversationDeps } from '../src/conversation.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { MemoryExtractor } from '../src/memory/extract.ts'
import { HashEmbedder } from '../src/memory/embedding.ts'
import { ProfileStore } from '../src/profile.ts'
import { SessionStore } from '../src/sessions.ts'
import { EventBus } from '../src/events.ts'
import type { ChatMessage, ModelClient } from '../src/model/types.ts'

function fixture(persisted = true) {
  const memory = new MemoryStore({ file: ':memory:', embedder: new HashEmbedder() })
  const profile = new ProfileStore(memory)
  const sessions = new SessionStore({ file: ':memory:' })
  const localMessages: ChatMessage[][] = [], routedMessages: ChatMessage[][] = [], extracted: ChatMessage[][] = []
  let remote = false, failLocal = false
  const local = { isLocal: true, async *chatStream(messages: ChatMessage[]) {
    localMessages.push(messages); if (failLocal) throw new Error('local unavailable'); yield 'private profile answer'
  }, async chatOnce(messages: ChatMessage[]) { extracted.push(messages); return '{"memories":[{"content":"我喜欢每天早上喝绿茶。"}]}' } } as ModelClient
  const model = { model: 'test', health: async () => ({ ok: true, models: [] }),
    servingRemote: () => remote, localClient: () => local,
    async *chatStream(messages: ChatMessage[]) { routedMessages.push(messages); yield 'ordinary answer' },
    async chatOnce(messages: ChatMessage[]) { extracted.push(messages); return '{"memories":[{"content":"我喜欢每天早上喝绿茶。"}]}' },
  } as unknown as ModelClient
  const bus = new EventBus()
  const deps = { sessions: persisted ? sessions : undefined, memory, profile, model, bus, config: { dataDir: '/tmp' },
    attention: { getState: () => 'idle', send() {}, reset() {} },
    policy: { noteInteraction() {} },
    tuning: { number: (key: string) => ({ 'conversation.maxHistory': 20, 'conversation.maxContextMessages': 20,
      'conversation.contextChars': 4000, 'conversation.recallLimit': 5, 'conversation.followupMs': 1000 }[key] ?? 10) },
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as ConversationDeps
  const conversation = new Conversation(deps)
  const sessionId = sessions.create().id
  return { memory, profile, sessions, localMessages, routedMessages, extracted, deps, bus, conversation,
    setRemote(value: boolean) { remote = value }, failLocal() { failLocal = true },
    async turn(text = '请给建议', turnId?: string) { await conversation.refreshModel(); return conversation.handleText(text, { sessionId, turnId, skipAttention: true }) },
    close() { conversation.reset(); sessions.close(); memory.close() },
  }
}

for (const persisted of [true, false]) test(`local profile cannot fail over or leak through ${persisted ? 'stored' : 'fallback'} history`, async () => {
  const f = fixture(persisted)
  try {
    const entry = f.profile.saveEntry({ category: 'basic', field: 'city', value: '秘密城市', usage: 'local' })
    const first = await f.turn('介绍居住环境', 'local-turn')
    assert.deepEqual(first.profileUsed, [entry.id])
    assert.equal(f.routedMessages.length, 0)
    assert.match(JSON.stringify(f.localMessages[0]), /秘密城市/)
    if (persisted) {
      assert.equal(f.sessions.getTurn('local-turn')?.assistant.metadata?.contextExcluded, true)
      assert.deepEqual(f.sessions.getTurn('local-turn')?.assistant.metadata?.profileUsed, [entry.id])
    }
    const done = f.bus.history().find(event => event.type === 'assistant.done')!
    assert.deepEqual((done.data as {profileUsed: string[]}).profileUsed, [entry.id])
    f.setRemote(true)
    const next = await f.turn('继续聊聊')
    assert.deepEqual(next.profileUsed, [])
    assert.doesNotMatch(JSON.stringify(f.routedMessages[0]), /秘密城市|private profile answer|介绍居住环境/)
    f.setRemote(false); f.failLocal()
    assert.match((await f.turn('介绍居住环境')).error!, /local unavailable/)
    assert.equal(f.routedMessages.length, 1)
  } finally { f.close() }
})

test('family birthday context identifies its subject and is excluded remotely', async () => {
  const f = fixture()
  try {
    const person = f.profile.savePerson({ name: '家人测试代号', relationship: '妈妈' })
    const birthday = { calendar: 'solar', month: 5, day: 12 }
    const entry = f.profile.saveEntry({ subjectId: person.id, category: 'basic', field: 'birthday', value: birthday, usage: 'relevant' })
    const result = await f.turn('妈妈的生日是什么时候？')
    assert.deepEqual(result.profileUsed, [entry.id])
    assert.equal(f.routedMessages.length, 0)
    const block = f.localMessages[0].find(message => message.role === 'system' && message.content.includes('以下是用户确认的个人档案'))!
    const payload = JSON.parse(block.content.split('\n').at(-1)!)
    assert.deepEqual(payload, [{ subject: { name: person.name, relationship: '妈妈' }, field: 'birthday', value: birthday }])
    f.setRemote(true)
    const remote = await f.turn('妈妈的生日是什么时候？')
    assert.deepEqual(remote.profileUsed, [])
    const remoteContext = f.routedMessages[0].filter(message => message.role !== 'user')
    assert.doesNotMatch(JSON.stringify(remoteContext), /家人测试代号|birthday|private profile answer/)
    assert.equal(f.routedMessages[0].at(-1)?.content, '妈妈的生日是什么时候？')
  } finally { f.close() }
})

test('sensitive relevant fields are also pinned locally; unknown locality omits them', async () => {
  const f = fixture()
  try {
    f.profile.saveEntry({ category: 'basic', field: 'city', value: '城市隐私', usage: 'relevant' })
    await f.turn('我的城市')
    assert.equal(f.localMessages.length, 1)
    assert.equal(f.routedMessages.length, 0)
    f.deps.model.localClient = undefined
    await f.turn('我的城市')
    assert.doesNotMatch(JSON.stringify(f.routedMessages), /城市隐私/)
  } finally { f.close() }
})

test('remote-safe preferences preserve routing, current instructions and corrected values', async () => {
  const f = fixture()
  try {
    let entry = f.profile.saveEntry({ category: 'preference', field: 'communication', value: '总是简短回答', usage: 'relevant' })
    await f.turn('这次请详细解释，不要简短')
    assert.equal(f.localMessages.length, 0)
    assert.match(JSON.stringify(f.routedMessages[0]), /当前用户的明确要求始终优先/)
    assert.equal(f.routedMessages[0].at(-1)?.content, '这次请详细解释，不要简短')
    entry = f.profile.saveEntry({ ...entry, expectedRevision: entry.revision, value: '给出具体例子' })
    await f.turn('解释一个概念')
    assert.doesNotMatch(JSON.stringify(f.routedMessages[1]), /总是简短回答|ordinary answer/)
    assert.match(JSON.stringify(f.routedMessages[1]), /给出具体例子/)
    f.profile.updateSettings({ useEnabled: false })
    assert.deepEqual((await f.turn()).profileUsed, [])
    assert.doesNotMatch(JSON.stringify(f.routedMessages[2]), /给出具体例子/)
    const count = f.routedMessages.length
    assert.equal((await f.turn('/time')).profileUsed, undefined)
    assert.equal(f.routedMessages.length, count)
  } finally { f.close() }
})

test('extraction attaches the same proposal row, ignores assistant text and honors paused learning', async () => {
  const f = fixture()
  try {
    const extractor = new MemoryExtractor(f.deps.model, f.memory, f.deps.logger, f.profile)
    assert.equal(await extractor.maybeExtract('我喜欢每天早上喝绿茶。', 'assistant private secret', 'turn:source'), 1)
    assert.doesNotMatch(JSON.stringify(f.extracted), /assistant private secret/)
    const entries = f.profile.snapshot().entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].status, 'proposed')
    assert.equal(entries[0].sourceRef, 'turn:source')
    assert.equal(f.memory.list({ includeSensitive: true, includeInactive: true }).length, 1)
    assert.ok(f.memory.get(entries[0].memoryId))
    f.profile.updateSettings({ learningEnabled: false })
    assert.equal(await extractor.maybeExtract('我喜欢每天早上喝咖啡。', '', 'turn:paused'), 0)
    assert.equal(f.extracted.length, 1)
  } finally { f.close() }
})

for (const persisted of [true, false]) test(`newly extracted profile sources are excluded from ${persisted ? 'stored' : 'fallback'} history`, async () => {
  const f = fixture(persisted)
  try {
    await f.turn('我喜欢每天早上喝绿茶。', 'learn-source')
    const entry = f.profile.snapshot().entries[0]
    assert.ok(entry)
    if (persisted) assert.equal(f.sessions.getTurn('learn-source')?.assistant.metadata?.contextExcluded, true)
    f.profile.saveEntry({ ...entry, expectedRevision: entry.revision, value: '红茶', status: 'confirmed', usage: 'relevant' })
    await f.turn('推荐饮料')
    assert.doesNotMatch(JSON.stringify(f.routedMessages.at(-1)), /我喜欢每天早上喝绿茶|ordinary answer/)
  } finally { f.close() }
})

test('learning off/on invalidates an in-flight extraction and profile learning never calls remote inference', async () => {
  const f = fixture()
  try {
    let release!: (value: string) => void
    f.deps.model.localClient!().chatOnce = async () => new Promise<string>(resolve => { release = resolve })
    const extractor = new MemoryExtractor(f.deps.model, f.memory, f.deps.logger, f.profile)
    const pending = extractor.maybeExtract('我喜欢每天早上喝绿茶。', '', 'turn:stale')
    f.profile.updateSettings({ learningEnabled: false })
    f.profile.updateSettings({ learningEnabled: true })
    release('{"memories":[{"content":"我喜欢每天早上喝绿茶。"}]}')
    assert.equal(await pending, 0)
    assert.equal(f.profile.snapshot().entries.length, 0)
    assert.equal(f.memory.list({ includeSensitive: true, includeInactive: true }).length, 0)
    f.deps.model.localClient = undefined
    f.deps.model.chatOnce = async () => { assert.fail('remote extraction must not run') }
    assert.equal(await extractor.maybeExtract('我喜欢每天早上喝绿茶。', '', 'turn:remote'), 0)
  } finally { f.close() }
})

test('profile candidates are sensitive before memory writes can embed them', async () => {
  const f = fixture()
  try {
    const add = f.memory.add.bind(f.memory)
    f.memory.add = async input => { assert.equal(input.sensitivity, 'sensitive'); return add(input) }
    await f.turn('我喜欢每天早上喝绿茶。')
    await f.turn('记住我喜欢喝红茶。')
  } finally { f.close() }
})

test('explicit remembering attaches self assertions but never arbitrary third-party statements', async () => {
  const f = fixture()
  try {
    const result = await f.turn('记住我喜欢每天早上喝绿茶。', 'remember-self')
    const entry = f.profile.snapshot().entries[0]
    assert.equal(entry.memoryId, result.memoryIds?.[0])
    assert.equal(entry.sourceRef, 'turn:remember-self')
    await f.turn('记住他喜欢每天晚上喝咖啡。')
    assert.equal(f.profile.snapshot().entries.length, 1)
    const locked = f.profile.saveEntry({ ...entry, expectedRevision: entry.revision, value: '红茶', status: 'confirmed' })
    await f.turn('我喜欢每天早上喝绿茶。')
    assert.equal(f.profile.snapshot().entries.find(e => e.id === locked.id)?.value, '红茶')
    assert.equal(f.profile.snapshot().entries.length, 1)
  } finally { f.close() }
})
