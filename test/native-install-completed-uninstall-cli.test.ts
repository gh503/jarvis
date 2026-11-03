import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseNativeInstallCompletedUninstallArgs as parse } from '../scripts/uninstall-native-install-transaction.ts'
import { completedFixture } from './fixtures/native-install-completed-uninstall.ts'
import { isPublicFile } from '../scripts/packaging.ts'

const cli = fileURLToPath(new URL('../scripts/uninstall-native-install-transaction.ts', import.meta.url))
const secret = 'PRIVATE-UNINSTALL-CLI-SECRET'
const timeout = process.platform === 'win32' ? 240_000 : 60_000
const scope = { automaticRecovery: false, powerLossDurability: false, producerEnabled: false }
const invalidReport = { schemaVersion: 1, status: 'invalid-arguments' }
const uncertainReport = { schemaVersion: 1, status: 'outcome-uncertain', requiresReview: true }
function args(platform: 'darwin' | 'win32', root: string, id: string): string[] {
  return ['uninstall-completed', '--expected-transaction-id', id, '--platform', platform, '--arch', process.arch, '--home', join(root, 'home'), '--root', join(root, 'package'),
    ...(platform === 'win32' ? ['--app-data', join(root, 'roaming'), '--local-app-data', join(root, 'local')] : [])]
}
async function run(input: string[], root: string, script = cli) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ['--experimental-transform-types', script, ...input], {
      timeout: timeout - 10_000, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1', JARVIS_CONFIG_FILE: join(root, secret + '.env'), JARVIS_DATA_DIR: join(root, secret), JARVIS_PORT: secret },
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) { reject(error); return }
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr })
    })
  })
}
async function temporary(t: test.TestContext) {
  const base = await fs.realpath(tmpdir()), root = await fs.mkdtemp(join(base, 'uninstall-cli-'))
  t.after(async () => { assert.equal(dirname(root), base); assert.ok(root.startsWith(join(base, 'uninstall-cli-'))); await fs.rm(root, { recursive: true, force: true }) })
  return root
}
async function fixture(t: test.TestContext, platform: 'darwin' | 'win32') {
  const f = await completedFixture(await temporary(t), platform)
  return { ...f, input: args(platform, f.root, f.transactionId) }
}
async function snapshot(path: string): Promise<unknown> {
  const stat = await fs.lstat(path, { bigint: true })
  if (stat.isDirectory()) return Promise.all((await fs.readdir(path)).sort().filter(name => !name.startsWith('launcher.lock.sqlite')).map(async name => [name, await snapshot(join(path, name))]))
  return { bytes: stat.isFile() ? await fs.readFile(path) : undefined, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs }
}
async function absent(path: string) { await assert.rejects(fs.lstat(path), { code: 'ENOENT' }) }
function failure(result: Awaited<ReturnType<typeof run>>, code: number, expected: unknown, privateValues: string[]) {
  assert.equal(result.code, code)
  assert.equal(result.stdout, '')
  assert.deepEqual(JSON.parse(result.stderr), expected)
  assert.ok(result.stderr.length < 1024)
  assert.doesNotMatch(result.stderr.trimEnd(), /[\x00-\x1f\x7f-\x9f]/)
  for (const value of privateValues) assert.ok(!result.stderr.includes(value))
}

