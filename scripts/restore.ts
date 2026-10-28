#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, resolve, relative, posix, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultDataDir } from '../src/config.ts'
import { acquireLifecycleLock } from '../src/runtime-lifecycle.ts'
import { archiveLimit, extractBackup, remapPrivatePath } from './backup-archive.ts'
import { SessionStore } from '../src/sessions.ts'
import { normalize, type ServerInput } from '../src/mcp/settings.ts'

const args = process.argv.slice(2)
const archive = args.find(arg => !arg.startsWith('--'))
if (!archive || !existsSync(archive)) {
  console.error('usage: npm run restore -- <backup.tar.gz> --yes')
  process.exit(2)
}
if (!args.includes('--yes')) {
  console.error('Refusing to overwrite data without --yes. Stop Jarvis first, then re-run.')
  process.exit(2)
}
const dataDir = resolve(process.env.JARVIS_DATA_DIR || defaultDataDir())
const localDirectories = ['file-history', 'artifacts', 'task-output']
const configs = ['tuning.json', 'model-config.json', 'voice-config.json', 'mcp-config.json', 'local-tools.json', 'local-files.json']
const work = await mkdtemp(join(tmpdir(), 'jarvis-restore-'))
let release: (() => void) | undefined
try {
  // --force is accepted for old callers, but never bypasses live ownership.
  release = await acquireLifecycleLock(dataDir, 'runtime')
  const archiveInfo = await lstat(archive)
  if (!archiveInfo.isFile() || archiveInfo.size > archiveLimit) throw new Error('backup archive is invalid or too large')
  // Both validation passes read the same private copy, preventing archive replacement
  // between inspection and extraction. The staging archive is outside the payload.
  const stagedArchive = join(work, 'input.tar.gz')
  await copyFile(archive, stagedArchive)
  if (statSync(stagedArchive).size > archiveLimit) throw new Error('backup archive is too large')
  const payload = join(work, 'payload')
  await mkdir(payload, { mode: 0o700 })
  await extractBackup(stagedArchive, payload)
  const manifestFile = join(payload, 'manifest.json')
  if (!existsSync(manifestFile)) throw new Error('archive has no manifest.json')
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { product?: string; files?: string[]; dataDir?: string }
  if (manifest.product !== 'jarvis-v2') throw new Error('archive is not a Jarvis v2 backup')
  const dbFile = join(payload, 'jarvis.db')
  if (!existsSync(dbFile)) throw new Error('archive has no jarvis.db')
  const databases = ['jarvis.db', ...['sessions.db', 'local-tasks.db'].filter(name => existsSync(join(payload, name)))]
  for (const name of databases) {
    const check = new DatabaseSync(join(payload, name), { readOnly: true })
    try {
      const results = check.prepare('PRAGMA integrity_check').all()
      if (results.length !== 1 || results[0].integrity_check !== 'ok') {
        throw new Error(`${name} integrity check failed`)
      }
      if (name === 'sessions.db') {
        // Build the reference in scratch space: never open the incoming database
        // with SessionStore, whose constructor migrates and recovers turns.
        const referenceFile = join(payload, 'session-schema.db')
        const store = new SessionStore({ file: referenceFile })
        store.close()
        const reference = new DatabaseSync(referenceFile, { readOnly: true })
        try {
          const version = check.prepare('PRAGMA user_version').get()!.user_version
          if (version !== 1 && version !== 2 && version !== reference.prepare('PRAGMA user_version').get()!.user_version) {
            throw new Error(`Unsupported sessions database version: ${version}`)
          }
          const schema = (db: DatabaseSync) => db.prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
          ).all()
          // Older versions have the same transcript schema, before context/journal tables.
          const expected = schema(reference).filter(row =>
            (version !== 1 || !['context_revisions', 'session_summaries'].includes(String(row.tbl_name)))
            && (Number(version) >= 3 || !['tool_steps', 'tool_calls'].includes(String(row.tbl_name))))
          if (JSON.stringify(schema(check)) !== JSON.stringify(expected)) {
            throw new Error('sessions.db does not match the SessionStore schema')
          }
          if (check.prepare('PRAGMA foreign_key_check').all().length) {
            throw new Error('sessions.db foreign key check failed')
          }
        } finally {
          reference.close()
        }
      }
    } finally {
      check.close()
    }
  }

  // A memory restore must never restart external MCP processes or reuse a prior
  // verification. If the archive omitted secrets, preserve destination credentials
  // privately but revoke their activation as well. Importing normalize is pure.
  const stagedMcp = join(payload, 'mcp-config.json')
  const retainedMcp = join(dataDir, 'mcp-config.json')
  const mcpSource = existsSync(stagedMcp) ? stagedMcp : existsSync(retainedMcp) ? retainedMcp : undefined
  if (mcpSource) {
    try {
      const readMcp = async (file: string) => {
        const info = await lstat(file)
        if (!info.isFile() || info.nlink !== 1 || info.size > 1_000_000) throw new Error('Invalid MCP configuration')
        const input = JSON.parse(await readFile(file, 'utf8'))
        if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision >= Number.MAX_SAFE_INTEGER || !Array.isArray(input.servers) || input.servers.length > 32) throw new Error('Invalid MCP configuration')
        const servers = input.servers.map((server: ServerInput) => normalize(server))
        if (new Set(servers.map((server: {id:string}) => server.id)).size !== servers.length) throw new Error('Invalid MCP configuration')
        return { revision: input.revision as number, servers }
      }
      const input = await readMcp(mcpSource)
      const existing = mcpSource !== retainedMcp && existsSync(retainedMcp) ? await readMcp(retainedMcp) : undefined
      const servers = input.servers.map((normalized: ReturnType<typeof normalize>) => {
        normalized.enabled = false
        if (normalized.preset) {
          delete normalized.preset.validatedFingerprint
          delete normalized.preset.verifiedAt
          delete normalized.preset.lastErrorCode
        }
        return normalized
      })
      if (new Set(servers.map((server: {id:string}) => server.id)).size !== servers.length) throw new Error('Invalid MCP configuration')
      await writeFile(stagedMcp, JSON.stringify({ revision: Math.max(input.revision, existing?.revision ?? 0) + 1, servers }, null, 2) + '\n', { mode: 0o600 })
    } catch {
      // JSON parsing and URL validation errors can embed credentials; never echo them.
      throw new Error('Invalid MCP configuration; restore aborted before changing destination')
    }
  }

  // Sanitize in scratch space before touching the destination. Never load settings
  // through LocalToolSettings here: archived grants may point at another machine.
  const settingsFile = join(payload, 'local-tools.json')
  let oldOutput = typeof manifest.dataDir === 'string' ? (win32.isAbsolute(manifest.dataDir) && !posix.isAbsolute(manifest.dataDir) ? win32 : posix).join(manifest.dataDir, 'artifacts') : undefined
  const hasLocalState = ['local-tools.json', 'local-files.json', 'local-tasks.db', ...localDirectories].some(name => existsSync(join(payload, name)))
  if (existsSync(settingsFile)) {
    const settings = JSON.parse(await readFile(settingsFile, 'utf8'))
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid local tool settings')
    if (typeof settings.outputDir === 'string' && (posix.isAbsolute(settings.outputDir) || win32.isAbsolute(settings.outputDir))) oldOutput = settings.outputDir
  }
  if (hasLocalState) await writeFile(settingsFile, JSON.stringify({ revision: 0, readRoots: [], writeRoots: [], outputDir: join(dataDir, 'artifacts'), webEnabled: false, shellEnabled: false, skillsDir: null }), { mode: 0o600 })
  const catalogFile = join(payload, 'local-files.json')
  if (existsSync(catalogFile)) {
    const catalog = JSON.parse(await readFile(catalogFile, 'utf8'))
    if (!Array.isArray(catalog) || catalog.some(item => !item || typeof item !== 'object' || typeof item.path !== 'string')) throw new Error('Invalid artifact catalog')
    for (const item of catalog) item.path = remapPrivatePath(item.path, oldOutput, join(dataDir, 'artifacts'))
    await writeFile(catalogFile, JSON.stringify(catalog), { mode: 0o600 })
  }
  const history = join(payload, 'file-history')
  if (existsSync(history)) for (const name of await readdir(history)) {
    if (!name.endsWith('.json')) continue
    const file = join(history, name)
    if (!(await lstat(file)).isFile()) throw new Error('Invalid history file')
    const record = JSON.parse(await readFile(file, 'utf8'))
    if (!record || typeof record !== 'object' || typeof record.path !== 'string') throw new Error('Invalid history record')
    record.path = remapPrivatePath(record.path, oldOutput, join(dataDir, 'artifacts'))
    await writeFile(file, JSON.stringify(record), { mode: 0o600 })
  }
  if (databases.includes('local-tasks.db')) {
    const tasks = new DatabaseSync(join(payload, 'local-tasks.db'))
    try {
      if (tasks.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','view')").all().length) throw new Error('Invalid task database schema')
      tasks.exec("UPDATE questions SET status='cancelled' WHERE status='pending'; UPDATE jobs SET status='interrupted',pid=NULL WHERE status IN ('running','cancelling')")
      for (const row of tasks.prepare('SELECT id,spill FROM jobs WHERE spill IS NOT NULL').all()) {
        // Spills are private owned files, never arbitrary absolute references.
        const id = String(row.id)
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid task output ID')
        tasks.prepare('UPDATE jobs SET spill=? WHERE id=?').run(join(dataDir, 'task-output', `${id}.log`), row.id)
      }
    } finally { tasks.close() }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const safety = await mkdtemp(`${dataDir}.pre-restore-${stamp}-`)
  await chmod(dataDir, 0o700).catch(() => undefined)
  await chmod(safety, 0o700).catch(() => undefined)
  const priorEntries = [...['jarvis.db', 'sessions.db', 'local-tasks.db'].flatMap(name => [name, `${name}-wal`, `${name}-shm`]), ...configs, ...localDirectories]
  async function validateDestination(path: string): Promise<void> {
    const info = await lstat(path)
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw new Error(`unsafe restore destination: ${path}`)
    if (info.isDirectory()) for (const child of await readdir(path)) await validateDestination(join(path, child))
  }
  if ((await lstat(dataDir)).isSymbolicLink()) throw new Error('Restore data directory must not be a symlink')
  for (const name of priorEntries) {
    try { await validateDestination(join(dataDir, name)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  for (const name of priorEntries) {
    if (existsSync(join(dataDir, name))) await cp(join(dataDir, name), join(safety, name), { recursive: true, preserveTimestamps: true })
  }

  for (const name of databases) {
    await rm(join(dataDir, `${name}-wal`), { force: true })
    await rm(join(dataDir, `${name}-shm`), { force: true })
    await copyFile(join(payload, name), join(dataDir, name))
    await chmod(join(dataDir, name), 0o600)
  }
  for (const name of configs) {
    if (existsSync(join(payload, name))) {
      await copyFile(join(payload, name), join(dataDir, name))
      await chmod(join(dataDir, name), 0o600)
    }
  }
  async function privateModes(path: string): Promise<void> {
    const info = await lstat(path)
    await chmod(path, info.isDirectory() ? 0o700 : 0o600)
    if (info.isDirectory()) for (const child of await readdir(path)) await privateModes(join(path, child))
  }
  for (const name of localDirectories) {
    if (!existsSync(join(payload, name))) continue
    // These fixed names resolve strictly beneath dataDir, already checked above.
    const destination = join(dataDir, name)
    if (relative(dataDir, destination) !== name) throw new Error('Invalid private destination')
    await rm(destination, { recursive: true, force: true })
    await cp(join(payload, name), destination, { recursive: true })
    await privateModes(destination)
  }
  if (hasLocalState) await mkdir(join(dataDir, 'artifacts'), { recursive: true, mode: 0o700 })
  const restored = [...databases, ...[...configs, ...localDirectories].filter(name => existsSync(join(payload, name)))]
  const sessions = databases.includes('sessions.db')
    ? 'sessions.db restored from backup.'
    : 'Legacy backup has no sessions.db; existing sessions.db and its WAL/SHM files were preserved.'
  console.log(JSON.stringify({ ok: true, restored, dataDir, safety, sessions }, null, 2))
} catch (error) {
  console.error(`restore failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  try { await rm(work, { recursive: true, force: true }) } finally { release?.() }
}
