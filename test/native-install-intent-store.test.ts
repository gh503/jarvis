import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { describeNativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { createNativeInstallIntent, encodeNativeInstallIntent, NATIVE_INSTALL_INTENT_MAX_BYTES } from '../scripts/native-install-intent.ts'
import { readNativeInstallIntent, writeNativeInstallIntent, writeNativeInstallIntentUnderLock } from '../scripts/native-install-intent-store.ts'
import { withNativeInstallLock, type NativeInstallLock } from '../scripts/native-install-lock.ts'

async function fixture(t: test.TestContext, platform: 'darwin' | 'win32' = 'darwin') {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'intent-store-'))
  t.after(async () => { assert.ok(root.startsWith(join(await fs.realpath(tmpdir()), 'intent-store-'))); await fs.rm(root, { recursive: true, force: true }) })
  const integration: InstallOptions = { platform, root: join(root, 'new-package'), home: join(root, 'home'), appData: join(root, 'roaming'), localAppData: join(root, 'local'), arch: process.arch }
  const layout = describeNativeIntegration(integration)
  const directory = join(dirname(layout.receiptPath), 'native-install-control')
  const path = join(directory, 'install-intent.json')
  const binding = { root: join(root, 'old-package'), autostart: false, configFile: join(root, 'source.env'), dataDir: join(root, 'data') }
  const intent = createNativeInstallIntent({ integration, binding })
  return { root, integration, intent, directory, path, ...layout }
}
async function snapshot(path: string): Promise<unknown> {
  const stat = await fs.lstat(path, { bigint: true })
  const metadata = { ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid, nlink: stat.nlink, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs }
  return stat.isDirectory() ? { metadata, children: await Promise.all((await fs.readdir(path)).sort().map(async name => [name, await snapshot(join(path, name))])) } : { metadata, bytes: await fs.readFile(path) }
}
for (const platform of ['darwin', 'win32'] as const) test(`${platform}: exclusive store preserves moved binding; read is inert`, async t => {
  const f = await fixture(t, platform)
  await fs.writeFile(f.intent.binding.configFile!, 'UNRELATED_SECRET=never-store-this\n')
  const before = await snapshot(f.root)
  assert.equal(await readNativeInstallIntent(f), undefined)
  assert.deepEqual(await snapshot(f.root), before)
  assert.deepEqual(await writeNativeInstallIntent(f), f.intent)
  assert.deepEqual(await fs.readFile(f.path), encodeNativeInstallIntent(f.intent, f.integration))
  assert.ok(!(await fs.readFile(f.path, 'utf8')).includes('never-store-this'))
  const stored = await snapshot(f.root)
  assert.deepEqual(await readNativeInstallIntent({ integration: { ...f.integration, root: join(f.root, 'third-package') } }), f.intent)
  assert.deepEqual(await snapshot(f.root), stored)
  assert.equal((await readNativeInstallIntent(f))!.binding.root, f.intent.binding.root)
  for (const path of [f.receiptPath, ...f.artifactPaths]) await assert.rejects(fs.lstat(path), { code: 'ENOENT' })
  const original = await snapshot(f.root)
  await assert.rejects(writeNativeInstallIntent(f), { code: 'EEXIST' })
  assert.deepEqual(await snapshot(f.root), original)
})
test('under-lock writer refuses forged, wrong-boundary and expired capabilities without writes', async t => {
  const f = await fixture(t), other = await fixture(t)
  const before = await snapshot(f.root)
  assert.throws(() => writeNativeInstallIntentUnderLock({ ...f, lock: {} as NativeInstallLock }), /capability/)
  assert.deepEqual(await snapshot(f.root), before)
  let saved: NativeInstallLock | undefined
  await withNativeInstallLock({ controlDirectory: other.directory }, async lock => {
    saved = lock
    assert.throws(() => writeNativeInstallIntentUnderLock({ ...f, lock }), /capability/)
    assert.deepEqual(await snapshot(f.root), before)
  })
  const expiredBefore = await snapshot(other.root)
  assert.throws(() => writeNativeInstallIntentUnderLock({ ...other, lock: saved! }), /capability/)
  assert.deepEqual(await snapshot(other.root), expiredBefore)
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(other.path), { code: 'ENOENT' })
})

