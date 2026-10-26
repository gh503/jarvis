import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { Logger } from '../logger.ts'
import { fileExists } from './media.ts'

export interface Synthesizer {
  available(): Promise<boolean>
  synthesize(text: string, output: string): Promise<void>
  warmup?(): Promise<void>
  reconfigure?(): Promise<void>
  close?(): Promise<void>
}

export interface VoiceParams {
  lengthScale: number
  noiseScale: number
  noiseW: number
  maxChars: number
}

export interface SynthesizerOptions {
  piperBin: string
  voice: string
  logger?: Logger
  getVoiceParams?: () => VoiceParams
}

interface PendingSynthesis {
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * A long-lived Piper process. Spawning Piper per sentence costs 2–3 seconds in
 * model loading alone; keeping it warm makes the first spoken clause arrive
 * while the LLM is still writing the rest of the answer.
 */
export class PiperSynthesizer implements Synthesizer {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private readonly pending = new Map<string, PendingSynthesis>()
  private startPromise: Promise<void> | null = null
  private generation = 0

  constructor(private readonly options: SynthesizerOptions) {}

  async available(): Promise<boolean> {
    return (await fileExists(this.options.piperBin)) && (await fileExists(this.options.voice))
  }

  async start(): Promise<void> {
    if (this.child) return
    if (this.startPromise) return await this.startPromise
    this.startPromise = this.startInternal().finally(() => { this.startPromise = null })
    return await this.startPromise
  }

  private async startInternal(): Promise<void> {
    const generation = this.generation
    if (!(await this.available())) throw new Error('Piper or its voice model is missing')
    if (generation !== this.generation) throw new Error('Piper start was superseded')
    const voice = this.options.getVoiceParams?.() ?? { lengthScale: 1, noiseScale: 0.667, noiseW: 0.8, maxChars: 4000 }
    const child = spawn(this.options.piperBin, [
      '--model', this.options.voice,
      '--json-input',
      '--quiet',
      '--length_scale', String(voice.lengthScale),
      '--noise_scale', String(voice.noiseScale),
      '--noise_w', String(voice.noiseW),
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.on('data', (chunk: string) => this.options.logger?.debug('piper stderr', { text: chunk.trim().slice(0, 300) }))
    // A crashed or missing Piper binary closes stdin; without this listener
    // Node turns the resulting EPIPE into an uncaught process crash.
    child.stdin.on('error', error => {
      if (this.child === child) this.child = null
      this.failAll(new Error(`Piper stdin failed: ${error.message}`))
    })
    child.stdout.on('error', error => this.failAll(new Error(`Piper stdout failed: ${error.message}`)))
    child.stderr.on('error', error => this.options.logger?.debug('piper stderr failed', { error: error.message }))
    child.on('error', error => {
      if (this.child === child) this.child = null
      this.failAll(new Error(`Piper failed: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null
      this.failAll(new Error(`Piper exited (${code ?? signal ?? 'unknown'})`))
    })
    this.options.logger?.info('tts worker started', { model: this.options.voice })
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split(/\r?\n/)
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const clean = line.trim()
      if (!clean) continue
      const pending = this.pending.get(resolve(clean)) ?? [...this.pending.entries()].find(([path]) => clean.endsWith(path))?.[1]
      if (!pending) continue
      clearTimeout(pending.timer)
      // Remove by value; the path may have appeared with a prefix.
      for (const [path, value] of this.pending) {
        if (value === pending) this.pending.delete(path)
      }
      pending.resolve()
    }
  }

  private failAll(error: Error): void {
    for (const [path, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(path)
    }
  }

  async synthesize(text: string, output: string): Promise<void> {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) throw new Error('cannot synthesize empty text')
    const path = resolve(output)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await this.start()
    const child = this.child
    if (!child?.stdin.writable) throw new Error('Piper is not writable')
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(path)
        rejectPromise(new Error('Piper synthesis timed out'))
      }, 120_000)
      timer.unref()
      this.pending.set(path, { resolve: resolvePromise, reject: rejectPromise, timer })
      const maxChars = this.options.getVoiceParams?.().maxChars ?? 4000
      try {
        child.stdin.write(`${JSON.stringify({ text: clean.slice(0, maxChars), output_file: path })}\n`, error => {
          if (!error) return
          const pending = this.pending.get(path)
          if (pending) clearTimeout(pending.timer)
          this.pending.delete(path)
          rejectPromise(error)
        })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(path)
        rejectPromise(error instanceof Error ? error : new Error(String(error)))
      }
    })
    if (!(await fileExists(path))) throw new Error('Piper produced no audio')
    this.options.logger?.debug('tts synthesized', { chars: clean.length, output: path })
  }

  async warmup(): Promise<void> {
    const path = resolve(tmpdir(), `jarvis-tts-warmup-${process.pid}.wav`)
    try {
      await this.synthesize('你好', path)
    } finally {
      await rm(path, { force: true }).catch(() => undefined)
    }
  }

  async reconfigure(): Promise<void> {
    if (!this.child) return
    await this.close()
  }

  async close(): Promise<void> {
    this.generation += 1
    const child = this.child
    this.child = null
    this.failAll(new Error('Piper shut down'))
    if (!child) return
    child.stdin.end()
    child.kill('SIGTERM')
  }
}
