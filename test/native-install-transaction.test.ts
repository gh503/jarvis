import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { test } from 'node:test'
import { describeNativeIntegration, renderNativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { createNativeInstallTransaction, decodeNativeInstallTransaction, encodeNativeInstallTransaction, NATIVE_INSTALL_TRANSACTION_MAX_BYTES } from '../scripts/native-install-transaction.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const json = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')
const receiptJson = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
function fixture(platform: 'darwin' | 'win32' = 'darwin', configured = true) {
  const base = resolve('nonexistent-transaction-fixture')
  const integration: InstallOptions = { platform, root: join(base, 'package'), home: join(base, 'home'), appData: join(base, 'roaming'), localAppData: join(base, 'local'), arch: process.arch, runPowerShell() { throw new Error('Execution forbidden') } }
  const binding = { root: integration.root, autostart: false, ...(configured ? { configFile: join(base, 'config.env'), dataDir: join(base, 'data') } : {}) }
  const layout = describeNativeIntegration(integration)
  const plan = renderNativeIntegration(integration, false, binding.configFile)
  const artifacts = plan.platform === 'darwin' ? plan.artifacts : plan.shortcuts.map(item => ({ path: item.path, bytes: Buffer.from([0, 255, 5, 10]), mode: 0o600 }))
  const receiptObject = { schemaVersion: 1, platform, ...binding, ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: artifacts.map(item => ({ path: item.path, sha256: hash(item.bytes) })) }
  return { integration, binding, layout, artifacts, receiptObject, receipt: receiptJson(receiptObject), transactionId: randomUUID() }
}
for (const platform of ['darwin', 'win32'] as const) for (const configured of [false, true]) {
  test(`${platform} complete fresh prepared transaction, configured=${configured}`, () => {
    const f = fixture(platform, configured), transaction = createNativeInstallTransaction(f)
    assert.deepEqual(transaction.binding, f.binding)
    assert.deepEqual(transaction.predecessor, [...f.layout.artifactPaths, f.layout.receiptPath].map(path => ({ path, state: 'absent' })))
    assert.deepEqual(transaction.artifacts.at(-1), { path: f.layout.artifactPaths.at(-1), state: 'absent', expected: null })
    for (const [index, item] of f.artifacts.entries()) assert.deepEqual(transaction.artifacts[index], { path: item.path, state: 'present', expected: { sha256: hash(item.bytes), bytes: item.bytes.length, mode: item.mode } })
    assert.deepEqual(transaction.receipt, { sha256: hash(f.receipt), bytes: f.receipt.length, base64: f.receipt.toString('base64') })
    const bytes = encodeNativeInstallTransaction(transaction, f.integration)
    assert.ok(bytes.equals(json(transaction)))
    assert.deepEqual(decodeNativeInstallTransaction(bytes, f.integration), transaction)
    const frozen = (value: unknown) => { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen) } }
    frozen(transaction); frozen(decodeNativeInstallTransaction(bytes, f.integration))
    f.artifacts[0]!.bytes.fill(1); f.artifacts[0]!.mode = 0; f.receipt.fill(0); f.artifacts.reverse()
    assert.ok(encodeNativeInstallTransaction(transaction, f.integration).equals(bytes))
    assert.throws(() => { (transaction.binding as any).root = '/changed' })
    assert.throws(() => decodeNativeInstallTransaction(bytes, { ...f.integration, root: join(f.integration.root, 'other') }))
    assert.throws(() => decodeNativeInstallTransaction(bytes, { ...f.integration, home: join(f.integration.home, 'other'), appData: join(f.integration.appData!, 'other') }))
  })
}
test('factory rejects mismatched artifact bytes, inventory, order and incomplete expectations', () => {
  const f = fixture()
  for (const artifacts of [[], f.artifacts.slice(1), [...f.artifacts].reverse(), [...f.artifacts, f.artifacts[0]!], [{ ...f.artifacts[0]!, path: '/other' }, f.artifacts[1]!], [{ ...f.artifacts[0]!, bytes: Buffer.from('wrong') }, f.artifacts[1]!], [{ ...f.artifacts[0]!, mode: -1 }, f.artifacts[1]!], [{ ...f.artifacts[0]!, bytes: Buffer.alloc(1024 * 1024 + 1) }, f.artifacts[1]!]]) assert.throws(() => createNativeInstallTransaction({ ...f, artifacts }))
  for (const files of [[...f.receiptObject.files].reverse(), [], [{ ...f.receiptObject.files[0]!, sha256: '0'.repeat(64) }, f.receiptObject.files[1]!]]) assert.throws(() => createNativeInstallTransaction({ ...f, receipt: receiptJson({ ...f.receiptObject, files }) }))
})
test('receipt binding, encoding, size and unsupported autostart are rejected', () => {
  const f = fixture()
  for (const patch of [{ root: join(f.integration.root, 'other') }, { dataDir: undefined }, { configFile: 'relative' }, { extra: true }, { autostart: true, files: [...f.receiptObject.files, { path: f.layout.artifactPaths.at(-1), sha256: '0'.repeat(64) }] }]) assert.throws(() => createNativeInstallTransaction({ ...f, receipt: receiptJson({ ...f.receiptObject, ...patch }) }))
  for (const receipt of [Buffer.alloc(65537), Buffer.alloc(0), json(f.receiptObject), Buffer.from([255])]) assert.throws(() => createNativeInstallTransaction({ ...f, receipt }))
  for (const transactionId of ['', '../transaction', '0'.repeat(32), randomUUID().toUpperCase(), '00000000-0000-0000-0000-000000000000']) assert.throws(() => createNativeInstallTransaction({ ...f, transactionId }))
})
test('strict decoder rejects malformed base64, expectations, unknown fields and noncanonical encodings', () => {
  const f = fixture(), transaction = createNativeInstallTransaction(f), bytes = encodeNativeInstallTransaction(transaction, f.integration)
  const mutate = (fn: (value: any) => void) => { const value = JSON.parse(bytes.toString()); fn(value); return json(value) }
  const mutations: ((v: any) => void)[] = [
    v => { v.schemaVersion = 2 }, v => { v.kind = 'native-install-intent' }, v => { v.extra = true }, v => { v.stage = 'completed' },
    v => { v.binding.autostart = true }, v => { v.binding.configFile += '.other' }, v => { v.binding.dataDir += '/other' }, v => { v.binding.extra = true },
    v => { v.predecessor.pop() }, v => { v.predecessor.reverse() }, v => { v.predecessor[0].state = 'present' }, v => { v.predecessor[0].extra = true },
    v => { v.artifacts.reverse() }, v => { v.artifacts[0].expected = null }, v => { v.artifacts[0].expected.sha256 = '0'.repeat(64) },
    v => { v.artifacts[0].expected.bytes = 1048577 }, v => { v.artifacts[0].expected.bytes = -1 }, v => { v.artifacts[0].expected.mode = 4096 }, v => { v.artifacts[0].expected.extra = true },
    v => { v.artifacts.at(-1).state = 'present' }, v => { v.artifacts.at(-1).expected = v.artifacts[0].expected },
    v => { v.receipt.sha256 = '0'.repeat(64) }, v => { v.receipt.bytes++ }, v => { v.receipt.extra = true },
    v => { v.receipt.base64 += '\n' }, v => { v.receipt.base64 = '*' }, v => { v.receipt.base64 = Buffer.alloc(65537).toString('base64') },
    v => { v.scope.replay = true }, v => { v.scope.atomicity = true }, v => { v.scope.ownership = true }, v => { v.scope.requestedMode = 'acl-authority' },
  ]
  for (const mutateValue of mutations) assert.throws(() => decodeNativeInstallTransaction(mutate(mutateValue), f.integration))
  for (const bad of [Buffer.alloc(NATIVE_INSTALL_TRANSACTION_MAX_BYTES + 1), Buffer.from([255]), Buffer.from('{'), bytes.subarray(0, -1), Buffer.concat([Buffer.from([239, 187, 191]), bytes]), receiptJson(transaction), Buffer.from(bytes.toString().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')), json({ kind: transaction.kind, ...Object.fromEntries(Object.entries(transaction).filter(([key]) => key !== 'kind')) })]) assert.throws(() => decodeNativeInstallTransaction(bad, f.integration))
  // A different spelling with nonzero padding bits decodes to the same bytes; reject it.
  const padded = fixture('win32')
  while (padded.receipt.length % 3 === 0) { padded.receiptObject.root += 'x'; padded.integration.root += 'x'; padded.receipt = receiptJson(padded.receiptObject) }
  const p = createNativeInstallTransaction(padded), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const encoded = p.receipt.base64, index = encoded.indexOf('=') - 1
  const alias = encoded.slice(0, index) + alphabet[alphabet.indexOf(encoded[index]!) + 1] + encoded.slice(index + 1)
  assert.ok(Buffer.from(alias, 'base64').equals(padded.receipt))
  assert.throws(() => decodeNativeInstallTransaction(json({ ...p, receipt: { ...p.receipt, base64: alias } }), padded.integration))
})
test('encoder and factory reject sparse inventories rather than skipping fixed slots', () => {
  const f = fixture(), transaction = createNativeInstallTransaction(f)
  const artifacts = [...f.artifacts]; delete artifacts[0]
  assert.throws(() => createNativeInstallTransaction({ ...f, artifacts }))
  const sparseArtifacts = [...transaction.artifacts]; delete sparseArtifacts[0]
  assert.throws(() => encodeNativeInstallTransaction({ ...transaction, artifacts: sparseArtifacts }, f.integration))
  const predecessor = [...transaction.predecessor]; delete predecessor[0]
  assert.throws(() => encodeNativeInstallTransaction({ ...transaction, predecessor }, f.integration))
})
test('artifact byte limit is inclusive and payload bytes are not persisted', () => {
  const f = fixture('win32')
  f.artifacts[0]!.bytes = Buffer.alloc(1024 * 1024, 42)
  f.receiptObject.files[0]!.sha256 = hash(f.artifacts[0]!.bytes)
  f.receipt = receiptJson(f.receiptObject)
  const transaction = createNativeInstallTransaction(f)
  assert.equal(transaction.artifacts[0]!.expected!.bytes, 1024 * 1024)
  assert.ok(encodeNativeInstallTransaction(transaction, f.integration).length < 4096)
})
