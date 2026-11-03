#!/usr/bin/env node
/** Per-user integrations only: the verified portable package stays in place. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PROPERTY_STORE_TYPES, WINDOWS_AUMID } from '../src/windows-notification.ts'
import { loadExternalConfig } from '../src/external-config.ts'
import { withNativeInstallLock } from './native-install-lock.ts'

export type Platform = 'darwin' | 'win32'
export interface InstallOptions {
  platform: Platform
  root: string
  home: string
  appData?: string
  localAppData?: string
  arch: string
  runPowerShell?: (script: string, env: NodeJS.ProcessEnv) => void
}
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
export function parseArgs(args: string[]): { action: 'install' | 'uninstall'; autostart: boolean; configFile?: string } {
  const usage = () => new Error('Usage: install-native.ts --install [--autostart] [--config ABS] | --uninstall')
  const flags = new Set<string>()
  let configFile: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (!['--install', '--uninstall', '--autostart', '--config'].includes(arg) || flags.has(arg)) throw usage()
    flags.add(arg)
    if (arg === '--config') {
      configFile = args[++index]
      if (!configFile || !isAbsolute(configFile) || /[\0\r\n]/.test(configFile)) throw usage()
    }
  }
  if (flags.has('--install') === flags.has('--uninstall') || (flags.has('--uninstall') && (flags.has('--autostart') || flags.has('--config')))) throw usage()
  return { action: flags.has('--install') ? 'install' : 'uninstall', autostart: flags.has('--autostart'), ...(configFile === undefined ? {} : { configFile }) }
}
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export function windowsQuote(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'
}
export function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) throw new Error('Path contains an XML control character')
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}
const plist = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`

/** Checks all declared payload bytes without running the bundled executable. */
export async function validatePackage(root: string, platform: Platform, arch: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.platform !== platform || manifest.arch !== arch || !/^v24\./.test(manifest.runtime?.version ?? '') || manifest.runtime.platform !== platform || manifest.runtime.arch !== arch || !Array.isArray(manifest.files)) throw new Error('Incompatible portable package manifest')
  const paths = new Set<string>()
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.includes(':') || entry.path.split('/').some((part: string) => !part || part === '.' || part === '..') || isAbsolute(entry.path) || paths.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Unsafe package manifest entry')
    paths.add(entry.path)
    let target = root
    for (const part of entry.path.split('/')) {
      target = join(target, part)
      if ((await lstat(target)).isSymbolicLink()) throw new Error(`Package symlink rejected: ${entry.path}`)
    }
    const info = await lstat(target)
    if (!info.isFile() || info.size !== entry.bytes || digest(await readFile(target)) !== entry.sha256) throw new Error(`Package checksum mismatch: ${entry.path}`)
  }
  for (const required of [`runtime/${platform === 'win32' ? 'node.exe' : 'node'}`, 'scripts/app.ts', 'scripts/install-native.ts', 'src/main.ts']) {
    if (!paths.has(required)) throw new Error(`Package manifest missing ${required}`)
  }
}

