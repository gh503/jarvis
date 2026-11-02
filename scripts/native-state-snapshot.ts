import { constants, type BigIntStats } from 'node:fs'
import { lstat, realpath, mkdir, open, opendir, rename, type FileHandle } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'

/** Raw stopped-state copies, not logical backups or a schema compatibility promise.
 * Only dataDir is covered; external configuration and files are out of scope.
 * The existing private-directory baseline is trusted: its ACL preparation may
 * intentionally mutate root permissions. This is not an OS sandbox against
 * malicious same-account concurrent mutation. fsync of individual files does
 * not promise power-loss atomicity/durability across the whole snapshot.
 * Keep the returned manifest digest separately in a trusted location.
 */
export const STATE_SNAPSHOT_LIMITS = Object.freeze({ depth: 64, files: 100_000, totalBytes: 64 * 1024 ** 3, fileBytes: 16 * 1024 ** 3, manifestBytes: 16 * 1024 ** 2, chunkBytes: 1024 ** 2, deadlineMs: 300_000 })
const MANIFEST = 'snapshot-manifest.json'
const EXCLUDED = Object.freeze(['launcher.lock.sqlite', 'launcher.lock.sqlite-journal', 'launcher.lock.sqlite-shm', 'launcher.lock.sqlite-wal', 'runtime-instance.json', 'runtime.lock.sqlite', 'runtime.lock.sqlite-journal', 'runtime.lock.sqlite-shm', 'runtime.lock.sqlite-wal'])
const SCOPE = Object.freeze({ kind: 'complete-stopped-data-directory', writers: 'cooperative-lifecycle-locks-and-stable-tree-required', externalConfiguration: 'out-of-scope', schemaCompatibility: 'not-asserted', powerLossDurability: 'not-asserted', sameAccountConcurrentMutation: 'out-of-scope' })
interface Entry { path: string; bytes: number; sha256: string }
export interface StateSnapshotManifest { schemaVersion: 1; sourceDataDir: string; createdAt: string; scope: typeof SCOPE; excluded: string[]; directories: string[]; files: Entry[] }
interface Context { deadline: number }
const context = (): Context => ({ deadline: performance.now() + STATE_SNAPSHOT_LIMITS.deadlineMs })
function check(ctx: Context) { if (performance.now() > ctx.deadline) throw new Error('State snapshot deadline exceeded') }
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
function identity(a: BigIntStats, b: BigIntStats, content = true) {
  assert(a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink && (!content || (a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs)), 'Filesystem identity changed')
}
function privateMode(s: BigIntStats) {
  if (process.platform !== 'win32') assert(s.uid === BigInt(process.getuid!()) && (s.mode & 0o777n) === (s.isDirectory() ? 0o700n : 0o600n), 'Snapshot permissions must remain private')
}
function regular(s: BigIntStats) { assert(s.isFile() && !s.isSymbolicLink() && s.nlink === 1n, 'Expected regular file without links') }
async function canonical(path: string, ctx: Context) {
  check(ctx)
  assert(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !path.includes('\0'), 'Expected canonical absolute path')
  for (let cursor = path; ; cursor = dirname(cursor)) {
    check(ctx)
    const s = await lstat(cursor, { bigint: true })
    assert(s.isDirectory() && !s.isSymbolicLink(), 'Directory boundary cannot contain links')
    if (dirname(cursor) === cursor) break
  }
  assert(await realpath(path) === path, 'Expected canonical existing directory')
}
function overlaps(a: string, b: string) {
  const below = (x: string, y: string) => { const r = relative(x, y); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)) }
  return below(a, b) || below(b, a)
}
async function fresh(path: string, separate: string[], ctx: Context) {
  assert(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !path.includes('\0'), 'Expected canonical absolute destination')
  await canonical(dirname(path), ctx)
  assert(separate.every(root => !overlaps(root, path)), 'Destination overlaps protected directory')
  try { await lstat(path); throw new Error('Destination already exists') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
}
function safePath(path: string) {
  assert(typeof path === 'string' && path.length > 0 && Buffer.byteLength(path) <= 4096 && path.split('/').length <= STATE_SNAPSHOT_LIMITS.depth, 'Invalid path or depth limit')
  for (const part of path.split('/')) {
    assert(part && Buffer.byteLength(part) <= 255 && part !== '.' && part !== '..' && !/[\\:<>"|?*\x00-\x1f\x7f-\x9f]/u.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part), 'Unsafe cross-platform path')
    assert(!/[\ud800-\udfff]/u.test(part), 'Invalid Unicode path')
  }
}
// Uppercase then lowercase also folds sharp-s and final sigma; NFD catches
// canonically equivalent macOS names. Conservative collisions fail closed.
const pathKey = (path: string) => path.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD')
async function transfer(source: string, destination: string | undefined, ctx: Context, cap = STATE_SNAPSHOT_LIMITS.fileBytes, collect = false) {
  check(ctx)
  const before = await lstat(source, { bigint: true }); regular(before)
  assert(before.size <= BigInt(cap), 'File size limit exceeded')
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  let output: FileHandle | undefined
  const hash = createHash('sha256'), chunks: Buffer[] = []
  let bytes = 0
  try {
    identity(before, await input.stat({ bigint: true }))
    if (destination) output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    const outputBefore = output ? await output.stat({ bigint: true }) : undefined
    if (outputBefore) regular(outputBefore)
    const buffer = Buffer.alloc(STATE_SNAPSHOT_LIMITS.chunkBytes)
    while (true) {
      check(ctx)
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      bytes += bytesRead
      assert(bytes <= cap && BigInt(bytes) <= before.size, 'File size changed or limit exceeded')
      const chunk = buffer.subarray(0, bytesRead); hash.update(chunk)
      if (collect) chunks.push(Buffer.from(chunk))
      if (output) for (let offset = 0; offset < bytesRead;) {
        check(ctx)
        const result = await output.write(chunk, offset, bytesRead - offset, null)
        assert(result.bytesWritten > 0, 'Short file write'); offset += result.bytesWritten
      }
    }
    assert(BigInt(bytes) === before.size, 'File truncated during read')
    identity(before, await input.stat({ bigint: true })); identity(before, await lstat(source, { bigint: true }))
    if (output && outputBefore) {
      await output.sync()
      const after = await output.stat({ bigint: true }); regular(after)
      identity(outputBefore, after, false); identity(after, await lstat(destination!, { bigint: true }))
      assert(after.size === BigInt(bytes), 'Copied file size changed')
    }
    return { bytes, sha256: hash.digest('hex'), buffer: collect ? Buffer.concat(chunks) : undefined }
  } finally { await output?.close(); await input.close() }
}
interface Tree { directories: string[]; files: Entry[] }
async function walk(root: string, ctx: Context, options: { copyTo?: string; exclude?: boolean; privateTree?: boolean } = {}): Promise<Tree> {
  const tree: Tree = { directories: [], files: [] }, seen = new Set<string>()
  let total = 0, entries = 0
  async function visit(dir: string, prefix: string) {
    check(ctx)
    const before = await lstat(dir, { bigint: true })
    assert(before.isDirectory() && !before.isSymbolicLink(), 'Expected directory without links')
    if (options.privateTree) privateMode(before)
    const handle = await opendir(dir, { encoding: 'buffer' as BufferEncoding })
    try {
      while (true) {
        check(ctx)
        const entry = await handle.read(); if (!entry) break
        const raw = entry.name as unknown as Buffer
        const name = Buffer.isBuffer(raw) ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : String(raw)
        const path = prefix ? `${prefix}/${name}` : name
        safePath(path)
        assert(++entries <= STATE_SNAPSHOT_LIMITS.files, 'Tree entry limit exceeded')
        const key = pathKey(path); assert(!seen.has(key), 'Path collision'); seen.add(key)
        const full = join(root, ...path.split('/'))
        const stat = await lstat(full, { bigint: true })
        assert(!stat.isSymbolicLink(), 'Links are forbidden')
        if (options.privateTree) privateMode(stat)
        if (options.exclude && !prefix && EXCLUDED.includes(name)) { regular(stat); continue }
        if (stat.isDirectory()) {
          tree.directories.push(path)
          if (options.copyTo) await mkdir(join(options.copyTo, ...path.split('/')), { mode: 0o700 })
          await visit(full, path)
          identity(stat, await lstat(full, { bigint: true }))
        } else {
          regular(stat)
          total += Number(stat.size)
          assert(total <= STATE_SNAPSHOT_LIMITS.totalBytes, 'Total byte limit exceeded')
          const value = await transfer(full, options.copyTo ? join(options.copyTo, ...path.split('/')) : undefined, ctx)
          identity(stat, await lstat(full, { bigint: true }))
          tree.files.push({ path, bytes: value.bytes, sha256: value.sha256 })
        }
      }
    } finally { await handle.close() }
    identity(before, await lstat(dir, { bigint: true }))
  }
  await visit(root, '')
  tree.directories.sort(); tree.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return tree
}
function encode(manifest: StateSnapshotManifest) { return Buffer.from(JSON.stringify(manifest) + '\n') }
function validateManifest(value: unknown): asserts value is StateSnapshotManifest {
  const m = value as StateSnapshotManifest
  assert(m && m.schemaVersion === 1 && typeof m.sourceDataDir === 'string' && (isAbsolute(m.sourceDataDir) || /^[A-Za-z]:\\/.test(m.sourceDataDir)) && typeof m.createdAt === 'string' && Number.isFinite(Date.parse(m.createdAt)), 'Invalid manifest metadata')
  assert(JSON.stringify(m.scope) === JSON.stringify(SCOPE) && JSON.stringify(m.excluded) === JSON.stringify(EXCLUDED), 'Invalid manifest scope or exclusions')
  assert(Array.isArray(m.directories) && Array.isArray(m.files) && m.directories.length + m.files.length <= STATE_SNAPSHOT_LIMITS.files, 'Invalid manifest inventory limit')
  assert(Object.keys(m).sort().join(',') === 'createdAt,directories,excluded,files,schemaVersion,scope,sourceDataDir', 'Unexpected manifest fields')
  const seen = new Set<string>(), dirs = new Set(m.directories)
  let total = 0
  for (const path of [...m.directories, ...m.files.map(f => f?.path)]) {
    safePath(path); const key = pathKey(path); assert(!seen.has(key), 'Manifest path collision'); seen.add(key)
    assert(!EXCLUDED.includes(path), 'Manifest includes ownership ephemeral')
    const parts = path.split('/'); parts.pop()
    if (parts.length) assert(dirs.has(parts.join('/')), 'Missing parent directory')
  }
  for (const f of m.files) {
    assert(Object.keys(f).sort().join(',') === 'bytes,path,sha256' && Number.isSafeInteger(f.bytes) && f.bytes >= 0 && f.bytes <= STATE_SNAPSHOT_LIMITS.fileBytes && /^[a-f0-9]{64}$/.test(f.sha256), 'Invalid file entry or size limit')
    total += f.bytes
  }
  assert(total <= STATE_SNAPSHOT_LIMITS.totalBytes, 'Manifest total byte limit exceeded')
  assert(JSON.stringify(m.directories) === JSON.stringify([...m.directories].sort()) && m.files.every((f, i) => i === 0 || m.files[i - 1]!.path < f.path), 'Unsorted manifest')
}
function compare(actual: Tree, expected: Tree) {
  assert(JSON.stringify(actual.directories) === JSON.stringify(expected.directories) && JSON.stringify(actual.files) === JSON.stringify(expected.files), 'Snapshot payload mismatch (missing, extra, or changed entries)')
}
// Read-only Windows reparse preflight: unlike permission preparation this never
// rewrites the snapshot ACL. Literal paths travel only through the environment.
async function windowsBoundaries(root: string, ctx: Context, privateTree = false) {
  if (process.platform !== 'win32') return
  const systemRoot = process.env.SystemRoot
  assert(systemRoot && isAbsolute(systemRoot), 'Cannot locate Windows boundary checker')
  const script = String.raw`$ErrorActionPreference='Stop'
$env:PSModulePath="$PSHOME\Modules"
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$p=$env:JARVIS_SNAPSHOT_ROOT
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
function Check-Private($path) {
 if ($env:JARVIS_SNAPSHOT_PRIVATE -ne '1') { return }
 $acl=Get-Acl -LiteralPath $path
 if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Untrusted owner' }
 $full=$false
 $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -notin @($user.Value,'S-1-5-18','S-1-5-32-544') -or $rule.AccessControlType -ne 'Allow') { throw 'Shared ACL' }
  if ($rule.IdentityReference.Value -eq $user.Value -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl -and !($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { $full=$true }
 }
 if (!$full) { throw 'Missing private access' }
}
Check-Private $p
$c=$p
while ($c) {
 $a=[IO.File]::GetAttributes($c)
 if (($a -band [IO.FileAttributes]::ReparsePoint) -or !($a -band [IO.FileAttributes]::Directory)) { throw 'Unsafe boundary' }
 $parent=[IO.Directory]::GetParent($c)
 if (!$parent) { break }; $c=$parent.FullName
}
$q=New-Object 'Collections.Generic.Queue[string]'
$q.Enqueue($p); $count=0
while ($q.Count) {
 $d=$q.Dequeue()
 foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($d)) {
  $count++; if ($count -gt 100002) { throw 'Entry limit' }
  $a=[IO.File]::GetAttributes($child)
  if ($a -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }
  Check-Private $child
  if ($a -band [IO.FileAttributes]::Directory) { $q.Enqueue($child) }
 }
}`
  check(ctx)
  try {
    await promisify(execFile)(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, JARVIS_SNAPSHOT_ROOT: root, JARVIS_SNAPSHOT_PRIVATE: privateTree ? '1' : '0' }, windowsHide: true, timeout: Math.max(1, Math.min(30_000, ctx.deadline - performance.now())), maxBuffer: 65536 })
  } catch { throw new Error('Windows snapshot boundary or private permission check failed') }
}
async function verify(snapshot: string, manifestSha256: string, ctx: Context) {
  assert(typeof manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(manifestSha256), 'Explicit trusted manifest SHA256 required')
  await canonical(snapshot, ctx)
  await windowsBoundaries(snapshot, ctx, true)
  const rootBefore = await lstat(snapshot, { bigint: true }); privateMode(rootBefore)
  privateMode(await lstat(join(snapshot, MANIFEST), { bigint: true }))
  const root = await opendir(snapshot)
  const names: string[] = []
  try { while (true) { check(ctx); const e = await root.read(); if (!e) break; names.push(e.name); assert(names.length <= 2, 'Extra snapshot root entry') } } finally { await root.close() }
  assert(names.sort().join(',') === `payload,${MANIFEST}`, 'Invalid snapshot root inventory')
  const raw = await transfer(join(snapshot, MANIFEST), undefined, ctx, STATE_SNAPSHOT_LIMITS.manifestBytes, true)
  assert(raw.sha256 === manifestSha256, 'Manifest digest mismatch')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw.buffer!)
  const manifest: unknown = JSON.parse(text); validateManifest(manifest)
  assert(encode(manifest).equals(raw.buffer!), 'Manifest must use canonical encoding without duplicate keys')
  compare(await walk(join(snapshot, 'payload'), ctx, { privateTree: true }), manifest)
  identity(rootBefore, await lstat(snapshot, { bigint: true }))
  return { snapshot, manifestSha256, manifest }
}
export async function verifyStateSnapshot(options: { snapshot: string; manifestSha256: string }) {
  return verify(options.snapshot, options.manifestSha256, context())
}
export async function createStateSnapshot({ dataDir, destination }: { dataDir: string; destination: string }) {
  const ctx = context()
  // Validate before the lifecycle helper, whose normal startup API creates roots.
  await canonical(dataDir, ctx)
  await fresh(destination, [dataDir], ctx)
  await ensurePrivateDataDirectory(dataDir)
  await windowsBoundaries(dataDir, ctx)
  // Reject hard-linked lock databases before SQLite can modify them. The walk
  // also rejects unsafe non-lock entries before lifecycle acquisition.
  await walk(dataDir, ctx, { exclude: true })
  const releaseLauncher = await acquireLifecycleLock(dataDir, 'launcher', 0)
  try {
    const releaseRuntime = await acquireLifecycleLock(dataDir, 'runtime', 0)
    try {
      check(ctx)
      await fresh(destination, [dataDir], ctx)
      await mkdir(destination, { mode: 0o700 })
      await ensurePrivateDataDirectory(destination)
      const payload = join(destination, 'payload'); await mkdir(payload, { mode: 0o700 })
      const inventory = await walk(dataDir, ctx, { copyTo: payload, exclude: true })
      compare(await walk(dataDir, ctx, { exclude: true }), inventory)
      compare(await walk(payload, ctx), inventory)
      const manifest: StateSnapshotManifest = { schemaVersion: 1, sourceDataDir: dataDir, createdAt: new Date().toISOString(), scope: SCOPE, excluded: [...EXCLUDED], ...inventory }
      validateManifest(manifest)
      const bytes = encode(manifest); assert(bytes.length <= STATE_SNAPSHOT_LIMITS.manifestBytes, 'Manifest size limit exceeded')
      check(ctx)
      // Commit last. Failures deliberately leave private partial data in place;
      // no cleanup deletes evidence and no manifest is created before verification.
      const pending = join(destination, '.snapshot-manifest.pending')
      const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        const before = await file.stat({ bigint: true }); regular(before)
        for (let offset = 0; offset < bytes.length;) {
          check(ctx)
          const result = await file.write(bytes, offset, Math.min(STATE_SNAPSHOT_LIMITS.chunkBytes, bytes.length - offset), null)
          assert(result.bytesWritten > 0, 'Short manifest write'); offset += result.bytesWritten
        }
        await file.sync()
        const after = await file.stat({ bigint: true }); identity(before, after, false); identity(after, await lstat(pending, { bigint: true }))
      } finally { await file.close() }
      check(ctx)
      await rename(pending, join(destination, MANIFEST))
      return { snapshot: destination, manifestSha256: createHash('sha256').update(bytes).digest('hex'), manifest }
    } finally { releaseRuntime() }
  } finally { releaseLauncher() }
}
export async function restoreStateSnapshot({ snapshot, manifestSha256, destination }: { snapshot: string; manifestSha256: string; destination: string }) {
  const ctx = context()
  const verified = await verify(snapshot, manifestSha256, ctx)
  await fresh(destination, [snapshot, verified.manifest.sourceDataDir], ctx)
  await mkdir(destination, { mode: 0o700 })
  await ensurePrivateDataDirectory(destination)
  compare(await walk(join(snapshot, 'payload'), ctx, { copyTo: destination }), verified.manifest)
  compare(await walk(destination, ctx), verified.manifest)
  return { destination, manifestSha256, manifest: verified.manifest }
}
