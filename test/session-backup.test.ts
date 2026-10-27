import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { SessionStore } from '../src/sessions.ts'
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
  const expected = store.exportAll()
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
  try { assert.deepEqual(reopened.exportAll(), expected) } finally { reopened.close() }
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
