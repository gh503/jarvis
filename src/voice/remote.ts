import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { Logger } from '../logger.ts'
import type { Transcriber, TranscriberState, Transcription } from './asr.ts'
import { makeTempDir, toWav } from './media.ts'
import { cloudflareRunUrl, geminiEndpoint, pcmToWav, resolveAsrAdapter, resolveTtsAdapter, wavRateFromMime } from './providers.ts'
import type { AsrProfile, TtsProfile } from './settings.ts'
import type { Synthesizer } from './tts.ts'

type WavInfo = { pcm: Buffer; sampleRate: number; channels: number; bits: number }

interface GeminiInline { mimeType?: string; mime_type?: string; data?: string }

interface GeminiAudioResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: GeminiInline
        inline_data?: GeminiInline
      }>
    }
  }>
}

function isWav(buffer: Buffer): boolean {
  return buffer.length > 44 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE'
}

function parseWav(buffer: Buffer): WavInfo {
  if (!isWav(buffer)) throw new Error('不是 WAV 音频')
  let offset = 12
  let sampleRate = 16000
  let channels = 1
  let bits = 16
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = Math.min(buffer.length, start + size)
    if (id === 'fmt ' && size >= 16) {
      channels = buffer.readUInt16LE(start + 2)
      sampleRate = buffer.readUInt32LE(start + 4)
      bits = buffer.readUInt16LE(start + 14)
    }
    if (id === 'data') return { pcm: buffer.subarray(start, end), sampleRate, channels, bits }
    offset = start + size + (size % 2)
  }
  throw new Error('WAV 缺少 data 段')
}

function audioMs(info: WavInfo): number {
  const bytesPerFrame = Math.max(1, info.channels * Math.max(1, info.bits / 8))
  return Math.round(info.pcm.length / bytesPerFrame / info.sampleRate * 1000)
}

/** Append an endpoint to an OpenAI-compatible base without duplicating paths. */
function endpoint(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (base.endsWith(suffix)) return base
  if (/\/(audio\/transcriptions|audio\/speech|models)$/.test(base)) return base.replace(/\/(audio\/transcriptions|audio\/speech|models)$/, suffix)
  try {
    const url = new URL(base)
    const path = url.pathname.replace(/\/+$/, '')
    if (path === '' || path === '/') return `${base}/v1${suffix}`
    return `${base}${suffix}`
  } catch {
    return `${base}${suffix}`
  }
}

