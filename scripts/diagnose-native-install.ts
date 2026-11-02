#!/usr/bin/env node
/** Diagnose fixed integration slots; never install, remove, or activate them. */
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { InstallOptions } from './install-native.ts'

const usage = 'Usage: diagnose-native-install.ts diagnose --platform darwin|win32 --arch x64|arm64 --home ABS --root ABS (win32 requires --app-data ABS --local-app-data ABS; darwin forbids them)'

/** Validate the complete explicit context before importing operational modules. */
export function parseNativeInstallDiagnosisArgs(argv: readonly string[]): { integration: InstallOptions } {
  const [action, ...rest] = argv
  if (action !== 'diagnose') throw new Error(usage)
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
  let options: ReturnType<typeof parseNativeInstallDiagnosisArgs>
  try { options = parseNativeInstallDiagnosisArgs(argv) }
  catch { console.error(usage); process.exitCode = 2; return }
  try {
    const { diagnoseNativeInstallIntent } = await import('./native-install-diagnose.ts')
    // Every returned status means diagnosis executed successfully, not healthy installation.
    console.log(JSON.stringify(await diagnoseNativeInstallIntent(options)))
  } catch {
    // Never disclose exception text, private bytes, bindings, or a stack trace.
    console.error('Native install diagnosis failed: unable to complete the requested operation')
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2))
