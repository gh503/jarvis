import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'

const windows = process.platform === 'win32'
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'jarvis-private-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
async function powershell(script: string, dir: string): Promise<string> {
  const { stdout } = await promisify(execFile)(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { env: { ...process.env, JARVIS_TEST_DIRECTORY: dir }, windowsHide: true })
  return stdout.trim()
}

test('private root rejects relative paths, filesystem root, home and ancestors', async () => {
  for (const path of ['relative/data', '', parse(homedir()).root, homedir()]) {
    await assert.rejects(ensurePrivateDataDirectory(path), /absolute|dedicated/)
  }
})

test('private root creates nested directories and retains account read/write', async t => {
  const parent = await fixture(t)
  const before = (await lstat(parent)).mode
  const root = join(parent, 'nested', 'data')
  await ensurePrivateDataDirectory(root)
  await ensurePrivateDataDirectory(root)
  await writeFile(join(root, 'probe'), 'account read/write')
  assert.equal(await readFile(join(root, 'probe'), 'utf8'), 'account read/write')
  assert.equal((await lstat(parent)).mode, before)
  if (!windows) assert.equal((await lstat(root)).mode & 0o777, 0o700)
})

test('POSIX migrates owner directory without touching ancestor modes', { skip: windows }, async t => {
  const parent = await fixture(t)
  const root = join(parent, 'data')
  await mkdir(root)
  await chmod(parent, 0o755)
  await chmod(root, 0o755)
  await ensurePrivateDataDirectory(root)
  assert.equal((await lstat(root)).mode & 0o777, 0o700)
  assert.equal((await lstat(parent)).mode & 0o777, 0o755)
})

test('POSIX refuses shared writable root without changing it', { skip: windows }, async t => {
  const root = await fixture(t)
  await chmod(root, 0o770)
  await assert.rejects(ensurePrivateDataDirectory(root), /Shared writable/)
  assert.equal((await lstat(root)).mode & 0o777, 0o770)
  await assert.rejects(acquireLifecycleLock(root, 'launcher'), /Shared writable/)
  await assert.rejects(lstat(join(root, 'launcher.lock.sqlite')), { code: 'ENOENT' })
})

test('rejects symbolic links or junctions at root and ancestor boundaries', async t => {
  const parent = await fixture(t)
  const target = join(parent, 'target')
  const link = join(parent, 'link')
  await mkdir(target)
  await symlink(target, link, windows ? 'junction' : 'dir')
  await assert.rejects(ensurePrivateDataDirectory(link), /link|permissions/)
  await assert.rejects(ensurePrivateDataDirectory(join(link, 'data')), /link|permissions/)
  await assert.rejects(lstat(join(target, 'data')), { code: 'ENOENT' })
})

test('lifecycle secures root before creating its SQLite database', async t => {
  const root = join(await fixture(t), 'data')
  const release = await acquireLifecycleLock(root, 'launcher')
  try {
    assert.ok((await lstat(join(root, 'launcher.lock.sqlite'))).isFile())
    if (!windows) assert.equal((await lstat(root)).mode & 0o777, 0o700)
  } finally { release() }
})

test('Windows native ACL grants only user and SYSTEM; new files inherit private ACL', { skip: !windows }, async t => {
  const root = join(await fixture(t), "data ' ; $value")
  await ensurePrivateDataDirectory(root)
  await writeFile(join(root, 'probe'), 'account read/write')
  assert.equal(await readFile(join(root, 'probe'), 'utf8'), 'account read/write')
  const report = JSON.parse(await powershell(`
$ErrorActionPreference = 'Stop'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$root = Get-Acl -LiteralPath $env:JARVIS_TEST_DIRECTORY
$file = Get-Acl -LiteralPath (Join-Path $env:JARVIS_TEST_DIRECTORY 'probe')
@{ user = $user; owner = $root.GetOwner([Security.Principal.SecurityIdentifier]).Value; protected = $root.AreAccessRulesProtected; root = @($root.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq 'Allow'); rights = [int]$_.FileSystemRights; inherited = $_.IsInherited } }); file = @($file.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }) } | ConvertTo-Json -Depth 5 -Compress
`, root))
  assert.equal(report.protected, true)
  assert.equal(report.owner, report.user)
  assert.deepEqual(report.root.map((rule: { sid: string }) => rule.sid).sort(), [report.user, 'S-1-5-18'].sort())
  for (const rule of report.root) {
    assert.equal(rule.allow, true)
    assert.equal(rule.inherited, false)
    assert.equal(rule.rights, 2032127) // FileSystemRights.FullControl
  }
  assert.deepEqual(report.file.sort(), [report.user, 'S-1-5-18'].sort())
})

test('macOS permits only trusted OS temp aliases', { skip: process.platform !== 'darwin' }, async t => {
  const parent = await mkdtemp('/tmp/jarvis-private-')
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, 'data')
  await ensurePrivateDataDirectory(root)
  assert.equal((await lstat(root)).mode & 0o777, 0o700)
})

test('Windows rejects legacy shared descendants before changing root ACL', { skip: !windows }, async t => {
  const root = join(await fixture(t), 'data')
  await ensurePrivateDataDirectory(root)
  const child = join(root, 'legacy')
  await writeFile(child, 'test fixture')
  await powershell(`
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:JARVIS_TEST_DIRECTORY
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
Set-Acl -LiteralPath $env:JARVIS_TEST_DIRECTORY -AclObject $acl
`, child)
  const before = await powershell('(Get-Acl -LiteralPath $env:JARVIS_TEST_DIRECTORY).Sddl', root)
  await assert.rejects(ensurePrivateDataDirectory(root), /permissions/)
  assert.equal(await powershell('(Get-Acl -LiteralPath $env:JARVIS_TEST_DIRECTORY).Sddl', root), before)
})

test('Windows refuses explicit shared ACL without revoking it', { skip: !windows }, async t => {
  const root = join(await fixture(t), 'shared')
  await mkdir(root)
  const script = `
$ErrorActionPreference = 'Stop'
$p = $env:JARVIS_TEST_DIRECTORY
$acl = Get-Acl -LiteralPath $p
$rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'ReadAndExecute', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $acl
(Get-Acl -LiteralPath $p).Sddl
`
  const before = await powershell(script, root)
  await assert.rejects(ensurePrivateDataDirectory(root), /explicit shared ACLs/)
  assert.equal(await powershell('(Get-Acl -LiteralPath $env:JARVIS_TEST_DIRECTORY).Sddl', root), before)
})
