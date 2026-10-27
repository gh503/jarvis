import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JarvisServer, type ServerDeps } from '../src/server.ts'
import { EventBus } from '../src/events.ts'
import { Conversation } from '../src/conversation.ts'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-local-api-'))
  const state = { busy: false, activeTurn: null as { sessionId: string; turnId: string } | null, blocked: false, blockedSessions: new Set<string>(), revision: 1, order: [] as string[], reads: 0, fail: false, conflict: false, onSave: undefined as (() => void) | undefined, release: undefined as (() => void) | undefined }
  const pause = async () => { if (state.onSave) await new Promise<void>(resolve => { state.release = resolve; state.onSave!() }) }
  const deps = {
    config: { dataDir: dir, host: '127.0.0.1', port: 0, authToken: 'synthetic-token', webDir: dir },
    bus: new EventBus(), logger: { error() {}, info() {} },
    conversation: { blockSessionAdmissions: (id: string) => state.blockedSessions.add(id), resumeSessionAdmissions: (id: string) => state.blockedSessions.delete(id), status: () => ({ busy: state.busy, activeTurn: state.activeTurn }), quiesce: async () => { state.blocked = true; state.order.push('conversation') }, resumeAdmissions: () => { state.blocked = false }, reset() {}, refreshModel: async () => {} },
    sessions: { get: (id: string) => ['session', 'other'].includes(id) ? { id } : undefined, delete: () => state.order.push('delete-session'), clearAll: () => state.order.push('sessions'), getOrCreateDefault: () => ({ id: 'new' }), exportSession: (id: string) => ({ id }), exportAll: () => ({ sessions: [{ id: 'session' }, { id: 'other' }] }) },
    tools: { quiesce: async () => { state.order.push('tools') } },
    localSettings: { snapshot: () => ({ revision: state.revision, outputDir: dir }), update: async () => { state.order.push('update'); await pause(); if (state.conflict) throw new Error('Settings revision conflict'); if (state.fail) throw new Error('secret-path'); state.revision++ }, reset: async () => { state.order.push('reset-settings') } },
    taskTools: { status: () => ({ shell: { enabled: false, available: false, reason: 'disabled' } }), pendingQuestions: () => [{ id: 'question' }], plan: (sessionId: string) => ({ sessionId }), jobs: (sessionId: string) => [{ id: 'job', sessionId }], exportSession: (sessionId: string) => ({ sessionId, plan: [] }), answer: (id: string, identity: { sessionId: string; turnId: string }) => id === 'question' && identity.sessionId === 'session' && identity.turnId === 'turn', cancelJob: async (id: string, sessionId: string) => id === 'job' && sessionId === 'session', quiesce: async () => { state.order.push('tasks') }, clearSession: async (id: string) => { state.order.push(`tasks:${id}`); await pause() }, clearAll: async () => { state.order.push('clear-tasks') } },
    fileTools: { artifacts: (sessionId: string) => [{ id: 'artifact', sessionId }], readArtifact: async (id: string, sessionId: string) => { state.reads++; if (id !== 'artifact' || sessionId !== 'session') throw new Error('private path'); return { name: '测试\r\n".html', mime: 'text/html', bytes: Buffer.from('<script>bad()</script>') } }, clearSession: async (id: string) => { state.order.push(`files:${id}`) }, clearAll: async () => { state.order.push('clear-files') } },
    mcp: { snapshot: () => ({ revision: 1, servers: [] }), save: pause },
    modelSettings: { load: async () => ({ profiles: [], scenarios: [] }), resetToDefaults: async () => ({ profiles: [] }), addProfile: pause, publicView: (value: unknown) => value },
    memory: { exportAll: () => ({}), eraseAll: () => ({}) }, reminders: { list: () => [] }, actions: { clear() {} }, telemetry: { clearAll() {} }, secure: { rotate() {} },
  } as unknown as ServerDeps
  const server = new JarvisServer(deps)
  const { url } = await server.start()
  const request = (path: string, method = 'GET', body?: unknown, headers = {}) => fetch(url + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { state, request, close: async () => { await server.close(); await rm(dir, { recursive: true, force: true }) } }
}

const settingsPath = '/api/local-tools/settings'
const answer = { sessionId: 'session', turnId: 'turn', answers: [{ id: 'choice', selected: ['a'] }] }

