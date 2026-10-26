import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from '../logger.ts'
import { runProcess } from '../util/process.ts'
import { fileExists, makeTempDir, removeDir, toWav } from './media.ts'

export interface Transcription {
  text: string
  language: string
  durationMs: number
  audioMs?: number
}

export interface TranscriberState {
  state: 'idle' | 'starting' | 'ready' | 'error'
  error?: string
}

export interface Transcriber {
  available(): Promise<boolean>
  transcribe(input: string | Buffer, extension?: string): Promise<Transcription>
  state?(): TranscriberState
  close?(): Promise<void>
}

interface WhisperJson {
  transcription?: Array<{ text?: string }>
  text?: string
}

export interface TranscriberOptions {
  whisperBin: string
  model: string
  ffmpeg: string
  logger?: Logger
  language?: string
}

export class WhisperTranscriber implements Transcriber {
  constructor(private readonly options: TranscriberOptions) {}

  async available(): Promise<boolean> {
    return (await fileExists(this.options.whisperBin)) && (await fileExists(this.options.model))
  }

  async transcribe(input: string | Buffer, extension = 'wav'): Promise<Transcription> {
    const started = Date.now()
    const dir = await makeTempDir('jarvis-asr-')
    try {
      const source = typeof input === 'string' ? input : join(dir, `input.${extension}`)
      if (typeof input !== 'string') await writeFile(source, input)
      let wav = source
      if (extension !== 'wav' || typeof input !== 'string') {
        wav = join(dir, 'input.wav')
        await toWav(this.options.ffmpeg, source, wav)
      }

      const base = join(dir, 'result')
      const language = this.options.language ?? 'zh'
      try {
        await runProcess(
          this.options.whisperBin,
          ['-m', this.options.model, '-f', wav, '-l', language, '-oj', '-nt', '-of', base, '--no-prints'],
          { timeoutMs: 120_000, maxOutputBytes: 500_000 },
        )
      } catch (error) {
        this.options.logger?.warn('whisper failed; trying text output', { error: String(error) })
        await runProcess(
          this.options.whisperBin,
          ['-m', this.options.model, '-f', wav, '-l', language, '-otxt', '-nt', '-of', base, '--no-prints'],
          { timeoutMs: 120_000, maxOutputBytes: 500_000 },
        )
      }

      let text = ''
      if (await fileExists(`${base}.json`)) {
        const parsed = JSON.parse(await readFile(`${base}.json`, 'utf8')) as WhisperJson
        if (Array.isArray(parsed.transcription)) {
          text = parsed.transcription.map(part => part.text ?? '').join('')
        } else {
          text = parsed.text ?? ''
        }
      } else if (await fileExists(`${base}.txt`)) {
        text = await readFile(`${base}.txt`, 'utf8')
      }
      return {
        text: text.replace(/\s+/g, ' ').trim(),
        language,
        durationMs: Date.now() - started,
      }
    } finally {
      await removeDir(dir)
    }
  }

  async transcribeFile(path: string): Promise<Transcription> {
    return await this.transcribe(path, path.split('.').pop() ?? 'wav')
  }

  async cleanup(): Promise<void> {
    // Placeholder for future persistent model sessions.
    await rm(join(process.cwd(), '.noop'), { force: true }).catch(() => undefined)
  }

  async close(): Promise<void> {
    // whisper.cpp is one-shot per request.
  }
}