#!/usr/bin/env node
/** Explicit local state snapshots. No configuration discovery or runtime activation. */
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type SnapshotArgs =
  | { action: 'create'; dataDir: string; destination: string }
  | { action: 'verify'; snapshot: string; manifestSha256: string }
  | { action: 'restore'; snapshot: string; manifestSha256: string; destination: string }

const usage = 'Usage: snapshot-native.ts create --data ABS --destination ABS | verify --snapshot ABS --manifest-sha256 64lowerhex | restore --snapshot ABS --manifest-sha256 64lowerhex --destination ABS'

/** Parsing is pure: reject incomplete, duplicated, or unknown arguments before loading state code. */
export function parseSnapshotArgs(args: readonly string[]): SnapshotArgs {
  const [action, ...rest] = args
  if (action !== 'create' && action !== 'verify' && action !== 'restore') throw new Error(usage)
  const required = action === 'create' ? ['--data', '--destination']
    : action === 'verify' ? ['--snapshot', '--manifest-sha256']
      : ['--snapshot', '--manifest-sha256', '--destination']
  if (rest.length !== required.length * 2) throw new Error(usage)
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!, value = rest[i + 1]!
    if (!required.includes(key) || values.has(key) || !value || value.includes('\0')) throw new Error(usage)
    if (key === '--manifest-sha256' ? !/^[a-f0-9]{64}$/.test(value) : !isAbsolute(value)) throw new Error(usage)
    values.set(key, value)
  }
  if (required.some(key => !values.has(key))) throw new Error(usage)
  if (action === 'create') return { action, dataDir: values.get('--data')!, destination: values.get('--destination')! }
  const snapshot = values.get('--snapshot')!, manifestSha256 = values.get('--manifest-sha256')!
  return action === 'verify' ? { action, snapshot, manifestSha256 }
    : { action, snapshot, manifestSha256, destination: values.get('--destination')! }
}

export async function main(args: string[]): Promise<void> {
  let options: SnapshotArgs
  try { options = parseSnapshotArgs(args) }
  catch { console.error(usage); process.exitCode = 2; return }
  try {
    const { createStateSnapshot, verifyStateSnapshot, restoreStateSnapshot } = await import('./native-state-snapshot.ts')
    if (options.action === 'create') {
      const { snapshot, manifestSha256 } = await createStateSnapshot(options)
      console.log(JSON.stringify({ snapshot, manifestSha256 }))
    } else if (options.action === 'verify') {
      const { snapshot, manifestSha256 } = await verifyStateSnapshot(options)
      console.log(JSON.stringify({ verified: true, snapshot, manifestSha256 }))
    } else {
      const { destination, manifestSha256 } = await restoreStateSnapshot(options)
      console.log(JSON.stringify({ destination, manifestSha256 }))
    }
  } catch (error) {
    // Never print stacks, causes, objects, or unbounded exception text.
    let message = 'Unexpected snapshot error'
    try {
      if (error instanceof Error && typeof error.message === 'string') {
        message = error.message.slice(0, 1024).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ') || message
      }
    } catch { /* A malformed thrown object must not bypass the diagnostic bound. */ }
    console.error(`Native state snapshot failed: ${message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2))
