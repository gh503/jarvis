import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isLoopbackHost } from '../model/settings.ts'
import { normalizeVoiceAdapter, resolveAsrAdapter, resolveTtsAdapter, type VoiceAdapter } from './providers.ts'

export type VoiceSource = 'local' | 'remote'
export type AsrTransport = 'websocket' | 'http'

export interface AsrProfile {
  id: VoiceSource
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
  id: VoiceSource
  label: string
  kind: VoiceSource
  baseUrl: string
  model: string
  voice: string
  apiKey: string
  adapter?: VoiceAdapter
}

export interface VoiceSettings {
  activeAsr: VoiceSource
  activeTts: VoiceSource
  asr: { local: AsrProfile; remote: AsrProfile }
  tts: { local: TtsProfile; remote: TtsProfile }
}

export interface PublicAsrProfile extends Omit<AsrProfile, 'apiKey'> {
  hasKey: boolean
}
export interface PublicTtsProfile extends Omit<TtsProfile, 'apiKey'> {
  hasKey: boolean
}

export interface VoiceUpdate {
  activeAsr?: VoiceSource
  activeTts?: VoiceSource
  asr?: { local?: Partial<AsrProfile>; remote?: Partial<AsrProfile> }
  tts?: { local?: Partial<TtsProfile>; remote?: Partial<TtsProfile> }
}

export interface PublicVoiceSettings {
  activeAsr: VoiceSource
  activeTts: VoiceSource
  asr: { local: PublicAsrProfile; remote: PublicAsrProfile }
  tts: { local: PublicTtsProfile; remote: PublicTtsProfile }
}

export interface VoiceDefaults {
  asrModel: string
  asrEngine: string
  asrLanguage: string
  ttsVoice: string
}

function source(value: unknown, fallback: VoiceSource): VoiceSource {
  return value === 'remote' || value === 'local' ? value : fallback
}

function transport(value: unknown, fallback: AsrTransport): AsrTransport {
  return value === 'http' || value === 'websocket' ? value : fallback
}

function asrProfile(value: Partial<AsrProfile>, fallback: AsrProfile): AsrProfile {
  const id = value.id === 'remote' || value.id === 'local' ? value.id : fallback.id
  return {
    id,
    label: String(value.label ?? fallback.label).slice(0, 64),
    kind: id,
    transport: transport(value.transport, fallback.transport),
    baseUrl: String(value.baseUrl ?? fallback.baseUrl ?? '').trim(),
    model: String(value.model ?? fallback.model ?? '').trim(),
    apiKey: String(value.apiKey ?? fallback.apiKey ?? ''),
    language: String(value.language ?? fallback.language ?? 'zh').trim().slice(0, 16) || 'zh',
    adapter: normalizeVoiceAdapter(value.adapter ?? fallback.adapter),
  }
}

