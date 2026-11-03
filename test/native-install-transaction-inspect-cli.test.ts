import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseNativeInstallTransactionInspectionArgs as parse } from '../scripts/inspect-native-install-transaction.ts'
import { describeNativeIntegration, renderNativeIntegration } from '../scripts/install-native.ts'
import { createNativeInstallTransaction } from '../scripts/native-install-transaction.ts'
import { writeNativeInstallTransaction } from '../scripts/native-install-transaction-store.ts'
import { createNativeInstallTransactionAck } from '../scripts/native-install-transaction-ack.ts'
import { readNativeInstallTransactionAck, writeNativeInstallTransactionAck } from '../scripts/native-install-transaction-ack-store.ts'
import { createNativeInstallTransactionCompletion } from '../scripts/native-install-transaction-completion.ts'
import { writeNativeInstallTransactionCompletion } from '../scripts/native-install-transaction-completion-store.ts'
import { isPublicFile } from '../scripts/packaging.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'

const cli = fileURLToPath(new URL('../scripts/inspect-native-install-transaction.ts', import.meta.url))
const secret = 'PRIVATE-TRANSACTION-CLI-SECRET'
const timeout = process.platform === 'win32' ? 120_000 : 60_000
const scope = { ownership: false, execution: false, automaticCleanup: false, replay: false, atomicity: false, completed: false }
const limitations = { sourcePolicy: 'legacy-integration', sourceWindowsAcl: false, controlPolicy: 'private-install-control', cooperatingWritersOnly: true, observationsAtomic: false, acknowledgementAuthenticity: false }
function args(platform: 'darwin' | 'win32', root: string): string[] {
  return ['inspect', '--platform', platform, '--arch', 'arm64', '--home', join(root, 'home'), '--root', join(root, 'package'),
    ...(platform === 'win32' ? ['--app-data', join(root, 'roaming'), '--local-app-data', join(root, 'local')] : [])]
}
async function run(input: string[], root: string, script = cli) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ['--experimental-transform-types', script, ...input], {
      timeout, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1', JARVIS_CONFIG_FILE: join(root, secret + '.env'), JARVIS_DATA_DIR: join(root, secret), JARVIS_PORT: secret },
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) { reject(error); return }
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr })
    })
  })
}
async function fixture(t: test.TestContext, platform: 'darwin' | 'win32') {
  const base = await fs.realpath(tmpdir()), root = await fs.mkdtemp(join(base, 'transaction-cli-'))
  t.after(async () => { assert.equal(dirname(root), base); assert.ok(root.startsWith(join(base, 'transaction-cli-'))); await fs.rm(root, { recursive: true, force: true }) })
  const options = parse(args(platform, root))
  assert.ok('integration' in options)
  const { integration } = options
  const layout = describeNativeIntegration(integration)
  const directory = join(dirname(layout.receiptPath), 'native-install-control')
  return { root, integration, directory, ...layout }
}
// atime and operational SQLite files may change. Everything else must survive.
async function snapshot(path: string): Promise<unknown> {
  const stat = await fs.lstat(path, { bigint: true })
  if (stat.isDirectory()) return Promise.all((await fs.readdir(path)).sort().filter(name => !name.startsWith('launcher.lock.sqlite')).map(async name => [name, await snapshot(join(path, name))]))
  return { bytes: stat.isFile() ? await fs.readFile(path) : undefined, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs }
}
async function absent(path: string) { await assert.rejects(fs.lstat(path), { code: 'ENOENT' }) }
async function report(f: Awaited<ReturnType<typeof fixture>>, status: string, issues: unknown[], declaration = status === 'no-transaction' ? 'not-inspected' : status === 'blocked' ? 'unavailable' : 'absent') {
  const result = await run(args(f.integration.platform as 'darwin' | 'win32', f.root), f.root)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), { status, declaration, issues, scope, limitations })
  assert.ok(result.stdout.length < 4096)
  for (const privateText of [f.root, secret, 'sha256', 'base64', 'identity', 'transactionId']) assert.ok(!result.stdout.includes(privateText))
  await absent(join(f.root, secret))
  await absent(join(f.root, secret + '.env'))
}

