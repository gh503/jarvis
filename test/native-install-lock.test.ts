import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { describeNativeIntegration, nativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { assertNativeInstallLockHeld, runWithNativeInstallLockHeld, withNativeInstallLock, type NativeInstallLock } from '../scripts/native-install-lock.ts'
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

async function privateCheckerScripts() {
  const source = await readFile(new URL('../scripts/native-install-lock.ts', import.meta.url), 'utf8')
  const direct = source.match(/const windowsCheck = String\.raw`([\s\S]*?)`/)![1]!
  // Freeze the provider implementation as the native parity oracle. Only reader
  // plumbing differs; the exact production owner/rule policy runs in both.
  const legacy = direct.replace('$user =', 'Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop\n$user =')
    .replace(/  \$attributes = \[IO.File\]::GetAttributes\(\$cursor\)[\s\S]*?  \$parent =/, `  $item = Get-Item -LiteralPath $cursor -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 1 }
  if ($cursor -ne $p -and !$item.PSIsContainer) { exit 1 }
  $parent =`)
    .replace(/# Windows PowerShell uses[^\n]*\n\$acl = if[\s\S]*?\n\}(?=\n\$owner)/, '$acl = Get-Acl -LiteralPath $p')
  return { source, direct, legacy }
}

test('Windows lock checker retains strict policy and bounded invocation with direct readers', async () => {
  const { source, direct, legacy } = await privateCheckerScripts()
  assert.match(direct, /\[IO.File\]::GetAttributes\(\$cursor\)/)
  assert.match(direct, /\$cursor -ne \$p -and !\(\$attributes -band \[IO.FileAttributes\]::Directory\)/)
  assert.match(direct, /\[IO.Directory\]::GetAccessControl\(\$p\)/)
  assert.match(direct, /\[IO.File\]::GetAccessControl\(\$p\)/)
  assert.doesNotMatch(direct, /Get-Item|Get-Acl|Import-Module|FileSystemRights\]::Read/)
  assert.match(direct, /FileSystemRights\]::FullControl/)
  assert.match(direct, /GetAccessRules\(\$true, \$true,/)
  assert.match(direct, /PropagationFlags\]::InheritOnly/)
  assert.match(direct, /\$owner -ne \$user -and !\(\$owner -eq 'S-1-5-32-544' -and \$elevated\)/)
  assert.match(direct, /@\(\$user, 'S-1-5-18', 'S-1-5-32-544'\) -or \$rule.AccessControlType -ne 'Allow'/)
  assert.match(legacy, /Get-Item -LiteralPath \$cursor -Force/)
  assert.match(legacy, /Get-Acl -LiteralPath \$p/)
  assert.doesNotMatch(legacy, /GetAttributes|GetAccessControl|leafAttributes/)
  assert.match(source, /join\(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'\)/)
  assert.match(source, /'-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'/)
  assert.match(source, /env: \{ \.\.\.process.env, JARVIS_INSTALL_CHECK_TARGET: path \}, windowsHide: true, timeout: 10_000, maxBuffer: 64 \* 1024, stdio: \['ignore', 'pipe', 'pipe'\]/)
})

test('native Windows lock provider and direct readers have ACL and refusal parity', { skip: process.platform !== 'win32', timeout: 120_000 }, async t => {
  const { root } = await fixture(t)
  const { direct, legacy } = await privateCheckerScripts()
  const run = (script: string, path: string, expected: number) => {
    const result = spawnSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { env: { ...process.env, JARVIS_INSTALL_CHECK_TARGET: path }, windowsHide: true, timeout: 10_000, encoding: 'utf8' })
    assert.equal(result.error, undefined, 'timeout or launch failure is not ACL refusal')
    assert.equal(result.signal, null)
    assert.equal(result.status, expected, result.stderr)
  }
  const compare = (path: string, expected: number) => {
    const snapshot = () => windowsAclScript(path, String.raw`
$p = $env:TEST_CONTROL
$acl = Get-Acl -LiteralPath $p
$direct = if ([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::Directory) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }
$sections = [Security.AccessControl.AccessControlSections]'Owner, Group, Access'
$sddl = $acl.GetSecurityDescriptorSddlForm($sections)
if ($sddl -cne $direct.GetSecurityDescriptorSddlForm($sections)) { throw 'ACL reader parity mismatch' }
[Console]::Write($sddl)
`)
    const before = snapshot()
    run(legacy, path, expected)
    run(direct, path, expected)
    assert.equal(snapshot(), before, 'checks must not repair ACLs')
  }
  const set = (path: string, action: string) => windowsAclScript(path, String.raw`
$p = $env:TEST_CONTROL
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $p
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$action = '${action}'
$rights = if ($action -eq 'readonly' -or $action -eq 'inheritonly') { 'ReadAndExecute' } else { 'FullControl' }
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user, $rights, 'Allow'))
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'ReadAndExecute', 'Allow')) }
if ($action -eq 'shared') { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow')) }
if ($action -eq 'deny') { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user, 'WriteData', 'Deny')) }
if ($action -eq 'inheritonly' -or $action -eq 'inheritable') {
  $propagation = if ($action -eq 'inheritonly') { 'InheritOnly' } else { 'None' }
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'ContainerInherit, ObjectInherit', $propagation, 'Allow'))
}
Set-Acl -LiteralPath $p -AclObject $acl
`)
  for (const directory of [false, true]) {
    const path = join(root, directory ? 'acl-dir' : 'acl-file')
    if (directory) await mkdir(path)
    else await writeFile(path, 'sentinel')
    try {
      for (const action of ['private', 'shared', 'deny', 'readonly', ...(directory ? ['inheritonly', 'inheritable'] : [])]) {
        set(path, action)
        compare(path, action === 'private' || action === 'inheritable' ? 0 : 1)
        t.diagnostic(`ACL parity: ${directory ? 'directory' : 'file'} ${action}`)
      }
      if (directory) {
        const child = join(path, 'inherited-file')
        await writeFile(child, 'inherited')
        compare(child, 0)
        const junction = join(root, 'junction')
        await symlink(path, junction, 'junction')
        for (const target of [junction, join(junction, 'inherited-file')]) {
          run(legacy, target, 1)
          run(direct, target, 1)
        }
      }
    } finally { set(path, 'private') }
  }
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

test('capabilities reject fabrication, copies, wrong boundaries and expired scopes', async t => {
  const { controlDirectory } = await fixture(t)
  for (const forged of [{}, null, undefined, 'lock', 1]) assert.throws(() => assertNativeInstallLockHeld(forged, controlDirectory), /capability/)
  await assert.rejects(lstat(controlDirectory), { code: 'ENOENT' })
  let saved: NativeInstallLock | undefined
  await withNativeInstallLock({ controlDirectory }, async lock => {
    saved = lock
    assertNativeInstallLockHeld(lock, controlDirectory)
    assert.throws(() => assertNativeInstallLockHeld({ ...lock }, controlDirectory), /capability/)
    assert.throws(() => assertNativeInstallLockHeld(lock, join(controlDirectory, 'other')), /capability/)
    assert.throws(() => assertNativeInstallLockHeld(lock, controlDirectory + '/.'), /capability/)
  })
  assert.throws(() => assertNativeInstallLockHeld(saved, controlDirectory), /capability/)
  await withNativeInstallLock({ controlDirectory }, async lock => {
    assert.notEqual(lock, saved)
    assert.throws(() => assertNativeInstallLockHeld(saved, controlDirectory), /capability/)
  })
})

test('unawaited registered failure is observed, propagated and releases the lock', async t => {
  const { controlDirectory } = await fixture(t)
  const failure = new Error('registered failure')
  let saved: NativeInstallLock | undefined
  await assert.rejects(withNativeInstallLock({ controlDirectory }, async lock => {
    saved = lock
    void runWithNativeInstallLockHeld(lock, controlDirectory, () => { throw failure })
  }), error => error === failure)
  assert.throws(() => assertNativeInstallLockHeld(saved, controlDirectory), /capability/)
  await withNativeInstallLock({ controlDirectory }, async () => {})
})

test('callback failure drains registered work and preserves distinct failures before release', { timeout: 60_000 }, async t => {
  const { controlDirectory } = await fixture(t)
  const callbackFailure = new Error('callback failed'), writeFailure = new Error('registered write failed')
  let unblock!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let completed = false, saved: NativeInstallLock | undefined
  const pending = withNativeInstallLock({ controlDirectory }, async lock => {
    saved = lock
    void runWithNativeInstallLockHeld(lock, controlDirectory, async () => { entered(); await gate; throw writeFailure })
    void runWithNativeInstallLockHeld(lock, controlDirectory, async () => { throw callbackFailure })
    throw callbackFailure
  })
  const checked = assert.rejects(pending, error => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [callbackFailure, writeFailure])
    assert.equal(error.cause, callbackFailure)
    return true
  }).finally(() => { completed = true })
  try {
    await started
    // Let the callback rejection close registration while the write is suspended.
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(completed, false)
    assert.throws(() => runWithNativeInstallLockHeld(saved!, controlDirectory, async () => {}), /scope is closing/)
    await assert.rejects(withNativeInstallLock({ controlDirectory }, async () => assert.fail('released before drain')), /Another launcher is still working/)
  } finally {
    unblock()
    await checked
  }
  assert.throws(() => assertNativeInstallLockHeld(saved, controlDirectory), /capability/)
  await withNativeInstallLock({ controlDirectory }, async () => {})
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
  let saved: NativeInstallLock | undefined
  DatabaseSync.prototype.close = function () {
    if (saved) assert.throws(() => assertNativeInstallLockHeld(saved, controlDirectory), /capability/)
    originalClose.call(this); throw releaseError
  }
  try {
    await assert.rejects(withNativeInstallLock({ controlDirectory }, async lock => { saved = lock; throw operationError }), error => {
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
