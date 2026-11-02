import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsPromises, { mkdtemp, mkdir, writeFile, readFile, rm, realpath, readdir, chmod, rename, stat } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRecoverySet, verifyRecoverySet } from '../scripts/native-recovery-set.ts'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
const digest = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex')
async function fixture(run: (o: { bundle: string; bundleManifestSha256: string; configFile: string; dataDir: string; destination: string }, root: string) => Promise<void>) {
  const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'jarvis-recovery-test-'))
  await ensurePrivateDataDirectory(root)
  try {
    const bundle = join(root, 'bundle'), dataDir = join(root, 'source-data'), configParent = join(root, 'source-config')
    for (const p of [bundle, dataDir, configParent]) { await mkdir(p, { mode: 0o700 }); await ensurePrivateDataDirectory(p) }
    const files = []
    for (const path of [`runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`, 'src/main.ts', 'scripts/app.ts', 'scripts/install-native.ts']) {
      await mkdir(dirname(join(bundle, path)), { recursive: true }); await writeFile(join(bundle, path), 'fixture')
      files.push({ path, bytes: 7, sha256: digest('fixture') })
    }
    const bytes = JSON.stringify({ schemaVersion: 1, version: '1.0.0', sourceTag: 'v1.0.0', sourceSha: 'a'.repeat(40), dirty: false, platform: process.platform, arch: process.arch, runtime: { version: 'v24.1.0', platform: process.platform, arch: process.arch }, files })
    await writeFile(join(bundle, 'manifest.json'), bytes)
    const configFile = join(configParent, 'config.env')
    await writeFile(configFile, `JARVIS_DATA_DIR="${dataDir}"\nJARVIS_AUTH_TOKEN=secret-fixture-token\n`, { mode: 0o600 })
    await writeFile(join(dataDir, 'state'), 'state fixture', { mode: 0o600 })
    await run({ bundle, bundleManifestSha256: digest(bytes), configFile, dataDir, destination: join(root, 'recovery') }, root)
  } finally { assert.equal(dirname(root), parent); await rm(root, { recursive: true, force: true }) }
}
test('coordinated capture has exact immutable scope, private layout and independently verified children', async () => fixture(async o => {
  const result = await createRecoverySet(o)
  assert.deepEqual((await readdir(o.destination)).sort(), ['config', 'data', 'recovery-manifest.json'])
  assert.equal(Object.isFrozen(result.manifest.scope), true)
  assert.deepEqual(result.manifest.scope, { kind: 'coordinated-stopped-recovery-set', coherence: 'conditional-on-all-other-writers-stopped', writers: 'cooperative-lifecycle-locks-and-stopped-other-writers-required', activation: 'none', schemaCompatibility: 'not-asserted', externalFiles: 'not-captured', baselineBundle: 'not-copied-must-remain-available', powerLossDurability: 'not-asserted', sameAccountConcurrentMutation: 'out-of-scope' })
  assert.equal(JSON.stringify(result.manifest).includes('secret-fixture-token'), false)
  assert.deepEqual(await verifyRecoverySet(result), result)
  if (process.platform !== 'win32') {
    assert.equal((await stat(o.destination)).mode & 0o777, 0o700)
    assert.equal((await stat(join(o.destination, 'recovery-manifest.json'))).mode & 0o777, 0o600)
  }
  await rename(o.configFile, o.configFile + '.moved'); await rename(o.dataDir, o.dataDir + '.moved')
  assert.deepEqual(await verifyRecoverySet(result), result)
  await writeFile(join(o.bundle, 'src/main.ts'), 'tampered')
  await assert.rejects(verifyRecoverySet(result), /Payload/)
}))
for (const role of ['launcher', 'runtime'] as const) test(`active ${role} owner produces no output`, async () => fixture(async o => {
  const release = await acquireLifecycleLock(o.dataDir, role, 0)
  try { await assert.rejects(createRecoverySet(o)); await assert.rejects(stat(o.destination), { code: 'ENOENT' }) }
  finally { release() }
}))
test('preflight rejects trusted hash errors, configuration mismatch, aliases and overlaps without output', async () => fixture(async (o, root) => {
  for (const changed of [ { bundleManifestSha256: 'bad' }, { bundleManifestSha256: '0'.repeat(64) }, { destination: join(o.bundle, 'output') }, { destination: join(o.dataDir, 'output') }, { destination: join(dirname(o.configFile), 'output') }, { destination: root }, { bundle: o.dataDir }, { bundle: dirname(o.configFile) }, { dataDir: o.bundle }, { bundle: o.bundle + '/.' } ]) {
    await assert.rejects(createRecoverySet({ ...o, ...changed }))
    await assert.rejects(stat(o.destination), { code: 'ENOENT' })
  }
}))
test('configuration privacy fails before output', { skip: process.platform === 'win32' }, async () => fixture(async o => {
  await chmod(o.configFile, 0o644)
  await assert.rejects(createRecoverySet(o))
  await assert.rejects(stat(o.destination), { code: 'ENOENT' })
}))
for (const target of ['config/config.env', 'data/payload/state', 'config/manifest.json', 'data/snapshot-manifest.json']) test(`rejects tampered child ${target}`, async () => fixture(async o => {
  const result = await createRecoverySet(o)
  await writeFile(join(o.destination, target), 'tampered', { mode: 0o600 })
  await assert.rejects(verifyRecoverySet(result))
}))
test('aggregate rejects missing trust, noncanonical JSON, extra fields, bad identity and oversized content', async () => fixture(async o => {
  const result = await createRecoverySet(o), path = join(o.destination, 'recovery-manifest.json')
  await assert.rejects(verifyRecoverySet({ ...result, manifestSha256: '' }))
  await assert.rejects(verifyRecoverySet({ ...result, manifestSha256: '0'.repeat(64) }))
  const variants = [JSON.stringify(result.manifest), JSON.stringify({ ...result.manifest, extra: true }) + '\n', JSON.stringify({ ...result.manifest, baseline: { ...result.manifest.baseline, arch: 'other' } }) + '\n', JSON.stringify({ ...result.manifest, sourceDataDir: o.dataDir + '-other' }) + '\n', JSON.stringify({ ...result.manifest, scope: {} }) + '\n', ' '.repeat(16385)]
  for (const bytes of variants) { await writeFile(path, bytes); await assert.rejects(verifyRecoverySet({ recoverySet: o.destination, manifestSha256: digest(bytes) })) }
}))
test('extra root entries and public aggregate permissions reject read-only', async () => fixture(async o => {
  const result = await createRecoverySet(o)
  await writeFile(join(o.destination, 'unexpected'), '')
  await assert.rejects(verifyRecoverySet(result), /exactly/)
  const extra = join(o.destination, 'unexpected'); assert.equal(dirname(extra), o.destination); await rm(extra)
  if (process.platform !== 'win32') {
    const path = join(o.destination, 'recovery-manifest.json'); await chmod(path, 0o644)
    await assert.rejects(verifyRecoverySet(result)); assert.equal((await stat(path)).mode & 0o777, 0o644)
  }
}))
test('baseline mutation between children prevents aggregate publication', async () => fixture(async o => {
  const original = fsPromises.mkdir
  let mutated = false
  fsPromises.mkdir = (async (...args: Parameters<typeof mkdir>) => {
    if (args[0] === join(o.destination, 'data')) { mutated = true; await writeFile(join(o.bundle, 'src/main.ts'), 'changed') }
    return original(...args)
  }) as typeof mkdir
  syncBuiltinESMExports()
  try { await assert.rejects(createRecoverySet(o), /Payload/); assert.equal(mutated, true) }
  finally { fsPromises.mkdir = original; syncBuiltinESMExports() }
  await assert.rejects(stat(join(o.destination, 'recovery-manifest.json')), { code: 'ENOENT' })
}))
test('configuration mutation between children retains private partial set without aggregate', async () => fixture(async o => {
  const original = fsPromises.mkdir
  let mutated = false
  fsPromises.mkdir = (async (...args: Parameters<typeof mkdir>) => {
    if (args[0] === join(o.destination, 'data')) {
      mutated = true
      await writeFile(o.configFile, `JARVIS_DATA_DIR="${o.dataDir}"\nJARVIS_AUTH_TOKEN=changed\n`)
    }
    return original(...args)
  }) as typeof mkdir
  syncBuiltinESMExports()
  try { await assert.rejects(createRecoverySet(o), /Configuration changed/); assert.equal(mutated, true) }
  finally { fsPromises.mkdir = original; syncBuiltinESMExports() }
  await assert.rejects(stat(join(o.destination, 'recovery-manifest.json')), { code: 'ENOENT' })
  assert.deepEqual((await readdir(o.destination)).sort(), ['config', 'data'])
  assert.match(await readFile(join(o.destination, 'config/config.env'), 'utf8'), /secret-fixture-token/)
}))