test('strict completed uninstall parser validates all fields, duplicate/unknown switches and standalone help', () => {
  assert.deepEqual(parse(['--help']), { help: true })
  const root = join(tmpdir(), 'parser fixture'), id = randomUUID()
  const invalid: string[][] = [[], ['uninstall-completed'], ['--help', secret], ['uninstall-completed', '--help']]
  for (const platform of ['darwin', 'win32'] as const) for (const arch of ['x64', 'arm64']) {
    const input = args(platform, root, id).map(value => value === process.arch ? arch : value)
    const reversed = Array.from({ length: (input.length - 1) / 2 }, (_, i) => input.slice(1 + i * 2, 3 + i * 2)).reverse().flat()
    assert.deepEqual(parse(input), parse(['uninstall-completed', ...reversed]))
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
  test(`${platform}: subprocess removes exact completed generation with missing original root`, { timeout }, async t => {
    const f = await fixture(t, platform)
    await absent(f.integration.root)
    const names = (await fs.readdir(f.directory)).filter(name => name.startsWith('prepared-'))
    const records = await Promise.all(names.map(async name => ({ name, bytes: await fs.readFile(join(f.directory, name)), ino: (await fs.lstat(join(f.directory, name), { bigint: true })).ino })))
    const result = await run(f.input, f.root)
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '')
    const report = JSON.parse(result.stdout)
    assert.match(report.archiveId, new RegExp(`^retired-${f.transactionId}-[A-Za-z0-9]+$`))
    assert.deepEqual(report, { schemaVersion: 1, status: 'uninstalled-generation', transactionId: f.transactionId, archiveId: report.archiveId, removedCount: f.artifacts.length + 1, scope })
    assert.ok(result.stdout.length < 2048 && !result.stdout.includes(f.root) && !result.stdout.includes(secret))
    assert.doesNotMatch(result.stdout.trimEnd(), /[\x00-\x1f\x7f-\x9f]/)
    const archive = join(f.directory, report.archiveId, 'generation')
    assert.deepEqual((await fs.readdir(archive)).sort(), [...names, 'manifest.json'].sort())
    for (const record of records) {
      assert.deepEqual(await fs.readFile(join(archive, record.name)), record.bytes)
      assert.equal((await fs.lstat(join(archive, record.name), { bigint: true })).ino, record.ino)
      await absent(join(f.directory, record.name))
    }
    for (const path of [...f.artifactPaths, f.receiptPath, f.barrier, f.integration.root, join(f.root, secret), join(f.root, secret + '.env')]) await absent(path)
    assert.deepEqual((await fs.readdir(f.directory)).filter(name => !name.startsWith('launcher.lock.sqlite')), [report.archiveId])
  })
  for (const scenarios of [['wrong-id', 'wrong-root'], ['replace-receipt', 'replace-artifact'], ['unknown', 'intent', 'startup']] as const) {
    test(`${platform}: subprocess refuses ${scenarios.join('/')} and preserves evidence`, { timeout }, async t => {
      for (const scenario of scenarios) {
        const f = await fixture(t, platform)
        if (scenario.startsWith('replace-')) {
          const path = scenario === 'replace-receipt' ? f.receiptPath : f.artifacts[0]!.path
          const bytes = await fs.readFile(path), before = await fs.lstat(path, { bigint: true })
          const retained = join(f.root, 'original-retained')
          assert.ok(path.startsWith(f.root)); assert.equal(dirname(retained), f.root)
          await fs.rename(path, retained)
          await fs.writeFile(path, bytes, { mode: Number(before.mode) })
          assert.notEqual((await fs.lstat(path, { bigint: true })).ino, before.ino)
        } else if (['unknown', 'intent', 'startup'].includes(scenario)) {
          const path = scenario === 'unknown' ? join(f.directory, 'prepared-unknown') : scenario === 'intent' ? join(f.directory, 'install-intent.json') : f.artifactPaths.at(-1)!
          await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
          await fs.writeFile(path, secret, { mode: 0o600 })
        }
        const wrongId = randomUUID(), before = await snapshot(f.root)
        const input = f.input.map(value => scenario === 'wrong-id' && value === f.transactionId ? wrongId : scenario === 'wrong-root' && value === f.integration.root ? join(f.root, secret) : value)
        failure(await run(input, f.root), 1, uncertainReport, [f.root, f.transactionId, wrongId, secret])
        assert.deepEqual(await snapshot(f.root), before)
        await absent(f.barrier)
      }
    })
  }
  test(`${platform}: malformed subprocess input makes no writes or raw reports`, { timeout }, async t => {
    const root = await temporary(t), id = randomUUID(), input = args(platform, root, id), before = await snapshot(root)
    for (const malformed of [[], ['--help', secret], ['uninstall-completed', '--help'], [...input, '--root', root], [...input, '--recover', secret], input.slice(0, -1), input.map(value => value === id ? id.toUpperCase() : value), input.map(value => value === join(root, 'home') ? value + '\n' : value), input.map(value => value === join(root, 'home') ? 'relative' : value)]) {
      failure(await run(malformed, root), 2, invalidReport, [root, id, secret])
      assert.deepEqual(await snapshot(root), before)
    }
  })
}

test('standalone JSON help and invalid inputs require no operational modules; import failures are uncertain', { timeout }, async t => {
  const root = await temporary(t), standalone = join(root, 'standalone.mts'), id = randomUUID()
  await fs.writeFile(standalone, await fs.readFile(cli))
  const before = await snapshot(root), help = await run(['--help'], root, standalone)
  assert.equal(help.code, 0); assert.equal(help.stderr, '')
  const report = JSON.parse(help.stdout)
  assert.equal(report.status, 'help'); assert.equal(report.schemaVersion, 1)
  assert.match(report.usage, /uninstall-completed --expected-transaction-id UUID/)
  assert.match(report.description, /Explicit caller-authorized removal/)
  assert.match(report.description, /never automatically retry, resume, or clean up/)
  assert.match(report.limitations, /not authentication/)
  assert.deepEqual(report.scope, scope)
  failure(await run(['--help', secret], root, standalone), 2, invalidReport, [root, id, secret])
  failure(await run(args('darwin', root, id), root, standalone), 1, uncertainReport, [root, id, secret])
  assert.deepEqual(await snapshot(root), before)
})

test('packaging includes explicit uninstall CLI and excludes its test and fixture', () => {
  assert.equal(isPublicFile('scripts/uninstall-native-install-transaction.ts'), true)
  assert.equal(isPublicFile('test/native-install-completed-uninstall-cli.test.ts'), false)
  assert.equal(isPublicFile('test/fixtures/native-install-completed-uninstall.ts'), false)
})
