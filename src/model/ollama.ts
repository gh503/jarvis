import { randomUUID } from 'node:crypto'
import { ToolCallBuffer, modelWire, finishToolEvents, type ModelStreamEvent } from './types.ts'
import { contextWindow, contextLimitsFor, isContextOverflow, requireCompleteOutput } from './context-budget.ts'
import type { Embedder } from '../memory/types.ts'
import type { ChatMessage, ChatOptions, ModelClient, ModelHealth, ModelInfo, ModelStatus } from './types.ts'

export type { ChatMessage, ChatOptions, ModelClient, ModelInfo, ModelHealth, ModelStatus } from './types.ts'

export class OllamaError extends Error {
  readonly code?: string
  constructor(message: string, readonly status?: number, detail?: unknown) {
    super(message)
    this.name = 'OllamaError'
    if (isContextOverflow(detail ?? message)) this.code = 'CONTEXT_WINDOW_EXCEEDED'
  }
}

interface OllamaChatChunk {
  message?: { role?: string; content?: string }
  done?: boolean
  done_reason?: string
  error?: string
}

export class OllamaClient implements ModelClient, Embedder {
  private readonly toolsEnabled: boolean
  private readonly configuredWindow: number
  readonly model: string
  readonly visionModel: string
  readonly embedModel: string
  readonly keepAlive: string
  readonly isLocal: boolean
  private readonly id: string
  private readonly label: string

  constructor(
    private readonly baseUrl: string,
    options: { supportsTools?: boolean; contextWindow?: number; model: string; visionModel: string; embedModel: string; keepAlive?: string; id?: string; label?: string },
  ) {
    this.toolsEnabled = options.supportsTools === true
    this.configuredWindow = contextWindow(options.contextWindow)
    this.model = options.model
    this.visionModel = options.visionModel
    this.embedModel = options.embedModel
    this.keepAlive = options.keepAlive ?? '24h'
    this.id = options.id ?? 'local'
    this.label = options.label ?? '本地 Ollama'
    let host = ''
    try { host = new URL(baseUrl).hostname } catch { /* validated by the caller */ }
    // "Local" means the socket never leaves this machine, not merely that the
    // provider is an Ollama instance.
    this.isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0'
  }

  async contextLimits(options: ChatOptions = {}): Promise<{ contextWindow: number; maxOutputTokens: number }> {
    return contextLimitsFor(this.configuredWindow, options, this.model)
  }

  status(): ModelStatus {
    return { id: this.id, label: this.label, kind: 'ollama', protocol: 'ollama', model: this.model, baseUrl: this.baseUrl, hasKey: false }
  }

