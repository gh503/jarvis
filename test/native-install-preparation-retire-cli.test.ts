import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseNativeInstallPreparationRetirementArgs as parse } from '../scripts/retire-native-install-preparation.ts'
import { describeNativeIntegration, renderNativeIntegration } from '../scripts/install-native.ts'
import { createNativeInstallTransaction } from '../scripts/native-install-transaction.ts'
import { writeNativeInstallTransaction } from '../scripts/native-install-transaction-store.ts'
import { isPublicFile } from '../scripts/packaging.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'

const cli = fileURLToPath(new URL('../scripts/retire-native-install-preparation.ts', import.meta.url))
const secret = 'PRIVATE-RETIRE-CLI-SECRET'
const timeout = process.platform === 'win32' ? 120_000 : 60_000
const scope = { uninstallCompleted: false, ownership: false, execution: false, recovery: false, automaticCleanup: false, replay: false, atomicity: false, completed: false }
const invalidReport = { schemaVersion: 1, status: 'invalid-arguments' }
const uncertainReport = { schemaVersion: 1, status: 'outcome-uncertain', requiresReview: true }
function args(platform: 'darwin' | 'win32', root: string, id: string): string[] {
  return ['retire-preparation', '--expected-transaction-id', id, '--platform', platform, '--arch', 'arm64', '--home', join(root, 'home'), '--root', join(root, 'missing-original-package'),
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
async function fixture(t: test.TestContext, platform: 'darwin' | 'win32', prepare = true) {
  const base = await fs.realpath(tmpdir()), root = await fs.mkdtemp(join(base, 'retire-cli-'))
  t.after(async () => { assert.equal(dirname(root), base); assert.ok(root.startsWith(join(base, 'retire-cli-'))); await fs.rm(root, { recursive: true, force: true }) })
  const id = randomUUID(), input = args(platform, root, id), options = parse(input)
  assert.ok('integration' in options)
  const { integration } = options, layout = describeNativeIntegration(integration)
  const directory = join(dirname(layout.receiptPath), 'native-install-control'), source = join(directory, 'prepared-transaction.json')
  if (prepare) {
    const plan = renderNativeIntegration(integration, false)
    const artifacts = plan.platform === 'darwin' ? plan.artifacts : plan.shortcuts.map(item => ({ path: item.path, bytes: Buffer.from(secret), mode: 0o600 }))
    const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, platform, root: integration.root, autostart: false, ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: artifacts.map(item => ({ path: item.path, sha256: createHash('sha256').update(item.bytes).digest('hex') })) }, null, 2) + '\n')
    const transaction = createNativeInstallTransaction({ integration, artifacts, receipt, transactionId: id })
    await writeNativeInstallTransaction({ integration, transaction })
  }
  return { root, id, input, integration, directory, source, ...layout }
}
async function snapshot(path: string): Promise<unknown> {
  const stat = await fs.lstat(path, { bigint: true })
  if (stat.isDirectory()) return Promise.all((await fs.readdir(path)).sort().filter(name => !name.startsWith('launcher.lock.sqlite')).map(async name => [name, await snapshot(join(path, name))]))
  return { bytes: stat.isFile() ? await fs.readFile(path) : undefined, ino: stat.ino, mode: stat.mode, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs }
}
async function absent(path: string) { await assert.rejects(fs.lstat(path), { code: 'ENOENT' }) }
function failure(result: Awaited<ReturnType<typeof run>>, code: number, expected: unknown, privateValues: string[]) {
  assert.equal(result.code, code)
  assert.equal(result.stdout, '')
  assert.deepEqual(JSON.parse(result.stderr), expected)
  assert.ok(result.stderr.length < 1024)
  for (const value of privateValues) assert.ok(!result.stderr.includes(value))
}

test('strict retirement parser validates all fields, duplicate/unknown switches and standalone help', () => {
  assert.deepEqual(parse(['--help']), { help: true })
  const root = join(tmpdir(), 'parser fixture'), id = randomUUID()
  const invalid: string[][] = [[], ['retire-preparation'], ['--help', secret], ['retire-preparation', '--help']]
  for (const platform of ['darwin', 'win32'] as const) for (const arch of ['x64', 'arm64']) {
    const input = args(platform, root, id).map(value => value === 'arm64' ? arch : value)
    const reversed = Array.from({ length: (input.length - 1) / 2 }, (_, i) => input.slice(1 + i * 2, 3 + i * 2)).reverse().flat()
    assert.deepEqual(parse(input), parse(['retire-preparation', ...reversed]))
    for (let i = 1; i < input.length; i += 2) {
      invalid.push(input.filter((_, index) => index !== i && index !== i + 1), [...input, input[i]!, input[i + 1]!])
      invalid.push([...input.slice(0, i), `${input[i]}=${input[i + 1]}`, ...input.slice(i + 2)])
      for (const bad of ['', ' ', 'relative', '--root', root + '\0', root + '\n', root + '\t', root + '\x7f', root + '\x85']) invalid.push(input.map((value, index) => index === i + 1 ? bad : value))
    }
    for (const flag of ['--json', '--force', '--resume', '--recover', '--cleanup', '--unknown']) invalid.push([...input, flag], [...input, flag, secret])
    for (const action of ['inspect', 'retire', 'install', 'Retire-preparation']) invalid.push([action, ...input.slice(1)])
    if (platform === 'darwin') invalid.push([...input, '--app-data', root], [...input, '--local-app-data', root])
    for (const bad of [id.toUpperCase(), '00000000-0000-0000-0000-000000000000', `${id} `]) invalid.push(input.map(value => value === id ? bad : value))
  }
  for (const input of invalid) assert.throws(() => parse(input), /^Error: invalid-arguments$/)
})

