import assert from 'node:assert/strict'
import { constants, existsSync, writeFileSync } from 'node:fs'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import fs, { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test as nodeTest, type TestContext } from 'node:test'
import { nativeIntegration, parseArgs } from '../scripts/install-native.ts'
import { readNativeInstallTransaction } from '../scripts/native-install-transaction-store.ts'
import { inspectNativeInstallTransaction } from '../scripts/native-install-transaction-inspect.ts'
import { uninstallCompletedNativeInstallTransaction } from '../scripts/native-install-completed-uninstall.ts'
import { producerFixture } from './fixtures/native-install-transaction-producer.ts'

const partition = process.env.JARVIS_INSTALL_PRODUCER_PARTITION
if (partition !== undefined && !['0', '1', '2', '3', '4', '5', '6', '7'].includes(partition)) throw new Error('JARVIS_INSTALL_PRODUCER_PARTITION must be exactly 0 through 7')
let ordinal = 0
const test = ((...args: Parameters<typeof nodeTest>) => { if (partition === undefined || ordinal++ % 8 === Number(partition)) return nodeTest(...args) }) as typeof nodeTest

async function fixture(t: TestContext, platform: 'darwin' | 'win32') {
  const base = await realpath(tmpdir()), directory = await mkdtemp(join(base, 'jarvis-producer-'))
  let child: ChildProcess | undefined
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()))
      child.kill('SIGKILL')
      await exited
    }
    assert.equal(dirname(directory), base); assert.equal(await realpath(directory), directory); assert.ok(directory.startsWith(join(base, 'jarvis-producer-'))); await rm(directory, { recursive: true, force: true }) })
  return { ...await producerFixture(directory, platform), directory, trackChild(value: ChildProcess) { child = value } }
}
function mockOpen(t: TestContext, intercept: (handle: Awaited<ReturnType<typeof open>>, path: string, flags: unknown) => void) {
  const original = fs.open
  t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => { const handle = await original(...args); intercept(handle, String(args[0]), args[1]); return handle })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
}

