import type { Logger } from '../logger.ts'
import { classifyModelError, cooldownMs, shouldFailover, type FailureKind } from '../model/failover.ts'
import type { Transcriber, TranscriberState, Transcription } from './asr.ts'
import { EdgeSynthesizer } from './edge.ts'
import type { VoiceHealthStore } from './health.ts'
import { RemoteSynthesizer, RemoteTranscriber } from './remote.ts'
import { resolveAsrAdapter, resolveTtsAdapter } from './providers.ts'
import type { AsrProfile, PublicVoiceSettings, TtsProfile, VoiceSettings, VoiceSettingsStore } from './settings.ts'
import type { Synthesizer } from './tts.ts'

export interface VoiceChainEntry {
  id: string
  label: string
  kind: 'local' | 'remote'
  model: string
  adapter: string
  /** Epoch ms when this provider becomes usable again, or null. */
  coolingUntil: number | null
  preferred: boolean
}

export interface VoiceFailoverNotice {
  kind: 'asr' | 'tts'
  from: string
  fromLabel: string
  to: string
  toLabel: string
  failure: FailureKind
  reason: string
  cooldownUntil: number
  at: string
}

export interface VoiceRuntimeStatus {
  asr: {
    id: string
    label: string
    kind: 'local' | 'remote'
    transport: string
    adapter: string
    model: string
    baseUrl: string
    language: string
    state: string
    error: string | null
    chain: VoiceChainEntry[]
  }
  tts: {
    id: string
    label: string
    kind: 'local' | 'remote'
    adapter: string
    model: string
    voice: string
    baseUrl: string
    chain: VoiceChainEntry[]
  }
  lastFailover: VoiceFailoverNotice | null
  /** Which chain entry actually handled the last request. */
  serving: { asr: string, tts: string }
}

export interface VoiceRuntimeOptions {
  store: VoiceSettingsStore
  localTranscriber: Transcriber & { start?(): Promise<void> }
  localSynthesizer: Synthesizer
  ffmpeg: string
  logger?: Logger
  health?: VoiceHealthStore
  emit?: (event: string, payload: Record<string, unknown>) => void
}

/**
 * Owns the ASR/TTS chains. Conversation depends on this one facade, so a
 * settings change can swap providers without rebuilding the conversation or
 * dropping a turn in flight.
 *
 * Each request walks the chain from the top, skipping providers that are
 * parked after a quota/auth/rate-limit/network failure, and hands the same
 * audio or text to the next provider when one cannot serve. Failures that are
 * our own fault (a bad request, an unsupported model name) are surfaced
 * immediately instead of silently switching engines.
 */
export class VoiceRuntime implements Transcriber, Synthesizer {
  private settings: VoiceSettings
  private readonly asrInstances = new Map<string, Transcriber>()
  private readonly ttsInstances = new Map<string, Synthesizer>()
  private serving = { asr: '', tts: '' }
  private lastFailover: VoiceFailoverNotice | null = null
  private closed = false

  constructor(private readonly options: VoiceRuntimeOptions) {
    // The store is loaded by initialize(); local is a safe synchronous
    // placeholder until then.
    this.settings = {
      asr: [{ id: 'local', label: '本地 ASR', kind: 'local', transport: 'http', baseUrl: '', model: '', apiKey: '', language: 'zh' }],
      tts: [{ id: 'local', label: '本地 TTS', kind: 'local', baseUrl: '', model: '', voice: '', apiKey: '' }],
    }
  }

  async initialize(): Promise<VoiceSettings> {
    this.settings = await this.options.store.load()
    await this.options.health?.load()
    await this.syncCooldowns()
    return this.settings
  }

  settingsView(): PublicVoiceSettings {
    return this.options.store.publicView(this.settings)
  }

  cooldowns(): { asr: Record<string, { until: number, kind: string, reason: string }>, tts: Record<string, { until: number, kind: string, reason: string }> } {
    return this.options.health?.snapshot() ?? { asr: {}, tts: {} }
  }

  private chain(kind: 'asr' | 'tts'): Array<AsrProfile | TtsProfile> {
    return kind === 'asr' ? this.settings.asr : this.settings.tts
  }

  private profile(kind: 'asr' | 'tts', id: string): AsrProfile | TtsProfile | undefined {
    return this.chain(kind).find(entry => entry.id === id)
  }

  private buildAsr(profile: AsrProfile): Transcriber {
    if (profile.kind === 'local') return this.options.localTranscriber
    return new RemoteTranscriber({ profile, ffmpeg: this.options.ffmpeg, logger: this.options.logger?.child('remote-asr') })
  }

