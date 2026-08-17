import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { appendFile, chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MemoryStore, type MemoryDocument, type MemoryItem, type MemoryProposal } from './memory.js'

const INFO_FILE = 'memory-service.json'
const LOCK_DIRECTORY = '.memory-writer.lock'
const MAX_REQUEST_BYTES = 16 * 1024
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

type MemoryCommand =
  | { version: 1; command: 'propose'; proposal: MemoryProposal }
  | { version: 1; command: 'list' | 'recall' | 'export' }
  | { version: 1; command: 'confirm' | 'reject' | 'delete'; id: string }
  | { version: 1; command: 'edit'; id: string; content: string }

type MemoryResult = MemoryItem | MemoryItem[] | MemoryDocument

export interface MemoryOperations {
  propose(proposal: MemoryProposal): Promise<MemoryItem>
  list(): Promise<MemoryItem[]>
  recall(): Promise<MemoryItem[]>
  recallReadOnly(): Promise<MemoryItem[]>
  confirm(id: string): Promise<MemoryItem>
  reject(id: string): Promise<MemoryItem>
  editConfirmed(id: string, content: string): Promise<MemoryItem>
  delete(id: string): Promise<MemoryItem>
  export(): Promise<MemoryDocument>
}

interface ServiceInfo {
  version: 1
  pid: number
  url: string
  token: string
  startedAt: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const expected = [...fields].sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function parseCommand(value: unknown): MemoryCommand {
  if (!record(value) || value.version !== 1 || typeof value.command !== 'string') throw new Error('memory command is invalid')
  if (['list', 'recall', 'export'].includes(value.command) && exact(value, ['version', 'command'])) return value as MemoryCommand
  if (['confirm', 'reject', 'delete'].includes(value.command) && exact(value, ['version', 'command', 'id'])
    && typeof value.id === 'string' && ID_PATTERN.test(value.id)) return value as MemoryCommand
  if (value.command === 'edit' && exact(value, ['version', 'command', 'id', 'content'])
    && typeof value.id === 'string' && ID_PATTERN.test(value.id) && typeof value.content === 'string') return value as MemoryCommand
  if (value.command === 'propose' && exact(value, ['version', 'command', 'proposal']) && record(value.proposal)) return value as MemoryCommand
  throw new Error('memory command is invalid')
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function acquireWriterLease(dataDir: string, role: string): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await chmod(dataDir, 0o700)
  const lockPath = join(dataDir, LOCK_DIRECTORY)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 })
      await writeFile(join(lockPath, 'owner.json'), `${JSON.stringify({ version: 1, pid: process.pid, role })}\n`, {
        mode: 0o600, flag: 'wx',
      })
      return async () => rm(lockPath, { recursive: true, force: true })
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      let owner: unknown
      try {
        owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'))
      } catch {
        throw new Error('memory writer lock is malformed; verify Jarvis is stopped before removing it')
      }
      const pid = record(owner) ? owner.pid : undefined
      if (!Number.isSafeInteger(pid) || (pid as number) < 1 || processAlive(pid as number)) {
        throw new Error('memory writer is already active')
      }
      await rm(lockPath, { recursive: true, force: true })
    }
  }
  throw new Error('memory writer lock is unavailable')
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_REQUEST_BYTES) throw new Error('memory request is too large')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function authorized(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false
  const supplied = Buffer.from(value.slice(7))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

async function execute(store: MemoryStore, command: MemoryCommand): Promise<MemoryResult> {
  if (command.command === 'propose') return store.propose(command.proposal)
  if (command.command === 'list') return store.list()
  if (command.command === 'recall') return store.recallReadOnly()
  if (command.command === 'export') return store.export()
  if (command.command === 'confirm') return store.confirm(command.id)
  if (command.command === 'reject') return store.reject(command.id)
  if (command.command === 'delete') return store.delete(command.id)
  if (command.command === 'edit') return store.editConfirmed(command.id, command.content)
  throw new Error('memory command is unsupported')
}

function send(response: import('node:http').ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

export class MemoryService {
  private readonly dataDir: string
  private server: Server | undefined
  private releaseWriter: (() => Promise<void>) | undefined
  private info: ServiceInfo | undefined
  private readonly auditPath: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.auditPath = join(dataDir, 'memory-audit.jsonl')
  }

  async start(port = 0): Promise<ServiceInfo> {
    if (this.server !== undefined) throw new Error('memory service is already started')
    this.releaseWriter = await acquireWriterLease(this.dataDir, 'memory-service')
    try {
      const store = new MemoryStore(this.dataDir)
      await store.initialize()
      await appendFile(this.auditPath, '', { mode: 0o600 })
      await chmod(this.auditPath, 0o600)
      const token = randomBytes(32).toString('base64url')
      const server = createServer(async (request, response) => {
        if (request.method !== 'POST' || request.url !== '/v1/memory/commands' || request.headers.origin !== undefined) {
          send(response, 404, { version: 1, ok: false, error: 'not_found' })
          return
        }
        if (!authorized(request, token)) {
          send(response, 401, { version: 1, ok: false, error: 'unauthorized' })
          return
        }
        let command: MemoryCommand | undefined
        try {
          command = parseCommand(await readBody(request))
          const result = await execute(store, command)
          await this.audit(command.command, true)
          send(response, 200, { version: 1, ok: true, result })
        } catch (error) {
          if (command !== undefined) await this.audit(command.command, false)
          send(response, 400, { version: 1, ok: false, error: 'operation_failed',
            message: error instanceof Error ? error.message.slice(0, 300) : 'memory operation failed' })
        }
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('memory service address is unavailable')
      this.server = server
      this.info = { version: 1, pid: process.pid, url: `http://127.0.0.1:${address.port}`, token, startedAt: new Date().toISOString() }
      await this.writeInfo(this.info)
      return structuredClone(this.info)
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    await rm(join(this.dataDir, INFO_FILE), { force: true })
    if (this.server !== undefined) await new Promise<void>(resolve => this.server?.close(() => resolve()))
    this.server = undefined
    this.info = undefined
    if (this.releaseWriter !== undefined) await this.releaseWriter()
    this.releaseWriter = undefined
  }

  private async writeInfo(info: ServiceInfo): Promise<void> {
    const path = join(this.dataDir, INFO_FILE)
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(info)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
    await chmod(path, 0o600)
  }

  private async audit(command: string, ok: boolean): Promise<void> {
    await appendFile(this.auditPath, `${JSON.stringify({ version: 1, id: randomUUID(), time: new Date().toISOString(), command, ok })}\n`)
  }
}

export class MemoryServiceClient {
  private constructor(private readonly info: ServiceInfo) {}

  static async discover(dataDir: string): Promise<MemoryServiceClient | undefined> {
    const path = join(dataDir, INFO_FILE)
    let metadata
    try {
      metadata = await lstat(path)
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw new Error('memory service info is unsafe')
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!record(value) || !exact(value, ['version', 'pid', 'url', 'token', 'startedAt']) || value.version !== 1
      || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1 || typeof value.url !== 'string'
      || !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(value.url) || typeof value.token !== 'string'
      || !TOKEN_PATTERN.test(value.token) || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))) {
      throw new Error('memory service info is invalid')
    }
    return new MemoryServiceClient(value as unknown as ServiceInfo)
  }

  async command(command: MemoryCommand): Promise<MemoryResult> {
    let response: Response
    try {
      response = await fetch(`${this.info.url}/v1/memory/commands`, {
        method: 'POST', headers: { authorization: `Bearer ${this.info.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(command), signal: AbortSignal.timeout(5_000),
      })
    } catch {
      throw new Error('active memory service is unavailable')
    }
    const value = await response.json() as unknown
    if (!record(value) || value.version !== 1 || typeof value.ok !== 'boolean') throw new Error('memory service response is invalid')
    if (!response.ok || value.ok !== true) throw new Error(typeof value.message === 'string' ? value.message : 'memory service rejected the command')
    return value.result as MemoryResult
  }

  async recallReadOnly(): Promise<MemoryItem[]> {
    return await this.command({ version: 1, command: 'recall' }) as MemoryItem[]
  }

  async recall(): Promise<MemoryItem[]> { return this.recallReadOnly() }
  async list(): Promise<MemoryItem[]> { return await this.command({ version: 1, command: 'list' }) as MemoryItem[] }
  async export(): Promise<MemoryDocument> { return await this.command({ version: 1, command: 'export' }) as MemoryDocument }
  async propose(proposal: MemoryProposal): Promise<MemoryItem> {
    return await this.command({ version: 1, command: 'propose', proposal }) as MemoryItem
  }
  async confirm(id: string): Promise<MemoryItem> {
    return await this.command({ version: 1, command: 'confirm', id }) as MemoryItem
  }
  async reject(id: string): Promise<MemoryItem> {
    return await this.command({ version: 1, command: 'reject', id }) as MemoryItem
  }
  async editConfirmed(id: string, content: string): Promise<MemoryItem> {
    return await this.command({ version: 1, command: 'edit', id, content }) as MemoryItem
  }
  async delete(id: string): Promise<MemoryItem> {
    return await this.command({ version: 1, command: 'delete', id }) as MemoryItem
  }
}

export async function acquireDirectMemoryWriter(dataDir: string): Promise<() => Promise<void>> {
  return acquireWriterLease(dataDir, 'owner-cli')
}
