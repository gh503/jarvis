import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRecoveryArgs } from '../scripts/recovery-native.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'

const cli = fileURLToPath(new URL('../scripts/recovery-native.ts', import.meta.url))
const hash = 'a'.repeat(64)
const absolute = join(tmpdir(), 'recovery-cli-parse')
const secret = 'private-recovery-token-DO-NOT-PRINT'
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const createArgs = ['create', '--bundle', absolute, '--bundle-manifest-sha256', hash, '--config', absolute, '--data', absolute, '--destination', absolute]
const verifyArgs = ['verify', '--recovery-set', absolute, '--manifest-sha256', hash]

test('recovery parser accepts only explicit create and verify options in any order', () => {
  assert.deepEqual(parseRecoveryArgs(['create', '--destination', absolute, '--config', absolute, '--bundle-manifest-sha256', hash, '--data', absolute, '--bundle', absolute]), {
    action: 'create', bundle: absolute, bundleManifestSha256: hash, configFile: absolute, dataDir: absolute, destination: absolute,
  })
  assert.deepEqual(parseRecoveryArgs(['verify', '--manifest-sha256', hash, '--recovery-set', absolute]), { action: 'verify', recoverySet: absolute, manifestSha256: hash })
})

test('recovery parser rejects missing, duplicate, cross-action, unknown and malformed options', () => {
  const invalid: string[][] = [[], ['help'], ['--help'], ['activate'], ['restore'], ['create'], ['verify'], ['create', ...verifyArgs], ['verify', ...createArgs]]
  for (const args of [createArgs, verifyArgs]) {
    invalid.push([...args, '--force'], [...args, '--config', absolute], [...args, 'verify'])
    for (let i = 1; i < args.length; i += 2) {
      invalid.push(args.filter((_, index) => index !== i && index !== i + 1))
      invalid.push(args.map((value, index) => index === i ? '--unknown' : value))
      invalid.push(args.map((value, index) => index === i ? args[i === 1 ? 3 : 1]! : value))
      invalid.push([...args.slice(0, i), `${args[i]}=${args[i + 1]}`, ...args.slice(i + 2)])
      const badValues = ['', 'relative', absolute + '\0bad']
      if (args[i]!.endsWith('sha256')) badValues.push('a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ' ' + hash, hash + '\n')
      for (const bad of badValues) invalid.push(args.map((value, index) => index === i + 1 ? bad : value))
    }
  }
  invalid.push(['verify', '--snapshot', absolute, '--manifest-sha256', hash])
  for (const args of invalid) assert.throws(() => parseRecoveryArgs(args), /^Error: Usage:/, JSON.stringify(args))
})

async function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--experimental-transform-types', cli, ...args], {
      timeout: process.platform === 'win32' ? 120_000 : 60_000, maxBuffer: 64 * 1024, encoding: 'utf8', env,
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) { reject(error); return }
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr })
    })
  })
}

type Fixture = { root: string; bundle: string; bundleHash: string; dataDir: string; configFile: string; configBytes: Buffer }
async function fixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const temporaryRoot = realpathSync.native(tmpdir())
  const root = realpathSync.native(await mkdtemp(join(temporaryRoot, 'jarvis recovery cli ')))
  try {
    await ensurePrivateDataDirectory(root)
    const dataDir = join(root, 'source data'), configParent = join(root, 'private config'), bundle = join(root, 'bundle')
    for (const directory of [dataDir, configParent, bundle]) await ensurePrivateDataDirectory(directory)
    await ensurePrivateDataDirectory(join(dataDir, '.native'))
    const configFile = join(configParent, 'original.env')
    const configBytes = Buffer.from(`# Preserve café 日本語\r\nJARVIS_DATA_DIR="${dataDir}"\r\nJARVIS_AUTH_TOKEN='${secret}'\r\n`, 'utf8')
    await writeFile(configFile, configBytes, { mode: 0o600 })
    await writeFile(join(dataDir, 'secrets.json'), JSON.stringify({ token: secret }), { mode: 0o600 })
    const files = []
    // Runtime identity is verified, but these inert payloads must never execute.
    for (const path of [`runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`, 'src/main.ts', 'scripts/app.ts', 'scripts/install-native.ts']) {
      await mkdir(dirname(join(bundle, path)), { recursive: true })
      await writeFile(join(bundle, path), 'fixture')
      files.push({ path, bytes: 7, sha256: digest('fixture') })
    }
    const manifest = JSON.stringify({ schemaVersion: 1, version: '1.0.0', sourceTag: 'v1.0.0', sourceSha: 'a'.repeat(40), dirty: false, platform: process.platform, arch: process.arch, runtime: { version: process.version, platform: process.platform, arch: process.arch }, files })
    await writeFile(join(bundle, 'manifest.json'), manifest)
    await body({ root, bundle, bundleHash: digest(manifest), dataDir, configFile, configBytes })
  } finally {
    // Exclusively owned mkdtemp root; no production paths enter cleanup.
    assert.equal(dirname(root), temporaryRoot)
    await rm(root, { recursive: true, force: true })
  }
}
function create(f: Fixture, destination: string): string[] {
  return ['create', '--bundle', f.bundle, '--bundle-manifest-sha256', f.bundleHash, '--config', f.configFile, '--data', f.dataDir, '--destination', destination]
}
async function absent(path: string): Promise<void> { await assert.rejects(stat(path), { code: 'ENOENT' }) }
function noSecrets(result: Awaited<ReturnType<typeof run>>): void {
  assert.doesNotMatch(result.stdout + result.stderr, /private-recovery-token|tampered-secret|JARVIS_AUTH_TOKEN|日本語|\n\s+at /)
}
function failed(result: Awaited<ReturnType<typeof run>>): void {
  assert.equal(result.code, 1, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Native recovery failed:/)
  const diagnostic = result.stderr.split('\n').find(line => line.startsWith('Native recovery failed:'))!
  assert.ok(diagnostic.length <= 1024)
  noSecrets(result)
}

