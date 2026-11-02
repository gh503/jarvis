import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { resolve, join } from 'node:path'
import { test } from 'node:test'
import { describeNativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { createNativeInstallIntent, decodeNativeInstallIntent, encodeNativeInstallIntent, NATIVE_INSTALL_INTENT_MAX_BYTES, type NativeInstallArtifactExpected } from '../scripts/native-install-intent.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function fixture(platform: 'darwin' | 'win32' = 'darwin', autostart = false) {
  const base = resolve('nonexistent-intent-fixture')
  const integration: InstallOptions = { platform, root: join(base, 'current-package'), home: join(base, 'home'), appData: join(base, 'roaming'), localAppData: join(base, 'local'), arch: process.arch, runPowerShell() { throw new Error('Execution forbidden') } }
  const binding = { root: join(base, 'original-package'), autostart, configFile: join(base, 'config.env'), dataDir: join(base, 'data') }
  const layout = describeNativeIntegration(integration)
  const paths = autostart ? layout.artifactPaths : layout.artifactPaths.slice(0, -1)
  const expectedArtifacts: Record<string, NativeInstallArtifactExpected | null> = Object.fromEntries(paths.map((path, index) => [path, { sha256: hash(Buffer.from(String(index))), bytes: 1, mode: index === 1 && platform === 'darwin' ? 0o755 : 0o644 }]))
  const receiptObject = { schemaVersion: 1, platform, ...binding, ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: paths.map(path => ({ path, sha256: expectedArtifacts[path]!.sha256 })) }
  const expectedReceipt = Buffer.from(JSON.stringify(receiptObject, null, 2) + '\n')
  return { integration, binding, layout, expectedArtifacts, expectedReceipt, receiptObject }
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')
for (const platform of ['darwin', 'win32'] as const) for (const autostart of [false, true]) {
  test(`${platform} intent fixed slots, authoritative moved binding, autostart=${autostart}`, () => {
    const f = fixture(platform, autostart)
    const intent = createNativeInstallIntent(f)
    assert.deepEqual(intent.binding, f.binding)
    assert.notEqual(intent.binding.root, f.integration.root)
    assert.deepEqual(intent.artifacts.map(entry => entry.path), f.layout.artifactPaths)
    assert.deepEqual(intent.artifacts.map(entry => entry.included), f.layout.artifactPaths.map((_, index) => index < f.layout.artifactPaths.length - 1 || autostart))
    assert.deepEqual(intent.receipt, { sha256: hash(f.expectedReceipt), bytes: f.expectedReceipt.length })
    assert.deepEqual(intent.scope, { ownership: false, execution: false, automaticCleanup: false })
    const bytes = encodeNativeInstallIntent(intent, f.integration)
    assert.ok(bytes.length <= NATIVE_INSTALL_INTENT_MAX_BYTES)
    assert.ok(bytes.equals(json(intent)))
    assert.deepEqual(decodeNativeInstallIntent(bytes, f.integration), intent)
    for (const value of [intent, intent.binding, intent.scope, intent.artifacts, intent.receipt, ...intent.artifacts, ...intent.artifacts.map(entry => entry.expected).filter(Boolean)]) assert.ok(Object.isFrozen(value))
    assert.throws(() => decodeNativeInstallIntent(bytes, { ...f.integration, home: join(f.integration.home, 'elsewhere'), appData: join(f.integration.appData!, 'elsewhere') }))
    assert.throws(() => decodeNativeInstallIntent(bytes, { ...f.integration, platform: platform === 'darwin' ? 'win32' : 'darwin' }))
  })
}
test('pending Windows shortcuts remain unknown; excluded startup cannot have expectations', () => {
  const f = fixture('win32')
  const intent = createNativeInstallIntent({ integration: f.integration, binding: f.binding })
  assert.equal(intent.receipt, null)
  assert.deepEqual(intent.artifacts.map(entry => entry.expected), [null, null])
  assert.deepEqual(decodeNativeInstallIntent(encodeNativeInstallIntent(intent, f.integration), f.integration), intent)
  assert.throws(() => createNativeInstallIntent({ ...f, expectedArtifacts: {} }))
  assert.throws(() => createNativeInstallIntent({ ...f, expectedArtifacts: { ...f.expectedArtifacts, [f.layout.artifactPaths[1]!]: f.expectedArtifacts[f.layout.artifactPaths[0]!]! } }))
})
test('construction rejects unknown maps, invalid bindings and invalid expected metadata', () => {
  const f = fixture()
  assert.throws(() => createNativeInstallIntent({ ...f, expectedArtifacts: { arbitrary: null } }))
  assert.throws(() => createNativeInstallIntent({ ...f, binding: { root: f.binding.root, autostart: false, configFile: f.binding.configFile } }))
  assert.throws(() => createNativeInstallIntent({ ...f, binding: { ...f.binding, root: 'relative' } }))
  const path = f.layout.artifactPaths[0]!
  for (const patch of [{ sha256: 'A'.repeat(64) }, { bytes: -1 }, { bytes: 0.5 }, { bytes: Infinity }, { bytes: 1024 * 1024 + 1 }, { mode: -1 }, { mode: 0o10000 }, { mode: 1.5 }, { extra: true }]) {
    assert.throws(() => createNativeInstallIntent({ ...f, expectedArtifacts: { ...f.expectedArtifacts, [path]: { ...f.expectedArtifacts[path]!, ...patch } } }))
  }
  const inherited = Object.create({ arbitrary: { secret: true } })
  const pending = createNativeInstallIntent({ integration: f.integration, binding: f.binding, expectedArtifacts: inherited })
  assert.ok(pending.artifacts.every(entry => entry.expected === null))
  assert.ok(!encodeNativeInstallIntent(pending, f.integration).includes('secret'))
})
test('expected receipt must parse and agree with binding, paths and every included digest', () => {
  const f = fixture()
  for (const patch of [{ root: join(f.binding.root, 'wrong') }, { autostart: true }, { configFile: join(f.binding.root, 'wrong.env') }, { dataDir: join(f.binding.root, 'wrong-data') }, { files: [{ path: f.layout.artifactPaths[0], sha256: '0'.repeat(64) }, f.receiptObject.files[1]] }, { files: [] }, { extra: true }]) {
    assert.throws(() => createNativeInstallIntent({ ...f, expectedReceipt: Buffer.from(JSON.stringify({ ...f.receiptObject, ...patch }, null, 2) + '\n') }))
  }
  for (const expectedReceipt of [Buffer.alloc(65537), Buffer.alloc(0), json(f.receiptObject)]) assert.throws(() => createNativeInstallIntent({ ...f, expectedReceipt }))
})
test('decoder rejects unknown/duplicate keys, reordered slots and fields, noncanonical and malformed input', () => {
  const f = fixture(), intent = createNativeInstallIntent(f), bytes = encodeNativeInstallIntent(intent, f.integration)
  const mutate = (fn: (value: any) => void) => { const value = JSON.parse(bytes.toString()); fn(value); return json(value) }
  const bad = [
    Buffer.alloc(NATIVE_INSTALL_INTENT_MAX_BYTES + 1, 32), Buffer.from([0xff]), Buffer.from('{'), Buffer.alloc(0),
    Buffer.from(bytes.toString().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
    Buffer.from(bytes.toString().replace('"root":', '"root":"ignored","root":')),
    Buffer.from(JSON.stringify(intent, null, 2) + '\n'), bytes.subarray(0, -1), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
    json({ kind: intent.kind, schemaVersion: intent.schemaVersion, ...Object.fromEntries(Object.entries(intent).slice(2)) }),
    mutate(v => { v.extra = true }), mutate(v => { v.binding.extra = true }), mutate(v => { v.scope.ownership = true }),
    mutate(v => { v.scope.execution = true }), mutate(v => { v.scope.automaticCleanup = true }), mutate(v => { v.stage = 'published' }),
    mutate(v => { v.artifacts.reverse() }), mutate(v => { v.artifacts.pop() }), mutate(v => { v.artifacts[1] = v.artifacts[0] }),
    mutate(v => { v.artifacts[0].path = '/arbitrary' }), mutate(v => { v.artifacts[0].included = false }),
    mutate(v => { v.artifacts[0].expected = null }), mutate(v => { v.artifacts[0].extra = true }),
    mutate(v => { v.receipt.bytes = 0 }), mutate(v => { v.receipt.bytes = 65537 }), mutate(v => { v.receipt.raw = 'secret' }),
    mutate(v => { v.binding.dataDir = null }), mutate(v => { v.binding.autostart = 1 }),
  ]
  for (const value of bad) assert.throws(() => decodeNativeInstallIntent(value, f.integration))
})
test('size limit applies to UTF-8 bytes at construction and before parsing', () => {
  const f = fixture()
  assert.throws(() => createNativeInstallIntent({ integration: f.integration, binding: { ...f.binding, configFile: resolve('界'.repeat(6000)) } }))
  const original = JSON.parse
  JSON.parse = () => { throw new Error('parse must not run') }
  try { assert.throws(() => decodeNativeInstallIntent(Buffer.alloc(16385), f.integration), /Unsafe native install intent/) } finally { JSON.parse = original }
})
test('codec performs no filesystem or process operations', () => {
  const f = fixture(), restorations: (() => void)[] = []
  for (const module of [fs, fsPromises, childProcess]) for (const key of Object.keys(module)) {
    if (typeof (module as any)[key] !== 'function') continue
    const descriptor = Object.getOwnPropertyDescriptor(module, key)
    if (!descriptor?.writable) continue
    const original = (module as any)[key]
    ;(module as any)[key] = () => { throw new Error(`Forbidden IO: ${key}`) }
    restorations.push(() => { (module as any)[key] = original })
  }
  syncBuiltinESMExports()
  try {
    const intent = createNativeInstallIntent(f)
    assert.deepEqual(decodeNativeInstallIntent(encodeNativeInstallIntent(intent, f.integration), f.integration), intent)
  } finally { for (const restore of restorations) restore(); syncBuiltinESMExports() }
})
