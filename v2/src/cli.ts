import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureRuntimeDirs, loadConfig } from './config.ts'
import { MemoryStore } from './memory/store.ts'
import { NullEmbedder } from './memory/embedding.ts'
import { ReminderStore } from './proactive/reminders.ts'

function usage(): never {
  console.error(`Usage:
  jarvis-v2 memory list [query]
  jarvis-v2 memory add <content>
  jarvis-v2 memory forget <id>
  jarvis-v2 memory consolidate
  jarvis-v2 memory export [file]
  jarvis-v2 reminders list
  jarvis-v2 migrate-v1 <path-to-v1-json>`)
  process.exit(2)
}

async function main(): Promise<void> {
  const config = loadConfig()
  ensureRuntimeDirs(config)
  const dbFile = join(config.dataDir, 'jarvis.db')
  const [command, subcommand, ...rest] = process.argv.slice(2)
  if (!command) usage()

  if (command === 'migrate-v1') {
    if (!subcommand) usage()
    const store = new MemoryStore({ file: dbFile, embedder: new NullEmbedder() })
    const result = store.migrateV1(subcommand)
    console.log(JSON.stringify(result, null, 2))
    store.close()
    return
  }

  const memory = new MemoryStore({ file: dbFile, embedder: new NullEmbedder() })
  if (command === 'memory') {
    if (subcommand === 'list') {
      const query = rest.join(' ').trim()
      if (query) console.log(JSON.stringify(await memory.recall(query, { limit: 20, includeSensitive: true }), null, 2))
      else console.log(JSON.stringify(memory.list({ includeSensitive: true, includeInactive: true, limit: 200 }), null, 2))
    } else if (subcommand === 'add') {
      const content = rest.join(' ').trim()
      if (!content) usage()
      console.log(JSON.stringify(await memory.add({
        kind: 'semantic',
        content,
        sourceKind: 'user-confirmed',
        sourceRef: 'cli',
        trust: 'authoritative',
        confidence: 1,
        importance: { explicit: 1 },
        status: 'confirmed',
      }), null, 2))
    } else if (subcommand === 'forget') {
      if (!rest[0]) usage()
      console.log(JSON.stringify({ deleted: memory.delete(rest[0]) }))
    } else if (subcommand === 'consolidate') {
      console.log(JSON.stringify(await memory.consolidate(), null, 2))
    } else if (subcommand === 'export') {
      const output = rest[0] ?? join(config.dataDir, `memory-export-${Date.now()}.json`)
      await writeFile(output, JSON.stringify(memory.exportAll(), null, 2), { mode: 0o600 })
      console.log(output)
    } else {
      usage()
    }
    memory.close()
    return
  }

  if (command === 'reminders') {
    const reminders = new ReminderStore(dbFile)
    console.log(JSON.stringify(reminders.list(), null, 2))
    reminders.close()
    memory.close()
    return
  }

  memory.close()
  usage()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