for (const platform of ['darwin', 'win32'] as const) test(`${platform}: writer composes without nested acquisition and preserves exclusive publication`, async t => {
  const f = await fixture(t, platform)
  await withNativeInstallLock({ controlDirectory: f.directory }, async lock => {
    assert.deepEqual(await writeNativeInstallIntentUnderLock({ ...f, lock }), f.intent)
    const before = await snapshot(f.root)
    await assert.rejects(writeNativeInstallIntentUnderLock({ ...f, lock }), { code: 'EEXIST' })
    assert.deepEqual(await snapshot(f.root), before)
  }).then(() => assert.fail('registered refusal must propagate'), error => assert.equal(error.code, 'EEXIST'))
  await withNativeInstallLock({ controlDirectory: f.directory }, async () => {})
  assert.deepEqual(await readNativeInstallIntent(f), f.intent)
  for (const path of [f.receiptPath, ...f.artifactPaths]) await assert.rejects(fs.lstat(path), { code: 'ENOENT' })
})

test('composed publication snapshots intent before yielding', async t => {
  const f = await fixture(t)
  f.intent = structuredClone(f.intent)
  const expected = structuredClone(f.intent)
  await withNativeInstallLock({ controlDirectory: f.directory }, async lock => {
    const pending = writeNativeInstallIntentUnderLock({ ...f, lock })
    Object.assign(f.intent.binding, { root: join(f.root, 'changed-after-call') })
    assert.deepEqual(await pending, expected)
  })
  assert.deepEqual(await readNativeInstallIntent(f), expected)
})

test('unawaited publication drains before release and refuses new work while closing', { timeout: 60_000 }, async t => {
  const f = await fixture(t), original = fs.open
  let unblock!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let saved: NativeInstallLock | undefined, completed = false
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === f.path && ((args[1] as number) & constants.O_CREAT) !== 0) { entered(); await gate }
    return original(...args)
  }) as typeof fs.open
  syncBuiltinESMExports()
  const pending = withNativeInstallLock({ controlDirectory: f.directory }, async lock => {
    saved = lock
    void writeNativeInstallIntentUnderLock({ ...f, lock })
  }).then(() => { completed = true })
  try {
    await started
    assert.equal(completed, false)
    assert.throws(() => writeNativeInstallIntentUnderLock({ ...f, lock: saved! }), /scope is closing/)
    await assert.rejects(withNativeInstallLock({ controlDirectory: f.directory }, async () => assert.fail('lock released early')), /Another launcher is still working/)
    await assert.rejects(fs.lstat(f.path), { code: 'ENOENT' })
  } finally {
    unblock()
    try { await pending } finally { fs.open = original; syncBuiltinESMExports() }
  }
  assert.equal(completed, true)
  assert.deepEqual(await readNativeInstallIntent(f), f.intent)
  await withNativeInstallLock({ controlDirectory: f.directory }, async () => {})
})

