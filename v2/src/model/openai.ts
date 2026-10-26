import type { Embedder } from '../memory/types.ts'
import type { ChatMessage, ChatOptions, ModelClient, ModelHealth, ModelInfo, ModelStatus } from './types.ts'

interface OpenAIChoice {
  delta?: { content?: string }
  message?: { content?: string }
}

interface OpenAIChunk {
  choices?: OpenAIChoice[]
  error?: { message?: string }
}

export class OpenAIError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'OpenAIError'
  }
}

/**
 * Minimal OpenAI-compatible client. It intentionally targets the stable
 * /chat/completions and /embeddings contracts so DeepSeek, OpenAI, vLLM,
 * LM Studio, OpenRouter and Ollama's /v1 compatibility layer all work.
 */
export class OpenAICompatibleClient implements ModelClient, Embedder {
  readonly model: string
  readonly visionModel: string
  readonly embedModel: string
  readonly baseUrl: string
  private readonly apiKey: string
  private readonly id: string
  private readonly label: string

  constructor(options: {
    baseUrl: string
    model: string
    apiKey?: string
    visionModel?: string
    embedModel?: string
    id?: string
    label?: string
  }) {
    let normalized = options.baseUrl.replace(/\/+$/, '')
    try {
      const parsed = new URL(normalized)
      if (parsed.pathname === '' || parsed.pathname === '/') normalized = `${normalized}/v1`
    } catch {
      // Validation happens in ModelSettingsStore; keep the raw value for a useful error.
    }
    this.baseUrl = normalized
    this.model = options.model
    this.apiKey = options.apiKey ?? ''
    this.visionModel = options.visionModel ?? ''
    this.embedModel = options.embedModel ?? ''
    this.id = options.id ?? 'remote'
    this.label = options.label ?? '远端模型'
  }

  status(): ModelStatus {
    return { id: this.id, label: this.label, kind: 'openai', model: this.model, baseUrl: this.baseUrl, hasKey: Boolean(this.apiKey) }
  }

  private endpoint(path: string): string {
    if (this.baseUrl.endsWith('/chat/completions') || this.baseUrl.endsWith('/embeddings') || this.baseUrl.endsWith('/models')) {
      return this.baseUrl.replace(/\/(chat\/completions|embeddings|models)$/, path)
    }
    return `${this.baseUrl}${path}`
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    return headers
  }

  async health(timeoutMs = 5000): Promise<ModelHealth> {
    try {
      const response = await fetch(this.endpoint('/models'), {
        headers: this.headers(),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status === 401 || response.status === 403) {
        return { ok: false, models: [], error: `HTTP ${response.status}: 检查 API Key` }
      }
      if (!response.ok) {
        // Some compatible servers do not expose /models. Let the explicit
        // connection test decide by making a tiny chat request.
        if (response.status === 404 || response.status === 405) return { ok: true, models: [] }
        return { ok: false, models: [], error: `HTTP ${response.status}` }
      }
      const data = (await response.json()) as { data?: Array<ModelInfo & { id?: string }> }
      const models = Array.isArray(data.data)
        ? data.data.map(item => ({ ...item, name: String(item.name ?? item.id ?? '') }))
        : []
      return { ok: true, models }
    } catch (error) {
      return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  private body(messages: ChatMessage[], options: ChatOptions, stream: boolean): string {
    const payloadMessages = messages.map(message => {
      if (!message.images?.length) return { role: message.role, content: message.content }
      return {
        role: message.role,
        content: [
          { type: 'text', text: message.content },
          ...message.images.map(image => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } })),
        ],
      }
    })
    return JSON.stringify({
      model: options.model ?? this.model,
      messages: payloadMessages,
      stream,
      temperature: options.temperature ?? 0.4,
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    })
  }

  async *chatStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    try {
      const response = await fetch(this.endpoint('/chat/completions'), {
        method: 'POST',
        headers: { ...this.headers(), accept: 'text/event-stream' },
        body: this.body(messages, options, true),
        signal,
      })
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '')
        throw new OpenAIError(`远端模型请求失败：HTTP ${response.status} ${detail.slice(0, 300)}`, response.status)
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const data = (await response.json()) as OpenAIChunk
        const content = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.delta?.content
        if (content) yield content
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data) continue
          if (data === '[DONE]') return
          let chunk: OpenAIChunk
          try {
            chunk = JSON.parse(data) as OpenAIChunk
          } catch {
            continue
          }
          if (chunk.error?.message) throw new OpenAIError(chunk.error.message)
          const content = chunk.choices?.[0]?.delta?.content
          if (content) yield content
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

  async vision(image: Buffer, prompt: string, options: ChatOptions = {}): Promise<string> {
    if (!this.visionModel) throw new Error('这个远端配置没有设置视觉模型。')
    return await this.chatOnce(
      [{ role: 'user', content: prompt, images: [image.toString('base64')] }],
      { ...options, model: options.model ?? this.visionModel, temperature: options.temperature ?? 0.2 },
    )
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!this.embedModel) return null
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await fetch(this.endpoint('/embeddings'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: this.embedModel, input: text }),
        signal: controller.signal,
      })
      if (!response.ok) return null
      const data = (await response.json()) as { data?: Array<{ embedding?: number[] }>; embedding?: number[] }
      const vector = data.data?.[0]?.embedding ?? data.embedding
      return vector ? new Float32Array(vector) : null
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  async warmup(): Promise<{ chatMs: number; embedMs: number }> {
    // Never spend remote tokens just because Jarvis started.
    return { chatMs: 0, embedMs: 0 }
  }
}
