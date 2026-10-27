import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JarvisServer, type ServerDeps } from '../src/server.ts'
import { EventBus } from '../src/events.ts'
import { RevisionConflict } from '../src/mcp/settings.ts'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-tool-server-'))
  const state = { busy: false, blocked: false, approval: true, reads: 0, failure: '', saved: undefined as unknown, order: [] as string[], release: undefined as (() => void) | undefined, onSave: undefined as (() => void) | undefined }
  const deps = {
    config: { dataDir: dir, host: '127.0.0.1', port: 0, authToken: 'secret-token', webDir: dir },
    bus: new EventBus(), logger: { error() {}, info() {} },
    conversation: { status: () => ({ busy: state.busy }), quiesce: async () => { state.blocked = true; state.order.push('conversation') }, resumeAdmissions: () => { state.blocked = false }, reset() {}, refreshModel: async () => {} },
    sessions: { get: (id: string) => ['session', 'other'].includes(id) ? { id } : undefined, clearAll: () => state.order.push('sessions'), exportSession: (id: string) => ({ id, messages: [] }), exportAll: () => ({ version: 1, sessions: [{ id: 'session', messages: [] }, { id: 'other', messages: [] }] }) },
    tools: { catalogue: () => [{ name: 'test', execute: 'must-be-stripped', parameters: {} }], pending: () => [{ id: 'approval' }], approve: (_id: string, _approved: boolean, identity: { sessionId: string; turnId: string }) => state.approval && identity.sessionId === 'session' && identity.turnId === 'turn', quiesce: async () => { state.order.push('tools') } },
    toolJournal: { listCalls: (sessionId: string, turnId?: string) => { state.reads++; return [{ sessionId, turnId }] } },
    mcp: { snapshot: () => ({ revision: 1, servers: [{ id: 'mcp' }] }), save: async (body: unknown) => { state.saved = body; if (state.failure === 'revision') throw new RevisionConflict(); if (state.failure) throw new Error('credential=secret'); if (state.onSave) await new Promise<void>(resolve => { state.release = resolve; state.onSave!() }) }, remove: async () => { state.order.push('mcp-remove') }, reconnect: async () => { state.order.push('reconnect') } },
    reminders: { list: () => [] },
    memory: { eraseAll: () => ({}), exportAll: () => ({ items: [] }) }, actions: { clear() {} }, telemetry: { clearAll() {} },
    modelSettings: { load: async () => ({ profiles: [], scenarios: [] }), resetToDefaults: async () => ({ profiles: [] }), publicView: (value: unknown) => value, addProfile: async () => { if (state.onSave) await new Promise<void>(resolve => { state.release = resolve; state.onSave!() }); return {} } }, secure: { rotate() {} },
  } as unknown as ServerDeps
  const server = new JarvisServer(deps)
  const { url } = await server.start()
  const request = (path: string, method = 'GET', body?: unknown, headers = {}) => fetch(url + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { state, request, close: async () => { await server.close(); await rm(dir, { recursive: true, force: true }) } }
}

test('tool APIs preserve authentication, strict approval identity and session isolation', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.request('/api/tools', 'GET', undefined, { 'x-forwarded-for': '1.2.3.4' })).status, 401)
    assert.equal((await f.request('/api/mcp', 'GET', undefined, { origin: 'https://evil.example' })).status, 403)
    const catalogue = await (await f.request('/api/tools')).json() as any
    assert.equal(catalogue.definitions[0].execute, undefined)
    assert.equal(catalogue.approvals.length, 1)
    for (const body of [{ approved: 'true', sessionId: 'session', turnId: 'turn' }, { approved: true, sessionId: 'session' }, { approved: true, sessionId: 1, turnId: 'turn' }]) {
      assert.equal((await f.request('/api/tools/approvals/approval', 'POST', body)).status, 400)
    }
    assert.equal((await f.request('/api/tools/approvals/approval', 'POST', { approved: true, sessionId: 'other', turnId: 'turn' })).status, 409)
    assert.equal((await f.request('/api/tools/approvals/approval', 'POST', { approved: false, sessionId: 'session', turnId: 'turn' })).status, 200)
    f.state.approval = false
    assert.equal((await f.request('/api/tools/approvals/approval', 'POST', { approved: true, sessionId: 'session', turnId: 'turn' })).status, 409)
    assert.equal((await f.request('/api/tools/calls')).status, 400)
    assert.equal((await f.request('/api/tools/calls?sessionId=missing')).status, 404)
    assert.equal(f.state.reads, 0)
    const calls = await (await f.request('/api/tools/calls?sessionId=session&turnId=turn')).json() as any
    assert.deepEqual(calls.items, [{ sessionId: 'session', turnId: 'turn' }])
  } finally { await f.close() }
})

