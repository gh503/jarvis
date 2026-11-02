import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
import { describeNativeIntegration, inspectNativeIntegration, parseNativeIntegrationReceipt, type InstallOptions } from './install-native.ts'

/** Capture, verify, and export portable recovery copies only. Keep all writers
 * quiescent and the manifest digest separately trusted. This does not activate
 * integrations, restore installations or ACLs, copy configuration/package/data
 * contents, or promise atomic/power-loss snapshots or directory fsync durability.
 * Failures retain private partial directories for explicit operator handling.
 * Malicious same-account mutation (including ABA replacement) is out of scope. */
export const INTEGRATION_SNAPSHOT_LIMITS = Object.freeze({ manifestBytes: 16 * 1024, receiptBytes: 64 * 1024, artifactBytes: 1024 * 1024 })
const SCOPE = Object.freeze({ kind: 'native-integration-inventory', activation: 'none', installationRestore: 'none', aclRestore: 'none', writers: 'quiescent-required', atomicity: 'not-asserted', externalConfiguration: 'binding-only', packageAndData: 'binding-only' })
type Inventory = NonNullable<Awaited<ReturnType<typeof inspectNativeIntegration>>>
export interface IntegrationSnapshotManifest {
  schemaVersion: 1
  platform: InstallOptions['platform']
  originalReceiptPath: string
  binding: Inventory['binding']
  scope: typeof SCOPE
  receiptMode: number
  receiptBytes: number
  receiptSha256: string
  artifacts: Array<{ path: string; mode: number | null; bytes: number | null; sha256: string | null }>
}
export interface IntegrationSnapshotResult { snapshot: string; manifestSha256: string; manifest: IntegrationSnapshotManifest }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + '\n')
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const identityKeys = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const
function same(a: BigIntStats, b: BigIntStats) { return identityKeys.every(key => a[key] === b[key]) }
function absolute(path: string) {
  assert(typeof path === 'string' && Buffer.byteLength(path) <= 4096 && isAbsolute(path) && resolve(path) === path && !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(path), 'Expected canonical absolute path')
  // Native Windows normalizes these spellings even for a not-yet-existing leaf.
  // Reject them before mkdir, rather than relying on existing-ancestor realpath.
  if (process.platform === 'win32') assert(/^[a-z]:\\/i.test(path) && !path.slice(2).includes(':') && !path.includes('/') && path.slice(3).split('\\').every(p => !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)), 'Expected native Windows path without aliases')
}
function overlaps(a: string, b: string) {
  const below = (x: string, y: string) => { const r = relative(x, y); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)) }
  return below(a, b) || below(b, a)
}
// Missing original paths are permitted, but every existing boundary must have its
// literal native spelling and contain no symlink/reparse alias.
async function canonical(path: string, missing = false) {
  absolute(path)
  for (let cursor = path; ; cursor = dirname(cursor)) {
    try {
      const s = await lstat(cursor)
      assert(!s.isSymbolicLink() && (cursor === path || s.isDirectory()), 'Unsafe path boundary')
      assert(await realpath(cursor) === cursor, 'Noncanonical native path')
    } catch (error) { if (!missing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (dirname(cursor) === cursor) break
  }
}
function privateStat(s: BigIntStats, directory: boolean) {
  assert(directory ? s.isDirectory() : s.isFile() && s.nlink === 1n, 'Unsafe snapshot file type or links')
  assert(!s.isSymbolicLink(), 'Snapshot links forbidden')
  if (process.platform !== 'win32') assert(s.uid === BigInt(process.getuid!()) && (s.mode & 0o7777n) === (directory ? 0o700n : 0o600n), 'Snapshot permissions must remain private')
}
// Fixed, read-only Windows ACL checker, invoked only for the bounded known inventory.
const WINDOWS_PRIVATE = String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
trap { exit 71 }
$env:PSModulePath="$PSHOME\Modules"
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
foreach ($p in (ConvertFrom-Json $env:JARVIS_INTEGRATION_PATHS)) {
 $c=$p
 while ($c) {
  $a=[IO.File]::GetAttributes($c)
  if ($a -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse boundary' }
  $parent=[IO.Directory]::GetParent($c); if (!$parent) { break }; $c=$parent.FullName
 }
 $acl=Get-Acl -LiteralPath $p
 $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
 if ($owner -ne $user.Value -and !($owner -eq 'S-1-5-32-544' -and $elevated)) { throw 'Owner' }
 $full=$false
 foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference.Value -notin @($user.Value,'S-1-5-18','S-1-5-32-544') -or $rule.AccessControlType -ne 'Allow') { throw 'Shared ACL' }
  if ($rule.IdentityReference.Value -eq $user.Value -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Read) -eq [Security.AccessControl.FileSystemRights]::Read -and !($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { $full=$true }
 }
 if (!$full) { throw 'Missing private access' }
}`
async function windowsPrivate(paths: string[]) {
  if (process.platform !== 'win32') return
  const systemRoot = process.env.SystemRoot
  assert(systemRoot && isAbsolute(systemRoot), 'Windows system root unavailable')
  await promisify(execFile)(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_PRIVATE, 'utf16le').toString('base64')], { env: { ...process.env, JARVIS_INTEGRATION_PATHS: JSON.stringify(paths) }, timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true, shell: false })
}
async function boundedRead(path: string, limit: number) {
  const before = await lstat(path, { bigint: true }); privateStat(before, false)
  assert(before.size <= BigInt(limit), 'Snapshot file size limit exceeded')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    assert(same(before, await handle.stat({ bigint: true })), 'Snapshot changed during read')
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead }
    assert(length === Number(before.size) && same(before, await handle.stat({ bigint: true })) && same(before, await lstat(path, { bigint: true })), 'Snapshot changed during read')
    return bytes.subarray(0, length)
  } finally { await handle.close() }
}
async function exactDirectory(path: string, expected: string[]) {
  const before = await lstat(path, { bigint: true }); privateStat(before, true)
  const remaining = new Set(expected), dir = await opendir(path)
  try {
    for (let count = 0; ; count++) {
      const entry = await dir.read(); if (!entry) break
      assert(count < expected.length && remaining.delete(entry.name), 'Unexpected snapshot inventory')
    }
    assert(remaining.size === 0 && same(before, await lstat(path, { bigint: true })), 'Missing or changing snapshot inventory')
  } finally { await dir.close() }
}
function protectedPaths(inventory: Pick<Inventory, 'receiptPath' | 'artifacts' | 'binding'>) {
  const paths = [dirname(inventory.receiptPath), ...inventory.artifacts.map(item => dirname(item.path)), inventory.binding.root]
  if (inventory.binding.configFile) paths.push(dirname(inventory.binding.configFile), inventory.binding.dataDir!)
  paths.forEach(absolute)
  return paths
}
function manifestFor(inventory: Inventory): IntegrationSnapshotManifest {
  return { schemaVersion: 1, platform: inventory.platform, originalReceiptPath: inventory.receiptPath, binding: inventory.binding, scope: SCOPE, receiptMode: inventory.receiptMode, receiptBytes: inventory.receipt.length, receiptSha256: hash(inventory.receipt), artifacts: inventory.artifacts.map(item => ({ path: item.path, mode: item.mode ?? null, bytes: item.bytes?.length ?? null, sha256: item.bytes === undefined ? null : hash(item.bytes) })) }
}
const mode = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0o7777
function validate(manifest: IntegrationSnapshotManifest, receipt: Buffer, integration: InstallOptions) {
  const layout = describeNativeIntegration(integration), parsed = parseNativeIntegrationReceipt(receipt, integration)
  const binding = { root: parsed.root, autostart: parsed.autostart, ...(parsed.configFile === undefined ? {} : { configFile: parsed.configFile, dataDir: parsed.dataDir! }) }
  assert(manifest && Object.keys(manifest).sort().join(',') === 'artifacts,binding,originalReceiptPath,platform,receiptBytes,receiptMode,receiptSha256,schemaVersion,scope', 'Invalid manifest fields')
  assert(manifest.schemaVersion === 1 && manifest.platform === integration.platform && manifest.originalReceiptPath === layout.receiptPath && JSON.stringify(manifest.binding) === JSON.stringify(binding) && JSON.stringify(manifest.scope) === JSON.stringify(SCOPE), 'Invalid manifest binding or scope')
  assert(mode(manifest.receiptMode) && manifest.receiptBytes === receipt.length && manifest.receiptSha256 === hash(receipt), 'Receipt metadata mismatch')
  assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length === layout.artifactPaths.length, 'Invalid artifact inventory')
  for (const [index, item] of manifest.artifacts.entries()) {
    assert(item && Object.keys(item).sort().join(',') === 'bytes,mode,path,sha256' && item.path === layout.artifactPaths[index], 'Invalid artifact path')
    const owned = parsed.files.find(file => file.path === item.path)
    if (item.bytes === null) assert(item.mode === null && item.sha256 === null, 'Invalid absent artifact')
    else assert(owned && mode(item.mode) && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= INTEGRATION_SNAPSHOT_LIMITS.artifactBytes && item.sha256 === owned.sha256, 'Artifact receipt mismatch')
  }
}
async function writeExclusive(path: string, bytes: Buffer) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}
async function identities(paths: string[]) {
  return Promise.all(paths.map(async path => { try { return await lstat(path, { bigint: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error } }))
}
export async function createIntegrationSnapshot({ integration, destination }: { integration: InstallOptions; destination: string }): Promise<IntegrationSnapshotResult> {
  const layout = describeNativeIntegration(integration)
  const sources = [layout.receiptPath, ...layout.artifactPaths]
  for (const path of sources) await canonical(path, true)
  const before = await identities(sources)
  const inventory = await inspectNativeIntegration(integration)
  assert(inventory, 'Original integration receipt is required')
  const manifest = manifestFor(inventory)
  validate(manifest, inventory.receipt, integration)
  const bytes = encode(manifest)
  assert(bytes.length <= INTEGRATION_SNAPSHOT_LIMITS.manifestBytes, 'Manifest size limit exceeded')
  absolute(destination)
  const protectedRoots = protectedPaths(inventory)
  assert(protectedRoots.every(path => !overlaps(path, destination)), 'Snapshot destination overlaps protected source')
  await canonical(dirname(destination))
  for (const path of [...protectedRoots, inventory.receiptPath, ...inventory.artifacts.map(item => item.path)]) await canonical(path, true)
  await mkdir(destination, { mode: 0o700 })
  await ensurePrivateDataDirectory(destination)
  await mkdir(join(destination, 'payload'), { mode: 0o700 })
  await writeExclusive(join(destination, 'receipt.bin'), inventory.receipt)
  for (const [index, item] of inventory.artifacts.entries()) if (item.bytes !== undefined) await writeExclusive(join(destination, 'payload', `${index}.bin`), item.bytes)
  await exactDirectory(destination, ['receipt.bin', 'payload'])
  const payloadNames = inventory.artifacts.flatMap((item, index) => item.bytes === undefined ? [] : [`${index}.bin`])
  await exactDirectory(join(destination, 'payload'), payloadNames)
  await windowsPrivate([destination, join(destination, 'receipt.bin'), join(destination, 'payload'), ...payloadNames.map(name => join(destination, 'payload', name))])
  assert((await boundedRead(join(destination, 'receipt.bin'), INTEGRATION_SNAPSHOT_LIMITS.receiptBytes)).equals(inventory.receipt), 'Copied receipt mismatch')
  for (const [index, item] of inventory.artifacts.entries()) if (item.bytes !== undefined) assert((await boundedRead(join(destination, 'payload', `${index}.bin`), INTEGRATION_SNAPSHOT_LIMITS.artifactBytes)).equals(item.bytes), 'Copied payload mismatch')
  const current = await inspectNativeIntegration(integration), after = await identities(sources)
  assert(current && encode(manifestFor(current)).equals(bytes) && before.every((s, index) => s === undefined ? after[index] === undefined : after[index] !== undefined && same(s, after[index]!)), 'Original integration changed during capture')
  await writeExclusive(join(destination, 'manifest.json'), bytes)
  const result = await verifyIntegrationSnapshot({ snapshot: destination, manifestSha256: hash(bytes), integration })
  const finalInventory = await inspectNativeIntegration(integration), finalIdentities = await identities(sources)
  assert(finalInventory && encode(manifestFor(finalInventory)).equals(bytes) && before.every((s, index) => s === undefined ? finalIdentities[index] === undefined : finalIdentities[index] !== undefined && same(s, finalIdentities[index]!)), 'Original integration changed during capture')
  return result
}
/** Export a portable, data-only recovery copy into a fresh private directory.
 * The original manifest/receipt/payload bytes and recorded modes are preserved;
 * copied files are private data (0600), never executable integration artifacts.
 * This never writes original integration paths or invokes integration activation.
 * All writers must remain stopped; later failures retain the partial destination. */
export async function restoreIntegrationSnapshot({ snapshot, manifestSha256, integration, destination }: { snapshot: string; manifestSha256: string; integration: InstallOptions; destination: string }): Promise<{ destination: string; manifestSha256: string; manifest: IntegrationSnapshotManifest }> {
  const { manifest } = await verifyIntegrationSnapshot({ snapshot, manifestSha256, integration })
  absolute(destination)
  const protectedRoots = protectedPaths({ receiptPath: manifest.originalReceiptPath, artifacts: manifest.artifacts.map(item => ({ path: item.path, bytes: undefined, mode: undefined })), binding: manifest.binding })
  assert([snapshot, ...protectedRoots].every(path => !overlaps(path, destination)), 'Recovery destination overlaps snapshot or protected source')
  await canonical(dirname(destination))
  // Original files may have disappeared. Still check every existing ancestor so
  // aliases cannot turn a lexically separate destination into a production path.
  for (const path of [...protectedRoots, manifest.originalReceiptPath, ...manifest.artifacts.map(item => item.path)]) await canonical(path, true)
  const names = manifest.artifacts.flatMap((item, index) => item.bytes === null ? [] : [`${index}.bin`])
  const sources = [snapshot, join(snapshot, 'payload'), join(snapshot, 'manifest.json'), join(snapshot, 'receipt.bin'), ...names.map(name => join(snapshot, 'payload', name))]
  const before = await identities(sources)
  const bytes = await boundedRead(join(snapshot, 'manifest.json'), INTEGRATION_SNAPSHOT_LIMITS.manifestBytes)
  assert(hash(bytes) === manifestSha256, 'Manifest SHA-256 mismatch')
  await mkdir(destination, { mode: 0o700 })
  await ensurePrivateDataDirectory(destination)
  await mkdir(join(destination, 'payload'), { mode: 0o700 })
  const copy = async (name: string, limit: number, length: number, sha256: string) => {
    const content = await boundedRead(join(snapshot, name), limit)
    assert(content.length === length && hash(content) === sha256, 'Source snapshot checksum mismatch during recovery')
    await writeExclusive(join(destination, name), content)
    assert((await boundedRead(join(destination, name), limit)).equals(content), 'Copied recovery data mismatch')
  }
  await copy('receipt.bin', INTEGRATION_SNAPSHOT_LIMITS.receiptBytes, manifest.receiptBytes, manifest.receiptSha256)
  for (const [index, item] of manifest.artifacts.entries()) if (item.bytes !== null) await copy(join('payload', `${index}.bin`), INTEGRATION_SNAPSHOT_LIMITS.artifactBytes, item.bytes, item.sha256!)
  await writeExclusive(join(destination, 'manifest.json'), bytes)
  await verifyIntegrationSnapshot({ snapshot: destination, manifestSha256, integration })
  await verifyIntegrationSnapshot({ snapshot, manifestSha256, integration })
  const after = await identities(sources)
  assert(before.every((s, index) => s !== undefined && after[index] !== undefined && same(s, after[index]!)), 'Source snapshot changed during recovery')
  assert((await boundedRead(join(snapshot, 'manifest.json'), INTEGRATION_SNAPSHOT_LIMITS.manifestBytes)).equals(bytes), 'Source manifest changed during recovery')
  return { destination, manifestSha256, manifest }
}
export async function verifyIntegrationSnapshot({ snapshot, manifestSha256, integration }: { snapshot: string; manifestSha256: string; integration: InstallOptions }): Promise<IntegrationSnapshotResult> {
  assert(typeof manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(manifestSha256), 'Expected external manifest SHA-256')
  describeNativeIntegration(integration)
  await canonical(snapshot)
  await exactDirectory(snapshot, ['manifest.json', 'receipt.bin', 'payload'])
  await canonical(join(snapshot, 'payload'))
  const rootBefore = await lstat(snapshot, { bigint: true }), payloadBefore = await lstat(join(snapshot, 'payload'), { bigint: true })
  const base = [snapshot, join(snapshot, 'payload'), join(snapshot, 'manifest.json'), join(snapshot, 'receipt.bin')]
  await windowsPrivate(base)
  const bytes = await boundedRead(join(snapshot, 'manifest.json'), INTEGRATION_SNAPSHOT_LIMITS.manifestBytes)
  assert(hash(bytes) === manifestSha256, 'Manifest SHA-256 mismatch')
  let manifest: IntegrationSnapshotManifest
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as IntegrationSnapshotManifest } catch { throw new Error('Invalid snapshot manifest encoding') }
  assert(encode(manifest).equals(bytes), 'Manifest must use canonical JSON and LF')
  const receipt = await boundedRead(join(snapshot, 'receipt.bin'), INTEGRATION_SNAPSHOT_LIMITS.receiptBytes)
  validate(manifest, receipt, integration)
  const canonicalManifest: IntegrationSnapshotManifest = { schemaVersion: 1, platform: manifest.platform, originalReceiptPath: manifest.originalReceiptPath, binding: manifest.binding, scope: SCOPE, receiptMode: manifest.receiptMode, receiptBytes: manifest.receiptBytes, receiptSha256: manifest.receiptSha256, artifacts: manifest.artifacts.map(item => ({ path: item.path, mode: item.mode, bytes: item.bytes, sha256: item.sha256 })) }
  assert(encode(canonicalManifest).equals(bytes), 'Manifest field order must be canonical')
  assert(protectedPaths({ receiptPath: manifest.originalReceiptPath, artifacts: manifest.artifacts.map(item => ({ path: item.path, bytes: undefined, mode: undefined })), binding: manifest.binding }).every(path => !overlaps(path, snapshot)), 'Snapshot overlaps protected source')
  const names = manifest.artifacts.flatMap((item, index) => item.bytes === null ? [] : [`${index}.bin`])
  await exactDirectory(join(snapshot, 'payload'), names)
  await windowsPrivate(names.map(name => join(snapshot, 'payload', name)))
  for (const [index, item] of manifest.artifacts.entries()) if (item.bytes !== null) {
    const payload = await boundedRead(join(snapshot, 'payload', `${index}.bin`), INTEGRATION_SNAPSHOT_LIMITS.artifactBytes)
    assert(payload.length === item.bytes && hash(payload) === item.sha256, 'Snapshot payload checksum mismatch')
  }
  await exactDirectory(join(snapshot, 'payload'), names)
  await exactDirectory(snapshot, ['manifest.json', 'receipt.bin', 'payload'])
  assert((await boundedRead(join(snapshot, 'manifest.json'), INTEGRATION_SNAPSHOT_LIMITS.manifestBytes)).equals(bytes) && (await boundedRead(join(snapshot, 'receipt.bin'), INTEGRATION_SNAPSHOT_LIMITS.receiptBytes)).equals(receipt), 'Snapshot changed during verification')
  assert(same(rootBefore, await lstat(snapshot, { bigint: true })) && same(payloadBefore, await lstat(join(snapshot, 'payload'), { bigint: true })), 'Snapshot directory changed during verification')
  return { snapshot, manifestSha256, manifest }
}
