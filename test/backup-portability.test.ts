import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { Header } from 'tar'
import { archivePath, extractBackup, remapPrivatePath } from '../scripts/backup-archive.ts'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-portable-backup-'))
  assert.ok(resolve(dir).startsWith(join(tmpdir(), 'jarvis-portable-backup-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
function tar(entries: Array<{ path: string; type?: 'File' | 'Directory' | 'SymbolicLink' | 'Link'; content?: string; linkpath?: string; size?: number }>) {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.content ?? '')
    const header = new Header({ ...entry, type: entry.type ?? 'File', size: entry.size ?? body.length, mode: 0o600 })
    header.encode(); chunks.push(header.block!, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]))
}

test('portable namespace rejects traversal, drives, ADS, devices and ambiguous components', () => {
  for (const path of ['../escape', 'artifacts/../escape', 'artifacts\\..\\escape', 'C:/escape', '//host/share', '/tmp/escape', 'artifacts/x:y', 'artifacts/NUL.txt', 'artifacts/a.', 'artifacts/a ', 'artifacts//a', 'artifacts/./a', 'artifacts/a\n']) assert.throws(() => archivePath(path), /unsafe entry/)
  assert.equal(archivePath('./artifacts/测试 space.txt'), 'artifacts/测试 space.txt')
  assert.equal(remapPrivatePath('C:\\old\\artifacts\\a.txt', 'C:\\old\\artifacts', '/new'), join('/new', 'a.txt'))
  for (const path of ['C:\\old\\outside.txt', 'D:\\old\\artifacts\\a.txt']) assert.equal(remapPrivatePath(path, 'C:\\old\\artifacts', '/new'), path)
})

test('hostile tar entries fail before extraction, including links and case aliases', async t => {
  const dir = await fixture(t), archive = join(dir, 'bad.tgz'), output = join(dir, 'output')
  await mkdir(output)
  const cases: Parameters<typeof tar>[0][] = [
    [{ path: '../escape' }], [{ path: 'artifacts\\..\\escape' }],
    [{ path: 'artifacts/link', type: 'SymbolicLink', linkpath: '../escape' }],
    [{ path: 'artifacts/link', type: 'Link', linkpath: 'jarvis.db' }],
    [{ path: 'artifacts/A' }, { path: 'artifacts/a' }],
    [{ path: 'artifacts/a' }, { path: 'artifacts/a/b' }],
    [{ path: 'artifacts/a' }, { path: 'artifacts/a' }],
    [{ path: 'runtime.lock.sqlite' }], [{ path: 'runtime-instance.json' }],
    [{ path: 'artifacts/CON' }], [{ path: 'artifacts/a:stream' }],
  ]
  for (const entries of cases) {
    await writeFile(archive, tar(entries))
    await assert.rejects(extractBackup(archive, output), /unsafe entry/)
    assert.deepEqual(await readdir(output), [])
  }
})

test('backup and restore work without PATH tools; live ownership cannot be forced and lock inode persists', async t => {
  const dir = await fixture(t), source = join(dir, 'source'), target = join(dir, 'target'), archive = join(dir, 'backup.tgz')
  await ensurePrivateDataDirectory(source); await ensurePrivateDataDirectory(target)
  const db = new DatabaseSync(join(source, 'jarvis.db')); db.exec('CREATE TABLE marker(value TEXT)'); db.close()
  const run = (name: string, data: string, ...args: string[]) => spawnSync(process.execPath, ['--experimental-transform-types', resolve(import.meta.dirname, '..', 'scripts', `${name}.ts`), ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: '', JARVIS_DATA_DIR: data } })
  let release = await acquireLifecycleLock(source, 'runtime')
  try { assert.notEqual(run('backup', source, archive).status, 0) } finally { release() }
  assert.equal(run('backup', source, archive).status, 0)
  assert.notEqual(run('backup', source, join(source, 'runtime.lock.sqlite')).status, 0)
  const marker = join(target, 'jarvis.db'); await writeFile(marker, 'untouched')
  release = await acquireLifecycleLock(target, 'runtime')
  const lock = join(target, 'runtime.lock.sqlite'), inode = (await stat(lock)).ino
  try {
    for (const flags of [['--yes'], ['--yes', '--force']]) {
      const result = run('restore', target, archive, ...flags)
      assert.notEqual(result.status, 0); assert.match(result.stderr, /owns this data directory/)
      assert.equal(await readFile(marker, 'utf8'), 'untouched')
    }
  } finally { release() }
  const restored = run('restore', target, archive, '--yes', '--force')
  assert.equal(restored.status, 0, restored.stderr)
  assert.equal((await stat(lock)).ino, inode)
  const safety = JSON.parse(restored.stdout).safety
  assert.equal((await readdir(safety)).includes('runtime.lock.sqlite'), false)
})
