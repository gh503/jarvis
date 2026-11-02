import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { describeNativeIntegration, nativeIntegration, readNativeIntegrationSlot, type InstallOptions } from '../scripts/install-native.ts'
import { diagnoseNativeInstallIntent } from '../scripts/native-install-diagnose.ts'
import { createNativeInstallIntent, type NativeInstallArtifactExpected } from '../scripts/native-install-intent.ts'
import { writeNativeInstallIntent } from '../scripts/native-install-intent-store.ts'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function fixture(t: test.TestContext, platform: 'darwin' | 'win32' = 'darwin', installed = true, unknown = false) {
  const base = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'native-diagnose-'))
  t.after(async () => { assert.ok(base.startsWith(join(await fs.realpath(tmpdir()), 'native-diagnose-'))); await fs.rm(base, { recursive: true, force: true }) })
  const integration: InstallOptions = { platform, root: join(base, 'package'), home: join(base, 'home'), appData: join(base, 'roaming'), localAppData: join(base, 'local'), arch: process.arch }
  const layout = describeNativeIntegration(integration)
  if (installed) {
    const files = []
    for (const path of [`runtime/${platform === 'win32' ? 'node.exe' : 'node'}`, 'scripts/app.ts', 'scripts/install-native.ts', 'src/main.ts']) {
      const bytes = Buffer.from('fixture')
      await fs.mkdir(dirname(join(integration.root, path)), { recursive: true })
      await fs.writeFile(join(integration.root, path), bytes)
      files.push({ path, bytes: bytes.length, sha256: hash(bytes) })
    }
    await fs.writeFile(join(integration.root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, platform, arch: process.arch, runtime: { version: 'v24.14.0', platform, arch: process.arch }, files }))
    integration.runPowerShell = (_script, env) => writeFileSync(env.JARVIS_LINK_PATH!, Buffer.from([0, 255, 13, 10]), { mode: 0o600 })
    await nativeIntegration(integration, ['--install'])
  }
  integration.runPowerShell = () => { throw new Error('Diagnosis must not invoke integration COM') }
  const expectedArtifacts: Record<string, NativeInstallArtifactExpected> = {}
  if (installed && !unknown) for (const path of layout.artifactPaths.slice(0, -1)) {
    const bytes = await fs.readFile(path)
    expectedArtifacts[path] = { sha256: hash(bytes), bytes: bytes.length, mode: (await fs.lstat(path)).mode & 0o7777 }
  }
  const intent = createNativeInstallIntent({ integration, binding: { root: integration.root, autostart: false }, ...(installed && !unknown ? { expectedArtifacts, expectedReceipt: await fs.readFile(layout.receiptPath) } : {}) })
  const intentPath = join(dirname(layout.receiptPath), 'native-install-control', 'install-intent.json')
  return { base, integration, intent, intentPath, ...layout }
}
async function fileSnapshot(path: string) {
  const stat = await fs.lstat(path, { bigint: true })
  return { bytes: await fs.readFile(path), metadata: ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs'].map(key => stat[key as keyof typeof stat]) }
}
for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: diagnoses real installed bytes without mutating or executing integration`, async t => {
    const f = await fixture(t, platform)
    await writeNativeInstallIntent(f)
    const paths = [f.intentPath, f.receiptPath, ...f.artifactPaths.slice(0, -1)]
    const before = await Promise.all(paths.map(fileSnapshot))
    const report = await diagnoseNativeInstallIntent(f)
    assert.equal(report.status, 'consistent')
    assert.deepEqual(await Promise.all(paths.map(fileSnapshot)), before)
    assert.deepEqual(report.scope, { ownership: false, execution: false, automaticCleanup: false, atomicity: false })
    assert.ok(Object.isFrozen(report)); assert.ok(Object.isFrozen(report.scope))
    for (const object of [report.receipt, report.artifacts, ...report.artifacts]) assert.ok(Object.isFrozen(object))
    assert.ok(!JSON.stringify(report).includes('sha256'))
    assert.ok(!JSON.stringify(report).includes(f.integration.root))
    // Consistency is observational: it must not grant mutation/retirement authority.
    await assert.rejects(nativeIntegration(f.integration, ['--uninstall']), /Existing native install intent requires review/)
    await assert.rejects(nativeIntegration(f.integration, ['--install']), /Existing native install intent requires review/)
    assert.deepEqual(await diagnoseNativeInstallIntent(f), report)
    assert.deepEqual(await Promise.all(paths.map(fileSnapshot)), before)
  })
  test(`${platform}: missing intent with orphan artifacts is explicitly no-intent`, async t => {
    const f = await fixture(t, platform)
    const report = await diagnoseNativeInstallIntent(f)
    assert.equal(report.status, 'no-intent')
    assert.deepEqual(Object.keys(report).sort(), ['scope', 'status'])
    assert.ok(Object.isFrozen(report))
    assert.ok((await fs.lstat(f.artifactPaths[0]!)).isFile())
  })
  test(`${platform}: all missing is unpublished only when intent exists`, async t => {
    const f = await fixture(t, platform, false)
    assert.equal((await diagnoseNativeInstallIntent(f)).status, 'no-intent')
    await writeNativeInstallIntent(f)
    assert.equal((await diagnoseNativeInstallIntent(f)).status, 'unpublished')
  })
  test(`${platform}: missing receipt still observes payloads and excluded startup`, async t => {
    const f = await fixture(t, platform)
    await writeNativeInstallIntent(f)
    assert.equal(f.receiptPath, describeNativeIntegration(f.integration).receiptPath)
    await fs.unlink(f.receiptPath)
    const report = await diagnoseNativeInstallIntent(f)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.artifacts[0]!.status, 'matching')
    const startup = f.artifactPaths.at(-1)!
    await fs.mkdir(dirname(startup), { recursive: true })
    await fs.writeFile(startup, 'orphan')
    assert.equal((await diagnoseNativeInstallIntent(f)).status, 'conflict')
  })
  test(`${platform}: unknown expectations remain indeterminate`, async t => {
    const f = await fixture(t, platform, true, true)
    await writeNativeInstallIntent(f)
    assert.equal((await diagnoseNativeInstallIntent(f)).status, 'indeterminate')
  })
}
for (const kind of ['tamper', 'directory', 'symlink', 'hardlink', 'fifo', 'oversized', 'permissions'] as const) test(`unsafe artifact ${kind} conflicts despite missing receipt`, { skip: process.platform === 'win32' && ['fifo', 'symlink', 'permissions'].includes(kind) }, async t => {
  const f = await fixture(t)
  await writeNativeInstallIntent(f)
  const target = f.artifactPaths[0]!
  assert.ok(f.artifactPaths.includes(target)); await fs.unlink(target)
  assert.equal(f.receiptPath, describeNativeIntegration(f.integration).receiptPath); await fs.unlink(f.receiptPath)
  if (kind === 'directory') await fs.mkdir(target)
  else if (kind === 'fifo') execFileSync('mkfifo', [target])
  else if (kind === 'symlink' || kind === 'hardlink') {
    const source = join(f.base, 'source')
    await fs.writeFile(source, 'secret')
    if (kind === 'symlink') await fs.symlink(source, target)
    else await fs.link(source, target)
  } else {
    await fs.writeFile(target, kind === 'oversized' ? Buffer.alloc(1024 * 1024 + 1) : 'tampered', { mode: 0o644 })
    if (kind === 'permissions') await fs.chmod(target, 0o666)
  }
  const report = await diagnoseNativeInstallIntent(f)
  assert.equal(report.status, 'conflict')
  assert.equal(report.artifacts[0]!.reason, kind === 'tamper' ? 'bytes-mismatch' : 'unsafe')
})
test('fixed-slot reader rejects arbitrary paths before filesystem IO', async t => {
  const f = await fixture(t, 'darwin', false)
  const original = fs.lstat
  let calls = 0
  fs.lstat = (async () => { calls++; throw new Error('Unexpected metadata IO') }) as typeof fs.lstat
  syncBuiltinESMExports()
  try {
    await assert.rejects(readNativeIntegrationSlot(f.integration, join(f.base, 'unrelated-secret')), /Unknown integration location/)
    assert.equal(calls, 0)
  } finally { fs.lstat = original; syncBuiltinESMExports() }
})
test('malformed stored intent fails instead of claiming no intent', async t => {
  const f = await fixture(t)
  await writeNativeInstallIntent(f)
  await fs.writeFile(f.intentPath, '{')
  await assert.rejects(diagnoseNativeInstallIntent(f))
})
test('environmental read failures become unsafe conflicts, never missing or raw messages', async t => {
  const f = await fixture(t)
  await writeNativeInstallIntent(f)
  const original = fs.open
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === f.artifactPaths[0]) throw Object.assign(new Error('SECRET EIO'), { code: 'EIO' })
    return original(...args)
  }) as typeof fs.open
  syncBuiltinESMExports()
  try {
    const report = await diagnoseNativeInstallIntent(f)
    assert.equal(report.status, 'conflict')
    assert.ok(!JSON.stringify(report).includes('SECRET'))
  } finally { fs.open = original; syncBuiltinESMExports() }
})
for (const mutation of ['artifact-replacement', 'intent-replacement', 'absent-startup-appears'] as const) test(`detects cross-window ${mutation}`, async t => {
  const f = await fixture(t)
  await writeNativeInstallIntent(f)
  const original = fs.open
  let mutated = false
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    // The receipt is captured first in both passes. Mutate at the second receipt
    // opening, after every initial artifact observation (including absence).
    if (args[0] === f.receiptPath) {
      receiptReads++
      if (receiptReads === 2) {
        mutated = true
        const path = mutation === 'intent-replacement' ? f.intentPath : mutation === 'artifact-replacement' ? f.artifactPaths[0]! : f.artifactPaths.at(-1)!
        if (mutation === 'absent-startup-appears') {
          await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, 'new startup')
        } else {
          const bytes = await fs.readFile(path), stat = await fs.lstat(path)
          const temporary = join(f.base, 'replacement')
          await fs.writeFile(temporary, bytes, { mode: stat.mode & 0o7777 })
          assert.ok(path === f.intentPath || f.artifactPaths.includes(path)); assert.equal(temporary, join(f.base, 'replacement'))
          await fs.rename(temporary, path)
        }
      }
    }
    return handle
  }) as typeof fs.open
  let receiptReads = 0
  syncBuiltinESMExports()
  try {
    if (mutation === 'intent-replacement') await assert.rejects(diagnoseNativeInstallIntent(f), /intent changed/)
    else assert.equal((await diagnoseNativeInstallIntent(f)).status, 'conflict')
    assert.ok(mutated)
  } finally { fs.open = original; syncBuiltinESMExports() }
})
