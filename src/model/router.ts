import { contextLimitsFor, estimateMessagesTokens } from './context-budget.ts'
import type { Logger } from '../logger.ts'
import { AnthropicClient } from './anthropic.ts'
import { classifyModelError, cooldownActive, cooldownMs, shouldFailover, type FailureKind } from './failover.ts'
import { OllamaClient } from './ollama.ts'
import { OpenAICompatibleClient } from './openai.ts'
import { isLoopbackHost } from './settings.ts'
import type { ModelProfile, ModelSettings } from './settings.ts'
import type { ChatMessage, ChatOptions, ModelClient, ModelHealth, ModelStatus } from './types.ts'

export function createModelClient(profile: ModelProfile): ModelClient {
  if (profile.kind === 'openai' && profile.protocol === 'anthropic') {
    return new AnthropicClient({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: profile.apiKey,
      visionModel: profile.visionModel,
      id: profile.id,
      label: profile.label,
      contextWindow: profile.contextWindow,
    })
  }
  if (profile.kind === 'openai') {
    return new OpenAICompatibleClient({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: profile.apiKey,
      visionModel: profile.visionModel,
      embedModel: profile.embedModel,
      id: profile.id,
      label: profile.label,
      contextWindow: profile.contextWindow,
      protocol: profile.protocol === 'responses' ? 'responses' : 'chat-completions',
    })
  }
  return new OllamaClient(profile.baseUrl, {
    model: profile.model,
    visionModel: profile.visionModel || 'qwen2.5vl:3b',
    embedModel: profile.embedModel || 'nomic-embed-text',
    keepAlive: profile.keepAlive || '24h',
    id: profile.id,
    label: profile.label,
    contextWindow: profile.contextWindow,
  })
}

export interface ModelTestResult {
  ok: boolean
  latencyMs: number
  message: string
  models: string[]
}

/** What the failover layer needs from persistence and the event bus. */
export interface FailoverDeps {
  loadSettings(): Promise<ModelSettings>
  persistCooldown(id: string, entry: { until: number; kind: string; reason: string } | null): Promise<void>
  emit?(event: 'model.failover', payload: Record<string, unknown>): void
}

function profileActivatable(profile: ModelProfile): boolean {
  if (profile.kind !== 'openai') return true
  if (profile.apiKey) return true
  try { return isLoopbackHost(new URL(profile.baseUrl).hostname) } catch { return false }
}

/**
 * Model router with priority-chain failover. Every request walks the chain
 * (scenario chain when provided, otherwise the global priority), skipping
 * providers in cooldown. Quota/auth/rate-limit/network/5xx failures park the
 * provider and retry the same request on the next one; a failure that
 * happens after streamed output has started is not retried (the partial
 * reply is already visible).
 */
export class ModelRouter implements ModelClient {
  private client: ModelClient
  private current: ModelProfile
  private clients = new Map<string, ModelClient>()
  private clientConfigs = new Map<string, string>()

  private configKey(profile: ModelProfile): string {
    return JSON.stringify([profile.kind, profile.protocol, profile.baseUrl, profile.model, profile.apiKey,
      profile.visionModel, profile.embedModel, profile.keepAlive, profile.label, profile.contextWindow ?? 4096])
  }
  private lastCooldowns: Record<string, { until: number; kind: string; reason: string }> = {}

