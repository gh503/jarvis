import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { nativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { parseIntegrationSnapshotArgs } from '../scripts/snapshot-native-integration.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
import { sanitizeDiagnostic } from './fixtures/native-snapshot-diagnostic.ts'
import { sanitizePermissionPhases } from './fixtures/native-snapshot-phases.ts'

const cli = fileURLToPath(new URL('../scripts/snapshot-native-integration.ts', import.meta.url))
const absolute = join(tmpdir(), 'integration-cli-parser')
const digest = 'a'.repeat(64)
const secret = 'PRIVATE-INTEGRATION-PAYLOAD-DO-NOT-PRINT'
const childTimeout = process.platform === 'win32' ? 120_000 : 60_000
function context(platform: 'darwin' | 'win32', root = absolute): string[] {
  return ['--platform', platform, '--arch', 'arm64', '--home', join(root, 'home'), '--root', join(root, 'package'),
    ...(platform === 'win32' ? ['--app-data', join(root, 'roaming'), '--local-app-data', join(root, 'local')] : [])]
}
function args(action: 'create' | 'verify' | 'restore-copy', platform: 'darwin' | 'win32'): string[] {
  return [action, ...context(platform), ...(action === 'create' ? ['--destination', absolute] : ['--snapshot', absolute, '--manifest-sha256', digest]),
    ...(action === 'restore-copy' ? ['--destination', join(absolute, 'recovery')] : [])]
}

test('integration snapshot parser accepts only explicit create, verify and restore-copy contexts in any order', () => {
  for (const platform of ['darwin', 'win32'] as const) for (const action of ['create', 'verify', 'restore-copy'] as const) {
    const input = args(action, platform)
    const pairs = Array.from({ length: (input.length - 1) / 2 }, (_, i) => input.slice(1 + i * 2, 3 + i * 2)).reverse().flat()
    const integration = { platform, arch: 'arm64', home: join(absolute, 'home'), root: join(absolute, 'package'),
      ...(platform === 'win32' ? { appData: join(absolute, 'roaming'), localAppData: join(absolute, 'local') } : {}) }
    assert.deepEqual(parseIntegrationSnapshotArgs([action, ...pairs]), action === 'create'
      ? { action, integration, destination: absolute }
      : { action, integration, snapshot: absolute, manifestSha256: digest, ...(action === 'restore-copy' ? { destination: join(absolute, 'recovery') } : {}) })
    assert.equal(parseIntegrationSnapshotArgs(input.map(value => value === 'arm64' ? 'x64' : value)).integration.arch, 'x64')
  }
})

test('integration snapshot parser rejects actions, duplicates, unknown, missing and invalid options', () => {
  const invalid: string[][] = [[], ['restore'], ['activate'], ['install'], ['--help'], ['create'], ['verify'], ['restore-copy'], ['restore', ...args('restore-copy', 'darwin').slice(1)]]
  for (const platform of ['darwin', 'win32'] as const) for (const action of ['create', 'verify', 'restore-copy'] as const) {
    const input = args(action, platform)
    invalid.push([...input, '--force'], [...input, '--unknown', absolute], [...input, '--arch', 'x64'])
    invalid.push([...input, ...(action === 'create' ? ['--snapshot', absolute] : ['--destination', absolute])])
    for (let i = 1; i < input.length; i += 2) {
      invalid.push(input.filter((_, index) => index !== i && index !== i + 1))
      invalid.push(input.map((value, index) => index === i ? '--unknown' : value))
      invalid.push(input.map((value, index) => index === i ? input[i === 1 ? 3 : 1]! : value))
      invalid.push([...input.slice(0, i), `${input[i]}=${input[i + 1]}`, ...input.slice(i + 2)])
      for (const bad of ['', 'relative', absolute + '\0bad', absolute + '\nsecret']) invalid.push(input.map((value, index) => index === i + 1 ? bad : value))
    }
    for (const bad of ['linux', 'Darwin', '']) invalid.push(input.map((value, index) => index === 2 ? bad : value))
    for (const bad of ['ia32', 'ARM64', '']) invalid.push(input.map((value, index) => index === 4 ? bad : value))
    if (platform === 'darwin') for (const option of ['--app-data', '--local-app-data']) invalid.push([...input, option, absolute])
    if (action !== 'create') for (const bad of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), digest + '\n']) invalid.push(input.map((value, index) => input[index - 1] === '--manifest-sha256' ? bad : value))
  }
  for (const input of invalid) assert.throws(() => parseIntegrationSnapshotArgs(input), /^Error: Usage:/, JSON.stringify(input))
})

