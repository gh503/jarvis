import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import nodeTest, { type TestContext, type TestFn, type TestOptions } from 'node:test'
import { describeNativeIntegration, renderNativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { createNativeInstallTransaction, encodeNativeInstallTransaction } from '../scripts/native-install-transaction.ts'
import { readNativeInstallTransaction, writeNativeInstallTransaction, writeNativeInstallTransactionUnderLock } from '../scripts/native-install-transaction-store.ts'
import { withNativeInstallLock, type NativeInstallLock } from '../scripts/native-install-lock.ts'
import { createNativeInstallTransactionAck, encodeNativeInstallTransactionAck } from '../scripts/native-install-transaction-ack.ts'
import { readNativeInstallTransactionAck, writeNativeInstallTransactionAck, writeNativeInstallTransactionAckUnderLock } from '../scripts/native-install-transaction-ack-store.ts'
import { createNativeInstallTransactionCompletion, encodeNativeInstallTransactionCompletion, NATIVE_INSTALL_TRANSACTION_COMPLETION_MAX_BYTES } from '../scripts/native-install-transaction-completion.ts'
import { readNativeInstallTransactionCompletion, writeNativeInstallTransactionCompletion, writeNativeInstallTransactionCompletionUnderLock } from '../scripts/native-install-transaction-completion-store.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'
import { isPublicFile } from '../scripts/packaging.ts'
import { assertNativeInstallPreparedWriteAllowed } from '../scripts/native-install-prepared-write-gate.ts'

const partitionValue = process.env.JARVIS_TEST_WRITE_GATE_PARTITION
if (partitionValue !== undefined && !['0', '1', '2', '3'].includes(partitionValue)) {
  throw new Error('JARVIS_TEST_WRITE_GATE_PARTITION must be 0, 1, 2 or 3 when set')
}
const partition = partitionValue === undefined ? undefined : Number(partitionValue)
let registeredCaseCount = 0

// Count every top-level registration, including loop-generated and platform-skipped
// cases, before filtering. Keep registration order deterministic on every platform.
function test(name: string, fn: TestFn): void
function test(name: string, options: TestOptions, fn: TestFn): void
function test(name: string, optionsOrFn: TestOptions | TestFn, fn?: TestFn): void {
  const caseIndex = registeredCaseCount++
  if (partition !== undefined && caseIndex % 4 !== partition) return
  const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn
  const body = typeof optionsOrFn === 'function' ? optionsOrFn : fn!
  // These cases monkeypatch global fs methods; never run their bodies concurrently.
  void nodeTest(name, { ...options, concurrency: false }, body)
}

async function fixture(t: TestContext, platform: 'darwin' | 'win32' = 'darwin') {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'transaction-store-'))
  t.after(async () => { assert.ok(root.startsWith(join(await fs.realpath(tmpdir()), 'transaction-store-'))); await fs.rm(root, { recursive: true, force: true }) })
  const integration: InstallOptions = { platform, root: join(root, 'new-package'), home: join(root, 'home'), appData: join(root, 'roaming'), localAppData: join(root, 'local'), arch: process.arch }
  const layout = describeNativeIntegration(integration)
  const directory = join(dirname(layout.receiptPath), 'native-install-control')
  const transactionPath = join(directory, 'prepared-transaction.json')
  const path = join(directory, 'prepared-completion.json')
  const binding = { root: integration.root, autostart: false, configFile: join(root, 'source.env'), dataDir: join(root, 'data') }
  const plan = renderNativeIntegration(integration, false, binding.configFile)
  const artifacts = plan.platform === 'darwin' ? plan.artifacts : plan.shortcuts.map(item => ({ path: item.path, bytes: Buffer.from([0, 255, 5, 10]), mode: 0o600 }))
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, platform, ...binding, ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: artifacts.map(item => ({ path: item.path, sha256: createHash('sha256').update(item.bytes).digest('hex') })) }, null, 2) + '\n')
  const transaction = createNativeInstallTransaction({ integration, artifacts, receipt, transactionId: randomUUID() })
  const acks = artifacts.map((artifact, artifactIndex) => createNativeInstallTransactionAck({ integration, transaction, artifactIndex, observation: { bytes: artifact.bytes, identity: { dev: '0', ino: String(123 + artifactIndex), mode: String(0o100600), nlink: '1', uid: '1000', gid: '1000', rdev: '0', size: String(artifact.bytes.length), mtimeNs: '0', ctimeNs: '0', birthtimeNs: '0' } } }))
  const completion = createNativeInstallTransactionCompletion({ integration, transaction, acks, observation: { bytes: receipt, identity: { ...acks[0]!.identity, size: String(receipt.length) } } })
  return { root, integration, transaction, acks, ack: acks[0]!, artifactIndex: 0, completion, directory, path, transactionPath, ...layout }

}
async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
  await writeNativeInstallTransaction(f)
  for (const ack of f.acks) await writeNativeInstallTransactionAck({ ...f, ack })
}
async function snapshot(path: string): Promise<unknown> {
  const stat = await fs.lstat(path, { bigint: true })
  const metadata = { ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid, nlink: stat.nlink, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs }
  return stat.isDirectory() ? { metadata, children: await Promise.all((await fs.readdir(path)).sort().map(async name => [name, await snapshot(join(path, name))])) } : { metadata, bytes: await fs.readFile(path) }
}

