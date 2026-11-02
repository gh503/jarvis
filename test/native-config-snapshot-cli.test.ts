import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseConfigSnapshotArgs } from '../scripts/snapshot-native-config.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'
import { loadExternalConfig } from '../src/external-config.ts'

const cli = fileURLToPath(new URL('../scripts/snapshot-native-config.ts', import.meta.url))
const hash = 'a'.repeat(64)
const absolute = join(tmpdir(), 'config-snapshot-cli-parse')
const secret = 'private-config-token-DO-NOT-PRINT'

test('config snapshot parser accepts explicit action-specific options in any order', () => {
  assert.deepEqual(parseConfigSnapshotArgs(['create', '--destination', absolute, '--config', absolute, '--data', absolute]), { action: 'create', configFile: absolute, dataDir: absolute, destination: absolute })
  assert.deepEqual(parseConfigSnapshotArgs(['verify', '--manifest-sha256', hash, '--snapshot', absolute]), { action: 'verify', snapshot: absolute, manifestSha256: hash })
  assert.deepEqual(parseConfigSnapshotArgs(['restore', '--destination', absolute, '--snapshot', absolute, '--manifest-sha256', hash]), { action: 'restore', snapshot: absolute, manifestSha256: hash, destination: absolute })
})

test('config snapshot parser rejects missing, duplicate, unknown, relative and malformed arguments', () => {
  const valid = [
    ['create', '--config', absolute, '--data', absolute, '--destination', absolute],
    ['verify', '--snapshot', absolute, '--manifest-sha256', hash],
    ['restore', '--snapshot', absolute, '--manifest-sha256', hash, '--destination', absolute],
  ]
  const invalid: string[][] = [[], ['help'], ['--help'], ['activate'], ['create'], ['verify'], ['restore']]
  for (const args of valid) {
    invalid.push([...args, '--force'], [...args, '--config', absolute])
    for (let i = 1; i < args.length; i += 2) {
      invalid.push(args.filter((_, index) => index !== i && index !== i + 1))
      invalid.push(args.map((value, index) => index === i ? '--unknown' : value))
      invalid.push(args.map((value, index) => index === i ? args[i === 1 ? 3 : 1]! : value))
      invalid.push([...args.slice(0, i), `${args[i]}=${args[i + 1]}`, ...args.slice(i + 2)])
      for (const bad of ['', 'relative', absolute + '\0bad']) {
        invalid.push(args.map((value, index) => index === i + 1 ? bad : value))
      }
    }
  }
  for (const badHash of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ' ' + hash, hash + '\n']) {
    invalid.push(['verify', '--snapshot', absolute, '--manifest-sha256', badHash])
  }
  for (const args of invalid) assert.throws(() => parseConfigSnapshotArgs(args), /^Error: Usage:/, JSON.stringify(args))
})

async function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--experimental-transform-types', cli, ...args], {
      timeout: 60_000, maxBuffer: 64 * 1024, encoding: 'utf8', env,
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) { reject(error); return }
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr })
    })
  })
}

type Fixture = { root: string; sourceData: string; configFile: string; bytes: Buffer }
async function fixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const temporaryRoot = await realpath(tmpdir())
  const root = await mkdtemp(join(temporaryRoot, 'jarvis config snapshot cli '))
  try {
    await ensurePrivateDataDirectory(root)
    const sourceData = join(root, 'source data')
    const configParent = join(root, 'private config')
    await ensurePrivateDataDirectory(sourceData)
    await ensurePrivateDataDirectory(configParent)
    const configFile = join(configParent, 'original.env')
    const bytes = Buffer.from(`# Private UTF-8 configuration: café 日本語\r\n\r\nJARVIS_DATA_DIR = "${sourceData}"\r\nJARVIS_AUTH_TOKEN='${secret}'\r\n# Keep quotes and comments unchanged\r\nJARVIS_LLM_MODEL = 'model with spaces'\r\n`, 'utf8')
    await writeFile(configFile, bytes, { mode: 0o400 })
    await body({ root, sourceData, configFile, bytes })
  } finally {
    // Exclusively owned mkdtemp root; never accept production paths for cleanup.
    assert.equal(dirname(root), temporaryRoot)
    await rm(root, { recursive: true, force: true })
  }
}
async function absent(path: string): Promise<void> { await assert.rejects(stat(path), { code: 'ENOENT' }) }
async function privatePath(path: string): Promise<void> {
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o077, 0)
}
function failed(result: Awaited<ReturnType<typeof run>>): void {
  assert.equal(result.code, 1, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Native config snapshot failed:/)
  assert.doesNotMatch(result.stderr, /private-config-token|tampered-secret|\n\s+at /)
  assert.ok(Buffer.byteLength(result.stderr) < 8192)
}