async function run(input: string[], root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => execFile(process.execPath, ['--experimental-transform-types', cli, ...input], {
    timeout: childTimeout, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, NODE_NO_WARNINGS: '1', JARVIS_CONFIG_FILE: join(root, 'missing.env'), JARVIS_DATA_DIR: join(root, 'missing-data'), JARVIS_PORT: 'invalid' },
  }, (error, stdout, stderr) => {
    if (error && (error.killed || typeof error.code !== 'number')) { reject(error); return }
    resolve({ code: error ? Number(error.code) : 0, stdout, stderr })
  }))
}
function owned(root: string, target: string): void {
  const rel = relative(root, target)
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}
async function absent(path: string): Promise<void> { await assert.rejects(lstat(path), { code: 'ENOENT' }) }
function failed(result: Awaited<ReturnType<typeof run>>): void {
  assert.equal(result.code, 1, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^Native integration snapshot failed:/)
  assert.ok(result.stderr.length <= 1024)
  assert.doesNotMatch(result.stderr, /PRIVATE-INTEGRATION|\n\s+at |[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
}
async function fixture(platform: 'darwin' | 'win32', body: (value: { root: string; integration: InstallOptions; created: string[] }) => Promise<void>): Promise<void> {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'jarvis integration cli .native '))
  try {
    await ensurePrivateDataDirectory(root)
    const integration: InstallOptions = { platform, arch: 'arm64', root: join(root, 'package'), home: join(root, 'home'),
      ...(platform === 'win32' ? { appData: join(root, 'roaming'), localAppData: join(root, 'local') } : {}),
      runPowerShell: (_script, env) => writeFileSync(env.JARVIS_LINK_PATH!, Buffer.from(secret), { mode: 0o600 }) }
    for (const directory of ['package', 'package/runtime', 'package/scripts', 'package/src', 'home', 'roaming', 'local']) {
      await mkdir(join(root, directory), { mode: 0o755 })
    }
    const files = []
    for (const path of [`runtime/${platform === 'win32' ? 'node.exe' : 'node'}`, 'scripts/app.ts', 'scripts/install-native.ts', 'src/main.ts']) {
      const bytes = Buffer.from('synthetic fixture; must never execute')
      await writeFile(join(integration.root, path), bytes, { mode: 0o644 })
      files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    await writeFile(join(integration.root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, platform, arch: 'arm64', runtime: { version: 'v24.14.0', platform, arch: 'arm64' }, files }), { mode: 0o644 })
    const created = await nativeIntegration(integration, ['--install', '--autostart'])
    await body({ root, integration, created })
  } finally {
    assert.equal(dirname(root), base)
    assert.ok(root.startsWith(join(base, 'jarvis integration cli .native ')))
    await rm(root, { recursive: true, force: true })
  }
}

