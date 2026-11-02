#!/usr/bin/env node
/** Explicit offline recovery sets. No environment discovery or runtime activation. */
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type RecoveryArgs =
  | { action: 'create'; bundle: string; bundleManifestSha256: string; configFile: string; dataDir: string; destination: string }
  | { action: 'verify'; recoverySet: string; manifestSha256: string }

const usage = 'Usage: recovery-native.ts create --bundle ABS --bundle-manifest-sha256 64lowerhex --config ABS --data ABS --destination ABS | verify --recovery-set ABS --manifest-sha256 64lowerhex'

/** Validate every option before importing the operation module. */
export function parseRecoveryArgs(args: readonly string[]): RecoveryArgs {
  const [action, ...rest] = args
  if (action !== 'create' && action !== 'verify') throw new Error(usage)
  const required = action === 'create'
    ? ['--bundle', '--bundle-manifest-sha256', '--config', '--data', '--destination']
    : ['--recovery-set', '--manifest-sha256']
  if (rest.length !== required.length * 2) throw new Error(usage)
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!, value = rest[i + 1]!
    if (!required.includes(key) || values.has(key) || !value || value.includes('\0')) throw new Error(usage)
    const digest = key === '--bundle-manifest-sha256' || key === '--manifest-sha256'
    if (digest ? !/^[a-f0-9]{64}$/.test(value) : !isAbsolute(value)) throw new Error(usage)
    values.set(key, value)
  }
  if (required.some(key => !values.has(key))) throw new Error(usage)
  if (action === 'create') return {
    action, bundle: values.get('--bundle')!, bundleManifestSha256: values.get('--bundle-manifest-sha256')!,
    configFile: values.get('--config')!, dataDir: values.get('--data')!, destination: values.get('--destination')!,
  }
  return { action, recoverySet: values.get('--recovery-set')!, manifestSha256: values.get('--manifest-sha256')! }
}

export async function main(args: string[]): Promise<void> {
  let options: RecoveryArgs
  try { options = parseRecoveryArgs(args) }
  catch { console.error(usage); process.exitCode = 2; return }
  try {
    const { createRecoverySet, verifyRecoverySet } = await import('./native-recovery-set.ts')
    if (options.action === 'create') {
      const { recoverySet, manifestSha256 } = await createRecoverySet(options)
      console.log(JSON.stringify({ recoverySet, manifestSha256 }))
    } else {
      await verifyRecoverySet(options)
      console.log(JSON.stringify({ verified: true, recoverySet: options.recoverySet, manifestSha256: options.manifestSha256 }))
    }
  } catch (error) {
    // Do not print stacks, causes, objects, or unbounded exception text.
    const prefix = 'Native recovery failed: '
    let message = 'Unexpected recovery error'
    try {
      if (error instanceof Error && typeof error.message === 'string') {
        message = error.message.slice(0, 1024 - prefix.length).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ') || message
      }
    } catch { /* Malformed thrown objects must not bypass the diagnostic bound. */ }
    console.error(prefix + message)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2))
