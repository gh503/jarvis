import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const DOCUMENT_VERSION = 1
const MAX_ITEMS = 1_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_CONTENT_BYTES = 4 * 1024
const MAX_REFERENCE_BYTES = 1_024
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export type MemoryClass = 'profile' | 'episodic'
export type MemorySensitivity = 'standard' | 'sensitive'
export type MemoryStatus = 'proposed' | 'confirmed' | 'rejected' | 'superseded' | 'expired'
export type MemorySourceKind = 'explicit-user' | 'model-candidate' | 'owner-edit'

export interface MemorySource {
  kind: MemorySourceKind
  reference: string | null
}

export interface MemoryRetention {
  kind: 'until-deleted' | 'expires-at'
  expiresAt: string | null
}

export interface MemoryItem {
  id: string
  ownerId: 'local-owner'
  class: MemoryClass
  content: string
  sensitivity: MemorySensitivity
  confidence: number
  source: MemorySource
  retention: MemoryRetention
  status: MemoryStatus
  createdAt: string
  updatedAt: string
  confirmedAt: string | null
  supersedesId: string | null
}

export interface MemoryDocument {
  version: typeof DOCUMENT_VERSION
  items: MemoryItem[]
}

export interface MemoryProposal {
  class: MemoryClass
  content: string
  sensitivity: MemorySensitivity
  confidence: number
  source: Omit<MemorySource, 'kind'> & { kind: 'explicit-user' | 'model-candidate' }
  retention: MemoryRetention
}

