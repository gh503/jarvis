import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { SessionStore } from '../src/sessions.ts'
import { ToolJournal } from '../src/tool-journal.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { ProfileStore } from '../src/profile.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
function command(binary: string, args: string[], dataDir?: string) {
  return spawnSync(binary, args, {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, JARVIS_DATA_DIR: dataDir },
  })
}
function script(name: string, dataDir: string, args: string[]) {
  return command(process.execPath, ['--experimental-transform-types', join(root, 'scripts', name), ...args], dataDir)
}
function success(result: ReturnType<typeof command>) {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-session-backup-test-'))
  // Only remove the exact temporary directory allocated by this test.
  assert.equal(resolve(dir), dir)
  assert.ok(dir.startsWith(join(tmpdir(), 'jarvis-session-backup-test-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const source = join(dir, 'source')
  const target = join(dir, 'target')
  mkdirSync(source); mkdirSync(target)
  const db = new DatabaseSync(join(source, 'jarvis.db'))
  db.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('backup')")
  db.close()
  return { dir, source, target, archive: join(dir, 'backup.tar.gz') }
}
function sidecars(target: string) {
  for (const name of ['jarvis.db', 'sessions.db']) {
    writeFileSync(join(target, name), `previous ${name}`)
    writeFileSync(join(target, `${name}-wal`), `previous ${name} WAL`)
    writeFileSync(join(target, `${name}-shm`), `previous ${name} SHM`)
  }
}
function bytes(target: string) {
  return Object.fromEntries(readdirSync(target).sort().map(name => [name, readFileSync(join(target, name))]))
}

test('backup snapshots WAL sessions, includes manifest, restores transcripts and saves old DB sidecars', t => {
  const { dir, source, target, archive } = fixture(t)
  const store = new SessionStore({ file: join(source, 'sessions.db'), now: () => 1234 })
  t.after(() => store.close())
  const session = store.create('Roundtrip')
  store.beginTurn(session.id, 'turn-one', 'Question', 'test')
  store.finishTurn('turn-one', { status: 'complete', text: 'Answer', metadata: { test: true } })
  const journal = new ToolJournal(store)
  const key = { sessionId: session.id, turnId: 'turn-one', step: 0 }
  journal.beginStep(key)
  journal.recordAssistant({ ...key, text: '', toolCalls: [{ id: 'call', name: 'read', arguments: '{}' }] })
  journal.startCall({ ...key, callId: 'call', name: 'read', args: {}, definitionHash: 'hash', localOnly: true })
  journal.finishCall({ ...key, callId: 'call', status: 'succeeded', content: 'private source', localOnly: true })
  const expectedCalls = journal.listCalls(session.id)
  const expected = store.exportAll()
  const context = store.contextState(session.id, 'backup-scope')
  const summary = store.saveSummary({ sessionId:session.id,scope:'backup-scope',text:'测试摘要',sourceIds:context.messages.map(m=>m.id),throughMessageId:context.messages.at(-1)!.id,expectedRevision:context.revision })
  assert.ok(existsSync(join(source, 'sessions.db-wal')))
  const memory = new MemoryStore({ file: join(source, 'jarvis.db') })
  const profile = new ProfileStore(memory)
  const entry = profile.saveEntry({ category: 'basic', field: 'city', value: '测试城市', usage: 'local' })
  profile.updateSettings({ learningEnabled: false })
  memory.close()
  const backup = success(script('backup.ts', source, [archive]))
  assert.ok(backup.files.includes('sessions.db'))
  const manifest = command('tar', ['-xOzf', archive, './manifest.json'])
  assert.equal(manifest.status, 0, manifest.stderr)
  assert.ok(JSON.parse(manifest.stdout).files.includes('sessions.db'))
  sidecars(target)
  const previous = bytes(target)
  const restored = success(script('restore.ts', target, [archive, '--yes', '--force']))
  assert.ok(restored.restored.includes('sessions.db'))
  assert.match(restored.sessions, /restored/)
  assert.ok(restored.safety.startsWith(join(dir, 'target.pre-restore-')))
  assert.deepEqual(bytes(restored.safety), previous)
  for (const name of ['jarvis.db', 'sessions.db']) {
    assert.equal(existsSync(join(target, `${name}-wal`)), false)
    assert.equal(existsSync(join(target, `${name}-shm`)), false)
  }
  const reopened = new SessionStore({ file: join(target, 'sessions.db'), now: () => 1234 })
  try {
    assert.deepEqual(new ToolJournal(reopened).listCalls(session.id), expectedCalls)
    assert.deepEqual(reopened.exportAll(), expected)
    assert.deepEqual(reopened.contextState(session.id, 'backup-scope').summary, summary)
  } finally { reopened.close() }
  const restoredMemory = new MemoryStore({ file: join(target, 'jarvis.db') })
  try {
    const restoredProfile = new ProfileStore(restoredMemory).snapshot()
    assert.equal(restoredProfile.entries[0].id, entry.id)
    assert.equal(restoredProfile.entries[0].value, '测试城市')
    assert.equal(restoredProfile.settings.learningEnabled, false)
    assert.match(restoredMemory.get(entry.memoryId)?.content ?? '', /测试城市/)
  } finally { restoredMemory.close() }
})

test('legacy archive preserves existing sessions and sidecars byte for byte with explanatory result', t => {
  const { source, target, archive } = fixture(t)
  const backup = success(script('backup.ts', source, [archive]))
  assert.equal(backup.files.includes('sessions.db'), false)
  const store = new SessionStore({ file: join(target, 'sessions.db') })
  t.after(() => store.close())
  store.create('Keep existing sessions')
  const previous = bytes(target)
  const restored = success(script('restore.ts', target, [archive, '--yes', '--force']))
  assert.equal(restored.restored.includes('sessions.db'), false)
  assert.match(restored.sessions, /Legacy backup.*preserved/)
  for (const [name, data] of Object.entries(previous)) {
    assert.deepEqual(readFileSync(join(target, name)), data)
    assert.deepEqual(readFileSync(join(restored.safety, name)), data)
  }
  assert.equal(store.list().items[0].title, 'Keep existing sessions')
})

test('default backup excludes MCP credentials and restore disables existing MCP config', t => {
  const { source, target, archive } = fixture(t)
  const config = JSON.stringify({ revision: 1, servers: [{ id: 'fixture', enabled: true, transport: 'streamable-http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer synthetic-source-token' } }] })
  const existing = JSON.stringify({ revision: 4, servers: [{ id: 'existing', enabled: true, transport: 'stdio', command: 'node', env: { TOKEN: 'synthetic-existing-token' } }] })
  writeFileSync(join(source, 'mcp-config.json'), config, { mode: 0o600 })
  writeFileSync(join(target, 'mcp-config.json'), existing, { mode: 0o600 })
  const backup = success(script('backup.ts', source, [archive]))
  assert.equal(backup.files.includes('mcp-config.json'), false)
  const listing = command('tar', ['-tzf', archive])
  assert.equal(listing.status, 0, listing.stderr)
  assert.equal(listing.stdout.includes('mcp-config.json'), false)
  const manifest = command('tar', ['-xOzf', archive, './manifest.json'])
  assert.equal(manifest.status, 0, manifest.stderr)
  assert.equal(JSON.parse(manifest.stdout).files.includes('mcp-config.json'), false)
  assert.equal(manifest.stdout.includes('synthetic-source-token'), false)
  const restored = success(script('restore.ts', target, [archive, '--yes', '--force']))
  assert.equal(restored.restored.includes('mcp-config.json'), true)
  const retained = JSON.parse(readFileSync(join(target, 'mcp-config.json'), 'utf8'))
  assert.equal(retained.revision, 5)
  assert.equal(retained.servers[0].enabled, false)
  assert.equal(retained.servers[0].env.TOKEN, 'synthetic-existing-token')
  assert.equal(readFileSync(join(restored.safety, 'mcp-config.json'), 'utf8'), existing)
})

test('explicit secret backup restores MCP credential bytes privately and preserves prior config', t => {
  const { source, target, archive } = fixture(t)
  const config = JSON.stringify({ revision: 9, servers: [
    { id: 'remote-fixture', enabled: true, transport: 'streamable-http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer synthetic-remote-token' } },
    { id: 'local-fixture', enabled: true, transport: 'stdio', command: 'example', env: { TOKEN: 'synthetic-env-token' } },
  ] }, null, 2) + '\n'
  const existing = '{"revision":3,"servers":[]}\n'
  writeFileSync(join(source, 'mcp-config.json'), config, { mode: 0o600 })
  writeFileSync(join(target, 'mcp-config.json'), existing, { mode: 0o600 })
  const backup = success(script('backup.ts', source, [archive, '--include-secrets']))
  assert.ok(backup.files.includes('mcp-config.json'))
  assert.equal(statSync(archive).mode & 0o777, 0o600)
  const packed = command('tar', ['-xOzf', archive, './mcp-config.json'])
  assert.equal(packed.status, 0, packed.stderr)
  assert.equal(packed.stdout, config)
  const manifest = command('tar', ['-xOzf', archive, './manifest.json'])
  assert.equal(manifest.status, 0, manifest.stderr)
  assert.ok(JSON.parse(manifest.stdout).files.includes('mcp-config.json'))
  assert.equal(manifest.stdout.includes('synthetic-remote-token'), false)
  const restored = success(script('restore.ts', target, [archive, '--yes', '--force']))
  assert.ok(restored.restored.includes('mcp-config.json'))
  const restoredConfig = JSON.parse(readFileSync(join(target, 'mcp-config.json'), 'utf8'))
  assert.equal(restoredConfig.revision, 10)
  assert.ok(restoredConfig.servers.every((server: {enabled:boolean}) => server.enabled === false))
  assert.equal(restoredConfig.servers[0].headers.Authorization, 'Bearer synthetic-remote-token')
  assert.equal(restoredConfig.servers[1].env.TOKEN, 'synthetic-env-token')
  assert.equal(statSync(join(target, 'mcp-config.json')).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(restored.safety, 'mcp-config.json'), 'utf8'), existing)
  assert.equal(statSync(restored.safety).mode & 0o777, 0o700)
})