for (const composed of [false, true]) {
  for (const name of ['prepared-retiring-anything', 'prepared-uninstalling-anything', 'prepared-future-secret', 'PrEpArEd-future', 'PREPARED-artifact-999.JSON', 'prepared-artifact-01.json', 'prepared-artifact-999.json', 'install-intent.json', 'INSTALL-INTENT.JSON']) {
    test(`transaction presence barrier ${name} refuses publication, composed=${composed}`, async t => {
      const f = { ...await fixture(t), path: '' }
      f.path = join(f.directory, 'prepared-transaction.json')
      await withNativeInstallLock({ controlDirectory: f.directory }, async () => {})
      const barrier = join(f.directory, name)
      if (name.includes('anything')) await fs.mkdir(barrier, { mode: 0o700 })
      else await fs.writeFile(barrier, 'not a record: secret', { mode: 0o600 })
      const before = await snapshot(barrier)
      const retained = (await fs.readdir(f.directory)).filter(entry => entry.startsWith('prepared-')).sort()
      const records = await Promise.all(retained.map(entry => snapshot(join(f.directory, entry))))
      const publish = () => composed
        ? withNativeInstallLock({ controlDirectory: f.directory }, lock => writeNativeInstallTransactionUnderLock({ ...f, lock }))
        : writeNativeInstallTransaction(f)
      await assert.rejects(publish(), { message: 'Native install preparation publication blocked by retained or unsafe control entries' })
      await assert.rejects(fs.lstat(f.path), { code: 'ENOENT' })
      assert.deepEqual(await snapshot(barrier), before)
      assert.deepEqual(await Promise.all(retained.map(entry => snapshot(join(f.directory, entry)))), records)
      assert.equal(await readNativeInstallTransaction(f), undefined)
      assert.deepEqual(await snapshot(barrier), before)
    })
  }
  test(`transaction barrier after publication preserves evidence and refuses success, composed=${composed}`, async t => {
    const f = { ...await fixture(t), path: '' }
      f.path = join(f.directory, 'prepared-transaction.json')
    await withNativeInstallLock({ controlDirectory: f.directory }, async () => {})
    const original = fs.open
    const barrier = join(f.directory, 'PrEpArEd-future-secret')
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args)
      if (args[0] === f.path && ((args[1] as number) & constants.O_CREAT) !== 0) {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => { await sync(); await fs.mkdir(barrier, { mode: 0o700 }) }
      }
      return handle
    }) as typeof fs.open
    syncBuiltinESMExports()
    try {
      await assert.rejects(composed
        ? withNativeInstallLock({ controlDirectory: f.directory }, lock => writeNativeInstallTransactionUnderLock({ ...f, lock }))
        : writeNativeInstallTransaction(f), { message: 'Native install preparation publication blocked by retained or unsafe control entries' })
    } finally { fs.open = original; syncBuiltinESMExports() }
    assert.ok((await fs.lstat(barrier)).isDirectory())
    assert.ok((await fs.lstat(f.path)).isFile())
    assert.deepEqual(await readNativeInstallTransaction(f), f.transaction)
  })
}