  private buildTts(profile: TtsProfile): Synthesizer {
    if (profile.kind === 'local') return this.options.localSynthesizer
    if (resolveTtsAdapter(profile) === 'edge') {
      return new EdgeSynthesizer({ voice: profile.voice, ffmpeg: this.options.ffmpeg, logger: this.options.logger?.child('edge-tts') })
    }
    return new RemoteSynthesizer({ profile, ffmpeg: this.options.ffmpeg, logger: this.options.logger?.child('remote-tts') })
  }

  private instanceFor(kind: 'asr', profile: AsrProfile): Transcriber
  private instanceFor(kind: 'tts', profile: TtsProfile): Synthesizer
  private instanceFor(kind: 'asr' | 'tts', profile: AsrProfile | TtsProfile): Transcriber | Synthesizer {
    if (kind === 'asr') {
      const asr = profile as AsrProfile
      const existing = this.asrInstances.get(asr.id)
      if (existing) return existing
      const created = this.buildAsr(asr)
      this.asrInstances.set(asr.id, created)
      return created
    }
    const tts = profile as TtsProfile
    const existing = this.ttsInstances.get(tts.id)
    if (existing) return existing
    const created = this.buildTts(tts)
    this.ttsInstances.set(tts.id, created)
    return created
  }

  /** Local engines need a warm-up; remote ones must not be billed for it. */
  private async warmLocal(kind: 'asr' | 'tts', profile: AsrProfile | TtsProfile): Promise<void> {
    if (profile.kind !== 'local') return
    if (kind === 'asr') {
      await this.options.localTranscriber.start?.().catch(error => {
        this.options.logger?.warn('local ASR warm-up failed', { error: String(error) })
      })
    }
  }

  private failureKind(kind: 'asr' | 'tts', profile: AsrProfile | TtsProfile, error: unknown): FailureKind {
    const base = classifyModelError(error)
    if (profile.kind === 'local') {
      // A broken local worker should hand the request to a configured remote
      // instead of failing the same way every time.
      return base === 'client' || base === 'other' ? 'server' : base
    }
    if (kind === 'tts' && resolveTtsAdapter(profile as TtsProfile) === 'edge') {
      const message = String((error as { message?: string })?.message ?? error).toLowerCase()
      if (/enoent|not found|未安装|spawn|command/.test(message)) return 'server'
    }
    return base
  }

