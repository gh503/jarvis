import type { ChatMessage, ChatOptions, ModelClient, ModelHealth, ModelInfo, ModelStatus } from './types.ts'

interface AnthropicContentBlock {
  type?: string
  text?: string
  source?: { data?: string; media_type?: string }
}

interface AnthropicPayload {
  content?: AnthropicContentBlock[]
  content_block?: AnthropicContentBlock
  error?: { message?: string }
  type?: string
  delta?: { type?: string; text?: string }
}

export class AnthropicError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'AnthropicError'
  }
}

function normalizeBase(raw: string): string {
  let value = raw.replace(/\/+$/, '')
  try {
    const parsed = new URL(value)
    const path = parsed.pathname.replace(/\/+$/, '')
    if (path === '' || path === '/') {
      value = `${value}/v1`
    } else if (/\/(messages|models)$/.test(path)) {
      value = value.replace(/\/(messages|models)$/, '')
    }
  } catch {
    // Validation reports the useful error; keep the raw value here.
  }
  return value.replace(/\/+$/, '')
}

function textOf(message: ChatMessage): string {
  return message.content
}

function blocks(message: ChatMessage): Array<Record<string, unknown>> {
  if (!message.images?.length) return [{ type: 'text', text: textOf(message) }]
  return [
    { type: 'text', text: textOf(message) },
    ...message.images.map(image => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: image },
    })),
  ]
}

/**
 * Anthropic Messages API (v1/messages).
 *
 * It is deliberately a separate client rather than pretending to be
 * OpenAI-compatible: the system prompt, image blocks and SSE event names are
 * all different, and guessing leads to silent empty replies.
 */
export class AnthropicClient implements ModelClient {
  readonly model: string
  readonly visionModel: string
  readonly embedModel = ''
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly id: string
  private readonly label: string

  constructor(options: {
    baseUrl: string
    model: string
    apiKey?: string
    visionModel?: string
    id?: string
    label?: string
  }) {
    this.baseUrl = normalizeBase(options.baseUrl)
    this.model = options.model
    this.apiKey = options.apiKey ?? ''
    this.visionModel = options.visionModel ?? ''
    this.id = options.id ?? 'remote'
    this.label = options.label ?? 'Anthropic Messages'
  }

  status(): ModelStatus {
    return {
      id: this.id,
      label: this.label,
      kind: 'openai',
      protocol: 'anthropic',
      model: this.model,
      baseUrl: this.baseUrl,
      hasKey: Boolean(this.apiKey),
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (this.apiKey) headers['x-api-key'] = this.apiKey
    return headers
  }

  private endpoint(path: '/messages' | '/models'): string {
    return `${this.baseUrl}${path}`
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
      if (response.status === 404 || response.status === 405) {
        // Older Anthropic-compatible gateways may not expose /models. The
        // explicit connection test still decides by making a tiny message.
        return { ok: true, models: [], error: '服务没有 /models，无法自动列出模型' }
      }
      if (!response.ok) return { ok: false, models: [], error: `HTTP ${response.status}` }
      const data = (await response.json()) as { data?: Array<{ id?: string; display_name?: string }> }
      return {
        ok: true,
        models: (data.data ?? [])
          .map(item => ({ name: String(item.id ?? item.display_name ?? '') }))
          .filter(item => Boolean(item.name)),
      }
    } catch (error) {
      return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) }
    }
  }

  private body(messages: ChatMessage[], options: ChatOptions, stream: boolean): string {
    const system = messages.filter(message => message.role === 'system').map(textOf).join('\n\n').trim()
    const turns = messages
      .filter(message => message.role !== 'system')
      .map(message => ({ role: message.role, content: blocks(message) }))
    return JSON.stringify({
      model: options.model ?? this.model,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.4,
      stream,
      ...(system ? { system } : {}),
      messages: turns,
    })
  }

  async *chatStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    try {
      const response = await fetch(this.endpoint('/messages'), {
        method: 'POST',
        headers: { ...this.headers(), accept: 'text/event-stream' },
        body: this.body(messages, options, true),
        signal,
      })
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '')
        throw new AnthropicError(`Anthropic 请求失败：HTTP ${response.status} ${detail.slice(0, 300)}`, response.status)
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const data = (await response.json()) as AnthropicPayload
        const content = (data.content ?? []).map(block => block.text ?? '').join('')
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
          const raw = trimmed.slice(5).trim()
          if (!raw || raw === '[DONE]') continue
          let payload: AnthropicPayload
          try {
            payload = JSON.parse(raw) as AnthropicPayload
          } catch {
            continue
          }
          if (payload.type === 'error' || payload.error?.message) {
            throw new AnthropicError(payload.error?.message ?? 'Anthropic stream error')
          }
          if (payload.type === 'content_block_delta' && payload.delta?.text) yield payload.delta.text
          if (payload.type === 'content_block_start') {
            // Some gateways send the first block whole instead of a delta.
            const first = payload.content?.[0]?.text ?? payload.content_block?.text
            if (first) yield first
          }
          if (payload.type === 'message_stop') return
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
    return await this.chatOnce(
      [{ role: 'user', content: prompt, images: [image.toString('base64')] }],
      { ...options, model: options.model ?? (this.visionModel || this.model), temperature: options.temperature ?? 0.2 },
    )
  }

  async embed(): Promise<Float32Array | null> {
    // Anthropic has no first-party embeddings endpoint. The router may fall
    // back to the local Ollama embedding model.
    return null
  }

  async warmup(): Promise<{ chatMs: number; embedMs: number }> {
    // Never spend remote tokens simply because Jarvis started.
    return { chatMs: 0, embedMs: 0 }
  }
}
