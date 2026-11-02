import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, chmod, writeFile, readFile, stat, lstat, readdir, link, symlink, truncate, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createStateSnapshot, verifyStateSnapshot, restoreStateSnapshot, STATE_SNAPSHOT_LIMITS } from '../scripts/native-state-snapshot.ts'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'state-snapshot-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data'); await ensurePrivateDataDirectory(dataDir)
  return { root, dataDir, destination: join(root, 'snapshot') }
}
const missing = async (path: string) => assert.rejects(lstat(path), { code: 'ENOENT' })

test('raw stopped SQLite WAL, secrets, nested lock names, and empty directories survive restore', async t => {
  const f = await fixture(t)
  await mkdir(join(f.dataDir, 'empty'))
  await mkdir(join(f.dataDir, 'nested'))
  await writeFile(join(f.dataDir, 'nested', 'runtime.lock.sqlite'), 'user-owned nested file', { mode: 0o600 })
  await writeFile(join(f.dataDir, 'secrets.json'), '{"token":"super-secret"}', { mode: 0o600 })
  await writeFile(join(f.dataDir, 'runtime-instance.json'), 'ephemeral', { mode: 0o600 })
  await writeFile(join(f.dataDir, 'legacyapp.pid'), '123', { mode: 0o600 })
  // Abrupt child exit retains actual SQLite WAL and SHM without an open writer.
  for (const name of ['memory.sqlite', 'jobs.sqlite', 'state.sqlite']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('wal-secret')"); process.exit(0)`, join(f.dataDir, name)], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    assert.ok((await stat(join(f.dataDir, `${name}-wal`))).size > 0)
  }
  const created = await createStateSnapshot(f)
  assert.equal(created.manifest.schemaVersion, 1)
  assert.deepEqual(created.manifest.directories, ['empty', 'nested'])
  assert.ok(!JSON.stringify(created.manifest).includes('super-secret'))
  assert.ok(created.manifest.files.some(x => x.path === 'legacyapp.pid'))
  for (const entry of created.manifest.files) assert.deepEqual(await readFile(join(f.destination, 'payload', entry.path)), await readFile(join(f.dataDir, entry.path)))
  await missing(join(f.destination, 'payload', 'runtime-instance.json'))
  await verifyStateSnapshot(created)
  const restored = join(f.root, 'restored')
  await restoreStateSnapshot({ ...created, destination: restored })
  assert.deepEqual(await readdir(join(restored, 'empty')), [])
  assert.equal(await readFile(join(restored, 'secrets.json'), 'utf8'), '{"token":"super-secret"}')
  await missing(join(restored, 'runtime.lock.sqlite'))
  for (const name of ['memory.sqlite', 'jobs.sqlite', 'state.sqlite']) {
    const db = new DatabaseSync(join(restored, name)); try { assert.equal((db.prepare('SELECT value FROM retained').get() as { value: string }).value, 'wal-secret') } finally { db.close() }
  }
  if (process.platform !== 'win32') {
    assert.equal((await stat(restored)).mode & 0o777, 0o700)
    assert.equal((await stat(join(restored, 'secrets.json'))).mode & 0o777, 0o600)
  }
  // Restoring/opening copies must not checkpoint or alter production WAL bytes.
  for (const entry of created.manifest.files) assert.equal(createHash('sha256').update(await readFile(join(f.dataDir, entry.path))).digest('hex'), entry.sha256)
})

for (const lock of ['runtime', 'launcher'] as const) test(`active ${lock} lock prevents destination creation`, async t => {
  const f = await fixture(t), release = await acquireLifecycleLock(f.dataDir, lock, 0)
  try { await assert.rejects(createStateSnapshot(f), /owns|launcher/); await missing(f.destination) } finally { release() }
  await createStateSnapshot(f)
})