  private async park(kind: 'asr' | 'tts', profile: AsrProfile | TtsProfile, failure: FailureKind, error: unknown, next?: AsrProfile | TtsProfile): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error)
    const until = Date.now() + cooldownMs(failure)
    this.options.logger?.warn('voice provider parked', { kind, id: profile.id, failure, reason })
    try {
      await this.options.health?.park(kind, profile.id, { until, kind: failure, reason: reason.slice(0, 300) })
    } catch (persistError) {
      this.options.logger?.warn('voice cooldown persist failed', { error: String(persistError) })
    }
    if (!next) return
    const notice: VoiceFailoverNotice = {
      kind,
      from: profile.id,
      fromLabel: profile.label,
      to: next.id,
      toLabel: next.label,
      failure,
      reason: reason.slice(0, 300),
      cooldownUntil: until,
      at: new Date().toISOString(),
    }
    this.lastFailover = notice
    this.options.emit?.('voice.failover', { ...notice })
  }

  private async runChain<R>(
    kind: 'asr' | 'tts',
    run: (instance: Transcriber | Synthesizer) => Promise<R>,
  ): Promise<R> {
    const chain = this.chain(kind)
    const now = Date.now()
    const healthy = chain.filter(profile => !this.options.health?.isCooling(kind, profile.id, now))
    // When every provider is parked we still try them in order: a cooldown may
    // be stale (a free tier refilled, a key was fixed) and refusing outright
    // would turn a recovered setup into a dead one.
    const order = healthy.length ? healthy : chain
    let lastError: unknown = null
    for (const [index, profile] of order.entries()) {
      try {
        const instance = kind === 'asr'
          ? this.instanceFor('asr', profile as AsrProfile)
          : this.instanceFor('tts', profile as TtsProfile)
        const result = await run(instance)
        this.serving[kind] = profile.id
        void this.warmLocal(kind, profile)
        return result
      } catch (error) {
        lastError = error
        const failure = this.failureKind(kind, profile, error)
        const next = order[index + 1]
        this.options.logger?.warn('voice request failed', {
          kind, id: profile.id, failure,
          error: error instanceof Error ? error.message : String(error),
        })
        if (!shouldFailover(failure)) throw error
        await this.park(kind, profile, failure, error, shouldFailover(failure) ? next : undefined)
        if (!next) throw error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(latestSpeechError(lastError))
  }

  async apply(next: VoiceSettings): Promise<PublicVoiceSettings> {
    if (this.closed) throw new Error('语音运行时已经关闭')
    await this.options.store.save(next)
    this.settings = next
    await this.syncCooldowns()
    // Rebuild lazily: provider configs may have changed under the same id.
    await this.disposeInstances()
    this.serving = { asr: '', tts: '' }
    const firstAsr = next.asr[0]
    if (firstAsr?.kind === 'local') {
      void this.options.localTranscriber.start?.().catch(error => {
        this.options.logger?.warn('local ASR warm-up failed after switch', { error: String(error) })
      })
    }
    return this.settingsView()
  }

  private async syncCooldowns(): Promise<void> {
    if (!this.options.health) return
    await this.options.health.retain('asr', new Set(this.settings.asr.map(entry => entry.id)))
    await this.options.health.retain('tts', new Set(this.settings.tts.map(entry => entry.id)))
  }

  private async disposeInstances(): Promise<void> {
    for (const instance of this.asrInstances.values()) {
      if (instance !== this.options.localTranscriber) await instance.close?.().catch(() => undefined)
    }
    for (const instance of this.ttsInstances.values()) {
      if (instance !== this.options.localSynthesizer) await instance.close?.().catch(() => undefined)
    }
    this.asrInstances.clear()
    this.ttsInstances.clear()
  }

  async start(): Promise<void> {
    const first = this.settings.asr[0]
    if (first?.kind !== 'local') return
    await this.options.localTranscriber.start?.()
  }

  async available(): Promise<boolean> {
    const first = this.settings.asr[0]
    return await this.instanceFor('asr', first).available()
  }

  async transcribe(input: string | Buffer, extension?: string): Promise<Transcription> {
    return await this.runChain('asr', instance => (instance as Transcriber).transcribe(input, extension))
  }

  state(): TranscriberState {
    const first = this.settings.asr[0]
    const instance = this.asrInstances.get(first?.id ?? '') ?? (first ? this.instanceFor('asr', first) : null)
    return instance?.state?.() ?? { state: 'ready' }
  }

  async synthesize(text: string, output: string): Promise<void> {
    await this.runChain('tts', instance => (instance as Synthesizer).synthesize(text, output))
  }

  async warmup(): Promise<void> {
    const first = this.settings.tts[0]
    if (!first) return
    await this.instanceFor('tts', first).warmup?.()
  }

  async reconfigure(): Promise<void> {
    for (const instance of this.ttsInstances.values()) await instance.reconfigure?.()
  }

  private chainStatus(kind: 'asr' | 'tts'): VoiceChainEntry[] {
    const cooldowns = this.options.health?.snapshot()[kind] ?? {}
    return this.chain(kind).map((profile, index) => ({
      id: profile.id,
      label: profile.label,
      kind: profile.kind,
      model: profile.model,
      adapter: profile.kind === 'local'
        ? 'local'
        : kind === 'asr'
          ? resolveAsrAdapter(profile as AsrProfile)
          : resolveTtsAdapter(profile as TtsProfile),
      coolingUntil: cooldowns[profile.id]?.until ?? null,
      preferred: index === 0,
    }))
  }

  status(): VoiceRuntimeStatus {
    const asrFirst = this.settings.asr[0]
    const ttsFirst = this.settings.tts[0]
    const asrState = this.state()
    return {
      asr: {
        id: asrFirst?.id ?? 'local',
        label: asrFirst?.label ?? '本地 ASR',
        kind: asrFirst?.kind ?? 'local',
        transport: asrFirst?.transport ?? 'http',
        adapter: asrFirst ? resolveAsrAdapter(asrFirst) : 'openai',
        model: asrFirst?.model ?? '',
        baseUrl: asrFirst?.baseUrl ?? '',
        language: asrFirst?.language ?? 'zh',
        state: asrState.state,
        error: asrState.error ?? null,
        chain: this.chainStatus('asr'),
      },
      tts: {
        id: ttsFirst?.id ?? 'local',
        label: ttsFirst?.label ?? '本地 TTS',
        kind: ttsFirst?.kind ?? 'local',
        adapter: ttsFirst ? resolveTtsAdapter(ttsFirst) : 'openai',
        model: ttsFirst?.model ?? '',
        voice: ttsFirst?.voice ?? '',
        baseUrl: ttsFirst?.baseUrl ?? '',
        chain: this.chainStatus('tts'),
      },
      lastFailover: this.lastFailover,
      serving: { asr: this.serving.asr || (asrFirst?.id ?? ''), tts: this.serving.tts || (ttsFirst?.id ?? '') },
    }
  }

  async clearHealth(): Promise<void> {
    await this.options.health?.clearAll()
    this.lastFailover = null
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.disposeInstances()
    await this.options.localTranscriber.close?.().catch(() => undefined)
    await this.options.localSynthesizer.close?.().catch(() => undefined)
  }
}

function latestSpeechError(error: unknown): string {
  return `所有语音服务都失败了：${error instanceof Error ? error.message : String(error)}`
}
