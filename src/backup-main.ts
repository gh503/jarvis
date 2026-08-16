import { resolve } from 'node:path'
import { createBackup, restoreBackup } from './backup.js'

function parseOptions(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>()
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (key === undefined || value === undefined || !key.startsWith('--')) throw new Error('options must use --name value pairs')
    if (parsed.has(key)) throw new Error(`duplicate option: ${key}`)
    parsed.set(key, value)
  }
  return parsed
}

function onlyKnown(options: Map<string, string>, allowed: string[]): void {
  for (const key of options.keys()) if (!allowed.includes(key)) throw new Error(`unknown option: ${key}`)
}

const command = process.argv[2]
const options = parseOptions(process.argv.slice(3))
const projectRoot = resolve(import.meta.dirname, '..')
const dshHome = resolve(options.get('--dsh-home') ?? process.env.DSH_HOME ?? resolve(projectRoot, '.dsh'))
const dataDir = resolve(options.get('--data-dir') ?? process.env.JARVIS_DATA_DIR ?? resolve(projectRoot, 'data'))
const runtimeDir = resolve(options.get('--runtime-dir') ?? process.env.JARVIS_RUNTIME_DIR ?? resolve(projectRoot, '.jarvis-runtime'))

if (command === 'backup') {
  onlyKnown(options, ['--output', '--dsh-home', '--data-dir', '--runtime-dir'])
  const output = options.get('--output')
  if (output === undefined) throw new Error('backup requires --output <archive>')
  const result = await createBackup({ outputPath: resolve(output), dshHome, dataDir, runtimeDir })
  console.log(`Jarvis backup created: ${result.path} (${result.fileCount} files, ${result.bytes} bytes)`)
} else if (command === 'restore') {
  onlyKnown(options, ['--archive', '--dsh-home', '--data-dir', '--runtime-dir'])
  const archive = options.get('--archive')
  if (archive === undefined) throw new Error('restore requires --archive <archive>')
  const result = await restoreBackup({ archivePath: resolve(archive), dshHome, dataDir, runtimeDir })
  console.log(`Jarvis backup restored: ${result.fileCount} files`)
  for (const warning of result.cleanupWarnings) console.warn(warning)
} else {
  throw new Error('usage: backup-main <backup|restore> [options]')
}