test('rejects existing, overlapping, noncanonical and missing roots before copying', async t => {
  const f = await fixture(t)
  await assert.rejects(createStateSnapshot({ ...f, destination: f.dataDir }), /overlap/)
  await assert.rejects(createStateSnapshot({ ...f, destination: join(f.dataDir, 'child') }), /overlap/)
  await assert.rejects(createStateSnapshot({ ...f, destination: f.root }), /overlap/)
  await mkdir(f.destination)
  await assert.rejects(createStateSnapshot(f), /exists/)
  await assert.rejects(createStateSnapshot({ dataDir: join(f.root, 'absent'), destination: join(f.root, 'another') }))
  await missing(join(f.root, 'absent'))
  await assert.rejects(createStateSnapshot({ ...f, dataDir: `${f.dataDir}/../data` }), /canonical/)
})

for (const alteration of ['tamper', 'truncate', 'extra-file', 'extra-directory', 'extra-root', 'manifest', 'hardlink'] as const) test(`verifier and restore reject ${alteration} before destination writes`, async t => {
  const f = await fixture(t)
  await writeFile(join(f.dataDir, 'file'), 'original')
  const created = await createStateSnapshot(f), payload = join(f.destination, 'payload')
  if (alteration === 'tamper') await writeFile(join(payload, 'file'), 'modified')
  if (alteration === 'truncate') await truncate(join(payload, 'file'), 2)
  if (alteration === 'extra-file') await writeFile(join(payload, 'extra'), '')
  if (alteration === 'extra-directory') await mkdir(join(payload, 'extra'))
  if (alteration === 'extra-root') await writeFile(join(f.destination, 'extra'), '')
  if (alteration === 'manifest') await writeFile(join(f.destination, 'snapshot-manifest.json'), '{}')
  if (alteration === 'hardlink') await link(join(payload, 'file'), join(f.root, 'alias'))
  await assert.rejects(verifyStateSnapshot(created))
  const destination = join(f.root, 'restore'); await assert.rejects(restoreStateSnapshot({ ...created, destination })); await missing(destination)
})

test('rejects links and hardlinked lock files before lock acquisition', async t => {
  const f = await fixture(t)
  const original = join(f.root, 'outside'); await writeFile(original, 'not sqlite')
  await link(original, join(f.dataDir, 'runtime.lock.sqlite'))
  await assert.rejects(createStateSnapshot(f), /links/)
  assert.equal(await readFile(original, 'utf8'), 'not sqlite'); await missing(f.destination)
})

test('rejects directory symlink boundary and payload links', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const alias = join(f.root, 'alias'); await symlink(f.dataDir, alias)
  await assert.rejects(createStateSnapshot({ ...f, dataDir: alias }), /links/)
  await writeFile(join(f.dataDir, 'file'), 'data')
  const created = await createStateSnapshot(f)
  await symlink(join(f.dataDir, 'file'), join(f.destination, 'payload', 'link'))
  await assert.rejects(verifyStateSnapshot(created), /Links/)
})

for (const name of ['a:b', 'back\\slash', 'tail.', 'CON', 'control\x01']) test(`rejects unsafe name ${JSON.stringify(name)}`, { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await writeFile(join(f.dataDir, name), '')
  await assert.rejects(createStateSnapshot(f), /Unsafe/); await missing(f.destination)
})

test('rejects Unicode normalization and case collisions', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t)
  await writeFile(join(f.dataDir, 'é'), ''); await writeFile(join(f.dataDir, 'e\u0301'), '')
  await assert.rejects(createStateSnapshot(f), /collision/)
})

test('rejects malformed UTF8 file names', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t)
  await writeFile(Buffer.concat([Buffer.from(f.dataDir + '/'), Buffer.from([0xff])]), '')
  await assert.rejects(createStateSnapshot(f))
})

test('rejects depth and sparse file size limits without unbounded reads', async t => {
  const f = await fixture(t)
  let cursor = f.dataDir
  for (let i = 0; i < STATE_SNAPSHOT_LIMITS.depth + 1; i++) { cursor = join(cursor, 'd'); await mkdir(cursor) }
  await assert.rejects(createStateSnapshot(f), /depth/)
  // Windows truncate may allocate real storage; its size validation is covered
  // by the pinned-manifest fixture instead of creating a 16 GiB file on CI.
  if (process.platform === 'win32') return
  const second = join(f.root, 'second'); await ensurePrivateDataDirectory(second)
  const huge = join(second, 'huge'); await writeFile(huge, ''); await truncate(huge, STATE_SNAPSHOT_LIMITS.fileBytes + 1)
  await assert.rejects(createStateSnapshot({ dataDir: second, destination: f.destination }), /size limit/)
})

