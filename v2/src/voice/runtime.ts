import type { Logger } from '../logger.ts'
import type { Transcriber, TranscriberState, Transcription } from './asr.ts'
import { RemoteSynthesizer, RemoteTranscriber } from './remote.ts'
import type { AsrProfile, PublicVoiceSettings, TtsProfile, VoiceSettings, VoiceSettingsStore } from './settings.ts'
import type { Synthesizer } from './tts.ts'

export interface VoiceRuntimeStatus {
  activeAsr: 'local' | 'remote'
  activeTts: 'local' | 'remote'
  asr: {
    id: string
    label: string
    kind: 'local' | 'remote'
    transport: string
    model: string
    baseUrl: string
    language: string
    state: string
    error: string | null
  }
  tts: {
    id: string
    label: string
    kind: 'local' | 'remote'
    model: string
    voice: string
    baseUrl: string
  }
}

export interface VoiceRuntimeOptions {
  store: VoiceSettingsStore
  localTranscriber: Transcriber & { start?(): Promise<void> }
  localSynthesizer: Synthesizer
  ffmpeg: string
  logger?: Logger
}

/**
 * Owns the active ASR/TTS pair. Conversation depends on this one facade, so a
 * settings change can swap providers without rebuilding the conversation or
 * dropping a turn in flight.
 */
export class VoiceRuntime implements Transcriber, Synthesizer {
  private settings: VoiceSettings
  private asr: Transcriber
  private tts: Synthesizer
  private remoteAsr: RemoteTranscriber | null = null
  private remoteTts: RemoteSynthesizer | null = null
  private closed = false

  constructor(private readonly options: VoiceRuntimeOptions) {
    // The store is loaded by initialize(); local is a safe synchronous
    // placeholder until then.
    this.settings = {
      activeAsr: 'local',
      activeTts: 'local',
      asr: {
        local: { id: 'local', label: '本地 ASR', kind: 'local', transport: 'http', baseUrl: '', model: '', apiKey: '', language: 'zh' },
        remote: { id: 'remote', label: '远端 ASR', kind: 'remote', transport: 'websocket', baseUrl: '', model: '', apiKey: '', language: 'zh' },
      },
      tts: {
        local: { id: 'local', label: '本地 TTS', kind: 'local', baseUrl: '', model: '', voice: '', apiKey: '' },
        remote: { id: 'remote', label: '远端 TTS', kind: 'remote', baseUrl: '', model: '', voice: '', apiKey: '' },
      },
    }
    this.asr = options.localTranscriber
    this.tts = options.localSynthesizer
  }

  async initialize(): Promise<VoiceSettings> {
    this.settings = await this.options.store.load()
    this.rebuild()
    return this.settings
  }

  settingsView(): PublicVoiceSettings {
    return this.options.store.publicView(this.settings)
  }

  private buildAsr(profile: AsrProfile): Transcriber {
    if (profile.kind === 'local') return this.options.localTranscriber
    return new RemoteTranscriber({ profile, ffmpeg: this.options.ffmpeg, logger: this.options.logger?.child('remote-asr') })
  }

  private buildTts(profile: TtsProfile): Synthesizer {
    if (profile.kind === 'local') return this.options.localSynthesizer
    return new RemoteSynthesizer({ profile, logger: this.options.logger?.child('remote-tts') })
  }

  private rebuild(): void {
    const oldAsr = this.remoteAsr
    const oldTts = this.remoteTts
    this.remoteAsr = null
    this.remoteTts = null
    const asrProfile = this.settings.asr[this.settings.activeAsr]
    const ttsProfile = this.settings.tts[this.settings.activeTts]
    this.asr = this.buildAsr(asrProfile)
    this.tts = this.buildTts(ttsProfile)
    if (this.asr instanceof RemoteTranscriber) this.remoteAsr = this.asr
    if (this.tts instanceof RemoteSynthesizer) this.remoteTts = this.tts
    if (oldAsr && oldAsr !== this.remoteAsr) void oldAsr.close().catch(() => undefined)
    if (oldTts && oldTts !== this.remoteTts) void oldTts.close().catch(() => undefined)
  }

  async apply(next: VoiceSettings): Promise<PublicVoiceSettings> {
    if (this.closed) throw new Error('语音运行时已经关闭')
    await this.options.store.save(next)
    this.settings = next
    this.rebuild()
    // Warm a local worker after switching back; a remote worker never needs
    // startup work and must not be billed on configuration.
    if (this.settings.activeAsr === 'local') {
      void this.options.localTranscriber.start?.().catch(error => {
        this.options.logger?.warn('local ASR warm-up failed after switch', { error: String(error) })
      })
    }
    return this.settingsView()
  }

  async start(): Promise<void> {
    if (this.settings.activeAsr !== 'local') return
    await this.options.localTranscriber.start?.()
  }

  async available(): Promise<boolean> {
    return await this.asr.available()
  }

  async transcribe(input: string | Buffer, extension?: string): Promise<Transcription> {
    return await this.asr.transcribe(input, extension)
  }

  state(): TranscriberState {
    return this.asr.state?.() ?? { state: 'ready' }
  }

  async synthesize(text: string, output: string): Promise<void> {
    await this.tts.synthesize(text, output)
  }

  async warmup(): Promise<void> {
    await this.tts.warmup?.()
  }

  async reconfigure(): Promise<void> {
    await this.tts.reconfigure?.()
  }

  status(): VoiceRuntimeStatus {
    const asr = this.settings.asr[this.settings.activeAsr]
    const tts = this.settings.tts[this.settings.activeTts]
    const asrState = this.asr.state?.() ?? { state: 'ready' as const }
    return {
      activeAsr: this.settings.activeAsr,
      activeTts: this.settings.activeTts,
      asr: {
        id: asr.id,
        label: asr.label,
        kind: asr.kind,
        transport: asr.transport,
        model: asr.model,
        baseUrl: asr.baseUrl,
        language: asr.language,
        state: asrState.state,
        error: asrState.error ?? null,
      },
      tts: {
        id: tts.id,
        label: tts.label,
        kind: tts.kind,
        model: tts.model,
        voice: tts.voice,
        baseUrl: tts.baseUrl,
      },
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.remoteAsr?.close().catch(() => undefined)
    await this.remoteTts?.close().catch(() => undefined)
    await this.options.localTranscriber.close?.().catch(() => undefined)
    await this.options.localSynthesizer.close?.().catch(() => undefined)
  }
}
