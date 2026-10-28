import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { TaskTools } from '../src/local-tools/tasks.ts'
import { EventBus } from '../src/events.ts'

const root = resolve(import.meta.dirname, '..')
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-local-backup-'))
  assert.equal(resolve(dir), dir)
  assert.ok(dir.startsWith(join(tmpdir(), 'jarvis-local-backup-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const source = join(dir, 'source'), target = join(dir, 'target'), archive = join(dir, 'backup.tgz')
  mkdirSync(source, { mode: 0o700 }); mkdirSync(target, { mode: 0o700 })
  const db = new DatabaseSync(join(source, 'jarvis.db')); db.exec('CREATE TABLE marker(value TEXT)'); db.close()
  const run = (script: string, ...args: string[]) => spawnSync(process.execPath, ['--experimental-transform-types', join(root, 'scripts', script + '.ts'), ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env, JARVIS_DATA_DIR: script === 'backup' ? source : target } })
  return { dir, source, target, archive, run }
}
function success(value: ReturnType<typeof spawnSync>) { assert.equal(value.status, 0, String(value.stderr)); return JSON.parse(String(value.stdout)) }

test('private local state roundtrips with permissions revoked, paths remapped and tasks interrupted', async t => {
  const { dir, source, target, archive, run } = fixture(t)
  const outputDir = join(source, 'artifacts')
  const settings = { revision: 4, readRoots: [dir], writeRoots: [dir], outputDir, shellEnabled: true, webEnabled: true, skillsDir: dir }
  for (const name of ['artifacts', 'file-history', 'task-output']) mkdirSync(join(source, name))
  writeFileSync(join(source, 'local-tools.json'), JSON.stringify(settings))
  const external = join(dir, 'external.txt'); writeFileSync(external, 'external stays outside backup')
  writeFileSync(join(outputDir, 'with spaces.txt'), 'private generated text')
  writeFileSync(join(source, 'local-files.json'), JSON.stringify([{ path: join(outputDir, 'with spaces.txt'), managed: true }, { path: external, managed: false }]))
  writeFileSync(join(source, 'file-history', 'record.json'), JSON.stringify({ path: join(outputDir, 'with spaces.txt'), content: 'old private text' }))
  const tasks = new TaskTools({ file: join(source, 'local-tasks.db'), bus: new EventBus(), settings: { snapshot: () => settings } }); await tasks.close()
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const db = new DatabaseSync(join(source, 'local-tasks.db'))
  db.exec('PRAGMA journal_mode=WAL')
  db.prepare('INSERT INTO questions VALUES(?,?,?,?,?,NULL,?,?,?)').run('q', 's', 't', 'c', 'private question', 'pending', 999, 1)
  db.prepare('INSERT INTO jobs(id,session_id,turn_id,call_id,command,workdir,status,pid,spill,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, 's', 't', 'c', 'echo private', outputDir, 'running', 123, join(source, 'task-output', id + '.log'), 1, 1)
  t.after(() => db.close())
  writeFileSync(join(source, 'task-output', id + '.log'), 'private output')
  const packed = success(run('backup', archive)); assert.ok(packed.files.includes('local-tasks.db'))
  const restored = success(run('restore', archive, '--yes', '--force'))
  assert.ok(restored.restored.includes('file-history'))
  assert.deepEqual(JSON.parse(readFileSync(join(target, 'local-tools.json'), 'utf8')), { revision: 0, readRoots: [], writeRoots: [], outputDir: join(target, 'artifacts'), webEnabled: false, shellEnabled: false, skillsDir: null })
  const catalog = JSON.parse(readFileSync(join(target, 'local-files.json'), 'utf8'))
  assert.equal(catalog[0].path, join(target, 'artifacts', 'with spaces.txt')); assert.equal(catalog[1].path, external)
  assert.equal(readFileSync(catalog[0].path, 'utf8'), 'private generated text')
  assert.equal(existsSync(join(target, 'external.txt')), false)
  assert.equal(JSON.parse(readFileSync(join(target, 'file-history', 'record.json'), 'utf8')).path, catalog[0].path)
  const check = new DatabaseSync(join(target, 'local-tasks.db'))
  try { assert.equal(check.prepare('SELECT status FROM questions').get()!.status, 'cancelled'); const row = check.prepare('SELECT * FROM jobs').get()!; assert.equal(row.status, 'interrupted'); assert.equal(row.pid, null); assert.equal(row.spill, join(target, 'task-output', id + '.log')) } finally { check.close() }
  assert.equal(statSync(join(target, 'task-output', id + '.log')).mode & 0o777, 0o600)
})

test('rejects symlink entries in newly allowed private directories before restore', t => {
  const { dir, source, target, archive, run } = fixture(t)
  mkdirSync(join(source, 'artifacts'))
  symlinkSync(dir, join(source, 'artifacts', 'escape'))
  writeFileSync(join(source, 'manifest.json'), JSON.stringify({ product: 'jarvis-v2' }))
  const tar = spawnSync('tar', ['-czf', archive, '-C', source, '.'], { encoding: 'utf8' }); assert.equal(tar.status, 0, tar.stderr)
  const result = run('restore', archive, '--yes', '--force')
  assert.equal(result.status, 1); assert.match(result.stderr, /unsafe entry/)
  assert.equal(existsSync(join(target, 'jarvis.db')), false)
})
