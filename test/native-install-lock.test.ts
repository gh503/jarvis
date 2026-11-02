import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { describeNativeIntegration, nativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { withNativeInstallLock } from '../scripts/native-install-lock.ts'
import { acquireVerifiedLifecycleLock } from '../src/runtime-lifecycle.ts'

function windowsAclScript(controlDirectory: string, script: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, TEST_CONTROL: controlDirectory }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key]
  script = String.raw`$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME\Modules"
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
` + script
  return execFileSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { env, encoding: 'utf8', timeout: 10_000, windowsHide: true })
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'native-lock-'))
  t.after(async () => { assert.ok(root.startsWith(join(await realpath(tmpdir()), 'native-lock-'))); await rm(root, { recursive: true, force: true }) })
  const options: InstallOptions = { platform: 'darwin', root: join(root, 'package'), home: join(root, 'home'), arch: process.arch }
  const description = describeNativeIntegration(options)
  const controlDirectory = join(dirname(description.receiptPath), 'native-install-control')
  return { root, options, controlDirectory, ...description }
}

test('absent uninstall creates private operational lock only and preserves legacy parent mode', async t => {
  const { options, controlDirectory, receiptPath, artifactPaths } = await fixture(t)
  await mkdir(dirname(receiptPath), { recursive: true, mode: 0o755 })
  const before = (await lstat(dirname(receiptPath))).mode
  assert.deepEqual(await nativeIntegration(options, ['--uninstall']), [])
  assert.equal((await lstat(dirname(receiptPath))).mode, before)
  const lock = await lstat(join(controlDirectory, 'launcher.lock.sqlite'))
  if (process.platform !== 'win32') {
    assert.equal((await lstat(controlDirectory)).mode & 0o777, 0o700)
    assert.equal(lock.mode & 0o777, 0o600)
    assert.equal(lock.uid, process.getuid!())
  }
  for (const path of [receiptPath, ...artifactPaths]) await assert.rejects(lstat(path), { code: 'ENOENT' })
})

test('verified lifecycle rejects before creating SQLite or a missing directory', async t => {
  const { controlDirectory } = await fixture(t)
  const failure = new Error('privacy rejected')
  let calls = 0
  const verify = async () => { calls++; throw failure }
  await assert.rejects(acquireVerifiedLifecycleLock(controlDirectory, 'launcher', verify), error => error === failure)
  await assert.rejects(lstat(controlDirectory), { code: 'ENOENT' })
  await mkdir(controlDirectory, { recursive: true, mode: 0o700 })
  await assert.rejects(acquireVerifiedLifecycleLock(controlDirectory, 'launcher', verify), error => error === failure)
  await assert.rejects(lstat(join(controlDirectory, 'launcher.lock.sqlite')), { code: 'ENOENT' })
  assert.equal(calls, 2)
})

test('verified lifecycle preflights hardlinks before calling directory verifier', async t => {
  const { root, controlDirectory } = await fixture(t)
  await mkdir(controlDirectory, { recursive: true, mode: 0o700 })
  const target = join(root, 'external')
  await writeFile(target, 'untouched', { mode: 0o600 })
  await link(target, join(controlDirectory, 'launcher.lock.sqlite-wal'))
  const before = await lstat(target, { bigint: true })
  await assert.rejects(acquireVerifiedLifecycleLock(controlDirectory, 'launcher', async () => assert.fail('verifier called')), /Unsafe lifecycle lock file/)
  assert.deepEqual(await lstat(target, { bigint: true }), before)
  await assert.rejects(lstat(join(controlDirectory, 'launcher.lock.sqlite')), { code: 'ENOENT' })
})

test('existing private control directory is not chmod repaired during acquisition', { skip: process.platform === 'win32' }, async t => {
  const { controlDirectory } = await fixture(t)
  await withNativeInstallLock({ controlDirectory }, async () => {})
  const before = await lstat(controlDirectory, { bigint: true })
  const originalChmod = fsPromises.chmod
  fsPromises.chmod = async (path, mode) => {
    assert.notEqual(path, controlDirectory, 'existing control directory must not be chmod repaired')
    return originalChmod(path, mode)
  }
  syncBuiltinESMExports()
  try { await withNativeInstallLock({ controlDirectory }, async () => {}) }
  finally { fsPromises.chmod = originalChmod; syncBuiltinESMExports() }
  const after = await lstat(controlDirectory, { bigint: true })
  // SQLite journal creation/removal can legitimately change directory ctime.
  assert.equal(after.mode, before.mode)
  assert.equal(after.ino, before.ino)
})

