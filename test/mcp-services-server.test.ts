import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JarvisServer, type ServerDeps } from '../src/server.ts'
import { EventBus } from '../src/events.ts'
import { PresetError } from '../src/mcp/presets.ts'
import { RevisionConflict } from '../src/mcp/settings.ts'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-services-api-'))
  const state = { busy: false, blocked: false, revision: 0, configured: false, verified: false, enabled: false, order: [] as string[], failure: undefined as unknown, entered: undefined as (() => void) | undefined, release: undefined as (() => void) | undefined }
  const snapshot = () => ({ revision: state.revision, services: [{ id: 'fixture', available: true, connection: { enabled: state.enabled, status: state.configured ? 'needs-verification' : 'unconfigured' } }, { id: 'unavailable', available: false, connection: { enabled: false, status: 'unconfigured' } }] })
  const mutate = async (action: string, id: string, revision: number, enabled = false) => {
    state.order.push(action)
    if (state.entered) await new Promise<void>(resolve => { state.release = resolve; state.entered!() })
    if (state.failure) throw state.failure
    if (id !== 'fixture') throw new PresetError('INVALID_SERVER')
    if (revision !== state.revision) throw new RevisionConflict()
    if (action === 'toggle' && (!state.configured || enabled && !state.verified)) throw new PresetError('INVALID_SERVER')
    if (action === 'configure') state.configured = true
    if (action === 'verify') state.verified = true
    if (action === 'toggle') state.enabled = enabled
    if (action === 'disconnect') { state.configured = false; state.enabled = false }
    state.revision++
    return snapshot()
  }
  const deps = {
    config: { dataDir: dir, host: '127.0.0.1', port: 0, authToken: 'synthetic-token', webDir: dir },
    bus: new EventBus(), logger: { error() {}, info() {} },
    conversation: { status: () => ({ busy: state.busy }), quiesce: async () => { state.blocked = true; state.order.push('conversation') }, resumeAdmissions: () => { state.blocked = false } },
    tools: { quiesce: async () => { state.order.push('tools') } },
    taskTools: { quiesce: async () => { state.order.push('tasks') } },
    localSettings: { snapshot: () => ({ revision: state.revision }), update: () => mutate('local', 'fixture', state.revision) }, fileTools: {}, sessions: {},
    presets: { snapshot, configure: (id: string, body: { expectedRevision: number }) => mutate('configure', id, body.expectedRevision), verify: (id: string, rev: number) => mutate('verify', id, rev), toggle: (id: string, enabled: boolean, rev: number) => mutate('toggle', id, rev, enabled), disconnect: (id: string, rev: number) => mutate('disconnect', id, rev) },
    mcp: { snapshot: () => ({ revision: 0, servers: [] }), save: () => mutate('advanced', 'fixture', state.revision) },
    modelSettings: { addProfile: () => mutate('model', 'fixture', state.revision), load: async () => ({ profiles: [] }), publicView: (value: unknown) => value },
  } as unknown as ServerDeps
  const server = new JarvisServer(deps)
  const { url } = await server.start()
  const request = (path: string, method = 'GET', body?: unknown, headers = {}) => fetch(url + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { state, deps, request, close: async () => { state.release?.(); await server.close(); await rm(dir, { recursive: true, force: true }) } }
}
const root = '/api/mcp/services'
const service = `${root}/fixture`

test('service API uses auth and origin guards for catalog and every supported mutation', async () => {
  const f = await fixture()
  try {
    for (const [path, method, body] of [[root, 'GET', undefined], [`${service}/configure`, 'POST', { expectedRevision: 0 }], [`${service}/verify`, 'POST', { expectedRevision: 0 }], [`${service}/toggle`, 'POST', { expectedRevision: 0, enabled: false }], [service, 'DELETE', { expectedRevision: 0 }]] as const) {
      assert.equal((await f.request(path, method, body, { 'x-forwarded-for': '192.0.2.1' })).status, 401)
      assert.equal((await f.request(`${path}?token=synthetic-token`, method, body, { 'x-forwarded-for': '192.0.2.1' })).status, 401)
      assert.equal((await f.request(path, method, body, { origin: 'https://evil.example' })).status, 403)
    }
    const response = await f.request(`${service}/configure`, 'POST', { expectedRevision: 0, credentials: { token: 'synthetic-private-secret' } }, { 'x-forwarded-for': '192.0.2.1', authorization: 'Bearer synthetic-token' })
    assert.equal(response.status, 200)
    assert.doesNotMatch(await response.text(), /synthetic-private-secret/)
    assert.doesNotMatch(await (await f.request(root)).text(), /synthetic-private-secret/)
  } finally { await f.close() }
})

