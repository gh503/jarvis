import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireMaintenanceLease } from './runtime-lease.js'

const FORMAT = 'jarvis-backup'
const FORMAT_VERSION = 1
const MAX_FILES = 20_000
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 192 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 260 * 1024 * 1024

const EXACT_FILES = [
  { path: '.dsh/storages/workspace.json', required: true },
  { path: '.dsh/storages/session_projcache.json', required: false },
  { path: 'data/reminders.json', required: true },
  { path: 'data/audit.jsonl', required: true },
  { path: 'data/pairing-state.json', required: false },
  { path: 'data/session-state.json', required: false },
  { path: 'data/event-state.json', required: false },
] as const

const DATA_PATHS = EXACT_FILES.filter(item => item.path.startsWith('data/')).map(item => item.path)

interface ArchiveFile {
  path: string
  mode: number
  size: number
  sha256: string
  contentBase64: string
}

interface ArchiveDocument {
  format: typeof FORMAT
  formatVersion: typeof FORMAT_VERSION
  applicationVersion: string
  createdAt: string
  files: ArchiveFile[]
}

interface ValidatedFile extends ArchiveFile {
  content: Buffer
}

export interface BackupOptions {
  outputPath: string
  dshHome: string
  dataDir: string
  runtimeDir: string
}

export interface RestoreOptions {
  archivePath: string
  dshHome: string
  dataDir: string
  runtimeDir: string
}

export interface BackupResult {
  path: string
  fileCount: number
  bytes: number
}

export interface RestoreResult {
  fileCount: number
  cleanupWarnings: string[]
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

function privateMode(mode: number): boolean {
  return (mode & 0o077) === 0 && (mode & 0o600) === 0o600
}

function assertPrivateFile(path: string, mode: number): void {
  if (!privateMode(mode)) throw new Error(`${path} must be private with owner read/write permission and no group or other access`)
}

function assertPrivateDirectory(path: string, mode: number): void {
  if ((mode & 0o077) !== 0 || (mode & 0o700) !== 0o700) {
    throw new Error(`${path} must be a private directory with mode 0700 or stricter`)
  }
}

function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(resolve(parent), resolve(child))
  return childRelative === '' || (!childRelative.startsWith(`..${sep}`) && childRelative !== '..' && !isAbsolute(childRelative))
}

async function applicationVersion(): Promise<string> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const value: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const version = typeof value === 'object' && value !== null ? Reflect.get(value, 'version') : undefined
  if (typeof version !== 'string' || version.length < 1) throw new Error('package.json has no valid version')
  return version
}

async function readStableFile(path: string, archivePath: string): Promise<ArchiveFile> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error(`${path} is not a regular file`)
    assertPrivateFile(path, before.mode)
    if (before.size > MAX_FILE_BYTES) throw new Error(`${path} exceeds the ${MAX_FILE_BYTES} byte backup limit`)
    const content = await handle.readFile()
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`${path} changed while the backup snapshot was being read`)
    }
    return {
      path: archivePath,
      mode: before.mode & 0o777,
      size: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      contentBase64: content.toString('base64'),
    }
  } finally {
    await handle.close()
  }
}

async function collectDirectory(path: string, archivePrefix: string, files: ArchiveFile[]): Promise<void> {
  const directory = await lstat(path)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(`${path} is not a regular directory`)
  assertPrivateDirectory(path, directory.mode)
  const entries = (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const childPath = join(path, entry.name)
    const childArchivePath = posix.join(archivePrefix, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`${childPath} is a symbolic link; backup follows no links`)
    if (entry.isDirectory()) await collectDirectory(childPath, childArchivePath, files)
    else if (entry.isFile()) files.push(await readStableFile(childPath, childArchivePath))
    else throw new Error(`${childPath} is not a regular file or directory`)
    if (files.length > MAX_FILES) throw new Error(`backup exceeds the ${MAX_FILES} file limit`)
  }
}