for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: subprocess retires lone preparation with absent original root`, { timeout: timeout * 2 }, async t => {
    const f = await fixture(t, platform), bytes = await fs.readFile(f.source), before = await fs.lstat(f.source, { bigint: true })
    const result = await run(f.input, f.root)
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '')
    const report = JSON.parse(result.stdout)
    assert.match(report.archiveId, new RegExp(`^retired-${f.id}-[A-Za-z0-9]+$`))
    assert.deepEqual(report, { schemaVersion: 1, status: 'retired-preparation', transactionId: f.id, archiveId: report.archiveId, scope })
    assert.ok(result.stdout.length < 2048 && !result.stdout.includes(f.root) && !result.stdout.includes(secret))
    const archived = join(f.directory, report.archiveId, 'generation', 'prepared-transaction.json')
    assert.deepEqual(await fs.readFile(archived), bytes)
    assert.equal((await fs.lstat(archived, { bigint: true })).ino, before.ino)
    for (const path of [f.source, f.integration.root, ...f.artifactPaths, f.receiptPath, join(f.root, secret), join(f.root, secret + '.env')]) await absent(path)
  })
  for (const scenario of ['wrong-id', 'wrong-root', 'artifact'] as const) test(`${platform}: subprocess ${scenario} refuses with fixed uncertain report and preserves evidence`, { timeout: timeout * 2 }, async t => {
    const f = await fixture(t, platform)
    if (scenario === 'artifact') {
      await fs.mkdir(dirname(f.artifactPaths[0]!), { recursive: true, mode: 0o700 })
      await fs.writeFile(f.artifactPaths[0]!, secret, { mode: 0o600 })
    }
    const wrongId = randomUUID(), before = await snapshot(f.root)
    const input = f.input.map(value => scenario === 'wrong-id' && value === f.id ? wrongId : scenario === 'wrong-root' && value === f.integration.root ? join(f.root, secret) : value)
    failure(await run(input, f.root), 1, uncertainReport, [f.root, f.id, wrongId, secret])
    assert.deepEqual(await snapshot(f.root), before)
  })
  test(`${platform}: malformed subprocess inputs create no operational artifacts`, { timeout: timeout * 16 }, async t => {
    const f = await fixture(t, platform, false), before = await snapshot(f.root)
    for (const input of [[], ['--help', secret], ['retire-preparation', '--help'], f.input.map(value => value === f.integration.home ? value + '\n' : value), [...f.input, '--root', f.integration.root], [...f.input, '--recover', secret], f.input.slice(0, -1), f.input.map(value => value === f.integration.home ? 'relative' : value), f.input.map(value => value === f.id ? secret : value), f.input.map(value => value === f.integration.home ? ' ' : value), f.input.map(value => value === f.integration.home ? '--force' : value)]) {
      failure(await run(input, f.root), 2, invalidReport, [f.root, f.id, secret])
      assert.deepEqual(await snapshot(f.root), before)
    }
    await absent(f.directory)
  })
}

test('standalone help/invalid input need no operational import; missing API reports uncertain outcome', { timeout: timeout * 4 }, async t => {
  const f = await fixture(t, 'darwin', false), standalone = join(f.root, 'standalone.mts')
  await fs.writeFile(standalone, await fs.readFile(cli))
  const before = await snapshot(f.root), help = await run(['--help'], f.root, standalone)
  assert.equal(help.code, 0); assert.equal(help.stderr, '')
  const report = JSON.parse(help.stdout)
  assert.equal(report.status, 'help'); assert.equal(report.schemaVersion, 1)
  assert.match(report.usage, /retire-preparation --expected-transaction-id UUID/)
  assert.match(report.description, /never automatically retry, resume, or clean up/)
  assert.deepEqual(report.scope, scope)
  failure(await run(['--help', secret], f.root, standalone), 2, invalidReport, [f.root, f.id, secret])
  failure(await run(f.input, f.root, standalone), 1, uncertainReport, [f.root, f.id, secret])
  assert.deepEqual(await snapshot(f.root), before)
})

test('packaging includes explicit retirement CLI and excludes dedicated tests', () => {
  assert.equal(isPublicFile('scripts/retire-native-install-preparation.ts'), true)
  assert.equal(isPublicFile('test/native-install-preparation-retire-cli.test.ts'), false)
})
