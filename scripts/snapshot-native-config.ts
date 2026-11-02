#!/usr/bin/env node
/** Explicit configuration snapshots. No environment discovery or runtime activation. */
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type ConfigSnapshotArgs =
  | { action: 'create'; configFile: string; dataDir: string; destination: string }
  | { action: 'verify'; snapshot: string; manifestSha256: string }
  | { action: 'restore'; snapshot: string; manifestSha256: string; destination: string }

const usage = 'Usage: snapshot-native-config.ts create --config ABS --data ABS --destination ABS | verify --snapshot ABS --manifest-sha256 64lowerhex | restore --snapshot ABS --manifest-sha256 64lowerhex --destination ABS'

/** Reject incomplete, duplicate, or unknown options before loading snapshot code. */
export function parseConfigSnapshotArgs(args: readonly string[]): ConfigSnapshotArgs {
  const [action, ...rest] = args
  if (action !== 'create' && action !== 'verify' && action !== 'restore') throw new Error(usage)
  const required = action === 'create' ? ['--config', '--data', '--destination']
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
  if (action === 'create') return { action, configFile: values.get('--config')!, dataDir: values.get('--data')!, destination: values.get('--destination')! }
  const snapshot = values.get('--snapshot')!, manifestSha256 = values.get('--manifest-sha256')!
  return action === 'verify' ? { action, snapshot, manifestSha256 }
    : { action, snapshot, manifestSha256, destination: values.get('--destination')! }
}

export async function main(args: string[]): Promise<void> {
  let options: ConfigSnapshotArgs
  try { options = parseConfigSnapshotArgs(args) }
  catch { console.error(usage); process.exitCode = 2; return }
  try {
    const { createConfigSnapshot, verifyConfigSnapshot, restoreConfigSnapshot } = await import('./native-config-snapshot.ts')
    if (options.action === 'create') {
      const { snapshot, manifestSha256 } = await createConfigSnapshot(options)
      console.log(JSON.stringify({ snapshot, manifestSha256 }))
    } else if (options.action === 'verify') {
      await verifyConfigSnapshot(options)
      console.log(JSON.stringify({ verified: true, snapshot: options.snapshot, manifestSha256: options.manifestSha256 }))
    } else {
      const { destination, manifestSha256 } = await restoreConfigSnapshot(options)
      console.log(JSON.stringify({ destination, manifestSha256 }))
    }
  } catch (error) {
    // Never print stacks, causes, objects, or unbounded exception text.
    let message = 'Unexpected snapshot error'
    try {
      if (error instanceof Error && typeof error.message === 'string') {
        message = error.message.slice(0, 1024).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ') || message
      }
    } catch { /* Malformed thrown objects must not bypass the diagnostic bound. */ }
    console.error(`Native config snapshot failed: ${message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2))