test('rejects pinned malformed manifests and manifest size limit', async t => {
  const f = await fixture(t), created = await createStateSnapshot(f), path = join(f.destination, 'snapshot-manifest.json')
  async function reject(bytes: Buffer) {
    await writeFile(path, bytes)
    await assert.rejects(verifyStateSnapshot({ snapshot: f.destination, manifestSha256: createHash('sha256').update(bytes).digest('hex') }))
  }
  await reject(Buffer.from(JSON.stringify({ ...created.manifest, directories: ['../escape'] }) + '\n'))
  await reject(Buffer.from(JSON.stringify({ ...created.manifest, directories: ['empty', 'empty'] }) + '\n'))
  await reject(Buffer.from(JSON.stringify({ ...created.manifest, files: [{ path: 'huge', bytes: STATE_SNAPSHOT_LIMITS.fileBytes + 1, sha256: 'a'.repeat(64) }] }) + '\n'))
  await reject(Buffer.from(JSON.stringify({ ...created.manifest, files: Array.from({ length: 5 }, (_, i) => ({ path: `file${i}`, bytes: STATE_SNAPSHOT_LIMITS.fileBytes, sha256: 'a'.repeat(64) })) }) + '\n'))
  await reject(Buffer.from(JSON.stringify({ ...created.manifest, directories: Array.from({ length: STATE_SNAPSHOT_LIMITS.files + 1 }, (_, i) => `dir${i}`) }) + '\n'))
  await reject(Buffer.from('{"schemaVersion":1,"schemaVersion":1}'))
  await reject(Buffer.from([0xff]))
  await writeFile(path, ''); await truncate(path, STATE_SNAPSHOT_LIMITS.manifestBytes + 1)
  await assert.rejects(verifyStateSnapshot(created), /size limit/)
})

test('verification rejects shared permissions without changing them', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await writeFile(join(f.dataDir, 'file'), 'secret')
  const created = await createStateSnapshot(f), file = join(f.destination, 'payload', 'file')
  await chmod(file, 0o644)
  await assert.rejects(verifyStateSnapshot(created), /private/)
  assert.equal((await stat(file)).mode & 0o777, 0o644)
  await chmod(file, 0o600); await chmod(f.destination, 0o755)
  await assert.rejects(verifyStateSnapshot(created), /private/)
  assert.equal((await stat(f.destination)).mode & 0o777, 0o755)
})

test('Windows verification rejects shared ACL without repairing it', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await writeFile(join(f.dataDir, 'file'), 'secret')
  const created = await createStateSnapshot(f), file = join(f.destination, 'payload', 'file')
  const tool = join(process.env.SystemRoot!, 'System32', 'icacls.exe')
  const grant = spawnSync(tool, [file, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8' })
  assert.equal(grant.status, 0, grant.stderr)
  const before = spawnSync(tool, [file], { encoding: 'utf8' }); assert.equal(before.status, 0)
  await assert.rejects(verifyStateSnapshot(created))
  const after = spawnSync(tool, [file], { encoding: 'utf8' }); assert.equal(after.status, 0)
  assert.equal(after.stdout, before.stdout)
})

test('restore refuses overwrite and production overlap', async t => {
  const f = await fixture(t); await writeFile(join(f.dataDir, 'secret'), 'keep')
  const created = await createStateSnapshot(f)
  await assert.rejects(restoreStateSnapshot({ ...created, destination: f.dataDir }), /overlap/)
  await assert.rejects(restoreStateSnapshot({ ...created, destination: join(f.dataDir, 'child') }), /overlap/)
  await assert.rejects(restoreStateSnapshot({ ...created, destination: join(f.destination, 'child') }), /overlap/)
  const existing = join(f.root, 'existing'); await mkdir(existing)
  await assert.rejects(restoreStateSnapshot({ ...created, destination: existing }), /exists/)
  assert.equal(await readFile(join(f.dataDir, 'secret'), 'utf8'), 'keep')
})
