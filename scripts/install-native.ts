#!/usr/bin/env node
/** Per-user integrations only: the verified portable package stays in place. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
export function parseArgs(args: string[]): { action: 'install' | 'uninstall'; autostart: boolean } {
  if (args.some(arg => !['--install', '--uninstall', '--autostart'].includes(arg)) || new Set(args).size !== args.length || args.includes('--install') === args.includes('--uninstall') || (args.includes('--uninstall') && args.includes('--autostart'))) {
    throw new Error('Usage: install-native.ts --install [--autostart] | --uninstall')
  }
  return { action: args.includes('--install') ? 'install' : 'uninstall', autostart: args.includes('--autostart') }
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
      ((IPersistFile)instance).Save(destination, true);
    } finally { Marshal.FinalReleaseComObject(instance); }
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
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, ...env, PSModulePath: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const failure = error as { status?: number; code?: string; stderr?: string }
    throw new Error(`Windows shortcut creation failed (${failure.code ?? failure.status ?? 'unknown'}): ${failure.stderr?.trim() || 'PowerShell returned no diagnostic'}`)
  }
}
function locations(options: InstallOptions) {
  for (const value of [options.home, options.root, ...(options.platform === 'win32' ? [options.appData, options.localAppData] : [])]) {
    if (!value || !isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('Native installation requires absolute paths without line breaks')
  }
  const app = join(options.home, 'Applications', 'Jarvis.app')
  const state = options.platform === 'darwin' ? join(options.home, 'Library', 'Application Support', 'Jarvis', 'native-install.json') : join(options.localAppData!, 'Jarvis', 'native-install.json')
  const menu = join(options.appData ?? options.home, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const files = options.platform === 'darwin'
    ? [join(app, 'Contents', 'Info.plist'), join(app, 'Contents', 'MacOS', 'Jarvis'), join(options.home, 'Library', 'LaunchAgents', 'org.jarvis.portable.plist')]
    : [join(menu, 'Jarvis.lnk'), join(menu, 'Startup', 'Jarvis.lnk')]
  return { app, state, files }
}
async function absent(path: string): Promise<void> {
  try { await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  throw new Error(`Integration already exists; uninstall it first: ${path}`)
}
/** Refuse symlink ancestors before writes or deletes; home itself may be canonicalized by caller. */
async function safeAncestors(path: string): Promise<void> {
  let current = resolve(path)
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Integration symlink rejected: ${current}`) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

export async function nativeIntegration(options: InstallOptions, args: string[]): Promise<string[]> {
  const { action, autostart } = parseArgs(args)
  const { app, state, files } = locations(options)
  for (const path of [state, ...files]) await safeAncestors(path)
  if (action === 'uninstall') {
    let receipt
    try { receipt = JSON.parse(await readFile(state, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    if (receipt.schemaVersion !== 1 || receipt.platform !== options.platform || !Array.isArray(receipt.files)) throw new Error('Invalid integration receipt')
    const seen = new Set<string>()
    for (const entry of receipt.files) {
      if (!files.includes(entry.path) || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Unsafe integration receipt')
      seen.add(entry.path)
      try { if (digest(await readFile(entry.path)) !== entry.sha256) throw new Error(`Integration changed; refusing to remove: ${entry.path}`) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    for (const entry of receipt.files) {
      try { await unlink(entry.path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    await unlink(state)
    if (options.platform === 'darwin') for (const directory of [join(app, 'Contents', 'MacOS'), join(app, 'Contents'), app]) {
      try { await rmdir(directory) } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    }
    return [...seen]
  }
  const root = await realpath(options.root)
  await validatePackage(root, options.platform, options.arch)
  await absent(state)
  if (options.platform === 'darwin') await absent(app)
  for (const path of files) await absent(path)
  const runtime = join(root, 'runtime', options.platform === 'win32' ? 'node.exe' : 'node')
  const argv = ['--experimental-transform-types', join(root, 'scripts', 'app.ts')]
  const created: string[] = []
  async function output(path: string, content: string, mode = 0o600) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, { flag: 'wx', mode })
    created.push(path)
  }
  try {
    if (options.platform === 'darwin') {
      await output(files[0]!, plist('<key>CFBundleIdentifier</key><string>org.jarvis.portable</string><key>CFBundleName</key><string>Jarvis</string><key>CFBundleExecutable</key><string>Jarvis</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/>'))
      await output(files[1]!, `#!/bin/sh\nset -eu\ncd ${shellQuote(root)}\nexec ${[runtime, ...argv].map(shellQuote).join(' ')}\n`, 0o700)
      if (autostart) await output(files[2]!, plist(`<key>Label</key><string>org.jarvis.portable</string><key>ProgramArguments</key><array>${[runtime, ...argv, '--no-open'].map(value => `<string>${xml(value)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/>`))
    } else {
      for (const [index, path] of files.entries()) {
        if (index === 1 && !autostart) continue
        await mkdir(dirname(path), { recursive: true })
        // COM must see a nonexistent path: a zero-byte reservation is not a valid .lnk.
        // Publish exclusively after generation, so existing final links are never replaced.
        const staging = await mkdtemp(join(dirname(path), '.jarvis-link-'))
        const temporaryLink = join(staging, 'Jarvis.lnk')
        try {
          ;(options.runPowerShell ?? runPowerShell)(POWERSHELL_LINK, { JARVIS_LINK_PATH: temporaryLink, JARVIS_LINK_TARGET: runtime, JARVIS_LINK_ARGS: [...argv, ...(index === 1 ? ['--no-open'] : [])].map(windowsQuote).join(' '), JARVIS_LINK_CWD: root })
          if (!(await lstat(temporaryLink)).size) throw new Error('PowerShell did not create a shortcut')
          await copyFile(temporaryLink, path, constants.COPYFILE_EXCL)
          created.push(path)
        } finally {
          if (dirname(staging) !== dirname(path) || dirname(temporaryLink) !== staging) throw new Error('Unsafe shortcut staging cleanup')
          try { await unlink(temporaryLink) } catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanup }
          await rmdir(staging)
        }
      }
    }
    const records = []
    for (const path of created) records.push({ path, sha256: digest(await readFile(path)) })
    await output(state, JSON.stringify({ schemaVersion: 1, platform: options.platform, root, autostart, files: records }, null, 2) + '\n')
    return created
  } catch (error) {
    // Only exact paths created by this invocation, never package or user data trees.
    for (const path of created.reverse()) { await safeAncestors(path); await unlink(path) }
    if (options.platform === 'darwin') for (const directory of [join(app, 'Contents', 'MacOS'), join(app, 'Contents'), app]) {
      try { await rmdir(directory) } catch (cleanup) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((cleanup as NodeJS.ErrnoException).code ?? '')) throw cleanup }
    }
    throw error
  }
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
