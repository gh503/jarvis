import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createConfigSnapshot, restoreConfigSnapshot, verifyConfigSnapshot } from '../scripts/native-config-snapshot.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'

async function fixture(run: (f: { root: string; configFile: string; dataDir: string; destination: string; bytes: Buffer }) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-config-snapshot-')))
  try {
    await ensurePrivateDataDirectory(root)
    const configDir = join(root, 'config'), dataDir = join(root, 'data')
    mkdirSync(configDir, { mode: 0o700 }); mkdirSync(dataDir, { mode: 0o700 })
    const configFile = join(configDir, 'config.env')
    const bytes = Buffer.from(`# untouched 中文\r\nJARVIS_DATA_DIR="${dataDir}"\r\nJARVIS_AUTH_TOKEN='secret-keep-exact'\r\n\r\n`)
    writeFileSync(configFile, bytes, { mode: 0o600 })
    await run({ root, configFile, dataDir, destination: join(root, 'snapshot'), bytes })
  } finally {
    // root is the canonical temporary directory created exclusively above.
    rmSync(root, { recursive: true, force: true })
  }
}

test('config-only snapshot and restore preserve exact bytes and absolute data path without environment or source changes', async () => {
  await fixture(async f => {
    const env = { ...process.env }, stat = lstatSync(f.configFile, { bigint: true })
    writeFileSync(join(f.dataDir, 'application-state'), 'untouched', { mode: 0o600 })
    const created = await createConfigSnapshot(f)
    assert.equal(JSON.stringify(created).includes('secret-keep-exact'), false)
    assert.deepEqual(readFileSync(join(f.destination, 'config.env')), f.bytes)
    assert.deepEqual((await verifyConfigSnapshot(created)).manifest, created.manifest)
    const destination = join(f.root, 'restored')
    const restored = await restoreConfigSnapshot({ ...created, destination })
    assert.equal(restored.destination, destination)
    assert.deepEqual(readFileSync(join(destination, 'config.env')), f.bytes)
    assert.deepEqual(readFileSync(f.configFile), f.bytes)
    assert.equal(readFileSync(join(f.dataDir, 'application-state'), 'utf8'), 'untouched')
    const after = lstatSync(f.configFile, { bigint: true })
    assert.equal(after.mtimeNs, stat.mtimeNs); assert.equal(after.mode, stat.mode)
    assert.deepEqual({ ...process.env }, env)
    await assert.rejects(restoreConfigSnapshot({ ...created, destination }), /already exists/)
  })
})

test('active runtime and launcher reject creation before destination exists', async () => {
  for (const name of ['runtime', 'launcher'] as const) await fixture(async f => {
    const release = await acquireLifecycleLock(f.dataDir, name)
    try { await assert.rejects(createConfigSnapshot(f), /already owns|launcher is still/) } finally { release() }
    assert.throws(() => lstatSync(f.destination), { code: 'ENOENT' })
  })
})

test('mismatched, missing, aliased data roots and protected destination overlaps reject', async () => {
  await fixture(async f => {
    const other = join(f.root, 'other'); mkdirSync(other, { mode: 0o700 })
    await assert.rejects(createConfigSnapshot({ ...f, dataDir: other }), /mismatch/)
    await assert.rejects(createConfigSnapshot({ ...f, dataDir: join(f.root, 'missing') }))
    await assert.rejects(createConfigSnapshot({ ...f, dataDir: `${f.dataDir}/.` }))
    for (const destination of [join(f.dataDir, 'snap'), join(f.root, 'config', 'snap'), f.root, f.configFile]) await assert.rejects(createConfigSnapshot({ ...f, destination }))
    const nestedData = join(f.root, 'config', 'nested-data')
    mkdirSync(nestedData, { mode: 0o700 })
    writeFileSync(f.configFile, `JARVIS_DATA_DIR=${nestedData}\n`)
    await assert.rejects(createConfigSnapshot({ ...f, dataDir: nestedData }), /private parent must be separate/)
    writeFileSync(f.configFile, f.bytes)
    const created = await createConfigSnapshot(f)
    for (const destination of [join(f.destination, 'restore'), join(f.dataDir, 'restore'), join(f.root, 'config', 'restore'), f.root]) await assert.rejects(restoreConfigSnapshot({ ...created, destination }))
  })
})

test('verification rejects tampering, extra entries, bounds, noncanonical manifests and untrusted digests', async () => {
  await fixture(async f => {
    const created = await createConfigSnapshot(f)
    await assert.rejects(verifyConfigSnapshot({ ...created, manifestSha256: '' }))
    await assert.rejects(verifyConfigSnapshot({ ...created, manifestSha256: '0'.repeat(64) }))
    const config = join(f.destination, 'config.env'), manifest = join(f.destination, 'manifest.json')
    const raw = readFileSync(manifest)
    writeFileSync(config, Buffer.concat([f.bytes, Buffer.from('# changed')]))
    await assert.rejects(verifyConfigSnapshot(created), /digest/)
    writeFileSync(config, f.bytes)
    for (const value of [Buffer.alloc(16385), Buffer.from([0xff]), Buffer.from(JSON.stringify(created.manifest)), Buffer.from(JSON.stringify({ ...created.manifest, extra: true }) + '\n')]) {
      writeFileSync(manifest, value)
      const manifestSha256 = createHash('sha256').update(value).digest('hex')
      await assert.rejects(verifyConfigSnapshot({ ...created, manifestSha256 }))
    }
    writeFileSync(manifest, raw)
    writeFileSync(config, Buffer.alloc(65537))
    await assert.rejects(verifyConfigSnapshot(created))
    writeFileSync(config, f.bytes)
    writeFileSync(join(f.destination, 'extra'), 'extra')
    await assert.rejects(verifyConfigSnapshot(created), /exactly/)
  })
})

test('hardlinked and symlinked payloads are rejected without mutation', async () => {
  for (const name of ['config.env', 'manifest.json']) await fixture(async f => {
    const created = await createConfigSnapshot(f)
    const file = join(f.destination, name), linked = join(f.root, 'hardlink')
    linkSync(file, linked)
    await assert.rejects(verifyConfigSnapshot(created))
    assert.equal(lstatSync(file).nlink, 2)
  })
  if (process.platform !== 'win32') await fixture(async f => {
    const alias = join(f.root, 'alias'); symlinkSync(f.dataDir, alias)
    await assert.rejects(createConfigSnapshot({ ...f, dataDir: alias }))
    const created = await createConfigSnapshot(f)
    const snapshotAlias = join(f.root, 'snapshot-alias'); symlinkSync(f.destination, snapshotAlias)
    await assert.rejects(verifyConfigSnapshot({ ...created, snapshot: snapshotAlias }))
  })
})

test('shared POSIX source and manifest permissions fail read-only', { skip: process.platform === 'win32' }, async () => {
  await fixture(async f => {
    chmodSync(f.configFile, 0o644)
    await assert.rejects(createConfigSnapshot(f))
    assert.equal(lstatSync(f.configFile).mode & 0o777, 0o644)
    chmodSync(f.configFile, 0o600)
    const created = await createConfigSnapshot(f)
    const manifest = join(f.destination, 'manifest.json')
    chmodSync(manifest, 0o644)
    await assert.rejects(verifyConfigSnapshot(created))
    assert.equal(lstatSync(manifest).mode & 0o777, 0o644)
  })
})
