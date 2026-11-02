import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseNativeInstallDiagnosisArgs } from '../scripts/diagnose-native-install.ts'
import { describeNativeIntegration, nativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { createNativeInstallIntent, type NativeInstallArtifactExpected } from '../scripts/native-install-intent.ts'
import { writeNativeInstallIntent } from '../scripts/native-install-intent-store.ts'

const cli = fileURLToPath(new URL('../scripts/diagnose-native-install.ts', import.meta.url))
const absolute = join(tmpdir(), 'diagnosis parser')
const secret = 'PRIVATE-DIAGNOSIS-BYTES-MUST-NOT-PRINT'
const timeout = process.platform === 'win32' ? 120_000 : 60_000
const scope = { ownership: false, execution: false, automaticCleanup: false, atomicity: false }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function args(platform: 'darwin' | 'win32', root = absolute): string[] {
  return ['diagnose', '--platform', platform, '--arch', 'arm64', '--home', join(root, 'home'), '--root', join(root, 'package'),
    ...(platform === 'win32' ? ['--app-data', join(root, 'roaming'), '--local-app-data', join(root, 'local')] : [])]
}

test('diagnosis parser requires explicit context and accepts reordered options and both architectures', () => {
  for (const platform of ['darwin', 'win32'] as const) for (const arch of ['x64', 'arm64']) {
    const input = args(platform).map(value => value === 'arm64' ? arch : value)
    const reversed = Array.from({ length: (input.length - 1) / 2 }, (_, i) => input.slice(1 + i * 2, 3 + i * 2)).reverse().flat()
    const expected = { integration: { platform, arch, home: join(absolute, 'home'), root: join(absolute, 'package'),
      ...(platform === 'win32' ? { appData: join(absolute, 'roaming'), localAppData: join(absolute, 'local') } : {}) } }
    assert.deepEqual(parseNativeInstallDiagnosisArgs(input), expected)
    assert.deepEqual(parseNativeInstallDiagnosisArgs(['diagnose', ...reversed]), expected)
  }
})

test('diagnosis parser rejects missing, duplicate, unknown, conditional, relative and control-bearing values', () => {
  const invalid: string[][] = [[], ['diagnose'], ['--help'], args('darwin').slice(1)]
  for (const action of ['--diagnose', 'install', 'uninstall', 'create', 'verify', 'persist', 'activate', 'Diagnose']) invalid.push([action, ...args('darwin').slice(1)])
  for (const platform of ['darwin', 'win32'] as const) {
    const input = args(platform)
    invalid.push([...input, '--force'], [...input, '--unknown', absolute], [...input, 'diagnose'])
    for (let i = 1; i < input.length; i += 2) {
      invalid.push(input.filter((_, index) => index !== i && index !== i + 1))
      invalid.push([...input, input[i]!, input[i + 1]!])
      invalid.push(input.map((value, index) => index === i ? '--unknown' : value))
      invalid.push([...input.slice(0, i), `${input[i]}=${input[i + 1]}`, ...input.slice(i + 2)])
      for (const bad of ['', 'relative', '--home', absolute + '\0', absolute + '\n', absolute + '\r', absolute + '\t', absolute + '\x7f', absolute + '\x85', absolute + '\x9f']) {
        invalid.push(input.map((value, index) => index === i + 1 ? bad : value))
      }
    }
    for (const bad of ['linux', 'Darwin']) invalid.push(input.map((value, index) => index === 2 ? bad : value))
    for (const bad of ['ia32', 'ARM64']) invalid.push(input.map((value, index) => index === 4 ? bad : value))
    if (platform === 'darwin') for (const option of ['--app-data', '--local-app-data']) invalid.push([...input, option, absolute])
  }
  for (const input of invalid) assert.throws(() => parseNativeInstallDiagnosisArgs(input), /^Error: Usage:/, JSON.stringify(input))
})

async function run(input: string[], root: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ['--experimental-transform-types', cli, ...input], {
      timeout, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1', JARVIS_CONFIG_FILE: join(root, 'missing.env'), JARVIS_DATA_DIR: join(root, 'missing-data'), JARVIS_PORT: 'invalid' },
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) { reject(error); return }
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr })
    })
  })
}
async function fixture(t: test.TestContext, platform: 'darwin' | 'win32') {
  const base = await realpath(tmpdir()), root = await mkdtemp(join(base, 'native-diagnose-cli-'))
  t.after(async () => {
    assert.equal(dirname(root), base)
    assert.ok(root.startsWith(join(base, 'native-diagnose-cli-')))
    await rm(root, { recursive: true, force: true })
  })
  const { integration } = parseNativeInstallDiagnosisArgs(args(platform, root))
  const layout = describeNativeIntegration(integration)
  const controlDirectory = join(dirname(layout.receiptPath), 'native-install-control')
  return { root, integration, ...layout, controlDirectory, intentPath: join(controlDirectory, 'install-intent.json') }
}
async function snapshot(path: string) {
  const stat = await lstat(path, { bigint: true })
  return { bytes: await readFile(path), metadata: [stat.dev, stat.ino, stat.mode, stat.nlink, stat.uid, stat.gid, stat.size, stat.mtimeNs, stat.ctimeNs] }
}
async function absent(path: string) { await assert.rejects(lstat(path), { code: 'ENOENT' }) }
function failure(result: Awaited<ReturnType<typeof run>>) {
  assert.equal(result.code, 1, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Native install diagnosis failed: unable to complete the requested operation\n')
  assert.ok(Buffer.byteLength(result.stderr) < 1024)
}
async function report(f: Awaited<ReturnType<typeof fixture>>, status: string) {
  const result = await run(args(f.integration.platform as 'darwin' | 'win32', f.root), f.root)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.status, status)
  assert.deepEqual(parsed.scope, scope)
  assert.doesNotMatch(result.stdout, /PRIVATE-DIAGNOSIS|sha256|"binding"|"configFile"|"dataDir"|"bytes"/)
  assert.ok(!result.stdout.includes(f.integration.root))
  await absent(join(f.root, 'missing.env'))
  await absent(join(f.root, 'missing-data'))
  if (status !== 'no-intent') {
    assert.deepEqual(Object.keys(parsed).sort(), ['artifacts', 'receipt', 'scope', 'status'])
    assert.equal(parsed.receipt.path, f.receiptPath)
    assert.deepEqual(parsed.artifacts.map((entry: { path: string }) => entry.path), f.artifactPaths)
    for (const entry of [parsed.receipt, ...parsed.artifacts]) assert.ok(Object.keys(entry).every(key => ['path', 'status', 'reason'].includes(key)))
  }
  return parsed
}

