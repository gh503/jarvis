export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'
export type LlmProtocol = 'chat-completions' | 'responses' | 'anthropic'
export type ModelProtocol = LlmProtocol | 'ollama'

export interface ChatMessage {
  role: ChatRole
  content: string
  images?: string[]
  toolCalls?: ToolCall[]
  toolCallId?: string
  name?: string
}

export interface ChatOptions {
  tools?: ToolSchema[]
  /** Pin tool rounds to one provider; never permit tool-stream failover. */
  pinnedProfileId?: string
  model?: string
  temperature?: number
  numCtx?: number
  maxTokens?: number
  /** Reject output stopped by its token limit (for summaries). */
  requireComplete?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  keepAlive?: string
  /** Failover chain for this request (scenario override); profile ids in order. */
  profileIds?: string[]
}

export interface ModelInfo {
  name: string
  size?: number
  modified_at?: string
}

export interface ModelHealth {
  ok: boolean
  models: ModelInfo[]
  error?: string
}

export interface ModelStatus {
  id: string
  label: string
  kind: 'ollama' | 'openai'
  protocol: ModelProtocol
  model: string
  baseUrl: string
  hasKey: boolean
  /** Providers currently parked by failover (id -> cooldown state). */
  cooldowns?: Record<string, { until: number; kind: string; reason: string }>
}

export interface ModelClient {
  readonly model: string
  readonly visionModel: string
  readonly embedModel: string
  contextLimits?(options?: ChatOptions): Promise<{ contextWindow: number; maxOutputTokens: number }>
  health(timeoutMs?: number): Promise<ModelHealth>
  supportsTools?(options?: ChatOptions): Promise<boolean>
  /** Resolve the actual selected tool provider to a concrete client, without network or failover. */
  toolClient?(options?: ChatOptions): Promise<ModelClient | undefined>
  toolStream?(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<ModelStreamEvent>
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string>
  chatOnce(messages: ChatMessage[], options?: ChatOptions): Promise<string>
  vision(image: Buffer, prompt: string, options?: ChatOptions): Promise<string>
  embed(text: string): Promise<Float32Array | null>
  warmup?(): Promise<{ chatMs: number; embedMs: number }>
  status?(): ModelStatus
  /** True when every call this client makes stays on this machine. */
  readonly isLocal?: boolean
  /** Router-only: does the serving provider live off this machine? */
  servingRemote?(): boolean
  /** Router-only: a client that never leaves this machine (captures, OCR). */
  localClient?(): ModelClient
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCall { id: string; name: string; arguments: string }
export type ModelStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'finish'; reason: 'stop' | 'tool-calls' | 'length' }

/** Provider envelopes are validated here; raw argument JSON belongs to runtime validation. */
export class ToolCallBuffer {
  private calls = new Map<number, ToolCall>()
  patch(index: number, patch: Partial<ToolCall>, append = false): void {
    if (!Number.isInteger(index) || index < 0 || (!this.calls.has(index) && this.calls.size >= 32)) throw new Error('Malformed tool call index / maximum 32 calls')
    const old = this.calls.get(index) ?? { id: '', name: '', arguments: '' }
    const next = { ...old }
    for (const key of ['id', 'name', 'arguments'] as const) {
      if (patch[key] !== undefined) {
        if (typeof patch[key] !== 'string') throw new Error('Malformed tool call field')
        next[key] = append ? old[key] + patch[key] : patch[key]
      }
    }
    if (Buffer.byteLength(next.arguments, 'utf8') > 256 * 1024) throw new Error('Tool arguments exceed 256KB')
    this.calls.set(index, next)
  }
  complete(): ToolCall[] {
    const result = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
    const ids = new Set<string>()
    for (const call of result) {
      if (!call.id.trim() || !call.name.trim() || ids.has(call.id)) throw new Error('Malformed tool call: missing name/id or duplicate id')
      ids.add(call.id)
    }
    return result
  }
}

/** Strict JSON wire reader. Cancelling/closing the generator also closes the response. */
export async function* modelWire(response: Response, signal: AbortSignal, ndjson = false): AsyncGenerator<any> {
  if (!response.body) throw new Error('Missing model response body')
  if (!ndjson && !(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    signal.throwIfAborted()
    yield await response.json()
    return
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  function parse(raw: string): any {
    try { return JSON.parse(raw) } catch { throw new Error('Malformed provider JSON') }
  }
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      if (buffer.length > 2 * 1024 * 1024) throw new Error('Provider frame too large')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      if (done && buffer) { lines.push(buffer); buffer = '' }
      if (done && !ndjson) lines.push('')
      for (const line of lines) {
        signal.throwIfAborted()
        if (ndjson) { if (line.trim()) yield parse(line); continue }
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
        else if (!line && data.length) {
          const raw = data.join('\n'); data = []
          if (raw === '[DONE]') return
          yield parse(raw)
        }
      }
      if (done) return
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

export function* finishToolEvents(buffer: ToolCallBuffer, reason: string | undefined, signal?: AbortSignal): Generator<ModelStreamEvent> {
  signal?.throwIfAborted()
  if (['length', 'max_tokens', 'max_output_tokens'].includes(reason ?? '')) {
    yield { type: 'finish', reason: 'length' }; return
  }
  if (!['stop', 'tool_calls', 'tool_use', 'end_turn', 'stop_sequence', 'completed'].includes(reason ?? '')) {
    throw new Error('Missing or unsupported model finish reason')
  }
  const calls = buffer.complete()
  if ((reason === 'tool_calls' || reason === 'tool_use') && !calls.length) throw new Error('Tool finish without tool calls')
  for (const call of calls) { signal?.throwIfAborted(); yield { type: 'tool-call', call } }
  signal?.throwIfAborted()
  yield { type: 'finish', reason: calls.length ? 'tool-calls' : 'stop' }
}