async function collectSnapshot(dshHome: string, dataDir: string): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = []
  const sessionsPath = join(dshHome, 'sessions')
  if (!await pathExists(sessionsPath)) throw new Error(`Harness sessions directory is missing: ${sessionsPath}`)
  await collectDirectory(sessionsPath, '.dsh/sessions', files)

  for (const item of EXACT_FILES) {
    const sourcePath = item.path.startsWith('.dsh/')
      ? join(dshHome, item.path.slice('.dsh/'.length))
      : join(dataDir, item.path.slice('data/'.length))
    if (!await pathExists(sourcePath)) {
      if (item.required) throw new Error(`required backup source is missing: ${sourcePath}`)
      continue
    }
    files.push(await readStableFile(sourcePath, item.path))
  }

  files.sort((left, right) => left.path.localeCompare(right.path))
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > MAX_TOTAL_BYTES) throw new Error(`backup payload exceeds the ${MAX_TOTAL_BYTES} byte limit`)
  return files
}

function sameSnapshot(left: ArchiveFile[], right: ArchiveFile[]): boolean {
  return left.length === right.length && left.every((file, index) => {
    const other = right[index]
    return other !== undefined && file.path === other.path && file.mode === other.mode
      && file.size === other.size && file.sha256 === other.sha256
  })
}