test('native Windows preserves trusted inheritable control and child intent ACLs', { skip: process.platform !== 'win32', timeout: 60_000 }, async t => {
  const { controlDirectory } = await fixture(t)
  await withNativeInstallLock({ controlDirectory }, async () => {})
  windowsAclScript(controlDirectory, String.raw`
$p = $env:TEST_CONTROL
$acl = Get-Acl -LiteralPath $p
$sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $acl
[IO.Directory]::CreateDirectory((Join-Path $p 'intent-store')) | Out-Null
[IO.File]::WriteAllText((Join-Path $p 'intent-store\intent.json'), 'sentinel')
`)
  const snapshot = () => windowsAclScript(controlDirectory, String.raw`
@($env:TEST_CONTROL, (Join-Path $env:TEST_CONTROL 'intent-store'), (Join-Path $env:TEST_CONTROL 'intent-store\intent.json')) | ForEach-Object { (Get-Acl -LiteralPath $_).Sddl }
`).trim()
  const before = snapshot()
  await withNativeInstallLock({ controlDirectory }, async () => {})
  assert.equal(snapshot(), before)
  assert.equal(await readFile(join(controlDirectory, 'intent-store', 'intent.json'), 'utf8'), 'sentinel')
})

test('invalid options fail before any control directory creation', async t => {
  const { options, controlDirectory } = await fixture(t)
  await assert.rejects(nativeIntegration({ ...options, root: 'relative' }, ['--uninstall']), /Unsafe integration option/)
  await assert.rejects(lstat(controlDirectory), { code: 'ENOENT' })
})

test('shared existing control and lock modes are rejected without repair', { skip: process.platform === 'win32' }, async t => {
  const { controlDirectory } = await fixture(t)
  await mkdir(controlDirectory, { recursive: true, mode: 0o755 })
  await chmod(controlDirectory, 0o755)
  await assert.rejects(withNativeInstallLock({ controlDirectory }, async () => assert.fail()), /Unsafe native/)
  assert.equal((await lstat(controlDirectory)).mode & 0o777, 0o755)
  await chmod(controlDirectory, 0o500)
  await assert.rejects(withNativeInstallLock({ controlDirectory }, async () => assert.fail()), /Unsafe native/)
  assert.equal((await lstat(controlDirectory)).mode & 0o777, 0o500)
  await chmod(controlDirectory, 0o700)
  const lock = join(controlDirectory, 'launcher.lock.sqlite')
  await writeFile(lock, '', { mode: 0o644 })
  await chmod(lock, 0o644)
  await assert.rejects(withNativeInstallLock({ controlDirectory }, async () => assert.fail()), /Unsafe native/)
  assert.equal((await lstat(lock)).mode & 0o777, 0o644)
  await chmod(lock, 0o400)
  await assert.rejects(withNativeInstallLock({ controlDirectory }, async () => assert.fail()), /Unsafe native/)
  assert.equal((await lstat(lock)).mode & 0o777, 0o400)
})

test('unsafe ancestor fails before creating control or repairing parent', { skip: process.platform === 'win32' }, async t => {
  const { options, controlDirectory } = await fixture(t)
  await mkdir(options.home, { mode: 0o777 })
  await chmod(options.home, 0o777)
  await assert.rejects(nativeIntegration(options, ['--uninstall']), /Unsafe native/)
  assert.equal((await lstat(options.home)).mode & 0o777, 0o777)
  await assert.rejects(lstat(controlDirectory), { code: 'ENOENT' })
})

test('symlink control is rejected without modifying target', { skip: process.platform === 'win32' }, async t => {
  const { root, controlDirectory } = await fixture(t)
  const target = join(root, 'target')
  await mkdir(target, { mode: 0o755 })
  await mkdir(dirname(controlDirectory), { recursive: true })
  await symlink(target, controlDirectory)
  await assert.rejects(withNativeInstallLock({ controlDirectory }, async () => assert.fail()), /symlink/)
  assert.equal((await lstat(target)).mode & 0o777, 0o755)
})

test('hardlinked SQLite sidecar is rejected without touching its external target', async t => {
  const { root, controlDirectory } = await fixture(t)
  await withNativeInstallLock({ controlDirectory }, async () => {})
  const target = join(root, 'external')
  await writeFile(target, 'preserved', { mode: 0o600 })
  const before = await lstat(target, { bigint: true })
  await link(target, join(controlDirectory, 'launcher.lock.sqlite-journal'))
  await assert.rejects(withNativeInstallLock({ controlDirectory }, async () => assert.fail()), /Unsafe native/)
  assert.equal(await readFile(target, 'utf8'), 'preserved')
  const after = await lstat(target, { bigint: true })
  assert.equal(after.mode, before.mode)
  assert.equal(after.mtimeNs, before.mtimeNs)
})

test('native Windows rejects shared ACL without repairing it', { skip: process.platform !== 'win32', timeout: 60_000 }, async t => {
  const { controlDirectory } = await fixture(t)
  await withNativeInstallLock({ controlDirectory }, async () => {})
  await withNativeInstallLock({ controlDirectory }, async () => {})
  const powershell = (script: string) => windowsAclScript(controlDirectory, script)
  powershell(String.raw`
$ErrorActionPreference = 'Stop'
$p = $env:TEST_CONTROL
$acl = Get-Acl -LiteralPath $p
$sid = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $acl
`)
  const before = powershell('(Get-Acl -LiteralPath $env:TEST_CONTROL).Sddl').trim()
  await assert.rejects(withNativeInstallLock({ controlDirectory }, async () => assert.fail()), /Unsafe native/)
  assert.equal(powershell('(Get-Acl -LiteralPath $env:TEST_CONTROL).Sddl').trim(), before)
})

