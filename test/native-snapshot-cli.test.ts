import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSnapshotArgs } from '../scripts/snapshot-native.ts'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'

const cli = fileURLToPath(new URL('../scripts/snapshot-native.ts', import.meta.url))
const hash = 'a'.repeat(64)
const absolute = join(tmpdir(), 'snapshot-cli-parse')

test('snapshot parser accepts only explicit complete action-specific options in any order', () => {
  assert.deepEqual(parseSnapshotArgs(['create', '--data', absolute, '--destination', absolute]), { action: 'create', dataDir: absolute, destination: absolute })
  assert.deepEqual(parseSnapshotArgs(['verify', '--manifest-sha256', hash, '--snapshot', absolute]), { action: 'verify', snapshot: absolute, manifestSha256: hash })
  assert.deepEqual(parseSnapshotArgs(['restore', '--destination', absolute, '--snapshot', absolute, '--manifest-sha256', hash]), { action: 'restore', snapshot: absolute, manifestSha256: hash, destination: absolute })
})

test('snapshot parser rejects missing, duplicate, unknown, relative, and malformed arguments', () => {
  const invalid: string[][] = [[], ['help'], ['--help'], ['activate'], ['create'], ['verify'], ['restore'],
    ['create', '--data', absolute],
    ['create', '--data', absolute, '--data', absolute],
    ['create', '--destination', absolute, '--destination', absolute],
    ['create', '--data', absolute, '--snapshot', absolute],
    ['create', '--data', absolute, '--destination', absolute, '--force'],
    ['create', '--data=' + absolute, '--destination', absolute],
    ['create', '--data', 'relative', '--destination', absolute],
    ['create', '--data', absolute, '--destination', 'relative'],
    ['create', '--data', '', '--destination', absolute],
    ['create', '--data', absolute + '\0bad', '--destination', absolute],
    ['verify', '--snapshot', absolute],
    ['verify', '--snapshot', absolute, '--manifest-sha256', hash, '--destination', absolute],
    ['verify', '--snapshot', 'relative', '--manifest-sha256', hash],
    ['verify', '--snapshot', absolute, '--snapshot', absolute],
    ['restore', '--snapshot', absolute, '--manifest-sha256', hash],
    ['restore', '--snapshot', absolute, '--manifest-sha256', hash, '--destination', 'relative'],
    ['restore', '--snapshot', absolute, '--manifest-sha256', hash, '--data', absolute],
  ]
  for (const badHash of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ' ' + hash, hash + '\n']) {
    invalid.push(['verify', '--snapshot', absolute, '--manifest-sha256', badHash])
  }
  for (const args of invalid) assert.throws(() => parseSnapshotArgs(args), /^Error: Usage:/, JSON.stringify(args))
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
async function fixture(body: (root: string, data: string) => Promise<void>): Promise<void> {
  const temporaryRoot = await realpath(tmpdir())
  const root = await mkdtemp(join(temporaryRoot, 'jarvis-snapshot-cli-'))
  try {
    await ensurePrivateDataDirectory(root)
    const data = join(root, 'data')
    await mkdir(data, { mode: 0o700 })
    await ensurePrivateDataDirectory(data)
    await body(root, data)
  } finally {
    // Exclusively owned mkdtemp root; never accept production paths for cleanup.
    assert.equal(dirname(root), temporaryRoot)
    await rm(root, { recursive: true, force: true })
  }
}
async function absent(path: string): Promise<void> { await assert.rejects(stat(path), { code: 'ENOENT' }) }

test('invalid snapshot CLI usage exits 2 without filesystem side effects or environment defaults', { timeout: 60_000 }, async () => fixture(async (root, data) => {
  const destination = join(root, 'must-not-exist')
  const result = await run(['create', '--destination', destination], { ...process.env, JARVIS_DATA_DIR: data })
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Usage: snapshot-native.ts/)
  assert.deepEqual(await readdir(data), [])
  await absent(destination)
}))

test('snapshot CLI creates, verifies and restores empty private state', { timeout: 180_000 }, async () => fixture(async (root, data) => {
  const snapshot = join(root, 'snapshot'), destination = join(root, 'restored')
  const created = await run(['create', '--data', data, '--destination', snapshot])
  assert.equal(created.code, 0, created.stderr)
  const receipt = JSON.parse(created.stdout)
  assert.deepEqual(Object.keys(receipt).sort(), ['manifestSha256', 'snapshot'])
  assert.equal(receipt.snapshot, snapshot)
  assert.match(receipt.manifestSha256, /^[a-f0-9]{64}$/)
  const verified = await run(['verify', '--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256])
  assert.equal(verified.code, 0, verified.stderr)
  assert.deepEqual(JSON.parse(verified.stdout), { verified: true, ...receipt })
  const restored = await run(['restore', '--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256, '--destination', destination])
  assert.equal(restored.code, 0, restored.stderr)
  assert.deepEqual(JSON.parse(restored.stdout), { destination, manifestSha256: receipt.manifestSha256 })
  assert.equal((await stat(destination)).isDirectory(), true)
}))

test('snapshot CLI keeps secret contents out of receipts and rejects tampered payloads before restoring', { timeout: 300_000 }, async () => fixture(async (root, data) => {
  const secret = 'private-test-token-DO-NOT-PRINT'
  await writeFile(join(data, 'secret.key'), secret, { mode: 0o600 })
  const snapshot = join(root, 'snapshot')
  const created = await run(['create', '--data', data, '--destination', snapshot])
  assert.equal(created.code, 0, created.stderr)
  assert.doesNotMatch(created.stdout + created.stderr, new RegExp(secret + '|secret\\.key'))
  const receipt = JSON.parse(created.stdout)
  const destination = join(root, 'restored')
  const restored = await run(['restore', '--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256, '--destination', destination])
  assert.equal(restored.code, 0, restored.stderr)
  assert.deepEqual(JSON.parse(restored.stdout), { destination, manifestSha256: receipt.manifestSha256 })
  assert.equal(await readFile(join(destination, 'secret.key'), 'utf8'), secret)
  assert.doesNotMatch(restored.stdout + restored.stderr, new RegExp(secret))
  await writeFile(join(snapshot, 'payload', 'secret.key'), 'tampered-secret-DO-NOT-PRINT', { mode: 0o600 })
  const verified = await run(['verify', '--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256])
  const refused = join(root, 'refused-restore')
  const failedRestore = await run(['restore', '--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256, '--destination', refused])
  for (const result of [verified, failedRestore]) {
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Native state snapshot failed:/)
    assert.doesNotMatch(result.stderr, /private-test-token|tampered-secret|\n\s+at /)
    assert.ok(Buffer.byteLength(result.stderr) < 8192)
  }
  await absent(refused)
}))

test('snapshot CLI refuses create while runtime lock is held and leaves destination absent', { timeout: 60_000 }, async () => fixture(async (root, data) => {
  const release = await acquireLifecycleLock(data, 'runtime')
  const destination = join(root, 'blocked-snapshot')
  try {
    const result = await run(['create', '--data', data, '--destination', destination])
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Native state snapshot failed:/)
    await absent(destination)
  } finally { release() }
}))