async function writePrivateAtomic(path: string, content: string): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if (await pathExists(path)) throw new Error(`backup destination already exists: ${path}`)
  const temporary = join(parent, `.${posix.basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function createBackup(options: BackupOptions): Promise<BackupResult> {
  const outputPath = resolve(options.outputPath)
  const dshHome = resolve(options.dshHome)
  const dataDir = resolve(options.dataDir)
  if (isWithin(dshHome, outputPath) || isWithin(dataDir, outputPath)) {
    throw new Error('backup destination must be outside the Harness and Jarvis data directories')
  }

  const lease = await acquireMaintenanceLease(resolve(options.runtimeDir), 'backup')
  try {
    const first = await collectSnapshot(dshHome, dataDir)
    const second = await collectSnapshot(dshHome, dataDir)
    if (!sameSnapshot(first, second)) throw new Error('persistent state changed during backup; retry after all Jarvis processes stop')
    const document: ArchiveDocument = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      applicationVersion: await applicationVersion(),
      createdAt: new Date().toISOString(),
      files: second,
    }
    await writePrivateAtomic(outputPath, `${JSON.stringify(document)}\n`)
    return { path: outputPath, fileCount: second.length, bytes: second.reduce((sum, file) => sum + file.size, 0) }
  } finally {
    await lease.release()
  }
}

function validArchivePath(path: string): boolean {
  if (path.length < 1 || path.includes('\\') || path.includes('\0') || path.startsWith('/') || posix.normalize(path) !== path) return false
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false
  return path.startsWith('.dsh/sessions/') || EXACT_FILES.some(item => item.path === path)
}

function hasExactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function parseJsonFile(file: ValidatedFile, label: string): unknown {
  try {
    return JSON.parse(file.content.toString('utf8')) as unknown
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

function validatePayloadSemantics(files: ValidatedFile[]): void {
  const byPath = new Map(files.map(file => [file.path, file]))
  for (const required of EXACT_FILES.filter(item => item.required)) {
    if (!byPath.has(required.path)) throw new Error(`backup is missing required file ${required.path}`)
  }
  const reminders = parseJsonFile(byPath.get('data/reminders.json') as ValidatedFile, 'data/reminders.json')
  if (!Array.isArray(reminders)) throw new Error('data/reminders.json must contain an array')
  parseJsonFile(byPath.get('.dsh/storages/workspace.json') as ValidatedFile, '.dsh/storages/workspace.json')
  for (const path of ['.dsh/storages/session_projcache.json', 'data/pairing-state.json', 'data/session-state.json', 'data/event-state.json']) {
    const file = byPath.get(path)
    if (file !== undefined) parseJsonFile(file, path)
  }
  const audit = (byPath.get('data/audit.jsonl') as ValidatedFile).content.toString('utf8')
  for (const [index, line] of audit.split('\n').entries()) {
    if (line === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object')
    } catch {
      throw new Error(`data/audit.jsonl line ${index + 1} is not a JSON object`)
    }
  }
}

async function readArchive(path: string): Promise<ValidatedFile[]> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('backup archive must be a regular file')
  assertPrivateFile(path, metadata.mode)
  if (metadata.size > MAX_ARCHIVE_BYTES) throw new Error(`backup archive exceeds the ${MAX_ARCHIVE_BYTES} byte limit`)
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    throw new Error('backup archive is not valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('backup archive must be an object')
  if (!hasExactKeys(value, ['format', 'formatVersion', 'applicationVersion', 'createdAt', 'files'])) {
    throw new Error('backup archive has unexpected or missing fields')
  }
  if (Reflect.get(value, 'format') !== FORMAT || Reflect.get(value, 'formatVersion') !== FORMAT_VERSION) {
    throw new Error('backup archive format is unsupported')
  }
  if (Reflect.get(value, 'applicationVersion') !== await applicationVersion()) {
    throw new Error('backup archive application version is incompatible')
  }
  const createdAt = Reflect.get(value, 'createdAt')
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) throw new Error('backup archive has an invalid creation time')
  const rawFiles = Reflect.get(value, 'files')
  if (!Array.isArray(rawFiles) || rawFiles.length > MAX_FILES) throw new Error('backup archive has an invalid file list')

  const files: ValidatedFile[] = []
  const paths = new Set<string>()
  let total = 0
  for (const rawFile of rawFiles) {
    if (typeof rawFile !== 'object' || rawFile === null || Array.isArray(rawFile)) throw new Error('backup file entry must be an object')
    if (!hasExactKeys(rawFile, ['path', 'mode', 'size', 'sha256', 'contentBase64'])) {
      throw new Error('backup file entry has unexpected or missing fields')
    }
    const pathValue = Reflect.get(rawFile, 'path')
    const mode = Reflect.get(rawFile, 'mode')
    const size = Reflect.get(rawFile, 'size')
    const sha256 = Reflect.get(rawFile, 'sha256')
    const contentBase64 = Reflect.get(rawFile, 'contentBase64')
    if (typeof pathValue !== 'string' || !validArchivePath(pathValue) || paths.has(pathValue)) throw new Error('backup contains an invalid or duplicate path')
    if (!Number.isSafeInteger(mode) || !privateMode(mode as number)) throw new Error(`backup file ${pathValue} has unsafe permissions`)
    if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > MAX_FILE_BYTES) throw new Error(`backup file ${pathValue} has an invalid size`)
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`backup file ${pathValue} has an invalid digest`)
    if (typeof contentBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
      throw new Error(`backup file ${pathValue} has invalid base64 content`)
    }
    const content = Buffer.from(contentBase64, 'base64')
    if (content.byteLength !== size || createHash('sha256').update(content).digest('hex') !== sha256) {
      throw new Error(`backup file ${pathValue} failed its size or checksum validation`)
    }
    total += content.byteLength
    if (total > MAX_TOTAL_BYTES) throw new Error(`backup payload exceeds the ${MAX_TOTAL_BYTES} byte limit`)
    paths.add(pathValue)
    files.push({ path: pathValue, mode: mode as number, size: size as number, sha256, contentBase64, content })
  }
  validatePayloadSemantics(files)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function ensureDirectory(path: string, privateDirectory: boolean): Promise<boolean> {
  if (await pathExists(path)) {
    const metadata = await lstat(path)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${path} must be a regular directory`)
    if (privateDirectory) assertPrivateDirectory(path, metadata.mode)
    return false
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
  return true
}

async function writeStagedFile(path: string, content: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600)
}

interface Replacement {
  target: string
  staged?: string
}

interface AppliedReplacement extends Replacement {
  backup?: string
}

async function rejectSymbolicTarget(path: string): Promise<void> {
  if (!await pathExists(path)) return
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) throw new Error(`restore target must not be a symbolic link: ${path}`)
}

