import { ToolCallBuffer, modelWire, finishToolEvents, type ModelStreamEvent } from './types.ts'
import { contextWindow, contextLimitsFor, isContextOverflow, requireCompleteOutput } from './context-budget.ts'
import type { Embedder } from '../memory/types.ts'
import type { ChatMessage, ChatOptions, ModelClient, ModelHealth, ModelInfo, ModelStatus } from './types.ts'
import { isCloudflareBaseUrl, listCloudflareModels } from './cloudflare.ts'

interface OpenAIChoice {
  finish_reason?: string
  delta?: { content?: string }
  message?: { content?: string }
}

interface OpenAIChunk {
  choices?: OpenAIChoice[]
  error?: { message?: string; code?: string; type?: string }
}

export type OpenAIProtocol = 'chat-completions' | 'responses'

export class OpenAIError extends Error {
  readonly code?: string
  constructor(message: string, readonly status?: number, detail?: unknown) {
    super(message)
    this.name = 'OpenAIError'
    if (isContextOverflow(detail ?? message)) this.code = 'CONTEXT_WINDOW_EXCEEDED'
  }
}

/**
 * Minimal OpenAI-compatible client. It intentionally targets the stable
 * /chat/completions and /embeddings contracts so DeepSeek, OpenAI, vLLM,
 * LM Studio, OpenRouter and Ollama's /v1 compatibility layer all work.
 */
export class OpenAICompatibleClient implements ModelClient, Embedder {
  private readonly toolsEnabled: boolean
  // Bounded, in-memory replay only: restarting or switching providers loses reasoning state.
  private readonly reasoning = new Map<string, any>()
  private readonly configuredWindow: number
  readonly model: string
  readonly visionModel: string
  readonly embedModel: string
  readonly baseUrl: string
  private readonly apiKey: string
  private readonly id: string
  private readonly label: string
  private readonly protocol: OpenAIProtocol

  constructor(options: {
    supportsTools?: boolean
    contextWindow?: number
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
    this.toolsEnabled = options.supportsTools === true
    this.configuredWindow = contextWindow(options.contextWindow)
    this.model = options.model
    this.apiKey = options.apiKey ?? ''
    this.visionModel = options.visionModel ?? ''
    this.embedModel = options.embedModel ?? ''
    this.id = options.id ?? 'remote'
    this.label = options.label ?? '远端模型'
    this.protocol = options.protocol === 'responses' ? 'responses' : 'chat-completions'
  }

  async contextLimits(options: ChatOptions = {}): Promise<{ contextWindow: number; maxOutputTokens: number }> {
    return contextLimitsFor(this.configuredWindow, options, this.model)
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
    if (isCloudflareBaseUrl(this.baseUrl)) {
      return await listCloudflareModels(this.baseUrl, this.apiKey, timeoutMs)
    }
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
      if (!message.images?.length) return {
        role: message.role, content: message.content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
        ...(message.name ? { name: message.name } : {}),
        ...(message.toolCalls ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
        ...(message.toolCalls?.[0] && this.reasoning.has(message.toolCalls[0].id) ? { reasoning_content: this.reasoning.get(message.toolCalls[0].id) } : {}),
      }
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
      ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function', function: tool })) } : {}),
      stream,
      temperature: options.temperature ?? 0.4,
      max_tokens: contextLimitsFor(this.configuredWindow, options, this.model).maxOutputTokens,
    })
  }

