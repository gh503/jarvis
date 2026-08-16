import { randomUUID } from 'node:crypto'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

type HarnessMethod = 'session.list' | 'session.create' | 'session.history' | 'session.prompt' | 'session.cancel'

export type HarnessBridgeErrorCode = 'timeout' | 'unavailable' | 'protocol' | 'rejected'

export class HarnessBridgeError extends Error {
  readonly code: HarnessBridgeErrorCode
  readonly upstreamCode: string | undefined

  constructor(code: HarnessBridgeErrorCode, message: string, upstreamCode?: string) {
    super(message)
    this.name = 'HarnessBridgeError'
    this.code = code
    this.upstreamCode = upstreamCode
  }
}

export interface ConversationSummary {
  id: string
  title: string | null
  updatedAt: number
  running: boolean
  blank: boolean
}

export interface ConversationMessage {
  id: string
  sequence: number
  createdAt: number
  role: 'user' | 'assistant'
  text: string
}

export interface ConversationHistory {
  messages: ConversationMessage[]
  hasMore: boolean
  nextBeforeSequence: number | null
}

export interface HarnessClient {
  listConversations(): Promise<readonly ConversationSummary[]>
  createConversation(): Promise<{ id: string }>
  getConversationHistory(id: string, beforeSequence?: number, maxMessages?: number): Promise<ConversationHistory>
  sendText(id: string, text: string, mode: 'queue' | 'steer'): Promise<{ accepted: true }>
  cancelConversation(id: string): Promise<{ accepted: true }>
}

export interface HarnessBridgeOptions {
  origin?: string
  timeoutMs?: number
  maxResponseBytes?: number
  fetch?: typeof fetch
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  return value
}

function validateOrigin(value: string): URL {
  const origin = new URL(value)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
    || origin.username !== '' || origin.password !== '' || origin.pathname !== '/'
    || origin.search !== '' || origin.hash !== '') {
    throw new Error('Harness origin must be an exact http://127.0.0.1[:port] origin')
  }
  return origin
}

function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new HarnessBridgeError('protocol', 'Harness returned an invalid session id')
  }
  return value
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HarnessBridgeError('protocol', `Harness returned an invalid ${name}`)
  }
  return value
}

function titleFrom(value: Record<string, unknown>): string | null {
  const projections = value.projections
  if (!record(projections) || !record(projections.values)) return null
  const title = projections.values.title
  return typeof title === 'string' ? title : null
}

function textFromBlocks(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap(block => record(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('')
}

function messageFromEntry(value: unknown): ConversationMessage | undefined {
  if (!record(value) || !record(value.event)) return undefined
  const event = value.event
  if (event.surfaceOp !== 'append') return undefined
  const sequence = event.seq
  const createdAt = event.time
  if (!Number.isInteger(sequence) || (sequence as number) < 0 || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return undefined
  if (event.type === 'user/message' && record(event.data) && record(event.data.source) && event.data.source.kind === 'user') {
    const text = textFromBlocks(event.data.content)
    if (typeof event.data.id !== 'string' || text.length === 0) return undefined
    return { id: event.data.id, sequence: sequence as number, createdAt, role: 'user', text }
  }
  if (event.type === 'assistant/message' && record(event.data) && record(event.data.message)) {
    const message = event.data.message
    const text = textFromBlocks(message.content)
    if (typeof message.id !== 'string' || text.length === 0) return undefined
    return { id: message.id, sequence: sequence as number, createdAt, role: 'assistant', text }
  }
  return undefined
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) {
    throw new HarnessBridgeError('protocol', 'Harness response exceeded the configured limit')
  }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new HarnessBridgeError('protocol', 'Harness response was not JSON')
  }
  if (response.body === null) throw new HarnessBridgeError('protocol', 'Harness response body was missing')
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > maxBytes) throw new HarnessBridgeError('protocol', 'Harness response exceeded the configured limit')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HarnessBridgeError('protocol', 'Harness response contained invalid JSON')
  }
}

export class HarnessBridge implements HarnessClient {
  private readonly origin: URL
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly fetchValue: typeof fetch