test('session and privacy exports include tool calls scoped to each exported session', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.request('/api/sessions/missing/export')).status, 404)
    assert.equal(f.state.reads, 0)
    const exported = await (await f.request('/api/sessions/session/export')).json() as any
    assert.equal(exported.id, 'session')
    assert.deepEqual(exported.toolCalls, [{ sessionId: 'session' }])
    const privacy = await (await f.request('/api/privacy/export')).json() as any
    assert.equal(privacy.conversations.version, 1)
    assert.deepEqual(privacy.conversations.sessions.map((session: any) => [session.id, session.toolCalls]), [
      ['session', [{ sessionId: 'session' }]], ['other', [{ sessionId: 'other' }]],
    ])
  } finally { await f.close() }
})

test('MCP mutations enforce busy admission, revisions and generic errors', async () => {
  const f = await fixture()
  const body = { id: 'mcp', transport: 'stdio', command: 'test', expectedRevision: 1 }
  try {
    f.state.busy = true
    assert.equal((await f.request('/api/mcp/servers', 'POST', body)).status, 409)
    assert.equal(f.state.saved, undefined)
    f.state.busy = false
    assert.equal((await f.request('/api/mcp/servers', 'POST', body)).status, 200)
    assert.deepEqual(f.state.saved, body)
    assert.equal(f.state.blocked, false)
    f.state.failure = 'revision'
    assert.equal((await f.request('/api/mcp/servers', 'POST', body)).status, 409)
    f.state.failure = 'secret'
    const failed = await f.request('/api/mcp/servers', 'POST', body)
    assert.equal(failed.status, 400)
    assert.doesNotMatch(await failed.text(), /credential|secret/)
    assert.equal(f.state.blocked, false)
    assert.equal((await f.request('/api/mcp/servers/mcp', 'DELETE', {})).status, 400)
    assert.equal((await f.request('/api/mcp/servers/mcp', 'DELETE', { expectedRevision: 1 })).status, 200)
    assert.equal((await f.request('/api/mcp/servers/mcp/reconnect', 'POST', {})).status, 200)
  } finally { await f.close() }
})

test('in-flight MCP changes block concurrent mutation and erase until admissions resume', async () => {
  const f = await fixture()
  try {
    const entered = new Promise<void>(resolve => { f.state.onSave = resolve })
    const saving = f.request('/api/mcp/servers', 'POST', { id: 'mcp', transport: 'stdio', command: 'test' })
    await entered
    assert.equal(f.state.blocked, true)
    assert.equal((await f.request('/api/mcp/servers/mcp/reconnect', 'POST', {})).status, 409)
    assert.equal((await f.request('/api/privacy/erase', 'POST', { confirm: 'ERASE ALL' })).status, 409)
    f.state.release!()
    assert.equal((await saving).status, 200)
    assert.equal(f.state.blocked, false)
  } finally { f.state.release?.(); await f.close() }
})

test('model mutations hold admissions and exclude MCP changes until persistence finishes', async () => {
  const f = await fixture()
  try {
    f.state.busy = true
    assert.equal((await f.request('/api/model/profile/add', 'POST', {})).status, 409)
    f.state.busy = false
    const entered = new Promise<void>(resolve => { f.state.onSave = resolve })
    const saving = f.request('/api/model/profile/add', 'POST', {})
    await entered
    assert.equal(f.state.blocked, true)
    assert.equal((await f.request('/api/model/priority', 'POST', { priority: [] })).status, 409)
    assert.equal((await f.request('/api/mcp/servers/mcp/reconnect', 'POST', {})).status, 409)
    assert.equal((await f.request('/api/privacy/erase', 'POST', { confirm: 'ERASE ALL' })).status, 409)
    f.state.release!()
    assert.equal((await saving).status, 200)
    assert.equal(f.state.blocked, false)
  } finally { f.state.release?.(); await f.close() }
})

test('full erase quiesces tools before clearing sessions and removes MCP credentials', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.request('/api/privacy/erase', 'POST', { confirm: 'ERASE ALL' })).status, 200)
    assert.deepEqual(f.state.order, ['conversation', 'tools', 'sessions', 'mcp-remove'])
    assert.equal(f.state.blocked, false)
  } finally { await f.close() }
})
