import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { MemoryStore, type MemoryClass, type MemorySensitivity, type MemoryStatus } from './memory.js'

const MAX_INPUT_BYTES = 8 * 1024
const STATUSES: MemoryStatus[] = ['proposed', 'confirmed', 'rejected', 'superseded', 'expired']

function usage(): string {
  return [
    'Usage: npm run memory -- <command> [options]',
    '',
    'Commands:',
    '  propose --class <profile|episodic> [--sensitivity <standard|sensitive>] [--confidence <0..1>]',
    '  list [--status <status>]',
    '  recall',
    '  confirm --id <memory-id>',
    '  reject --id <memory-id>',
    '  edit --id <memory-id>',
    '  delete --id <memory-id>',
    '  export --output <new-file>',
    '',
    'New and edited content is read from an interactive prompt or standard input.',
    'All commands accept --data-dir <directory>.',
  ].join('\n')
}

function onlyOptions(values: Record<string, boolean | string | undefined>, allowed: readonly string[]): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== false && !allowed.includes(key)) throw new Error(`option --${key} is not valid for this command`)
  }
}

function required(values: Record<string, boolean | string | undefined>, name: string): string {
  const value = values[name]
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`--${name} is required`)
  return value.trim()
}

async function readContent(label: string): Promise<string> {
  if (stdin.isTTY && stdout.isTTY) {
    const prompt = createInterface({ input: stdin, output: stdout })
    try {
      return await prompt.question(`${label}: `)
    } finally {
      prompt.close()
    }
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_INPUT_BYTES) throw new Error(`standard input exceeds ${MAX_INPUT_BYTES} bytes`)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function print(value: unknown): void {
  stdout.write(`${JSON.stringify(value)}\n`)
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      help: { type: 'boolean' },
      'data-dir': { type: 'string' },
      id: { type: 'string' },
      class: { type: 'string' },
      sensitivity: { type: 'string' },
      confidence: { type: 'string' },
      'source-reference': { type: 'string' },
      'expires-at': { type: 'string' },
      status: { type: 'string' },
      output: { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
  })
  if (parsed.values.help === true) {
    stdout.write(`${usage()}\n`)
    return
  }
  if (parsed.positionals.length !== 1) throw new Error(usage())
  const command = parsed.positionals[0] as string
  const dataDir = resolve(parsed.values['data-dir'] ?? process.env.JARVIS_DATA_DIR ?? resolve(import.meta.dirname, '..', 'data'))
  const common = ['data-dir']
  const optionsByCommand: Record<string, string[]> = {
    propose: [...common, 'class', 'sensitivity', 'confidence', 'source-reference', 'expires-at'],
    list: [...common, 'status'],
    recall: common,
    confirm: [...common, 'id'],
    reject: [...common, 'id'],
    edit: [...common, 'id'],
    delete: [...common, 'id'],
    export: [...common, 'output'],
  }
  const allowed = optionsByCommand[command]
  if (allowed === undefined) throw new Error(`unknown memory command: ${command}`)
  onlyOptions(parsed.values, allowed)
  if (['confirm', 'reject', 'edit', 'delete'].includes(command)) required(parsed.values, 'id')
  if (command === 'propose') {
    const classValue = required(parsed.values, 'class')
    if (classValue !== 'profile' && classValue !== 'episodic') throw new Error('--class must be profile or episodic')
    const sensitivity = parsed.values.sensitivity ?? 'standard'
    if (sensitivity !== 'standard' && sensitivity !== 'sensitive') throw new Error('--sensitivity must be standard or sensitive')
    const confidence = parsed.values.confidence === undefined ? 1 : Number(parsed.values.confidence)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('--confidence must be between 0 and 1')
  }
  if (command === 'list' && parsed.values.status !== undefined
    && !STATUSES.includes(parsed.values.status as MemoryStatus)) throw new Error('--status is invalid')
  if (command === 'export') required(parsed.values, 'output')
  const content = command === 'propose' ? await readContent('Memory content')
    : command === 'edit' ? await readContent('Updated memory content') : undefined
  const store = new MemoryStore(dataDir)
  await store.initialize()

  if (command === 'propose') {
    const classValue = required(parsed.values, 'class')
    if (classValue !== 'profile' && classValue !== 'episodic') throw new Error('--class must be profile or episodic')
    const sensitivity = parsed.values.sensitivity ?? 'standard'
    if (sensitivity !== 'standard' && sensitivity !== 'sensitive') throw new Error('--sensitivity must be standard or sensitive')
    const confidence = parsed.values.confidence === undefined ? 1 : Number(parsed.values.confidence)
    const expiresAt = parsed.values['expires-at']
    const item = await store.propose({
      class: classValue as MemoryClass,
      content: content as string,
      sensitivity: sensitivity as MemorySensitivity,
      confidence,
      source: { kind: 'explicit-user', reference: parsed.values['source-reference'] ?? null },
      retention: expiresAt === undefined
        ? { kind: 'until-deleted', expiresAt: null }
        : { kind: 'expires-at', expiresAt },
    })
    print({ item })
    return
  }
  if (command === 'list') {
    const status = parsed.values.status
    const items = await store.list()
    print({ items: status === undefined ? items : items.filter(item => item.status === status) })
    return
  }
  if (command === 'recall') {
    print({ items: await store.recall() })
    return
  }
  if (command === 'export') {
    const output = resolve(required(parsed.values, 'output'))
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    const document = await store.export()
    await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(output, 0o600)
    print({ path: output, itemCount: document.items.length })
    return
  }

  const id = required(parsed.values, 'id')
  if (command === 'confirm') {
    print({ item: await store.confirm(id) })
  } else if (command === 'reject') {
    print({ item: await store.reject(id) })
  } else if (command === 'edit') {
    print({ item: await store.editConfirmed(id, content as string) })
  } else if (command === 'delete') {
    print({ item: await store.delete(id) })
  }
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : 'memory command failed'
  process.stderr.write(`Memory command failed: ${message}\n`)
  process.exitCode = 1
}