test('invalid plan and invalid layout cause no control preparation', async t => {
  const f = await fixture(t), before = await snapshot(f.root)
  await assert.rejects(writeNativeInstallIntent({ ...f, intent: { ...f.intent, scope: { ...f.intent.scope, execution: true } } as never }))
  await assert.rejects(readNativeInstallIntent({ integration: { ...f.integration, root: 'relative' } }))
  assert.deepEqual(await snapshot(f.root), before)
})
test('missing file under an existing control performs no SQLite writes', async t => {
  const f = await fixture(t)
  await withNativeInstallLock({ controlDirectory: f.directory }, async () => {})
  const before = await snapshot(f.root)
  assert.equal(await readNativeInstallIntent(f), undefined)
  assert.deepEqual(await snapshot(f.root), before)
})
for (const kind of ['invalid', 'extra', 'noncanonical', 'oversized', 'directory', 'symlink', 'hardlink', 'fifo'] as const) test(`rejects ${kind} without modifying existing intent`, { skip: process.platform === 'win32' && ['fifo', 'symlink'].includes(kind) }, async t => {
  const f = await fixture(t)
  await withNativeInstallLock({ controlDirectory: f.directory }, async () => {})
  const bytes = encodeNativeInstallIntent(f.intent, f.integration)
  if (kind === 'directory') await fs.mkdir(f.path, { mode: 0o700 })
  else if (kind === 'fifo') execFileSync('mkfifo', ['-m', '600', f.path])
  else if (kind === 'symlink' || kind === 'hardlink') {
    const target = join(f.root, 'target')
    await fs.writeFile(target, bytes, { mode: 0o600 })
    if (kind === 'symlink') await fs.symlink(target, f.path)
    else await fs.link(target, f.path)
  } else await fs.writeFile(f.path, kind === 'invalid' ? '{' : kind === 'extra' ? JSON.stringify({ ...f.intent, extra: true }) + '\n' : kind === 'noncanonical' ? JSON.stringify(f.intent, null, 2) + '\n' : Buffer.alloc(NATIVE_INSTALL_INTENT_MAX_BYTES + 1), { mode: 0o600 })
  const before = await fs.lstat(f.path, { bigint: true })
  await assert.rejects(readNativeInstallIntent(f))
  await assert.rejects(writeNativeInstallIntent(f), { code: 'EEXIST' })
  const after = await fs.lstat(f.path, { bigint: true })
  for (const key of ['ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[key])
})
test('unsafe modes and missing-path unsafe ancestors are rejected without repair', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await fs.mkdir(f.integration.home, { mode: 0o777 })
  await fs.chmod(f.integration.home, 0o777)
  await assert.rejects(readNativeInstallIntent(f))
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' })
  await fs.chmod(f.integration.home, 0o700)
  await writeNativeInstallIntent(f)
  for (const [path, modes] of [[f.path, [0o644, 0o400]], [f.directory, [0o755, 0o500]]] as const) {
    for (const mode of modes) {
      await fs.chmod(path, mode)
      await assert.rejects(readNativeInstallIntent(f))
      assert.equal((await fs.lstat(path)).mode & 0o7777, mode)
    }
    await fs.chmod(path, path === f.path ? 0o600 : 0o700)
  }
})
test('symlink ancestor with missing control is rejected', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), target = join(f.root, 'target')
  await fs.mkdir(target)
  await fs.symlink(target, f.integration.home)
  await assert.rejects(readNativeInstallIntent(f))
  assert.deepEqual(await fs.readdir(target), [])
})
for (const failure of ['partial', 'sync'] as const) test(`${failure} failure retains exclusive file and refuses retry`, async t => {
  const f = await fixture(t), original = fs.open
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[0] === f.path && ((args[1] as number) & constants.O_CREAT) !== 0) {
      if (failure === 'partial') handle.writeFile = async () => { await handle.write(Buffer.from('{')); throw new Error('injected partial failure') }
      else handle.sync = async () => { throw new Error('injected sync failure') }
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try { await assert.rejects(writeNativeInstallIntent(f), /injected/) } finally { fs.open = original; syncBuiltinESMExports() }
  assert.ok((await fs.lstat(f.path)).isFile())
  if (failure === 'partial') await assert.rejects(readNativeInstallIntent(f))
  else assert.deepEqual(await readNativeInstallIntent(f), f.intent) // Valid bytes still do not acknowledge a failed publication.
  await assert.rejects(writeNativeInstallIntent(f), { code: 'EEXIST' })
})
test('write and close failures preserve the original failure and retained file', async t => {
  const f = await fixture(t), original = fs.open
  const failure = new Error('write failure'), closeFailure = new Error('close failure')
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[0] === f.path && ((args[1] as number) & constants.O_CREAT) !== 0) {
      handle.writeFile = async () => { await handle.write(Buffer.from('{')); throw failure }
      const close = handle.close.bind(handle)
      handle.close = async () => { await close(); throw closeFailure }
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try {
    await assert.rejects(writeNativeInstallIntent(f), error => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [failure, closeFailure])
      assert.equal(error.cause, failure)
      return true
    })
  } finally { fs.open = original; syncBuiltinESMExports() }
  assert.equal(await fs.readFile(f.path, 'utf8'), '{')
  await assert.rejects(readNativeInstallIntent(f))
})
test('read validation and close failures retain both errors', async t => {
  const f = await fixture(t), original = fs.open
  await writeNativeInstallIntent(f)
  await fs.writeFile(f.path, '{')
  const closeFailure = new Error('read close failure')
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[0] === f.path) {
      const close = handle.close.bind(handle)
      handle.close = async () => { await close(); throw closeFailure }
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try {
    await assert.rejects(readNativeInstallIntent(f), error => {
      assert.ok(error instanceof AggregateError)
      assert.match(String(error.errors[0]), /Unsafe native install intent/)
      assert.equal(error.errors[1], closeFailure)
      assert.equal(error.cause, error.errors[0])
      return true
    })
  } finally { fs.open = original; syncBuiltinESMExports() }
  assert.equal(await fs.readFile(f.path, 'utf8'), '{')
})
test('writer verifies persisted bytes after sync before acknowledging publication', async t => {
  const f = await fixture(t), original = fs.open
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[0] === f.path && ((args[1] as number) & constants.O_CREAT) !== 0) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { await sync(); await handle.write(Buffer.from('!'), 0, 1, 0) }
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try { await assert.rejects(writeNativeInstallIntent(f), /Unsafe/) } finally { fs.open = original; syncBuiltinESMExports() }
  assert.equal((await fs.readFile(f.path))[0], '!'.charCodeAt(0))
  await assert.rejects(readNativeInstallIntent(f))
  await assert.rejects(writeNativeInstallIntent(f), { code: 'EEXIST' })
})
for (const change of ['sibling', 'child', 'parent-mode', 'parent-inode'] as const) test(`reader handles ${change} during descriptor read`, { skip: process.platform === 'win32' && change.startsWith('parent-') }, async t => {
  const f = await fixture(t)
  await writeNativeInstallIntent(f)
  const parent = dirname(f.directory), original = fs.open
  const before = await fs.lstat(parent, { bigint: true })
  let changed = false
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[0] === f.path) {
      const read = handle.read.bind(handle)
      handle.read = (async (...readArgs: unknown[]) => {
        const result = await (read as (...args: unknown[]) => Promise<unknown>)(...readArgs)
        if (!changed) {
          changed = true
          if (change === 'sibling' || change === 'child') {
            await fs.mkdir(join(change === 'sibling' ? parent : f.directory, 'unrelated-child'), { mode: 0o700 })
          } else if (change === 'parent-mode') {
            // Both modes pass ancestor policy; the snapshot must still detect change.
            await fs.chmod(parent, (before.mode & 0o777n) === 0o700n ? 0o750 : 0o700)
          } else {
            const moved = join(dirname(parent), 'moved-parent')
            assert.ok(parent.startsWith(f.root + '/'))
            assert.equal(dirname(moved), dirname(parent))
            await fs.rename(parent, moved)
            await fs.mkdir(parent, { mode: Number(before.mode & 0o777n) })
            // Keep the control directory and source file identities unchanged:
            // only the containing parent's inode has been replaced.
            const movedControl = join(moved, 'native-install-control')
            assert.equal(dirname(f.directory), parent)
            assert.equal(dirname(movedControl), moved)
            await fs.rename(movedControl, f.directory)
          }
        }
        return result
      }) as typeof handle.read
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try {
    if (change === 'sibling' || change === 'child') assert.deepEqual(await readNativeInstallIntent(f), f.intent)
    else await assert.rejects(readNativeInstallIntent(f), /Unsafe/)
    assert.ok(changed)
  } finally { fs.open = original; syncBuiltinESMExports() }
})
for (const race of ['replace', 'hardlink', 'grow', 'ancestor'] as const) test(`reader rejects ${race} during descriptor read`, { skip: process.platform === 'win32' && ['replace', 'ancestor'].includes(race) }, async t => {
  const f = await fixture(t)
  await writeNativeInstallIntent(f)
  const original = fs.open
  let changed = false
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[0] === f.path) {
      const read = handle.read.bind(handle)
      handle.read = (async (...readArgs: unknown[]) => {
        const result = await (read as (...args: unknown[]) => Promise<unknown>)(...readArgs)
        if (!changed) {
          changed = true
          if (race === 'replace') {
            const target = join(f.root, 'replacement')
            await fs.writeFile(target, encodeNativeInstallIntent(f.intent, f.integration), { mode: 0o600 })
            // Both absolute paths are fixture-owned, checked before replacement.
            assert.equal(dirname(f.path), f.directory)
            await fs.rename(target, f.path)
          } else if (race === 'hardlink') await fs.link(f.path, join(f.root, 'extra-link'))
          else if (race === 'grow') await fs.appendFile(f.path, 'x')
          else {
            const moved = join(dirname(f.directory), 'moved-control')
            assert.equal(dirname(moved), dirname(f.directory))
            await fs.rename(f.directory, moved)
            await fs.mkdir(f.directory, { mode: 0o700 })
            await fs.writeFile(f.path, encodeNativeInstallIntent(f.intent, f.integration), { mode: 0o600 })
          }
        }
        return result
      }) as typeof handle.read
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try { await assert.rejects(readNativeInstallIntent(f), /Unsafe/); assert.ok(changed) } finally { fs.open = original; syncBuiltinESMExports() }
})
test('native Windows read and refusal preserve ACLs; shared ACLs fail without repair', { skip: process.platform !== 'win32', timeout: 120_000 }, async t => {
  const f = await fixture(t)
  await writeNativeInstallIntent(f)
  const powershell = (script: string, target: string) => execFileSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(String.raw`
$ErrorActionPreference = 'Stop'
$env:PSModulePath = "$PSHOME\Modules"
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
` + script, 'utf16le').toString('base64'),
  ], { env: { ...process.env, TEST_TARGET: target }, encoding: 'utf8', timeout: 10_000, windowsHide: true })
  for (const target of [f.path, f.directory]) {
    const before = powershell('(Get-Acl -LiteralPath $env:TEST_TARGET).Sddl', target)
    assert.deepEqual(await readNativeInstallIntent(f), f.intent)
    await assert.rejects(writeNativeInstallIntent(f), { code: 'EEXIST' })
    assert.equal(powershell('(Get-Acl -LiteralPath $env:TEST_TARGET).Sddl', target), before)
  }
  powershell(String.raw`
$acl = Get-Acl -LiteralPath $env:TEST_TARGET
$sid = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:TEST_TARGET -AclObject $acl
`, f.path)
  const shared = powershell('(Get-Acl -LiteralPath $env:TEST_TARGET).Sddl', f.path)
  await assert.rejects(readNativeInstallIntent(f), /Unsafe/)
  await assert.rejects(writeNativeInstallIntent(f), { code: 'EEXIST' })
  assert.equal(powershell('(Get-Acl -LiteralPath $env:TEST_TARGET).Sddl', f.path), shared)
})
test('writer uses shared lock held by another process before creating intent', { timeout: 60_000 }, async t => {
  const f = await fixture(t)
  const moduleUrl = new URL('../scripts/native-install-lock.ts', import.meta.url).href
  const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
    import {withNativeInstallLock} from ${JSON.stringify(moduleUrl)};
    await withNativeInstallLock({controlDirectory: process.env.TEST_CONTROL}, async () => {
      await new Promise(resolve => { process.stdin.resume(); process.stdin.once('end', resolve); process.stdout.write('READY\\n'); });
    });
  `], { env: { ...process.env, TEST_CONTROL: f.directory }, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', () => reject(new Error(stderr)))
    child.stdout.on('data', data => { if (String(data).includes('READY')) resolve() })
  })
  const before = await snapshot(f.root)
  assert.equal(await readNativeInstallIntent(f), undefined)
  assert.deepEqual(await snapshot(f.root), before)
  await assert.rejects(writeNativeInstallIntent(f), /Another launcher is still working/)
  await assert.rejects(fs.lstat(f.path), { code: 'ENOENT' })
  child.stdin.end()
  await exited
  assert.deepEqual(await writeNativeInstallIntent(f), f.intent)
})
