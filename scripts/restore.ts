#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { defaultDataDir } from '../src/config.ts'
import { runProcess } from '../src/util/process.ts'
import { SessionStore } from '../src/sessions.ts'

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
const dataDir = process.env.JARVIS_DATA_DIR || defaultDataDir()
if (!args.includes('--force')) {
  const running = spawnSync('pgrep', ['-f', 'src/main.ts'], { encoding: 'utf8' })
  if (running.status === 0 && running.stdout.trim()) {
    console.error('Jarvis is still running. Stop it first, then re-run restore.')
    process.exit(2)
  }
}
const work = await mkdtemp(join(tmpdir(), 'jarvis-restore-'))
try {
  if (statSync(archive).size > 1_000_000_000) throw new Error('backup archive is too large')
  const listing = spawnSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (listing.status !== 0) throw new Error(`cannot list backup archive: ${listing.stderr || 'tar failed'}`)
  const allowed = new Set(['', 'jarvis.db', 'sessions.db', 'manifest.json', 'tuning.json', 'model-config.json', 'voice-config.json'])
  for (const line of listing.stdout.split('\n').filter(Boolean)) {
    const type = line[0]
    const name = line.trim().split(/\s+/).pop()?.replace(/^\.\//, '') ?? ''
    if ((type !== '-' && type !== 'd') || name.includes('..') || name.startsWith('/') || !allowed.has(name)) {
      throw new Error(`unsafe entry in backup archive: ${line.slice(0, 120)}`)
    }
  }
  await runProcess('tar', ['-xzf', archive, '-C', work], { timeoutMs: 120_000 })
  const manifestFile = join(work, 'manifest.json')
  if (!existsSync(manifestFile)) throw new Error('archive has no manifest.json')
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { product?: string; files?: string[] }
  if (manifest.product !== 'jarvis-v2') throw new Error('archive is not a Jarvis v2 backup')
  const dbFile = join(work, 'jarvis.db')
  if (!existsSync(dbFile)) throw new Error('archive has no jarvis.db')
  const databases = ['jarvis.db', ...(existsSync(join(work, 'sessions.db')) ? ['sessions.db'] : [])]
  for (const name of databases) {
    const check = new DatabaseSync(join(work, name), { readOnly: true })
    try {
      const results = check.prepare('PRAGMA integrity_check').all()
      if (results.length !== 1 || results[0].integrity_check !== 'ok') {
        throw new Error(`${name} integrity check failed`)
      }
      if (name === 'sessions.db') {
        // Build the reference in scratch space: never open the incoming database
        // with SessionStore, whose constructor migrates and recovers turns.
        const referenceFile = join(work, 'session-schema.db')
        const store = new SessionStore({ file: referenceFile })
        store.close()
        const reference = new DatabaseSync(referenceFile, { readOnly: true })
        try {
          const version = check.prepare('PRAGMA user_version').get()!.user_version
          if (version !== 1 && version !== reference.prepare('PRAGMA user_version').get()!.user_version) {
            throw new Error(`Unsupported sessions database version: ${version}`)
          }
          const schema = (db: DatabaseSync) => db.prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
          ).all()
          // v1 has the identical transcript schema, before derived context tables were added.
          const expected = schema(reference).filter(row => version !== 1
            || !['context_revisions', 'session_summaries'].includes(String(row.tbl_name)))
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

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safety = `${dataDir}.pre-restore-${stamp}`
  await runProcess('mkdir', ['-p', dataDir, join(safety)], { timeoutMs: 10_000 })
  await chmod(dataDir, 0o700).catch(() => undefined)
  await chmod(safety, 0o700).catch(() => undefined)
  for (const name of ['jarvis.db', 'jarvis.db-wal', 'jarvis.db-shm', 'sessions.db', 'sessions.db-wal', 'sessions.db-shm', 'tuning.json', 'model-config.json', 'voice-config.json']) {
    if (existsSync(join(dataDir, name))) await copyFile(join(dataDir, name), join(safety, name))
  }

  for (const name of databases) {
    await rm(join(dataDir, `${name}-wal`), { force: true })
    await rm(join(dataDir, `${name}-shm`), { force: true })
    await copyFile(join(work, name), join(dataDir, name))
    await chmod(join(dataDir, name), 0o600)
  }
  for (const name of ['tuning.json', 'model-config.json', 'voice-config.json']) {
    if (existsSync(join(work, name))) {
      await copyFile(join(work, name), join(dataDir, name))
      await chmod(join(dataDir, name), 0o600)
    }
  }
  const restored = [...databases, ...['tuning.json', 'model-config.json', 'voice-config.json'].filter(name => existsSync(join(work, name)))]
  const sessions = databases.includes('sessions.db')
    ? 'sessions.db restored from backup.'
    : 'Legacy backup has no sessions.db; existing sessions.db and its WAL/SHM files were preserved.'
  console.log(JSON.stringify({ ok: true, restored, dataDir, safety, sessions }, null, 2))
} catch (error) {
  console.error(`restore failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await rm(work, { recursive: true, force: true })
}
