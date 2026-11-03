import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { describeNativeIntegration, renderNativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { createNativeInstallTransaction, encodeNativeInstallTransaction } from '../scripts/native-install-transaction.ts'
import { writeNativeInstallTransaction } from '../scripts/native-install-transaction-store.ts'
import { createNativeInstallTransactionAck, encodeNativeInstallTransactionAck } from '../scripts/native-install-transaction-ack.ts'
import { writeNativeInstallTransactionAck } from '../scripts/native-install-transaction-ack-store.ts'
import { inspectNativeInstallTransaction } from '../scripts/native-install-transaction-inspect.ts'
import { withNativeInstallLock } from '../scripts/native-install-lock.ts'
import { isPublicFile } from '../scripts/packaging.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'

async function fixture(t: test.TestContext, platform: 'darwin' | 'win32') {
  const temporary = await fs.realpath(tmpdir())
  const root = await fs.mkdtemp(join(temporary, 'transaction-inspect-'))
  t.after(async () => { assert.equal(dirname(root), temporary); assert.ok(root.startsWith(join(temporary, 'transaction-inspect-'))); await fs.rm(root, { recursive: true, force: true }) })
  const integration: InstallOptions = { platform, root: join(root, 'package'), home: join(root, 'home'), appData: join(root, 'roaming'), localAppData: join(root, 'local'), arch: process.arch }
  const layout = describeNativeIntegration(integration)
  const directory = join(dirname(layout.receiptPath), 'native-install-control')
  const plan = renderNativeIntegration(integration, false)
  const artifacts = plan.platform === 'darwin' ? plan.artifacts : plan.shortcuts.map(item => ({ path: item.path, bytes: Buffer.from([0, 255, 1, 10]), mode: 0o600 }))
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, platform, root: integration.root, autostart: false, ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: artifacts.map(item => ({ path: item.path, sha256: createHash('sha256').update(item.bytes).digest('hex') })) }, null, 2) + '\n')
  const transaction = createNativeInstallTransaction({ integration, artifacts, receipt, transactionId: randomUUID() })
  const materialize = async (acknowledge = true) => {
    for (const [artifactIndex, artifact] of artifacts.entries()) {
      await fs.mkdir(dirname(artifact.path), { recursive: true, mode: 0o700 })
      await fs.writeFile(artifact.path, artifact.bytes, { mode: artifact.mode })
      if (acknowledge) {
        const ack = createNativeInstallTransactionAck({ integration, transaction, artifactIndex, observation: { bytes: artifact.bytes, identity: await fs.lstat(artifact.path, { bigint: true }) } })
        await writeNativeInstallTransactionAck({ integration, transaction, ack })
      }
    }
  }
  return { root, integration, directory, artifacts, receipt, transaction, materialize, ...layout }
}
// Reading can change atime and operational SQLite files are permitted; all other
// file contents and identities must stay intact, including unexpected files.
async function snapshot(path: string): Promise<unknown> {
  const stat = await fs.lstat(path, { bigint: true })
  if (stat.isDirectory()) return Promise.all((await fs.readdir(path)).sort().filter(name => !name.startsWith('launcher.lock.sqlite')).map(async name => [name, await snapshot(join(path, name))]))
  return { bytes: stat.isFile() ? await fs.readFile(path) : undefined, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs }
}
for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: no preparation makes no absence claim; no ack blocks; exact observations describe receipt only`, async t => {
    const f = await fixture(t, platform)
    // Existing slots must not turn missing preparation into an absence claim.
    await f.materialize(false)
    const absent = await inspectNativeInstallTransaction(f)
    assert.equal(absent.status, 'no-transaction')
    assert.deepEqual(absent.issues, [{ reason: 'preparation-missing' }])
    await writeNativeInstallTransaction(f)
    const before = await snapshot(f.root)
    const unacked = await inspectNativeInstallTransaction(f)
    assert.equal(unacked.status, 'blocked')
    assert.deepEqual(unacked.issues, f.artifacts.map((_, artifactIndex) => ({ reason: 'ack-missing', artifactIndex })))
    assert.deepEqual(await snapshot(f.root), before)
    // Acks are actual observed stats, never fabricated expected identities.
    for (const [artifactIndex, artifact] of f.artifacts.entries()) await writeNativeInstallTransactionAck({ ...f, ack: createNativeInstallTransactionAck({ ...f, artifactIndex, observation: { bytes: artifact.bytes, identity: await fs.lstat(artifact.path, { bigint: true }) } }) })
    const ready = await inspectNativeInstallTransaction(f)
    assert.equal(ready.status, 'receipt-absent')
    await assert.rejects(fs.lstat(f.receiptPath), { code: 'ENOENT' })
    await fs.writeFile(f.receiptPath, f.receipt, { mode: 0o600 })
    const published = await snapshot(f.root)
    const present = await inspectNativeInstallTransaction(f)
    assert.equal(present.status, 'receipt-present')
    assert.deepEqual(await snapshot(f.root), published)
    for (const value of Object.values(present.scope)) assert.equal(value, false)
    assert.equal(present.limitations.sourceWindowsAcl, false)
    assert.equal(present.limitations.controlPolicy, 'private-install-control')
    assert.ok(Object.isFrozen(present) && Object.isFrozen(present.scope) && Object.isFrozen(present.limitations) && Object.isFrozen(present.issues) && present.issues.every(Object.isFrozen))
    assert.throws(() => { (present as { status: string }).status = 'completed' }, TypeError)
    const serialized = JSON.stringify(present)
    for (const secret of [f.root, f.transaction.transactionId, f.transaction.receipt.sha256, f.transaction.receipt.base64, 'identity', 'path']) assert.ok(!serialized.includes(secret))
  })
  for (const scenario of ['missing', 'replace', 'bytes', 'startup', 'receipt', 'ack-invalid', 'transaction-invalid', 'unsafe-artifact'] as const) test(`${platform}: ${scenario} fails closed without automatic changes`, async t => {
    const f = await fixture(t, platform)
    await writeNativeInstallTransaction(f)
    await f.materialize()
    const artifact = f.artifacts[0]!
    if (scenario === 'missing' || scenario === 'replace') {
      const retained = join(f.root, 'retained-original')
      assert.ok(artifact.path.startsWith(f.root + (process.platform === 'win32' ? '\\' : '/')))
      assert.equal(dirname(retained), f.root)
      await fs.rename(artifact.path, retained)
      if (scenario === 'replace') await fs.writeFile(artifact.path, artifact.bytes, { mode: artifact.mode })
    } else if (scenario === 'bytes') await fs.writeFile(artifact.path, Buffer.alloc(artifact.bytes.length, 65))
    else if (scenario === 'startup') {
      const path = f.artifactPaths.at(-1)!
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 }); await fs.writeFile(path, 'unexpected', { mode: 0o600 })
    } else if (scenario === 'receipt') await fs.writeFile(f.receiptPath, Buffer.concat([f.receipt, Buffer.from(' ')]), { mode: 0o600 })
    else if (scenario === 'ack-invalid') await fs.writeFile(join(f.directory, 'prepared-artifact-0.json'), '{}')
    else if (scenario === 'transaction-invalid') await fs.writeFile(join(f.directory, 'prepared-transaction.json'), '{}')
    else await fs.link(artifact.path, join(f.root, 'hardlink'))
    const before = await snapshot(f.root)
    const result = await inspectNativeInstallTransaction(f)
    assert.equal(result.status, ['missing', 'ack-invalid', 'transaction-invalid', 'unsafe-artifact'].includes(scenario) ? 'blocked' : 'conflict')
    if (scenario === 'replace') assert.ok(result.issues.some(issue => issue.reason === 'artifact-mismatch' && issue.artifactIndex === 0))
    assert.deepEqual(await snapshot(f.root), before)
  })
  test(`${platform}: call-time options snapshot and shared lock contention`, async t => {
    const f = await fixture(t, platform)
    await writeNativeInstallTransaction(f); await f.materialize()
    const original = { ...f.integration }
    const pending = inspectNativeInstallTransaction(f)
    f.integration.home = join(f.root, 'other-home')
    f.integration.localAppData = join(f.root, 'other-local')
    assert.equal((await pending).status, 'receipt-absent')
    await withNativeInstallLock({ controlDirectory: f.directory }, async () => {
      assert.equal((await inspectNativeInstallTransaction({ integration: original })).status, 'blocked')
    })
  })
}
for (const change of ['artifact', 'receipt', 'ack', 'transaction'] as const) test(`repeat observations and canonical store revalidation reject ${change} race`, async t => {
  const f = await fixture(t, 'darwin')
  await writeNativeInstallTransaction(f); await f.materialize()
  if (change === 'receipt') await fs.writeFile(f.receiptPath, f.receipt, { mode: 0o600 })
  const original = fs.open
  let changed = false
  // Alter after the first artifact descriptor closes, so its bounded read was
  // valid. The later observation/store checks must independently detect it.
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[0] === (change === 'receipt' ? f.receiptPath : f.artifacts[0]!.path) && !changed) {
      const close = handle.close.bind(handle)
      handle.close = async () => {
        await close()
        if (changed) return
        changed = true
        if (change === 'artifact') {
          const target = join(f.root, 'replacement')
          await fs.writeFile(target, f.artifacts[0]!.bytes, { mode: f.artifacts[0]!.mode })
          assert.equal(dirname(target), f.root); assert.ok(f.artifacts[0]!.path.startsWith(f.root + (process.platform === 'win32' ? '\\' : '/')))
          await fs.rename(target, f.artifacts[0]!.path)
        } else if (change === 'receipt') {
          // A valid first receipt observation must be rechecked before report.
          await fs.writeFile(f.receiptPath, 'wrong', { mode: 0o600 })
        } else if (change === 'transaction') await fs.writeFile(join(f.directory, 'prepared-transaction.json'), encodeNativeInstallTransaction({ ...f.transaction, transactionId: randomUUID() }, f.integration))
        else {
          const ack = createNativeInstallTransactionAck({ ...f, artifactIndex: 0, observation: { bytes: f.artifacts[0]!.bytes, identity: await fs.lstat(f.artifacts[0]!.path, { bigint: true }) } })
          await fs.writeFile(join(f.directory, 'prepared-artifact-0.json'), encodeNativeInstallTransactionAck({ ...ack, identity: { ...ack.identity, ino: String(BigInt(ack.identity.ino) + 1n) } }, f.transaction, f.integration))
        }
      }
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try {
    const result = await inspectNativeInstallTransaction(f)
    assert.ok(changed)
    assert.equal(result.status, 'blocked')
    assert.ok(result.issues.some(issue => ['observation-changed', 'store-changed', 'unsafe-or-unavailable', 'receipt-mismatch'].includes(issue.reason)))
  } finally { fs.open = original; syncBuiltinESMExports() }
})
test('packaging includes runtime inspector only', () => {
  assert.equal(isPublicFile('scripts/native-install-transaction-inspect.ts'), true)
  assert.equal(isPublicFile('test/native-install-transaction-inspect.test.ts'), false)
})
