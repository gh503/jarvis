import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { Logger } from '../logger.ts'
import { makeTempDir, removeDir, toWav } from './media.ts'
import type { Transcriber, TranscriberState, Transcription } from './asr.ts'

interface Pending {
  resolve: (value: Transcription) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface WorkerMessage {
  ready?: boolean
  id?: number
  text?: string
  language?: string
  durationMs?: number
  audioMs?: number
  loadMs?: number
  warmupMs?: number
  error?: string
}

export class FasterWhisperTranscriber implements Transcriber {
  private child: ChildProcessWithoutNullStreams | null = null
  private lines: Interface | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private ready: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false
  private workerState: TranscriberState = { state: 'idle' }

  constructor(
    private readonly options: {
      pythonBin: string
      script: string
      model: string
      language: string
      ffmpeg: string
      logger?: Logger
    },
  ) {}

  async available(): Promise<boolean> {
    return this.options.script.length > 0
  }

  state(): TranscriberState {
    return this.workerState
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('ASR worker is closed'))
    if (this.ready) return this.ready
    this.workerState = { state: 'starting' }
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(
        this.options.pythonBin,
        [
          this.options.script,
          '--model',
          this.options.model,
          '--language',
          this.options.language,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        },
      )
      this.child = child
      let settled = false
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true
          reject(error)
        }
      }
      const timer = setTimeout(() => fail(new Error('ASR worker did not become ready in 180s')), 180_000)
      timer.unref()

      this.lines = createInterface({ input: child.stdout })
      this.lines.on('line', line => {
        let message: WorkerMessage
        try {
          message = JSON.parse(line) as WorkerMessage
        } catch {
          this.options.logger?.debug('asr worker non-json output', { line })
          return
        }
        if (message.ready === true) {
          clearTimeout(timer)
          if (!settled) {
            settled = true
            this.workerState = { state: 'ready' }
            this.options.logger?.info('asr worker ready', {
              model: this.options.model,
              loadMs: message.loadMs,
              warmupMs: message.warmupMs,
            })
            resolve()
          }
          return
        }
        if (message.ready === false) {
          clearTimeout(timer)
          this.workerState = { state: 'error', error: message.error ?? 'ASR worker failed to load' }
          fail(new Error(message.error ?? 'ASR worker failed to load'))
          return
        }
        if (typeof message.id !== 'number') return
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) {
          pending.reject(new Error(message.error))
        } else {
          pending.resolve({
            text: String(message.text ?? '').trim(),
            language: String(message.language ?? this.options.language),
            durationMs: Number(message.durationMs ?? 0),
            audioMs: Number(message.audioMs ?? 0) || undefined,
          })
        }
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => {
        this.options.logger?.debug('asr worker stderr', { chunk: String(chunk).trim().slice(0, 500) })
      })
      const workerFailure = (error: Error): void => {
        if (this.stopped) return
        if (this.child === child) this.child = null
        this.ready = null
        this.workerState = { state: 'error', error: error.message }
        fail(error)
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(error)
        }
        this.pending.clear()
      }
      // Python can die between the readiness handshake and the next write.
      // Without these listeners a closed stdin/stdout turns into an uncaught
      // EPIPE and takes the whole assistant down.
      child.stdin.on('error', error => workerFailure(new Error(`ASR stdin failed: ${error.message}`)))
      child.stdout.on('error', error => workerFailure(new Error(`ASR stdout failed: ${error.message}`)))
      child.on('error', error => {
        clearTimeout(timer)
        this.workerState = { state: 'error', error: error.message }
        fail(error)
      })
      child.on('close', code => {
        clearTimeout(timer)
        if (!settled) fail(new Error(`ASR worker exited with code ${code}`))
        this.child = null
        this.ready = null
        if (!this.stopped) {
          this.workerState = this.workerState.state === 'starting'
            ? { state: 'error', error: `ASR worker exited with code ${code}` }
            : { state: 'idle' }
        }
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error(`ASR worker exited with code ${code}`))
        }
        this.pending.clear()
        if (!this.stopped) this.options.logger?.warn('asr worker exited; it will restart on next request', { code })
      })
    })
    return this.ready
  }

  async transcribe(input: string | Buffer, extension = 'wav'): Promise<Transcription> {
    const task = this.queue.then(async () => {
      await this.start()
      const child = this.child
      if (!child || child.killed) throw new Error('ASR worker is not running')
      const dir = await makeTempDir('jarvis-asr-')
      try {
        const source = typeof input === 'string' ? input : join(dir, `request.${extension}`)
        if (typeof input !== 'string') await (await import('node:fs/promises')).writeFile(source, input)
        let wav = source
        if (extension.toLowerCase() !== 'wav') {
          wav = join(dir, 'request.wav')
          await toWav(this.options.ffmpeg, source, wav)
        }
        const data = await readFile(wav)
        return await this.send(data)
      } finally {
        await removeDir(dir)
      }
    })
    this.queue = task.catch(() => undefined)
    return await task
  }

  private send(wav: Buffer): Promise<Transcription> {
    const id = this.nextId++
    return new Promise<Transcription>((resolve, reject) => {
      const child = this.child
      if (!child) {
        reject(new Error('ASR worker is not running'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('ASR request timed out'))
        // A wedged Python worker cannot be trusted to process the next
        // utterance in order. Tear it down; the next request starts a fresh
        // process (and pays the warm-up once, not forever).
        this.restart()
      }, 120_000)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      const header = Buffer.alloc(8)
      header.writeUInt32BE(id, 0)
      header.writeUInt32BE(wav.byteLength, 4)
      try {
        child.stdin.write(header)
        child.stdin.write(wav)
      } catch (error) {
        const pending = this.pending.get(id)
        if (pending) clearTimeout(pending.timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
        this.restart()
      }
    })
  }

  private restart(): void {
    const child = this.child
    this.child = null
    this.ready = null
    this.workerState = { state: 'idle' }
    try { child?.kill('SIGKILL') } catch { /* already gone */ }
  }

  async close(): Promise<void> {
    this.stopped = true
    this.workerState = { state: 'idle' }
    this.lines?.close()
    try { this.child?.stdin.end() } catch { /* already closed */ }
    this.child?.kill('SIGTERM')
    this.child = null
    this.ready = null
  }
}