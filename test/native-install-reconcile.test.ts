import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { resolve, join } from 'node:path'
import { test } from 'node:test'
import { describeNativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { createNativeInstallIntent, type NativeInstallArtifactExpected } from '../scripts/native-install-intent.ts'
import { reconcileNativeInstallIntent, type NativeInstallObservation, type NativeInstallObservations } from '../scripts/native-install-reconcile.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
function fixture(platform: 'darwin' | 'win32' = 'darwin', autostart = false) {
  const base = resolve('nonexistent-reconcile-fixture')
  const integration: InstallOptions = { platform, root: join(base, 'current'), home: join(base, 'home'), appData: join(base, 'roaming'), localAppData: join(base, 'local'), arch: process.arch, runPowerShell() { throw new Error('Forbidden execution') } }
  const binding = { root: join(base, 'original-secret-root'), autostart, configFile: join(base, 'secret.env'), dataDir: join(base, 'secret-data') }
  const layout = describeNativeIntegration(integration)
  const expectedArtifacts: Record<string, NativeInstallArtifactExpected> = {}
  const artifacts: NativeInstallObservation[] = layout.artifactPaths.map((path, index) => {
    if (!autostart && index === layout.artifactPaths.length - 1) return { path, state: 'absent' }
    const bytes = Buffer.from(`private-payload-${index}`), mode = index === 1 ? 0o755 : 0o644
    expectedArtifacts[path] = { sha256: hash(bytes), bytes: bytes.length, mode }
    return { path, state: 'file', bytes, mode }
  })
  const receiptObject = { schemaVersion: 1, platform, ...binding, ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: Object.entries(expectedArtifacts).map(([path, expected]) => ({ path, sha256: expected.sha256 })) }
  const expectedReceipt = json(receiptObject)
  const intent = createNativeInstallIntent({ integration, binding, expectedArtifacts, expectedReceipt })
  const observations: NativeInstallObservations = { artifacts, receipt: { path: layout.receiptPath, state: 'file', bytes: expectedReceipt } }
  return { integration, binding, expectedArtifacts, expectedReceipt, receiptObject, intent, observations }
}
const absent = (slot: NativeInstallObservation): NativeInstallObservation => ({ path: slot.path, state: 'absent' })
function withArtifact(f: ReturnType<typeof fixture>, index: number, patch: object) {
  return { ...f, observations: { ...f.observations, artifacts: f.observations.artifacts.map((slot, i) => i === index ? { ...slot, ...patch } as NativeInstallObservation : slot) } }
}
function withReceipt(f: ReturnType<typeof fixture>, bytes: Buffer) {
  return { ...f, observations: { ...f.observations, receipt: { path: f.intent.receiptPath, state: 'file' as const, bytes } } }
}
for (const platform of ['darwin', 'win32'] as const) for (const autostart of [false, true]) {
  test(`${platform}, autostart=${autostart}: consistent, unpublished, missing receipt and orphan receipt`, () => {
    const f = fixture(platform, autostart)
    assert.equal(reconcileNativeInstallIntent(f).status, 'consistent')
    assert.equal(reconcileNativeInstallIntent({ ...f, observations: { artifacts: f.observations.artifacts.map(absent), receipt: absent(f.observations.receipt) } }).status, 'unpublished')
    const missing = reconcileNativeInstallIntent({ ...f, observations: { ...f.observations, receipt: absent(f.observations.receipt) } })
    assert.equal(missing.status, 'incomplete')
    assert.equal(missing.receipt.status, 'missing')
    assert.equal(missing.scope.ownership, false)
    assert.equal(reconcileNativeInstallIntent({ ...f, observations: { ...f.observations, artifacts: f.observations.artifacts.map(absent) } }).status, 'incomplete')
    assert.equal(reconcileNativeInstallIntent({ ...f, observations: { ...f.observations, artifacts: f.observations.artifacts.map((slot, i) => i === 0 ? absent(slot) : slot) } }).status, 'incomplete')
  })
}
test('unknown Windows artifacts and unknown receipt cannot establish consistency; precedence is conservative', () => {
  const f = fixture('win32', true)
  const intent = createNativeInstallIntent({ integration: f.integration, binding: f.binding })
  const unknown = { ...f, intent }
  const report = reconcileNativeInstallIntent(unknown)
  assert.equal(report.status, 'indeterminate')
  assert.ok(report.artifacts.every(slot => slot.status === 'unverified'))
  assert.equal(report.receipt.status, 'unverified')
  const contradictory = withReceipt(unknown, json({ ...f.receiptObject, files: f.receiptObject.files.map(file => ({ ...file, sha256: '0'.repeat(64) })) }))
  assert.equal(reconcileNativeInstallIntent(contradictory).receipt.reason, 'files-mismatch')
  assert.equal(reconcileNativeInstallIntent(contradictory).status, 'conflict')
  assert.equal(reconcileNativeInstallIntent({ ...unknown, observations: { ...unknown.observations, receipt: absent(unknown.observations.receipt) } }).status, 'indeterminate')
  assert.equal(reconcileNativeInstallIntent({ ...unknown, observations: { ...unknown.observations, artifacts: unknown.observations.artifacts.map(absent) } }).status, 'indeterminate')
  assert.equal(reconcileNativeInstallIntent({ ...unknown, observations: { ...unknown.observations, receipt: { path: f.intent.receiptPath, state: 'unsafe' } } }).status, 'conflict')
  const knownArtifacts = createNativeInstallIntent({ integration: f.integration, binding: f.binding, expectedArtifacts: f.expectedArtifacts })
  assert.equal(reconcileNativeInstallIntent({ ...f, intent: knownArtifacts }).status, 'indeterminate')
  assert.equal(reconcileNativeInstallIntent({ ...f, intent: knownArtifacts, observations: { ...f.observations, receipt: absent(f.observations.receipt) } }).status, 'incomplete')
})
test('unsafe slots and excluded startup files conflict even with unknown expectations', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const f = fixture(platform)
    const index = f.intent.artifacts.length - 1
    assert.equal(reconcileNativeInstallIntent(withArtifact(f, index, { state: 'file', bytes: Buffer.alloc(0) })).artifacts[index]!.reason, 'excluded-present')
    assert.equal(reconcileNativeInstallIntent(withArtifact(f, index, { state: 'unsafe' })).status, 'conflict')
    const artifacts = f.observations.artifacts.map(slot => ({ path: slot.path, state: 'unsafe' as const }))
    assert.equal(reconcileNativeInstallIntent({ ...f, observations: { ...f.observations, artifacts } }).status, 'conflict')
  }
})
test('known bytes, sizes, and full permission metadata must match, including special bits', () => {
  const f = fixture()
  for (const patch of [{ bytes: Buffer.from('different') }, { bytes: Buffer.from('x'.repeat(f.expectedArtifacts[f.intent.artifacts[0]!.path]!.bytes)) }, { mode: 0o600 }, { mode: 0o4644 }]) {
    assert.equal(reconcileNativeInstallIntent(withArtifact(f, 0, patch)).status, 'conflict')
  }
  const first = f.observations.artifacts[0]!
  assert.equal(reconcileNativeInstallIntent({ ...f, observations: { ...f.observations, artifacts: [{ path: first.path, state: 'file', bytes: (first as { bytes: Buffer }).bytes }, ...f.observations.artifacts.slice(1)] } }).artifacts[0]!.reason, 'mode-mismatch')
  for (const mode of [0, 0o4644, 0o2777, 0o7777]) {
    const intent = createNativeInstallIntent({ ...f, expectedArtifacts: { ...f.expectedArtifacts, [first.path]: { ...f.expectedArtifacts[first.path]!, mode } } })
    assert.equal(reconcileNativeInstallIntent({ ...withArtifact(f, 0, { mode }), intent }).status, 'consistent')
  }
})
test('receipt strict parsing, binding and included hashes are required even without known receipt digest', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const f = fixture(platform)
    const pending = { ...f, intent: createNativeInstallIntent({ integration: f.integration, binding: f.binding, expectedArtifacts: f.expectedArtifacts }) }
    for (const patch of [{ root: f.integration.root }, { configFile: join(f.binding.root, 'different.env') }, { dataDir: join(f.binding.root, 'different-data') }, { autostart: true }]) {
      assert.equal(reconcileNativeInstallIntent(withReceipt(pending, json({ ...f.receiptObject, ...patch }))).status, 'conflict')
    }
    const wrongHash = json({ ...f.receiptObject, files: f.receiptObject.files.map(file => ({ ...file, sha256: '0'.repeat(64) })) })
    assert.equal(reconcileNativeInstallIntent(withReceipt(pending, wrongHash)).receipt.reason, 'files-mismatch')
    assert.equal(reconcileNativeInstallIntent({ ...withReceipt(pending, wrongHash), observations: { ...withReceipt(pending, wrongHash).observations, artifacts: f.observations.artifacts.map(absent) } }).status, 'conflict')
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from('{'), Buffer.from(JSON.stringify(f.receiptObject)), json({ ...f.receiptObject, extra: true }), json({ ...f.receiptObject, files: [] }), Buffer.from(f.expectedReceipt.toString().replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1'))]) {
      assert.equal(reconcileNativeInstallIntent(withReceipt(f, bytes)).receipt.reason, 'invalid-receipt')
    }
    // Parser accepts key order, but known exact receipt bytes still differ.
    const { files, ...rest } = f.receiptObject
    assert.equal(reconcileNativeInstallIntent(withReceipt(f, json({ files, ...rest }))).receipt.reason, 'bytes-mismatch')
    const startup = f.intent.artifacts.at(-1)!.path
    assert.equal(reconcileNativeInstallIntent(withReceipt(pending, json({ ...f.receiptObject, files: [...files, { path: startup, sha256: '0'.repeat(64) }] }))).status, 'conflict')
  }
})
test('reject malformed observations, arbitrary paths, reordered/duplicate/extra slots and invalid metadata', () => {
  const f = fixture(), o = f.observations, first = o.artifacts[0]!
  const bad: unknown[] = [null, {}, { ...o, extra: true }, { ...o, artifacts: [] }, { ...o, artifacts: [...o.artifacts, first] }, { ...o, artifacts: [...o.artifacts].reverse() }, { ...o, artifacts: o.artifacts.map(() => first) }, { ...o, receipt: { ...o.receipt, path: '/arbitrary-secret' } }]
  for (const patch of [{ path: '/arbitrary-secret' }, { extra: true }, { state: 'directory' }, { bytes: 'string' }, { bytes: new Uint8Array(1) }, { bytes: undefined }, { bytes: Buffer.alloc(1024 * 1024 + 1) }, { mode: undefined }, { mode: -1 }, { mode: 0o10000 }, { mode: 0o100644 }, { mode: 1.5 }, { mode: NaN }, { state: 'absent' }, { state: 'unsafe' }]) bad.push(withArtifact(f, 0, patch).observations)
  bad.push(withReceipt(f, Buffer.alloc(64 * 1024 + 1)).observations)
  const sparse = [...o.artifacts]; delete sparse[0]; bad.push({ ...o, artifacts: sparse })
  const extraArray = [...o.artifacts]; Object.defineProperty(extraArray, 'extra', { value: true }); bad.push({ ...o, artifacts: extraArray })
  const symbolSlot = { ...first, [Symbol('extra')]: true }; bad.push({ ...o, artifacts: [symbolSlot, ...o.artifacts.slice(1)] })
  const accessor = { ...first }; Object.defineProperty(accessor, 'bytes', { get() { assert.fail('accessor must not execute') } }); bad.push({ ...o, artifacts: [accessor, ...o.artifacts.slice(1)] })
  for (const observations of bad) assert.throws(() => reconcileNativeInstallIntent({ ...f, observations: observations as NativeInstallObservations }), /^Error: Invalid native install observations$/)
  assert.throws(() => reconcileNativeInstallIntent({ ...f, intent: { ...f.intent, artifacts: [...f.intent.artifacts].reverse() } }))
  assert.throws(() => reconcileNativeInstallIntent({ ...f, intent: undefined as any }))
})
test('limits permit exact-size artifacts and receipts; malformed bounded receipts become conflicts', () => {
  const f = fixture(), path = f.intent.artifacts[0]!.path, bytes = Buffer.alloc(1024 * 1024)
  const expectedArtifacts = { ...f.expectedArtifacts, [path]: { sha256: hash(bytes), bytes: bytes.length, mode: 0o644 } }
  const intent = createNativeInstallIntent({ integration: f.integration, binding: f.binding, expectedArtifacts })
  const report = reconcileNativeInstallIntent({ ...withArtifact(f, 0, { bytes }), intent, observations: { ...withArtifact(f, 0, { bytes }).observations, receipt: absent(f.observations.receipt) } })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.artifacts[0]!.status, 'matching')
  assert.equal(reconcileNativeInstallIntent(withReceipt(f, Buffer.alloc(64 * 1024))).receipt.reason, 'invalid-receipt')
})
test('report is deeply immutable, bounded and contains no payload, digests or binding paths', () => {
  const f = fixture(), intent = structuredClone(f.intent)
  const report = reconcileNativeInstallIntent({ ...f, intent })
  for (const value of [report, report.scope, report.artifacts, report.receipt, ...report.artifacts]) assert.ok(Object.isFrozen(value))
  assert.deepEqual(report.scope, { ownership: false, execution: false, automaticCleanup: false, atomicity: false })
  const before = JSON.stringify(report)
  assert.ok(before.length < 4096)
  for (const secret of [f.binding.root, f.binding.configFile, f.binding.dataDir, 'private-payload', ...Object.values(f.expectedArtifacts).map(value => value.sha256)]) assert.ok(!before.includes(secret))
  ;(f.observations.artifacts[0] as { bytes: Buffer }).bytes.fill(0)
  ;(intent.artifacts[0] as { path: string }).path = '/changed'
  assert.equal(JSON.stringify(report), before)
  assert.throws(() => { (report.scope as any).ownership = true }, TypeError)
})
test('classifier performs no filesystem or child-process IO', () => {
  const fixtures = [fixture(), fixture('win32', true)], restorations: (() => void)[] = []
  let calls = 0
  for (const module of [fs, fsPromises, childProcess]) for (const key of Object.keys(module)) {
    if (typeof (module as any)[key] !== 'function' || !Object.getOwnPropertyDescriptor(module, key)?.writable) continue
    const original = (module as any)[key]
    ;(module as any)[key] = () => { calls++; throw new Error(`Forbidden IO: ${key}`) }
    restorations.push(() => { (module as any)[key] = original })
  }
  syncBuiltinESMExports()
  try {
    for (const f of fixtures) {
      assert.equal(reconcileNativeInstallIntent(f).status, 'consistent')
      assert.equal(reconcileNativeInstallIntent(withReceipt(f, Buffer.from('{'))).status, 'conflict')
      const intent = createNativeInstallIntent({ integration: f.integration, binding: f.binding })
      assert.equal(reconcileNativeInstallIntent({ ...f, intent }).status, 'indeterminate')
    }
    assert.equal(calls, 0)
  } finally { for (const restore of restorations) restore(); syncBuiltinESMExports() }
})