test('presence gate requires matching lock and sanitizes enumeration failures', async t => {
  const f = { ...await fixture(t), path: '' }
  f.path = join(f.directory, 'prepared-transaction.json')
  const other = await fixture(t)
  await assert.rejects(assertNativeInstallPreparedWriteAllowed(f.integration, {} as NativeInstallLock), /capability/)
  await withNativeInstallLock({ controlDirectory: other.directory }, async lock => {
    await assert.rejects(assertNativeInstallPreparedWriteAllowed(f.integration, lock), /capability/)
  })
  const original = fs.readdir
  fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
    if (args[0] === f.directory) throw new Error('sensitive path and filesystem details')
    return original(...args)
  }) as typeof fs.readdir
  syncBuiltinESMExports()
  try {
    await assert.rejects(writeNativeInstallTransaction(f), { message: 'Native install preparation publication blocked by retained or unsafe control entries' })
  } finally { fs.readdir = original; syncBuiltinESMExports() }
  await assert.rejects(fs.lstat(f.path), { code: 'ENOENT' })
  assert.equal(isPublicFile('scripts/native-install-prepared-write-gate.ts'), true)
})

for (const composed of [false, true]) {
  for (const name of ['prepared-retiring-anything', 'prepared-uninstalling-anything', 'prepared-future-secret', 'PrEpArEd-future', 'PREPARED-artifact-999.JSON', 'prepared-artifact-01.json', 'prepared-artifact-999.json', 'install-intent.json', 'INSTALL-INTENT.JSON']) {
    test(`-ack presence barrier ${name} refuses publication, composed=${composed}`, async t => {
      const f = { ...await fixture(t), path: '' }
      f.path = join(f.directory, 'prepared-artifact-0.json')
      await writeNativeInstallTransaction(f)
      const barrier = join(f.directory, name)
      if (name.includes('anything')) await fs.mkdir(barrier, { mode: 0o700 })
      else await fs.writeFile(barrier, 'not a record: secret', { mode: 0o600 })
      const before = await snapshot(barrier)
      const retained = (await fs.readdir(f.directory)).filter(entry => entry.startsWith('prepared-')).sort()
      const records = await Promise.all(retained.map(entry => snapshot(join(f.directory, entry))))
      const publish = () => composed
        ? withNativeInstallLock({ controlDirectory: f.directory }, lock => writeNativeInstallTransactionAckUnderLock({ ...f, lock }))
        : writeNativeInstallTransactionAck(f)
      await assert.rejects(publish(), { message: 'Native install preparation publication blocked by retained or unsafe control entries' })
      await assert.rejects(fs.lstat(f.path), { code: 'ENOENT' })
      assert.deepEqual(await snapshot(barrier), before)
      assert.deepEqual(await Promise.all(retained.map(entry => snapshot(join(f.directory, entry)))), records)
      assert.equal(await readNativeInstallTransactionAck(f), undefined)
      assert.deepEqual(await snapshot(barrier), before)
    })
  }
  test(`-ack barrier after publication preserves evidence and refuses success, composed=${composed}`, async t => {
    const f = { ...await fixture(t), path: '' }
      f.path = join(f.directory, 'prepared-artifact-0.json')
    await writeNativeInstallTransaction(f)
    const original = fs.open
    const barrier = join(f.directory, 'PrEpArEd-future-secret')
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args)
      if (args[0] === f.path && ((args[1] as number) & constants.O_CREAT) !== 0) {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => { await sync(); await fs.mkdir(barrier, { mode: 0o700 }) }
      }
      return handle
    }) as typeof fs.open
    syncBuiltinESMExports()
    try {
      await assert.rejects(composed
        ? withNativeInstallLock({ controlDirectory: f.directory }, lock => writeNativeInstallTransactionAckUnderLock({ ...f, lock }))
        : writeNativeInstallTransactionAck(f), { message: 'Native install preparation publication blocked by retained or unsafe control entries' })
    } finally { fs.open = original; syncBuiltinESMExports() }
    assert.ok((await fs.lstat(barrier)).isDirectory())
    assert.ok((await fs.lstat(f.path)).isFile())
    assert.deepEqual(await readNativeInstallTransactionAck(f), f.ack)
  })
}

