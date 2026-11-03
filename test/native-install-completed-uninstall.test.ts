import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import nodeTest, { type TestContext, type TestFn, type TestOptions } from 'node:test'
import { completedFixture } from './fixtures/native-install-completed-uninstall.ts'
import { uninstallCompletedNativeInstallTransaction } from '../scripts/native-install-completed-uninstall.ts'
import { readNativeInstallTransactionAckSnapshot, writeNativeInstallTransactionAck } from '../scripts/native-install-transaction-ack-store.ts'
import { createNativeInstallTransactionAck } from '../scripts/native-install-transaction-ack.ts'
import { readNativeInstallTransactionCompletionSnapshot } from '../scripts/native-install-transaction-completion-store.ts'
import { isPublicFile } from '../scripts/packaging.ts'

const partitionValue = process.env.JARVIS_TEST_UNINSTALL_PARTITION
if (partitionValue !== undefined && !['0', '1', '2', '3', '4', '5', '6', '7'].includes(partitionValue)) throw new Error('JARVIS_TEST_UNINSTALL_PARTITION must be 0, 1, 2, 3, 4, 5, 6 or 7')
const partition = partitionValue === undefined ? undefined : Number(partitionValue)
let registrations = 0
function test(name: string, fn: TestFn): void
function test(name: string, options: TestOptions, fn: TestFn): void
function test(name: string, optionsOrFn: TestOptions | TestFn, fn?: TestFn): void {
  const index = registrations++
  if (partition !== undefined && index % 8 !== partition) return
  void nodeTest(name, { ...(typeof optionsOrFn === 'function' ? {} : optionsOrFn), concurrency: false }, typeof optionsOrFn === 'function' ? optionsOrFn : fn!)
}
async function snapshot(path: string): Promise<unknown> {
  const stat = await fs.lstat(path, { bigint: true })
  if (stat.isDirectory()) return Promise.all((await fs.readdir(path)).sort().filter(name => !name.startsWith('launcher.lock.sqlite')).map(async name => [name, await snapshot(join(path, name))]))
  return { bytes: await fs.readFile(path), ino: stat.ino, mode: stat.mode, nlink: stat.nlink, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs }
}
async function fixture(t: TestContext, platform: 'darwin' | 'win32') {
  const temporary = await fs.realpath(tmpdir())
  const root = await fs.mkdtemp(join(temporary, 'completed-uninstall-'))
  t.after(async () => { assert.equal(dirname(root), temporary); assert.ok(root.startsWith(join(temporary, 'completed-uninstall-'))); await fs.rm(root, { recursive: true, force: true }) })
  return completedFixture(root, platform)
}
for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: concurrent uninstallers archive exactly one generation`, async t => {
    const f = await fixture(t, platform)
    const lock = join(f.directory, 'launcher.lock.sqlite')
    const inode = (await fs.lstat(lock, { bigint: true })).ino
    const names = (await fs.readdir(f.directory)).filter(name => name.startsWith('prepared-'))
    const records = await Promise.all(names.map(async name => ({ name, bytes: await fs.readFile(join(f.directory, name)) })))
    const results = await Promise.allSettled([uninstallCompletedNativeInstallTransaction(f), uninstallCompletedNativeInstallTransaction(f)])
    const successes = results.filter(result => result.status === 'fulfilled')
    assert.equal(successes.length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    const archive = successes[0]!.value.archiveDirectory
    assert.deepEqual(successes[0]!.value.removedPaths, [...f.artifacts.map(a => a.path), f.receiptPath])
    for (const record of records) assert.deepEqual(await fs.readFile(join(archive, record.name)), record.bytes)
    assert.equal((await fs.lstat(lock, { bigint: true })).ino, inode)
    const remaining = await fs.readdir(f.directory)
    assert.equal(remaining.filter(name => name.startsWith('retired-')).length, 1)
    assert.equal(remaining.some(name => name.toLowerCase().startsWith('prepared-')), false)
    for (const path of [...f.artifactPaths, f.receiptPath]) await assert.rejects(fs.lstat(path), { code: 'ENOENT' })
  })
  test(`${platform}: exact generation archives records and preserves unrelated files and lock inode`, async t => {
    const f = await fixture(t, platform)
    const keep = [join(f.integration.root, 'payload'), join(f.root, 'config'), join(f.root, 'data', 'payload')]
    for (const path of keep) { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, 'preserve') }
    const lock = join(f.directory, 'launcher.lock.sqlite')
    const inode = (await fs.lstat(lock, { bigint: true })).ino
    const names = (await fs.readdir(f.directory)).filter(name => name.startsWith('prepared-'))
    const before = await Promise.all(names.map(async name => ({ name, bytes: await fs.readFile(join(f.directory, name)), stat: await fs.lstat(join(f.directory, name), { bigint: true }) })))
    const result = await uninstallCompletedNativeInstallTransaction(f)
    assert.equal(result.transactionId, f.transactionId)
    assert.deepEqual(result.removedPaths, [...f.artifacts.map(a => a.path), f.receiptPath])
    assert.deepEqual((await fs.readdir(result.archiveDirectory)).sort(), [...names, 'manifest.json'].sort())
    for (const record of before) { assert.deepEqual(await fs.readFile(join(result.archiveDirectory, record.name)), record.bytes); assert.equal((await fs.lstat(join(result.archiveDirectory, record.name), { bigint: true })).ino, record.stat.ino) }
    assert.equal((await fs.lstat(lock, { bigint: true })).ino, inode)
    for (const path of keep) assert.equal(await fs.readFile(path, 'utf8'), 'preserve')
    for (const path of [...f.artifactPaths, f.receiptPath]) await assert.rejects(fs.lstat(path), { code: 'ENOENT' })
    if (platform === 'darwin') await assert.rejects(fs.lstat(join(f.integration.home, 'Applications', 'Jarvis.app')), { code: 'ENOENT' })
    await assert.rejects(uninstallCompletedNativeInstallTransaction(f))
  })
  for (const scenario of ['wrong-id', 'wrong-root', 'missing-completion', 'bad-completion', 'missing-ack', 'bad-ack', 'missing-receipt', 'bad-receipt', 'missing-artifact', 'bad-artifact', 'replace-artifact', 'replace-receipt', 'startup', 'intent', 'unknown', 'case'] as const) test(`${platform}: ${scenario} refuses before barrier`, async t => {
    const f = await fixture(t, platform)
    let path: string | undefined
    if (scenario.includes('completion')) path = join(f.directory, 'prepared-completion.json')
    else if (scenario.includes('ack')) path = join(f.directory, 'prepared-artifact-0.json')
    else if (scenario.includes('receipt')) path = f.receiptPath
    else if (scenario.includes('artifact')) path = f.artifactPaths[0]!
    else if (scenario === 'startup') path = f.artifactPaths.at(-1)!
    else if (scenario === 'intent') path = join(f.directory, 'install-intent.json')
    else if (scenario === 'unknown') path = join(f.directory, 'prepared-unknown')
    else if (scenario === 'case') path = join(f.directory, 'PREPARED-unknown')
    if (path) {
      assert.ok(path.startsWith(f.root))
      if (scenario.startsWith('replace')) {
        const bytes = await fs.readFile(path)
        const mode = (await fs.lstat(path)).mode
        const retained = join(f.root, 'original-retained')
        assert.equal(dirname(retained), f.root)
        await fs.rename(path, retained)
        await fs.writeFile(path, bytes, { mode })
      }
      else if (scenario.startsWith('missing')) await fs.unlink(path)
      else { await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 }); await fs.writeFile(path, 'invalid', { mode: 0o600 }) }
    }
    const before = await snapshot(f.root)
    await assert.rejects(uninstallCompletedNativeInstallTransaction({ ...f, transactionId: scenario === 'wrong-id' ? randomUUID() : f.transactionId, integration: scenario === 'wrong-root' ? { ...f.integration, root: join(f.root, 'different') } : f.integration }))
    assert.deepEqual(await snapshot(f.root), before)
    await assert.rejects(fs.lstat(f.barrier), { code: 'ENOENT' })
    assert.equal((await fs.readdir(f.directory)).some(name => name.startsWith('retired-')), false)
  })
  test(`${platform}: batch private check failure retains barrier before deleting live slots`, async t => {
    const f = await fixture(t, platform)
    const lstat = fs.lstat, open = fs.open
    let manifestCreated = false, injected = false, controlReads = 0
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (String(args[0]) === join(f.barrier, 'manifest.json') && typeof args[1] === 'number' && (args[1] & constants.O_CREAT) !== 0) manifestCreated = true
      return handle
    }) as typeof fs.open
    fs.lstat = (async (...args: Parameters<typeof fs.lstat>) => {
      // Each of the three ancestry walks visits control first; the fourth
      // numeric control read is the fresh batch (identity pins use bigint).
      if (manifestCreated && String(args[0]) === f.directory && args[1] === undefined && ++controlReads === 4) {
        injected = true
        throw new Error('injected batch private check')
      }
      return lstat(...args)
    }) as typeof fs.lstat
    syncBuiltinESMExports()
    try { await assert.rejects(uninstallCompletedNativeInstallTransaction(f), /injected batch private check/) }
    finally { fs.lstat = lstat; fs.open = open; syncBuiltinESMExports() }
    assert.equal(injected, true)
    for (const artifact of f.artifacts) assert.deepEqual(await fs.readFile(artifact.path), artifact.bytes)
    assert.deepEqual(await fs.readFile(f.receiptPath), f.receipt)
    assert.ok((await fs.lstat(join(f.barrier, 'manifest.json'))).isFile())
    await assert.rejects(uninstallCompletedNativeInstallTransaction(f))
  })
  test(`${platform}: unlink failure retains barrier and blocks cooperating writers`, async t => {
    const f = await fixture(t, platform)
    const unlink = fs.unlink
    fs.unlink = (async path => { if (String(path) === f.artifactPaths[0]) throw new Error('injected unlink'); return unlink(path) }) as typeof fs.unlink
    syncBuiltinESMExports()
    try { await assert.rejects(uninstallCompletedNativeInstallTransaction(f), /injected unlink/) } finally { fs.unlink = unlink; syncBuiltinESMExports() }
    assert.ok((await fs.lstat(f.barrier)).isDirectory())
    assert.deepEqual(await fs.readFile(f.receiptPath), f.receipt)
    await assert.rejects(uninstallCompletedNativeInstallTransaction(f))
    const ack = createNativeInstallTransactionAck({ ...f, artifactIndex: 0, observation: { bytes: f.artifacts[0]!.bytes, identity: await fs.lstat(f.artifactPaths[0]!, { bigint: true }) } })
    await assert.rejects(writeNativeInstallTransactionAck({ ...f, ack }))
  })
  for (const point of ['source-move', 'commit'] as const) test(`${platform}: late ${point} error never rolls back`, async t => {
    const f = await fixture(t, platform)
    const rename = fs.rename
    fs.rename = (async (source, destination) => {
      await rename(source, destination)
      if (point === 'source-move' ? String(source) === join(f.directory, 'prepared-completion.json') : String(source) === f.barrier) throw new Error('injected late rename')
    }) as typeof fs.rename
    syncBuiltinESMExports()
    try { await assert.rejects(uninstallCompletedNativeInstallTransaction(f), /injected late rename/) } finally { fs.rename = rename; syncBuiltinESMExports() }
    for (const path of [...f.artifactPaths, f.receiptPath]) await assert.rejects(fs.lstat(path), { code: 'ENOENT' })
    if (point === 'source-move') assert.ok((await fs.lstat(join(f.barrier, 'prepared-completion.json'))).isFile())
    else { await assert.rejects(fs.lstat(f.barrier), { code: 'ENOENT' }); const archive = (await fs.readdir(f.directory)).find(name => name.startsWith('retired-'))!; assert.ok((await fs.lstat(join(f.directory, archive, 'generation', 'manifest.json'))).isFile()) }
    await assert.rejects(uninstallCompletedNativeInstallTransaction(f))
  })
}
test('macOS preserves nonempty wrapper directories and supports missing original package', async t => {
  const f = await fixture(t, 'darwin')
  const extra = join(dirname(f.artifactPaths[1]!), 'user-file')
  await fs.writeFile(extra, 'user')
  await uninstallCompletedNativeInstallTransaction(f)
  assert.equal(await fs.readFile(extra, 'utf8'), 'user')
})
for (const platform of ['darwin', 'win32'] as const) for (const stage of ['artifact', 'receipt', 'archive-move', 'commit'] as const) test(`${platform}: real SIGKILL after ${stage} retains conservative state`, { timeout: process.platform === 'win32' ? 240_000 : 60_000 }, async t => {
  const f = await fixture(t, platform)
  const lockPath = join(f.directory, 'launcher.lock.sqlite')
  const inode = (await fs.lstat(lockPath, { bigint: true })).ino
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-transform-types', fileURLToPath(new URL('./fixtures/native-install-completed-uninstall-crash.ts', import.meta.url)), stage, JSON.stringify({ integration: f.integration, transactionId: f.transactionId })], { encoding: 'utf8', timeout: process.platform === 'win32' ? 220_000 : 45_000, maxBuffer: 4096, killSignal: 'SIGKILL', windowsHide: true })
  assert.equal(child.error, undefined)
  assert.equal(child.stdout, 'INTERRUPTING\n')
  assert.equal(child.stderr, '')
  assert.ok(child.signal === 'SIGKILL' || (process.platform === 'win32' && typeof child.status === 'number' && child.status !== 0))
  if (process.platform !== 'win32') assert.equal(child.signal, 'SIGKILL')
  assert.equal((await fs.lstat(lockPath, { bigint: true })).ino, inode)
  if (stage === 'artifact') assert.deepEqual(await fs.readFile(f.receiptPath), f.receipt)
  else await assert.rejects(fs.lstat(f.receiptPath), { code: 'ENOENT' })
  if (stage === 'commit') {
    await assert.rejects(fs.lstat(f.barrier), { code: 'ENOENT' })
    const archive = (await fs.readdir(f.directory)).find(name => name.startsWith('retired-'))!
    assert.ok((await fs.lstat(join(f.directory, archive, 'generation', 'prepared-transaction.json'))).isFile())
  } else {
    assert.ok((await fs.lstat(join(f.barrier, 'manifest.json'))).isFile())
    if (stage === 'archive-move') assert.ok((await fs.lstat(join(f.barrier, 'prepared-completion.json'))).isFile())
  }
  await assert.rejects(uninstallCompletedNativeInstallTransaction(f))
})
for (const fault of ['receipt-replaced', 'startup-added', 'manifest-open'] as const) test(`post-barrier ${fault} retains evidence without unlinking artifacts`, async t => {
  const f = await fixture(t, 'darwin')
  const open = fs.open
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === join(f.barrier, 'manifest.json') && typeof args[1] === 'number' && (args[1] & constants.O_CREAT) !== 0) {
      if (fault === 'manifest-open') throw new Error('injected manifest open')
      if (fault === 'receipt-replaced') {
        const retained = join(f.root, 'retained-receipt')
        assert.equal(dirname(retained), f.root)
        await fs.rename(f.receiptPath, retained)
        await fs.writeFile(f.receiptPath, f.receipt, { mode: 0o600 })
      } else {
        const startup = f.artifactPaths.at(-1)!
        await fs.mkdir(dirname(startup), { recursive: true, mode: 0o700 })
        await fs.writeFile(startup, 'unexpected', { mode: 0o600 })
      }
    }
    return open(...args)
  }) as typeof fs.open
  syncBuiltinESMExports()
  try { await assert.rejects(uninstallCompletedNativeInstallTransaction(f)) } finally { fs.open = open; syncBuiltinESMExports() }
  for (const artifact of f.artifacts) assert.deepEqual(await fs.readFile(artifact.path), artifact.bytes)
  assert.ok((await fs.lstat(f.barrier)).isDirectory())
  await assert.rejects(uninstallCompletedNativeInstallTransaction(f))
})
for (const fault of ['writeFile', 'sync', 'close'] as const) test(`manifest ${fault} failure retains barrier and all live slots`, async t => {
  const f = await fixture(t, 'darwin')
  const open = fs.open
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args)
    if (String(args[0]) === join(f.barrier, 'manifest.json') && typeof args[1] === 'number' && (args[1] & constants.O_CREAT) !== 0) {
      if (fault === 'close') {
        const close = handle.close.bind(handle)
        handle.close = async () => { await close(); throw new Error('injected manifest close') }
      } else if (fault === 'writeFile') handle.writeFile = async () => { throw new Error('injected manifest writeFile') }
      else handle.sync = async () => { throw new Error('injected manifest sync') }
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try { await assert.rejects(uninstallCompletedNativeInstallTransaction(f), /injected manifest/) } finally { fs.open = open; syncBuiltinESMExports() }
  for (const artifact of f.artifacts) assert.deepEqual(await fs.readFile(artifact.path), artifact.bytes)
  assert.deepEqual(await fs.readFile(f.receiptPath), f.receipt)
  assert.ok((await fs.lstat(f.barrier)).isDirectory())
  await assert.rejects(uninstallCompletedNativeInstallTransaction(f))
})
test('detached snapshot readers reject missing identity and forged barrier locations', async t => {
  const f = await fixture(t, 'darwin')
  const stat = await fs.lstat(join(f.directory, 'prepared-artifact-0.json'), { bigint: true })
  for (const directory of [f.barrier, join(f.directory, 'prepared-uninstalling-invalid'), join(f.root, `prepared-uninstalling-${f.transactionId}`)]) {
    await assert.rejects(readNativeInstallTransactionAckSnapshot({ ...f, artifactIndex: 0 }, undefined, directory))
    await assert.rejects(readNativeInstallTransactionCompletionSnapshot(f, undefined, directory))
    if (directory !== f.barrier) {
      await assert.rejects(readNativeInstallTransactionAckSnapshot({ ...f, artifactIndex: 0 }, stat, directory))
      await assert.rejects(readNativeInstallTransactionCompletionSnapshot(f, stat, directory))
    }
  }
})
test('completed uninstall API is packaged and importable', () => {
  assert.equal(isPublicFile('scripts/native-install-completed-uninstall.ts'), true)
  assert.equal(typeof uninstallCompletedNativeInstallTransaction, 'function')
})
