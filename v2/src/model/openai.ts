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

export type OpenAIProtocol = 'chat-completions' | 'responses'

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
  private readonly protocol: OpenAIProtocol

  constructor(options: {
    baseUrl: string
    model: string
    apiKey?: string
    visionModel?: string
    embedModel?: string
    id?: string
    label?: string
    protocol?: OpenAIProtocol
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
    this.protocol = options.protocol === 'responses' ? 'responses' : 'chat-completions'
  }

  status(): ModelStatus {
    return { id: this.id, label: this.label, kind: 'openai', protocol: this.protocol, model: this.model, baseUrl: this.baseUrl, hasKey: Boolean(this.apiKey) }
  }

  private endpoint(path: string): string {
    if (/\/(chat\/completions|responses|embeddings|models)$/.test(this.baseUrl)) {
      return this.baseUrl.replace(/\/(chat\/completions|responses|embeddings|models)$/, path)
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
        if (response.status === 404 || response.status === 405) return { ok: true, models: [], error: '服务没有 /models，无法自动列出模型' }
        return { ok: false, models: [], error: `HTTP ${response.status}` }
      }
      const data = (await response.json()) as { data?: Array<ModelInfo & { id?: string }>; models?: Array<ModelInfo & { id?: string }> }
      const listed = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []
      const models = listed.map(item => ({ ...item, name: String(item.name ?? item.id ?? '') })).filter(item => item.name)
      return { ok: true, models }
    } catch (error) {
      return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  private chatBody(messages: ChatMessage[], options: ChatOptions, stream: boolean): string {
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

  private responsesBody(messages: ChatMessage[], options: ChatOptions, stream: boolean): string {
    const instructions = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n').trim()
    const input = messages
      .filter(message => message.role !== 'system')
      .map(message => message.images?.length
        ? {
            role: message.role,
            content: [
              { type: 'input_text', text: message.content },
              ...message.images.map(image => ({ type: 'input_image', image_url: `data:image/jpeg;base64,${image}` })),
            ],
          }
        : { role: message.role, content: message.content })
    return JSON.stringify({
      model: options.model ?? this.model,
      input,
      stream,
      ...(instructions ? { instructions } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
    })
  }

  async *chatStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<string> {
    if (this.protocol === 'responses') {
      yield* this.responsesStream(messages, options)
      return
    }
    yield* this.chatCompletionsStream(messages, options)
  }

  private async *chatCompletionsStream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    try {
      const response = await fetch(this.endpoint('/chat/completions'), {
        method: 'POST',
        headers: { ...this.headers(), accept: 'text/event-stream' },
        body: this.chatBody(messages, options, true),
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

  private async *responsesStream(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    try {
      const response = await fetch(this.endpoint('/responses'), {
        method: 'POST',
        headers: { ...this.headers(), accept: 'text/event-stream' },
        body: this.responsesBody(messages, options, true),
        signal,
      })
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '')
        throw new OpenAIError(`Responses 请求失败：HTTP ${response.status} ${detail.slice(0, 300)}`, response.status)
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const data = (await response.json()) as {
          output_text?: string
          output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
        }
        const text = data.output_text ?? (data.output ?? [])
          .flatMap(item => item.content ?? [])
          .filter(item => item.type === 'output_text' || item.text)
          .map(item => item.text ?? '')
          .join('')
        if (text) yield text
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let sawDelta = false
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const raw = trimmed.slice(5).trim()
          if (!raw || raw === '[DONE]') continue
          let event: {
            type?: string
            delta?: string
            error?: { message?: string }
            response?: { output_text?: string }
          }
          try {
            event = JSON.parse(raw) as typeof event
          } catch {
            continue
          }
          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            sawDelta = true
            yield event.delta
          }
          if (event.type === 'response.completed') {
            if (!sawDelta && event.response?.output_text) yield event.response.output_text
            return
          }
          if (event.type === 'error') throw new OpenAIError(event.error?.message ?? 'Responses stream error')
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