test('strict service bodies reject identities, unknown commands, prototypes and invalid credentials', async () => {
  const f = await fixture()
  try {
    const invalid = [null, [], {}, { expectedRevision: -1 }, { expectedRevision: '0' }, { expectedRevision: 0.5 }, { expectedRevision: 0, command: 'secret-command' }, { expectedRevision: 0, mode: 'admin' }, { expectedRevision: 0, credentials: [] }, { expectedRevision: 0, credentials: null }, { expectedRevision: 0, credentials: { token: 42 } }, { expectedRevision: 0, credentials: { token: 'x'.repeat(8193) } }, { expectedRevision: 0, credentials: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`key${i}`, 'x'])) }, JSON.parse('{"expectedRevision":0,"credentials":{"__proto__":"secret"}}'), { expectedRevision: 0, credentials: { constructor: 'secret' } }, { expectedRevision: 0, credentials: { 'bad.key': 'secret' } }, JSON.parse('{"expectedRevision":0,"__proto__":{"command":"secret"}}')]
    for (const body of invalid) assert.equal((await f.request(`${service}/configure`, 'POST', body)).status, 400)
    for (const id of ['__proto__', 'constructor', 'prototype', 'bad%20id', 'x'.repeat(49)]) assert.equal((await f.request(`${root}/${id}/configure`, 'POST', { expectedRevision: 0 })).status, 400)
    for (const action of ['verify', 'toggle']) assert.equal((await f.request(`${service}/${action}`, 'POST', { expectedRevision: 0, credentials: { token: 'secret' } })).status, 400)
    assert.equal((await f.request(`${service}/toggle`, 'POST', { expectedRevision: 0, enabled: 'true' })).status, 400)
    assert.equal((await f.request(service, 'DELETE', { expectedRevision: 0, extra: true })).status, 400)
    assert.deepEqual(f.state.order, [])
  } finally { await f.close() }
})

test('mutations quiesce in order, preserve revisions and require verification before enabling', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.request(`${service}/toggle`, 'POST', { expectedRevision: 0, enabled: true })).status, 400)
    assert.equal((await f.request(`${root}/unavailable/toggle`, 'POST', { expectedRevision: 0, enabled: true })).status, 400)
    f.state.order = []
    assert.equal((await f.request(`${service}/configure`, 'POST', { expectedRevision: 0, credentials: { token: 'secret' }, mode: 'read' })).status, 200)
    assert.deepEqual(f.state.order, ['conversation', 'tools', 'tasks', 'configure'])
    assert.equal(f.state.blocked, false)
    assert.equal((await f.request(`${service}/verify`, 'POST', { expectedRevision: 0 })).status, 409)
    assert.equal((await f.request(`${service}/verify`, 'POST', { expectedRevision: 1 })).status, 200)
    assert.equal((await f.request(`${service}/toggle`, 'POST', { expectedRevision: 2, enabled: true })).status, 200)
    const disconnected = await f.request(service, 'DELETE', { expectedRevision: 3 })
    assert.equal(disconnected.status, 200)
    assert.equal((await disconnected.json() as any).revision, 4)
    assert.equal(f.state.enabled, false)
  } finally { await f.close() }
})

