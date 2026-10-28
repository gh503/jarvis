import { create, Parser, extract } from 'tar'
import { lstat, readdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { dirname, join, posix, resolve, win32 } from 'node:path'

export const archiveLimit = 1_000_000_000
export const privateDirectories = ['file-history', 'artifacts', 'task-output']
export const configurationFiles = ['tuning.json', 'model-config.json', 'voice-config.json', 'mcp-config.json', 'local-tools.json', 'local-files.json']
const allowedFiles = new Set(['jarvis.db', 'sessions.db', 'local-tasks.db', 'manifest.json', ...configurationFiles])

/** Use the same conservative namespace on every OS, including Windows device/ADS rules. */
export function archivePath(raw: string): string {
  if (raw.includes('\\') || posix.isAbsolute(raw) || win32.isAbsolute(raw)) throw new Error(`unsafe entry path: ${raw}`)
  const name = raw.replace(/^\.\//, '').replace(/\/$/, '')
  if (name === '' || name === '.') return ''
  if (name.length > 4096 || posix.isAbsolute(name) || win32.isAbsolute(name)) throw new Error(`unsafe entry path: ${raw}`)
  for (const part of name.split('/')) {
    if (!part || part === '.' || part === '..' || /[\x00-\x1f\x7f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) throw new Error(`unsafe entry path: ${raw}`)
  }
  return name
}

function validator() {
  let bytes = 0, entries = 0
  const seen = new Set<string>()
  const spelling = new Map<string, string>()
  const files = new Set<string>()
  const parents = new Set<string>()
  return (raw: string, type: string, size: number) => {
    const name = archivePath(raw)
    const directory = type === 'Directory'
    const privateEntry = privateDirectories.some(dir => name === dir || name.startsWith(`${dir}/`))
    bytes += size
    if (++entries > 100_000 || !Number.isSafeInteger(size) || size < 0 || bytes > archiveLimit || (type !== 'File' && !directory) || (directory && size !== 0) || (name === '' ? !directory : !privateEntry && (!allowedFiles.has(name) || directory)) || (privateDirectories.includes(name) && !directory) || seen.has(name)) throw new Error(`unsafe entry in backup archive: ${raw}`)
    if (!directory && name.endsWith('.json') && !name.includes('/') && size > 8 * 1024 * 1024) throw new Error(`unsafe entry size: ${raw}`)
    seen.add(name)
    const parts = name.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/')
      const key = prefix.normalize('NFC').toLowerCase()
      if (spelling.has(key) && spelling.get(key) !== prefix) throw new Error(`unsafe entry alias: ${raw}`)
      spelling.set(key, prefix)
      if (i < parts.length) {
        if (files.has(key)) throw new Error(`unsafe entry parent: ${raw}`)
        parents.add(key)
      } else if (!directory) {
        if (parents.has(key)) throw new Error(`unsafe entry parent: ${raw}`)
        files.add(key)
      }
    }
  }
}

/** Called only on an immutable private staging copy, never the user's archive directly. */
export async function extractBackup(archive: string, destination: string): Promise<void> {
  const validate = validator()
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(archive)
    const parser = new Parser({ strict: true, maxMetaEntrySize: 1024 * 1024 })
    parser.on('entry', entry => {
      try { validate(entry.path, entry.type, entry.size); entry.resume() }
      catch (error) { parser.abort(error as Error) }
    })
    parser.on('ignoredEntry', () => parser.abort(new Error('unsafe entry type in backup archive')))
    parser.on('error', error => { input.destroy(); reject(error) })
    input.on('error', reject)
    parser.on('end', resolve)
    input.pipe(parser)
  })
  // No archive links, devices, ownership or absolute paths reach extraction. Repeat
  // validation on the extraction pass as defense in depth.
  const validateAgain = validator()
  await extract({ file: archive, cwd: destination, strict: true, preservePaths: false, noChmod: true, noMtime: true, maxMetaEntrySize: 1024 * 1024,
    filter: (path, entry) => { if (!('type' in entry)) throw new Error('unsafe entry metadata'); validateAgain(path, entry.type, entry.size); return true } })
}

export async function createBackup(directory: string, output: string): Promise<void> {
  const validate = validator()
  async function walk(relative: string): Promise<void> {
    const info = await lstat(join(directory, relative))
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw new Error(`unsafe entry in backup archive: ${relative}`)
    validate(relative, info.isDirectory() ? 'Directory' : 'File', info.isDirectory() ? 0 : info.size)
    if (info.isDirectory()) for (const child of await readdir(join(directory, relative))) await walk(relative ? `${relative}/${child}` : child)
  }
  await walk('')
  const target = resolve(output)
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.nlink !== 1) throw new Error('unsafe backup output')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  // Stage on the destination filesystem, then atomically replace regular output.
  // Never truncate an existing file or follow an output symlink.
  const staging = await mkdtemp(join(dirname(target), '.jarvis-backup-'))
  try {
    const temporary = join(staging, 'backup.tar.gz')
    await pipeline(create({ cwd: directory, gzip: true, portable: true, follow: false }, ['.']), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
    await rename(temporary, target)
  } finally { await rm(staging, { recursive: true, force: true }) }
}

/** Choose path semantics from the archived path, not the machine doing restore. */
export function remapPrivatePath(path: unknown, from: string | undefined, to: string): unknown {
  if (typeof path !== 'string' || !from) return path
  const flavor = win32.isAbsolute(from) && !posix.isAbsolute(from) ? win32 : posix
  if (!flavor.isAbsolute(from) || !flavor.isAbsolute(path)) return path
  const suffix = flavor.relative(from, path)
  if (!suffix || flavor.isAbsolute(suffix) || suffix.split(/[\\/]/).some(part => part === '..')) return path
  return join(to, ...suffix.split(/[\\/]/))
}