async function commitReplacements(replacements: Replacement[], suffix: string): Promise<string[]> {
  const applied: AppliedReplacement[] = []
  try {
    for (const replacement of replacements) {
      await rejectSymbolicTarget(replacement.target)
      const backup = await pathExists(replacement.target) ? `${replacement.target}.jarvis-old-${suffix}` : undefined
      if (backup !== undefined) await rename(replacement.target, backup)
      try {
        if (replacement.staged !== undefined) await rename(replacement.staged, replacement.target)
      } catch (error) {
        if (backup !== undefined) await rename(backup, replacement.target)
        throw error
      }
      applied.push({ ...replacement, ...(backup === undefined ? {} : { backup }) })
    }
  } catch (error) {
    for (const replacement of [...applied].reverse()) {
      await rm(replacement.target, { recursive: true, force: true })
      if (replacement.backup !== undefined) await rename(replacement.backup, replacement.target)
    }
    throw error
  }

  const warnings: string[] = []
  for (const replacement of applied) {
    if (replacement.backup === undefined) continue
    try {
      await rm(replacement.backup, { recursive: true, force: true })
    } catch (error: unknown) {
      warnings.push(`could not remove old state at ${replacement.backup}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return warnings
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const archivePath = resolve(options.archivePath)
  const dshHome = resolve(options.dshHome)
  const dataDir = resolve(options.dataDir)
  if (isWithin(dshHome, archivePath) || isWithin(dataDir, archivePath)) {
    throw new Error('backup archive must be outside the Harness and Jarvis data directories')
  }
  if (isWithin(dshHome, dataDir) || isWithin(dataDir, dshHome)) throw new Error('Harness and Jarvis data directories must be separate')

  const lease = await acquireMaintenanceLease(resolve(options.runtimeDir), 'restore')
  const suffix = `${process.pid}-${randomUUID()}`
  const stagedPaths: string[] = []
  let createdDshHome = false
  let createdDataDir = false
  try {
    const files = await readArchive(archivePath)
    createdDshHome = await ensureDirectory(dshHome, false)
    createdDataDir = await ensureDirectory(dataDir, true)

    const sessionsTarget = join(dshHome, 'sessions')
    const storagesTarget = join(dshHome, 'storages')
    const sessionsStage = `${sessionsTarget}.jarvis-new-${suffix}`
    const storagesStage = `${storagesTarget}.jarvis-new-${suffix}`
    await mkdir(sessionsStage, { mode: 0o700 })
    await mkdir(storagesStage, { mode: 0o700 })
    stagedPaths.push(sessionsStage, storagesStage)

    const byPath = new Map(files.map(file => [file.path, file]))
    for (const file of files) {
      if (file.path.startsWith('.dsh/sessions/')) {
        await writeStagedFile(join(sessionsStage, file.path.slice('.dsh/sessions/'.length)), file.content)
      } else if (file.path.startsWith('.dsh/storages/')) {
        await writeStagedFile(join(storagesStage, file.path.slice('.dsh/storages/'.length)), file.content)
      }
    }

    const replacements: Replacement[] = [
      { target: sessionsTarget, staged: sessionsStage },
      { target: storagesTarget, staged: storagesStage },
    ]
    for (const archiveDataPath of DATA_PATHS) {
      const target = join(dataDir, archiveDataPath.slice('data/'.length))
      const file = byPath.get(archiveDataPath)
      if (file === undefined) replacements.push({ target })
      else {
        const staged = `${target}.jarvis-new-${suffix}`
        await writeStagedFile(staged, file.content)
        stagedPaths.push(staged)
        replacements.push({ target, staged })
      }
    }

    const cleanupWarnings = await commitReplacements(replacements, suffix)
    await chmod(sessionsTarget, 0o700)
    await chmod(storagesTarget, 0o700)
    await chmod(dataDir, 0o700)
    return { fileCount: files.length, cleanupWarnings }
  } finally {
    for (const path of stagedPaths) await rm(path, { recursive: true, force: true })
    if (createdDshHome) {
      try {
        if ((await readdir(dshHome)).length === 0) await rm(dshHome)
      } catch {}
    }
    if (createdDataDir) {
      try {
        if ((await readdir(dataDir)).length === 0) await rm(dataDir)
      } catch {}
    }
    await lease.release()
  }
}
