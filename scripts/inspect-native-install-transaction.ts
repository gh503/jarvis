#!/usr/bin/env node
/** Inspect preparation and acknowledgements; never publish, recover, or execute. */
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { InstallOptions } from './install-native.ts'

const usage = 'Usage: inspect-native-install-transaction.ts inspect --platform darwin|win32 --arch x64|arm64 --home ABS --root ABS (win32 requires --app-data ABS --local-app-data ABS; darwin forbids them)'
const help = `${usage}
       inspect-native-install-transaction.ts --help

Outputs one fixed JSON report. All context is explicit; no application config is loaded.
Read-only for installation files; operational lock directories and SQLite files may be created.
Exit 0: report produced (any status) or help; 2: invalid arguments; 1: unable to produce a report.
no-transaction means preparation is missing, not that installation is healthy or absent.
Receipt observations do not prove completion, ownership, execution, or permission to recover.
Cooperating writers only; observations are not atomic and acknowledgements are not authenticated.
Source reads use the legacy integration policy, not Windows ACL privacy verification.
`

/** Reject malformed input before importing any operational module. */
export function parseNativeInstallTransactionInspectionArgs(argv: readonly string[]): { integration: InstallOptions } | { help: true } {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const [action, ...rest] = argv
  if (action !== 'inspect') throw new Error(usage)
  const required = ['--platform', '--arch', '--home', '--root']
  const allowed = [...required, '--app-data', '--local-app-data']
  const values = new Map<string, string>()
  if (rest.length % 2) throw new Error(usage)
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!, value = rest[i + 1]!
    if (!allowed.includes(key) || values.has(key) || !value || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error(usage)
    if (key === '--platform' ? !['darwin', 'win32'].includes(value)
      : key === '--arch' ? !['x64', 'arm64'].includes(value) : !isAbsolute(value)) throw new Error(usage)
    values.set(key, value)
  }
  const platform = values.get('--platform') as InstallOptions['platform']
  if (platform === 'win32') required.push('--app-data', '--local-app-data')
  else if (values.has('--app-data') || values.has('--local-app-data')) throw new Error(usage)
  if (required.some(key => !values.has(key))) throw new Error(usage)
  return { integration: { platform, arch: values.get('--arch')!, home: values.get('--home')!, root: values.get('--root')!,
    ...(platform === 'win32' ? { appData: values.get('--app-data')!, localAppData: values.get('--local-app-data')! } : {}) } }
}

export async function main(argv: string[]): Promise<void> {
  let options: ReturnType<typeof parseNativeInstallTransactionInspectionArgs>
  try { options = parseNativeInstallTransactionInspectionArgs(argv) }
  catch { console.error(usage); process.exitCode = 2; return }
  if ('help' in options) { console.log(help); return }
  try {
    const { inspectNativeInstallTransaction } = await import('./native-install-transaction-inspect.ts')
    // A report is an observation, never a successful-installation assertion.
    console.log(JSON.stringify(await inspectNativeInstallTransaction(options)))
  } catch {
    // Never print exception text, input paths, environment values, or raw stacks.
    console.error('Native install transaction inspection failed: unable to complete the requested operation')
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2))