test('local API authentication, session isolation and strict question/job identities', async () => {
  const f = await fixture()
  try {
    for (const path of ['/api/local-tools', '/api/local-tools/artifacts/artifact?sessionId=session']) assert.equal((await f.request(path, 'GET', undefined, { 'x-forwarded-for': '192.0.2.1' })).status, 401)
    assert.equal((await f.request('/api/local-tools', 'GET', undefined, { origin: 'https://evil.example' })).status, 403)
    const snapshot = await (await f.request('/api/local-tools')).json() as any
    assert.equal(snapshot.settings.revision, 1)
    assert.equal(snapshot.questions[0].id, 'question')
    assert.equal((await f.request('/api/local-tools/session/missing')).status, 404)
    const data = await (await f.request('/api/local-tools/session/session')).json() as any
    assert.equal(data.plan.sessionId, 'session')
    assert.equal(data.artifacts[0].sessionId, 'session')
    for (const body of [{ ...answer, extra: true }, { ...answer, turnId: null }, { ...answer, answers: {} }, { ...answer, answers: [{ id: 'choice', selected: [2] }] }]) assert.equal((await f.request('/api/local-tools/questions/question', 'POST', body)).status, 400)
    assert.equal((await f.request('/api/local-tools/questions/question', 'POST', { ...answer, sessionId: 'other' })).status, 409)
    assert.equal((await f.request('/api/local-tools/questions/question', 'POST', answer)).status, 200)
    assert.equal((await f.request('/api/local-tools/jobs/job/cancel', 'POST', { sessionId: 'other' })).status, 409)
    assert.equal((await f.request('/api/local-tools/jobs/job/cancel', 'POST', { sessionId: 'session', extra: true })).status, 400)
    assert.equal((await f.request('/api/local-tools/jobs/job/cancel', 'POST', { sessionId: 'session' })).status, 200)
  } finally { await f.close() }
})

test('artifact downloads require existing owner and force inert attachments', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.request('/api/local-tools/artifacts/artifact')).status, 400)
    assert.equal((await f.request('/api/local-tools/artifacts/artifact?sessionId=missing')).status, 404)
    assert.equal(f.state.reads, 0)
    assert.equal((await f.request('/api/local-tools/artifacts/artifact?sessionId=other')).status, 404)
    const response = await f.request('/api/local-tools/artifacts/artifact?sessionId=session')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/octet-stream')
    assert.match(response.headers.get('content-disposition')!, /^attachment;.*filename\*=UTF-8''/)
    assert.doesNotMatch(response.headers.get('content-disposition')!, /[\r\n]/)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(response.headers.get('content-security-policy')!, /sandbox/)
    assert.equal(await response.text(), '<script>bad()</script>')
  } finally { await f.close() }
})

test('settings validate revision, reject busy and always release admission after failures', async () => {
  const f = await fixture()
  try {
    for (const body of [{}, { expectedRevision: -1 }, { expectedRevision: '1' }, { expectedRevision: 1, outputDir: '/tmp' }, { expectedRevision: 1, extra: true }]) assert.equal((await f.request(settingsPath, 'PATCH', body)).status, 400)
    f.state.busy = true
    assert.equal((await f.request(settingsPath, 'PATCH', { expectedRevision: 1 })).status, 409)
    f.state.busy = false
    assert.equal((await f.request(settingsPath, 'PATCH', { expectedRevision: 0 })).status, 409)
    f.state.order = []
    assert.equal((await f.request(settingsPath, 'PATCH', { expectedRevision: 1, shellEnabled: true })).status, 200)
    assert.deepEqual(f.state.order, ['conversation', 'tools', 'tasks', 'update'])
    assert.equal(f.state.blocked, false)
    f.state.conflict = true
    assert.equal((await f.request(settingsPath, 'PATCH', { expectedRevision: 2 })).status, 409)
    assert.equal(f.state.blocked, false)
    f.state.conflict = false
    f.state.fail = true
    const failed = await f.request(settingsPath, 'PATCH', { expectedRevision: 2 })
    assert.equal(failed.status, 400)
    assert.doesNotMatch(await failed.text(), /secret-path/)
    assert.equal(f.state.blocked, false)
  } finally { await f.close() }
})

test('settings, model, MCP and erase mutations are mutually exclusive', async () => {
  for (const initiating of ['local', 'model', 'mcp']) {
    const f = await fixture()
    try {
      const entered = new Promise<void>(resolve => { f.state.onSave = resolve })
      const saving = initiating === 'local' ? f.request(settingsPath, 'PATCH', { expectedRevision: 1 }) : initiating === 'model' ? f.request('/api/model/profile/add', 'POST', {}) : f.request('/api/mcp/servers', 'POST', { id: 'mcp' })
      await entered
      assert.equal(f.state.blocked, true)
      assert.equal((await f.request(settingsPath, 'PATCH', { expectedRevision: 1 })).status, 409)
      assert.equal((await f.request('/api/model/profile/add', 'POST', {})).status, 409)
      assert.equal((await f.request('/api/mcp/servers', 'POST', { id: 'mcp' })).status, 409)
      assert.equal((await f.request('/api/privacy/erase', 'POST', { confirm: 'ERASE ALL' })).status, 409)
      f.state.release!()
      assert.equal((await saving).status, 200)
      assert.equal(f.state.blocked, false)
    } finally { f.state.release?.(); await f.close() }
  }
})

