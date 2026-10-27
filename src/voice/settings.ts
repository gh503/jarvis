import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isLoopbackHost } from '../model/settings.ts'
import { normalizeVoiceAdapter, resolveAsrAdapter, resolveTtsAdapter, type VoiceAdapter } from './providers.ts'

export type VoiceSource = 'local' | 'remote'
export type AsrTransport = 'websocket' | 'http'

export interface AsrProfile {
  id: string
  label: string
  kind: VoiceSource
  transport: AsrTransport
  baseUrl: string
  model: string
  apiKey: string
  language: string
  adapter?: VoiceAdapter
}

export interface TtsProfile {
  id: string
  label: string
  kind: VoiceSource
  baseUrl: string
  model: string
  voice: string
  apiKey: string
  adapter?: VoiceAdapter
}

/**
 * ASR and TTS are ordered failover chains, not single slots. Index 0 is the
 * preferred provider; when it is parked (quota, auth, rate limit, network) the
 * runtime walks to the next entry. The local engine is just another entry, so
 * "cloud first, local as the safety net" is expressible.
 */
export interface VoiceSettings {
  asr: AsrProfile[]
  tts: TtsProfile[]
}

export interface PublicAsrProfile extends Omit<AsrProfile, 'apiKey'> {
  hasKey: boolean
}
export interface PublicTtsProfile extends Omit<TtsProfile, 'apiKey'> {
  hasKey: boolean
}

export interface PublicVoiceSettings {
  asr: PublicAsrProfile[]
  tts: PublicTtsProfile[]
}

export interface VoiceUpdate {
  asr?: Array<Partial<AsrProfile>>
  tts?: Array<Partial<TtsProfile>>
}

export interface VoiceDefaults {
  asrModel: string
  asrEngine: string
  asrLanguage: string
  ttsVoice: string
}

const ID_PATTERN = /^[a-z0-9-]{1,32}$/

function transport(value: unknown, fallback: AsrTransport): AsrTransport {
  return value === 'http' || value === 'websocket' ? value : fallback
}

function asrProfile(value: Partial<AsrProfile>, fallback: AsrProfile): AsrProfile {
  const id = typeof value.id === 'string' && ID_PATTERN.test(value.id) ? value.id : fallback.id
  return {
    id,
    label: String(value.label ?? fallback.label).slice(0, 64),
    kind: value.kind === 'local' || value.kind === 'remote' ? value.kind : id === 'local' ? 'local' : fallback.kind,
    transport: transport(value.transport, fallback.transport),
    baseUrl: String(value.baseUrl ?? fallback.baseUrl ?? '').trim(),
    model: String(value.model ?? fallback.model ?? '').trim(),
    apiKey: String(value.apiKey ?? fallback.apiKey ?? ''),
    language: String(value.language ?? fallback.language ?? 'zh').trim().slice(0, 16),
    adapter: normalizeVoiceAdapter(value.adapter ?? fallback.adapter),
  }
}

function ttsProfile(value: Partial<TtsProfile>, fallback: TtsProfile): TtsProfile {
  const id = typeof value.id === 'string' && ID_PATTERN.test(value.id) ? value.id : fallback.id
  return {
    id,
    label: String(value.label ?? fallback.label).slice(0, 64),
    kind: value.kind === 'local' || value.kind === 'remote' ? value.kind : id === 'local' ? 'local' : fallback.kind,
    baseUrl: String(value.baseUrl ?? fallback.baseUrl ?? '').trim(),
    model: String(value.model ?? fallback.model ?? '').trim(),
    voice: String(value.voice ?? fallback.voice ?? '').trim(),
    apiKey: String(value.apiKey ?? fallback.apiKey ?? ''),
    adapter: normalizeVoiceAdapter(value.adapter ?? fallback.adapter),
  }
}