  async health(timeoutMs = 3000): Promise<ModelHealth> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        return { ok: false, models: [], error: `HTTP ${response.status}` }
      }
      const data = (await response.json()) as { models?: ModelInfo[] }
      return { ok: true, models: data.models ?? [] }
    } catch (error) {
      return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  async hasModel(name: string): Promise<boolean> {
    const health = await this.health()
    return health.models.some(model => model.name === name || model.name.startsWith(`${name}:`))
  }

  private body(messages: ChatMessage[], options: ChatOptions, model: string, stream: boolean): string {
    return JSON.stringify({
      model,
      messages: messages.map(message => ({
        role: message.role, content: message.content, images: message.images,
        ...(message.toolCalls ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.parse(call.arguments) } })) } : {}),
        ...(message.role === 'tool' ? { tool_name: message.name ?? messages.flatMap(m => m.toolCalls ?? []).find(c => c.id === message.toolCallId)?.name, tool_call_id: message.toolCallId } : {}),
      })),
      ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function', function: tool })) } : {}),
      stream,
      keep_alive: options.keepAlive ?? this.keepAlive,
      options: {
        temperature: options.temperature ?? 0.4,
        num_ctx: contextLimitsFor(this.configuredWindow, options, this.model).contextWindow,
        num_predict: contextLimitsFor(this.configuredWindow, options, this.model).maxOutputTokens,
      },
    })
  }

  async supportsTools(): Promise<boolean> { return this.toolsEnabled }

  async *toolStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<ModelStreamEvent> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    const calls = new ToolCallBuffer()
    let count = 0
    try {
      signal.throwIfAborted()
      const response = await fetch(`${this.baseUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: this.body(messages, options, options.model ?? this.model, true), signal })
      if (!response.ok) throw new OllamaError(`Ollama chat failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`, response.status)
      for await (const chunk of modelWire(response, signal, true)) {
        if (!chunk || typeof chunk !== 'object') throw new Error('Malformed Ollama response')
        if (chunk.error) throw new OllamaError(String(chunk.error))
        const message = chunk.message
        if (message?.content !== undefined && typeof message.content !== 'string') throw new Error('Malformed Ollama content')
        if (message?.content) yield { type: 'text', text: message.content }
        if (message?.tool_calls !== undefined) {
          if (!Array.isArray(message.tool_calls)) throw new Error('Malformed Ollama tool calls')
          for (const call of message.tool_calls) {
            if (!call?.function || call.function.arguments === undefined) throw new Error('Malformed Ollama tool call')
            // Native Ollama sends complete argument objects, not JSON deltas.
            calls.patch(count, { id: call.id ?? `ollama_${randomUUID()}`, name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments) })
            count++
          }
        }
        if (chunk.done === true) { signal.throwIfAborted(); yield* finishToolEvents(calls, chunk.done_reason, signal); return }
      }
      throw new Error('Ollama stream ended without finish')
    } finally { controller.abort(); clearTimeout(timeout) }
  }

  async *chatStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<string> {
    const model = options.model ?? this.model
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: this.body(messages, options, model, true),
        signal,
      })
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '')
        throw new OllamaError(`Ollama chat failed: HTTP ${response.status} ${detail.slice(0, 300)}`, response.status, detail)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let chunk: OllamaChatChunk
          try {
            chunk = JSON.parse(trimmed) as OllamaChatChunk
          } catch {
            continue
          }
          requireCompleteOutput(options, chunk.done_reason)
          if (chunk.error) throw new OllamaError(chunk.error)
          const content = chunk.message?.content
          if (content) yield content
          if (chunk.done) return
        }
      }
      if (buffer.trim()) {
        let chunk: OllamaChatChunk | undefined
        try { chunk = JSON.parse(buffer.trim()) as OllamaChatChunk } catch { /* partial JSON */ }
        if (chunk?.error) throw new OllamaError(chunk.error)
        requireCompleteOutput(options, chunk?.done_reason)
        if (chunk?.message?.content) yield chunk.message.content
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async chatOnce(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    let result = ''
    for await (const token of this.chatStream(messages, options)) result += token
    return result.trim()
  }

  async warmup(): Promise<{ chatMs: number; embedMs: number }> {
    const chatStart = Date.now()
    await this.chatOnce([{ role: 'user', content: '只回复：ok' }], {
      temperature: 0,
      numCtx: 4096,
      timeoutMs: 60_000,
    })
    const chatMs = Date.now() - chatStart
    const embedStart = Date.now()
    await this.embed('warmup')
    return { chatMs, embedMs: Date.now() - embedStart }
  }

  async vision(image: Buffer, prompt: string, options: ChatOptions = {}): Promise<string> {
    return this.chatOnce(
      [{ role: 'user', content: prompt, images: [image.toString('base64')] }],
      { ...options, model: options.model ?? this.visionModel, temperature: options.temperature ?? 0.2 },
    )
  }

  async embed(text: string): Promise<Float32Array | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.embedModel, input: text, keep_alive: this.keepAlive }),
        signal: controller.signal,
      })
      if (response.ok) {
        const data = (await response.json()) as { embeddings?: number[][] }
        const vector = data.embeddings?.[0]
        return vector ? new Float32Array(vector) : null
      }
      // Older Ollama versions expose /api/embeddings instead.
      const fallback = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.embedModel, prompt: text, keep_alive: this.keepAlive }),
        signal: controller.signal,
      })
      if (!fallback.ok) return null
      const data = (await fallback.json()) as { embedding?: number[] }
      return data.embedding ? new Float32Array(data.embedding) : null
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }
}