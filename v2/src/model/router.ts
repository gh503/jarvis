import type { Logger } from '../logger.ts'
import { OllamaClient } from './ollama.ts'
import { OpenAICompatibleClient } from './openai.ts'
import type { ModelProfile } from './settings.ts'
import type { ChatMessage, ChatOptions, ModelClient, ModelHealth, ModelStatus } from './types.ts'

export function createModelClient(profile: ModelProfile): ModelClient {
  if (profile.kind === 'openai') {
    return new OpenAICompatibleClient({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: profile.apiKey,
      visionModel: profile.visionModel,
      embedModel: profile.embedModel,
      id: profile.id,
      label: profile.label,
    })
  }
  return new OllamaClient(profile.baseUrl, {
    model: profile.model,
    visionModel: profile.visionModel || 'qwen2.5vl:3b',
    embedModel: profile.embedModel || 'nomic-embed-text',
    keepAlive: profile.keepAlive || '24h',
    id: profile.id,
    label: profile.label,
  })
}

export interface ModelTestResult {
  ok: boolean
  latencyMs: number
  message: string
  models: string[]
}

export class ModelRouter implements ModelClient {
  private client: ModelClient
  private current: ModelProfile

  constructor(
    initial: ModelClient,
    profile: ModelProfile,
    private readonly logger?: Logger,
    private readonly fallback?: { embedding?: ModelClient; vision?: ModelClient },
  ) {
    this.client = initial
    this.current = profile
  }

  get model(): string {
    return this.client.model
  }

  get visionModel(): string {
    return this.client.visionModel
  }

  get embedModel(): string {
    return this.client.embedModel
  }

  profile(): ModelProfile {
    return { ...this.current }
  }

  status(): ModelStatus {
    return this.client.status?.() ?? {
      id: this.current.id,
      label: this.current.label,
      kind: this.current.kind,
      model: this.client.model,
      baseUrl: this.current.baseUrl,
      hasKey: Boolean(this.current.apiKey),
    }
  }

  async health(timeoutMs = 5000): Promise<ModelHealth> {
    return await this.client.health(timeoutMs)
  }

  async warmup(): Promise<{ chatMs: number; embedMs: number }> {
    return this.client.warmup ? await this.client.warmup() : { chatMs: 0, embedMs: 0 }
  }

  chatStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<string> {
    return this.client.chatStream(messages, options)
  }

  async chatOnce(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    return await this.client.chatOnce(messages, options)
  }

  async vision(image: Buffer, prompt: string, options: ChatOptions = {}): Promise<string> {
    if (!this.client.visionModel && this.fallback?.vision) return await this.fallback.vision.vision(image, prompt, options)
    return await this.client.vision(image, prompt, options)
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!this.client.embedModel && this.fallback?.embedding) return await this.fallback.embedding.embed(text)
    return await this.client.embed(text)
  }

  async test(profile: ModelProfile): Promise<ModelTestResult> {
    const started = Date.now()
    const client = createModelClient(profile)
    try {
      const health = await client.health(8000)
      if (!health.ok) return { ok: false, latencyMs: Date.now() - started, message: health.error ?? '连接失败', models: [] }
      const reply = await client.chatOnce([{ role: 'user', content: '只回复：ok' }], {
        temperature: 0,
        maxTokens: 8,
        timeoutMs: 20_000,
      })
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: reply ? `连接成功：${reply.slice(0, 80)}` : '连接成功',
        models: health.models.map(item => item.name).filter(Boolean).slice(0, 20),
      }
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, message: error instanceof Error ? error.message : String(error), models: [] }
    }
  }

  async switchTo(profile: ModelProfile): Promise<{ status: ModelStatus; test: ModelTestResult }> {
    const test = await this.test(profile)
    if (!test.ok) throw new Error(test.message)
    this.client = createModelClient(profile)
    this.current = profile
    this.logger?.info('model switched', { id: profile.id, kind: profile.kind, model: profile.model })
    return { status: this.status(), test }
  }
}