test('recovery CLI rejects missing flags before operation import without ambient defaults or writes', { timeout: 240_000 }, async () => fixture(async f => {
  const destination = join(f.root, 'must-not-exist')
  const env = { ...process.env, JARVIS_CONFIG_FILE: f.configFile, JARVIS_DATA_DIR: f.dataDir }
  const before = await readdir(f.dataDir)
  for (const args of [
    ['create', '--destination', destination],
    create(f, destination).filter((_, index) => index !== 5 && index !== 6),
    ['verify', '--recovery-set', destination],
  ]) {
    const result = await run(args, env)
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Usage: recovery-native.ts/)
    assert.doesNotMatch(result.stderr, /ExperimentalWarning.*SQLite|ERR_MODULE_NOT_FOUND|Native recovery failed:/)
    noSecrets(result)
    await absent(destination)
  }
  assert.deepEqual(await readdir(f.dataDir), before)
  assert.deepEqual(await readFile(f.configFile), f.configBytes)
}))

test('recovery CLI creates and verifies exact private set without loading ambient configuration', { timeout: 360_000 }, async () => fixture(async f => {
  const recoverySet = join(f.root, 'recovery set'), ambientData = join(f.root, 'ambient-must-not-exist')
  const env = { ...process.env, JARVIS_CONFIG_FILE: join(f.root, 'missing.env'), JARVIS_DATA_DIR: ambientData, JARVIS_PORT: 'invalid' }
  const created = await run(create(f, recoverySet), env)
  assert.equal(created.code, 0, created.stderr)
  const receipt = JSON.parse(created.stdout)
  assert.deepEqual(Object.keys(receipt).sort(), ['manifestSha256', 'recoverySet'])
  assert.equal(receipt.recoverySet, recoverySet)
  assert.match(receipt.manifestSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual((await readdir(recoverySet)).sort(), ['config', 'data', 'recovery-manifest.json'])
  assert.deepEqual(await readFile(join(recoverySet, 'config', 'config.env')), f.configBytes)
  assert.equal(await readFile(join(recoverySet, 'data', 'payload', 'secrets.json'), 'utf8'), JSON.stringify({ token: secret }))
  const verified = await run(['verify', '--recovery-set', recoverySet, '--manifest-sha256', receipt.manifestSha256], env)
  assert.equal(verified.code, 0, verified.stderr)
  assert.deepEqual(JSON.parse(verified.stdout), { verified: true, ...receipt })
  for (const result of [created, verified]) noSecrets(result)
  assert.deepEqual(await readFile(f.configFile), f.configBytes)
  if (process.platform !== 'win32') {
    for (const path of [recoverySet, join(recoverySet, 'config'), join(recoverySet, 'data'), join(recoverySet, 'recovery-manifest.json'), join(recoverySet, 'config', 'config.env'), join(recoverySet, 'data', 'payload', 'secrets.json')]) assert.equal((await stat(path)).mode & 0o077, 0)
  }
  await absent(ambientData)
  await absent(join(f.dataDir, 'runtime-instance.json'))
}))

test('recovery CLI rejects altered trust anchor and tampered config or data without leaking secrets', { timeout: 720_000 }, async () => fixture(async f => {
  for (const corruption of ['anchor', 'config', 'data']) {
    const recoverySet = join(f.root, `recovery-${corruption}`)
    const created = await run(create(f, recoverySet))
    assert.equal(created.code, 0, created.stderr)
    const receipt = JSON.parse(created.stdout)
    if (corruption === 'config') await writeFile(join(recoverySet, 'config', 'config.env'), 'tampered-secret-DO-NOT-PRINT')
    if (corruption === 'data') await writeFile(join(recoverySet, 'data', 'payload', 'secrets.json'), 'tampered-secret-DO-NOT-PRINT')
    failed(await run(['verify', '--recovery-set', recoverySet, '--manifest-sha256', corruption === 'anchor' ? '0'.repeat(64) : receipt.manifestSha256]))
    noSecrets(created)
  }
}))

test('recovery CLI refuses active runtime before creating destination', { timeout: 180_000 }, async () => fixture(async f => {
  const release = await acquireLifecycleLock(f.dataDir, 'runtime')
  const destination = join(f.root, 'blocked-recovery')
  try {
    failed(await run(create(f, destination)))
    await absent(destination)
    assert.deepEqual(await readFile(f.configFile), f.configBytes)
  } finally { release() }
}))