test('transaction action is explicit and incompatible action/autostart combinations refuse', () => {
  assert.deepEqual(parseArgs(['--install-transaction']), { action: 'install-transaction', autostart: false })
  for (const other of ['--autostart', '--install', '--uninstall', '--install-transaction']) assert.throws(() => parseArgs(['--install-transaction', other]))
})
for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: real producer -> matching inspection -> completed uninstall -> fresh UUID, archives preserved`, async t => {
    const f = await fixture(t, platform)
    const output = await nativeIntegration(f.integration, ['--install-transaction'])
    assert.deepEqual(output, [...f.layout.artifactPaths.slice(0, -1), f.layout.receiptPath])
    assert.equal((await inspectNativeInstallTransaction({ integration: f.integration })).declaration, 'matching')
    const first = (await readNativeInstallTransaction({ integration: f.integration }))!
    const removed = await uninstallCompletedNativeInstallTransaction({ integration: f.integration, transactionId: first.transactionId })
    const archived = await readFile(join(removed.archiveDirectory, 'prepared-transaction.json'))
    await nativeIntegration(f.integration, ['--install-transaction'])
    const second = (await readNativeInstallTransaction({ integration: f.integration }))!
    assert.notEqual(first.transactionId, second.transactionId)
    assert.deepEqual(await readFile(join(removed.archiveDirectory, 'prepared-transaction.json')), archived)
    assert.equal((await inspectNativeInstallTransaction({ integration: f.integration })).declaration, 'matching')
  })
  test(`${platform}: default producer emits no transaction records`, async t => {
    const f = await fixture(t, platform)
    await nativeIntegration(f.integration, ['--install'])
    assert.deepEqual((await readdir(f.control)).filter(name => name.startsWith('prepared-')), [])
    await nativeIntegration(f.integration, ['--uninstall'])
  })
  for (const name of ['PREPARED-unknown', 'INSTALL-INTENT.JSON', 'prepared-completion.json', 'prepared-artifact-99.json']) test(`${platform}: fresh residue ${name} refuses before config/package/COM`, async t => {
    const f = await fixture(t, platform)
    await mkdir(f.control, { recursive: true, mode: 0o700 })
    await writeFile(join(f.control, name), 'evidence', { mode: 0o600 })
    f.integration.root = join(f.directory, 'missing-package')
    f.integration.runPowerShell = () => assert.fail('COM must not run')
    await assert.rejects(nativeIntegration(f.integration, ['--install-transaction', '--config', join(f.directory, 'missing-config')]), /residue|intent/i)
    assert.equal(existsSync(f.layout.receiptPath), false)
  })
  for (const record of ['prepared-transaction.json', 'prepared-artifact-0.json', 'prepared-completion.json']) for (const failure of ['write', 'sync', 'close'] as const) test(`${platform}: ${record} ${failure} failure retains evidence and prior outputs`, async t => {
    const f = await fixture(t, platform)
    mockOpen(t, (handle, path, flags) => {
      if (path !== join(f.control, record) || typeof flags !== 'number' || !(flags & constants.O_CREAT)) return
      if (failure === 'write') t.mock.method(handle, 'writeFile', async () => { throw new Error('injected write') })
      if (failure === 'sync') t.mock.method(handle, 'sync', async () => { throw new Error('injected sync') })
      if (failure === 'close') { const close = handle.close.bind(handle); t.mock.method(handle, 'close', async () => { await close(); throw new Error('injected close') }) }
    })
    await assert.rejects(nativeIntegration(f.integration, ['--install-transaction']), /injected/)
    assert.ok(existsSync(join(f.control, record)))
    assert.equal(existsSync(f.layout.artifactPaths[0]!), record !== 'prepared-transaction.json')
    assert.equal(existsSync(f.layout.receiptPath), record === 'prepared-completion.json')
    await assert.rejects(nativeIntegration(f.integration, ['--install-transaction']))
  })
  test(`${platform}: actual output reads occur after close`, async t => {
    const f = await fixture(t, platform), closed = new Set<string>()
    const paths = new Set([...f.layout.artifactPaths.slice(0, -1), f.layout.receiptPath])
    mockOpen(t, (handle, path, flags) => {
      if (!paths.has(path)) return
      if (flags === 'wx') { const close = handle.close.bind(handle); t.mock.method(handle, 'close', async () => { await close(); closed.add(path) }) }
      else assert.ok(closed.has(path), `read before output close: ${path}`)
    })
    await nativeIntegration(f.integration, ['--install-transaction'])
    assert.equal(closed.size, paths.size)
  })
  test(`${platform}: completion persistence mutation is detected before success`, async t => {
    const f = await fixture(t, platform)
    mockOpen(t, (handle, path, flags) => {
      if (path !== join(f.control, 'prepared-completion.json') || typeof flags !== 'number' || !(flags & constants.O_CREAT)) return
      const sync = handle.sync.bind(handle)
      t.mock.method(handle, 'sync', async () => { await sync(); await writeFile(f.layout.artifactPaths[0]!, 'changed') })
    })
    await assert.rejects(nativeIntegration(f.integration, ['--install-transaction']), /changed/)
    assert.ok(existsSync(join(f.control, 'prepared-completion.json')))
    assert.equal(await readFile(f.layout.artifactPaths[0]!, 'utf8'), 'changed')
  })
}
for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: explicit config binds canonical path and data without secrets`, async t => {
    const f = await fixture(t, platform), config = join(f.directory, 'config.env'), dataDir = join(f.directory, 'data')
    await writeFile(config, `JARVIS_DATA_DIR="${dataDir}"\nJARVIS_AUTH_TOKEN=secret-not-in-records\n`, { mode: 0o600 })
    await nativeIntegration(f.integration, ['--install-transaction', '--config', config])
    const tx = (await readNativeInstallTransaction({ integration: f.integration }))!
    assert.deepEqual(tx.binding, { root: f.integration.root, autostart: false, configFile: await realpath(config), dataDir })
    assert.equal(JSON.stringify(tx).includes('secret-not-in-records'), false)
    assert.equal((await inspectNativeInstallTransaction({ integration: f.integration })).declaration, 'matching')
  })
  test(`${platform}: existing startup refuses before config observation`, async t => {
    const f = await fixture(t, platform), startup = f.layout.artifactPaths.at(-1)!
    await mkdir(dirname(startup), { recursive: true, mode: 0o700 })
    await writeFile(startup, 'existing', { mode: 0o600 })
    await assert.rejects(nativeIntegration(f.integration, ['--install-transaction', '--config', join(f.directory, 'missing')]), /already exists/)
    assert.equal(await readFile(startup, 'utf8'), 'existing')
    assert.equal(existsSync(join(f.control, 'prepared-transaction.json')), false)
  })
  for (const unexpected of ['prepared-completion.json', `prepared-artifact-${platform === 'darwin' ? 2 : 1}.json`, 'prepared-unknown']) test(`${platform}: phase guard refuses ${unexpected} appearing at artifact close`, async t => {
    const f = await fixture(t, platform)
    mockOpen(t, (handle, path, flags) => {
      if (path !== f.layout.artifactPaths[0] || flags !== 'wx') return
      const close = handle.close.bind(handle)
      t.mock.method(handle, 'close', async () => { await close(); await writeFile(join(f.control, unexpected), 'unexpected', { mode: 0o600 }) })
    })
    await assert.rejects(nativeIntegration(f.integration, ['--install-transaction']), /phase residue/)
    assert.ok(existsSync(f.layout.artifactPaths[0]!))
    assert.equal(existsSync(join(f.control, 'prepared-artifact-0.json')), false)
  })
}
test('concurrent caller mutations cannot change captured integration options', async t => {
  const f = await fixture(t, 'win32'), originalRoot = f.integration.root, originalPowerShell = f.integration.runPowerShell!
  f.integration.runPowerShell = (script, env) => { f.integration.root = join(f.directory, 'wrong-root'); f.integration.home = join(f.directory, 'wrong-home'); originalPowerShell(script, env) }
  const result = nativeIntegration(f.integration, ['--install-transaction'])
  const canonical = { ...f.integration }
  await result
  assert.equal((await readNativeInstallTransaction({ integration: canonical }))!.binding.root, originalRoot)
})
test('root symlink is canonicalized throughout producer records and sources', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, 'darwin'), alias = join(f.directory, 'alias')
  await symlink(f.integration.root, alias)
  await nativeIntegration({ ...f.integration, root: alias }, ['--install-transaction'])
  const transaction = (await readNativeInstallTransaction({ integration: f.integration }))!
  assert.equal(transaction.binding.root, f.integration.root)
  await assert.rejects(readNativeInstallTransaction({ integration: { ...f.integration, root: alias } }), /Unsafe native install transaction/)
  await assert.rejects(uninstallCompletedNativeInstallTransaction({ integration: { ...f.integration, root: alias }, transactionId: transaction.transactionId }))
  assert.equal((await inspectNativeInstallTransaction({ integration: f.integration })).declaration, 'matching')
})
for (const platform of ['darwin', 'win32'] as const) for (const phase of ['prepared', 'artifact', 'receipt', 'completion']) test(`${platform}: actual producer SIGKILL after ${phase}, fresh inspection retains evidence`, { timeout: 240_000 }, async t => {
  const f = await fixture(t, platform)
  const script = fileURLToPath(new URL('./fixtures/native-install-transaction-producer-crash.ts', import.meta.url))
  const child = spawn(process.execPath, ['--experimental-transform-types', script, 'produce', f.directory, platform, phase], { stdio: ['ignore', 'pipe', 'pipe'] })
  f.trackChild(child)
  await new Promise<void>((resolve, reject) => {
    let stdout = '', stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`child exited ${code}: ${stderr}`)))
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('READY\n')) resolve() })
  })
  const exited = new Promise<void>((resolve, reject) => child.once('exit', (_code, signal) => { try { assert.equal(signal, 'SIGKILL'); resolve() } catch (error) { reject(error) } }))
  child.kill('SIGKILL')
  await exited
  const before = await readFile(join(f.control, 'prepared-transaction.json'))
  const result = await promisify(execFile)(process.execPath, ['--experimental-transform-types', script, 'inspect', f.directory, platform, phase], { timeout: 180_000 })
  const report = JSON.parse(result.stdout)
  assert.equal(report.declaration === 'matching', phase === 'completion')
  assert.equal(existsSync(f.layout.artifactPaths[0]!), phase !== 'prepared')
  assert.equal(existsSync(f.layout.receiptPath), ['receipt', 'completion'].includes(phase))
  assert.deepEqual(await readFile(join(f.control, 'prepared-transaction.json')), before)
  await assert.rejects(nativeIntegration(f.integration, ['--install-transaction']))
})
test('native Windows actual COM producer emits inspectable completed generation', { skip: process.platform !== 'win32', timeout: 600_000 }, async t => {
  const f = await fixture(t, 'win32')
  delete f.integration.runPowerShell
  const previousPath = process.env.PATH
  process.env.PATH = ''
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath })
  await nativeIntegration(f.integration, ['--install-transaction'])
  assert.equal((await inspectNativeInstallTransaction({ integration: f.integration })).declaration, 'matching')
})
test('oversized actual Windows COM payload refuses before preparation', async t => {
  const f = await fixture(t, 'win32')
  f.integration.runPowerShell = (_script, env) => writeFileSync(env.JARVIS_LINK_PATH!, Buffer.alloc(1024 * 1024 + 1))
  await assert.rejects(nativeIntegration(f.integration, ['--install-transaction']))
  assert.equal(existsSync(join(f.control, 'prepared-transaction.json')), false)
  assert.equal(existsSync(f.layout.artifactPaths[0]!), false)
})
