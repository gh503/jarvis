import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { describeNativeIntegration, nativeIntegration, renderNativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { createNativeInstallTransaction } from '../scripts/native-install-transaction.ts'
import { readNativeInstallTransactionSnapshot, writeNativeInstallTransaction } from '../scripts/native-install-transaction-store.ts'
import { retireNativeInstallPreparation } from '../scripts/native-install-preparation-retire.ts'
import { isPublicFile } from '../scripts/packaging.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'

async function fixture(t: TestContext, platform: 'darwin' | 'win32') {
  const temporary = await fs.realpath(tmpdir())
  const root = await fs.mkdtemp(join(temporary, 'preparation-retire-'))
  t.after(async () => { assert.equal(dirname(root), temporary); assert.ok(root.startsWith(join(temporary, 'preparation-retire-'))); await fs.rm(root, { recursive: true, force: true }) })
  const integration: InstallOptions = { platform, root: join(root, 'missing-package'), home: join(root, 'home'), appData: join(root, 'roaming'), localAppData: join(root, 'local'), arch: process.arch }
  const layout = describeNativeIntegration(integration)
  const directory = join(dirname(layout.receiptPath), 'native-install-control')
  const plan = renderNativeIntegration(integration, false)
  const artifacts = plan.platform === 'darwin' ? plan.artifacts : plan.shortcuts.map(item => ({ path: item.path, bytes: Buffer.from([0, 255, 1]), mode: 0o600 }))
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, platform, root: integration.root, autostart: false, ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: artifacts.map(item => ({ path: item.path, sha256: createHash('sha256').update(item.bytes).digest('hex') })) }, null, 2) + '\n')
  const transactionId = randomUUID()
  const transaction = createNativeInstallTransaction({ integration, artifacts, receipt, transactionId })
  await writeNativeInstallTransaction({ integration, transaction })
  const source = join(directory, 'prepared-transaction.json')
  return { integration, transactionId, directory, source, bytes: await fs.readFile(source), barrier: join(directory, `prepared-retiring-${transactionId}`), ...layout }
}
async function snapshot(path: string): Promise<unknown> {
  const stat = await fs.lstat(path, { bigint: true })
  if (stat.isDirectory()) return Promise.all((await fs.readdir(path)).sort().filter(name => !name.startsWith('launcher.lock.sqlite')).map(async name => [name, await snapshot(join(path, name))]))
  return { bytes: stat.isFile() ? await fs.readFile(path) : undefined, ino: stat.ino, mode: stat.mode, mtime: stat.mtimeNs, ctime: stat.ctimeNs }
}
for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: retire exact prepared-only bytes, preserve lock inode and unblock installer`, async t => {
    const f = await fixture(t, platform)
    const before = await fs.lstat(f.source, { bigint: true })
    const lock = join(f.directory, 'launcher.lock.sqlite')
    const lockBefore = await fs.lstat(lock, { bigint: true })
    await assert.rejects(nativeIntegration(f.integration, ['--install']), /transaction residue/)
    const result = await retireNativeInstallPreparation(f)
    assert.equal(result.transactionId, f.transactionId)
    assert.equal(dirname(dirname(result.archiveDirectory)), f.directory)
    assert.equal(result.archiveDirectory.split(/[\\/]/).at(-1), 'generation')
    const archived = join(result.archiveDirectory, 'prepared-transaction.json')
    assert.deepEqual(await fs.readFile(archived), f.bytes)
    assert.equal((await fs.lstat(archived, { bigint: true })).ino, before.ino)
    assert.equal((await fs.lstat(lock, { bigint: true })).ino, lockBefore.ino)
    assert.deepEqual((await fs.readdir(result.archiveDirectory)).sort(), ['manifest.json', 'prepared-transaction.json'])
    const manifest = JSON.parse(await fs.readFile(join(result.archiveDirectory, 'manifest.json'), 'utf8'))
    assert.equal(manifest.transactionId, f.transactionId)
    assert.equal(manifest.sha256, createHash('sha256').update(f.bytes).digest('hex'))
    assert.equal(manifest.identity.ino, before.ino.toString())
    assert.equal(manifest.archiveBasename, dirname(result.archiveDirectory).split(/[\\/]/).at(-1))
    await assert.rejects(fs.lstat(f.source), { code: 'ENOENT' })
    assert.equal((await fs.readdir(f.directory)).some(name => name.toLowerCase().startsWith('prepared-')), false)
    const archiveBefore = await snapshot(result.archiveDirectory)
    await assert.rejects(nativeIntegration(f.integration, ['--install']), error => { assert.doesNotMatch(String(error), /transaction residue|intent requires review/); return true })
    assert.deepEqual(await snapshot(result.archiveDirectory), archiveBefore)
  })
  for (const scenario of ['artifact', 'startup', 'receipt', 'ack', 'completion', 'intent', 'unknown', 'case', 'barrier', 'wrong-id'] as const) test(`${platform}: refuses ${scenario} untouched`, async t => {
    const f = await fixture(t, platform)
    const path = scenario === 'artifact' ? f.artifactPaths[0]! : scenario === 'startup' ? f.artifactPaths.at(-1)! : scenario === 'receipt' ? f.receiptPath : join(f.directory, ({ ack: 'prepared-artifact-0.json', completion: 'prepared-completion.json', intent: 'install-intent.json', unknown: 'prepared-unknown', case: 'PREPARED-TRANSACTION.JSON', barrier: `prepared-retiring-${f.transactionId}`, 'wrong-id': 'unused' } as Record<string, string>)[scenario]!)
    if (scenario !== 'wrong-id') {
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
      if (scenario === 'case') await fs.rename(f.source, path)
      else if (scenario === 'barrier') await fs.mkdir(path, { mode: 0o700 })
      else await fs.writeFile(path, 'evidence', { mode: 0o600 })
    }
    const before = await snapshot(f.directory)
    await assert.rejects(retireNativeInstallPreparation({ ...f, transactionId: scenario === 'wrong-id' ? randomUUID() : f.transactionId }))
    assert.deepEqual(await snapshot(f.directory), before)
    assert.deepEqual(await fs.readFile(scenario === 'case' ? path : f.source), f.bytes)
  })
}

for (const fault of ['before-move', 'after-move', 'moved-bytes', 'moved-identity', 'target-tamper', 'after-commit'] as const) test(`fault ${fault} retains evidence and conservative gate`, async t => {
  const f = await fixture(t, 'darwin')
  const original = fs.rename
  t.after(() => { fs.rename = original; syncBuiltinESMExports() })
  fs.rename = async (source, destination) => {
    if (source === f.source) {
      assert.deepEqual(await fs.readFile(join(f.barrier, 'manifest.json')).then(bytes => JSON.parse(bytes.toString()).transactionId), f.transactionId)
      if (fault === 'before-move') throw new Error('injected before move')
      await original(source, destination)
      if (fault === 'after-move') throw new Error('injected after move')
      if (fault === 'moved-bytes') await fs.writeFile(destination, Buffer.alloc(f.bytes.length, 65))
      if (fault === 'moved-identity') {
        const retained = join(f.barrier, 'retained-original')
        assert.equal(dirname(retained), f.barrier)
        await original(destination, retained)
        await fs.writeFile(destination, f.bytes, { mode: 0o600 })
      }
      if (fault === 'target-tamper') {
        const archive = (await fs.readdir(f.directory)).find(name => name.startsWith('retired-'))!
        await fs.mkdir(join(f.directory, archive, 'generation'), { mode: 0o700 })
      }
    } else {
      await original(source, destination)
      if (fault === 'after-commit') throw new Error('injected lost response')
    }
  }
  syncBuiltinESMExports()
  await assert.rejects(retireNativeInstallPreparation(f))
  fs.rename = original; syncBuiltinESMExports()
  if (fault === 'after-commit') {
    await assert.rejects(fs.lstat(f.barrier), { code: 'ENOENT' })
    const archive = (await fs.readdir(f.directory)).find(name => name.startsWith('retired-'))!
    assert.deepEqual(await fs.readFile(join(f.directory, archive, 'generation', 'prepared-transaction.json')), f.bytes)
  } else {
    assert.ok((await fs.lstat(f.barrier)).isDirectory())
    await assert.rejects(nativeIntegration(f.integration, ['--install']), /transaction residue/)
    if (fault === 'before-move') assert.deepEqual(await fs.readFile(f.source), f.bytes)
    else await assert.rejects(fs.lstat(f.source), { code: 'ENOENT' })
  }
})
test('source modification after barrier creation refuses before moving', async t => {
  const f = await fixture(t, 'darwin')
  const mkdtemp = fs.mkdtemp
  t.after(() => { fs.mkdtemp = mkdtemp; syncBuiltinESMExports() })
  fs.mkdtemp = (async (...args: Parameters<typeof fs.mkdtemp>) => {
    const result = await mkdtemp(...args)
    await fs.writeFile(f.source, Buffer.alloc(f.bytes.length, 65))
    return result
  }) as typeof fs.mkdtemp
  syncBuiltinESMExports()
  await assert.rejects(retireNativeInstallPreparation(f))
  fs.mkdtemp = mkdtemp; syncBuiltinESMExports()
  assert.deepEqual(await fs.readFile(f.source), Buffer.alloc(f.bytes.length, 65))
  await assert.rejects(fs.lstat(join(f.barrier, 'prepared-transaction.json')), { code: 'ENOENT' })
  await assert.rejects(nativeIntegration(f.integration, ['--install']), /transaction residue/)
})
for (const failure of ['writeFile', 'sync', 'close'] as const) test(`manifest ${failure} failure keeps source and barrier`, async t => {
  const f = await fixture(t, 'darwin')
  const open = fs.open
  t.after(() => { fs.open = open; syncBuiltinESMExports() })
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args)
    if (args[0] === join(f.barrier, 'manifest.json')) {
      const close = file.close.bind(file)
      if (failure === 'close') file.close = async () => { await close(); throw new Error('injected manifest close') }
      else file[failure] = async () => { throw new Error(`injected manifest ${failure}`) }
    }
    return file
  }
  syncBuiltinESMExports()
  await assert.rejects(retireNativeInstallPreparation(f), /injected manifest/)
  fs.open = open; syncBuiltinESMExports()
  assert.deepEqual(await fs.readFile(f.source), f.bytes)
  assert.ok((await fs.lstat(f.barrier)).isDirectory())
  await assert.rejects(nativeIntegration(f.integration, ['--install']), /transaction residue/)
})
for (const stage of ['before-source', 'after-source', 'after-commit']) test(`process interruption ${stage} preserves archive or gate`, { timeout: 300_000 }, async t => {
  const f = await fixture(t, 'darwin')
  const child = spawnSync(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', fileURLToPath(new URL('./fixtures/native-install-preparation-retire-crash.ts', import.meta.url)), stage, JSON.stringify({ integration: f.integration, transactionId: f.transactionId })], { encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL', maxBuffer: 4096, windowsHide: true })
  assert.equal(child.error, undefined)
  assert.equal(child.stdout, 'INTERRUPTING\n')
  assert.equal(child.stderr, '')
  if (process.platform === 'win32') assert.ok(child.signal === 'SIGKILL' || (child.status !== null && child.status !== 0), 'Expected Windows process termination')
  else assert.equal(child.signal, 'SIGKILL')
  if (stage === 'after-commit') {
    await assert.rejects(fs.lstat(f.barrier), { code: 'ENOENT' })
    const archive = (await fs.readdir(f.directory)).find(name => name.startsWith('retired-'))!
    assert.deepEqual(await fs.readFile(join(f.directory, archive, 'generation', 'prepared-transaction.json')), f.bytes)
    await assert.rejects(nativeIntegration(f.integration, ['--install']), error => { assert.doesNotMatch(String(error), /transaction residue/); return true })
  } else {
    assert.ok((await fs.lstat(f.barrier)).isDirectory())
    assert.deepEqual(await fs.readFile(stage === 'before-source' ? f.source : join(f.barrier, 'prepared-transaction.json')), f.bytes)
    await assert.rejects(nativeIntegration(f.integration, ['--install']), /transaction residue/)
  }
})
test('snapshot alternate directory is restricted to a fixed retirement child and identity', async t => {
  const f = await fixture(t, 'darwin')
  const stat = await fs.lstat(f.source, { bigint: true })
  for (const directory of [dirname(f.directory), join(f.directory, 'other'), join(f.directory, '../other'), join(f.directory, 'prepared-retiring-bad')]) await assert.rejects(readNativeInstallTransactionSnapshot(f.integration, stat, directory))
  await assert.rejects(readNativeInstallTransactionSnapshot(f.integration, undefined, f.barrier))
})
test('retirement API is packaged and importable', async () => {
  assert.equal(isPublicFile('scripts/native-install-preparation-retire.ts'), true)
  assert.equal(typeof (await import('../scripts/native-install-preparation-retire.ts')).retireNativeInstallPreparation, 'function')
})