test('verification holds the shared mutation lock across its network await', async () => {
  const f = await fixture()
  try {
    f.state.busy = true
    assert.equal((await f.request(`${service}/verify`, 'POST', { expectedRevision: 0 })).status, 409)
    f.state.busy = false
    const entered = new Promise<void>(resolve => { f.state.entered = resolve })
    const verifying = f.request(`${service}/verify`, 'POST', { expectedRevision: 0 })
    await entered
    assert.equal(f.state.blocked, true)
    for (const [path, method, body] of [[`${service}/configure`, 'POST', { expectedRevision: 0 }], [service, 'DELETE', { expectedRevision: 0 }], ['/api/mcp/servers', 'POST', { id: 'advanced' }], ['/api/model/profile/add', 'POST', {}], ['/api/local-tools/settings', 'PATCH', { expectedRevision: 0 }], ['/api/privacy/erase', 'POST', { confirm: 'ERASE ALL' }]] as const) assert.equal((await f.request(path, method, body)).status, 409)
    assert.equal((await f.request(root)).status, 200)
    f.state.release!()
    assert.equal((await verifying).status, 200)
    assert.equal(f.state.blocked, false)
  } finally { await f.close() }
})

test('in-flight advanced MCP, model and local settings changes block service operations', async () => {
  for (const [path, method, body] of [['/api/mcp/servers', 'POST', { id: 'advanced' }], ['/api/model/profile/add', 'POST', {}], ['/api/local-tools/settings', 'PATCH', { expectedRevision: 0 }]] as const) {
    const f = await fixture()
    try {
      const entered = new Promise<void>(resolve => { f.state.entered = resolve })
      const changing = f.request(path, method, body)
      await entered
      assert.equal((await f.request(`${service}/verify`, 'POST', { expectedRevision: 0 })).status, 409)
      assert.equal((await f.request(`${service}/toggle`, 'POST', { expectedRevision: 0, enabled: false })).status, 409)
      assert.equal(f.state.blocked, true)
      f.state.release!()
      await changing
      assert.equal(f.state.blocked, false)
    } finally { await f.close() }
  }
})

test('safe errors never leak secrets and admissions resume after operation or quiesce failures', async () => {
  const f = await fixture()
  try {
    for (const [error, status, code] of [[new Error('Bearer secret https://secret.example/?token=secret'), 500, undefined], [Object.assign(new Error('secret'), { code: 'AUTH_REQUIRED', status: 401 }), 500, undefined], [new RevisionConflict(), 409, 'REVISION_CONFLICT'], [new PresetError('AUTH_REQUIRED'), 400, 'AUTH_REQUIRED'], [new PresetError('RATE_LIMITED'), 429, 'RATE_LIMITED'], [new PresetError('TIMEOUT'), 504, 'TIMEOUT'], [new PresetError('UNREACHABLE'), 502, 'UNREACHABLE']] as const) {
      f.state.failure = error
      const response = await f.request(`${service}/configure`, 'POST', { expectedRevision: 0, credentials: { token: 'secret' } })
      assert.equal(response.status, status)
      const body = await response.json() as any
      assert.equal(body.code, code)
      assert.doesNotMatch(JSON.stringify(body), /secret|Bearer/)
      assert.equal(f.state.blocked, false)
    }
    f.state.failure = undefined
    f.deps.tools!.quiesce = async () => { throw new Error('secret') }
    assert.equal((await f.request(`${service}/verify`, 'POST', { expectedRevision: 0 })).status, 500)
    assert.equal(f.state.blocked, false)
    f.deps.tools!.quiesce = async () => {}
    assert.equal((await f.request(`${service}/configure`, 'POST', { expectedRevision: 0 })).status, 200)
  } finally { await f.close() }
})

test('advanced MCP endpoints forbid reserved preset identities including reconnect', async () => {
  const f = await fixture()
  try {
    for (const [path, method, body] of [['/api/mcp/servers', 'POST', { id: 'preset-fixture', command: 'secret', expectedRevision: 0 }], ['/api/mcp/servers/preset-fixture', 'DELETE', { expectedRevision: 0 }], ['/api/mcp/servers/preset-fixture/reconnect', 'POST', {}]] as const) {
      const response = await f.request(path, method, body)
      assert.equal(response.status, 403)
      assert.doesNotMatch(await response.text(), /secret/)
    }
    assert.deepEqual(f.state.order, [])
  } finally { await f.close() }
})