export function validateRemoteUrl(raw: string, label: string, allowedProtocols = ['http:', 'https:', 'ws:', 'wss:']): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${label} 不是合法链接`)
  }
  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(`${label} 只支持 ${allowedProtocols.map(item => item.replace(':', '')).join('/')}`)
  }
  if (url.username || url.password) throw new Error(`${label} 不能包含用户名或密码`)
  if (url.search || url.hash) throw new Error(`${label} 不要带查询参数或锚点，避免密钥出现在地址里`)
  if (url.hostname === '169.254.169.254' || url.hostname.toLowerCase() === 'metadata.google.internal') {
    throw new Error('不允许把语音地址指向云主机元数据服务')
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  if (!secure && !isLoopbackHost(url.hostname)) throw new Error(`${label} 必须使用 TLS（只有 localhost 可用 http/ws）`)
  return raw.replace(/\/+$/, '')
}

function validateSecret(apiKey: string): void {
  if (apiKey.includes('\n') || apiKey.includes('\r') || apiKey.length > 4096) throw new Error('API Key 不合法')
}

function validateAsr(profile: AsrProfile, index: number): void {
  if (normalizeVoiceAdapter(profile.adapter) === 'edge') throw new Error('Edge TTS 只能用于语音合成，不能作为 ASR')
  if (profile.kind === 'local') {
    if (profile.baseUrl) throw new Error(`本地 ASR（${profile.label}）不需要服务地址`)
    return
  }
  const label = profile.label || `第 ${index + 1} 个 ASR 服务`
  const adapter = resolveAsrAdapter(profile)
  // Native Gemini/Cloudflare audio endpoints are HTTP-only. Normalizing here
  // keeps old saved WebSocket settings usable instead of rejecting them.
  if (adapter !== 'openai') profile.transport = 'http'
  if (!profile.baseUrl) throw new Error(`${label} 还没有填写服务地址`)
  validateRemoteUrl(profile.baseUrl, label, profile.transport === 'websocket' ? ['http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:'])
  validateSecret(profile.apiKey)
  if (!['websocket', 'http'].includes(profile.transport)) throw new Error('ASR 传输方式不合法')
  if (!profile.model) throw new Error(`${label} 的模型不能为空`)
  profile.adapter = normalizeVoiceAdapter(profile.adapter)
}

function validateTts(profile: TtsProfile, index: number): void {
  const label = profile.label || `第 ${index + 1} 个 TTS 服务`
  if (profile.kind === 'local') {
    if (profile.baseUrl) throw new Error(`本地 TTS（${profile.label}）不需要服务地址`)
    return
  }
  const adapter = resolveTtsAdapter(profile)
  profile.adapter = normalizeVoiceAdapter(profile.adapter)
  if (adapter === 'edge') {
    // Edge TTS is a local command, not an HTTP endpoint.
    profile.baseUrl = ''
    profile.apiKey = ''
    if (!profile.model) profile.model = 'edge-tts'
    if (!profile.voice) throw new Error(`${label} 的音色不能为空`)
    return
  }
  if (!profile.baseUrl) throw new Error(`${label} 还没有填写服务地址`)
  validateRemoteUrl(profile.baseUrl, label, ['http:', 'https:'])
  validateSecret(profile.apiKey)
  if (!profile.model) throw new Error(`${label} 的模型不能为空`)
  if (!profile.voice) throw new Error(`${label} 的音色不能为空`)
}

function validateChain<T extends { id: string; kind: VoiceSource }>(kind: string, chain: T[], validateOne: (profile: T, index: number) => void): void {
  if (!Array.isArray(chain) || chain.length === 0) throw new Error(`${kind} 至少需要一个服务`)
  if (chain.length > 12) throw new Error(`${kind} 最多 12 个服务；再多了切换顺序也没人看得过来`)
  const ids = new Set<string>()
  chain.forEach((profile, index) => {
    if (!ID_PATTERN.test(profile.id)) throw new Error(`${kind} 的服务 id 不合法（${profile.id}）`)
    if (ids.has(profile.id)) throw new Error(`${kind} 的服务 id 重复（${profile.id}）`)
    ids.add(profile.id)
    validateOne(profile, index)
  })
  if (chain.filter(profile => profile.kind === 'local').length > 1) throw new Error(`${kind} 只能有一个本地引擎`)
}

export function validateVoiceSettings(settings: VoiceSettings): VoiceSettings {
  validateChain('ASR', settings.asr, validateAsr)
  validateChain('TTS', settings.tts, validateTts)
  return settings
}

function sameEndpoint(left: string, right: string): boolean {
  if (!left || !right) return left === right
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return left === right
  }
}

/**
 * An empty key means "keep the saved key", but only as long as the endpoint
 * stays the same. Re-pointing a provider at a different origin while keeping
 * the stored key would hand that key to whoever controls the new host, so the
 * same rule the model settings enforce applies here.
 */
function assertKeyStaysWithEndpoint(label: string, before: string, after: string, hasNewKey: boolean): void {
  // Surface URL problems (TLS, credentials in the URL, metadata service) before
  // the key-binding rule, so the person sees the more specific reason.
  if (after) validateRemoteUrl(after, label)
  if (hasNewKey || !before || sameEndpoint(before, after)) return
  throw new Error(`${label} 更换服务地址后需要重新输入 API Key，避免把旧密钥发给新地址`)
}

export class VoiceSettingsStore {
  private loaded: VoiceSettings | null = null

  constructor(
    private readonly file: string,
    private readonly defaults: VoiceDefaults,
  ) {}

  private localAsr(): AsrProfile {
    return {
      id: 'local', label: `本地 ${this.defaults.asrEngine}`, kind: 'local', transport: 'http',
      baseUrl: '', model: this.defaults.asrModel, apiKey: '', language: this.defaults.asrLanguage, adapter: 'auto',
    }
  }

  private localTts(): TtsProfile {
    return {
      id: 'local', label: '本地 Piper', kind: 'local', baseUrl: '',
      model: 'piper', voice: this.defaults.ttsVoice, apiKey: '', adapter: 'auto',
    }
  }

  private defaultSettings(): VoiceSettings {
    return { asr: [this.localAsr()], tts: [this.localTts()] }
  }

  /** Erase saved speech providers and remote keys; back to local defaults. */
  async resetToDefaults(): Promise<VoiceSettings> {
    await rm(this.file, { force: true })
    this.loaded = this.defaultSettings()
    return this.loaded
  }

  private legacyAsrRemote(): AsrProfile {
    return {
      id: 'remote', label: '远端 ASR', kind: 'remote', transport: 'websocket',
      baseUrl: '', model: 'whisper-1', apiKey: '', language: this.defaults.asrLanguage, adapter: 'auto',
    }
  }

  private legacyTtsRemote(): TtsProfile {
    return { id: 'remote', label: '远端 TTS', kind: 'remote', baseUrl: '', model: 'tts-1', voice: 'alloy', apiKey: '', adapter: 'auto' }
  }

  /**
   * Migrate the pre-chain shape ({activeAsr, asr:{local,remote}}) into an
   * ordered chain. The old "active" side becomes the preferred entry so an
   * existing setup keeps behaving as before until it is edited.
   */
  private migrate(saved: unknown): VoiceSettings {
    const value = (saved ?? {}) as {
      activeAsr?: unknown
      activeTts?: unknown
      asr?: { local?: Partial<AsrProfile>; remote?: Partial<AsrProfile> }
      tts?: { local?: Partial<TtsProfile>; remote?: Partial<TtsProfile> }
    }
    const asrLocal = asrProfile(value.asr?.local ?? {}, this.localAsr())
    const asrRemote = asrProfile(value.asr?.remote ?? {}, this.legacyAsrRemote())
    const ttsLocal = ttsProfile(value.tts?.local ?? {}, this.localTts())
    const ttsRemote = ttsProfile(value.tts?.remote ?? {}, this.legacyTtsRemote())
    // Only keep the old remote slot when it was actually configured; an empty
    // placeholder in the chain would produce a 4xx that cannot fail over.
    const usableAsr = Boolean(asrRemote.baseUrl)
    const usableTts = Boolean(ttsRemote.baseUrl) || resolveTtsAdapter(ttsRemote) === 'edge'
    const asr = value.activeAsr === 'remote' && usableAsr ? [asrRemote, asrLocal] : [asrLocal, ...(usableAsr ? [asrRemote] : [])]
    const tts = value.activeTts === 'remote' && usableTts ? [ttsRemote, ttsLocal] : [ttsLocal, ...(usableTts ? [ttsRemote] : [])]
    return { asr, tts }
  }

  async load(): Promise<VoiceSettings> {
    if (this.loaded) return this.loaded
    let saved: unknown = null
    try {
      await chmod(this.file, 0o600).catch(() => undefined)
      saved = JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      // First run.
    }
    const migrated = this.migrate(saved)
    const base = this.defaultSettings()
    const rawAsr = (saved as { asr?: unknown } | null)?.asr
    const rawTts = (saved as { tts?: unknown } | null)?.tts
    const asr = (Array.isArray(rawAsr) ? rawAsr as Array<Partial<AsrProfile>> : migrated.asr)
      .map(item => asrProfile(item, base.asr[0]))
    const tts = (Array.isArray(rawTts) ? rawTts as Array<Partial<TtsProfile>> : migrated.tts)
      .map(item => ttsProfile(item, base.tts[0]))
    const settings: VoiceSettings = { asr: asr.length ? asr : base.asr, tts: tts.length ? tts : base.tts }
    try {
      validateVoiceSettings(settings)
    } catch {
      // A chain with one invalid entry must not take the local engine down
      // with it: fall back to the local-only chain.
      return { asr: [base.asr[0]], tts: [base.tts[0]] }
    }
    this.loaded = settings
    return settings
  }

  async save(settings: VoiceSettings): Promise<void> {
    validateVoiceSettings(settings)
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.file)
    await chmod(this.file, 0o600).catch(() => undefined)
    this.loaded = settings
  }

  publicView(settings: VoiceSettings): PublicVoiceSettings {
    const hide = <T extends { apiKey: string }>(profile: T) => {
      const { apiKey, ...rest } = profile
      return { ...rest, hasKey: Boolean(apiKey) }
    }
    return { asr: settings.asr.map(hide), tts: settings.tts.map(hide) }
  }
}

/** Merge a browser update while treating an empty key as "keep the saved key". */
export function mergeVoiceUpdate(current: VoiceSettings, input: VoiceUpdate): VoiceSettings {
  const mergeChain = <T extends { id: string; baseUrl: string; apiKey: string; label: string }>(
    kind: string,
    currentChain: T[],
    incoming: Array<Partial<T>> | undefined,
    normalizeOne: (value: Partial<T>, fallback: T) => T,
  ): T[] => {
    if (!Array.isArray(incoming)) return currentChain
    return incoming.map((value, index) => {
      const previous = currentChain.find(item => item.id === value.id) ?? currentChain[index] ?? currentChain[0]
      const label = String(value.label ?? previous.label)
      assertKeyStaysWithEndpoint(
        label || `${kind} 第 ${index + 1} 个服务`,
        previous.baseUrl,
        value.baseUrl ?? previous.baseUrl,
        Boolean(value.apiKey?.trim()),
      )
      return normalizeOne(
        { ...previous, ...value, apiKey: value.apiKey?.trim() ? value.apiKey.trim() : previous.apiKey },
        previous,
      )
    })
  }
  const next: VoiceSettings = {
    asr: mergeChain('ASR', current.asr, input.asr as Array<Partial<AsrProfile>> | undefined, asrProfile),
    tts: mergeChain('TTS', current.tts, input.tts as Array<Partial<TtsProfile>> | undefined, ttsProfile),
  }
  return validateVoiceSettings(next)
}
