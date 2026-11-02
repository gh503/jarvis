import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, chownSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'

const names = ['runtime', 'launcher'] as const
const suffixes = ['', '-journal', '-wal', '-shm'] as const

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'jarvis lock files '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, data: join(root, 'data') }
}

function createDatabase(file: string) {
  const db = new DatabaseSync(file)
  try { db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('outside must not change')") }
  finally { db.close() }
}

function snapshot(file: string) {
  const { dev, ino, nlink, mode, uid, gid, size, mtimeNs, ctimeNs } = lstatSync(file, { bigint: true })
  return { dev, ino, nlink, mode, uid, gid, size, mtimeNs, ctimeNs, bytes: readFileSync(file) }
}

for (const kind of ['hardlink', 'symlink'] as const) {
  for (const name of names) {
    for (const suffix of suffixes) {
      test(`${name}${suffix || ' database'} rejects ${kind} without changing outside SQLite sentinel`, async t => {
        const { root, data } = fixture(t)
        // An unsafe file must be rejected before even the root permission migration.
        mkdirSync(data, { mode: 0o755 })
        const outside = join(root, 'outside.sqlite')
        createDatabase(outside)
        if (process.platform !== 'win32') chmodSync(outside, 0o644)
        const target = join(data, `${name}.lock.sqlite${suffix}`)
        if (suffix) createDatabase(join(data, `${name}.lock.sqlite`))
        try {
          if (kind === 'hardlink') linkSync(outside, target)
          else symlinkSync(outside, target, 'file')
        } catch (error) {
          if (kind === 'symlink' && process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
            t.skip('Windows account cannot create symlinks')
            return
          }
          throw error
        }
        const before = snapshot(outside)
        const rootBefore = lstatSync(data, { bigint: true })
        const linkBefore = lstatSync(target, { bigint: true })
        await assert.rejects(acquireLifecycleLock(data, name), /Unsafe lifecycle lock file/)
        assert.deepEqual(snapshot(outside), before)
        const rootAfter = lstatSync(data, { bigint: true })
        assert.equal(rootAfter.mode, rootBefore.mode)
        assert.equal(rootAfter.ctimeNs, rootBefore.ctimeNs)
        const linkAfter = lstatSync(target, { bigint: true })
        assert.equal(linkAfter.ino, linkBefore.ino)
        assert.equal(linkAfter.dev, linkBefore.dev)
        assert.equal(linkAfter.ctimeNs, linkBefore.ctimeNs)
      })
    }
  }
}

for (const name of names) {
  for (const suffix of suffixes) {
    test(`${name}${suffix || ' database'} rejects nonregular files`, async t => {
      const { data } = fixture(t)
      mkdirSync(data)
      mkdirSync(join(data, `${name}.lock.sqlite${suffix}`))
      await assert.rejects(acquireLifecycleLock(data, name), /Unsafe lifecycle lock file/)
    })
  }

  test(`${name} creates an absent private root and preserves lock inode and exclusion`, async t => {
    const { data } = fixture(t)
    const release = await acquireLifecycleLock(data, name)
    const file = join(data, `${name}.lock.sqlite`)
    const before = lstatSync(file, { bigint: true })
    try {
      await assert.rejects(acquireLifecycleLock(data, name), name === 'runtime' ? /already owns/ : /Another launcher/)
      assert.equal(lstatSync(file, { bigint: true }).ino, before.ino)
    } finally { release(); release() }
    const next = await acquireLifecycleLock(data, name)
    next()
    const after = lstatSync(file, { bigint: true })
    assert.equal(after.ino, before.ino)
    assert.equal(after.dev, before.dev)
    assert.equal(after.nlink, 1n)
    if (process.platform !== 'win32') assert.equal(after.mode & 0o777n, 0o600n)
  })

  test(`${name} keeps a valid legacy database and tightens its permissions`, async t => {
    const { data } = fixture(t)
    await ensurePrivateDataDirectory(data)
    const file = join(data, `${name}.lock.sqlite`)
    createDatabase(file)
    if (process.platform !== 'win32') chmodSync(file, 0o644)
    const before = snapshot(file)
    const release = await acquireLifecycleLock(data, name)
    release()
    const after = snapshot(file)
    assert.equal(after.ino, before.ino)
    assert.equal(after.dev, before.dev)
    assert.deepEqual(after.bytes, before.bytes)
    if (process.platform !== 'win32') assert.equal(after.mode & 0o777n, 0o600n)
  })
}

test('waits for a live SQLite writer whose journal disappears on commit', async t => {
  const { data } = fixture(t)
  await ensurePrivateDataDirectory(data)
  const file = join(data, 'runtime.lock.sqlite')
  createDatabase(file)
  const owner = new DatabaseSync(file)
  try {
    owner.exec("BEGIN IMMEDIATE; INSERT INTO sentinel VALUES ('live owner')")
    assert.equal(lstatSync(`${file}-journal`).isFile(), true)
    const timer = setTimeout(() => owner.exec('COMMIT'), 150)
    try {
      const release = await acquireLifecycleLock(data, 'runtime', 2000)
      release()
    } finally { clearTimeout(timer) }
  } finally { owner.close() }
})

test('rejects a POSIX lock owned by another account before chmod', { skip: process.platform === 'win32' || process.getuid?.() !== 0 }, async t => {
  const { data } = fixture(t)
  mkdirSync(data)
  const file = join(data, 'runtime.lock.sqlite')
  createDatabase(file)
  chownSync(file, 65534, 65534)
  const before = snapshot(file)
  await assert.rejects(acquireLifecycleLock(data, 'runtime'), /Unsafe lifecycle lock file/)
  assert.deepEqual(snapshot(file), before)
})

for (const failAt of ['PRAGMA busy_timeout=0', 'BEGIN IMMEDIATE']) {
  test(`closes the database exactly once when ${failAt} fails`, async t => {
    const { data } = fixture(t)
    const exec = DatabaseSync.prototype.exec
    const close = DatabaseSync.prototype.close
    let closes = 0
    t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      if (sql === failAt) throw new Error('injected SQLite setup failure')
      return exec.call(this, sql)
    })
    t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) { closes++; return close.call(this) })
    await assert.rejects(acquireLifecycleLock(data, 'runtime'), error => String(error).includes('injected SQLite setup failure') || String((error as Error).cause).includes('injected SQLite setup failure'))
    assert.equal(closes, 1)
  })
}

test('release remains closed even when SQLite close throws', async t => {
  const { data } = fixture(t)
  const close = DatabaseSync.prototype.close
  let closes = 0
  t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) {
    closes++
    close.call(this)
    throw new Error('injected close failure')
  })
  const release = await acquireLifecycleLock(data, 'runtime')
  assert.throws(release, /injected close failure/)
  release()
  assert.equal(closes, 1)
})

test('post-BEGIN sidecar validation failure closes the acquired database', async t => {
  const { root, data } = fixture(t)
  const outside = join(root, 'outside.sqlite')
  createDatabase(outside)
  const exec = DatabaseSync.prototype.exec
  const close = DatabaseSync.prototype.close
  let closes = 0
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    exec.call(this, sql)
    if (sql === 'BEGIN IMMEDIATE') linkSync(outside, join(data, 'runtime.lock.sqlite-shm'))
  })
  t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) { closes++; return close.call(this) })
  await assert.rejects(acquireLifecycleLock(data, 'runtime'), /Unsafe lifecycle lock file/)
  assert.equal(closes, 1)
})
