import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { Logger } from '../logger.ts'
import type { Transcriber, TranscriberState, Transcription } from './asr.ts'
import { makeTempDir, toWav } from './media.ts'
import type { AsrProfile, TtsProfile } from './settings.ts'
import type { Synthesizer } from './tts.ts'

type WavInfo = { pcm: Buffer; sampleRate: number; channels: number; bits: number }

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
      const result = this.options.profile.transport === 'websocket'
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

/** Remote TTS using the OpenAI-compatible `/audio/speech` contract. */
export class RemoteSynthesizer implements Synthesizer {
  constructor(private readonly options: {
    profile: TtsProfile
    logger?: Logger
  }) {}

  async available(): Promise<boolean> {
    return Boolean(this.options.profile.baseUrl)
  }

  async synthesize(text: string, output: string): Promise<void> {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) throw new Error('cannot synthesize empty text')
    const profile = this.options.profile
    if (!profile.baseUrl) throw new Error('远端 TTS 还没有配置服务地址')
    const response = await fetch(endpoint(profile.baseUrl, '/audio/speech'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(profile) },
      body: JSON.stringify({
        model: profile.model,
        input: clean.slice(0, 4000),
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
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length) throw new Error('远端 TTS 返回了空音频')
    if (bytes.length > 20_000_000) throw new Error('远端 TTS 音频超过 20 MB 上限')
    const path = output
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, bytes, { mode: 0o600 })
    this.options.logger?.debug('remote tts synthesized', { chars: clean.length, bytes: bytes.length, request: randomUUID().slice(0, 8) })
  }

  async warmup(): Promise<void> {
    // A remote model should not be billed on every process start.
  }

  async reconfigure(): Promise<void> {}

  async close(): Promise<void> {}
}