function ttsProfile(value: Partial<TtsProfile>, fallback: TtsProfile): TtsProfile {
  const id = value.id === 'remote' || value.id === 'local' ? value.id : fallback.id
  return {
    id,
    label: String(value.label ?? fallback.label).slice(0, 64),
    kind: id,
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

export function validateVoiceSettings(settings: VoiceSettings): VoiceSettings {
  // A local-only setup must be saved without forcing the person to fill a
  // remote provider first. Remote fields are validated when they are set, and
  // strictly when that side is actually active.
  const asrRemote = settings.asr.remote
  if (normalizeVoiceAdapter(asrRemote.adapter) === 'edge') throw new Error('Edge TTS 只能用于语音合成，不能作为 ASR')
  const asrAdapter = resolveAsrAdapter(asrRemote)
  asrRemote.adapter = normalizeVoiceAdapter(asrRemote.adapter)
  // Native Gemini/Cloudflare audio endpoints are HTTP-only. Normalizing here
  // keeps old saved WebSocket settings usable instead of rejecting them.
  if (asrAdapter !== 'openai') asrRemote.transport = 'http'
  if (asrRemote.baseUrl) {
    validateRemoteUrl(
      asrRemote.baseUrl,
      asrRemote.label,
      asrRemote.transport === 'websocket' ? ['http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:'],
    )
    validateSecret(asrRemote.apiKey)
    if (!['websocket', 'http'].includes(asrRemote.transport)) throw new Error('ASR 传输方式不合法')
  } else if (settings.activeAsr === 'remote') {
    throw new Error(`${asrRemote.label} 还没有填写服务地址`)
  }
  if (settings.activeAsr === 'remote' && !asrRemote.model) throw new Error('远端 ASR 模型不能为空')

  const ttsRemote = settings.tts.remote
  const ttsAdapter = resolveTtsAdapter(ttsRemote)
  ttsRemote.adapter = normalizeVoiceAdapter(ttsRemote.adapter)
  if (ttsAdapter === 'edge') {
    // Edge TTS is a local command, not an HTTP endpoint. It still uses the
    // remote slot so the rest of the runtime can switch engines uniformly.
    ttsRemote.baseUrl = ''
    ttsRemote.apiKey = ''
    if (!ttsRemote.model) ttsRemote.model = 'edge-tts'
  } else if (ttsRemote.baseUrl) {
    validateRemoteUrl(ttsRemote.baseUrl, ttsRemote.label, ['http:', 'https:'])
    validateSecret(ttsRemote.apiKey)
  } else if (settings.activeTts === 'remote') {
    throw new Error(`${ttsRemote.label} 还没有填写服务地址`)
  }
  if (settings.activeTts === 'remote' && !ttsRemote.model) throw new Error('远端 TTS 模型不能为空')
  if (settings.activeTts === 'remote' && !ttsRemote.voice) throw new Error('远端 TTS 音色不能为空')
  if (!['local', 'remote'].includes(settings.activeAsr) || !['local', 'remote'].includes(settings.activeTts)) {
    throw new Error('语音来源不合法')
  }
  return settings
}

export class VoiceSettingsStore {
  private loaded: VoiceSettings | null = null

  constructor(
    private readonly file: string,
    private readonly defaults: VoiceDefaults,
  ) {}

  private defaultSettings(): VoiceSettings {
    const localAsr: AsrProfile = {
      id: 'local', label: `本地 ${this.defaults.asrEngine}`, kind: 'local', transport: 'http',
      baseUrl: '', model: this.defaults.asrModel, apiKey: '', language: this.defaults.asrLanguage, adapter: 'auto',
    }
    const remoteAsr: AsrProfile = {
      id: 'remote', label: '远端 ASR', kind: 'remote', transport: 'websocket',
      baseUrl: '', model: 'whisper-1', apiKey: '', language: this.defaults.asrLanguage, adapter: 'auto',
    }
    const localTts: TtsProfile = {
      id: 'local', label: '本地 Piper', kind: 'local', baseUrl: '', model: 'piper', voice: this.defaults.ttsVoice, apiKey: '', adapter: 'auto',
    }
    const remoteTts: TtsProfile = {
      id: 'remote', label: '远端 TTS', kind: 'remote', baseUrl: '', model: 'tts-1', voice: 'alloy', apiKey: '', adapter: 'auto',
    }
    return {
      activeAsr: 'local', activeTts: 'local',
      asr: { local: localAsr, remote: remoteAsr },
      tts: { local: localTts, remote: remoteTts },
    }
  }

  /** Erase saved speech providers and remote keys; back to local defaults. */
  async resetToDefaults(): Promise<VoiceSettings> {
    await rm(this.file, { force: true })
    this.loaded = this.defaultSettings()
    return this.loaded
  }

  async load(): Promise<VoiceSettings> {
    if (this.loaded) return this.loaded
    let saved: Partial<VoiceSettings> = {}
    try {
      await chmod(this.file, 0o600).catch(() => undefined)
      saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<VoiceSettings>
    } catch {
      // First run.
    }
    const base = this.defaultSettings()
    const settings: VoiceSettings = {
      activeAsr: source(saved.activeAsr, base.activeAsr),
      activeTts: source(saved.activeTts, base.activeTts),
      asr: {
        local: asrProfile(saved.asr?.local ?? {}, base.asr.local),
        remote: asrProfile(saved.asr?.remote ?? {}, base.asr.remote),
      },
      tts: {
        local: ttsProfile(saved.tts?.local ?? {}, base.tts.local),
        remote: ttsProfile(saved.tts?.remote ?? {}, base.tts.remote),
      },
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
    return {
      activeAsr: settings.activeAsr,
      activeTts: settings.activeTts,
      asr: { local: hide(settings.asr.local), remote: hide(settings.asr.remote) },
      tts: { local: hide(settings.tts.local), remote: hide(settings.tts.remote) },
    }
  }
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

/** Merge a browser update while treating an empty key as "keep the saved key". */
export function mergeVoiceUpdate(current: VoiceSettings, input: VoiceUpdate): VoiceSettings {
  assertKeyStaysWithEndpoint(
    '远端 ASR',
    current.asr.remote.baseUrl,
    input.asr?.remote?.baseUrl ?? current.asr.remote.baseUrl,
    Boolean(input.asr?.remote?.apiKey?.trim()),
  )
  assertKeyStaysWithEndpoint(
    '远端 TTS',
    current.tts.remote.baseUrl,
    input.tts?.remote?.baseUrl ?? current.tts.remote.baseUrl,
    Boolean(input.tts?.remote?.apiKey?.trim()),
  )
  const next: VoiceSettings = {
    activeAsr: source(input.activeAsr, current.activeAsr),
    activeTts: source(input.activeTts, current.activeTts),
    asr: {
      local: asrProfile({ ...current.asr.local, ...(input.asr?.local ?? {}), id: 'local', kind: 'local' }, current.asr.local),
      remote: asrProfile({ ...current.asr.remote, ...(input.asr?.remote ?? {}), id: 'remote', kind: 'remote', apiKey: input.asr?.remote?.apiKey?.trim() ? input.asr.remote.apiKey.trim() : current.asr.remote.apiKey }, current.asr.remote),
    },
    tts: {
      local: ttsProfile({ ...current.tts.local, ...(input.tts?.local ?? {}), id: 'local', kind: 'local' }, current.tts.local),
      remote: ttsProfile({ ...current.tts.remote, ...(input.tts?.remote ?? {}), id: 'remote', kind: 'remote', apiKey: input.tts?.remote?.apiKey?.trim() ? input.tts.remote.apiKey.trim() : current.tts.remote.apiKey }, current.tts.remote),
    },
  }
  return validateVoiceSettings(next)
}
