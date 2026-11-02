import { constants as C, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// Deliberately finite: configuration must never become a generic environment loader.
export const externalConfigKeys = [
  'JARVIS_HOST', 'JARVIS_PORT', 'JARVIS_DATA_DIR', 'JARVIS_WEB_DIR', 'JARVIS_AUTH_TOKEN',
  'JARVIS_TLS_CERT', 'JARVIS_TLS_KEY', 'JARVIS_OLLAMA_URL', 'JARVIS_LLM_MODEL',
  'JARVIS_VISION_MODEL', 'JARVIS_EMBED_MODEL', 'JARVIS_OLLAMA_KEEP_ALIVE', 'JARVIS_ASR_ENGINE',
  'JARVIS_WHISPER_BIN', 'JARVIS_WHISPER_MODEL', 'JARVIS_ASR_SCRIPT', 'JARVIS_ASR_MODEL',
  'JARVIS_OCR_SCRIPT', 'JARVIS_PYTHON', 'JARVIS_PIPER_BIN', 'JARVIS_PIPER_VOICE',
  'JARVIS_FFMPEG', 'JARVIS_ARECORD', 'JARVIS_QUIET_START', 'JARVIS_QUIET_END',
  'JARVIS_DAILY_SPEAK_BUDGET', 'JARVIS_SCREEN_TIMEOUT_MS', 'JARVIS_SCREEN_BLOCKLIST',
  'JARVIS_CALENDAR_ICS', 'JARVIS_ALLOWED_HOSTS', 'JARVIS_ALLOW_REMOTE_VISION',
  'JARVIS_LOG_LEVEL', 'JARVIS_BRIEF_TIME', 'JARVIS_CAMERA_DEVICE', 'JARVIS_EDGE_TTS_BIN',
  'JARVIS_NOTIFY_COMMAND', 'JARVIS_NOTIFY',
] as const
const paths = new Set([
  'JARVIS_DATA_DIR', 'JARVIS_WEB_DIR', 'JARVIS_TLS_CERT', 'JARVIS_TLS_KEY',
  'JARVIS_WHISPER_BIN', 'JARVIS_WHISPER_MODEL', 'JARVIS_ASR_SCRIPT', 'JARVIS_OCR_SCRIPT',
  'JARVIS_PYTHON', 'JARVIS_PIPER_BIN', 'JARVIS_PIPER_VOICE', 'JARVIS_FFMPEG',
  'JARVIS_ARECORD', 'JARVIS_CALENDAR_ICS', 'JARVIS_CAMERA_DEVICE', 'JARVIS_EDGE_TTS_BIN',
  'JARVIS_NOTIFY_COMMAND',
])
const keys = new Set<string>(externalConfigKeys)
const limit = 64 * 1024
const invalid = () => new Error('Invalid JARVIS_CONFIG_FILE: require a private canonical absolute regular single-link file, valid UTF-8, at most 64 KiB, and recognized settings with absolute paths')

// Read-only counterpart of private-directory.ts's Windows trust policy. Do not
// call ensurePrivateDataDirectory: it changes permissions on the actual target.
const windowsCheck = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
trap { exit 1 }
$env:PSModulePath = "$PSHOME\Modules"
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$p = $env:JARVIS_CONFIG_CHECK_TARGET
$cursor = $p
while ($cursor) {
  $item = Get-Item -LiteralPath $cursor -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 1 }
  if ($cursor -ne $p -and !$item.PSIsContainer) { exit 1 }
  $parent = [IO.Directory]::GetParent($cursor)
  if (!$parent) { break }
  $cursor = $parent.FullName
}
foreach ($target in @($p, [IO.Path]::GetDirectoryName($p))) {
  $acl = Get-Acl -LiteralPath $target
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $user -and !($owner -eq 'S-1-5-32-544' -and $elevated)) { exit 1 }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -eq 0) { exit 1 }
  $readable = $false
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -notin @($user, 'S-1-5-18', 'S-1-5-32-544') -or $rule.AccessControlType -ne 'Allow') { exit 1 }
    if ($rule.IdentityReference.Value -eq $user -and !($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Read) -eq [Security.AccessControl.FileSystemRights]::Read) { $readable = $true }
  }
  if (!$readable) { exit 1 }
}
`
function privateMode(stat: BigIntStats): boolean {
  return process.platform === 'win32' || (process.getuid !== undefined && stat.uid === BigInt(process.getuid()) && (stat.mode & 0o077n) === 0n)
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
function inspect(file: string, maxBytes = limit): BigIntStats {
  if (!file || file.includes('\0') || !isAbsolute(file) || resolve(file) !== file || realpathSync(file) !== file) throw invalid()
  if (process.platform === 'win32' && (!/^[a-z]:\\/i.test(file) || file.slice(2).includes(':') || file.split(/[\\/]/).slice(1).some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw invalid()
  for (let part = dirname(file); ; part = dirname(part)) {
    const stat = lstatSync(part, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || (part === dirname(file) && !privateMode(stat))) throw invalid()
    if (part === dirname(part)) break
  }
  const stat = lstatSync(file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(maxBytes) || !privateMode(stat)) throw invalid()
  return stat
}

/** Validate without modifying the file, its ACL, or process.env. Portable checks
 * trust the OS account boundary, as private-storage does; this is not a sandbox
 * against a malicious process already running as the same account. */
export function readPrivateConfigurationFile(file: string, maxBytes = limit): Buffer {
  let fd: number | undefined
  try {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > limit) throw invalid()
    const before = inspect(file, maxBytes)
    if (process.platform === 'win32') {
      const root = process.env.SystemRoot
      if (!root || !isAbsolute(root)) throw invalid()
      execFileSync(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsCheck, 'utf16le').toString('base64'),
      ], { env: { ...process.env, JARVIS_CONFIG_CHECK_TARGET: file }, windowsHide: true, timeout: 10_000, maxBuffer: limit, stdio: ['ignore', 'pipe', 'pipe'] })
    }
    fd = openSync(file, C.O_RDONLY | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0))
    if (!same(before, fstatSync(fd, { bigint: true }))) throw invalid()
    const bytes = Buffer.alloc(maxBytes + 1)
    let total = 0
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, null)
      if (!count) break
      total += count
    }
    if (total > maxBytes || BigInt(total) !== before.size || !same(before, fstatSync(fd, { bigint: true })) || !same(before, inspect(file, maxBytes))) throw invalid()
    return Buffer.from(bytes.subarray(0, total))
  } catch { throw invalid() }
  finally { if (fd !== undefined) closeSync(fd) }
}

/** Return the validated original bytes and settings from the same bounded read. */
export function readExternalConfig(file: string): { bytes: Buffer; values: Record<string, string> } {
  try {
    const bytes = readPrivateConfigurationFile(file)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0')) throw invalid()
    const parsed: Record<string, string> = {}
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const match = /^([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line)
      if (!match || !keys.has(match[1]) || Object.hasOwn(parsed, match[1])) throw invalid()
      let value = match[2].trim()
      if (/^["']/.test(value)) {
        if (value.length < 2 || value.at(-1) !== value[0]) throw invalid()
        value = value.slice(1, -1)
      }
      if (paths.has(match[1]) && value && (!isAbsolute(value) || value.trim() !== value)) throw invalid()
      parsed[match[1]] = value
    }
    if (!parsed.JARVIS_DATA_DIR) throw invalid()
    return { bytes, values: parsed }
  } catch { throw invalid() }
}

export function loadExternalConfig(file: string): Record<string, string> {
  return readExternalConfig(file).values
}
