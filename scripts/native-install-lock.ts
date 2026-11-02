import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// Fixed read-only counterpart of external-config's Windows boundary checker.
// Operational SQLite storage requires FullControl, not configuration's Read.
const windowsCheck = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
trap { exit 1 }
$env:PSModulePath = "$PSHOME\Modules"
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$p = $env:JARVIS_INSTALL_CHECK_TARGET
$cursor = $p
while ($cursor) {
  $item = Get-Item -LiteralPath $cursor -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 1 }
  if ($cursor -ne $p -and !$item.PSIsContainer) { exit 1 }
  $parent = [IO.Directory]::GetParent($cursor)
  if (!$parent) { break }
  $cursor = $parent.FullName
}
$acl = Get-Acl -LiteralPath $p
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $user -and !($owner -eq 'S-1-5-32-544' -and $elevated)) { exit 1 }
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
$writable = $false
foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -notin @($user, 'S-1-5-18', 'S-1-5-32-544') -or $rule.AccessControlType -ne 'Allow') { exit 1 }
  if ($rule.IdentityReference.Value -eq $user -and !($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $writable = $true }
}
if (!$writable) { exit 1 }
`
function verifyPrivateWindowsPath(path: string): void {
  const root = process.env.SystemRoot
  if (!root || !isAbsolute(root)) throw unsafe()
  try {
    execFileSync(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsCheck, 'utf16le').toString('base64'),
    ], { env: { ...process.env, JARVIS_INSTALL_CHECK_TARGET: path }, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch { throw unsafe() }
}
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
import { acquireVerifiedLifecycleLock } from '../src/runtime-lifecycle.ts'

const unsafe = () => new Error('Unsafe native install control boundary or permissions')
function validateControlPath(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f\ud800-\udfff]/u.test(path)) throw unsafe()
  if (process.platform === 'win32' && (!/^[a-z]:\\/i.test(path) || path.slice(2).includes(':') || path.includes('/') || path.slice(3).split('\\').some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))) throw unsafe()
}

/** Read-only checks: never repair an existing shared control directory or lock. */
export async function verifyNativeInstallPrivatePath(path: string, directory: boolean): Promise<boolean> {
  let stat
  try { stat = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw unsafe()
  if (process.platform === 'win32') verifyPrivateWindowsPath(path)
  else if (stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)) throw unsafe()
  return true
}

export async function verifyNativeInstallAncestors(directory: string): Promise<void> {
  validateControlPath(directory)
  for (let path = directory; ; path = dirname(path)) {
    let stat
    try { stat = await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (stat) {
      if (stat.isSymbolicLink()) throw new Error('Native install control symlink rejected')
      if (!stat.isDirectory()) throw unsafe()
      if (await realpath(path) !== path) throw new Error('Native install control symlink or noncanonical ancestor rejected')
      // System-owned sticky temp roots are safe ancestors of our account-owned
      // directory. Other shared writable ancestors can redirect the lock name.
      if (process.platform !== 'win32' &&
          ((stat.uid !== process.getuid!() && stat.uid !== 0) ||
           ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000))))) throw unsafe()
    }
    if (path === dirname(path)) break
  }
}

/** Only cooperating install/uninstall writers use this lock. Inspectors and
 * snapshots still require writers stopped. Even an absent-receipt uninstall
 * creates persistent operational control/SQLite files, but no integration.
 * The caller derives this fixed directory from the validated receipt location,
 * never from package root, external configuration, or runtime data directory.
 */
export async function withNativeInstallLock<T>(
  { controlDirectory }: { controlDirectory: string }, operation: () => Promise<T>,
): Promise<T> {
  await verifyNativeInstallAncestors(controlDirectory)
  if (!await verifyNativeInstallPrivatePath(controlDirectory, true)) {
    // Preserve the legacy state parent's permissions; privatize only our child.
    await mkdir(dirname(controlDirectory), { recursive: true, mode: 0o755 })
    await verifyNativeInstallAncestors(dirname(controlDirectory))
    let created = false
    try { await mkdir(controlDirectory, { mode: 0o700 }); created = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (!created) await verifyNativeInstallPrivatePath(controlDirectory, true)
    else await ensurePrivateDataDirectory(controlDirectory)
  }
  await verifyNativeInstallAncestors(controlDirectory)
  if (!await verifyNativeInstallPrivatePath(controlDirectory, true)) throw unsafe()
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    await verifyNativeInstallPrivatePath(join(controlDirectory, `launcher.lock.sqlite${suffix}`), false)
  }
  const release = await acquireVerifiedLifecycleLock(controlDirectory, 'launcher', async () => {
    // Revalidate after lifecycle's hardlink preflight without rewriting existing
    // Windows inheritable ACLs (which would also mutate child intent storage).
    await verifyNativeInstallAncestors(controlDirectory)
    if (!await verifyNativeInstallPrivatePath(controlDirectory, true)) throw unsafe()
  })
  let failure: unknown
  let failed = false
  try { return await operation() } catch (error) { failed = true; failure = error; throw error }
  finally {
    try { release() } catch (error) {
      if (failed) throw new AggregateError([failure, error], 'Native installation and lock release failed', { cause: failure })
      throw error
    }
  }
}
