import { join } from 'node:path'
import { atomicPrivateJson, readPrivateJson } from '../src/local-tools/private-storage.ts'

const journalMaxBytes = 64 * 1024

// The caller must verify the private transaction root and hold the updater lock.
// Private storage flushes the file before atomic replacement and syncs the parent
// on POSIX. Windows does not support directory fsync through node:fs.
export function readUpdateJournal(transaction: string): unknown {
  const value = readPrivateJson(join(transaction, 'journal.json'), journalMaxBytes)
  if (value === undefined) throw new Error('Missing native update journal')
  return value
}

export function writeUpdateJournal(transaction: string, value: unknown): void {
  atomicPrivateJson(join(transaction, 'journal.json'), value, journalMaxBytes)
}
