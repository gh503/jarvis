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
import { ProactivePolicy } from '../src/proactive/policy.ts'
import { ReminderStore } from '../src/proactive/reminders.ts'
import { SecureFiles } from '../src/secure-files.ts'
import { JarvisServer } from '../src/server.ts'
import { SessionStore, type Session, type SessionMessage } from '../src/sessions.ts'
import { TelemetryCollector } from '../src/telemetry.ts'
import { TuningStore } from '../src/tuning.ts'

type Identity = { sessionId?: string; turnId?: string }
type Detail = { session: Session; messages: { items: SessionMessage[]; hasMore: boolean }; activeTurn: Identity | null }

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-session-api-'))
  const config: JarvisConfig = {
    version: '2.0.0', host: '127.0.0.1', port: 0, dataDir: dir,
    webDir: join(import.meta.dirname, '..', 'web'), authToken: 'session-test-token-0123456789', tlsCert: '', tlsKey: '',
    // No route under test invokes a model. Port 1 also prevents accidental use of a live local provider.
    ollama: { url: 'http://127.0.0.1:1', model: 'test', visionModel: 'test', embedModel: 'test', keepAlive: '24h' },
    voice: { asrEngine: 'faster-whisper', whisperBin: '', whisperModel: '', fasterWhisperScript: '', fasterWhisperModel: 'tiny', ocrScript: '', pythonBin: 'python3', piperBin: '', piperVoice: '', ffmpeg: 'ffmpeg', arecord: 'arecord' },
    quiet: { start: '22:00', end: '08:00' }, dailySpeakBudget: 5, screenTimeoutMs: 15000, screenBlocklist: [],
  }
  const bus = new EventBus()
  const sessions = new SessionStore({ file: join(dir, 'sessions.db') })
  const memory = new MemoryStore({ file: join(dir, 'memory.db'), embedder: new NullEmbedder() })
  const reminders = new ReminderStore(join(dir, 'memory.db'))
  const state = { activeTurn: null as { sessionId: string; turnId: string } | null, busy: false }
  const calls = { text: [] as Array<{ text: string; options: Identity & { source?: string; scenario?: string } }>, cancel: [] as Identity[], quiesce: 0, reset: 0, resumeAdmissions: 0 }
  const conversation = {
    status: () => ({ modelReady: true, model: 'test', ...state }),
    handleText: async (text: string, options: Identity & { source?: string; scenario?: string }) => {
      calls.text.push({ text, options })
      return state.busy ? { reply: 'busy', busy: true } : { reply: `echo:${text}`, ...options }
    },
    cancel: (identity: Identity = {}) => {
      calls.cancel.push(identity)
      if (!state.activeTurn || (identity.sessionId && identity.sessionId !== state.activeTurn.sessionId) || (identity.turnId && identity.turnId !== state.activeTurn.turnId)) return false
      state.activeTurn = null
      state.busy = false
      return true
    },
    quiesce: async () => { calls.quiesce++; state.activeTurn = null; state.busy = false },
    reset: () => { calls.reset++ },
    resumeAdmissions: () => { calls.resumeAdmissions++ },
    cleanupAudio: async () => {}, cleanupCaptures: async () => {},
  } as unknown as Conversation
  const profile = { id: 'local', label: 'Test', kind: 'ollama' as const, protocol: 'chat-completions' as const, baseUrl: config.ollama.url, model: 'test', apiKey: '', visionModel: 'test', embedModel: 'test', keepAlive: '24h' }
  const server = new JarvisServer({
    config, bus, sessions, memory, reminders, conversation,
    attention: new AttentionManager(bus), models: new ModelRouter(createModelClient(profile), profile),
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
    assert.ok(dir.startsWith(join(tmpdir(), 'jarvis-session-api-')))
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
  async function create(title?: string) {
    return (await json<{ session: Session }>('/api/sessions', 'POST', title === undefined ? {} : { title }, 201)).session
  }
  return { sessions, memory, state, calls, config, url, request, json, create }
}

test('session API creates, reads, renames, archives, searches and deletes sessions', async t => {
  const f = await fixture(t)
  const a = await f.create('100% literal_title')
  const b = await f.create('Other session')
  assert.equal(a.messageCount, 0)
  assert.equal(a.archived, false)
  f.sessions.beginTurn(a.id, 'search-turn', 'synthetic searchable question', 'text')
  f.sessions.finishTurn('search-turn', { status: 'complete', text: 'unique-answer-needle' })
  const detail = await f.json<Detail>(`/api/sessions/${a.id}`)
  assert.equal(detail.session.id, a.id)
  assert.deepEqual(detail.messages.items.map(m => m.content), ['synthetic searchable question', 'unique-answer-needle'])
  assert.equal(detail.activeTurn, null)
  for (const query of ['%', '_', 'searchable question', 'unique-answer-needle']) {
    const result = await f.json<{ items: Session[]; total: number }>(`/api/sessions?query=${encodeURIComponent(query)}`)
    assert.deepEqual(result.items.map(s => s.id), [a.id])
    assert.equal(result.total, 1)
  }
  const renamed = await f.json<{ session: Session }>(`/api/sessions/${a.id}`, 'PATCH', { title: 'Renamed', archived: true })
  assert.equal(renamed.session.title, 'Renamed')
  assert.equal(renamed.session.archived, true)
  assert.deepEqual((await f.json<{ items: Session[] }>('/api/sessions?archived=true')).items.map(s => s.id), [a.id])
  assert.deepEqual((await f.json<{ items: Session[] }>('/api/sessions?archived=false')).items.map(s => s.id), [b.id])
  await f.json(`/api/sessions/${a.id}`, 'PATCH', { archived: false })
  assert.equal(f.sessions.get(a.id)?.archived, false)
  await f.json(`/api/sessions/${a.id}`, 'DELETE')
  assert.equal(f.sessions.get(a.id), undefined)
  assert.ok(f.sessions.get(b.id))
})

test('session API paginates session lists and chronological messages without overlap', async t => {
  const f = await fixture(t)
  const a = await f.create('A')
  const b = await f.create('B')
  await f.create('C')
  for (let i = 0; i < 3; i++) {
    f.sessions.beginTurn(a.id, `turn-${i}`, `question-${i}`, 'text')
    f.sessions.finishTurn(`turn-${i}`, { status: 'complete', text: `answer-${i}` })
  }
  f.sessions.beginTurn(b.id, 'other-turn', 'other-session-only', 'text')
  const ids: string[] = []
  for (let offset = 0; offset < 3; offset++) {
    const page = await f.json<{ items: Session[]; total: number }>(`/api/sessions?limit=1&offset=${offset}`)
    assert.equal(page.total, 3)
    assert.equal(page.items.length, 1)
    ids.push(page.items[0].id)
  }
  assert.equal(new Set(ids).size, 3)
  const newest = await f.json<Detail>(`/api/sessions/${a.id}?limit=3`)
  assert.equal(newest.messages.hasMore, true)
  const older = await f.json<Detail>(`/api/sessions/${a.id}?limit=3&before=${newest.messages.items[0].id}`)
  assert.equal(older.messages.hasMore, false)
  const messages = [...older.messages.items, ...newest.messages.items]
  assert.equal(new Set(messages.map(m => m.id)).size, 6)
  assert.ok(messages.every(m => m.sessionId === a.id))
  assert.deepEqual(messages.map(m => m.content), ['question-0', 'answer-0', 'question-1', 'answer-1', 'question-2', 'answer-2'])
})

test('session export contains its complete transcript and metadata, without another session', async t => {
  const f = await fixture(t)
  const a = await f.create('Export title')
  const b = await f.create('Private other title')
  f.sessions.beginTurn(a.id, 'export-turn', 'export question', 'text', 'work')
  f.sessions.finishTurn('export-turn', { status: 'complete', text: 'export answer', metadata: { model: 'fake', tokens: 2 } })
  f.sessions.beginTurn(b.id, 'private-turn', 'unrelated transcript', 'text')
  const response = await f.request(`/api/sessions/${a.id}/export`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-disposition') ?? '', new RegExp(`attachment; filename="jarvis-session-${a.id}\\.json"`))
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), f.sessions.exportSession(a.id))
  const all = await f.json<{ conversations: ReturnType<SessionStore['exportAll']> }>('/api/privacy/export')
  assert.deepEqual(all.conversations, f.sessions.exportAll())
})

