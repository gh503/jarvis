import type { AsrProfile, TtsProfile } from './settings.ts'

export type AsrAdapter = 'openai' | 'gemini' | 'cloudflare'
export type TtsAdapter = AsrAdapter | 'edge'
export type VoiceAdapter = 'auto' | AsrAdapter | TtsAdapter

const ASR_ADAPTERS = new Set<AsrAdapter>(['openai', 'gemini', 'cloudflare'])
const TTS_ADAPTERS = new Set<TtsAdapter>(['openai', 'gemini', 'cloudflare', 'edge'])

/** A saved or submitted adapter value. Unknown values fall back to auto. */
export function normalizeVoiceAdapter(value: unknown): VoiceAdapter {
  return value === 'openai' || value === 'gemini' || value === 'cloudflare' || value === 'edge'
    ? value
    : 'auto'
}

function hostAdapter(baseUrl: string): AsrAdapter {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    if (host === 'generativelanguage.googleapis.com') return 'gemini'
    if (host === 'api.cloudflare.com') return 'cloudflare'
  } catch {
    // URL validation reports the useful error later.
  }
  return 'openai'
}

export function resolveAsrAdapter(profile: Pick<AsrProfile, 'adapter' | 'baseUrl'>): AsrAdapter {
  const configured = normalizeVoiceAdapter(profile.adapter)
  if (configured === 'gemini' || configured === 'cloudflare' || configured === 'openai') return configured
  return hostAdapter(profile.baseUrl)
}

export function resolveTtsAdapter(profile: Pick<TtsProfile, 'adapter' | 'baseUrl'>): TtsAdapter {
  const configured = normalizeVoiceAdapter(profile.adapter)
  if (configured === 'edge' || configured === 'gemini' || configured === 'cloudflare' || configured === 'openai') return configured
  return hostAdapter(profile.baseUrl)
}

export function isAsrAdapter(value: string): value is AsrAdapter {
  return ASR_ADAPTERS.has(value as AsrAdapter)
}

export function isTtsAdapter(value: string): value is TtsAdapter {
  return TTS_ADAPTERS.has(value as TtsAdapter)
}

/** Gemini native base URL; accepts the OpenAI-compatible suffix people often paste. */
export function geminiBaseUrl(baseUrl: string): string {
  let base = baseUrl.replace(/\/+$/, '')
  if (/\/openai$/i.test(base)) base = base.slice(0, -'/openai'.length)
  try {
    const url = new URL(base)
    if (url.hostname.toLowerCase() === 'generativelanguage.googleapis.com' && (url.pathname === '' || url.pathname === '/')) {
      base = `${url.origin}/v1beta`
    }
  } catch {
    // URL validation reports the useful error later.
  }
  return base
}

export function geminiEndpoint(baseUrl: string, model: string, method: string): string {
  return `${geminiBaseUrl(baseUrl)}/models/${encodeURIComponent(model)}:${method}`
}

export interface CloudflareAccount {
  origin: string
  prefix: string
  accountId: string
}

/** Parse https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1. */
export function cloudflareAccount(baseUrl: string): CloudflareAccount | null {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return null
  }
  const match = url.pathname.match(/^(.*\/accounts\/([^/]+))\/ai\/(?:v1|run)(?:\/.*)?$/)
  if (!match) return null
  return { origin: url.origin, prefix: match[1], accountId: match[2] }
}

export function cloudflareRunUrl(baseUrl: string, model: string): string {
  const account = cloudflareAccount(baseUrl)
  if (!account) throw new Error('Cloudflare Base URL 需形如 https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1')
  const name = model.trim()
  if (!/^@cf\/[A-Za-z0-9._/-]+$/.test(name)) throw new Error('Cloudflare 模型需以 @cf/ 开头')
  return `${account.origin}${account.prefix}/ai/run/${name}`
}

/** PCM signed 16-bit little-endian to a playable mono WAV. */
export function pcmToWav(pcm: Buffer, sampleRate = 24_000, channels = 1, bits = 16): Buffer {
  const header = Buffer.alloc(44)
  const bytesPerFrame = Math.max(1, channels * Math.ceil(bits / 8))
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * bytesPerFrame, 28)
  header.writeUInt16LE(bytesPerFrame, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export function wavRateFromMime(mime: string): number {
  const match = /(?:rate|samplerate)=(\d+)/i.exec(mime)
  const value = match ? Number(match[1]) : 24_000
  return Number.isFinite(value) && value >= 8_000 && value <= 96_000 ? value : 24_000
}
