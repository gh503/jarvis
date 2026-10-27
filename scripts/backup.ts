#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  for (const name of ['jarvis.db', 'sessions.db']) {
    const source = join(dataDir, name)
    if (!existsSync(source)) continue
    const snapshot = join(work, name)
    const db = new DatabaseSync(source, { readOnly: true })
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`)
    } finally {
      db.close()
    }
    await chmod(snapshot, 0o600)
    files.push(name)
  }
  for (const name of ['tuning.json', ...(includeSecrets ? ['model-config.json', 'voice-config.json', 'mcp-config.json'] : [])]) {
    const source = join(dataDir, name)
    if (existsSync(source)) {
      await copyFile(source, join(work, name))
      await chmod(join(work, name), 0o600)
      files.push(name)
    }
  }
  const manifest = {
    product: 'jarvis-v2',
    version: '2.0.0',
    createdAt: new Date().toISOString(),
    dataDir,
    files,
    excluded: ['auth-token', 'secret.key (encryption key)', 'audio', 'captures', 'telemetry', 'logs', ...(includeSecrets ? [] : ['model-config.json / voice-config.json / mcp-config.json (contain credentials)'])],
    note: 'Restore while Jarvis is stopped. The database snapshot is consistent.',
  }
  await writeFile(join(work, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await runProcess('tar', ['-czf', output, '-C', work, '.'], { timeoutMs: 120_000 })
  await chmod(output, 0o600)
  const info = await (await import('node:fs/promises')).stat(output)
  console.log(JSON.stringify({ ok: true, output, bytes: info.size, files }, null, 2))
} finally {
  await rm(work, { recursive: true, force: true })
}
