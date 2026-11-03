#!/usr/bin/env node
/** Explicitly uninstall one completed generation; never recover or retry. */
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { InstallOptions } from './install-native.ts'

const usage = 'Usage: uninstall-native-install-transaction.ts uninstall-completed --expected-transaction-id UUID --platform darwin|win32 --arch x64|arm64 --home ABS --root ORIGINAL_ABS (win32 requires --app-data ABS --local-app-data ABS; darwin forbids them)'
const scope = { automaticRecovery: false, powerLossDurability: false, producerEnabled: false }

/** Validate every argument before importing operational modules or acquiring locks. */
export function parseNativeInstallCompletedUninstallArgs(argv: readonly string[]): { integration: InstallOptions; transactionId: string } | { help: true } {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const [action, ...rest] = argv
  if (action !== 'uninstall-completed' || rest.length % 2) throw new Error('invalid-arguments')
  const required = ['--expected-transaction-id', '--platform', '--arch', '--home', '--root']
  const allowed = [...required, '--app-data', '--local-app-data']
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!, value = rest[i + 1]!
    if (!allowed.includes(key) || values.has(key) || !value.trim() || value.startsWith('--') || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error('invalid-arguments')
    if (key === '--expected-transaction-id' ? !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
      : key === '--platform' ? !['darwin', 'win32'].includes(value)
      : key === '--arch' ? !['x64', 'arm64'].includes(value) : !isAbsolute(value)) throw new Error('invalid-arguments')
    values.set(key, value)
  }
  const platform = values.get('--platform') as InstallOptions['platform']
  if (platform === 'win32') required.push('--app-data', '--local-app-data')
  else if (values.has('--app-data') || values.has('--local-app-data')) throw new Error('invalid-arguments')
  if (required.some(key => !values.has(key))) throw new Error('invalid-arguments')
  return { transactionId: values.get('--expected-transaction-id')!, integration: {
    platform, arch: values.get('--arch')!, home: values.get('--home')!, root: values.get('--root')!,
    ...(platform === 'win32' ? { appData: values.get('--app-data')!, localAppData: values.get('--local-app-data')! } : {}),
  } }
}

export async function main(argv: string[]): Promise<void> {
  let options: ReturnType<typeof parseNativeInstallCompletedUninstallArgs>
  try { options = parseNativeInstallCompletedUninstallArgs(argv) }
  catch { console.error(JSON.stringify({ schemaVersion: 1, status: 'invalid-arguments' })); process.exitCode = 2; return }
  if ('help' in options) {
    console.log(JSON.stringify({ schemaVersion: 1, status: 'help', usage,
      description: 'Explicit caller-authorized removal of artifacts and receipt for one exact completed generation. The original root need not exist. No application configuration is loaded. Errors require review of retained evidence; never automatically retry, resume, or clean up.',
      limitations: 'Records are claims, not authentication. Cooperating writers only; no power-loss guarantee. Source reads use the legacy integration policy, not Windows ACL privacy verification.', scope }))
    return
  }
  try {
    const { uninstallCompletedNativeInstallTransaction } = await import('./native-install-completed-uninstall.ts')
    const result = await uninstallCompletedNativeInstallTransaction(options)
    console.log(JSON.stringify({ schemaVersion: 1, status: 'uninstalled-generation', transactionId: result.transactionId,
      archiveId: basename(dirname(result.archiveDirectory)), removedCount: result.removedPaths.length, scope }))
  } catch {
    // Refusal and late failure share one conservative report: mutation may have occurred.
    console.error(JSON.stringify({ schemaVersion: 1, status: 'outcome-uncertain', requiresReview: true }))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2))