// Fixed code only. Paths and argv are passed as environment data, never interpolated.
export const POWERSHELL_LINK = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = 'load Unicode shell-link API'
try {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
${PROPERTY_STORE_TYPES}
[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
class JarvisShellLink {}
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface JarvisShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr data, uint flags);
  void GetIDList(out IntPtr id);
  void SetIDList(IntPtr id);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int count);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string path);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int count);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string text);
  void GetHotkey(out short key);
  void SetHotkey(short key);
  void GetShowCmd(out int command);
  void SetShowCmd(int command);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, out int index);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
  void Resolve(IntPtr window, uint flags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
}
public static class JarvisShortcut {
  public static void Save(string destination, string target, string arguments, string directory) {
    object instance = new JarvisShellLink();
    try {
      var link = (JarvisShellLinkW)instance;
      link.SetPath(target);
      link.SetArguments(arguments);
      link.SetWorkingDirectory(directory);
      link.SetDescription("Jarvis portable per-user launcher");
      JarvisIdentity.Set(instance);
      ((IPersistFile)instance).Save(destination, true);
    } finally { Marshal.FinalReleaseComObject(instance); }
    object verification = new JarvisShellLink();
    try {
      ((IPersistFile)verification).Load(destination, 0);
      var saved = (JarvisShellLinkW)verification;
      var actualTarget = new StringBuilder(32768);
      var actualArguments = new StringBuilder(32768);
      var actualDirectory = new StringBuilder(32768);
      saved.GetPath(actualTarget, actualTarget.Capacity, IntPtr.Zero, 4);
      saved.GetArguments(actualArguments, actualArguments.Capacity);
      saved.GetWorkingDirectory(actualDirectory, actualDirectory.Capacity);
      if (!String.Equals(actualTarget.ToString(), target, StringComparison.OrdinalIgnoreCase)
          || !String.Equals(actualDirectory.ToString(), directory, StringComparison.OrdinalIgnoreCase)
          || !String.Equals(actualArguments.ToString(), arguments, StringComparison.Ordinal)
          || !String.Equals(JarvisIdentity.Read(verification), "${WINDOWS_AUMID}", StringComparison.Ordinal))
        throw new InvalidOperationException("Saved shortcut fields differ from requested integration");
    } finally { Marshal.FinalReleaseComObject(verification); }
  }
}
'@
$stage = 'save Unicode shortcut'
[JarvisShortcut]::Save($env:JARVIS_LINK_PATH, $env:JARVIS_LINK_TARGET, $env:JARVIS_LINK_ARGS, $env:JARVIS_LINK_CWD)
} catch {
[Console]::Error.WriteLine(('Shortcut stage {0}: {1} (HRESULT {2})' -f $stage, $_.Exception.Message, $_.Exception.HResult))
exit 1
}
`
function runPowerShell(script: string, env: NodeJS.ProcessEnv): void {
  try {
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, ...env, PSModulePath: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') }, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const failure = error as { status?: number; code?: string; stderr?: string }
    throw new Error(`Windows shortcut creation failed (${failure.code ?? failure.status ?? 'unknown'}): ${failure.stderr?.trim() || 'PowerShell returned no diagnostic'}`)
  }
}
function validateOptionPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || Buffer.byteLength(path) > 4096 || !isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f\ud800-\udfff]/u.test(path)) throw new Error('Unsafe integration option path')
  // Use host semantics: mocked Windows integrations on POSIX still use POSIX paths.
  // Windows aliases must fail even when the destination does not yet exist.
  if (process.platform === 'win32' && (!/^[a-z]:\\/i.test(path) || path.slice(2).includes(':') || path.includes('/') || !path.slice(3).split('\\').every(part => !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))) throw new Error('Unsafe integration option path: native Windows alias')
}
type RenderOptions = Pick<InstallOptions, 'platform' | 'root' | 'home' | 'appData' | 'localAppData'>
function locations(options: RenderOptions) {
  const app = join(options.home, 'Applications', 'Jarvis.app')
  const state = options.platform === 'darwin' ? join(options.home, 'Library', 'Application Support', 'Jarvis', 'native-install.json') : join(options.localAppData!, 'Jarvis', 'native-install.json')
  const menu = join(options.appData ?? options.home, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const files = options.platform === 'darwin'
    ? [join(app, 'Contents', 'Info.plist'), join(app, 'Contents', 'MacOS', 'Jarvis'), join(options.home, 'Library', 'LaunchAgents', 'org.jarvis.portable.plist')]
    : [join(menu, 'Jarvis.lnk'), join(menu, 'Startup', 'Jarvis.lnk')]
  return { app, state, files }
}
export type NativeIntegrationRenderPlan =
  | { platform: 'darwin'; artifacts: { path: string; bytes: Buffer; mode: number }[] }
  | { platform: 'win32'; shortcuts: { path: string; target: string; args: string; cwd: string }[] }

/** Pure rendering of already resolved inputs, in publication order. No validation or I/O.
 * Modes are requested creation modes (subject to umask). Windows COM supplies the
 * shortcut bytes later; this plan cannot predict their bytes or hashes. */
export function renderNativeIntegration(options: RenderOptions, autostart: boolean, configFile?: string): NativeIntegrationRenderPlan {
  const { root } = options
  const { files } = locations(options)
  const runtime = join(root, 'runtime', options.platform === 'win32' ? 'node.exe' : 'node')
  const argv = ['--experimental-transform-types', join(root, 'scripts', 'app.ts'), ...(configFile ? ['--config', configFile] : [])]
  if (options.platform === 'darwin') {
    const artifacts = [
      { path: files[0]!, bytes: Buffer.from(plist('<key>CFBundleIdentifier</key><string>org.jarvis.portable</string><key>CFBundleName</key><string>Jarvis</string><key>CFBundleExecutable</key><string>Jarvis</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/>')), mode: 0o600 },
      { path: files[1]!, bytes: Buffer.from(`#!/bin/sh\nset -eu\ncd ${shellQuote(root)}\nexec ${[runtime, ...argv].map(shellQuote).join(' ')}\n`), mode: 0o700 },
    ]
    if (autostart) artifacts.push({ path: files[2]!, bytes: Buffer.from(plist(`<key>Label</key><string>org.jarvis.portable</string><key>ProgramArguments</key><array>${[runtime, ...argv, '--no-open'].map(value => `<string>${xml(value)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/>`)), mode: 0o600 })
    return { platform: 'darwin', artifacts }
  }
  return { platform: 'win32', shortcuts: files.slice(0, autostart ? 2 : 1).map((path, index) => ({
    path, target: runtime, args: [...argv, ...(index === 1 ? ['--no-open'] : [])].map(windowsQuote).join(' '), cwd: root,
  })) }
}

async function absent(path: string): Promise<void> {
  try { await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  throw new Error(`Integration already exists; uninstall it first: ${path}`)
}
/** Refuse symlink ancestors before writes or deletes; home itself may be canonicalized by caller. */
async function safeAncestors(path: string, userRoots: string[] = []): Promise<void> {
  let current = resolve(path)
  while (true) {
    try {
      const info = await lstat(current, { bigint: true })
      if (info.isSymbolicLink()) throw new Error(`Integration symlink rejected: ${current}`)
      if (current !== resolve(path) && !info.isDirectory()) throw new Error('Unsafe integration ancestor type')
      if (userRoots.some(root => current === root || current.startsWith(root + (process.platform === 'win32' ? '\\' : '/')))) checkPermissions(info)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

function checkPermissions(info: BigIntStats, privateFile = false): void {
  // Windows mode bits do not establish ACL privacy. Keep legacy producers compatible.
  if (process.platform !== 'win32' && (info.uid !== BigInt(process.getuid!()) || (info.mode & (privateFile ? 0o077n : 0o022n)) !== 0n)) throw new Error('Unsafe integration permissions')
}
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return (['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const).every(key => a[key] === b[key])
}
interface Snapshot { bytes: Buffer; identity: BigIntStats }
async function boundedIntegrationRead(path: string, limit: number, userRoots: string[], privateFile = false): Promise<Snapshot | undefined> {
  await safeAncestors(path, userRoots)
  let before: BigIntStats
  try { before = await lstat(path, { bigint: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const validate = (info: BigIntStats) => {
    if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(limit)) throw new Error('Unsafe integration file type, links or size')
    checkPermissions(info, privateFile)
  }
  validate(before)
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const initial = await handle.stat({ bigint: true })
    validate(initial)
    if (!sameIdentity(before, initial)) throw new Error('Integration changed during read')
    // Allocate only after the size check, with one byte reserved to prove EOF.
    const bytes = Buffer.alloc(Number(initial.size) + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    await safeAncestors(path, userRoots)
    const named = await lstat(path, { bigint: true })
    if (length !== Number(initial.size) || !sameIdentity(initial, after) || !sameIdentity(initial, named)) throw new Error('Integration changed during read')
    return { bytes: bytes.subarray(0, length), identity: initial }
  } finally { await handle.close() }
}
export interface IntegrationReceipt {
  schemaVersion: 1
  platform: Platform
  root: string
  autostart: boolean
  configFile?: string
  dataDir?: string
  notificationAumid?: string
  files: { path: string; sha256: string }[]
}
function parseReceipt(bytes: Buffer, platform: Platform, files: string[]): IntegrationReceipt {
  const invalid = () => new Error('Unsafe integration receipt')
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  const absolute = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0') && isAbsolute(value)
  let receipt: unknown
  try { receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw invalid() }
  // Accept the producer's JSON encoding only, rejecting duplicate keys and lossy encodings.
  if (!object(receipt) || !bytes.equals(Buffer.from(JSON.stringify(receipt, null, 2) + '\n'))) throw invalid()
  const allowed = ['schemaVersion', 'platform', 'root', 'autostart', 'configFile', 'dataDir', 'notificationAumid', 'files']
  if (Object.keys(receipt).some(key => !allowed.includes(key)) || receipt.schemaVersion !== 1 || receipt.platform !== platform || !absolute(receipt.root) || /[\r\n]/.test(receipt.root) || resolve(receipt.root) !== receipt.root || typeof receipt.autostart !== 'boolean' || !Array.isArray(receipt.files)) throw invalid()
  const hasConfig = Object.hasOwn(receipt, 'configFile'), hasData = Object.hasOwn(receipt, 'dataDir')
  if (hasConfig !== hasData || (hasConfig && (!absolute(receipt.configFile) || !absolute(receipt.dataDir)))) throw invalid()
  if (platform === 'win32' ? receipt.notificationAumid !== WINDOWS_AUMID : Object.hasOwn(receipt, 'notificationAumid')) throw invalid()
  const expected = new Set(receipt.autostart ? files : files.slice(0, -1))
  if (receipt.files.length !== expected.size) throw invalid()
  for (const entry of receipt.files) {
    if (!object(entry) || Object.keys(entry).length !== 2 || typeof entry.path !== 'string' || !expected.delete(entry.path) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw invalid()
  }
  return receipt as unknown as IntegrationReceipt
}

/** Pure fixed-location description; does not inspect the original installation. */
export function describeNativeIntegration(options: InstallOptions): { receiptPath: string; artifactPaths: string[] } {
  if (!['darwin', 'win32'].includes(options.platform)) throw new Error('Unsupported integration platform')
  validateOptionPath(options.root)
  validateOptionPath(options.home)
  for (const path of [options.appData, options.localAppData]) {
    if (options.platform === 'win32' || path !== undefined) validateOptionPath(path)
  }
  const { state, files } = locations(options)
  return { receiptPath: state, artifactPaths: files }
}

/** Read one fixed integration location without requiring a receipt to exist.
 * Uses legacy integration permission checks; Windows mode bits do not prove ACL privacy.
 * Callers must coordinate writers and treat unsafe read failures as unverified state. */
export async function readNativeIntegrationSlot(options: InstallOptions, path: string): Promise<{ bytes: Buffer; mode: number; identity: BigIntStats } | undefined> {
  const { receiptPath, artifactPaths } = describeNativeIntegration(options)
  if (path !== receiptPath && !artifactPaths.includes(path)) throw new Error('Unknown integration location')
  const userRoots = [options.home, options.appData, options.localAppData].filter((value): value is string => value !== undefined).map(value => resolve(value))
  const snapshot = await boundedIntegrationRead(path, path === receiptPath ? 64 * 1024 : 1024 * 1024, userRoots, path === receiptPath)
  return snapshot && { bytes: Buffer.from(snapshot.bytes), mode: Number(snapshot.identity.mode & 0o7777n), identity: snapshot.identity }
}

/** Validate captured receipt bytes without accessing their original source paths. */
export function parseNativeIntegrationReceipt(bytes: Buffer, options: InstallOptions): IntegrationReceipt {
  if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024) throw new Error('Unsafe integration receipt size')
  return parseReceipt(bytes, options.platform, describeNativeIntegration(options).artifactPaths)
}

async function inspectDetailed(options: InstallOptions, state: string, files: string[]) {
  const userRoots = [options.home, options.appData, options.localAppData].filter((path): path is string => path !== undefined).map(path => resolve(path))
  const receiptSnapshot = await boundedIntegrationRead(state, 64 * 1024, userRoots, true)
  if (!receiptSnapshot) return undefined
  const receipt = parseReceipt(receiptSnapshot.bytes, options.platform, files)
  const preflight = new Map<string, Snapshot | undefined>()
  for (const entry of receipt.files) {
    const snapshot = await boundedIntegrationRead(entry.path, 1024 * 1024, userRoots)
    if (snapshot && digest(snapshot.bytes) !== entry.sha256) throw new Error('Integration changed')
    preflight.set(entry.path, snapshot)
  }
  return { userRoots, receiptSnapshot, receipt, preflight }
}

/** Read-only inspection. Callers must keep writers quiescent: revalidation is not an atomic OS snapshot. */
export async function inspectNativeIntegration(options: InstallOptions): Promise<{
  receiptPath: string
  receipt: Buffer
  receiptMode: number
  artifacts: Array<{ path: string; bytes: Buffer | undefined; mode: number | undefined }>
  binding: { root: string; autostart: boolean; configFile?: string; dataDir?: string }
  platform: Platform
} | undefined> {
  const { receiptPath: state, artifactPaths: files } = describeNativeIntegration(options)
  const detailed = await inspectDetailed(options, state, files)
  if (!detailed) return undefined
  const { userRoots, receiptSnapshot, receipt, preflight } = detailed
  for (const path of files) {
    if (preflight.has(path)) continue
    const snapshot = await boundedIntegrationRead(path, 1024 * 1024, userRoots)
    if (snapshot) throw new Error('Unowned integration location exists')
    preflight.set(path, undefined)
  }
  for (const path of files) {
    const before = preflight.get(path)
    const current = await boundedIntegrationRead(path, 1024 * 1024, userRoots)
    if (before === undefined ? current !== undefined : !current || !sameIdentity(before.identity, current.identity) || !before.bytes.equals(current.bytes)) throw new Error('Integration changed during inspection')
  }
  const currentReceipt = await boundedIntegrationRead(state, 64 * 1024, userRoots, true)
  if (!currentReceipt || !sameIdentity(receiptSnapshot.identity, currentReceipt.identity) || !receiptSnapshot.bytes.equals(currentReceipt.bytes)) throw new Error('Integration receipt changed during inspection')
  return {
    receiptPath: state,
    receipt: Buffer.from(receiptSnapshot.bytes),
    receiptMode: Number(receiptSnapshot.identity.mode & 0o7777n),
    artifacts: files.map(path => {
      const snapshot = preflight.get(path)
      return { path, bytes: snapshot && Buffer.from(snapshot.bytes), mode: snapshot && Number(snapshot.identity.mode & 0o7777n) }
    }),
    binding: { root: receipt.root, autostart: receipt.autostart, ...(receipt.configFile === undefined ? {} : { configFile: receipt.configFile, dataDir: receipt.dataDir! }) },
    platform: receipt.platform,
  }
}

/** Presence only, under the verified shared writer boundary. Never open residue:
 * malformed records, special files and records from other roots still require review. */
async function refuseRetainedTransaction(directory: string, artifactCount: number): Promise<void> {
  const refused = () => new Error('Retained or unsafe native install transaction residue requires review; refusing integration mutation')
  try {
    for (const name of ['prepared-transaction.json', 'prepared-completion.json', ...Array.from({ length: artifactCount }, (_, index) => `prepared-artifact-${index}.json`)]) {
      try { await lstat(join(directory, name)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      throw refused()
    }
    // Include unknown generations/indices and malformed acknowledgement names.
    // Directory entries suffice: do not follow links or inspect their contents.
    // Reserve case variants too, including on case-insensitive Windows volumes.
    if ((await readdir(directory)).some(name => ['prepared-transaction.json', 'prepared-completion.json'].includes(name.toLowerCase()) || /^prepared-artifact-/i.test(name))) throw refused()
  } catch { throw refused() }
}

export async function nativeIntegration(options: InstallOptions, args: string[]): Promise<string[]> {
  const { action, autostart, configFile } = parseArgs(args)
  const { receiptPath: state, artifactPaths: files } = describeNativeIntegration(options)
  return withNativeInstallLock({ controlDirectory: join(dirname(state), 'native-install-control') }, async () => {
    // Hold the shared writer lock before configuration/package observation, through cleanup.
    // The store reader is deliberately unlocked; never reacquire this writer lock.
    // Retained plans (including malformed/unsafe files) require review before mutation.
    const { readNativeInstallIntent } = await import('./native-install-intent-store.ts')
    if (await readNativeInstallIntent({ integration: options })) throw new Error('Existing native install intent requires review; refusing integration mutation')
    await refuseRetainedTransaction(join(dirname(state), 'native-install-control'), files.length)
    // Validate on the host before any integration mutation; never snapshot secrets.
    const externalConfig = configFile === undefined ? undefined : loadExternalConfig(configFile)
    const binding = configFile === undefined ? {} : { configFile: await realpath(configFile), dataDir: externalConfig!.JARVIS_DATA_DIR }
    const { app } = locations(options)
    for (const path of [state, ...files]) await safeAncestors(path)
    if (action === 'uninstall') {
      const detailed = await inspectDetailed(options, state, files)
      if (!detailed) return []
      const { userRoots, receiptSnapshot, receipt, preflight } = detailed
      // These checks narrow races; portable pathname unlink is not atomic with validation.
      for (const entry of receipt.files) {
        const before = preflight.get(entry.path)
        const current = await boundedIntegrationRead(entry.path, 1024 * 1024, userRoots)
        if (!current) continue
        if (!before || !sameIdentity(before.identity, current.identity) || digest(current.bytes) !== entry.sha256) throw new Error('Integration changed; refusing to remove')
        await unlink(entry.path)
      }
      const currentReceipt = await boundedIntegrationRead(state, 64 * 1024, userRoots, true)
      if (!currentReceipt || !sameIdentity(receiptSnapshot.identity, currentReceipt.identity) || !receiptSnapshot.bytes.equals(currentReceipt.bytes)) throw new Error('Integration receipt changed; refusing to remove')
      await unlink(state)
      if (options.platform === 'darwin') for (const directory of [join(app, 'Contents', 'MacOS'), join(app, 'Contents'), app]) {
        try { await rmdir(directory) } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
      }
      return receipt.files.map(entry => entry.path)
    }
    const root = await realpath(options.root)
    await validatePackage(root, options.platform, options.arch)
    await absent(state)
    if (options.platform === 'darwin') await absent(app)
    for (const path of files) await absent(path)
    const plan = renderNativeIntegration({ ...options, root }, autostart, binding.configFile)
    interface CreatedRecord { path: string; identity?: BigIntStats; sha256?: string; limit: number }
    const created: CreatedRecord[] = []
    const userRoots = [options.home, options.appData, options.localAppData].filter((path): path is string => path !== undefined).map(path => resolve(path))
    const cleanupErrors: unknown[] = []
    const retained = (path: string) => new Error(`Retained unverified installation artifact: ${JSON.stringify(path).slice(0, 1024)}`)
    async function verifyCreated(record: CreatedRecord) {
      const current = await boundedIntegrationRead(record.path, record.limit, userRoots, record.path === state)
      if (!record.identity || !record.sha256 || !current || !sameIdentity(record.identity, current.identity) || digest(current.bytes) !== record.sha256) throw new Error('Integration changed after publication')
    }
    async function removeOwned(record: CreatedRecord) {
      if (!record.identity || !record.sha256) throw retained(record.path)
      const current = await boundedIntegrationRead(record.path, record.limit, userRoots, record.path === state)
      if (!current) return
      if (!sameIdentity(record.identity, current.identity) || digest(current.bytes) !== record.sha256) throw retained(record.path)
      // Portable pathname unlink cannot be atomic with the preceding validation.
      await unlink(record.path)
    }
    async function output(path: string, content: string | Buffer, mode = 0o600) {
      await mkdir(dirname(path), { recursive: true, mode: 0o755 })
      await safeAncestors(path, userRoots)
      const handle = await open(path, 'wx', mode)
      // Register immediately: failed writes may leave bytes whose ownership is uncertain.
      const record: CreatedRecord = { path, limit: path === state ? 64 * 1024 : 1024 * 1024 }
      created.push(record)
      let failure: unknown
      let failed = false
      try {
        record.identity = await handle.stat({ bigint: true })
        const initial = record.identity
        await handle.writeFile(content)
        await handle.sync()
        const completed = await handle.stat({ bigint: true })
        const snapshot = await boundedIntegrationRead(path, record.limit, userRoots, path === state)
        if (!snapshot || initial.dev !== completed.dev || initial.ino !== completed.ino || !sameIdentity(completed, snapshot.identity) || digest(snapshot.bytes) !== digest(content)) throw new Error('Integration changed during publication')
        record.identity = completed
        record.sha256 = digest(content)
      } catch (error) { failed = true; failure = error }
      try { await handle.close() } catch (error) { if (failed) cleanupErrors.push(error); else { failed = true; failure = error } }
      if (failed) throw failure
    }
    try {
      const prepared: { path: string; bytes: Buffer; mode: number }[] = plan.platform === 'darwin' ? plan.artifacts : []
      if (plan.platform === 'win32') {
        for (const { path, target, args, cwd } of plan.shortcuts) {
          await mkdir(dirname(path), { recursive: true, mode: 0o755 })
          // COM must see a nonexistent path: a zero-byte reservation is not a valid .lnk.
          // Publish exclusively after generation, so existing final links are never replaced.
          const staging = await mkdtemp(join(dirname(path), '.jarvis-link-'))
          const temporaryLink = join(staging, 'Jarvis.lnk')
          let staged: CreatedRecord | undefined
          let failure: unknown
          let failed = false
          try {
            ;(options.runPowerShell ?? runPowerShell)(POWERSHELL_LINK, { JARVIS_LINK_PATH: temporaryLink, JARVIS_LINK_TARGET: target, JARVIS_LINK_ARGS: args, JARVIS_LINK_CWD: cwd })
            const source = await boundedIntegrationRead(temporaryLink, 1024 * 1024, userRoots)
            if (!source?.bytes.length) throw new Error('PowerShell did not create a shortcut')
            staged = { path: temporaryLink, identity: source.identity, sha256: digest(source.bytes), limit: 1024 * 1024 }
            // Keep the exact bounded-read bytes; every selected shortcut must finish
            // generation, validation and owned staging cleanup before publication.
            prepared.push({ path, bytes: source.bytes, mode: 0o600 })
          } catch (error) { failed = true; failure = error }
          try {
            if (dirname(staging) !== dirname(path) || dirname(temporaryLink) !== staging) throw new Error('Unsafe shortcut staging cleanup')
            if (staged) await removeOwned(staged)
            else if (await lstat(temporaryLink).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })) throw retained(temporaryLink)
            await rmdir(staging)
          } catch (error) { if (failed) cleanupErrors.push(error); else { failed = true; failure = error } }
          if (failed) throw failure
        }
      }
      const records = prepared.map(({ path, bytes }) => ({ path, sha256: digest(bytes) }))
      const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, platform: options.platform, root, autostart, ...binding, ...(options.platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: records }, null, 2) + '\n')
      // Validate the complete proposed receipt before any final artifact is published.
      parseNativeIntegrationReceipt(receipt, { ...options, root })
      for (const artifact of prepared) await output(artifact.path, artifact.bytes, artifact.mode)
      if (JSON.stringify(created.map(({ path, sha256 }) => ({ path, sha256 }))) !== JSON.stringify(records)) throw new Error('Published integration differs from prepared receipt')
      for (const record of created) await verifyCreated(record)
      if (!autostart) { await safeAncestors(files.at(-1)!, userRoots); await absent(files.at(-1)!) }
      await output(state, receipt)
      for (const record of created) await verifyCreated(record)
      if (!autostart) { await safeAncestors(files.at(-1)!, userRoots); await absent(files.at(-1)!) }
      return created.map(record => record.path)
    } catch (error) {
      for (const record of created.toReversed()) {
        try { await removeOwned(record) } catch (cleanup) { cleanupErrors.push(new Error(`Installation cleanup retained ${JSON.stringify(record.path).slice(0, 1024)}`, { cause: cleanup })) }
      }
      if (options.platform === 'darwin') for (const directory of [join(app, 'Contents', 'MacOS'), join(app, 'Contents'), app]) {
        try { await safeAncestors(directory, userRoots); await rmdir(directory) } catch (cleanup) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((cleanup as NodeJS.ErrnoException).code ?? '')) cleanupErrors.push(cleanup) }
      }
      if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], `Native installation failed (${error instanceof Error ? error.message.slice(0, 512) : 'unknown error'}); cleanup incomplete. ${cleanupErrors.map(cleanup => cleanup instanceof Error ? cleanup.message : 'Cleanup failed').join('; ').slice(0, 4096)}`, { cause: error })
      throw error
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const main = async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('Native wrappers support macOS and Windows; Linux desktop/systemd scripts are unchanged')
    const parsed = parseArgs(process.argv.slice(2))
    await nativeIntegration({ platform: process.platform, root: dirname(dirname(fileURLToPath(import.meta.url))), home: await realpath(homedir()), appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA, arch: process.arch }, process.argv.slice(2))
    console.log(parsed.action === 'install' ? `Installed per-user shortcuts. Keep this package folder in place. Login startup: ${parsed.autostart ? 'enabled for next login' : 'disabled'}. No application was started.` : 'Removed owned integrations. Package, user data and running servers were preserved.')
    if (process.platform === 'darwin') console.log('This wrapper is unsigned and not notarized. macOS may block it or the downloaded runtime; no Gatekeeper or quarantine settings were changed.')
  }
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
}