export interface MemoryStoreOptions {
  now?: () => Date
  randomUUID?: () => string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function boundedString(value: unknown, maxBytes: number, nullable = false): value is string | null {
  if (nullable && value === null) return true
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes && !value.includes('\0')
}

function canonicalTimestamp(value: unknown, nullable = false): value is string | null {
  if (nullable && value === null) return true
  if (typeof value !== 'string') return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function validSource(value: unknown): value is MemorySource {
  return record(value) && exactFields(value, ['kind', 'reference'])
    && ['explicit-user', 'model-candidate', 'owner-edit'].includes(String(value.kind))
    && boundedString(value.reference, MAX_REFERENCE_BYTES, true)
}

function validRetention(value: unknown): value is MemoryRetention {
  if (!record(value) || !exactFields(value, ['kind', 'expiresAt'])) return false
  if (value.kind === 'until-deleted') return value.expiresAt === null
  return value.kind === 'expires-at' && canonicalTimestamp(value.expiresAt)
}

function validItem(value: unknown): value is MemoryItem {
  if (!record(value) || !exactFields(value, [
    'id', 'ownerId', 'class', 'content', 'sensitivity', 'confidence', 'source', 'retention', 'status',
    'createdAt', 'updatedAt', 'confirmedAt', 'supersedesId',
  ])) return false
  if (!(typeof value.id === 'string' && ID_PATTERN.test(value.id) && value.ownerId === 'local-owner'
    && (value.class === 'profile' || value.class === 'episodic')
    && boundedString(value.content, MAX_CONTENT_BYTES)
    && (value.sensitivity === 'standard' || value.sensitivity === 'sensitive')
    && typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    && value.confidence >= 0 && value.confidence <= 1
    && validSource(value.source) && validRetention(value.retention)
    && ['proposed', 'confirmed', 'rejected', 'superseded', 'expired'].includes(String(value.status))
    && canonicalTimestamp(value.createdAt) && canonicalTimestamp(value.updatedAt)
    && canonicalTimestamp(value.confirmedAt, true)
    && (value.supersedesId === null || typeof value.supersedesId === 'string' && ID_PATTERN.test(value.supersedesId)))) return false
  const createdAt = new Date(value.createdAt as string).getTime()
  const updatedAt = new Date(value.updatedAt as string).getTime()
  const confirmedAt = value.confirmedAt === null ? null : new Date(value.confirmedAt as string).getTime()
  if (updatedAt < createdAt || (confirmedAt !== null && (confirmedAt < createdAt || confirmedAt > updatedAt))) return false
  if ((value.status === 'confirmed' || value.status === 'superseded') && confirmedAt === null) return false
  if ((value.status === 'proposed' || value.status === 'rejected') && confirmedAt !== null) return false
  if (value.retention.kind === 'expires-at' && new Date(value.retention.expiresAt as string).getTime() <= createdAt) return false
  return value.source.kind === 'owner-edit'
    ? value.supersedesId !== null && value.source.reference === value.supersedesId
      && (value.status === 'confirmed' || value.status === 'superseded' || value.status === 'expired')
    : value.supersedesId === null
}

export function validateMemoryDocument(value: unknown): MemoryDocument {
  if (!record(value) || !exactFields(value, ['version', 'items']) || value.version !== DOCUMENT_VERSION
    || !Array.isArray(value.items) || value.items.length > MAX_ITEMS || !value.items.every(validItem)) {
    throw new Error('memory document is invalid')
  }
  if (new Set(value.items.map(item => item.id)).size !== value.items.length) {
    throw new Error('memory document contains duplicate ids')
  }
  return structuredClone(value) as unknown as MemoryDocument
}

function normalizeProposal(value: MemoryProposal): MemoryProposal {
  const content = value.content.trim()
  if (!boundedString(content, MAX_CONTENT_BYTES)) throw new Error('memory content must contain 1 to 4096 UTF-8 bytes without NUL')
  if (value.class !== 'profile' && value.class !== 'episodic') throw new Error('memory class is invalid')
  if (value.sensitivity !== 'standard' && value.sensitivity !== 'sensitive') throw new Error('memory sensitivity is invalid')
  if (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new Error('memory confidence must be between 0 and 1')
  if ((value.source.kind !== 'explicit-user' && value.source.kind !== 'model-candidate')
    || !boundedString(value.source.reference, MAX_REFERENCE_BYTES, true)) throw new Error('memory source is invalid')
  if (!validRetention(value.retention)) throw new Error('memory retention is invalid')
  return structuredClone({ ...value, content })
}

function cloneItem(item: MemoryItem): MemoryItem {
  return structuredClone(item)
}

export class MemoryStore {
  readonly path: string
  private readonly now: () => Date
  private readonly createId: () => string
  private pending: Promise<void> = Promise.resolve()

  constructor(dataDir: string, options: MemoryStoreOptions = {}) {
    this.path = join(dataDir, 'memory.json')
    this.now = options.now ?? (() => new Date())
    this.createId = options.randomUUID ?? randomUUID
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await chmod(dirname(this.path), 0o700)
    try {
      const metadata = await lstat(this.path)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('memory file must be a regular file')
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      await writeFile(this.path, '{"version":1,"items":[]}\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    }
    await chmod(this.path, 0o600)
    await this.readDocument()
  }

  async propose(input: MemoryProposal): Promise<MemoryItem> {
    const proposal = normalizeProposal(input)
    if (proposal.retention.kind === 'expires-at'
      && new Date(proposal.retention.expiresAt as string).getTime() <= this.now().getTime()) {
      throw new Error('memory expiry must be in the future')
    }
    return this.mutate(document => {
      const duplicate = document.items.find(item => (item.status === 'proposed' || item.status === 'confirmed')
        && item.class === proposal.class && item.content === proposal.content
        && item.sensitivity === proposal.sensitivity && item.confidence === proposal.confidence
        && item.source.kind === proposal.source.kind
        && item.source.reference === proposal.source.reference
        && item.retention.kind === proposal.retention.kind && item.retention.expiresAt === proposal.retention.expiresAt)
      if (duplicate !== undefined) return { result: cloneItem(duplicate), changed: false }
      if (document.items.length >= MAX_ITEMS) throw new Error(`memory store cannot exceed ${MAX_ITEMS} items`)
      const timestamp = this.timestamp()
      const item: MemoryItem = {
        id: this.nextId(), ownerId: 'local-owner', class: proposal.class, content: proposal.content,
        sensitivity: proposal.sensitivity, confidence: proposal.confidence, source: proposal.source,
        retention: proposal.retention, status: 'proposed', createdAt: timestamp, updatedAt: timestamp,
        confirmedAt: null, supersedesId: null,
      }
      document.items.push(item)
      return { result: cloneItem(item), changed: true }
    })
  }

  async confirm(id: string): Promise<MemoryItem> {
    return this.transition(id, 'proposed', 'confirmed', true)
  }

  async reject(id: string): Promise<MemoryItem> {
    return this.transition(id, 'proposed', 'rejected', false)
  }

  async editConfirmed(id: string, content: string): Promise<MemoryItem> {
    const normalizedContent = content.trim()
    if (!boundedString(normalizedContent, MAX_CONTENT_BYTES)) throw new Error('memory content must contain 1 to 4096 UTF-8 bytes without NUL')
    return this.mutate(document => {
      const current = document.items.find(item => item.id === id)
      if (current === undefined) throw new Error(`memory not found: ${id}`)
      if (current.status !== 'confirmed') throw new Error('only a confirmed memory can be edited')
      if (document.items.length >= MAX_ITEMS) throw new Error(`memory store cannot exceed ${MAX_ITEMS} items`)
      const timestamp = this.timestamp()
      current.status = 'superseded'
      current.updatedAt = timestamp
      const edited: MemoryItem = {
        ...cloneItem(current), id: this.nextId(), content: normalizedContent,
        source: { kind: 'owner-edit', reference: current.id }, status: 'confirmed',
        createdAt: timestamp, updatedAt: timestamp, confirmedAt: timestamp, supersedesId: current.id,
      }
      document.items.push(edited)
      return { result: cloneItem(edited), changed: true }
    })
  }

  async delete(id: string): Promise<MemoryItem> {
    return this.mutate(document => {
      const index = document.items.findIndex(item => item.id === id)
      if (index < 0) throw new Error(`memory not found: ${id}`)
      const [deleted] = document.items.splice(index, 1)
      return { result: cloneItem(deleted as MemoryItem), changed: true }
    })
  }

  async list(): Promise<MemoryItem[]> {
    return this.mutate(document => ({
      result: document.items.map(cloneItem).sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      changed: false,
    }))
  }

  async recall(): Promise<MemoryItem[]> {
    return this.mutate(document => ({
      result: document.items.filter(item => item.status === 'confirmed').map(cloneItem)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      changed: false,
    }))
  }

  async recallReadOnly(): Promise<MemoryItem[]> {
    let result: MemoryItem[] = []
    const queued = this.pending.then(async () => {
      const now = this.now().getTime()
      const document = await this.readDocument()
      result = document.items.filter(item => item.status === 'confirmed'
        && (item.retention.kind === 'until-deleted'
          || new Date(item.retention.expiresAt as string).getTime() > now))
        .map(cloneItem).sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    })
    this.pending = queued.catch(() => undefined)
    await queued
    return result
  }

  async export(): Promise<MemoryDocument> {
    return this.mutate(document => ({ result: structuredClone(document), changed: false }))
  }

  private async transition(id: string, from: MemoryStatus, to: MemoryStatus, confirmed: boolean): Promise<MemoryItem> {
    return this.mutate(document => {
      const item = document.items.find(candidate => candidate.id === id)
      if (item === undefined) throw new Error(`memory not found: ${id}`)
      if (item.status !== from) throw new Error(`memory must be ${from} before becoming ${to}`)
      const timestamp = this.timestamp()
      item.status = to
      item.updatedAt = timestamp
      if (confirmed) item.confirmedAt = timestamp
      return { result: cloneItem(item), changed: true }
    })
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  private nextId(): string {
    const id = this.createId()
    if (!ID_PATTERN.test(id)) throw new Error('memory id generator returned an invalid id')
    return id
  }

  private expire(document: MemoryDocument): boolean {
    const now = this.now().getTime()
    let changed = false
    for (const item of document.items) {
      if ((item.status === 'proposed' || item.status === 'confirmed') && item.retention.kind === 'expires-at'
        && new Date(item.retention.expiresAt as string).getTime() <= now) {
        item.status = 'expired'
        item.updatedAt = new Date(now).toISOString()
        changed = true
      }
    }
    return changed
  }

  private async mutate<T>(operation: (document: MemoryDocument) => { result: T; changed: boolean }): Promise<T> {
    let result: T | undefined
    const queued = this.pending.then(async () => {
      const document = await this.readDocument()
      const expired = this.expire(document)
      const outcome = operation(document)
      result = outcome.result
      if (expired || outcome.changed) await this.writeDocument(document)
    })
    this.pending = queued.catch(() => undefined)
    await queued
    return result as T
  }

  private async readDocument(): Promise<MemoryDocument> {
    const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let content: Buffer
    try {
      const before = await handle.stat()
      if (!before.isFile()) throw new Error('memory file must be a regular file')
      if (before.size > MAX_FILE_BYTES) throw new Error(`memory file exceeds ${MAX_FILE_BYTES} bytes`)
      content = await handle.readFile()
      const after = await handle.stat()
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error('memory file changed while being read')
      }
    } finally {
      await handle.close()
    }
    try {
      return validateMemoryDocument(JSON.parse(content.toString('utf8')) as unknown)
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('memory file is not valid JSON')
      throw error
    }
  }

  private async writeDocument(document: MemoryDocument): Promise<void> {
    validateMemoryDocument(document)
    const content = `${JSON.stringify(document, null, 2)}\n`
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`memory file exceeds ${MAX_FILE_BYTES} bytes`)
    const temporary = `${this.path}.${process.pid}.${this.nextId()}.tmp`
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, this.path)
      await chmod(this.path, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