// Independent first-class invocation: never retry a failing black-box CLI operation.
for (const platform of ['darwin', 'win32'] as const) test(`${platform} direct snapshot API subprocess reports bounded native diagnostics`, { timeout: childTimeout * 2 }, async () => fixture(platform, async ({ root, integration }) => {
  const destination = join(root, 'diagnostic-snapshot')
  owned(root, destination)
  const parameters = { platform, arch: integration.arch, home: integration.home, root: integration.root, destination,
    ...(platform === 'win32' ? { appData: integration.appData, localAppData: integration.localAppData } : {}) }
  const diagnostic = fileURLToPath(new URL('./fixtures/native-snapshot-diagnostic.ts', import.meta.url))
  const started = performance.now()
  const result = await new Promise<{ error: unknown; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, ['--experimental-transform-types', diagnostic], {
      timeout: childTimeout, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1', JARVIS_TEST_SNAPSHOT_PHASES: '1', JARVIS_TEST_SNAPSHOT_PARAMETERS: JSON.stringify(parameters),
        JARVIS_CONFIG_FILE: join(root, 'missing.env'), JARVIS_DATA_DIR: join(root, 'missing-data'), JARVIS_PORT: 'invalid' },
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  const timing = { elapsedMs: Math.round(performance.now() - started), limitMs: childTimeout }
  // Fixed provenance distinguishes parent process/protocol failures from a valid
  // child-reported error without echoing output, arguments, paths or environment.
  // Protocol failures also use fixed diagnostics; assertions must not echo child output.
  if (result.stderr !== '' || Buffer.byteLength(result.stdout) > 512 || !/^\{[^\r\n]*\}\n$/.test(result.stdout)) {
    assert.fail(JSON.stringify({ origin: 'parent-process-or-protocol', ...timing, diagnostic: result.error ? sanitizeDiagnostic(result.error) : { ok: false, kind: 'unknown' } }))
  }
  let response: unknown
  try { response = JSON.parse(result.stdout) } catch { assert.fail(JSON.stringify({ ok: false, kind: 'unknown' })) }
  if (response && typeof response === 'object' && Object.hasOwn(response, 'ok') && (response as { ok: unknown }).ok === false) {
    const value = response as Record<string, unknown>
    // Reconstruct from primitive allowlisted fields; never pass through child JSON.
    const safe = sanitizeDiagnostic({ code: value.code, killed: value.killed, signal: value.signal,
      message: value.stage === 'integration-permission-check' ? 'Native integration snapshot permission verification failed' : typeof value.stage === 'string' ? `Cannot establish private Windows data permissions [${value.stage}]: use a dedicated current-account-owned local directory without links or explicit shared ACLs` : undefined })
    if (safe.kind === 'unknown' && value.kind === 'validation') safe.kind = 'validation'
    const permissionPhases = safe.stage === 'integration-permission-check' ? sanitizePermissionPhases(value.permissionPhases) : undefined
    assert.fail(JSON.stringify({ origin: 'child-report', ...timing, diagnostic: safe, ...(permissionPhases ? { permissionPhases } : {}) }))
  }
  if (result.error) assert.fail(JSON.stringify({ origin: 'parent-process', ...timing, diagnostic: sanitizeDiagnostic(result.error) }))
  assert.ok(response && typeof response === 'object' && Object.keys(response).length === 1 && (response as { ok: unknown }).ok === true, 'Invalid diagnostic success receipt')
}))

for (const platform of ['darwin', 'win32'] as const) test(`${platform} CLI captures, verifies and restores a private recovery copy offline without activation`, { timeout: childTimeout * 6 }, async () => fixture(platform, async ({ root, created }) => {
  const snapshot = join(root, 'snapshot'), destination = join(root, 'recovery')
  const [missing] = created.splice(created.length - 2, 1)
  assert.ok(missing)
  owned(root, missing)
  await unlink(missing)
  const before = await Promise.all(created.map(path => lstat(path, { bigint: true })))
  const capture = await run(['create', ...context(platform, root), '--destination', snapshot], root)
  assert.equal(capture.code, 0, capture.stderr)
  const receipt = JSON.parse(capture.stdout)
  assert.deepEqual(Object.keys(receipt).sort(), ['manifestSha256', 'snapshot'])
  assert.equal(receipt.snapshot, snapshot)
  assert.match(receipt.manifestSha256, /^[a-f0-9]{64}$/)
  for (const [index, path] of created.entries()) {
    const after = await lstat(path, { bigint: true })
    for (const key of ['ino', 'mode', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[index]![key])
    owned(root, path)
    await unlink(path)
  }
  const manifestBefore = await lstat(join(snapshot, 'manifest.json'), { bigint: true })
  const verified = await run(['verify', ...context(platform, root), '--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256], root)
  assert.equal(verified.code, 0, verified.stderr)
  assert.deepEqual(JSON.parse(verified.stdout), { verified: true, ...receipt })
  const manifestAfter = await lstat(join(snapshot, 'manifest.json'), { bigint: true })
  for (const key of ['ino', 'mode', 'mtimeNs', 'ctimeNs'] as const) assert.equal(manifestAfter[key], manifestBefore[key])
  const restore = ['restore-copy', ...context(platform, root), '--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256, '--destination', destination]
  const recovered = await run(restore, root)
  assert.equal(recovered.code, 0, recovered.stderr)
  assert.deepEqual(JSON.parse(recovered.stdout), { destination, manifestSha256: receipt.manifestSha256 })
  assert.equal(recovered.stderr, '')
  const manifestBytes = await readFile(join(destination, 'manifest.json'))
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), receipt.manifestSha256)
  const manifest = JSON.parse(manifestBytes.toString())
  assert.ok(manifest.artifacts.some((item: { path: string; bytes: number | null }) => item.path === missing && item.bytes === null))
  assert.deepEqual((await readdir(destination)).sort(), ['manifest.json', 'payload', 'receipt.bin'])
  const payloadNames = manifest.artifacts.flatMap((item: { bytes: number | null }, index: number) => item.bytes === null ? [] : [`${index}.bin`])
  assert.deepEqual((await readdir(join(destination, 'payload'))).sort(), payloadNames.sort())
  for (const file of ['manifest.json', 'receipt.bin', ...payloadNames.map((name: string) => join('payload', name))]) {
    assert.deepEqual(await readFile(join(destination, file)), await readFile(join(snapshot, file)))
    if (process.platform !== 'win32') assert.equal((await lstat(join(destination, file))).mode & 0o777, 0o600)
  }
  if (process.platform !== 'win32') for (const directory of [destination, join(destination, 'payload')]) assert.equal((await lstat(directory)).mode & 0o777, 0o700)
  const recoveredVerify = await run(['verify', ...context(platform, root), '--snapshot', destination, '--manifest-sha256', receipt.manifestSha256], root)
  assert.equal(recoveredVerify.code, 0, recoveredVerify.stderr)
  assert.deepEqual(JSON.parse(recoveredVerify.stdout), { verified: true, snapshot: destination, manifestSha256: receipt.manifestSha256 })
  const marker = join(destination, 'marker'), markerBytes = Buffer.from('existing destination must remain unchanged')
  await writeFile(marker, markerBytes, { mode: 0o600 })
  const markerBefore = await lstat(marker, { bigint: true })
  failed(await run(restore, root))
  assert.deepEqual(await readFile(marker), markerBytes)
  const markerAfter = await lstat(marker, { bigint: true })
  for (const key of ['ino', 'mode', 'mtimeNs', 'ctimeNs'] as const) assert.equal(markerAfter[key], markerBefore[key])
  assert.doesNotMatch(capture.stdout + capture.stderr + verified.stdout + verified.stderr + recovered.stdout + recovered.stderr, /PRIVATE-INTEGRATION/)
  await absent(missing)
  await absent(join(root, 'missing-data'))
  await absent(join(root, 'missing.env'))
  for (const path of created) await absent(path)
  if (process.platform !== 'win32') assert.equal((await lstat(snapshot)).mode & 0o777, 0o700)
}))

test('CLI usage fails before module discovery and create refuses protected overlap without creating destination', { timeout: childTimeout * 3 }, async () => fixture('darwin', async ({ root, integration }) => {
  const destination = join(integration.root, 'snapshot')
  const invalid = await run(['create', '--destination', destination], root)
  assert.equal(invalid.code, 2)
  assert.equal(invalid.stdout, '')
  assert.match(invalid.stderr, /^Usage:/)
  await absent(destination)
  failed(await run(['create', ...context('darwin', root), '--destination', destination], root))
  await absent(destination)
}))

test('CLI rejects tampered private payloads and shared permissions without leaking or repairing', { timeout: childTimeout * 6 }, async () => fixture('darwin', async ({ root }) => {
  const snapshot = join(root, 'snapshot')
  const capture = await run(['create', ...context('darwin', root), '--destination', snapshot], root)
  assert.equal(capture.code, 0, capture.stderr)
  const receipt = JSON.parse(capture.stdout)
  const verify = ['verify', ...context('darwin', root), '--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256]
  const payload = join(snapshot, 'payload', '0.bin'), original = await readFile(payload)
  await writeFile(payload, secret)
  failed(await run(verify, root))
  const destination = join(root, 'tampered-recovery')
  failed(await run(['restore-copy', ...verify.slice(1), '--destination', destination], root))
  await absent(destination)
  assert.deepEqual(await readFile(payload), Buffer.from(secret))
  await writeFile(payload, original)
  const manifest = join(snapshot, 'manifest.json'), manifestBytes = await readFile(manifest)
  await writeFile(manifest, secret)
  failed(await run(verify, root))
  await writeFile(manifest, manifestBytes)
  if (process.platform !== 'win32') {
    await chmod(payload, 0o644)
    failed(await run(verify, root))
    assert.equal((await lstat(payload)).mode & 0o777, 0o644)
  }
}))
