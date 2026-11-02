import { createHash } from 'node:crypto'
import { lstatSync, realpathSync, opendirSync, type BigIntStats } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readExternalConfig, readPrivateConfigurationFile } from '../src/external-config.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
import { withStoppedDataScope, withScopeOperation, type StoppedDataScope } from './stopped-data-scope.ts'

/** Prerequisite config-only copy, never activation or a unified data backup.
 * Stop all configuration editors and other writers first: they do not participate
 * in lifecycle locks. Those locks perform their normal permission preflight and
 * write operational SQLite artifacts, but no application data is copied/changed.
 * Same-account malicious races and power-loss durability are outside this scope.
 * Preserve the returned manifest digest separately in a trusted location.
 */
const SCOPE = Object.freeze({ kind: 'config-only', writers: 'stopped-writers-required', data: 'not-included', externalFiles: 'not-included', activation: 'none', unifiedDataAtomicity: 'not-asserted' })
export interface ConfigSnapshotManifest { schemaVersion: 1; sourceConfigFile: string; dataDir: string; bytes: number; sha256: string; scope: typeof SCOPE }
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const encode = (manifest: ConfigSnapshotManifest) => Buffer.from(JSON.stringify(manifest) + '\n')
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
function absolute(path: string) { assert(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !path.includes('\0'), 'Expected canonical absolute path') }
function canonical(path: string) {
  absolute(path)
  for (let p = path; ; p = dirname(p)) {
    const s = lstatSync(p)
    assert(s.isDirectory() && !s.isSymbolicLink(), 'Expected existing directory without aliases or links')
    if (dirname(p) === p) break
  }
  assert(realpathSync(path) === path, 'Expected canonical directory')
}
function overlaps(a: string, b: string) {
  const below = (x: string, y: string) => { const r = relative(x, y); return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)) }
  return below(a, b) || below(b, a)
}
function fresh(destination: string, protectedPaths: string[]) {
  absolute(destination); canonical(dirname(destination))
  assert(protectedPaths.every(p => !overlaps(p, destination)), 'Destination overlaps protected directory')
  try { lstatSync(destination); throw new Error('Destination already exists') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
function same(a: BigIntStats, b: BigIntStats) {
  assert(a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs, 'Configuration identity changed')
}
function privateMode(file: string, directory = false) {
  const stat = lstatSync(file, { bigint: true })
  assert(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n, 'Invalid snapshot entry')
  if (process.platform !== 'win32') assert(stat.uid === BigInt(process.getuid!()) && (stat.mode & 0o777n) === (directory ? 0o700n : 0o600n), 'Snapshot permissions must remain private')
}
async function createDirectory(destination: string) {
  await mkdir(destination, { mode: 0o700 })
  await ensurePrivateDataDirectory(destination)
}
async function writeExclusive(file: string, bytes: Buffer) {
  const handle = await open(file, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}
function validatedManifest(bytes: Buffer): ConfigSnapshotManifest {
  let m: ConfigSnapshotManifest
  try { m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as ConfigSnapshotManifest }
  catch { throw new Error('Invalid manifest encoding or JSON') }
  assert(m && Object.keys(m).sort().join(',') === 'bytes,dataDir,schemaVersion,scope,sha256,sourceConfigFile', 'Invalid manifest fields')
  assert(m.schemaVersion === 1 && Number.isSafeInteger(m.bytes) && m.bytes > 0 && m.bytes <= 65536 && typeof m.sha256 === 'string' && /^[a-f0-9]{64}$/.test(m.sha256), 'Invalid manifest metadata')
  absolute(m.sourceConfigFile); absolute(m.dataDir)
  assert(JSON.stringify(m.scope) === JSON.stringify(SCOPE), 'Invalid manifest scope')
  const canonicalManifest: ConfigSnapshotManifest = { schemaVersion: 1, sourceConfigFile: m.sourceConfigFile, dataDir: m.dataDir, bytes: m.bytes, sha256: m.sha256, scope: SCOPE }
  assert(encode(canonicalManifest).equals(bytes), 'Manifest encoding is not canonical')
  return canonicalManifest
}
function inspectSnapshot(snapshot: string, manifestSha256: string) {
  assert(typeof manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(manifestSha256), 'Trusted manifest SHA-256 required')
  canonical(snapshot); privateMode(snapshot, true)
  const before = lstatSync(snapshot, { bigint: true })
  const directory = opendirSync(snapshot), names: string[] = []
  try {
    for (let i = 0; i < 3; i++) { const entry = directory.readSync(); if (!entry) break; names.push(entry.name) }
  } finally { directory.closeSync() }
  assert(names.sort().join(',') === 'config.env,manifest.json', 'Snapshot must contain exactly config.env and manifest.json')
  const manifestFile = join(snapshot, 'manifest.json'), configFile = join(snapshot, 'config.env')
  privateMode(manifestFile); privateMode(configFile)
  const raw = readPrivateConfigurationFile(manifestFile, 16384)
  assert(digest(raw) === manifestSha256, 'Manifest digest mismatch')
  const manifest = validatedManifest(raw)
  assert(!overlaps(snapshot, dirname(manifest.sourceConfigFile)) && !overlaps(snapshot, manifest.dataDir), 'Snapshot overlaps protected directory')
  const { bytes, values } = readExternalConfig(configFile)
  assert(values.JARVIS_DATA_DIR === manifest.dataDir, 'Configuration data directory mismatch')
  assert(bytes.length === manifest.bytes && digest(bytes) === manifest.sha256, 'Configuration digest mismatch')
  same(before, lstatSync(snapshot, { bigint: true }))
  return { manifest, bytes }
}
export function createConfigSnapshot({ configFile, dataDir, destination, scope }: { configFile: string; dataDir: string; destination: string; scope?: StoppedDataScope }) {
  let initial: ReturnType<typeof readExternalConfig>
  function preflight() {
    canonical(dataDir)
    initial = readExternalConfig(configFile)
    canonical(initial.values.JARVIS_DATA_DIR)
    assert(initial.values.JARVIS_DATA_DIR === dataDir, 'Configuration data directory mismatch')
    assert(!overlaps(dirname(configFile), dataDir), 'Configuration private parent must be separate from data directory')
    fresh(destination, [dirname(configFile), dataDir])
  }
  async function copy() {
    const before = lstatSync(configFile, { bigint: true })
    const source = readExternalConfig(configFile)
    assert(source.bytes.equals(initial.bytes), 'Configuration changed before copy')
    fresh(destination, [dirname(configFile), dataDir])
    await createDirectory(destination)
    await writeExclusive(join(destination, 'config.env'), source.bytes)
    const copied = readExternalConfig(join(destination, 'config.env'))
    assert(copied.bytes.equals(source.bytes), 'Copied configuration changed')
    same(before, lstatSync(configFile, { bigint: true }))
    assert(readExternalConfig(configFile).bytes.equals(source.bytes), 'Configuration changed during copy')
    same(before, lstatSync(configFile, { bigint: true }))
    const manifest: ConfigSnapshotManifest = { schemaVersion: 1, sourceConfigFile: configFile, dataDir, bytes: source.bytes.length, sha256: digest(source.bytes), scope: SCOPE }
    const raw = encode(manifest)
    assert(raw.length <= 16384, 'Manifest exceeds size bound')
    await writeExclusive(join(destination, 'manifest.json'), raw)
    const manifestSha256 = digest(raw)
    inspectSnapshot(destination, manifestSha256)
    assert(readExternalConfig(configFile).bytes.equals(source.bytes), 'Configuration changed before completion')
    same(before, lstatSync(configFile, { bigint: true }))
    return { snapshot: destination, manifestSha256, manifest }
  }
  if (scope !== undefined) return withScopeOperation(scope, dataDir, async () => { preflight(); return copy() })
  return (async () => {
    preflight()
    return withStoppedDataScope(dataDir, owned => withScopeOperation(owned, dataDir, copy))
  })()
}
export async function verifyConfigSnapshot({ snapshot, manifestSha256 }: { snapshot: string; manifestSha256: string }) {
  const { manifest } = inspectSnapshot(snapshot, manifestSha256)
  return { snapshot, manifestSha256, manifest }
}
export async function restoreConfigSnapshot({ snapshot, manifestSha256, destination }: { snapshot: string; manifestSha256: string; destination: string }) {
  const { manifest, bytes } = inspectSnapshot(snapshot, manifestSha256)
  fresh(destination, [snapshot, dirname(manifest.sourceConfigFile), manifest.dataDir])
  await createDirectory(destination)
  await writeExclusive(join(destination, 'config.env'), bytes)
  assert(readExternalConfig(join(destination, 'config.env')).bytes.equals(bytes), 'Restored configuration changed')
  inspectSnapshot(snapshot, manifestSha256)
  return { destination, manifestSha256, manifest }
}
