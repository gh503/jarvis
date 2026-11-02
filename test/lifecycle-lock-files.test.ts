import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { chmodSync, chownSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, type BigIntStats } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acquireLifecycleLock, acquireVerifiedLifecycleLock } from '../src/runtime-lifecycle.ts'
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

// Inject only one exact pathname's BigIntStats. The real file stays linked;
// this covers defensive metadata rejection, not an actual unlink race.
async function withInjectedStat(target: string, metadata: Pick<BigIntStats, 'nlink'>, check: () => Promise<void>) {
  const mutableFs = fs as { lstatSync: typeof lstatSync }
  const original = mutableFs.lstatSync
  let injections = 0
  try {
    mutableFs.lstatSync = ((...args: Parameters<typeof lstatSync>) => {
      const stat = Reflect.apply(original, fs, args) as BigIntStats
      if (args[0] !== target) return stat
      assert.equal(args[1]?.bigint, true)
      injections++
      // Inherit real mode and the Stats prototype so isFile() still works.
      return Object.assign(Object.create(stat), metadata) as BigIntStats
    }) as typeof lstatSync
    syncBuiltinESMExports()
    await check()
    assert.equal(injections, 1, 'reject during the initial lock-family preflight')
  } finally {
    mutableFs.lstatSync = original
    syncBuiltinESMExports()
  }
}

for (const name of names) {
  for (const suffix of ['', '-journal'] as const) {
    for (const { metadata, reason } of [
      { metadata: { nlink: 0n }, reason: 'links-zero' },
      { metadata: { nlink: -1n }, reason: 'links-invalid' },
    ]) {
      test(`${name}${suffix || ' database'} rejects injected ${reason} metadata without changing SQLite sentinels`, async t => {
        const { data } = fixture(t)
        mkdirSync(data, { mode: 0o755 })
        const main = join(data, `${name}.lock.sqlite`)
        const target = main + suffix
        createDatabase(main)
        if (suffix) createDatabase(target)
        if (process.platform !== 'win32') {
          chmodSync(main, 0o644)
          if (suffix) chmodSync(target, 0o644)
        }
        const mainBefore = snapshot(main)
        const targetBefore = snapshot(target)
        const rootBefore = lstatSync(data, { bigint: true })
        assert.equal(targetBefore.nlink, 1n)
        await withInjectedStat(target, metadata, async () => {
          await assert.rejects(acquireLifecycleLock(data, name), {
            message: `Unsafe lifecycle lock file: ${target} [${reason}]`,
          })
        })
        // Read actual metadata only after restoring the native ESM export.
        assert.deepEqual(snapshot(main), mainBefore)
        assert.deepEqual(snapshot(target), targetBefore)
        const rootAfter = lstatSync(data, { bigint: true })
        assert.equal(rootAfter.mode, rootBefore.mode)
        assert.equal(rootAfter.ctimeNs, rootBefore.ctimeNs)
      })
    }
  }
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
        await assert.rejects(acquireLifecycleLock(data, name), kind === 'hardlink' ? /Unsafe lifecycle lock file: .* \[links-multiple\]$/ : /Unsafe lifecycle lock file: .* \[type\]$/)
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
      await assert.rejects(acquireLifecycleLock(data, name), /Unsafe lifecycle lock file: .* \[type\]$/)
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

test('accepts a cooperating SQLite journal removed and recreated during directory verification', async t => {
  const { data } = fixture(t)
  await ensurePrivateDataDirectory(data)
  const file = join(data, 'runtime.lock.sqlite')
  const journal = `${file}-journal`
  createDatabase(file)
  const main = lstatSync(file, { bigint: true })
  const owner = new DatabaseSync(file)
  const checkJournal = () => {
    const stat = lstatSync(journal, { bigint: true })
    assert.equal(stat.isFile(), true)
    assert.equal(stat.nlink, 1n)
    if (process.platform !== 'win32') assert.equal(stat.uid, BigInt(process.getuid!()))
  }
  try {
    owner.exec("BEGIN IMMEDIATE; INSERT INTO sentinel VALUES ('first transaction')")
    checkJournal()
    let verified = false
    const release = await acquireVerifiedLifecycleLock(data, 'runtime', async () => {
      // The initial lock-family preflight has already observed the live journal.
      await ensurePrivateDataDirectory(data)
      owner.exec('COMMIT')
      assert.throws(() => lstatSync(journal), { code: 'ENOENT' })
      owner.exec("BEGIN IMMEDIATE; INSERT INTO sentinel VALUES ('second transaction')")
      checkJournal()
      owner.exec('COMMIT')
      assert.throws(() => lstatSync(journal), { code: 'ENOENT' })
      verified = true
    })
    try {
      assert.equal(verified, true)
      assert.equal(lstatSync(file, { bigint: true }).ino, main.ino)
      await assert.rejects(acquireLifecycleLock(data, 'runtime'), /already owns/)
    } finally { release() }
    const rows = owner.prepare('SELECT value FROM sentinel').all()
    assert.equal(rows.length, 3)
  } finally { owner.close() }
})

test('rejects a POSIX lock owned by another account before chmod', { skip: process.platform === 'win32' || process.getuid?.() !== 0 }, async t => {
  const { data } = fixture(t)
  mkdirSync(data)
  const file = join(data, 'runtime.lock.sqlite')
  createDatabase(file)
  chownSync(file, 65534, 65534)
  const before = snapshot(file)
  await assert.rejects(acquireLifecycleLock(data, 'runtime'), /Unsafe lifecycle lock file: .* \[owner\]$/)
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
