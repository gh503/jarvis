import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { renderNativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { createNativeInstallTransaction, encodeNativeInstallTransaction } from '../scripts/native-install-transaction.ts'
import { createNativeInstallTransactionAck, encodeNativeInstallTransactionAck, decodeNativeInstallTransactionAck, NATIVE_INSTALL_TRANSACTION_ACK_MAX_BYTES, NATIVE_INSTALL_TRANSACTION_ACK_IDENTITY_MAX_DIGITS, type NativeInstallArtifactIdentity } from '../scripts/native-install-transaction-ack.ts'
import { isPublicFile } from '../scripts/packaging.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const json = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')
function fixture(platform: 'darwin' | 'win32' = 'darwin', configured = false) {
  const base = resolve('nonexistent-ack-fixture')
  const integration: InstallOptions = { platform, root: join(base, 'package'), home: join(base, 'home'), appData: join(base, 'roaming'), localAppData: join(base, 'local'), arch: process.arch, runPowerShell() { throw new Error('Execution forbidden') } }
  const binding = { root: integration.root, autostart: false, ...(configured ? { configFile: join(base, 'config.env'), dataDir: join(base, 'data') } : {}) }
  const plan = renderNativeIntegration(integration, false, binding.configFile)
  const artifacts = plan.platform === 'darwin' ? plan.artifacts : plan.shortcuts.map(item => ({ path: item.path, bytes: Buffer.from([0, 255, 5, 10]), mode: 0o600 }))
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, platform, ...binding, ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: artifacts.map(item => ({ path: item.path, sha256: hash(item.bytes) })) }, null, 2) + '\n')
  const transaction = createNativeInstallTransaction({ integration, transactionId: randomUUID(), artifacts, receipt })
  const identity: NativeInstallArtifactIdentity = { dev: '0', ino: '123', mode: String(0o100600), nlink: '1', uid: '1000', gid: '1000', rdev: '0', size: String(artifacts[0]!.bytes.length), mtimeNs: '-1', ctimeNs: '0', birthtimeNs: '-123456789' }
  const options = { integration, transaction, artifactIndex: 0, observation: { bytes: Buffer.from(artifacts[0]!.bytes), identity } }
  return { ...options, options, artifacts }
}
function frozen(value: unknown) { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen) } }
for (const platform of ['darwin', 'win32'] as const) for (const configured of [false, true]) test(`${platform} canonical immutable acknowledgement configured=${configured}`, () => {
  const f = fixture(platform, configured)
  for (const [artifactIndex, artifact] of f.artifacts.entries()) {
    const observation = { bytes: Buffer.from(artifact.bytes), identity: { ...f.observation.identity, size: String(artifact.bytes.length) } }
    const ack = createNativeInstallTransactionAck({ ...f, artifactIndex, observation })
    const bytes = encodeNativeInstallTransactionAck(ack, f.transaction, f.integration)
    assert.deepEqual(bytes, json(ack))
    assert.equal(ack.transactionSha256, hash(encodeNativeInstallTransaction(f.transaction, f.integration)))
    assert.equal(ack.path, artifact.path)
    assert.equal(ack.artifactIndex, artifactIndex)
    assert.deepEqual(ack.expected, { sha256: hash(artifact.bytes), bytes: artifact.bytes.length })
    assert.deepEqual(ack.identity, observation.identity)
    const decoded = decodeNativeInstallTransactionAck(bytes, f.transaction, f.integration)
    assert.deepEqual(decoded, ack); frozen(ack); frozen(decoded)
    assert.ok(Object.values(ack.scope).every(value => value === false))
    observation.bytes.fill(1); observation.identity.ino = '999'
    assert.deepEqual(encodeNativeInstallTransactionAck(ack, f.transaction, f.integration), bytes)
    assert.ok(!('base64' in ack) && !('bytes' in ack))
  }
})
test('real BigIntStats converts all identity fields and tolerates effective mode differing from requested', async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), 'jarvis-ack-'))
  try {
    const path = join(directory, 'artifact')
    await writeFile(path, f.observation.bytes, { mode: 0o400 })
    const stats = await lstat(path, { bigint: true })
    const ack = createNativeInstallTransactionAck({ ...f, observation: { bytes: f.observation.bytes, identity: stats } })
    for (const key of Object.keys(ack.identity) as (keyof NativeInstallArtifactIdentity)[]) assert.equal(ack.identity[key], stats[key].toString())
    assert.notEqual(Number(stats.mode & 0o7777n), f.transaction.artifacts[0]!.expected!.mode)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('rejects wrong bytes, non-Buffers, excluded startup and invalid indices', () => {
  const f = fixture()
  for (const artifactIndex of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, f.transaction.artifacts.length - 1, f.transaction.artifacts.length]) assert.throws(() => createNativeInstallTransactionAck({ ...f, artifactIndex }))
  for (const bytes of [Buffer.alloc(f.observation.bytes.length), Buffer.alloc(0), Buffer.concat([f.observation.bytes, Buffer.from('x')]), new Uint8Array(f.observation.bytes)]) assert.throws(() => createNativeInstallTransactionAck({ ...f, observation: { ...f.observation, bytes: bytes as Buffer } }))
})
test('strict identity grammar, exact fields, regular single-link file and size', () => {
  const f = fixture()
  const reject = (identity: unknown) => assert.throws(() => createNativeInstallTransactionAck({ ...f, observation: { ...f.observation, identity: identity as NativeInstallArtifactIdentity } }))
  for (const key of Object.keys(f.observation.identity)) {
    const missing: any = { ...f.observation.identity }; delete missing[key]; reject(missing)
    for (const value of ['', '01', '-0', '+1', '1.0', '1e2', ' 1', '1\n', '9'.repeat(41), 1, 1n, null]) reject({ ...f.observation.identity, [key]: value })
    if (!key.endsWith('Ns')) reject({ ...f.observation.identity, [key]: '-1' })
  }
  for (const patch of [{ mode: String(0o040700) }, { mode: String(0o120600) }, { mode: String(0o010600) }, { mode: '0' }, { mode: String(0o300600) }, { nlink: '0' }, { nlink: '2' }, { size: '999999' }, { extra: '1' }]) reject({ ...f.observation.identity, ...patch })
  reject(null); reject([])
  const maximum = '9'.repeat(NATIVE_INSTALL_TRANSACTION_ACK_IDENTITY_MAX_DIGITS)
  const ack = createNativeInstallTransactionAck({ ...f, observation: { ...f.observation, identity: { ...f.observation.identity, ino: maximum, mtimeNs: '-' + maximum } } })
  assert.equal(ack.identity.ino, maximum)
  reject({ ...f.observation.identity, isFile: () => true, ino: 10n ** 40n })
})
test('binding rejects changed UUID, plan, integration, receipt path and startup path', () => {
  const f = fixture(), ack = createNativeInstallTransactionAck(f), bytes = json(ack)
  const changed = [
    { ...f.transaction, transactionId: randomUUID() },
    { ...f.transaction, artifacts: f.transaction.artifacts.map((item, index) => index === 0 && item.state === 'present' ? { ...item, expected: { ...item.expected!, mode: 0o700 } } : item) },
    { ...f.transaction, artifacts: f.transaction.artifacts.map((item, index) => index === 0 && item.state === 'present' ? { ...item, expected: { ...item.expected!, bytes: item.expected!.bytes + 1 } } : item) },
    { ...f.transaction, extra: true },
  ]
  for (const transaction of changed) {
    assert.throws(() => decodeNativeInstallTransactionAck(bytes, transaction, f.integration))
    assert.throws(() => encodeNativeInstallTransactionAck(ack, transaction, f.integration))
  }
  assert.throws(() => decodeNativeInstallTransactionAck(bytes, f.transaction, { ...f.integration, root: '/changed' }))
  for (const path of [f.transaction.receiptPath, f.transaction.artifacts.at(-1)!.path]) assert.throws(() => decodeNativeInstallTransactionAck(json({ ...ack, path }), f.transaction, f.integration))
})
test('strict canonical decoder and encoder reject missing/extra keys and altered fields', () => {
  const f = fixture(), ack = createNativeInstallTransactionAck(f), bytes = json(ack)
  const reject = (value: any) => { assert.throws(() => decodeNativeInstallTransactionAck(json(value), f.transaction, f.integration)); assert.throws(() => encodeNativeInstallTransactionAck(value, f.transaction, f.integration)) }
  for (const location of ['', 'expected', 'identity', 'scope']) {
    const target = location ? (ack as any)[location] : ack
    for (const key of [...Object.keys(target), 'extra']) {
      const value = JSON.parse(bytes.toString()), object = location ? value[location] : value
      if (key === 'extra') object.extra = true; else delete object[key]
      reject(value)
    }
  }
  for (const patch of [{ schemaVersion: 2 }, { kind: 'receipt' }, { transactionId: randomUUID() }, { transactionSha256: '0'.repeat(64) }, { artifactIndex: 1 }, { path: '/wrong' }, { expected: { ...ack.expected, bytes: ack.expected.bytes + 1 } }, { expected: { ...ack.expected, sha256: '0'.repeat(64) } }, { identity: { ...ack.identity, nlink: '2' } }]) reject({ ...ack, ...patch })
  for (const key of Object.keys(ack.scope)) reject({ ...ack, scope: { ...ack.scope, [key]: true } })
  for (const bad of [Buffer.alloc(NATIVE_INSTALL_TRANSACTION_ACK_MAX_BYTES + 1), Buffer.from([255]), Buffer.from('{'), bytes.subarray(0, -1), Buffer.concat([Buffer.from([239, 187, 191]), bytes]), Buffer.from(JSON.stringify(ack, null, 2) + '\n'), Buffer.from(bytes.toString().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')), json({ kind: ack.kind, ...Object.fromEntries(Object.entries(ack).filter(([key]) => key !== 'kind')) })]) assert.throws(() => decodeNativeInstallTransactionAck(bad, f.transaction, f.integration))
  // Canonical invented observations still decode: this is data, not authentication.
  assert.equal(decodeNativeInstallTransactionAck(json({ ...ack, identity: { ...ack.identity, ino: '999' } }), f.transaction, f.integration).identity.ino, '999')
})
test('acknowledgement runtime module is allowlisted, tests are excluded', () => {
  assert.equal(isPublicFile('scripts/native-install-transaction-ack.ts'), true)
  assert.equal(isPublicFile('test/native-install-transaction-ack.test.ts'), false)
})