for (const composed of [false, true]) {
  for (const name of ['prepared-retiring-anything', 'prepared-uninstalling-anything', 'prepared-future-secret', 'PrEpArEd-future', 'PREPARED-artifact-999.JSON', 'prepared-artifact-01.json', 'prepared-artifact-999.json', 'install-intent.json', 'INSTALL-INTENT.JSON']) {
    test(`-completion presence barrier ${name} refuses publication, composed=${composed}`, async t => {
      const f = { ...await fixture(t), path: '' }
      f.path = join(f.directory, 'prepared-completion.json')
      await prepare(f)
      const barrier = join(f.directory, name)
      if (name.includes('anything')) await fs.mkdir(barrier, { mode: 0o700 })
      else await fs.writeFile(barrier, 'not a record: secret', { mode: 0o600 })
      const before = await snapshot(barrier)
      const retained = (await fs.readdir(f.directory)).filter(entry => entry.startsWith('prepared-')).sort()
      const records = await Promise.all(retained.map(entry => snapshot(join(f.directory, entry))))
      const publish = () => composed
        ? withNativeInstallLock({ controlDirectory: f.directory }, lock => writeNativeInstallTransactionCompletionUnderLock({ ...f, lock }))
        : writeNativeInstallTransactionCompletion(f)
      await assert.rejects(publish(), { message: 'Native install preparation publication blocked by retained or unsafe control entries' })
      await assert.rejects(fs.lstat(f.path), { code: 'ENOENT' })
      assert.deepEqual(await snapshot(barrier), before)
      assert.deepEqual(await Promise.all(retained.map(entry => snapshot(join(f.directory, entry)))), records)
      assert.equal(await readNativeInstallTransactionCompletion(f), undefined)
      assert.deepEqual(await snapshot(barrier), before)
    })
  }
  test(`-completion barrier after publication preserves evidence and refuses success, composed=${composed}`, async t => {
    const f = { ...await fixture(t), path: '' }
      f.path = join(f.directory, 'prepared-completion.json')
    await prepare(f)
    const original = fs.open
    const barrier = join(f.directory, 'PrEpArEd-future-secret')
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args)
      if (args[0] === f.path && ((args[1] as number) & constants.O_CREAT) !== 0) {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => { await sync(); await fs.mkdir(barrier, { mode: 0o700 }) }
      }
      return handle
    }) as typeof fs.open
    syncBuiltinESMExports()
    try {
      await assert.rejects(composed
        ? withNativeInstallLock({ controlDirectory: f.directory }, lock => writeNativeInstallTransactionCompletionUnderLock({ ...f, lock }))
        : writeNativeInstallTransactionCompletion(f), { message: 'Native install preparation publication blocked by retained or unsafe control entries' })
    } finally { fs.open = original; syncBuiltinESMExports() }
    assert.ok((await fs.lstat(barrier)).isDirectory())
    assert.ok((await fs.lstat(f.path)).isFile())
    assert.deepEqual(await readNativeInstallTransactionCompletion(f), f.completion)
  })
}