test('config snapshot CLI rejects incomplete usage without ambient defaults or side effects', { timeout: 180_000 }, async () => fixture(async ({ root, sourceData, configFile, bytes }) => {
  const destination = join(root, 'must-not-exist')
  const env = { ...process.env, JARVIS_CONFIG_FILE: configFile, JARVIS_DATA_DIR: sourceData }
  for (const args of [
    ['create', '--destination', destination],
    ['create', '--data', sourceData, '--destination', destination],
    ['create', '--config', configFile, '--destination', destination],
  ]) {
    const result = await run(args, env)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Usage: snapshot-native-config.ts/)
    await absent(destination)
  }
  assert.deepEqual(await readdir(sourceData), [])
  assert.deepEqual(await readFile(configFile), bytes)
}))

test('config snapshot CLI creates verifies and restores exact private UTF-8 bytes without activation or rewrites', { timeout: 240_000 }, async () => fixture(async ({ root, sourceData, configFile, bytes }) => {
  const snapshot = join(root, 'snapshot'), destination = join(root, 'restored directory')
  const originalStat = await stat(configFile)
  const inheritedData = join(root, 'ambient-must-not-exist')
  const env = { ...process.env, JARVIS_CONFIG_FILE: join(root, 'missing.env'), JARVIS_DATA_DIR: inheritedData, JARVIS_PORT: 'invalid' }
  const created = await run(['create', '--config', configFile, '--data', sourceData, '--destination', snapshot], env)
  assert.equal(created.code, 0, created.stderr)
  const receipt = JSON.parse(created.stdout)
  assert.deepEqual(Object.keys(receipt).sort(), ['manifestSha256', 'snapshot'])
  assert.equal(receipt.snapshot, snapshot)
  assert.match(receipt.manifestSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual((await readdir(snapshot)).sort(), ['config.env', 'manifest.json'])
  assert.deepEqual(await readFile(join(snapshot, 'config.env')), bytes)
  const verified = await run(['verify', '--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256], env)
  assert.equal(verified.code, 0, verified.stderr)
  assert.deepEqual(JSON.parse(verified.stdout), { verified: true, ...receipt })
  const restored = await run(['restore', '--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256, '--destination', destination], env)
  assert.equal(restored.code, 0, restored.stderr)
  assert.deepEqual(JSON.parse(restored.stdout), { destination, manifestSha256: receipt.manifestSha256 })
  assert.equal((await stat(destination)).isDirectory(), true)
  assert.deepEqual(await readdir(destination), ['config.env'])
  assert.deepEqual(await readFile(join(destination, 'config.env')), bytes)
  assert.equal(loadExternalConfig(join(destination, 'config.env')).JARVIS_DATA_DIR, sourceData)
  assert.deepEqual(await readFile(configFile), bytes)
  const unchangedStat = await stat(configFile)
  assert.equal(unchangedStat.mode, originalStat.mode)
  assert.equal(unchangedStat.mtimeMs, originalStat.mtimeMs)
  for (const path of [snapshot, join(snapshot, 'manifest.json'), join(snapshot, 'config.env'), destination, join(destination, 'config.env')]) await privatePath(path)
  for (const result of [created, verified, restored]) assert.doesNotMatch(result.stdout + result.stderr, /private-config-token|JARVIS_AUTH_TOKEN|model with spaces|日本語/)
  await absent(inheritedData)
  await absent(join(sourceData, 'runtime-instance.json'))
}))

test('config snapshot CLI refuses tampered or extra files before creating restore destination', { timeout: 420_000 }, async () => fixture(async ({ root, sourceData, configFile, bytes }) => {
  for (const corruption of ['tamper', 'extra']) {
    const snapshot = join(root, `snapshot-${corruption}`)
    const created = await run(['create', '--config', configFile, '--data', sourceData, '--destination', snapshot])
    assert.equal(created.code, 0, created.stderr)
    const receipt = JSON.parse(created.stdout)
    if (corruption === 'tamper') await writeFile(join(snapshot, 'config.env'), 'tampered-secret-DO-NOT-PRINT', { mode: 0o600 })
    else await writeFile(join(snapshot, 'extra'), 'tampered-secret-DO-NOT-PRINT', { mode: 0o600 })
    failed(await run(['verify', '--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256]))
    const destination = join(root, `refused-${corruption}`)
    failed(await run(['restore', '--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256, '--destination', destination]))
    await absent(destination)
    assert.deepEqual(await readFile(configFile), bytes)
  }
}))

test('config snapshot CLI refuses active runtime without destination or config changes', { timeout: 60_000 }, async () => fixture(async ({ root, sourceData, configFile, bytes }) => {
  const release = await acquireLifecycleLock(sourceData, 'runtime')
  const destination = join(root, 'blocked-snapshot')
  try {
    failed(await run(['create', '--config', configFile, '--data', sourceData, '--destination', destination]))
    await absent(destination)
    assert.deepEqual(await readFile(configFile), bytes)
  } finally { release() }
}))