  constructor(
    initial: ModelClient,
    profile: ModelProfile,
    private readonly logger?: Logger,
    private readonly fallback?: { embedding?: ModelClient; vision?: ModelClient },
    private readonly failover?: FailoverDeps,
  ) {
    this.client = initial
    this.current = profile
    this.clients.set(profile.id, initial)
    this.clientConfigs.set(profile.id, this.configKey(profile))
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

  /**
   * A client that never leaves this machine. Screen and camera derived content
   * (including OCR text) goes through this one so a failover can never carry it
   * to a remote provider.
   */
  localClient(): ModelClient {
    return this.fallback?.vision ?? this.clients.get('local') ?? this.client
  }

  /** True when the currently serving provider is reached over the network. */
  servingRemote(): boolean {
    const baseUrl = this.status().baseUrl
    if (!baseUrl) return this.current.kind === 'openai'
    try {
      return !isLoopbackHost(new URL(baseUrl).hostname)
    } catch {
      return this.current.kind === 'openai'
    }
  }

  status(): ModelStatus {
    const base = this.client.status?.() ?? {
      id: this.current.id,
      label: this.current.label,
      kind: this.current.kind,
      protocol: this.current.protocol,
      model: this.client.model,
      baseUrl: this.current.baseUrl,
      hasKey: Boolean(this.current.apiKey),
    }
    return { ...base, cooldowns: this.lastCooldowns }
  }

  async contextLimits(options: ChatOptions = {}): Promise<{ contextWindow: number; maxOutputTokens: number }> {
    const chain = await this.chain(options.profileIds)
    const limits = chain.map((profile, index) => contextLimitsFor(profile.contextWindow, index === 0 ? options : { ...options, model: undefined }, profile.model))
    return {
      contextWindow: Math.min(...limits.map(item => item.contextWindow)),
      maxOutputTokens: Math.min(...limits.map(item => item.maxOutputTokens)),
    }
  }

  async health(timeoutMs = 5000): Promise<ModelHealth> {
    return await this.client.health(timeoutMs)
  }

  async warmup(): Promise<{ chatMs: number; embedMs: number }> {
    return this.client.warmup ? await this.client.warmup() : { chatMs: 0, embedMs: 0 }
  }

  private clientFor(profile: ModelProfile): ModelClient {
    const key = this.configKey(profile)
    let client = this.clients.get(profile.id)
    if (!client || this.clientConfigs.get(profile.id) !== key) {
      client = createModelClient(profile)
      this.clients.set(profile.id, client)
      this.clientConfigs.set(profile.id, key)
    }
    if (profile.id === this.current.id) {
      this.client = client
      this.current = profile
    }
    return client
  }

  /**
   * Ordered candidate chain. Providers in cooldown are skipped; when every
   * candidate is parked the chain falls back to the raw order so we still
   * try (the cooldown may be stale, e.g. quota refilled).
   */
  private async chain(profileIds?: string[]): Promise<ModelProfile[]> {
    if (!this.failover) return [this.current]
    const settings = await this.failover.loadSettings()
    this.lastCooldowns = { ...settings.cooldowns }
    const order = profileIds?.length ? profileIds : settings.priority
    const byId = new Map(settings.profiles.map(item => [item.id, item]))
    const ordered: ModelProfile[] = []
    for (const id of order) {
      const profile = byId.get(id)
      if (profile && !ordered.some(item => item.id === id)) ordered.push(profile)
    }
    if (!ordered.some(item => item.id === this.current.id)) ordered.push(byId.get(this.current.id) ?? this.current)
    if (ordered.length === 0) return [this.current]
    const usable = ordered.filter(profileActivatable)
    const candidates = usable.length > 0 ? usable : ordered
    const now = Date.now()
    const ready = candidates.filter(item => !cooldownActive(settings.cooldowns[item.id], now))
    return ready.length > 0 ? ready : candidates
  }

  private noteSuccess(profile: ModelProfile, client: ModelClient): void {
    if (profile.id === this.current.id) return
    this.current = profile
    this.client = client
    this.logger?.info('model now served by provider', { id: profile.id, label: profile.label, model: profile.model })
  }

  private async parkProvider(profile: ModelProfile, kind: FailureKind, error: unknown, chainIds: string[]): Promise<void> {
    const until = Date.now() + cooldownMs(kind)
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200)
    this.lastCooldowns = { ...this.lastCooldowns, [profile.id]: { until, kind, reason } }
    this.logger?.warn('model provider parked', { id: profile.id, label: profile.label, kind, minutes: Math.max(1, Math.round((until - Date.now()) / 60000)), reason })
    const next = chainIds.filter(id => id !== profile.id)[0]
    this.failover?.emit?.('model.failover', {
      from: profile.id,
      fromLabel: profile.label,
      to: next ?? null,
      kind,
      reason,
      cooldownUntil: new Date(until).toISOString(),
    })
    try {
      await this.failover?.persistCooldown(profile.id, { until, kind, reason })
    } catch (persistError) {
      this.logger?.warn('cooldown persist failed', { error: persistError instanceof Error ? persistError.message : String(persistError) })
    }
  }

  private async assertTextBudget(client: ModelClient, profile: ModelProfile, messages: ChatMessage[], options: ChatOptions): Promise<void> {
    // Image token costs are provider-specific; this guard protects text planning only.
    if (messages.some(message => message.images?.length)) return
    const limits = await client.contextLimits?.(options) ?? contextLimitsFor(profile.contextWindow, options, profile.model)
    if (estimateMessagesTokens(messages) + (options.maxTokens ?? limits.maxOutputTokens) > limits.contextWindow) {
      throw Object.assign(new Error('Request exceeds the selected model context window'), { code: 'CONTEXT_WINDOW_EXCEEDED' })
    }
  }

