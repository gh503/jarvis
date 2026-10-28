import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, realpath, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, parse, relative, resolve, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// Constant code only: the path is transported through the environment, never
// interpolated into PowerShell syntax, a shell command, or a diagnostic.
const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = 41
trap { exit $stage }
# pwsh 7 parents export their incompatible module path to Windows PowerShell.
# Load only the bundled Windows PowerShell modules, never user module overrides.
$env:PSModulePath = "$PSHOME\Modules"
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$stage = 42
$p = $env:JARVIS_PRIVATE_DIRECTORY
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admins = 'S-1-5-32-544'
function Check-Boundaries {
  $cursor = $p
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe directory boundary' }
    }
    $parent = [IO.Directory]::GetParent($cursor)
    if (!$parent) { break }
    $cursor = $parent.FullName
  }
}
# Walk without following reparse points. Bound startup work and fail closed;
# no descendant ACL is rewritten to accommodate an unsafe legacy tree.
function Check-Descendants {
  if (!(Test-Path -LiteralPath $p)) { return }
  $queue = [Collections.Generic.Queue[string]]::new()
  $queue.Enqueue($p)
  $count = 0
  while ($queue.Count -gt 0) {
    $directory = $queue.Dequeue()
    foreach ($child in Get-ChildItem -LiteralPath $directory -Force) {
      $count++
      if ($count -gt 100000) { throw 'Data tree exceeds private permission preflight limit' }
      if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe descendant reparse point' }
      $security = Get-Acl -LiteralPath $child.FullName
      if ($security.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Foreign-owned descendant' }
      $entries = @($security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
      if ($entries.Count -eq 0) { throw 'Empty descendant DACL' }
      foreach ($entry in $entries) {
        if ($entry.IdentityReference.Value -notin @($user.Value, $system.Value, $admins)) { throw 'Shared descendant ACL: migrate to a private data tree explicitly' }
      }
      if ($child.PSIsContainer) { $queue.Enqueue($child.FullName) }
    }
  }
}
Check-Boundaries
$stage = 43
Check-Descendants
$stage = 44
if (Test-Path -LiteralPath $p) {
  $old = Get-Acl -LiteralPath $p
  $owner = $old.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $user.Value) { throw 'Data root must be owned by the current account' }
  foreach ($rule in $old.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.IdentityReference.Value -notin @($user.Value, $system.Value, $admins)) {
      throw 'Explicit shared permissions: choose a dedicated private data root'
    }
  }
}
$stage = 45
[IO.Directory]::CreateDirectory($p) | Out-Null
Check-Boundaries
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
foreach ($sid in @($user, $system)) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
$stage = 46
Set-Acl -LiteralPath $p -AclObject $acl
$stage = 47
Check-Boundaries
Check-Descendants
$verified = Get-Acl -LiteralPath $p
if (!$verified.AreAccessRulesProtected -or $verified.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Private ACL verification failed' }
$rules = @($verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw 'Unexpected access rules' }
foreach ($sid in @($user, $system)) {
  $matching = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid.Value -and $_.AccessControlType -eq 'Allow' -and !$_.IsInherited -and $_.FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and $_.InheritanceFlags -eq $inherit -and $_.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None })
  if ($matching.Count -ne 1) { throw 'Private ACL verification failed' }
}
`

function isSameOrAncestor(candidate: string, target: string): boolean {
  const rest = relative(candidate, target)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rest))
}

/**
 * Prepare a dedicated account-owned data root BEFORE creating tokens or databases.
 * Changes only the root's permissions, never ancestor directories. Existing POSIX
 * owner-only/readable roots migrate to 0700; shared writable roots and explicit
 * Windows third-party ACLs require the operator to choose a private directory.
 * Existing Windows descendants are preflighted (100,000 objects / 30 seconds,
 * failing closed); shared entries require explicit migration, never recursive
 * permission rewriting. SYSTEM and Administrators are trusted OS principals.
 * Symlink/reparse boundaries are rejected except root-owned macOS temp aliases. As with normal filesystem operations,
 * this does not protect against a malicious process already running as this user.
 */
export async function ensurePrivateDataDirectory(dir: string): Promise<void> {
  if (!dir || dir.includes('\0') || !isAbsolute(dir)) throw new Error('Private data directory must be an absolute path')
  let root = resolve(dir)
  // macOS exposes these root-owned OS aliases even in its native temp paths.
  // Canonicalize only the exact documented link, never arbitrary user links.
  if (process.platform === 'darwin') {
    for (const alias of ['/var', '/tmp']) {
      if (root === alias || root.startsWith(`${alias}/`)) {
        const stat = await lstat(alias)
        if (stat.isSymbolicLink() && stat.uid === 0 && [`private${alias}`, `/private${alias}`].includes(await readlink(alias))) {
          root = `/private${root}`
        }
      }
    }
  }
  if (root === parse(root).root || (process.platform !== 'win32' && ['/tmp', '/var', '/private', '/private/tmp', '/private/var'].includes(root)) || isSameOrAncestor(root, resolve(homedir()))) {
    throw new Error('Choose a dedicated data directory, not a filesystem root, home, or home ancestor')
  }
  if (process.platform === 'win32') {
    // Reject UNC/device namespaces, alternate streams, and Win32 name aliases.
    if (!/^[a-z]:\\/i.test(dir) || dir.slice(2).includes(':') || dir.split(/[\\/]/).slice(1).some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error('Private data directory requires an unambiguous local drive path')
    }
    for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA, process.env.ProgramData, process.env.SystemRoot]) {
      if (base && isSameOrAncestor(root, resolve(base))) throw new Error('Choose a dedicated data directory below the system or account directory')
    }
    const systemRoot = process.env.SystemRoot
    if (!systemRoot || !isAbsolute(systemRoot)) throw new Error('Cannot locate the native Windows ACL tool')
    try {
      await execute(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsScript, 'utf16le').toString('base64'),
      ], { env: { ...process.env, JARVIS_PRIVATE_DIRECTORY: root }, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 })
    } catch (error) {
      // Report only our allowlisted stage codes, never stderr or exception text.
      const stages: Record<number, string> = { 41: 'native-module', 42: 'path-boundary', 43: 'descendant-preflight', 44: 'root-preflight', 45: 'create-root', 46: 'apply-acl', 47: 'verify-acl' }
      const code = (error as { code?: unknown }).code
      const stage = typeof code === 'number' ? stages[code] ?? 'native-process' : 'native-process'
      throw new Error(`Cannot establish private Windows data permissions [${stage}]: use a dedicated current-account-owned local directory without links or explicit shared ACLs`)
    }
    return
  }

  const parts: string[] = []
  for (let cursor = root; ; cursor = dirname(cursor)) {
    parts.unshift(cursor)
    if (cursor === dirname(cursor)) break
  }
  for (const part of parts) {
    let stat
    try { stat = await lstat(part) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await mkdir(part, { mode: 0o700 }) } catch (creationError) {
        if ((creationError as NodeJS.ErrnoException).code !== 'EEXIST') throw creationError
      }
      stat = await lstat(part)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private data directory cannot cross a link or non-directory boundary')
    if (part === root) {
      if (stat.uid !== process.getuid?.()) throw new Error('Private data directory must be owned by the current account')
      if (stat.mode & 0o022) throw new Error('Shared writable data root: choose a dedicated private data directory')
    }
  }
  if (await realpath(root) !== root) throw new Error('Private data directory changed during validation')
  await chmod(root, 0o700)
  const verified = await lstat(root)
  if (!verified.isDirectory() || verified.uid !== process.getuid?.() || (verified.mode & 0o777) !== 0o700) {
    throw new Error('Private data directory permission verification failed')
  }
}
