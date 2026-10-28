import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { Logger } from '../logger.ts'

interface OcrMessage {
  ready?: boolean
  loadMs?: number
  id?: number
  text?: string
  lines?: string[]
  durationMs?: number
  error?: string
}

export interface OcrResult {
  text: string
  lines: string[]
  durationMs: number
}

export class OcrClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private lines: Interface | null = null
  private readonly pending = new Map<number, { resolve: (value: OcrResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private nextId = 1
  private ready: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false

  constructor(
    private readonly options: {
      pythonBin: string
      script: string
      logger?: Logger
    },
  ) {}

  async available(): Promise<boolean> {
    return this.options.script.length > 0
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('OCR worker is closed'))
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.pythonBin, [this.options.script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
      this.child = child
      let settled = false
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true
          reject(error)
        }
      }
      const timer = setTimeout(() => fail(new Error('OCR worker did not become ready in 60s')), 60_000)
      timer.unref()
      this.lines = createInterface({ input: child.stdout })
      this.lines.on('line', line => {
        let message: OcrMessage
        try {
          message = JSON.parse(line) as OcrMessage
        } catch {
          return
        }
        if (message.ready === true) {
          clearTimeout(timer)
          if (!settled) {
            settled = true
            this.options.logger?.info('ocr worker ready', { loadMs: message.loadMs })
            resolve()
          }
          return
        }
        if (message.ready === false) {
          clearTimeout(timer)
          fail(new Error(message.error ?? 'OCR worker failed to load'))
          return
        }
        if (typeof message.id !== 'number') return
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error))
        else pending.resolve({ text: message.text ?? '', lines: message.lines ?? [], durationMs: message.durationMs ?? 0 })
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => this.options.logger?.debug('ocr worker stderr', { chunk: String(chunk).trim().slice(0, 400) }))
      const workerFailure = (error: Error): void => {
        if (this.stopped) return
        if (this.child === child) this.child = null
        this.ready = null
        fail(error)
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(error)
        }
        this.pending.clear()
      }
      child.stdin.on('error', error => workerFailure(new Error(`OCR stdin failed: ${error.message}`)))
      child.stdout.on('error', error => workerFailure(new Error(`OCR stdout failed: ${error.message}`)))
      child.on('error', error => {
        clearTimeout(timer)
        workerFailure(error)
      })
      child.on('close', code => {
        clearTimeout(timer)
        if (!settled) fail(new Error(`OCR worker exited with code ${code}`))
        this.child = null
        this.ready = null
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error(`OCR worker exited with code ${code}`))
        }
        this.pending.clear()
      })
    })
    return this.ready
  }

  async recognize(path: string): Promise<OcrResult> {
    const task = this.queue.then(async () => {
      await this.start()
      const child = this.child
      if (!child || child.killed) throw new Error('OCR worker is not running')
      return await this.send(path)
    })
    this.queue = task.catch(() => undefined)
    return await task
  }

  private send(path: string): Promise<OcrResult> {
    const id = this.nextId++
    return new Promise<OcrResult>((resolve, reject) => {
      const child = this.child
      if (!child) return reject(new Error('OCR worker is not running'))
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('OCR request timed out'))
      }, 30_000)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      const data = Buffer.from(path, 'utf8')
      const header = Buffer.alloc(8)
      header.writeUInt32BE(id, 0)
      header.writeUInt32BE(data.byteLength, 4)
      try {
        child.stdin.write(header)
        child.stdin.write(data)
      } catch (error) {
        const pending = this.pending.get(id)
        if (pending) clearTimeout(pending.timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async close(): Promise<void> {
    this.stopped = true
    this.lines?.close()
    try { this.child?.stdin.end() } catch { /* already closed */ }
    this.child?.kill('SIGTERM')
    this.child = null
    this.ready = null
  }
}