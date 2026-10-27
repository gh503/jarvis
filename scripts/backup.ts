#!/usr/bin/env node
import { DatabaseSync, backup } from 'node:sqlite'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { defaultDataDir } from '../src/config.ts'
import { runProcess } from '../src/util/process.ts'

const args = process.argv.slice(2)
const dataDir = process.env.JARVIS_DATA_DIR || defaultDataDir()
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const output = args.find(arg => !arg.startsWith('--')) || join(homedir(), `jarvis-backup-${stamp}.tar.gz`)
const includeSecrets = args.includes('--include-secrets')

const work = await mkdtemp(join(tmpdir(), 'jarvis-backup-'))
try {
  const dbFile = join(dataDir, 'jarvis.db')
  if (!existsSync(dbFile)) throw new Error(`no database at ${dbFile}`)
  const files: string[] = []
  for (const name of ['jarvis.db', 'sessions.db', 'local-tasks.db']) {
    const source = join(dataDir, name)
    if (!existsSync(source)) continue
    const sourceInfo = await lstat(source)
    if (!sourceInfo.isFile() || sourceInfo.nlink !== 1) throw new Error(`unsafe database entry: ${name}`)
    const snapshot = join(work, name)
    const db = new DatabaseSync(source, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      await backup(db, snapshot)
    } finally {
      db.close()
    }
    await chmod(snapshot, 0o600)
    files.push(name)
  }
  for (const name of ['tuning.json', 'local-tools.json', 'local-files.json', ...(includeSecrets ? ['model-config.json', 'voice-config.json', 'mcp-config.json'] : [])]) {
    const source = join(dataDir, name)
    if (existsSync(source)) {
      const info = await lstat(source)
      if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) throw new Error(`unsafe config entry: ${name}`)
      await copyFile(source, join(work, name))
      await chmod(join(work, name), 0o600)
      files.push(name)
    }
  }
  // Only private, managed directories are copied; catalog source references are never followed.
  let privateBytes = 0
  async function copyPrivate(name: string): Promise<void> {
    const source = join(dataDir, name), destination = join(work, name)
    const info = await lstat(source)
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw new Error(`unsafe private backup entry: ${name}`)
    if (info.isDirectory()) {
      await mkdir(destination, { mode: 0o700 })
      for (const child of await readdir(source)) await copyPrivate(join(name, child))
    } else {
      privateBytes += info.size
      if (privateBytes > 1_000_000_000) throw new Error('private backup data is too large')
      await copyFile(source, destination)
      await chmod(destination, 0o600)
    }
  }
  for (const name of ['file-history', 'artifacts', 'task-output']) {
    if (!existsSync(join(dataDir, name))) continue
    await copyPrivate(name)
    files.push(name)
  }
  const manifest = {
    product: 'jarvis-v2',
    version: '2.0.0',
    createdAt: new Date().toISOString(),
    dataDir,
    files,
    excluded: ['auth-token', 'secret.key (encryption key)', 'audio', 'captures', 'telemetry', 'logs', ...(includeSecrets ? [] : ['model-config.json / voice-config.json / mcp-config.json (contain credentials)'])],
    sensitive: 'Includes private memory, transcripts, local settings paths, task text/output and file history. External source files are not copied.',
    note: 'Restore while Jarvis is stopped. Each database snapshot is consistent. Restored local tool permissions are disabled.',
  }
  await writeFile(join(work, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await runProcess('tar', ['-czf', output, '-C', work, '.'], { timeoutMs: 120_000 })
  await chmod(output, 0o600)
  const info = await (await import('node:fs/promises')).stat(output)
  console.log(JSON.stringify({ ok: true, output, bytes: info.size, files }, null, 2))
} finally {
  await rm(work, { recursive: true, force: true })
}