  constructor(options: HarnessBridgeOptions = {}) {
    this.origin = validateOrigin(options.origin ?? 'http://127.0.0.1:3080')
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 'maxResponseBytes')
    this.fetchValue = options.fetch ?? fetch
  }

  async listConversations(): Promise<readonly ConversationSummary[]> {
    const value = await this.call('session.list', {})
    if (!record(value) || !Array.isArray(value.items)) throw new HarnessBridgeError('protocol', 'Harness returned an invalid session list')
    return value.items.map(item => {
      if (!record(item) || typeof item.running !== 'boolean' || typeof item.blank !== 'boolean') {
        throw new HarnessBridgeError('protocol', 'Harness returned an invalid session summary')
      }
      return {
        id: requireSessionId(item.sessionId),
        title: titleFrom(item),
        updatedAt: requireFiniteNumber(item.updatedAt, 'session timestamp'),
        running: item.running,
        blank: item.blank,
      }
    })
  }

  async createConversation(): Promise<{ id: string }> {
    const value = await this.call('session.create', {})
    if (!record(value)) throw new HarnessBridgeError('protocol', 'Harness returned an invalid session creation result')
    return { id: requireSessionId(value.sessionId) }
  }

  async getConversationHistory(id: string, beforeSequence?: number, maxMessages = 50): Promise<ConversationHistory> {
    const sessionId = this.validateSessionId(id)
    if (beforeSequence !== undefined && (!Number.isInteger(beforeSequence) || beforeSequence < 0)) {
      throw new RangeError('beforeSequence must be a non-negative integer')
    }
    positiveInteger(maxMessages, 'maxMessages')
    const value = await this.call('session.history', {
      sessionId,
      ...(beforeSequence === undefined ? {} : { beforeSeq: beforeSequence }),
      maxMessages,
    })
    if (!record(value) || !Array.isArray(value.events) || typeof value.hasMore !== 'boolean') {
      throw new HarnessBridgeError('protocol', 'Harness returned an invalid session history')
    }
    const sequences = value.events.flatMap(entry => record(entry) && record(entry.event)
      && Number.isInteger(entry.event.seq) && (entry.event.seq as number) >= 0 ? [entry.event.seq as number] : [])
    return {
      messages: value.events.flatMap(entry => {
        const message = messageFromEntry(entry)
        return message === undefined ? [] : [message]
      }),
      hasMore: value.hasMore,
      nextBeforeSequence: value.hasMore && sequences.length > 0 ? Math.min(...sequences) : null,
    }
  }

  async sendText(id: string, text: string, mode: 'queue' | 'steer'): Promise<{ accepted: true }> {
    const sessionId = this.validateSessionId(id)
    if (typeof text !== 'string' || text.trim().length === 0 || Buffer.byteLength(text, 'utf8') > 16 * 1024 || text.includes('\0')) {
      throw new TypeError('conversation text must contain 1 to 16384 UTF-8 bytes without NUL')
    }
    if (text.trimStart().startsWith('/')) throw new TypeError('remote slash commands are not allowed')
    if (mode !== 'queue' && mode !== 'steer') throw new TypeError('conversation mode is invalid')
    const value = await this.call('session.prompt', { sessionId, mode, content: [{ type: 'text', text }] })
    if (!record(value) || value.accepted !== true) throw new HarnessBridgeError('protocol', 'Harness returned an invalid prompt receipt')
    return { accepted: true }
  }

  async cancelConversation(id: string): Promise<{ accepted: true }> {
    const value = await this.call('session.cancel', { sessionId: this.validateSessionId(id) })
    if (!record(value) || value.accepted !== true) throw new HarnessBridgeError('protocol', 'Harness returned an invalid cancellation receipt')
    return { accepted: true }
  }

  private validateSessionId(value: string): string {
    if (!SESSION_ID_PATTERN.test(value)) throw new TypeError('conversation id is invalid')
    return value
  }

  private async call(method: HarnessMethod, payload: Record<string, unknown>): Promise<unknown> {
    const rpcId = randomUUID()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), this.timeoutMs)
    timer.unref()
    try {
      const response = await this.fetchValue(new URL(`/api/${method}`, this.origin), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        redirect: 'error',
        signal: abort.signal,
      })
      if (!response.ok) throw new HarnessBridgeError('protocol', `Harness carrier returned HTTP ${response.status}`)
      const envelope = await readBoundedJson(response, this.maxResponseBytes)
      if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !record(envelope.result)
        || typeof envelope.result.ok !== 'boolean') {
        throw new HarnessBridgeError('protocol', 'Harness returned an invalid RPC envelope')
      }
      if (envelope.result.ok) {
        if (!Object.hasOwn(envelope.result, 'value')) throw new HarnessBridgeError('protocol', 'Harness response value was missing')
        return envelope.result.value
      }
      const error = envelope.result.error
      const upstreamCode = record(error) && typeof error.code === 'string' ? error.code : 'internal'
      throw new HarnessBridgeError('rejected', 'Harness rejected the request', upstreamCode)
    } catch (error) {
      if (error instanceof HarnessBridgeError) throw error
      if (abort.signal.aborted) throw new HarnessBridgeError('timeout', 'Harness request timed out')
      throw new HarnessBridgeError('unavailable', 'Harness is unavailable', undefined)
    } finally {
      clearTimeout(timer)
    }
  }
}
