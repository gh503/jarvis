#!/usr/bin/env node
/** Explicit integration inventory snapshots; never install or activate integrations. */
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { InstallOptions } from './install-native.ts'

export type IntegrationSnapshotArgs =
  | { action: 'create'; integration: InstallOptions; destination: string }
  | { action: 'verify'; integration: InstallOptions; snapshot: string; manifestSha256: string }

const usage = 'Usage: snapshot-native-integration.ts create --platform darwin|win32 --arch x64|arm64 --home ABS --root ABS --destination ABS | verify --platform darwin|win32 --arch x64|arm64 --home ABS --root ABS --snapshot ABS --manifest-sha256 64lowerhex (win32 requires --app-data ABS --local-app-data ABS; darwin forbids them)'

/** Parse the complete explicit context before importing any operational modules. */
export function parseIntegrationSnapshotArgs(args: readonly string[]): IntegrationSnapshotArgs {
  const [action, ...rest] = args
  if (action !== 'create' && action !== 'verify') throw new Error(usage)
  const required = ['--platform', '--arch', '--home', '--root', ...(action === 'create' ? ['--destination'] : ['--snapshot', '--manifest-sha256'])]
  const allowed = [...required, '--app-data', '--local-app-data']
  const values = new Map<string, string>()
  if (rest.length % 2) throw new Error(usage)
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!, value = rest[i + 1]!
    if (!allowed.includes(key) || values.has(key) || !value || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error(usage)
    if (key === '--platform' ? !['darwin', 'win32'].includes(value)
      : key === '--arch' ? !['x64', 'arm64'].includes(value)
        : key === '--manifest-sha256' ? !/^[a-f0-9]{64}$/.test(value) : !isAbsolute(value)) throw new Error(usage)
    values.set(key, value)
  }
  const platform = values.get('--platform') as InstallOptions['platform']
  if (platform === 'win32') required.push('--app-data', '--local-app-data')
  else if (values.has('--app-data') || values.has('--local-app-data')) throw new Error(usage)
  if (required.some(key => !values.has(key))) throw new Error(usage)
  const integration: InstallOptions = { platform, arch: values.get('--arch')!, home: values.get('--home')!, root: values.get('--root')!,
    ...(platform === 'win32' ? { appData: values.get('--app-data')!, localAppData: values.get('--local-app-data')! } : {}) }
  return action === 'create' ? { action, integration, destination: values.get('--destination')! }
    : { action, integration, snapshot: values.get('--snapshot')!, manifestSha256: values.get('--manifest-sha256')! }
}

export async function main(args: string[]): Promise<void> {
  let options: IntegrationSnapshotArgs
  try { options = parseIntegrationSnapshotArgs(args) }
  catch { console.error(usage); process.exitCode = 2; return }
  try {
    const { createIntegrationSnapshot, verifyIntegrationSnapshot } = await import('./native-integration-snapshot.ts')
    if (options.action === 'create') {
      const { snapshot, manifestSha256 } = await createIntegrationSnapshot(options)
      console.log(JSON.stringify({ snapshot, manifestSha256 }))
    } else {
      await verifyIntegrationSnapshot(options)
      console.log(JSON.stringify({ verified: true, snapshot: options.snapshot, manifestSha256: options.manifestSha256 }))
    }
  } catch {
    // Exception text can contain private payloads, paths, or child-process output.
    // A fixed diagnostic is sanitized and bounded even for hostile thrown objects.
    console.error('Native integration snapshot failed: unable to complete the requested operation')
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2))
