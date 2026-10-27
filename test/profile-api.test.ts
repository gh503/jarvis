import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { ActionManager } from '../src/actions.ts'
import { AttentionManager } from '../src/attention.ts'
import type { JarvisConfig } from '../src/config.ts'
import type { Conversation } from '../src/conversation.ts'
import { EventBus } from '../src/events.ts'
import type { Logger } from '../src/logger.ts'
import { NullEmbedder } from '../src/memory/embedding.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { ModelRouter, createModelClient } from '../src/model/router.ts'
import { ModelSettingsStore } from '../src/model/settings.ts'
import { ProfileStore } from '../src/profile.ts'
import { ProactivePolicy } from '../src/proactive/policy.ts'
import { ReminderStore } from '../src/proactive/reminders.ts'
import { SecureFiles } from '../src/secure-files.ts'
import { JarvisServer } from '../src/server.ts'
import { SessionStore } from '../src/sessions.ts'
import { TelemetryCollector } from '../src/telemetry.ts'
import { TuningStore } from '../src/tuning.ts'

type Snapshot = ReturnType<ProfileStore['snapshot']>
type Entry = ReturnType<ProfileStore['saveEntry']>
type Person = ReturnType<ProfileStore['savePerson']>

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-profile-api-'))
  const config: JarvisConfig = {
    version: '2.0.0', host: '127.0.0.1', port: 0, dataDir: dir,
    webDir: join(import.meta.dirname, '..', 'web'), authToken: 'profile-test-token-0123456789', tlsCert: '', tlsKey: '',
    // No model is needed; prevent accidental contact with a live provider.
    ollama: { url: 'http://127.0.0.1:1', model: 'test', visionModel: 'test', embedModel: 'test', keepAlive: '24h' },
    voice: { asrEngine: 'faster-whisper', whisperBin: '', whisperModel: '', fasterWhisperScript: '', fasterWhisperModel: 'tiny', ocrScript: '', pythonBin: 'python3', piperBin: '', piperVoice: '', ffmpeg: 'ffmpeg', arecord: 'arecord' },
    quiet: { start: '22:00', end: '08:00' }, dailySpeakBudget: 5, screenTimeoutMs: 15000, screenBlocklist: [],
  }
  const bus = new EventBus()
  const sessions = new SessionStore({ file: join(dir, 'sessions.db') })
  const memory = new MemoryStore({ file: join(dir, 'memory.db'), embedder: new NullEmbedder() })
  const profile = new ProfileStore(memory)
  const reminders = new ReminderStore(join(dir, 'memory.db'))
  const calls = { quiesce: 0, reset: 0, resumeAdmissions: 0, refreshModel: 0 }
  const conversation = {
    status: () => ({ modelReady: true, model: 'test', activeTurn: null, busy: false }),
    quiesce: async () => { calls.quiesce++ }, reset: () => { calls.reset++ },
    resumeAdmissions: () => { calls.resumeAdmissions++ },
    refreshModel: async () => { calls.refreshModel++ },
    cleanupAudio: async () => {}, cleanupCaptures: async () => {},
  } as unknown as Conversation
  const model = { id: 'local', label: 'Test', kind: 'ollama' as const, protocol: 'chat-completions' as const, baseUrl: config.ollama.url, model: 'test', apiKey: '', visionModel: 'test', embedModel: 'test', keepAlive: '24h' }
  const server = new JarvisServer({
    config, bus, sessions, memory, profile, reminders, conversation,
    attention: new AttentionManager(bus), models: new ModelRouter(createModelClient(model), model),
    modelSettings: new ModelSettingsStore(join(dir, 'model-config.json'), { local: { baseUrl: config.ollama.url, model: 'test', visionModel: 'test', embedModel: 'test', keepAlive: '24h' } }),
    tuning: new TuningStore(join(dir, 'tuning.json'), config), telemetry: new TelemetryCollector(bus),
    actions: new ActionManager({ auditFile: join(dir, 'audit', 'actions.jsonl'), runner: async () => {} }),
    policy: new ProactivePolicy(config), secure: new SecureFiles(dir),
    logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this } } as unknown as Logger,
  })
  t.after(async () => {
    await server.close()
    reminders.close()
    memory.close()
    sessions.close()
    assert.equal(dirname(dir), tmpdir())
    assert.ok(dir.startsWith(join(tmpdir(), 'jarvis-profile-api-')))
    await rm(dir, { recursive: true, force: true })
  })
  const { url } = await server.start()
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(`${url}${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  async function json<T>(path: string, method = 'GET', body?: unknown, expected = 200): Promise<T> {
    const response = await request(path, method, body)
    assert.equal(response.status, expected, `${method} ${path}: ${await response.clone().text()}`)
    return await response.json() as T
  }
  const save = async (body: Record<string, unknown>, expected = body.id ? 200 : 201) =>
    (await json<{ entry: Entry }>('/api/profile/entries', 'POST', body, expected)).entry
  const person = async (body: Record<string, unknown>, expected = body.id ? 200 : 201) =>
    (await json<{ person: Person }>('/api/profile/people', 'POST', body, expected)).person
  return { memory, profile, sessions, calls, config, request, json, save, person }
}


test('profile snapshot and manual entries share canonical MemoryStore records', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.json<Snapshot>('/api/profile'), f.profile.snapshot())
  const inputs = [
    { category: 'basic', field: 'gender', value: '其他' },
    { category: 'basic', field: 'birthday', value: { calendar: 'solar', month: 2, day: 29 } },
    { category: 'basic', field: 'age', value: { years: 30, asOf: '2025-01-01' } },
    { category: 'basic', field: 'city', value: '测试城市' },
    { category: 'career', field: 'industry', value: '软件' },
    { category: 'career', field: 'role', value: '工程师' },
    { category: 'interest', field: 'hobby', value: '徒步' },
    { category: 'preference', field: 'communication', value: '简短回答' },
    { category: 'preference', field: 'workstyle', value: '先规划' },
    { category: 'goal', field: 'goal', value: '学习绘画' },
    { category: 'understanding', field: 'understanding', value: '喜欢有依据的建议' },
    { category: 'understanding', field: 'notes', value: '测试备注' },
    { category: 'experience', field: 'experience', value: { organization: '示例组织', role: '工程师', industry: '软件', start: '2020-01', end: '2021-12', description: '合成经历' } },
  ]
  for (const input of inputs) {
    const entry = await f.save({ ...input, usage: 'display', status: 'confirmed', scope: 'global' })
    assert.deepEqual(entry.value, input.value)
    assert.equal(entry.subjectId, 'self')
    const memory = f.memory.get(entry.memoryId)
    assert.ok(memory)
    assert.equal(memory.content, entry.content)
    assert.equal(memory.status, 'confirmed')
    assert.equal(memory.sourceKind, 'user-confirmed')
    assert.equal(memory.sourceRef, 'profile:manual')
    assert.equal(entry.userLocked, true)
  }
  const snapshot = await f.json<Snapshot>('/api/profile')
  assert.equal(snapshot.entries.length, inputs.length)
  assert.equal(f.memory.exportAll().items.length, inputs.length)
  assert.deepEqual(snapshot, f.profile.snapshot())
})

test('entry edits enforce revisions and cannot forge provenance or canonical IDs', async t => {
  const f = await fixture(t)
  const entry = await f.save({ category: 'interest', field: 'hobby', value: '徒步' })
  const edited = await f.save({ ...entry, expectedRevision: entry.revision, value: '游泳',
    memoryId: 'forged-memory', sourceKind: 'inferred', sourceRef: 'turn:forged', userLocked: false,
    revision: 999, createdAt: '1900-01-01', updatedAt: '1900-01-01' })
  assert.equal(edited.id, entry.id)
  assert.equal(edited.memoryId, entry.memoryId)
  assert.equal(edited.createdAt, entry.createdAt)
  assert.equal(edited.revision, entry.revision + 1)
  assert.equal(edited.sourceKind, 'user-confirmed')
  assert.equal(edited.sourceRef, 'profile:manual')
  assert.equal(edited.userLocked, true)
  assert.equal(f.memory.get(entry.memoryId)?.content, edited.content)
  assert.equal(f.memory.get('forged-memory'), null)
  const before = f.profile.snapshot()
  await f.save({ ...entry, expectedRevision: entry.revision, value: 'stale' }, 409)
  await f.json(`/api/profile/entries/${entry.id}`, 'DELETE', { expectedRevision: entry.revision }, 409)
  assert.deepEqual(f.profile.snapshot(), before)
  await f.json(`/api/profile/entries/${entry.id}`, 'DELETE', { expectedRevision: edited.revision })
  assert.equal(f.memory.get(entry.memoryId), null)
  assert.equal(f.profile.snapshot().entries.length, 0)
})

test('invalid field values and enum inputs return 400 without partial writes', async t => {
  const f = await fixture(t)
  const invalid = [
    { category: 'basic', field: 'unknown', value: 'test' },
    { category: 'invalid', field: 'city', value: 'test' },
    { category: 'basic', field: 'city', value: '' },
    { category: 'basic', field: 'city', value: 42 },
    { category: 'basic', field: 'birthday', value: { calendar: 'solar', year: 2023, month: 2, day: 29 } },
    { category: 'basic', field: 'birthday', value: { calendar: 'lunar', month: 1, day: 31 } },
    { category: 'basic', field: 'birthday', value: { calendar: 'unknown', month: 1, day: 1 } },
    { category: 'basic', field: 'birthday', value: { calendar: 'solar', month: 1, day: 1, leap: true } },
    { category: 'basic', field: 'age', value: { years: -1, asOf: '2025-01-01' } },
    { category: 'basic', field: 'age', value: { years: 30, asOf: '2025-02-30' } },
    { category: 'basic', field: 'age', value: { years: 30 } },
    { category: 'experience', field: 'experience', value: { organization: 'Example', role: 'Engineer', start: '2022-12', end: '2021-01' } },
    { category: 'interest', field: 'hobby', value: 'test', status: 'accepted' },
    { category: 'interest', field: 'hobby', value: 'test', usage: 'remote' },
    { category: 'interest', field: 'hobby', value: 'test', scope: '../bad' },
  ]
  const before = f.profile.snapshot()
  for (const input of invalid) await f.save(input, 400)
  for (const input of [{ name: '', relationship: 'child' }, { name: 'Example', relationship: 42 }]) await f.person(input, 400)
  assert.deepEqual(f.profile.snapshot(), before)
  assert.equal(f.memory.exportAll().items.length, 0)
})

test('family edits reject stale revisions and deletion cascades only their memories', async t => {
  const f = await fixture(t)
  const person = await f.person({ name: '示例家人', relationship: '家人' })
  const entry = await f.save({ subjectId: person.id, category: 'basic', field: 'birthday', value: { calendar: 'lunar', month: 8, day: 15, leap: false } })
  const own = await f.save({ category: 'interest', field: 'hobby', value: '徒步' })
  const other = await f.person({ name: '另一位家人', relationship: '家人' })
  const updated = await f.person({ ...person, expectedRevision: person.revision, name: '修改后的家人' })
  assert.equal(updated.revision, person.revision + 1)
  await f.person({ ...person, expectedRevision: person.revision }, 409)
  await f.json(`/api/profile/people/${person.id}`, 'DELETE', { expectedRevision: person.revision }, 409)
  assert.ok(f.memory.get(entry.memoryId))
  await f.json(`/api/profile/people/${person.id}`, 'DELETE', { expectedRevision: updated.revision })
  const snapshot = await f.json<Snapshot>('/api/profile')
  assert.deepEqual(snapshot.people, [other])
  assert.deepEqual(snapshot.entries.map(e => e.id), [own.id])
  assert.equal(f.memory.get(entry.memoryId), null)
  assert.ok(f.memory.get(own.memoryId))
})

test('source returns only the linked user turn and becomes unavailable after transcript deletion', async t => {
  const f = await fixture(t)
  const session = f.sessions.create('Source fixture')
  f.sessions.beginTurn(session.id, 'source-turn', '我喜欢徒步', 'text')
  f.sessions.finishTurn('source-turn', { status: 'complete', text: 'assistant-private-marker' })
  f.sessions.beginTurn(session.id, 'unrelated-turn', 'unrelated-user-marker', 'text')
  const memory = await f.memory.add({ kind: 'semantic', content: '我喜欢徒步', sourceKind: 'user-stated', sourceRef: 'turn:source-turn', status: 'confirmed' })
  const entry = f.profile.observeMemory(memory)
  assert.ok(entry)
  const path = `/api/profile/entries/${entry.id}/source`
  assert.deepEqual(await f.json(path), { available: true, text: '我喜欢徒步', sessionId: session.id, turnId: 'source-turn' })
  await f.json(`/api/sessions/${session.id}`, 'DELETE')
  const missing = await f.json<{ available: boolean; text?: string; reason: string }>(path)
  assert.equal(missing.available, false)
  assert.equal(missing.text, undefined)
  assert.ok(missing.reason)
  assert.ok(f.memory.get(memory.id))
  assert.ok(f.profile.snapshot().entries.find(item => item.id === entry.id))
  const manual = await f.save({ category: 'understanding', field: 'notes', value: 'Manual note' })
  assert.equal((await f.json<{ available: boolean }>(`/api/profile/entries/${manual.id}/source`)).available, false)
  await f.json('/api/profile/entries/missing/source', 'GET', undefined, 404)
})

test('profile routes enforce authentication and CSRF before reads and writes', async t => {
  const f = await fixture(t)
  const entry = await f.save({ category: 'interest', field: 'hobby', value: '徒步' })
  const person = await f.person({ name: 'Example', relationship: 'family' })
  const remote = { 'x-forwarded-for': '203.0.113.9' }
  const auth = { ...remote, authorization: `Bearer ${f.config.authToken}` }
  const before = f.profile.snapshot()
  const operations: Array<[string, string, unknown?]> = [
    ['/api/profile', 'GET'],
    ['/api/profile/entries', 'POST', { category: 'interest', field: 'hobby', value: 'Blocked' }],
    [`/api/profile/entries/${entry.id}/source`, 'GET'],
    [`/api/profile/entries/${entry.id}`, 'DELETE', { expectedRevision: entry.revision }],
    ['/api/profile/people', 'POST', { name: 'Blocked', relationship: 'family' }],
    [`/api/profile/people/${person.id}`, 'DELETE', { expectedRevision: person.revision }],
    ['/api/profile/settings', 'PATCH', { learningEnabled: false, useEnabled: false }],
  ]
  for (const [path, method, body] of operations) {
    assert.equal((await f.request(path, method, body, remote)).status, 401, `${method} ${path}`)
    assert.equal((await f.request(path, method, body, { ...auth, origin: 'https://evil.example' })).status, 403, `${method} ${path}`)
  }
  assert.equal((await f.request('/api/profile', 'GET', undefined, auth)).status, 200)
  assert.equal((await f.request('/api/profile/settings', 'PATCH', { useEnabled: false }, { ...auth, 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.deepEqual(f.profile.snapshot(), before)
})

test('settings toggle independently and preserve entries while rejecting invalid values', async t => {
  const f = await fixture(t)
  const entry = await f.save({ category: 'interest', field: 'hobby', value: '徒步', usage: 'local' })
  const original = f.profile.snapshot().settings
  assert.deepEqual(await f.json('/api/profile/settings', 'PATCH', { learningEnabled: false }), { settings: { ...original, learningEnabled: false } })
  assert.deepEqual(await f.json('/api/profile/settings', 'PATCH', { useEnabled: false }), { settings: { learningEnabled: false, useEnabled: false } })
  assert.deepEqual(f.profile.context({ remote: false }), [])
  for (const input of [{ learningEnabled: 'false' }, { useEnabled: 0 }, { learningEnabled: null }]) await f.json('/api/profile/settings', 'PATCH', input, 400)
  assert.deepEqual(f.profile.snapshot().settings, { learningEnabled: false, useEnabled: false })
  assert.deepEqual(f.profile.snapshot().entries, [entry])
  await f.json('/api/profile/settings', 'PATCH', { learningEnabled: true, useEnabled: true })
  assert.deepEqual(f.profile.context({ remote: false }).map(e => e.id), [entry.id])
})

test('privacy export includes profile and confirmed erase clears profile, settings and transcripts', async t => {
  const f = await fixture(t)
  const defaults = f.profile.snapshot().settings
  const person = await f.person({ name: 'Export family', relationship: 'family' })
  const entry = await f.save({ subjectId: person.id, category: 'basic', field: 'city', value: 'Synthetic city' })
  await f.json('/api/profile/settings', 'PATCH', { learningEnabled: false, useEnabled: false })
  const session = f.sessions.create('Erase fixture')
  f.sessions.beginTurn(session.id, 'erase-turn', 'erase transcript', 'text')
  const exported = await f.json<ReturnType<MemoryStore['exportAll']>>('/api/privacy/export')
  assert.deepEqual(exported.profile, JSON.parse(JSON.stringify(f.memory.exportAll().profile)))
  assert.ok(JSON.stringify(exported.profile).includes(entry.id))
  assert.ok(JSON.stringify(exported.profile).includes(person.id))
  assert.ok(exported.items.some(item => item.id === entry.memoryId))
  await f.json('/api/privacy/erase', 'POST', { confirm: 'wrong' }, 400)
  assert.ok(f.memory.get(entry.memoryId))
  assert.equal(f.calls.quiesce, 0)
  const result = await f.json<{ ok: boolean; conversationsErased: boolean }>('/api/privacy/erase', 'POST', { confirm: 'ERASE ALL' })
  assert.equal(result.ok, true)
  assert.equal(result.conversationsErased, true)
  assert.deepEqual(f.calls, { quiesce: 1, reset: 1, resumeAdmissions: 1, refreshModel: 1 })
  const snapshot = await f.json<Snapshot>('/api/profile')
  assert.deepEqual(snapshot.entries, [])
  assert.deepEqual(snapshot.people, [])
  assert.deepEqual(snapshot.changes, [])
  assert.deepEqual(snapshot.settings, defaults)
  assert.equal(f.memory.get(entry.memoryId), null)
  assert.equal(f.sessions.getTurn('erase-turn'), undefined)
  assert.equal(f.memory.exportAll().items.length, 0)
  for (const rows of Object.values(f.memory.exportAll().profile)) assert.deepEqual(rows, [])
})
