import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

export type NativePlatform = 'linux' | 'darwin' | 'win32'
export function nativeTarget(platform: string, arch: string, version: string): NativePlatform {
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`)
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`)
  if (!/^v24\./.test(version)) throw new Error('Packaging requires the current Node 24 runtime')
  return platform as NativePlatform
}

const runtimeScripts = new Set(['app.ts', 'runtime-lifecycle.ts', 'asr_worker.py', 'ocr_worker.py', 'screen_capture.py', 'backup.ts', 'restore.ts', 'backup-archive.ts', 'gen-tls.sh', 'install-service.sh'])
const publicDocs = new Set(['getting-started.md', 'distribution.md', 'security.md', 'providers-guide.md', 'voice-providers.md', 'operations.md', 'models.md', 'voice.md', 'providers.md'])
/** An allowlist of tracked public source; never recursively copy a working tree. */
export function isPublicFile(path: string): boolean {
  const parts = path.split('/')
  if (parts.some(p => !p || p.startsWith('.') || /^(?:private|secrets?|data|node_modules|__pycache__)$/i.test(p))) return false
  if (['package.json', 'package-lock.json', 'README.md', 'LICENSE'].includes(path)) return true
  if (parts[0] === 'src') return path.endsWith('.ts')
  if (parts[0] === 'web') return /\.(?:html|js|css|webmanifest|svg|png|ico|woff2?)$/.test(path)
  if (parts.length === 2 && parts[0] === 'scripts') return runtimeScripts.has(parts[1]!)
  return parts.length === 2 && parts[0] === 'docs' && publicDocs.has(parts[1]!)
}

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
}
export function provenance(root: string, packageVersion: string, env: NodeJS.ProcessEnv = process.env) {
  const version = env.JARVIS_RELEASE_VERSION ?? packageVersion
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid JARVIS_RELEASE_VERSION')
  const sha = git(root, ['rev-parse', 'HEAD'])
  if (env.JARVIS_SOURCE_SHA && env.JARVIS_SOURCE_SHA !== sha) throw new Error('JARVIS_SOURCE_SHA does not match checked-out HEAD')
  const tag = env.JARVIS_RELEASE_TAG ?? null
  if (tag && tag !== `v${version}`) throw new Error('JARVIS_RELEASE_TAG must equal v<release version>')
  if (tag && git(root, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]) !== sha) throw new Error('Release tag does not point at HEAD')
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']).length > 0
  if ((env.JARVIS_SOURCE_SHA || tag) && dirty) throw new Error('Release provenance requires a clean tracked checkout')
  return { version, sourceSha: sha, sourceTag: tag, dirty }
}

export async function copyPublicFiles(root: string, stage: string): Promise<string[]> {
  const paths = git(root, ['ls-files', '-z']).split('\0').filter(isPublicFile).sort()
  for (const required of ['package.json', 'package-lock.json', 'LICENSE', 'src/main.ts', 'scripts/app.ts', 'web/index.html']) {
    if (!paths.includes(required)) throw new Error(`Missing tracked public file: ${required}`)
  }
  for (const path of paths) {
    let source = root
    for (const part of path.split('/')) {
      source = join(source, part)
      if ((await lstat(source)).isSymbolicLink()) throw new Error(`Public payload symlink rejected: ${path}`)
    }
    if (!(await lstat(source)).isFile()) throw new Error(`Not a regular payload file: ${path}`)
    const destination = join(stage, path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }
  return paths
}

export function launchers(platform: NativePlatform): Record<string, string> {
  if (platform === 'win32') return {
    'Jarvis.cmd': '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%~dp0runtime\\node.exe" --experimental-transform-types "%~dp0scripts\\app.ts" %*\r\nexit /b %errorlevel%\r\n',
    'Jarvis.ps1': '& "$PSScriptRoot\\runtime\\node.exe" --experimental-transform-types "$PSScriptRoot\\scripts\\app.ts" @args\r\nexit $LASTEXITCODE\r\n',
  }
  const sh = '#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/runtime/node" --experimental-transform-types "$HERE/scripts/app.ts" "$@"\n'
  return platform === 'darwin' ? { jarvis: sh, 'Jarvis.command': sh } : { jarvis: sh }
}

export async function writeLaunchers(stage: string, platform: NativePlatform): Promise<void> {
  for (const [name, content] of Object.entries(launchers(platform))) {
    await writeFile(join(stage, name), content)
    if (platform !== 'win32') await chmod(join(stage, name), 0o755)
  }
}

export async function payloadFiles(root: string, directory = root): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Payload symlink rejected: ${full}`)
    if (entry.isDirectory()) result.push(...await payloadFiles(root, full))
    else if (entry.isFile()) result.push(relative(root, full).split('\\').join('/'))
    else throw new Error(`Non-regular payload rejected: ${full}`)
  }
  return result.sort()
}
export async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

export async function licenseInventory(stage: string) {
  const files = await payloadFiles(stage)
  const licenses = files.filter(path => /(?:^|\/)(?:licen[sc]e|copying|notice|copyright)(?:[.-].*)?$/i.test(path))
  const dependencies = []
  for (const path of files.filter(path => /^node_modules\/(?:@[^/]+\/)?[^/]+\/(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*package\.json$/.test(path))) {
    const pkg = JSON.parse(await readFile(join(stage, path), 'utf8'))
    const prefix = path.slice(0, -'package.json'.length)
    dependencies.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? pkg.licenses ?? 'SEE LICENSE FILES', path: prefix, files: licenses.filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/node_modules/')) })
  }
  return { licenses, dependencies }
}

export async function writeManifest(stage: string, metadata: Record<string, unknown>): Promise<void> {
  const files = []
  for (const path of await payloadFiles(stage)) {
    if (path === 'manifest.json') continue
    const info = await lstat(join(stage, path))
    files.push({ path, bytes: info.size, sha256: await sha256(join(stage, path)), executable: !!(info.mode & 0o111) })
  }
  await writeFile(join(stage, 'manifest.json'), JSON.stringify({ schemaVersion: 1, ...metadata, files }, null, 2) + '\n')
}

export function createArchive(platform: NativePlatform, parent: string, name: string, output: string): void {
  // The caller supplies a new temporary output path: archivers never update a prior release.
  if (platform === 'win32') {
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -LiteralPath $env:JARVIS_ARCHIVE_SOURCE -DestinationPath $env:JARVIS_ARCHIVE_DESTINATION -CompressionLevel Optimal -ErrorAction Stop'],
    { stdio: 'inherit', env: { ...process.env, JARVIS_ARCHIVE_SOURCE: resolve(parent, name), JARVIS_ARCHIVE_DESTINATION: resolve(output) } })
  } else {
    execFileSync('tar', ['-czf', resolve(output), '-C', resolve(parent), name], { stdio: 'inherit' })
  }
}