  private responsesBody(messages: ChatMessage[], options: ChatOptions, stream: boolean): string {
    const instructions = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n').trim()
    const input: any[] = []
    for (const message of messages.filter(m => m.role !== 'system')) {
      if (message.role === 'tool') { input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content }); continue }
      if (message.toolCalls?.[0]) input.push(...(this.reasoning.get(message.toolCalls[0].id) ?? []))
      if (message.content || message.images?.length || !message.toolCalls?.length) input.push({ role: message.role, content: message.images?.length ? [
        { type: 'input_text', text: message.content },
        ...message.images.map(image => ({ type: 'input_image', image_url: `data:image/jpeg;base64,${image}` })),
      ] : message.content })
      for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })
    }
    return JSON.stringify({
      model: options.model ?? this.model,
      input,
      ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function', ...tool })), include: ['reasoning.encrypted_content'], store: false } : {}),
      stream,
      ...(instructions ? { instructions } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      max_output_tokens: contextLimitsFor(this.configuredWindow, options, this.model).maxOutputTokens,
    })
  }

  async supportsTools(): Promise<boolean> { return this.toolsEnabled }

  async *toolStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<ModelStreamEvent> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    const calls = new ToolCallBuffer()
    const responses = this.protocol === 'responses'
    let reasoningText = ''
    const reasoningItems: any[] = []
    let sawText = false
    try {
      signal.throwIfAborted()
      const response = await fetch(this.endpoint(responses ? '/responses' : '/chat/completions'), {
        method: 'POST', headers: { ...this.headers(), accept: 'text/event-stream' }, signal,
        body: responses ? this.responsesBody(messages, options, true) : this.chatBody(messages, options, true),
      })
      if (!response.ok) throw new OpenAIError(`Model request failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`, response.status)
      const isSse = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      let finish: string | undefined
      for await (const event of modelWire(response, signal)) {
        if (!event || typeof event !== 'object') throw new Error('Malformed OpenAI response')
        if (event.error || event.type === 'error' || event.type === 'response.failed') throw new OpenAIError(event.error?.message ?? event.response?.error?.message ?? 'Model stream error')
        if (!responses) {
          if (!Array.isArray(event.choices)) throw new Error('Malformed OpenAI choices')
          if (!event.choices.length) continue // usage-only frame
          if (event.choices.length !== 1) throw new Error('Multiple choices are unsupported')
          const choice = event.choices[0]
          const delta = choice.delta ?? choice.message
          if (delta?.content != null && typeof delta.content !== 'string') throw new Error('Malformed OpenAI text')
          if (delta?.content) yield { type: 'text', text: delta.content }
          if (delta?.reasoning_content != null && typeof delta.reasoning_content !== 'string') throw new Error('Malformed reasoning content')
          if (delta?.reasoning_content) reasoningText += delta.reasoning_content
          if (delta?.tool_calls !== undefined) {
            if (!Array.isArray(delta.tool_calls)) throw new Error('Malformed OpenAI tool calls')
            for (const [index, call] of delta.tool_calls.entries()) {
              if (call.type !== undefined && call.type !== 'function') throw new Error('Unsupported tool call type')
              calls.patch(isSse ? call.index : index, { id: call.id, name: call.function?.name, arguments: call.function?.arguments }, isSse)
            }
          }
          if (choice.finish_reason != null) finish = choice.finish_reason
        } else {
          if (event.type === 'response.output_text.delta') {
            if (typeof event.delta !== 'string') throw new Error('Malformed Responses text delta')
            sawText = true; yield { type: 'text', text: event.delta }
          }
          if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
            calls.patch(event.output_index, { id: event.item.call_id, name: event.item.name, arguments: event.item.arguments ?? '' })
          }
          if (event.type === 'response.function_call_arguments.delta') {
            if (typeof event.delta !== 'string') throw new Error('Malformed Responses tool delta')
            calls.patch(event.output_index, { arguments: event.delta }, true)
          }
          if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
            calls.patch(event.output_index, { id: event.item.call_id, name: event.item.name, arguments: event.item.arguments })
          }
          if (event.type === 'response.output_item.done' && event.item?.type === 'reasoning') reasoningItems.push(event.item)
          if (!isSse || event.type === 'response.completed' || event.type === 'response.incomplete') {
            const final = isSse ? event.response : event
            if (!final || final.error) throw new Error('Malformed Responses completion')
            finish = event.type === 'response.incomplete' || final.status === 'incomplete' ? final.incomplete_details?.reason : final.status === 'completed' || event.type === 'response.completed' ? 'completed' : undefined
            if (final.output !== undefined && !Array.isArray(final.output)) throw new Error('Malformed Responses output')
            for (const [index, item] of (final.output ?? []).entries()) {
              if (item.type === 'function_call') calls.patch(index, { id: item.call_id, name: item.name, arguments: item.arguments })
              if (item.type === 'reasoning' && !reasoningItems.some(r => r.id === item.id)) reasoningItems.push(item)
              if (!sawText && item.type === 'message') for (const block of item.content ?? []) if (block.type === 'output_text' && block.text) yield { type: 'text', text: block.text }
            }
            if (!sawText && !final.output?.length && final.output_text) yield { type: 'text', text: final.output_text }
          }
        }
        if (finish !== undefined) {
          signal.throwIfAborted()
          // Validate every call before publishing any; retain opaque reasoning for follow-up requests.
          if (!['length', 'max_output_tokens'].includes(finish)) {
            const completed = calls.complete()
            for (const call of completed) {
              if (responses ? reasoningItems.length : reasoningText) this.reasoning.set(call.id, responses ? reasoningItems : reasoningText)
            }
            while (this.reasoning.size > 128) this.reasoning.delete(this.reasoning.keys().next().value!)
          }
          yield* finishToolEvents(calls, finish, signal); return
        }
      }
      throw new Error('OpenAI stream ended without finish')
    } finally { controller.abort(); clearTimeout(timeout) }
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
        throw new OpenAIError(`远端模型请求失败：HTTP ${response.status} ${detail.slice(0, 300)}`, response.status, detail)
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const data = (await response.json()) as OpenAIChunk
        if (data.error) throw new OpenAIError(data.error.message ?? 'OpenAI error', undefined, data.error)
        requireCompleteOutput(options, data.choices?.[0]?.finish_reason)
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
          if (chunk.error) throw new OpenAIError(chunk.error.message ?? 'OpenAI stream error', undefined, chunk.error)
          requireCompleteOutput(options, chunk.choices?.[0]?.finish_reason)
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
        throw new OpenAIError(`Responses 请求失败：HTTP ${response.status} ${detail.slice(0, 300)}`, response.status, detail)
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        const data = (await response.json()) as {
          incomplete_details?: { reason?: string }
          error?: { message?: string; code?: string }
          output_text?: string
          output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
        }
        if (data.error) throw new OpenAIError(data.error.message ?? 'Responses error', undefined, data.error)
        requireCompleteOutput(options, data.incomplete_details?.reason)
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
            error?: { message?: string; code?: string; type?: string }
            response?: { output_text?: string; incomplete_details?: { reason?: string }; error?: { message?: string; code?: string } }
            code?: string
            message?: string
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
          requireCompleteOutput(options, event.response?.incomplete_details?.reason)
          if (event.type === 'response.failed') throw new OpenAIError(event.response?.error?.message ?? 'Responses failed', undefined, event.response?.error)
          if (event.type === 'response.completed') {
            if (!sawDelta && event.response?.output_text) yield event.response.output_text
            return
          }
          if (event.type === 'error') throw new OpenAIError(event.error?.message ?? event.message ?? 'Responses stream error', undefined, event.error ?? event)
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
