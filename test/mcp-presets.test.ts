import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpManager } from '../src/mcp/manager.ts'
import { McpSettings, normalize, RevisionConflict } from '../src/mcp/settings.ts'
import { McpPresets, presetToolPolicy, presetVerified } from '../src/mcp/presets.ts'
import { mcpCatalog } from '../src/mcp/catalog.ts'

const service = () => mcpCatalog.find(p => p.available && p.fields.some(f => f.secret))!
const credentials = () => Object.fromEntries(service().fields.map(f => [f.key, f.key.toLowerCase().includes('email') ? 'test@example.com' : 'private-token-123']))
async function setup(probe: (c: any) => Promise<{ toolCount: number }> = async () => ({ toolCount: 2 })) {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-presets-'))
  const file = join(dir, 'mcp-config.json'); const manager = new McpManager({ file }); await manager.initialize()
  return { file, manager, presets: new McpPresets({ manager, probe }), cleanup: async () => { await manager.close(); assert.ok(dir.startsWith(join(tmpdir(), 'jarvis-presets-'))); await rm(dir, { recursive: true, force: true }) } }
}
test('preset private store CAS, omitted secrets, safe snapshots and managed guard', async () => {
  const f = await setup(); const id = service().id
  try {
    await f.presets.save(id, { expectedRevision: 0, credentials: credentials() })
    assert.equal((await stat(f.file)).mode & 0o777, 0o600)
    await f.presets.save(id, { expectedRevision: 1 })
    assert.deepEqual(f.manager.presetSettings().servers[0].preset!.credentials, credentials())
    assert.ok((await readFile(f.file, 'utf8')).includes('private-token-123'))
    assert.ok(!JSON.stringify([f.presets.snapshot(), f.manager.snapshot()]).includes('private-token-123'))
    await assert.rejects(f.presets.save(id, { expectedRevision: 1 }), RevisionConflict)
    const required = service().fields.find(f => f.required)!
    await assert.rejects(f.presets.save(id, { expectedRevision: 2, credentials: { [required.key]: '' } }))
    await assert.rejects(f.presets.save(id, { expectedRevision: 2, credentials: { unexpected: 'x' } }))
    await assert.rejects(f.manager.save({ id: `preset-${id}`, transport: 'stdio', command: 'evil', expectedRevision: 2, managed: true } as any), /managed/)
    await assert.rejects(f.manager.remove(`preset-${id}`, 2), /managed/)
    await f.presets.validate(id, 2)
    assert.ok(presetVerified(f.manager.presetSettings().servers[0]))
    await f.presets.disable(id, 3)
    assert.deepEqual(f.manager.definitions(), [])
    await f.presets.save(id, { expectedRevision: 4, credentials: { [required.key]: 'changed' } })
    assert.equal(presetVerified(f.manager.presetSettings().servers[0]), false)
    await assert.rejects(f.presets.enable(id, 5))
    await f.presets.disconnect(id, 5)
    assert.deepEqual(f.manager.presetSettings().servers, [])
    await f.presets.configure(id, { expectedRevision: 6, credentials: credentials() })
    await f.presets.verify(id, 7)
    assert.ok(presetVerified(f.manager.presetSettings().servers[0]))
    await f.presets.configure(id, { expectedRevision: 8 })
    assert.equal(presetVerified(f.manager.presetSettings().servers[0]), false)
    assert.deepEqual(f.manager.presetSettings().servers[0].preset!.credentials, credentials())
  } finally { await f.cleanup() }
})
test('late successful validation cannot resurrect a deleted preset', async () => {
  let finish!: (value: { toolCount: number }) => void
  const f = await setup(() => new Promise(resolve => { finish = resolve })); const id = service().id
  try {
    await f.presets.save(id, { expectedRevision: 0, credentials: credentials() })
    const pending = f.presets.validate(id, 1)
    await f.presets.remove(id, 1)
    finish({ toolCount: 1 })
    await assert.rejects(pending, RevisionConflict)
    assert.deepEqual(f.manager.presetSettings().servers, [])
  } finally { await f.cleanup() }
})
test('probe failure is sanitized and zero tools cannot verify', async () => {
  for (const error of [{ status: 401, message: 'private-token-123' }, null]) {
    const f = await setup(async () => { if (error) throw error; return { toolCount: 0 } }); const id = service().id
    try {
      await f.presets.save(id, { expectedRevision: 0, credentials: credentials() })
      await f.presets.validate(id, 1)
      const snapshot = f.presets.snapshot(); const state = snapshot.services.find(p => p.id === id)!.connection
      assert.equal(state.errorCode, error ? 'AUTH_REQUIRED' : 'INVALID_SERVER')
      assert.equal(state.status, 'failed'); assert.equal(state.enabled, false)
      assert.ok(!JSON.stringify(snapshot).includes('private-token-123'))
    } finally { await f.cleanup() }
  }
})
test('restart invalidates stale versions and modified authoritative config', async () => {
  const f = await setup(); const id = service().id
  try {
    await f.presets.save(id, { expectedRevision: 0, credentials: credentials() }); await f.presets.validate(id, 1)
    const old = f.manager.presetSettings().servers[0]
    assert.ok(presetVerified(old))
    const restored = new McpManager({ file: f.file }); await restored.initialize()
    assert.ok(presetVerified(restored.presetSettings().servers[0])); await restored.close()
    await new McpSettings(f.file).change(2, data => { data.servers[0].enabled = true; data.servers[0].preset!.version++ })
    const restarted = new McpManager({ file: f.file }); await restarted.initialize()
    assert.equal(restarted.snapshot().servers[0].enabled, false); assert.deepEqual(restarted.definitions(), []); await restarted.close()
    assert.equal(presetVerified({ ...old, destination: 'local' }), false)
    const surprise = presetToolPolicy(old, 'surprise_destructive_tool')
    assert.equal(surprise.effect, 'write'); assert.equal(surprise.usage, 'local')
    if (service().readOnly || service().toolPolicy?.permittedReadTools) assert.equal(surprise.permission, 'deny')
  } finally { await f.cleanup() }
})
test('managed metadata, schema, results and exceptions cannot echo private credentials', async () => {
  const f = await setup(); const entry = service()
  try {
    await f.presets.save(entry.id, { expectedRevision: 0, credentials: credentials() })
    const config = f.manager.presetSettings().servers[0]; config.enabled = true
    const rawName = entry.toolPolicy!.permittedReadTools![0]
    const secret = Object.values(credentials())[0]
    const state: any = { config, status: 'connected', tools: [], epoch: 1, attempts: 0, abort: new AbortController() }
    const internals = f.manager as any
    internals.states.set(config.id, state)
    let shouldThrow = false
    const basic = Buffer.from(`person@example.com:${secret}`).toString('base64')
    const basicUrl = Buffer.from(`person@example.com:${secret}`).toString('base64url')
    config.headers = { Authorization: `Basic ${basic}` }
    const client = { request: async () => { if (shouldThrow) throw new Error(`https://remote.test/?token=${secret}&basic=${basic}`); return { content: [{ type: 'text', text: `token ${secret} ${encodeURIComponent(secret)} ${Buffer.from(secret).toString('base64')} ${basic} ${basicUrl}` }] } } }
    const tool = internals.definition(state, client, 1, rawName, `Remote ${secret} ${basic} ${basicUrl}`, { type: 'object' }, 'tool')
    state.tools = [tool]
    assert.ok(!JSON.stringify(f.manager.definitions()).includes(secret))
    const result = (await tool.execute({}, {})).content
    for (const value of [secret, basic, basicUrl]) {
      assert.ok(!JSON.stringify(f.manager.definitions()).includes(value))
      assert.ok(!result.includes(value))
      assert.throws(() => internals.definition(state, client, 1, rawName, 'safe', { type: 'object', description: value }, 'tool'), /INVALID_SERVER/)
    }
    shouldThrow = true
    await assert.rejects(tool.execute({}, {}), (error: Error) => error.message === 'UNREACHABLE')
    assert.throws(() => internals.definition(state, client, 1, rawName, 'safe', { type: 'object', description: secret }, 'tool'), /INVALID_SERVER/)
  } finally { await f.cleanup() }
})
test('disable waits for the previous transport close before resolving', async () => {
  const f = await setup(); const id = service().id
  try {
    await f.presets.save(id, { expectedRevision: 0, credentials: credentials() })
    const state = (f.manager as any).states.get(`preset-${id}`)
    let release!: () => void; let closeStarted!: () => void
    const started = new Promise<void>(resolve => { closeStarted = resolve })
    state.client = { close: () => { closeStarted(); return new Promise<void>(resolve => { release = resolve }) } }
    let returned = false
    state.config = { ...state.config, enabled: true }
    const pending = f.presets.disable(id, 1).then(() => { returned = true })
    await started
    assert.equal(returned, false)
    release(); await pending
    assert.equal(returned, true)
  } finally { await f.cleanup() }
})
test('manager shutdown aborts an in-flight isolated probe', async () => {
  const f = await setup()
  try {
    const config = normalize({ id: 'probe', transport: 'stdio', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] })
    const pending = f.manager.probe(config)
    const rejected = assert.rejects(pending, /TIMEOUT|UNREACHABLE/)
    await f.manager.close()
    await rejected
    assert.deepEqual(f.manager.definitions(), [])
  } finally { await f.cleanup() }
})
test('isolated real SDK probe compiles schemas without activating tools', async () => {
  const f = await setup()
  try {
    const config = normalize({ id: 'probe', transport: 'stdio', command: process.execPath, args: ['--experimental-transform-types', resolve('test/mcp-fixture.ts')] })
    const result = await f.manager.probe(config)
    assert.ok(result.toolCount > 0)
    assert.deepEqual(f.manager.snapshot().servers, []); assert.deepEqual(f.manager.definitions(), [])
    config.preset = { id: service().id, version: 1, mode: 'read', credentials: credentials() }
    await assert.rejects(f.manager.probe(config), /INVALID_SERVER/)
  } finally { await f.cleanup() }
})
