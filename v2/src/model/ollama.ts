import type { Embedder } from '../memory/types.ts'

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
  images?: string[]
}

export interface ChatOptions {
  model?: string
  temperature?: number
  numCtx?: number
  signal?: AbortSignal
  timeoutMs?: number
  keepAlive?: string
}

export interface OllamaModel {
  name: string
  size: number
  modified_at: string
}

export class OllamaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'OllamaError'
  }
}

interface OllamaChatChunk {
  message?: { role?: string; content?: string }
  done?: boolean
  error?: string
}

export class OllamaClient implements Embedder {
  readonly model: string
  readonly visionModel: string
  readonly embedModel: string
  readonly keepAlive: string

  constructor(
    private readonly baseUrl: string,
    options: { model: string; visionModel: string; embedModel: string; keepAlive?: string },
  ) {
    this.model = options.model
    this.visionModel = options.visionModel
    this.embedModel = options.embedModel
    this.keepAlive = options.keepAlive ?? '24h'
  }

  async health(timeoutMs = 3000): Promise<{ ok: boolean; models: OllamaModel[]; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        return { ok: false, models: [], error: `HTTP ${response.status}` }
      }
      const data = (await response.json()) as { models?: OllamaModel[] }
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
      messages,
      stream,
      keep_alive: options.keepAlive ?? this.keepAlive,
      options: {
        temperature: options.temperature ?? 0.4,
        num_ctx: options.numCtx ?? 4096,
      },
    })
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
        throw new OllamaError(`Ollama chat failed: HTTP ${response.status} ${detail.slice(0, 300)}`, response.status)
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
          if (chunk.error) throw new OllamaError(chunk.error)
          const content = chunk.message?.content
          if (content) yield content
          if (chunk.done) return
        }
      }
      if (buffer.trim()) {
        try {
          const chunk = JSON.parse(buffer.trim()) as OllamaChatChunk
          if (chunk.message?.content) yield chunk.message.content
        } catch {
          // Partial trailing JSON after a stream reset; ignore.
        }
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