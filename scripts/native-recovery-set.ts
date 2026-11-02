import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, opendirSync, realpathSync, type BigIntStats } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readExternalConfig, readPrivateConfigurationFile } from '../src/external-config.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
import { createConfigSnapshot, verifyConfigSnapshot } from './native-config-snapshot.ts'
import { createStateSnapshot, verifyStateSnapshot } from './native-state-snapshot.ts'
import { withStoppedDataScope } from './stopped-data-scope.ts'
import { verifyBundle, type Identity } from './update-native.ts'

/** Coordinated capture and verification only. Stop configuration editors, baseline
 * writers and every other non-cooperative writer before capture. Lifecycle locks
 * may prepare root permissions and create operational artifacts. Coherence is
 * conditional on these writer requirements, not a filesystem transaction.
 * Verification requires the original baseline bundle to remain available; original
 * configuration/data paths need not exist. Keep the aggregate digest separately.
 * Child operations retain their finite byte/entry/depth/deadline limits: this
 * wrapper makes a fixed number of calls, never an unbounded outer tree walk.
 * Files are fsynced, directories are not; no power-loss durability is promised.
 * Failures retain private partial output for inspection, without cleanup.
 */
const SCOPE = Object.freeze({ kind: 'coordinated-stopped-recovery-set', coherence: 'conditional-on-all-other-writers-stopped', writers: 'cooperative-lifecycle-locks-and-stopped-other-writers-required', activation: 'none', schemaCompatibility: 'not-asserted', externalFiles: 'not-captured', baselineBundle: 'not-copied-must-remain-available', powerLossDurability: 'not-asserted', sameAccountConcurrentMutation: 'out-of-scope' })
export interface RecoverySetManifest { schemaVersion: 1; baseline: Identity; sourceConfigFile: string; sourceDataDir: string; configManifestSha256: string; dataManifestSha256: string; scope: typeof SCOPE }
const MANIFEST = 'recovery-manifest.json'
const LIMIT = 16 * 1024
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const encode = (manifest: RecoverySetManifest) => Buffer.from(JSON.stringify(manifest) + '\n')
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
function hash(value: unknown): asserts value is string { assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Explicit trusted SHA-256 required') }
function absolute(path: string) {
  assert(typeof path === 'string' && Buffer.byteLength(path) <= 4096 && isAbsolute(path) && resolve(path) === path && !/[\x00-\x1f\ud800-\udfff]/u.test(path), 'Expected bounded canonical absolute path')
  if (process.platform === 'win32') assert(/^[a-z]:\\/i.test(path) && !path.slice(2).includes(':') && !path.includes('/') && path.slice(3).split('\\').every(p => !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)), 'Expected native Windows path without aliases')
}
function canonical(path: string) {
  absolute(path)
  for (let p = path; ; p = dirname(p)) {
    const s = lstatSync(p)
    assert(s.isDirectory() && !s.isSymbolicLink(), 'Expected existing directory without links')
    if (dirname(p) === p) break
  }
  assert(realpathSync.native(path) === path, 'Expected canonical existing directory')
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot
    assert(systemRoot && isAbsolute(systemRoot), 'Cannot locate Windows boundary checker')
    const script = String.raw`$ErrorActionPreference='Stop'; trap { exit 1 }
$p=$env:JARVIS_RECOVERY_BOUNDARY
while ($p) {
 $a=[IO.File]::GetAttributes($p)
 if (($a -band [IO.FileAttributes]::ReparsePoint) -or !($a -band [IO.FileAttributes]::Directory)) { exit 1 }
 $parent=[IO.Directory]::GetParent($p)
 if (!$parent) { break }; $p=$parent.FullName
}`
    try { execFileSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, JARVIS_RECOVERY_BOUNDARY: path }, windowsHide: true, timeout: 10_000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { throw new Error('Windows recovery directory boundary check failed') }
  }
}
function overlaps(a: string, b: string) {
  const below = (x: string, y: string) => { const r = relative(x, y); return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)) }
  return below(a, b) || below(b, a)
}
function separate(bundle: string, data: string, config: string, destination: string) {
  const sources = [bundle, data, dirname(config)]
  assert(!overlaps(bundle, data) && !overlaps(bundle, dirname(config)) && !overlaps(data, dirname(config)), 'Source directories must be disjoint')
  assert(sources.every(p => !overlaps(p, destination)), 'Recovery set overlaps protected source directory')
}
function fresh(destination: string) {
  absolute(destination); canonical(dirname(destination))
  try { lstatSync(destination); throw new Error('Destination already exists') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
}
function same(a: BigIntStats, b: BigIntStats, content = true) {
  assert(a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && (!content || (a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs)), 'Recovery source or root identity changed')
}
function inventory(root: string) {
  const dir = opendirSync(root), names: string[] = []
  try { for (let i = 0; i < 4; i++) { const e = dir.readSync(); if (!e) break; names.push(e.name) } } finally { dir.closeSync() }
  assert(names.sort().join(',') === 'config,data,recovery-manifest.json', 'Recovery set must contain exactly config, data and recovery-manifest.json')
}
function validated(raw: Buffer): RecoverySetManifest {
  let m: RecoverySetManifest
  try { m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) }
  catch { throw new Error('Invalid recovery manifest encoding or JSON') }
  assert(m && Object.keys(m).sort().join(',') === 'baseline,configManifestSha256,dataManifestSha256,schemaVersion,scope,sourceConfigFile,sourceDataDir', 'Invalid recovery manifest fields')
  assert(m.schemaVersion === 1 && JSON.stringify(m.scope) === JSON.stringify(SCOPE), 'Invalid recovery manifest schema or scope')
  absolute(m.sourceConfigFile); absolute(m.sourceDataDir); hash(m.configManifestSha256); hash(m.dataManifestSha256)
  const b = m.baseline
  assert(b && Object.keys(b).sort().join(',') === 'arch,manifestSha256,platform,root,runtime,sourceSha,version', 'Invalid baseline identity fields')
  absolute(b.root); hash(b.manifestSha256)
  assert(typeof b.version === 'string' && b.version.length <= 128 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(b.version) && typeof b.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(b.sourceSha) && b.platform === process.platform && b.arch === process.arch && typeof b.runtime === 'string' && b.runtime.length <= 128 && /^v24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(b.runtime), 'Invalid or incompatible baseline identity')
  const baseline: Identity = { root: b.root, manifestSha256: b.manifestSha256, version: b.version, sourceSha: b.sourceSha, platform: b.platform, arch: b.arch, runtime: b.runtime }
  const manifest: RecoverySetManifest = { schemaVersion: 1, baseline, sourceConfigFile: m.sourceConfigFile, sourceDataDir: m.sourceDataDir, configManifestSha256: m.configManifestSha256, dataManifestSha256: m.dataManifestSha256, scope: SCOPE }
  assert(raw.length <= LIMIT && encode(manifest).equals(raw), 'Recovery manifest must use bounded canonical JSON plus LF')
  return manifest
}
export async function createRecoverySet({ bundle, bundleManifestSha256, configFile, dataDir, destination }: { bundle: string; bundleManifestSha256: string; configFile: string; dataDir: string; destination: string }) {
  hash(bundleManifestSha256); canonical(bundle); canonical(dataDir); absolute(configFile); canonical(dirname(configFile))
  assert(realpathSync.native(configFile) === configFile, 'Expected canonical existing configuration file')
  const initialIdentity = lstatSync(configFile, { bigint: true }), initial = readExternalConfig(configFile)
  same(initialIdentity, lstatSync(configFile, { bigint: true }))
  assert(initial.values.JARVIS_DATA_DIR === dataDir, 'Configuration data directory mismatch')
  separate(bundle, dataDir, configFile, destination); fresh(destination)
  const dataIdentity = lstatSync(dataDir, { bigint: true })
  return withStoppedDataScope(dataDir, async scope => {
    const baseline = await verifyBundle(bundle, bundleManifestSha256)
    const unchanged = () => {
      assert(readExternalConfig(configFile).bytes.equals(initial.bytes), 'Configuration changed during recovery capture')
      same(initialIdentity, lstatSync(configFile, { bigint: true }))
      const now = lstatSync(dataDir, { bigint: true })
      assert(now.isDirectory() && now.dev === dataIdentity.dev && now.ino === dataIdentity.ino, 'Data directory identity changed')
    }
    // Prove aggregate metadata fits before creating output, even for long paths.
    validated(encode({ schemaVersion: 1, baseline, sourceConfigFile: configFile, sourceDataDir: dataDir, configManifestSha256: '0'.repeat(64), dataManifestSha256: '0'.repeat(64), scope: SCOPE }))
    unchanged(); fresh(destination)
    await mkdir(destination, { mode: 0o700 }); await ensurePrivateDataDirectory(destination)
    const rootIdentity = lstatSync(destination, { bigint: true })
    const config = await createConfigSnapshot({ configFile, dataDir, destination: join(destination, 'config'), scope })
    const data = await createStateSnapshot({ dataDir, destination: join(destination, 'data'), scope })
    const checkedConfig = await verifyConfigSnapshot({ snapshot: config.snapshot, manifestSha256: config.manifestSha256 })
    const checkedData = await verifyStateSnapshot({ snapshot: data.snapshot, manifestSha256: data.manifestSha256 })
    assert(checkedConfig.manifest.sourceConfigFile === configFile && checkedConfig.manifest.dataDir === dataDir && checkedData.manifest.sourceDataDir === dataDir, 'Child source path mismatch')
    assert(JSON.stringify(await verifyBundle(bundle, bundleManifestSha256)) === JSON.stringify(baseline), 'Baseline identity changed')
    unchanged(); same(rootIdentity, lstatSync(destination, { bigint: true }), false)
    const manifest: RecoverySetManifest = { schemaVersion: 1, baseline, sourceConfigFile: configFile, sourceDataDir: dataDir, configManifestSha256: config.manifestSha256, dataManifestSha256: data.manifestSha256, scope: SCOPE }
    const raw = encode(manifest); validated(raw)
    const file = await open(join(destination, MANIFEST), 'wx', 0o600)
    try { await file.writeFile(raw); await file.sync() } finally { await file.close() }
    inventory(destination)
    return { recoverySet: destination, manifestSha256: digest(raw), manifest }
  })
}
export async function verifyRecoverySet({ recoverySet, manifestSha256 }: { recoverySet: string; manifestSha256: string }) {
  hash(manifestSha256); canonical(recoverySet)
  const before = lstatSync(recoverySet, { bigint: true }); inventory(recoverySet)
  const raw = readPrivateConfigurationFile(join(recoverySet, MANIFEST), LIMIT)
  assert(digest(raw) === manifestSha256, 'Recovery manifest digest mismatch')
  const manifest = validated(raw)
  separate(manifest.baseline.root, manifest.sourceDataDir, manifest.sourceConfigFile, recoverySet)
  canonical(join(recoverySet, 'config')); canonical(join(recoverySet, 'data')); canonical(manifest.baseline.root)
  const config = await verifyConfigSnapshot({ snapshot: join(recoverySet, 'config'), manifestSha256: manifest.configManifestSha256 })
  const data = await verifyStateSnapshot({ snapshot: join(recoverySet, 'data'), manifestSha256: manifest.dataManifestSha256 })
  assert(config.manifest.sourceConfigFile === manifest.sourceConfigFile && config.manifest.dataDir === manifest.sourceDataDir && data.manifest.sourceDataDir === manifest.sourceDataDir, 'Child source path mismatch')
  assert(JSON.stringify(await verifyBundle(manifest.baseline.root, manifest.baseline.manifestSha256)) === JSON.stringify(manifest.baseline), 'Baseline identity mismatch')
  assert(readPrivateConfigurationFile(join(recoverySet, MANIFEST), LIMIT).equals(raw), 'Recovery manifest changed during verification')
  inventory(recoverySet); same(before, lstatSync(recoverySet, { bigint: true }))
  return { recoverySet, manifestSha256, manifest }
}