function wsEndpoint(baseUrl: string): string {
  if (/^wss?:\/\//i.test(baseUrl)) return baseUrl
  if (/^https?:\/\//i.test(baseUrl)) {
    return baseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
  }
  return baseUrl
}

async function toWavBuffer(input: string | Buffer, extension: string, ffmpeg: string): Promise<{ wav: Buffer; sourceMs?: number }> {
  if (typeof input === 'string') {
    if (extension === 'wav') return { wav: await readFile(input) }
    const dir = await makeTempDir('jarvis-remote-asr-')
    try {
      const wavPath = join(dir, 'input.wav')
      await toWav(ffmpeg, input, wavPath)
      return { wav: await readFile(wavPath) }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  if (extension === 'wav' || isWav(input)) return { wav: input }
  const dir = await makeTempDir('jarvis-remote-asr-')
  try {
    const source = join(dir, `input.${extension || 'webm'}`)
    const wavPath = join(dir, 'input.wav')
    await writeFile(source, input)
    await toWav(ffmpeg, source, wavPath)
    return { wav: await readFile(wavPath) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function authHeader(profile: { apiKey: string }): Record<string, string> {
  return profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Remote ASR.
 *
 * HTTP is the OpenAI-compatible multipart `/audio/transcriptions` contract.
 * WebSocket is the Jarvis streaming contract documented in docs/voice.md:
 *   client -> {type:"start",model,language,...}; binary PCM s16le frames;
 *   client -> {type:"end"}; server -> {type:"partial"|"final"|"error",...}
 * It is a real transport, not a POST wrapped in a socket: audio is forwarded
 * while it is still being produced by the caller.
 */
export class RemoteTranscriber implements Transcriber {
  private lastState: TranscriberState = { state: 'ready' }

  constructor(private readonly options: {
    profile: AsrProfile
    ffmpeg: string
    logger?: Logger
  }) {}

  async available(): Promise<boolean> {
    return Boolean(this.options.profile.baseUrl)
  }

  state(): TranscriberState {
    return this.lastState
  }

  private async prepare(input: string | Buffer, extension: string): Promise<Buffer> {
    const result = await toWavBuffer(input, extension, this.options.ffmpeg)
    return result.wav
  }

  async transcribe(input: string | Buffer, extension = 'wav'): Promise<Transcription> {
    const started = Date.now()
    if (!this.options.profile.baseUrl) throw new Error('远端 ASR 还没有配置服务地址')
    const wav = await this.prepare(input, extension)
    const info = parseWav(wav)
    this.lastState = { state: 'ready' }
    try {
      const adapter = resolveAsrAdapter(this.options.profile)
      const result = adapter === 'gemini'
        ? await this.viaGemini(wav, info, started)
        : adapter === 'cloudflare'
          ? await this.viaCloudflare(wav, info, started)
          : this.options.profile.transport === 'websocket'
            ? await this.viaWebSocket(wav, info, started)
            : await this.viaHttp(wav, info, extension, started)
      this.lastState = { state: 'ready' }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastState = { state: 'error', error: message }
      throw error
    }
  }

  private async viaGemini(wav: Buffer, info: WavInfo, started: number): Promise<Transcription> {
    const profile = this.options.profile
    if (!profile.model) throw new Error('Gemini ASR 需要填写模型，例如 gemini-3.5-transcribe')
    if (wav.length > 18_000_000) throw new Error('Gemini 单次音频不能超过 18 MB')
    const languageName = profile.language === 'zh' ? '中文' : profile.language === 'en' ? 'English' : profile.language
    const response = await fetch(geminiEndpoint(profile.baseUrl, profile.model, 'generateContent'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': profile.apiKey },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: `逐字转写这段音频为${languageName}，只返回转写文本，不要解释。` },
            { inline_data: { mime_type: 'audio/wav', data: wav.toString('base64') } },
          ],
        }],
        generationConfig: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(120_000),
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(`Gemini ASR 失败：HTTP ${response.status} ${raw.slice(0, 300)}`)
    let data: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      promptFeedback?: { blockReason?: string }
    }
    try {
      data = JSON.parse(raw) as typeof data
    } catch {
      throw new Error('Gemini ASR 返回了非 JSON 内容')
    }
    const text = (data.candidates?.[0]?.content?.parts ?? []).map(part => part.text ?? '').join('').trim()
    if (!text && data.promptFeedback?.blockReason) throw new Error(`Gemini 拒绝了这段音频：${data.promptFeedback.blockReason}`)
    return { text, language: profile.language || 'zh', durationMs: Date.now() - started, audioMs: audioMs(info) }
  }

  private async viaCloudflare(wav: Buffer, info: WavInfo, started: number): Promise<Transcription> {
    const profile = this.options.profile
    if (!profile.model) throw new Error('Cloudflare ASR 需要填写模型，例如 @cf/openai/whisper')
    if (wav.length > 20_000_000) throw new Error('Cloudflare 单次音频不能超过 20 MB')
    const response = await fetch(cloudflareRunUrl(profile.baseUrl, profile.model), {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.apiKey}`, 'content-type': 'audio/wav' },
      body: new Uint8Array(wav),
      signal: AbortSignal.timeout(120_000),
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(`Cloudflare ASR 失败：HTTP ${response.status} ${raw.slice(0, 300)}`)
    let data: { result?: { text?: string; language?: string } | string; text?: string; language?: string }
    try {
      data = JSON.parse(raw) as typeof data
    } catch {
      throw new Error('Cloudflare ASR 返回了非 JSON 内容')
    }
    const text = typeof data.result === 'string'
      ? data.result
      : String(data.result?.text ?? data.text ?? '')
    const language = String(data.result && typeof data.result !== 'string' ? data.result.language ?? profile.language ?? 'zh' : data.language ?? profile.language ?? 'zh')
    return { text: text.trim(), language, durationMs: Date.now() - started, audioMs: audioMs(info) }
  }

  private async viaHttp(wav: Buffer, info: WavInfo, extension: string, started: number): Promise<Transcription> {
    const profile = this.options.profile
    const form = new FormData()
    const fileBytes = Uint8Array.from(wav)
    form.append('file', new Blob([fileBytes.buffer], { type: 'audio/wav' }), 'audio.wav')
    form.append('model', profile.model)
    if (profile.language) form.append('language', profile.language)
    const response = await fetch(endpoint(profile.baseUrl, '/audio/transcriptions'), {
      method: 'POST',
      headers: authHeader(profile),
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(`远端 ASR 失败：HTTP ${response.status} ${raw.slice(0, 300)}`)
    let text = ''
    let language = profile.language || 'zh'
    try {
      const data = JSON.parse(raw) as { text?: string; language?: string; result?: { text?: string } }
      text = String(data.text ?? data.result?.text ?? '').trim()
      language = String(data.language ?? language)
    } catch {
      text = raw.trim()
    }
    return { text, language, durationMs: Date.now() - started, audioMs: audioMs(info) }
  }

  private async viaWebSocket(wav: Buffer, info: WavInfo, started: number): Promise<Transcription> {
    const profile = this.options.profile
    const url = wsEndpoint(profile.baseUrl)
    const socket = new WebSocket(url, { headers: authHeader(profile) })
    const binaryType = 'arraybuffer'
    socket.binaryType = binaryType
    let settled = false
    let transcript = ''
    let language = profile.language || 'zh'
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error) {
        socket.terminate()
        rejectPromise(error)
      } else {
        socket.close()
        resolvePromise()
      }
    }
    let resolvePromise: () => void = () => undefined
    let rejectPromise: (error: Error) => void = () => undefined
    const done = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const timer = setTimeout(() => finish(new Error('远端 ASR WebSocket 超时')), 120_000)
    timer.unref()
    socket.on('open', async () => {
      try {
        socket.send(JSON.stringify({
          type: 'start',
          model: profile.model,
          language: profile.language || 'zh',
          format: 'pcm_s16le',
          sampleRate: info.sampleRate,
          channels: info.channels,
        }))
        const chunk = 3200
        for (let offset = 0; offset < info.pcm.length; offset += chunk) {
          if (settled || socket.readyState !== WebSocket.OPEN) break
          socket.send(info.pcm.subarray(offset, Math.min(info.pcm.length, offset + chunk)))
          // Yield so a slow socket can apply backpressure instead of building
          // an unbounded in-memory queue for a long utterance.
          if (offset % (chunk * 20) === 0) await wait(1)
        }
        if (!settled && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'end' }))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return
      let payload: { type?: string; text?: string; language?: string; error?: string }
      try {
        payload = JSON.parse(raw.toString()) as typeof payload
      } catch {
        return
      }
      if (payload.error) {
        finish(new Error(payload.error))
        return
      }
      if (payload.language) language = payload.language
      if (payload.type === 'partial' && payload.text) transcript = payload.text
      if (payload.type === 'final' || (payload.text && !payload.type)) {
        transcript = String(payload.text ?? transcript).trim()
        finish()
      }
    })
    socket.on('error', error => finish(new Error(`远端 ASR WebSocket 失败：${error.message}`)))
    socket.on('close', () => {
      if (!settled) {
        if (transcript) finish()
        else finish(new Error('远端 ASR WebSocket 在返回结果前关闭'))
      }
    })
    try {
      await done
    } finally {
      clearTimeout(timer)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate()
    }
    return { text: transcript, language, durationMs: Date.now() - started, audioMs: audioMs(info) }
  }

  async close(): Promise<void> {
    this.lastState = { state: 'idle' }
  }
}

/** Remote TTS: OpenAI `/audio/speech`, Gemini native TTS, or Cloudflare Workers AI. */
export class RemoteSynthesizer implements Synthesizer {
  constructor(private readonly options: {
    profile: TtsProfile
    ffmpeg?: string
    logger?: Logger
  }) {}

  async available(): Promise<boolean> {
    const adapter = resolveTtsAdapter(this.options.profile)
    return adapter === 'edge' || Boolean(this.options.profile.baseUrl)
  }

  async synthesize(text: string, output: string): Promise<void> {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) throw new Error('cannot synthesize empty text')
    const profile = this.options.profile
    const adapter = resolveTtsAdapter(profile)
    if (adapter !== 'edge' && !profile.baseUrl) throw new Error('远端 TTS 还没有配置服务地址')
    const bytes = adapter === 'gemini'
      ? await this.geminiSpeech(clean)
      : adapter === 'cloudflare'
        ? await this.cloudflareSpeech(clean)
        : await this.openaiSpeech(clean)
    if (!bytes.length) throw new Error('远端 TTS 返回了空音频')
    if (bytes.length > 20_000_000) throw new Error('远端 TTS 音频超过 20 MB 上限')
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    if (isWav(bytes)) {
      await writeFile(output, bytes, { mode: 0o600 })
    } else {
      await this.convertToWav(bytes, output)
    }
    this.options.logger?.debug('remote tts synthesized', { chars: clean.length, bytes: bytes.length, request: randomUUID().slice(0, 8) })
  }

  private async openaiSpeech(text: string): Promise<Buffer> {
    const profile = this.options.profile
    const response = await fetch(endpoint(profile.baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(profile) },
      body: JSON.stringify({
        model: profile.model,
        input: text.slice(0, 4000),
        voice: profile.voice,
        response_format: 'wav',
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`远端 TTS 失败：HTTP ${response.status} ${detail.slice(0, 300)}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      throw new Error('远端 TTS 返回了 JSON 而不是音频；检查地址与模型权限')
    }
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > 20_000_000) throw new Error('远端 TTS 音频超过 20 MB 上限')
    return Buffer.from(await response.arrayBuffer())
  }

  private async geminiSpeech(text: string): Promise<Buffer> {
    const profile = this.options.profile
    if (!profile.model) throw new Error('Gemini TTS 需要填写模型，例如 gemini-3.8-flash-tts')
    const response = await fetch(geminiEndpoint(profile.baseUrl, profile.model, 'generateContent'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': profile.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: profile.voice || 'Kore' } },
          },
        },
      }),
      signal: AbortSignal.timeout(120_000),
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(`Gemini TTS 失败：HTTP ${response.status} ${raw.slice(0, 300)}`)
    let payload: GeminiAudioResponse | null = null
    try { payload = JSON.parse(raw) as GeminiAudioResponse } catch { payload = null }
    const part = payload?.candidates?.[0]?.content?.parts?.find(item => item.inlineData?.data || item.inline_data?.data)
    const inline = part?.inlineData ?? part?.inline_data
    if (!inline?.data) throw new Error('Gemini TTS 没有返回音频；检查模型是否支持 TTS 与音色名')
    const mime = inline.mimeType ?? inline.mime_type ?? 'audio/L16'
    const bytes = Buffer.from(inline.data, 'base64')
    if (/wav/i.test(mime) || isWav(bytes)) return bytes
    if (/mpeg|mp3/i.test(mime)) return bytes
    return pcmToWav(bytes, wavRateFromMime(mime), 1, 16)
  }

  private async cloudflareSpeech(text: string): Promise<Buffer> {
    const profile = this.options.profile
    if (!profile.model) throw new Error('Cloudflare TTS 需要填写模型，例如 @cf/myshell-ai/melotts')
    const aura = /aura/i.test(profile.model)
    const response = await fetch(cloudflareRunUrl(profile.baseUrl, profile.model), {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(aura
        ? { text: text.slice(0, 4000), speaker: profile.voice || 'angus' }
        : { prompt: text.slice(0, 4000), lang: /[\u3400-\u9fff]/.test(text) ? 'zh' : 'en' }),
      signal: AbortSignal.timeout(120_000),
    })
    const raw = Buffer.from(await response.arrayBuffer())
    if (!response.ok) throw new Error(`Cloudflare TTS 失败：HTTP ${response.status} ${raw.toString('utf8').slice(0, 300)}`)
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      try {
        const data = JSON.parse(raw.toString('utf8')) as { result?: { audio?: string } | string }
        const encoded = typeof data.result === 'string' ? data.result : data.result?.audio
        if (encoded) return Buffer.from(encoded, 'base64')
      } catch {
        // Fall through to the JSON error below.
      }
      throw new Error('Cloudflare TTS 返回了 JSON 而不是音频；检查模型权限与请求参数')
    }
    return raw
  }

  private async convertToWav(bytes: Buffer, output: string): Promise<void> {
    if (!this.options.ffmpeg) throw new Error('该 TTS 返回的不是 WAV，需要配置 ffmpeg 才能播放')
    const dir = await makeTempDir('jarvis-remote-tts-')
    const input = join(dir, 'speech.bin')
    try {
      await writeFile(input, bytes)
      await toWav(this.options.ffmpeg, input, output)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async warmup(): Promise<void> {
    // A remote model should not be billed on every process start.
  }

  async reconfigure(): Promise<void> {}

  async close(): Promise<void> {}
}