for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: missing intent preserves orphan and creates only operational control files`, { timeout }, async t => {
    const f = await fixture(t, platform), path = f.artifactPaths[0]!
    await mkdir(dirname(path), { recursive: true, mode: 0o755 })
    await writeFile(path, secret, { mode: 0o600 })
    const before = await snapshot(path)
    assert.deepEqual(await report(f, 'no-intent'), { status: 'no-intent', scope })
    assert.deepEqual(await snapshot(path), before)
    assert.ok((await lstat(join(f.controlDirectory, 'launcher.lock.sqlite'))).isFile())
    await absent(f.intentPath)
    await absent(f.receiptPath)
    for (const other of f.artifactPaths.slice(1)) await absent(other)
    await absent(f.integration.root)
  })

  test(`${platform}: unpublished, incomplete, conflict and indeterminate reports exit zero without mutation`, { timeout: timeout * 5 }, async t => {
    const f = await fixture(t, platform), path = f.artifactPaths[0]!, bytes = Buffer.from(secret)
    await mkdir(dirname(path), { recursive: true, mode: 0o755 })
    await writeFile(path, bytes, { mode: 0o600 })
    const mode = (await lstat(path)).mode & 0o7777
    // Remove only this fixture's fixed slot before publishing an all-absent plan.
    assert.ok(path.startsWith(f.root + '/') || path.startsWith(f.root + '\\'))
    await rm(path)
    const intent = createNativeInstallIntent({ integration: f.integration, binding: { root: f.integration.root, autostart: false },
      expectedArtifacts: { [path]: { sha256: hash(bytes), bytes: bytes.length, mode } } })
    await writeNativeInstallIntent({ integration: f.integration, intent })
    const intentBefore = await snapshot(f.intentPath)
    await report(f, 'unpublished')
    await writeFile(path, bytes, { mode: 0o600 })
    const before = await snapshot(path)
    const incomplete = await report(f, 'incomplete')
    assert.equal(incomplete.receipt.status, 'missing')
    assert.equal(incomplete.artifacts[0].status, 'matching')
    assert.deepEqual(await snapshot(path), before)
    await writeFile(path, 'tampered-' + secret)
    const tampered = await snapshot(path)
    const conflict = await report(f, 'conflict')
    assert.equal(conflict.artifacts[0].reason, 'bytes-mismatch')
    assert.deepEqual(await snapshot(path), tampered)
    assert.deepEqual(await snapshot(f.intentPath), intentBefore)
    await absent(f.receiptPath)
    await absent(f.integration.root)
    const unknown = await fixture(t, platform), unknownPath = unknown.artifactPaths[0]!
    await mkdir(dirname(unknownPath), { recursive: true, mode: 0o755 })
    await writeFile(unknownPath, secret, { mode: 0o600 })
    await writeNativeInstallIntent({ integration: unknown.integration, intent: createNativeInstallIntent({ integration: unknown.integration, binding: { root: unknown.integration.root, autostart: false } }) })
    assert.equal((await report(unknown, 'indeterminate')).artifacts[0].reason, 'unknown-expectation')
  })

  test(`${platform}: consistent synthetic installation exits zero and never executes fixture bytes`, { timeout: timeout * 2 }, async t => {
    const f = await fixture(t, platform), files = []
    for (const path of [`runtime/${platform === 'win32' ? 'node.exe' : 'node'}`, 'scripts/app.ts', 'scripts/install-native.ts', 'src/main.ts']) {
      const bytes = Buffer.from(secret)
      await mkdir(dirname(join(f.integration.root, path)), { recursive: true, mode: 0o755 })
      await writeFile(join(f.integration.root, path), bytes)
      files.push({ path, bytes: bytes.length, sha256: hash(bytes) })
    }
    await writeFile(join(f.integration.root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, platform, arch: 'arm64', runtime: { version: 'v24.14.0', platform, arch: 'arm64' }, files }))
    const integration: InstallOptions = { ...f.integration, runPowerShell: (_script, env) => writeFileSync(env.JARVIS_LINK_PATH!, secret, { mode: 0o600 }) }
    await nativeIntegration(integration, ['--install'])
    const expectedArtifacts: Record<string, NativeInstallArtifactExpected> = {}
    for (const path of f.artifactPaths.slice(0, -1)) {
      const bytes = await readFile(path)
      expectedArtifacts[path] = { sha256: hash(bytes), bytes: bytes.length, mode: (await lstat(path)).mode & 0o7777 }
    }
    await writeNativeInstallIntent({ integration, intent: createNativeInstallIntent({ integration, binding: { root: integration.root, autostart: false }, expectedArtifacts, expectedReceipt: await readFile(f.receiptPath) }) })
    const paths = [f.intentPath, f.receiptPath, ...f.artifactPaths.slice(0, -1)]
    const before = await Promise.all(paths.map(snapshot))
    await report(f, 'consistent')
    assert.deepEqual(await Promise.all(paths.map(snapshot)), before)
  })
}

test('usage rejection precedes operational import, while malformed intent is a bounded operational failure', { timeout: timeout * 3 }, async t => {
  const f = await fixture(t, 'darwin')
  // A standalone copy has no operational sibling: invalid usage must still exit 2.
  const standalone = join(f.root, 'standalone.mts')
  await writeFile(standalone, await readFile(cli))
  const rejected = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ['--experimental-transform-types', standalone, ...args('darwin', f.root), '--unknown', secret],
      { timeout, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') { reject(error); return }
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr })
      })
  })
  assert.equal(rejected.code, 2)
  assert.equal(rejected.stdout, '')
  assert.match(rejected.stderr, /^Usage:/)
  assert.ok(rejected.stderr.length < 1024)
  assert.ok(!rejected.stderr.includes(secret))
  await absent(f.controlDirectory)
  await report(f, 'no-intent')
  await writeFile(f.intentPath, '{' + secret, { mode: 0o600 })
  const before = await snapshot(f.intentPath)
  failure(await run(args('darwin', f.root), f.root))
  assert.deepEqual(await snapshot(f.intentPath), before)
})

test('CLI contention fails safely while reachable child lock survives GC, then succeeds after release', { timeout: timeout * 3 }, async t => {
  const f = await fixture(t, 'darwin'), path = f.artifactPaths[0]!
  await mkdir(dirname(path), { recursive: true, mode: 0o755 })
  await writeFile(path, secret, { mode: 0o600 })
  const before = await snapshot(path)
  const moduleUrl = new URL('../scripts/native-install-lock.ts', import.meta.url).href
  const child = spawn(process.execPath, ['--expose-gc', '--experimental-transform-types', '--input-type=module', '-e', `
    import { withNativeInstallLock } from ${JSON.stringify(moduleUrl)};
    await withNativeInstallLock({ controlDirectory: process.env.TEST_CONTROL }, async () => {
      await new Promise((resolve, reject) => {
        process.stdin.once('end', resolve);
        process.stdin.once('error', reject);
        process.stdin.on('data', () => { global.gc(); process.stdout.write('ALIVE\\n'); });
        process.stdout.write('READY\\n');
      });
    });
  `], { env: { ...process.env, NODE_NO_WARNINGS: '1', TEST_CONTROL: f.controlDirectory }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  function message(expected: string, request?: string) {
    return new Promise<void>((resolve, reject) => {
      let output = ''
      const cleanup = () => { child.stdout.off('data', onData); child.off('exit', onExit); child.off('error', onError) }
      const onData = (data: Buffer) => { output += data; if (output.includes(expected)) { cleanup(); resolve() } }
      const onExit = () => { cleanup(); reject(new Error(`Lock holder exited: ${stderr}`)) }
      const onError = (error: Error) => { cleanup(); reject(error) }
      child.stdout.on('data', onData); child.once('exit', onExit); child.once('error', onError)
      if (request) child.stdin.write(request)
    })
  }
  await message('READY')
  await message('ALIVE', 'GC and acknowledge\n')
  failure(await run(args('darwin', f.root), f.root))
  await message('ALIVE', 'GC and acknowledge\n')
  assert.deepEqual(await snapshot(path), before)
  await absent(f.intentPath)
  await absent(f.receiptPath)
  child.stdin.end()
  assert.deepEqual(await exited, [0, null])
  await report(f, 'no-intent')
  assert.deepEqual(await snapshot(path), before)
})
