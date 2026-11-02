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
  script = String.raw`$env:PSModulePath = "$PSHOME\Modules"
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
` + script
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
  // Elevated Windows may assign Administrators ownership to Node-created files;
  // restart must accept their inherited private DACL without granting new access.
  await ensurePrivateDataDirectory(root)
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
  await assert.rejects(ensurePrivateDataDirectory(root), /permissions \[descendant-acl-policy\]/)
  assert.equal(await powershell('(Get-Acl -LiteralPath $env:JARVIS_TEST_DIRECTORY).Sddl', root), before)
})

// Instrument a copy of the exact fixed production program, never the production
// API/environment. All filesystem and ACL operations still run on native Windows.
async function scanWithMutation(root: string, marker: string, mutation: string): Promise<string> {
  const source = await readFile(new URL('../src/private-directory.ts', import.meta.url), 'utf8')
  const match = source.match(/const windowsScript = String\.raw`([\s\S]*?)`/)
  assert.ok(match, 'fixed native script must remain discoverable')
  assert.equal(match[1].split(marker).length, 2, 'mutation point must be unique')
  const script = match[1].replace(marker, `${mutation}\n${marker}`)
  return powershell('$env:JARVIS_PRIVATE_DIRECTORY = $env:JARVIS_TEST_DIRECTORY\n' + script, root)
}

for (const point of ['metadata', 'acl', 'queued-directory'] as const) {
  test(`Windows tolerates a genuinely vanished descendant at ${point}`, { skip: !windows }, async t => {
    const root = join(await fixture(t), 'data')
    await ensurePrivateDataDirectory(root)
    const child = join(root, 'ephemeral')
    if (point === 'queued-directory') await mkdir(child)
    else await writeFile(child, 'temporary')
    const marker = point === 'metadata' ? '      $childPath = $child.FullName'
      : point === 'acl' ? '      try { $security = Get-Acl -LiteralPath $childPath -ErrorAction Stop }'
        : '    $directory = $queue.Dequeue()'
    const mutation = point === 'queued-directory'
      ? "if ($queue.Peek() -ne $p) { Remove-Item -LiteralPath $queue.Peek() -Force -ErrorAction Stop }"
      : "if (!$script:removed) { Remove-Item -LiteralPath (Join-Path $p 'ephemeral') -Force -ErrorAction Stop; $script:removed = $true }"
    await scanWithMutation(root, marker, mutation)
    await assert.rejects(lstat(child), { code: 'ENOENT' })
    await ensurePrivateDataDirectory(root)
  })
}

for (const point of ['before-metadata', 'after-acl', 'queued-directory'] as const) {
  test(`Windows rejects a descendant replaced by a junction ${point}`, { skip: !windows }, async t => {
    const parent = await fixture(t)
    const root = join(parent, 'data')
    await ensurePrivateDataDirectory(root)
    await mkdir(join(root, 'ephemeral'))
    await mkdir(join(parent, 'target'))
    const marker = point === 'before-metadata' ? '      $childPath = $child.FullName'
      : point === 'after-acl' ? '      # Check again after the ACL read so a replacement\'s cached attributes are'
        : '    $directory = $queue.Dequeue()'
    const condition = point === 'queued-directory' ? '$queue.Peek() -ne $p' : '!$script:replaced'
    const mutation = `if (${condition}) {
      $victim = Join-Path $p 'ephemeral'
      Remove-Item -LiteralPath $victim -Force -ErrorAction Stop
      New-Item -ItemType Junction -Path $victim -Target (Join-Path (Split-Path $p) 'target') -ErrorAction Stop | Out-Null
      $script:replaced = $true
    }`
    await assert.rejects(scanWithMutation(root, marker, mutation), { code: point === 'queued-directory' ? 50 : 51 })
  })
}

test('Windows rejects fresh shared ACL after enumeration', { skip: !windows }, async t => {
  const root = join(await fixture(t), 'data')
  await ensurePrivateDataDirectory(root)
  await writeFile(join(root, 'ephemeral'), 'temporary')
  await assert.rejects(scanWithMutation(root,
    '      try { $security = Get-Acl -LiteralPath $childPath -ErrorAction Stop }', `
    $shared = Get-Acl -LiteralPath $childPath
    $shared.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
    Set-Acl -LiteralPath $childPath -AclObject $shared
  `), { code: 54 })
})

test('Windows missing-item recovery refuses a name that reappears', { skip: !windows }, async t => {
  const root = join(await fixture(t), 'data')
  await ensurePrivateDataDirectory(root)
  await writeFile(join(root, 'ephemeral'), 'temporary')
  // Remove at the actual Get-Acl call, then restore the name before its recheck.
  const marker = '      try { $security = Get-Acl -LiteralPath $childPath -ErrorAction Stop }'
  await assert.rejects(scanWithMutation(root, marker, `
    Remove-Item -LiteralPath $childPath -Force -ErrorAction Stop
    try { Get-Acl -LiteralPath $childPath -ErrorAction Stop }
    catch {
      [IO.File]::WriteAllText($childPath, 'replacement')
      Confirm-Vanished $childPath $_
    }
  `), { code: 55 })
})

test('Windows missing-item recovery requires a private root', { skip: !windows }, async t => {
  const root = join(await fixture(t), 'data')
  await ensurePrivateDataDirectory(root)
  await writeFile(join(root, 'ephemeral'), 'temporary')
  const before = await powershell('(Get-Acl -LiteralPath $env:JARVIS_TEST_DIRECTORY).Sddl', root)
  await assert.rejects(scanWithMutation(root,
    '      try { $security = Get-Acl -LiteralPath $childPath -ErrorAction Stop }', `
    $shared = Get-Acl -LiteralPath $p
    $shared.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
    Set-Acl -LiteralPath $p -AclObject $shared
    Remove-Item -LiteralPath $childPath -Force -ErrorAction Stop
  `), { code: 58 })
  assert.notEqual(await powershell('(Get-Acl -LiteralPath $env:JARVIS_TEST_DIRECTORY).Sddl', root), before)
})

for (const [exception, code] of [
  ["[UnauthorizedAccessException]::new('fixture')", 56],
  ["[IO.IOException]::new('fixture', -2147024864)", 57],
  ["[IO.IOException]::new('fixture')", 52],
] as const) {
  test(`Windows descendant errors fail closed with diagnostic ${code}`, { skip: !windows }, async t => {
    const root = join(await fixture(t), 'data')
    await ensurePrivateDataDirectory(root)
    await writeFile(join(root, 'ephemeral'), 'temporary')
    // Classification-only fault injection; real disappearance tests above use
    // native cmdlets. Even an absent name cannot excuse a non-missing error.
    await assert.rejects(scanWithMutation(root,
      '      try { $security = Get-Acl -LiteralPath $childPath -ErrorAction Stop }', `
      Remove-Item -LiteralPath $childPath -Force -ErrorAction Stop
      $failure = [Management.Automation.ErrorRecord]::new(${exception}, 'Fixture', [Management.Automation.ErrorCategory]::NotSpecified, $null)
      Confirm-Vanished $childPath $failure
    `), { code })
  })
}

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