test('exports include session tasks and deletion clears only owned records before sessions', async () => {
  const f = await fixture()
  try {
    const exported = await (await f.request('/api/sessions/session/export')).json() as any
    assert.equal(exported.localTools.sessionId, 'session')
    const privacy = await (await f.request('/api/privacy/export')).json() as any
    assert.deepEqual(privacy.conversations.sessions.map((s: any) => s.localTools.sessionId), ['session', 'other'])
    assert.equal((await f.request('/api/sessions/session', 'DELETE')).status, 200)
    assert.deepEqual(f.state.order, ['tasks:session', 'files:session', 'delete-session'])
    f.state.order = []
    assert.equal((await f.request('/api/sessions', 'DELETE', { confirm: 'DELETE ALL SESSIONS' })).status, 200)
    assert.deepEqual(f.state.order, ['conversation', 'tools', 'clear-tasks', 'clear-files', 'sessions'])
    f.state.order = []
    assert.equal((await f.request('/api/privacy/erase', 'POST', { confirm: 'ERASE ALL' })).status, 200)
    assert.deepEqual(f.state.order, ['conversation', 'tools', 'tasks', 'clear-tasks', 'clear-files', 'reset-settings', 'sessions'])
    assert.equal(f.state.blocked, false)
  } finally { await f.close() }
})


test('inactive session cleanup preserves another active turn and rejects new work for the deleted target', async () => {
  const f = await fixture()
  try {
    f.state.busy = true
    f.state.activeTurn = { sessionId: 'other', turnId: 'running' }
    const entered = new Promise<void>(resolve => { f.state.onSave = resolve })
    const deleting = f.request('/api/sessions/session', 'DELETE')
    await entered
    assert.equal(f.state.blocked, false)
    assert.deepEqual(f.state.order, ['tasks:session'])
    assert.deepEqual([...f.state.blockedSessions], ['session'])
    assert.equal((await f.request('/api/chat', 'POST', { sessionId: 'session', turnId: 'new', text: 'new work' })).status, 404)
    assert.equal((await f.request(settingsPath, 'PATCH', { expectedRevision: 1 })).status, 409)
    f.state.release!()
    assert.equal((await deleting).status, 200)
    assert.deepEqual(f.state.order, ['tasks:session', 'files:session', 'delete-session'])
    assert.deepEqual(f.state.activeTurn, { sessionId: 'other', turnId: 'running' })
    assert.equal(f.state.busy, true)
    assert.equal(f.state.blocked, false)
    assert.equal(f.state.blockedSessions.size, 0)
  } finally { f.state.release?.(); await f.close() }
})


test('conversation fence resolves implicit default session before admitting text or audio', async () => {
  let admitted = 0
  const conversation = new Conversation({ sessions: { getTurn: () => undefined, getOrCreateDefault: () => ({ id: 'default-session' }), get: () => ({ archived: false }) }, policy: { noteInteraction: () => { admitted++ } } } as unknown as ConstructorParameters<typeof Conversation>[0])
  conversation.blockSessionAdmissions('default-session')
  await assert.rejects(conversation.handleText('implicit'), /会话正在删除/)
  await assert.rejects(conversation.handleText('explicit', { sessionId: 'default-session' }), /会话正在删除/)
  await assert.rejects(conversation.handleAudio(Buffer.from('audio'), 'audio/wav'), /会话正在删除/)
  assert.equal(admitted, 0)
  // Exercise admission directly so this isolated fixture needs no model/audio runtime.
  const reserve = (conversation as unknown as { reserve: (options: { sessionId: string }) => { sessionId: string; controller?: AbortController } }).reserve.bind(conversation)
  assert.equal(reserve({ sessionId: 'other' }).sessionId, 'other')
  assert.equal(admitted, 1)
  const fresh = new Conversation({ sessions: { getTurn: () => undefined, getOrCreateDefault: () => ({ id: 'default-session' }), get: () => ({ archived: false }) }, policy: { noteInteraction() {} } } as unknown as ConstructorParameters<typeof Conversation>[0])
  fresh.blockSessionAdmissions('default-session')
  fresh.resumeSessionAdmissions('default-session')
  const resumed = (fresh as unknown as { reserve: (options: object) => { controller?: AbortController } }).reserve({})
  assert.ok(resumed.controller)
})
