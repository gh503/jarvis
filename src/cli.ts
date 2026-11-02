import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureRuntimeDirs, loadConfig } from './config.ts'
import { MemoryStore } from './memory/store.ts'
import { NullEmbedder } from './memory/embedding.ts'
import { ReminderStore } from './proactive/reminders.ts'
import { acquireLifecycleLock } from './runtime-lifecycle.ts'

class UsageError extends Error {}

function usage(): never {
  throw new UsageError(`Usage:
  jarvis-v2 memory list [query]
  jarvis-v2 memory add <content>
  jarvis-v2 memory forget <id>
  jarvis-v2 memory consolidate
  jarvis-v2 memory export [file]
  jarvis-v2 reminders list
  jarvis-v2 migrate-v1 <path-to-v1-json>`)
}

async function main(): Promise<void> {
  process.umask(0o077)
  const [command, subcommand, ...rest] = process.argv.slice(2)
  // Reject malformed commands before creating directories, credentials or databases.
  if (command === 'migrate-v1') {
    if (!subcommand || rest.length) usage()
  } else if (command === 'reminders') {
    if (subcommand !== 'list' || rest.length) usage()
  } else if (command === 'memory') {
    if (subcommand === 'add') {
      if (!rest.join(' ').trim()) usage()
    } else if (subcommand === 'forget') {
      if (rest.length !== 1 || !rest[0]) usage()
    } else if (subcommand === 'consolidate') {
      if (rest.length) usage()
    } else if (subcommand === 'export') {
      if (rest.length > 1 || rest[0] === '') usage()
    } else if (subcommand !== 'list') usage()
  } else usage()

  const config = loadConfig()
  const release = await acquireLifecycleLock(config.dataDir, 'runtime').catch(error => {
    throw new Error('Unable to acquire the data directory lock. Stop the Jarvis runtime before using the offline CLI.', { cause: error })
  })
  let memory: MemoryStore | undefined
  let reminders: ReminderStore | undefined
  try {
    ensureRuntimeDirs(config)
    const dbFile = join(config.dataDir, 'jarvis.db')
    if (command === 'reminders') {
      reminders = new ReminderStore(dbFile)
      console.log(JSON.stringify(reminders.list(), null, 2))
      return
    }

    memory = new MemoryStore({ file: dbFile, embedder: new NullEmbedder() })
    if (command === 'migrate-v1') {
      console.log(JSON.stringify(memory.migrateV1(subcommand!), null, 2))
    } else if (subcommand === 'list') {
      const query = rest.join(' ').trim()
      if (query) console.log(JSON.stringify(await memory.recall(query, { limit: 20, includeSensitive: true }), null, 2))
      else console.log(JSON.stringify(memory.list({ includeSensitive: true, includeInactive: true, limit: 200 }), null, 2))
    } else if (subcommand === 'add') {
      console.log(JSON.stringify(await memory.add({
        kind: 'semantic',
        content: rest.join(' ').trim(),
        sourceKind: 'user-confirmed',
        sourceRef: 'cli',
        trust: 'authoritative',
        confidence: 1,
        importance: { explicit: 1 },
        status: 'confirmed',
      }), null, 2))
    } else if (subcommand === 'forget') {
      console.log(JSON.stringify({ deleted: memory.delete(rest[0]) }))
    } else if (subcommand === 'consolidate') {
      console.log(JSON.stringify(await memory.consolidate(), null, 2))
    } else if (subcommand === 'export') {
      const output = rest[0] ?? join(config.dataDir, `memory-export-${Date.now()}.json`)
      await writeFile(output, JSON.stringify(memory.exportAll(), null, 2), { mode: 0o600 })
      console.log(output)
    }
  } finally {
    // Attempt every close even if one fails, and release ownership only afterward.
    try {
      reminders?.close()
    } finally {
      try { memory?.close() } finally { release() }
    }
  }
}

main().catch(error => {
  console.error(error instanceof UsageError ? error.message : error)
  process.exitCode = error instanceof UsageError ? 2 : 1
})