for (const version of [1, 2]) {
  test(`restore accepts v${version} sessions and migrates journal schema on open`, t => {
    const { source, target, archive } = fixture(t)
    const file = join(source, 'sessions.db')
    const store = new SessionStore({ file })
    const session = store.create('Older schema')
    store.close()
    const db = new DatabaseSync(file)
    db.exec('DROP TABLE tool_calls; DROP TABLE tool_steps;')
    if (version === 1) db.exec('DROP TABLE context_revisions; DROP TABLE session_summaries;')
    db.exec(`PRAGMA user_version=${version}`)
    db.close()
    success(script('backup.ts', source, [archive]))
    success(script('restore.ts', target, [archive, '--yes', '--force']))
    const reopened = new SessionStore({ file: join(target, 'sessions.db') })
    try {
      assert.equal(reopened.get(session.id)?.title, 'Older schema')
      assert.equal(reopened.databaseForTools().prepare('PRAGMA user_version').get()!.user_version, 3)
      assert.deepEqual(new ToolJournal(reopened).listCalls(session.id), [])
    } finally { reopened.close() }
  })
}

for (const invalid of ['version', 'schema', 'corruption']) {
  test(`rejects invalid session ${invalid} before destination mutation`, t => {
    const { dir, source, target, archive } = fixture(t)
    const file = join(source, 'sessions.db')
    const store = new SessionStore({ file })
    store.create('Invalid fixture')
    store.close()
    if (invalid !== 'corruption') {
      const db = new DatabaseSync(file)
      db.exec(invalid === 'version' ? 'PRAGMA user_version=999' : 'DROP TABLE messages')
      db.close()
    } else {
      writeFileSync(file, 'not sqlite')
    }
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ product: 'jarvis-v2', files: ['jarvis.db', 'sessions.db'] }))
    const packed = command('tar', ['-czf', archive, '-C', source, '.'])
    assert.equal(packed.status, 0, packed.stderr)
    sidecars(target)
    const previous = bytes(target)
    const restored = script('restore.ts', target, [archive, '--yes', '--force'])
    assert.equal(restored.status, 1)
    assert.match(restored.stderr, invalid === 'version' ? /Unsupported sessions database version/ : invalid === 'schema' ? /SessionStore schema/ : /not a database/)
    assert.deepEqual(bytes(target), previous)
    assert.equal(readdirSync(dir).some(name => name.includes('pre-restore')), false)
  })
}