test('session routes enforce proxy authentication and CSRF before reading or mutating', async t => {
  const f = await fixture(t)
  const session = await f.create('Protected')
  const remote = { 'x-forwarded-for': '203.0.113.9' }
  const auth = { ...remote, authorization: `Bearer ${f.config.authToken}` }
  const operations: Array<[string, string, unknown?]> = [
    ['/api/sessions', 'GET'], ['/api/sessions', 'POST', { title: 'Blocked' }],
    [`/api/sessions/${session.id}`, 'GET'], [`/api/sessions/${session.id}/export`, 'GET'],
    [`/api/sessions/${session.id}`, 'PATCH', { title: 'Blocked' }],
    [`/api/sessions/${session.id}`, 'DELETE'], ['/api/sessions', 'DELETE', { confirm: 'DELETE ALL SESSIONS' }],
  ]
  for (const [path, method, body] of operations) {
    assert.equal((await f.request(path, method, body, remote)).status, 401, `${method} ${path} requires auth`)
    assert.equal((await f.request(path, method, body, { ...auth, origin: 'https://evil.example' })).status, 403, `${method} ${path} rejects CSRF`)
  }
  assert.equal((await f.request('/api/sessions', 'GET', undefined, auth)).status, 200)
  assert.equal((await f.request('/api/sessions', 'POST', {}, { ...auth, 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal(f.sessions.list().total, 1)
  assert.equal(f.sessions.get(session.id)?.title, 'Protected')
})

test('active delete, archive and clear return 409 without cancelling or erasing work', async t => {
  const f = await fixture(t)
  const a = await f.create('Active')
  const b = await f.create('Idle')
  f.sessions.beginTurn(a.id, 'active-turn', 'unfinished question', 'text')
  f.state.activeTurn = { sessionId: a.id, turnId: 'active-turn' }
  f.state.busy = true
  const before = f.sessions.exportAll()
  await f.json(`/api/sessions/${a.id}`, 'DELETE', undefined, 409)
  await f.json(`/api/sessions/${a.id}`, 'PATCH', { archived: true }, 409)
  await f.json('/api/sessions', 'DELETE', { confirm: 'DELETE ALL SESSIONS' }, 409)
  assert.deepEqual(f.sessions.exportAll(), before)
  assert.deepEqual(f.calls.cancel, [])
  assert.equal(f.calls.quiesce, 0)
  await f.json(`/api/sessions/${b.id}`, 'DELETE')
  assert.ok(f.sessions.get(a.id))
  f.state.activeTurn = null // Busy work without a published identity must still prevent clear.
  await f.json('/api/sessions', 'DELETE', { confirm: 'DELETE ALL SESSIONS' }, 409)
})

test('missing and deleted sessions return 404 and chat never falls back to the default', async t => {
  const f = await fixture(t)
  const defaultSession = f.sessions.getOrCreateDefault()
  const deleted = await f.create('Delete me')
  await f.json(`/api/sessions/${deleted.id}`, 'DELETE')
  for (const id of ['missing-session', deleted.id]) {
    for (const [suffix, method, body] of [['', 'GET', undefined], ['/export', 'GET', undefined], ['', 'PATCH', { title: 'Missing' }], ['', 'DELETE', undefined]] as const) {
      await f.json(`/api/sessions/${id}${suffix}`, method, body, 404)
    }
    await f.json('/api/chat', 'POST', { text: 'Do not send this to default', sessionId: id, turnId: 'missing-turn' }, 404)
  }
  assert.deepEqual(f.calls.text, [])
  assert.equal(f.sessions.get(defaultSession.id)?.messageCount, 0)
  await f.json('/api/chat', 'POST', { text: 'Valid', sessionId: defaultSession.id, turnId: 'valid-turn', scenario: 'work' })
  assert.deepEqual(f.calls.text, [{ text: 'Valid', options: { source: 'text', scenario: 'work', sessionId: defaultSession.id, turnId: 'valid-turn' } }])
  f.state.busy = true
  f.state.activeTurn = { sessionId: defaultSession.id, turnId: 'running' }
  const busy = await f.json<{ activeTurn: Identity }>('/api/chat', 'POST', { text: 'Busy', sessionId: defaultSession.id }, 409)
  assert.deepEqual(busy.activeTurn, f.state.activeTurn)
})

test('cancel forwards both identity fields and cannot cancel a different session or turn', async t => {
  const f = await fixture(t)
  const a = await f.create('Active')
  const b = await f.create('Other')
  const active = { sessionId: a.id, turnId: 'running-turn' }
  f.state.activeTurn = active
  f.state.busy = true
  for (const identity of [{ sessionId: b.id, turnId: active.turnId }, { sessionId: a.id, turnId: 'old-turn' }]) {
    const result = await f.json<{ cancelled: boolean; activeTurn: Identity }>('/api/cancel', 'POST', identity)
    assert.equal(result.cancelled, false)
    assert.deepEqual(result.activeTurn, active)
    assert.deepEqual(f.calls.cancel.at(-1), identity)
  }
  await f.json('/api/cancel', 'POST', { sessionId: '../invalid', turnId: active.turnId }, 400)
  assert.equal(f.calls.cancel.length, 2)
  const stopped = await f.json<{ cancelled: boolean; activeTurn: null }>('/api/cancel', 'POST', active)
  assert.equal(stopped.cancelled, true)
  assert.equal(stopped.activeTurn, null)
  assert.deepEqual(f.calls.cancel.at(-1), active)
})

test('deleting and clearing transcripts keeps long-term MemoryStore memories intact', async t => {
  const f = await fixture(t)
  const memory = await f.memory.add({ kind: 'semantic', content: 'Synthetic long-term fact retained after transcript deletion.', sourceKind: 'user-confirmed', sourceRef: 'test', status: 'confirmed' })
  const a = await f.create('Delete transcript')
  f.sessions.beginTurn(a.id, 'delete-turn', 'ephemeral text', 'text')
  f.sessions.finishTurn('delete-turn', { status: 'complete', text: 'ephemeral reply' })
  await f.json(`/api/sessions/${a.id}`, 'DELETE')
  assert.equal(f.sessions.getTurn('delete-turn'), undefined)
  assert.deepEqual(f.memory.get(memory.id), memory)
  const b = await f.create('Clear transcript')
  f.sessions.beginTurn(b.id, 'clear-turn', 'another ephemeral text', 'text')
  await f.json('/api/sessions', 'DELETE', {}, 400)
  assert.ok(f.sessions.get(b.id))
  const result = await f.json<{ ok: boolean; session: Session }>('/api/sessions', 'DELETE', { confirm: 'DELETE ALL SESSIONS' })
  assert.equal(result.ok, true)
  assert.equal(result.session.id, f.sessions.getOrCreateDefault().id)
  assert.equal(result.session.messageCount, 0)
  assert.equal(f.sessions.list().total, 1)
  assert.equal(f.sessions.getTurn('clear-turn'), undefined)
  assert.deepEqual(f.memory.get(memory.id), memory)
})

test('session API rejects malformed input and invalid pagination with 400', async t => {
  const f = await fixture(t)
  const a = await f.create('Validation')
  for (const body of [{ title: '' }, { title: 42 }, { title: 'x'.repeat(201) }]) await f.json('/api/sessions', 'POST', body, 400)
  for (const body of [{}, { title: '' }, { archived: 'true' }, { title: 'changed', archived: 1 }]) await f.json(`/api/sessions/${a.id}`, 'PATCH', body, 400)
  assert.equal(f.sessions.get(a.id)?.title, 'Validation')
  for (const query of ['limit=0', 'limit=501', 'limit=abc', 'offset=-1', 'offset=1.5', 'archived=yes']) await f.json(`/api/sessions?${query}`, 'GET', undefined, 400)
  for (const query of ['limit=0', 'before=0', 'before=abc']) await f.json(`/api/sessions/${a.id}?${query}`, 'GET', undefined, 400)
  await f.json('/api/chat', 'POST', { text: 'Invalid identity', sessionId: 42 }, 400)
  assert.deepEqual(f.calls.text, [])
})
