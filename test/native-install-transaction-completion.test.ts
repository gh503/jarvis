import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { renderNativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { createNativeInstallTransaction, encodeNativeInstallTransaction } from '../scripts/native-install-transaction.ts'
import { createNativeInstallTransactionAck, encodeNativeInstallTransactionAck, type NativeInstallArtifactIdentity } from '../scripts/native-install-transaction-ack.ts'
import { createNativeInstallTransactionCompletion as create, encodeNativeInstallTransactionCompletion as encode, decodeNativeInstallTransactionCompletion as decode, NATIVE_INSTALL_TRANSACTION_COMPLETION_MAX_BYTES } from '../scripts/native-install-transaction-completion.ts'
import { isPublicFile } from '../scripts/packaging.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const json = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')
function fixture(platform: 'darwin' | 'win32' = 'darwin', configured = false) {
  const base = resolve('nonexistent-completion-fixture')
  const integration: InstallOptions = { platform, root: join(base, 'package'), home: join(base, 'home'), appData: join(base, 'roaming'), localAppData: join(base, 'local'), arch: process.arch, runPowerShell() { throw new Error('Execution forbidden') } }
  const binding = { root: integration.root, autostart: false, ...(configured ? { configFile: join(base, 'config.env'), dataDir: join(base, 'data') } : {}) }
  const plan = renderNativeIntegration(integration, false, binding.configFile)
  const artifacts = plan.platform === 'darwin' ? plan.artifacts : plan.shortcuts.map(item => ({ path: item.path, bytes: Buffer.from([0, 255, 5, 10]), mode: 0o600 }))
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, platform, ...binding, ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: artifacts.map(item => ({ path: item.path, sha256: hash(item.bytes) })) }, null, 2) + '\n')
  const transaction = createNativeInstallTransaction({ integration, transactionId: randomUUID(), artifacts, receipt })
  const identity: NativeInstallArtifactIdentity = { dev: '0', ino: '123', mode: String(0o100400), nlink: '1', uid: '1000', gid: '1000', rdev: '0', size: String(receipt.length), mtimeNs: '-1', ctimeNs: '0', birthtimeNs: '-123456789' }
  const acks = artifacts.map((artifact, artifactIndex) => createNativeInstallTransactionAck({ transaction, integration, artifactIndex, observation: { bytes: artifact.bytes, identity: { ...identity, ino: String(artifactIndex + 1), size: String(artifact.bytes.length) } } }))
  return { integration, transaction, acks, observation: { bytes: receipt, identity } }
}
function frozen(value: unknown) { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen) } }
for (const platform of ['darwin', 'win32'] as const) for (const configured of [false, true]) test(`${platform} immutable canonical completion configured=${configured}`, () => {
  const f = fixture(platform, configured), completion = create(f), bytes = encode(completion, f.transaction, f.integration, f.acks)
  assert.deepEqual(bytes, json(completion))
  assert.equal(completion.stage, 'declared-completion')
  assert.equal(completion.transactionSha256, hash(encodeNativeInstallTransaction(f.transaction, f.integration)))
  assert.deepEqual(completion.ackSha256, f.acks.map(ack => hash(encodeNativeInstallTransactionAck(ack, f.transaction, f.integration))))
  assert.deepEqual(completion.receipt, { sha256: hash(f.observation.bytes), bytes: f.observation.bytes.length, identity: f.observation.identity })
  assert.ok(!('base64' in completion.receipt))
  assert.ok(Object.values(completion.scope).every(value => value === false))
  const decoded = decode(bytes, f.transaction, f.integration, f.acks)
  assert.deepEqual(decoded, completion); frozen(completion); frozen(decoded)
  f.observation.bytes.fill(0); (f.observation.identity as any).ino = '999'; f.acks.reverse()
  assert.deepEqual(json(completion), bytes)
})
test('rejects missing, extra, duplicate, reordered, sparse and mismatched acknowledgements', () => {
  const f = fixture(), completion = create(f), bytes = json(completion)
  const sparse = [...f.acks]; delete sparse[0]
  const inherited = [...f.acks]; delete inherited[0]; Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: f.acks[0] }))
  const other = fixture()
  const lists = [[], f.acks.slice(1), [...f.acks, f.acks[0]!], [...f.acks].reverse(), f.acks.map(() => f.acks[0]!), sparse, inherited, other.acks, f.acks.map((ack, index) => index ? ack : { ...ack, identity: { ...ack.identity, ino: '999' } })]
  for (const acks of lists) {
    assert.throws(() => decode(bytes, f.transaction, f.integration, acks))
    assert.throws(() => encode(completion, f.transaction, f.integration, acks))
  }
  for (const acks of lists.slice(0, -1)) assert.throws(() => create({ ...f, acks }))
  const extra = Object.assign([...f.acks], { extra: true })
  assert.throws(() => create({ ...f, acks: extra }))
  assert.throws(() => create({ ...f, acks: f.acks.map(ack => ({ ...ack, transactionId: randomUUID() })) }))
})
test('exact receipt bytes and strict shared identity validation', () => {
  const f = fixture()
  for (const bytes of [Buffer.alloc(f.observation.bytes.length), Buffer.alloc(0), Buffer.concat([f.observation.bytes, Buffer.from('\n')]), new Uint8Array(f.observation.bytes)]) assert.throws(() => create({ ...f, observation: { ...f.observation, bytes: bytes as Buffer } }))
  const reject = (identity: any) => assert.throws(() => create({ ...f, observation: { ...f.observation, identity } }))
  for (const key of Object.keys(f.observation.identity)) {
    const missing: any = { ...f.observation.identity }; delete missing[key]; reject(missing)
    for (const value of ['', '01', '-0', '+1', '1.0', '1e2', ' 1', '1\n', '9'.repeat(41), 1, 1n, null]) reject({ ...f.observation.identity, [key]: value })
    if (!key.endsWith('Ns')) reject({ ...f.observation.identity, [key]: '-1' })
  }
  for (const patch of [{ mode: String(0o040700) }, { mode: String(0o120600) }, { mode: String(0o010600) }, { mode: '0' }, { mode: String(0o300600) }, { nlink: '0' }, { nlink: '2' }, { size: '999999' }, { extra: '1' }, { [Symbol()]: '1' }]) reject({ ...f.observation.identity, ...patch })
  reject(null); reject([])
  const maximum = '9'.repeat(40)
  assert.equal(create({ ...f, observation: { ...f.observation, identity: { ...f.observation.identity, ino: maximum, mtimeNs: '-' + maximum } } }).receipt.identity.ino, maximum)
  reject({ ...f.observation.identity, isFile: () => true, ino: 10n ** 40n })
})
test('real receipt stats retain all eleven observed fields', async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), 'jarvis-completion-'))
  try {
    const path = join(directory, 'receipt')
    await writeFile(path, f.observation.bytes, { mode: 0o400 })
    const stats = await lstat(path, { bigint: true })
    const completion = create({ ...f, observation: { bytes: f.observation.bytes, identity: stats } })
    for (const key of Object.keys(completion.receipt.identity) as (keyof NativeInstallArtifactIdentity)[]) assert.equal(completion.receipt.identity[key], stats[key].toString())
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('strict decoder rejects malformed UTF8, noncanonical JSON, altered bindings and unknown keys', () => {
  const f = fixture(), completion = create(f), bytes = json(completion)
  const reject = (value: any) => { assert.throws(() => decode(json(value), f.transaction, f.integration, f.acks)); assert.throws(() => encode(value, f.transaction, f.integration, f.acks)) }
  for (const location of ['', 'receipt', 'receipt.identity', 'scope']) {
    const target = location.split('.').filter(Boolean).reduce((obj: any, key) => obj[key], completion)
    for (const key of [...Object.keys(target), 'extra']) {
      const value = JSON.parse(bytes.toString()), object = location.split('.').filter(Boolean).reduce((obj, key) => obj[key], value)
      if (key === 'extra') object.extra = true; else delete object[key]
      reject(value)
    }
  }
  for (const patch of [{ schemaVersion: 2 }, { kind: 'receipt' }, { stage: 'committed' }, { transactionId: randomUUID() }, { transactionSha256: '0'.repeat(64) }, { ackSha256: [] }, { ackSha256: [...completion.ackSha256].reverse() }, { receipt: { ...completion.receipt, sha256: '0'.repeat(64) } }, { receipt: { ...completion.receipt, bytes: completion.receipt.bytes + 1 } }, { receipt: { ...completion.receipt, identity: { ...completion.receipt.identity, nlink: '2' } } }]) reject({ ...completion, ...patch })
  for (const key of Object.keys(completion.scope)) reject({ ...completion, scope: { ...completion.scope, [key]: true } })
  const sparse = [...completion.ackSha256]; delete sparse[0]; reject({ ...completion, ackSha256: sparse })
  assert.throws(() => encode({ ...completion, [Symbol()]: true }, f.transaction, f.integration, f.acks))
  for (const bad of [Buffer.alloc(NATIVE_INSTALL_TRANSACTION_COMPLETION_MAX_BYTES + 1), Buffer.from([255]), Buffer.from('{'), bytes.subarray(0, -1), Buffer.concat([Buffer.from([239, 187, 191]), bytes]), Buffer.from(JSON.stringify(completion, null, 2) + '\n'), Buffer.from(bytes.toString().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')), json({ kind: completion.kind, ...Object.fromEntries(Object.entries(completion).filter(([key]) => key !== 'kind')) })]) assert.throws(() => decode(bad, f.transaction, f.integration, f.acks))
  assert.throws(() => decode(bytes, { ...f.transaction, transactionId: randomUUID() }, f.integration, f.acks))
  assert.throws(() => decode(bytes, f.transaction, { ...f.integration, root: '/changed' }, f.acks))
  const changedReceipt = Buffer.concat([Buffer.from(f.transaction.receipt.base64, 'base64'), Buffer.from('\n')])
  assert.throws(() => decode(bytes, { ...f.transaction, receipt: { sha256: hash(changedReceipt), bytes: changedReceipt.length, base64: changedReceipt.toString('base64') } }, f.integration, f.acks))
  // Data-only: a structurally valid invented receipt identity cannot be authenticated.
  assert.equal(decode(json({ ...completion, receipt: { ...completion.receipt, identity: { ...completion.receipt.identity, ino: '999' } } }), f.transaction, f.integration, f.acks).receipt.identity.ino, '999')
})
test('completion runtime module is allowlisted, tests are excluded', () => {
  assert.equal(isPublicFile('scripts/native-install-transaction-completion.ts'), true)
  assert.equal(isPublicFile('test/native-install-transaction-completion.test.ts'), false)
})