test('operation failure releases the existing lock inode', async t => {
  const { controlDirectory } = await fixture(t)
  const failure = new Error('operation failed')
  await assert.rejects(withNativeInstallLock({ controlDirectory }, async () => { throw failure }), error => error === failure)
  const before = await lstat(join(controlDirectory, 'launcher.lock.sqlite'))
  assert.equal(await withNativeInstallLock({ controlDirectory }, async () => 42), 42)
  assert.equal((await lstat(join(controlDirectory, 'launcher.lock.sqlite'))).ino, before.ino)
})

test('operation and release failures retain both errors with original cause', async t => {
  const { controlDirectory } = await fixture(t)
  const operationError = new Error('operation sentinel'), releaseError = new Error('release sentinel')
  const originalClose = DatabaseSync.prototype.close
  DatabaseSync.prototype.close = function () { originalClose.call(this); throw releaseError }
  try {
    await assert.rejects(withNativeInstallLock({ controlDirectory }, async () => { throw operationError }), error => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [operationError, releaseError])
      assert.equal(error.cause, operationError)
      return true
    })
  } finally { DatabaseSync.prototype.close = originalClose }
  await withNativeInstallLock({ controlDirectory }, async () => {})
})

for (const platform of ['darwin', 'win32'] as const) test(`${platform}: process contention spans package roots/config and crash releases same inode`, { timeout: process.platform === 'win32' ? 120_000 : 30_000 }, async t => {
  const f = await fixture(t)
  const options = { ...f.options, platform, appData: join(f.root, 'roaming'), localAppData: join(f.root, 'local') }
  const { receiptPath, artifactPaths } = describeNativeIntegration(options)
  const controlDirectory = join(dirname(receiptPath), 'native-install-control')
  // Preserve an unowned integration artifact byte-for-byte under contention.
  await mkdir(dirname(artifactPaths[0]!), { recursive: true, mode: 0o755 })
  await writeFile(artifactPaths[0]!, 'sentinel', { mode: 0o600 })
  const original = await lstat(artifactPaths[0]!, { bigint: true })
  const moduleUrl = new URL('../scripts/native-install-lock.ts', import.meta.url).href
  const child = spawn(process.execPath, ['--expose-gc', '--experimental-transform-types', '--input-type=module', '-e', `
    import { withNativeInstallLock } from ${JSON.stringify(moduleUrl)};
    await withNativeInstallLock({controlDirectory: process.env.TEST_CONTROL}, async () => {
      // A timer alone keeps the process alive but not an unreachable pending
      // promise: GC can collect its suspended lock scope and SQLite connection.
      await new Promise((resolve, reject) => {
        process.stdin.once('end', resolve);
        process.stdin.once('error', reject);
        process.stdin.on('data', () => {
          global.gc();
          process.stdout.write('ALIVE\\n');
        });
        process.stdout.write('READY\\n');
      });
    });
  `], { env: { ...process.env, TEST_CONTROL: controlDirectory }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', () => reject(new Error(stderr)))
    child.stdout.on('data', data => { if (String(data).includes('READY')) resolve() })
  })
  const assertHolderAlive = async () => {
    assert.equal(child.exitCode, null, stderr)
    assert.equal(child.signalCode, null, stderr)
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { child.stdout.off('data', onData); child.off('exit', onExit); child.off('error', onError) }
      const onData = (data: Buffer) => { if (String(data).includes('ALIVE')) { cleanup(); resolve() } }
      const onExit = () => { cleanup(); reject(new Error(`Lock holder exited: ${stderr}`)) }
      const onError = (error: Error) => { cleanup(); reject(error) }
      child.stdout.on('data', onData)
      child.once('exit', onExit)
      child.once('error', onError)
      child.stdin.write('GC and acknowledge\n')
    })
  }
  const lock = join(controlDirectory, 'launcher.lock.sqlite')
  const identity = await lstat(lock)
  for (const args of [['--install'], ['--uninstall'], ['--install', '--config', join(f.root, 'nonexistent-config')]]) {
    await assertHolderAlive()
    await assert.rejects(nativeIntegration({ ...options, root: join(f.root, 'different-package') }, args), /Another launcher is still working/)
    await assertHolderAlive()
    assert.equal(await readFile(artifactPaths[0]!, 'utf8'), 'sentinel')
    const current = await lstat(artifactPaths[0]!, { bigint: true })
    assert.equal(current.ino, original.ino)
    assert.equal(current.mtimeNs, original.mtimeNs)
    await assert.rejects(lstat(receiptPath), { code: 'ENOENT' })
  }
  child.kill('SIGKILL')
  await exited
  assert.deepEqual(await nativeIntegration(options, ['--uninstall']), [])
  assert.equal((await lstat(lock)).ino, identity.ino)
  assert.equal(await readFile(artifactPaths[0]!, 'utf8'), 'sentinel')
})