test('strict parser accepts explicit reordered contexts; rejects missing, duplicate, control and mutation arguments', () => {
  assert.deepEqual(parse(['--help']), { help: true })
  const root = join(tmpdir(), 'parser fixture')
  const invalid: string[][] = [[], ['inspect'], ['--help', secret], ['inspect', '--help']]
  for (const platform of ['darwin', 'win32'] as const) for (const arch of ['x64', 'arm64']) {
    const input = args(platform, root).map(value => value === 'arm64' ? arch : value)
    const reversed = Array.from({ length: (input.length - 1) / 2 }, (_, i) => input.slice(1 + i * 2, 3 + i * 2)).reverse().flat()
    assert.deepEqual(parse(input), parse(['inspect', ...reversed]))
    for (let i = 1; i < input.length; i += 2) {
      invalid.push(input.filter((_, index) => index !== i && index !== i + 1), [...input, input[i]!, input[i + 1]!])
      invalid.push([...input.slice(0, i), `${input[i]}=${input[i + 1]}`, ...input.slice(i + 2)])
      for (const bad of ['', 'relative', '--root', root + '\0', root + '\n', root + '\t', root + '\x7f', root + '\x85']) invalid.push(input.map((value, index) => index === i + 1 ? bad : value))
    }
    for (const flag of ['--json', '--force', '--recover', '--publish', '--cleanup', '--unknown']) invalid.push([...input, flag], [...input, flag, secret])
    for (const action of ['diagnose', 'recover', 'install', 'Inspect']) invalid.push([action, ...input.slice(1)])
    if (platform === 'darwin') invalid.push([...input, '--app-data', root], [...input, '--local-app-data', root])
  }
  for (const input of invalid) assert.throws(() => parse(input), /^Error: Usage:/)
})