  async *chatStream(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<string> {
    const chain = await this.chain(options.profileIds)
    const maxTokens = Math.min(...chain.map((profile, index) => contextLimitsFor(profile.contextWindow, index === 0 ? options : { ...options, model: undefined }, profile.model).maxOutputTokens))
    options = { ...options, maxTokens }
    let lastError: unknown = new Error('没有可用的模型供应商')
    for (const [index, profile] of chain.entries()) {
      const client = this.clientFor(profile)
      // A scenario's model override only applies to the first provider in the
      // chain; after a failover the fallback provider uses its own default
      // model, because model ids are not portable across providers.
      const attemptOptions = index === 0 ? options : { ...options, model: undefined }
      let produced = false
      try {
        await this.assertTextBudget(client, profile, messages, attemptOptions)
        for await (const delta of client.chatStream(messages, attemptOptions)) {
          produced = true
          yield delta
        }
        this.noteSuccess(profile, client)
        return
      } catch (error) {
        const kind = classifyModelError(error)
        if (produced || !shouldFailover(kind)) throw error
        lastError = error
        await this.parkProvider(profile, kind, error, chain.map(item => item.id))
      }
    }
    throw lastError
  }

  async chatOnce(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const chain = await this.chain(options.profileIds)
    const maxTokens = Math.min(...chain.map((profile, index) => contextLimitsFor(profile.contextWindow, index === 0 ? options : { ...options, model: undefined }, profile.model).maxOutputTokens))
    options = { ...options, maxTokens }
    let lastError: unknown = new Error('没有可用的模型供应商')
    for (const [index, profile] of chain.entries()) {
      const client = this.clientFor(profile)
      const attemptOptions = index === 0 ? options : { ...options, model: undefined }
      try {
        await this.assertTextBudget(client, profile, messages, attemptOptions)
        const reply = await client.chatOnce(messages, attemptOptions)
        this.noteSuccess(profile, client)
        return reply
      } catch (error) {
        const kind = classifyModelError(error)
        if (!shouldFailover(kind)) throw error
        lastError = error
        await this.parkProvider(profile, kind, error, chain.map(item => item.id))
      }
    }
    throw lastError
  }

  async vision(image: Buffer, prompt: string, options: ChatOptions = {}): Promise<string> {
    if (!this.client.visionModel && this.fallback?.vision) return await this.fallback.vision.vision(image, prompt, options)
    return await this.client.vision(image, prompt, options)
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!this.client.embedModel && this.fallback?.embedding) return await this.fallback.embedding.embed(text)
    return await this.client.embed(text)
  }

  async list(profile: ModelProfile): Promise<{ ok: boolean; models: string[]; error?: string }> {
    const client = createModelClient(profile)
    const health = await client.health(8000)
    return {
      ok: health.ok,
      models: health.models.map(item => item.name).filter(Boolean).slice(0, 200),
      error: health.error,
    }
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

  /**
   * Drop every cached provider and serve from `profile` without probing it.
   * Used after an erase resets the saved configuration.
   */
  resetTo(profile: ModelProfile): void {
    this.clients.clear()
    this.clientConfigs.clear()
    this.current = profile
    this.client = createModelClient(profile)
    this.clients.set(profile.id, this.client)
    this.clientConfigs.set(profile.id, this.configKey(profile))
    this.lastCooldowns = {}
  }

  /**
   * Manual switch from the settings UI: test first, then pin the profile and
   * clear its cooldown so it serves immediately.
   */
  async switchTo(profile: ModelProfile): Promise<{ status: ModelStatus; test: ModelTestResult }> {
    const test = await this.test(profile)
    if (!test.ok) throw new Error(test.message)
    this.client = createModelClient(profile)
    this.clients.set(profile.id, this.client)
    this.clientConfigs.set(profile.id, this.configKey(profile))
    this.current = profile
    if (this.failover) {
      try {
        const settings = await this.failover.loadSettings()
        this.lastCooldowns = { ...settings.cooldowns }
        if (settings.cooldowns[profile.id]) await this.failover.persistCooldown(profile.id, null)
      } catch {
        // A cooldown that cannot be cleared is cosmetic; the switch succeeded.
      }
    }
    this.logger?.info('model switched', { id: profile.id, kind: profile.kind, model: profile.model })
    return { status: this.status(), test }
  }
}