for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: missing preparation preserves orphan slots; only operational lock files appear`, { timeout }, async t => {
    const f = await fixture(t, platform), path = f.artifactPaths[0]!
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await fs.writeFile(path, secret, { mode: 0o600 })
    const before = await snapshot(path)
    await report(f, 'no-transaction', [{ reason: 'preparation-missing' }])
    assert.deepEqual(await snapshot(path), before)
    assert.ok((await fs.lstat(join(f.directory, 'launcher.lock.sqlite'))).isFile())
    assert.deepEqual((await fs.readdir(f.directory)).filter(name => !name.startsWith('launcher.lock.sqlite')), [])
    for (const other of [...f.artifactPaths.slice(1), f.receiptPath, f.integration.root]) await absent(other)
  })
  test(`${platform}: orphan control records produce fixed sanitized CLI reports`, { timeout }, async t => {
    const f = await fixture(t, platform)
    await report(f, 'no-transaction', [{ reason: 'preparation-missing' }])
    await fs.writeFile(join(f.directory, 'PREPARED-ARTIFACT-unknown.json'), secret, { mode: 0o600 })
    const before = await snapshot(f.root)
    await report(f, 'blocked', [{ reason: 'orphan-record' }], 'not-inspected')
    assert.deepEqual(await snapshot(f.root), before)
  })
  test(`${platform}: canonical operation names add only exact sanitized hints`, { timeout }, async t => {
    const f = await fixture(t, platform)
    await report(f, 'no-transaction', [{ reason: 'preparation-missing' }])
    const id = '12345678-abcd-4abc-8abc-123456789abc'
    await fs.mkdir(join(f.directory, `prepared-retiring-${id}`), { mode: 0o700 })
    await fs.writeFile(join(f.directory, `prepared-uninstalling-${id}`), secret, { mode: 0o600 })
    await fs.writeFile(join(f.directory, 'prepared-unknown'), secret, { mode: 0o600 })
    const before = await snapshot(f.root)
    const result = await run(args(platform, f.root), f.root)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), { status: 'blocked', declaration: 'not-inspected', issues: [{ reason: 'orphan-record' }], scope, limitations,
      retainedOperationNames: { retirement: true, uninstall: true, observedNamesOnly: true } })
    for (const value of [id, f.root, secret, 'prepared-', 'manifest']) assert.ok(!result.stdout.includes(value))
    assert.deepEqual(await snapshot(f.root), before)
  })
  test(`${platform}: manual preparation and observed acks produce bounded reports without changing installation files`, { timeout: timeout * 5 }, async t => {
    const f = await fixture(t, platform)
    const plan = renderNativeIntegration(f.integration, false)
    const artifacts = plan.platform === 'darwin' ? plan.artifacts : plan.shortcuts.map(item => ({ path: item.path, bytes: Buffer.from(secret), mode: 0o600 }))
    const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, platform, root: f.integration.root, autostart: false, ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: artifacts.map(item => ({ path: item.path, sha256: createHash('sha256').update(item.bytes).digest('hex') })) }, null, 2) + '\n')
    const transaction = createNativeInstallTransaction({ integration: f.integration, artifacts, receipt, transactionId: randomUUID() })
    await writeNativeInstallTransaction({ ...f, transaction })
    for (const artifact of artifacts) {
      await fs.mkdir(dirname(artifact.path), { recursive: true, mode: 0o700 })
      await fs.writeFile(artifact.path, artifact.bytes, { mode: artifact.mode })
    }
    let before = await snapshot(f.root)
    await report(f, 'blocked', artifacts.map((_, artifactIndex) => ({ reason: 'ack-missing', artifactIndex })))
    assert.deepEqual(await snapshot(f.root), before)
    for (const [artifactIndex, artifact] of artifacts.entries()) {
      const ack = createNativeInstallTransactionAck({ ...f, transaction, artifactIndex, observation: { bytes: artifact.bytes, identity: await fs.lstat(artifact.path, { bigint: true }) } })
      await writeNativeInstallTransactionAck({ ...f, transaction, ack })
    }
    before = await snapshot(f.root)
    await report(f, 'receipt-absent', [{ reason: 'all-artifacts-match' }])
    assert.deepEqual(await snapshot(f.root), before)
    await absent(f.receiptPath)
    await fs.writeFile(f.receiptPath, receipt, { mode: 0o600 })
    before = await snapshot(f.root)
    await report(f, 'receipt-present', [{ reason: 'all-artifacts-match' }])
    assert.deepEqual(await snapshot(f.root), before)
    const acks = []
    for (const artifactIndex of artifacts.keys()) {
      const ack = await readNativeInstallTransactionAck({ ...f, transaction, artifactIndex })
      assert.ok(ack); acks.push(ack)
    }
    const completion = createNativeInstallTransactionCompletion({ ...f, transaction, acks, observation: { bytes: receipt, identity: await fs.lstat(f.receiptPath, { bigint: true }) } })
    await writeNativeInstallTransactionCompletion({ ...f, transaction, acks, completion })
    before = await snapshot(f.root)
    await report(f, 'receipt-present', [{ reason: 'all-artifacts-match' }], 'matching')
    assert.deepEqual(await snapshot(f.root), before)
    await fs.writeFile(artifacts[0]!.path, secret + '-tampered')
    before = await snapshot(f.root)
    await report(f, 'conflict', [{ reason: 'artifact-mismatch', artifactIndex: 0 }], 'unavailable')
    assert.deepEqual(await snapshot(f.root), before)
    await fs.writeFile(join(f.directory, 'prepared-transaction.json'), '{' + secret, { mode: 0o600 })
    before = await snapshot(f.root)
    await report(f, 'blocked', [{ reason: 'unsafe-or-unavailable' }])
    assert.deepEqual(await snapshot(f.root), before)
    await absent(f.integration.root)
  })
}

test('standalone help and malformed secret arguments need no operational imports; missing module failure is sanitized', { timeout: timeout * 3 }, async t => {
  const f = await fixture(t, 'darwin'), standalone = join(f.root, 'standalone.mts')
  await fs.writeFile(standalone, await fs.readFile(cli))
  const help = await run(['--help'], f.root, standalone)
  assert.equal(help.code, 0)
  assert.equal(help.stderr, '')
  assert.match(help.stdout, /operational lock directories and SQLite files may be created/)
  assert.match(help.stdout, /not that installation is healthy or absent/)
  for (const input of [[...args('darwin', f.root), '--recover', secret], ['--help', secret], args('darwin', f.root).map(value => value === 'arm64' ? secret : value)]) {
    const invalid = await run(input, f.root, standalone)
    assert.equal(invalid.code, 2)
    assert.equal(invalid.stdout, '')
    assert.match(invalid.stderr, /^Usage:/)
    assert.ok(invalid.stderr.length < 1024)
    assert.ok(!invalid.stderr.includes(secret) && !invalid.stderr.includes(f.root))
  }
  const failed = await run(args('darwin', f.root), f.root, standalone)
  assert.equal(failed.code, 1)
  assert.equal(failed.stdout, '')
  assert.equal(failed.stderr, 'Native install transaction inspection failed: unable to complete the requested operation\n')
  await absent(f.directory)
  await absent(join(f.root, secret))
})

test('packaging includes inspection CLI and excludes its tests', () => {
  assert.equal(isPublicFile('scripts/inspect-native-install-transaction.ts'), true)
  assert.equal(isPublicFile('test/native-install-transaction-inspect-cli.test.ts'), false)
})
