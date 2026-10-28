import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_REQUEST = 65536
const MAX_RESPONSE = 12 * 1024 * 1024
const MAX_READ = 8 * 1024 * 1024
const fail = (code: string) => Object.assign(new Error(`Native filesystem: ${code}`), { code })
export function nativeFilesystemExecutable(): string {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const name = process.platform === 'win32' ? 'jarvis-scoped-fs.exe' : 'jarvis-scoped-fs'
  const packaged = join(root, 'runtime', name)
  if (existsSync(packaged)) return packaged
  return join(root, 'native', 'dist', name)
}
export interface NativeEntry { name: string; kind: 'file' | 'directory' | 'other'; size: number }
/** Internal application adapter. Executable overrides are trusted construction-time inputs,
 * never tool arguments. No operations are enabled merely by importing this module. */
export class NativeFilesystem {
  private child: ChildProcessWithoutNullStreams
  private readonly exited: Promise<void>
  private seq = 0
  private pending?: { seq: number; op: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  private chunks: Buffer[] = []
  private buffered = 0
  private dead = false
  private queue: Promise<unknown> = Promise.resolve()
  private roots = new Set<string>()
  private detachAbort?: () => void
  private constructor(executable: string, private timeoutMs: number, args: string[]) {
    if (!isAbsolute(executable)) throw fail('EXECUTABLE_MUST_BE_ABSOLUTE')
    this.child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, cwd: dirname(executable) })
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()))
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    // Drain diagnostics without retaining or exposing file content.
    this.child.stderr.resume()
    this.child.on('error', () => this.stop(fail('HELPER_UNAVAILABLE')))
    this.child.on('close', () => this.stop(fail('HELPER_EXITED')))
    this.child.stdin.on('error', () => this.stop(fail('HELPER_PIPE_CLOSED')))
  }
  static async start(roots: string[], options: { executable?: string; timeoutMs?: number; args?: string[]; signal?: AbortSignal } = {}): Promise<{ filesystem: NativeFilesystem; roots: string[] }> {
    if (!roots.every(root => isAbsolute(root) && !root.includes('\0'))) throw fail('INVALID_ROOT')
    roots = [...roots]
    const timeout = options.timeoutMs ?? 10000
    if (!Number.isSafeInteger(timeout) || timeout < 1) throw fail('INVALID_TIMEOUT')
    options.signal?.throwIfAborted()
    const fs = new NativeFilesystem(options.executable ?? nativeFilesystemExecutable(), timeout, options.args ?? [])
    if (options.signal) {
      const signal = options.signal, abort = () => fs.dispose()
      signal.addEventListener('abort', abort, { once: true })
      fs.detachAbort = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) fs.dispose()
    }
    try {
      const hello = await fs.request('hello', {}) as Record<string, unknown>
      if (hello.protocolVersion !== 1 || hello.maxRequestBytes !== MAX_REQUEST || hello.maxReadBytes !== MAX_READ || hello.maxListEntries !== 1000 || !Array.isArray(hello.capabilities) || !['read', 'list'].every(value => (hello.capabilities as unknown[]).includes(value))) throw fail('PROTOCOL_MISMATCH')
      const init = await fs.request('init', { roots }) as { roots?: Array<{ token?: unknown }> }
      if (!Array.isArray(init.roots) || init.roots.length !== roots.length || init.roots.some(root => typeof root.token !== 'string' || !root.token)) throw fail('INVALID_RESPONSE')
      const tokens = init.roots.map(root => root.token as string)
      if (new Set(tokens).size !== tokens.length) throw fail('INVALID_RESPONSE')
      tokens.forEach(token => fs.roots.add(token))
      return { filesystem: fs, roots: tokens }
    } catch (error) { await fs.disposeAsync(); throw error }
  }
  private stop(error: Error): void {
    if (this.dead) return
    this.dead = true
    this.detachAbort?.(); this.detachAbort = undefined
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined }
    this.roots.clear(); this.chunks = []; this.buffered = 0
    this.child.kill()
  }
  dispose(): void { this.stop(fail('HELPER_CLOSED')) }
  /** Await OS handle release before removing a helper-owned workspace. */
  async disposeAsync(): Promise<void> {
    this.dispose()
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([this.exited, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          this.child.kill('SIGKILL')
          this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy()
          reject(fail('HELPER_SHUTDOWN_TIMEOUT'))
        }, 5000)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  private receive(chunk: Buffer): void {
    if (this.dead) return
    // Exactly one response per outstanding request. Bound before concatenation.
    if (this.buffered + chunk.length > MAX_RESPONSE) { this.stop(fail('RESPONSE_TOO_LARGE')); return }
    this.chunks.push(chunk); this.buffered += chunk.length
    if (!chunk.includes(10)) return
    const data = Buffer.concat(this.chunks, this.buffered)
    this.chunks = []; this.buffered = 0
    if (data.indexOf(10) !== data.length - 1 || !this.pending) { this.stop(fail('INVALID_FRAME')); return }
    try {
      const response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
      if (!response || response.version !== 1 || response.seq !== this.pending.seq || typeof response.ok !== 'boolean') throw fail('INVALID_RESPONSE')
      if (response.ok && (!response.result || typeof response.result !== 'object' || Array.isArray(response.result))) throw fail('INVALID_RESPONSE')
      if (!response.ok && (typeof response.error?.code !== 'string' || !/^[A-Z0-9_]{1,100}$/.test(response.error.code))) throw fail('INVALID_RESPONSE')
      const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer)
      if (response.ok) pending.resolve(response.result)
      else pending.reject(Object.assign(new Error(`Native filesystem ${pending.op}: ${response.error.code}`), { code: response.error.code, operation: pending.op }))
    } catch { this.stop(fail('INVALID_RESPONSE')) }
  }
  private request(op: string, fields: Record<string, unknown>): Promise<unknown> {
    const run = () => new Promise<unknown>((resolve, reject) => {
      if (this.dead) { reject(fail('HELPER_CLOSED')); return }
      const seq = ++this.seq
      const frame = JSON.stringify({ version: 1, seq, op, ...fields }) + '\n'
      if (Buffer.byteLength(frame) > MAX_REQUEST) { reject(fail('REQUEST_TOO_LARGE')); return }
      const timer = setTimeout(() => this.stop(fail('HELPER_TIMEOUT')), this.timeoutMs)
      this.pending = { seq, op, resolve, reject, timer }
      this.child.stdin.write(frame)
    })
    const result = this.queue.then(run)
    this.queue = result.catch(() => {})
    return result
  }
  private validate(root: string, components: string[]): void {
    if (!this.roots.has(root)) throw fail('INVALID_ROOT_TOKEN')
    if (!Array.isArray(components) || components.some(part => typeof part !== 'string' || !part || part === '.' || part === '..' || /[\\/\0]/.test(part))) throw fail('INVALID_COMPONENT')
  }
  async read(root: string, components: string[], maxBytes = MAX_READ): Promise<Buffer> {
    this.validate(root, components)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ) throw fail('INVALID_LIMIT')
    const result = await this.request('read', { root, components: [...components], maxBytes }) as { dataBase64?: unknown; bytes?: unknown }
    if (typeof result.dataBase64 !== 'string' || !Number.isSafeInteger(result.bytes) || (result.bytes as number) < 0 || (result.bytes as number) > maxBytes) { this.dispose(); throw fail('INVALID_RESPONSE') }
    const bytes = Buffer.from(result.dataBase64, 'base64')
    if (bytes.length !== result.bytes || bytes.toString('base64') !== result.dataBase64) { this.dispose(); throw fail('INVALID_RESPONSE') }
    return bytes
  }
  async list(root: string, components: string[] = [], limit = 1000): Promise<{ entries: NativeEntry[]; truncated: boolean }> {
    this.validate(root, components)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail('INVALID_LIMIT')
    const result = await this.request('list', { root, components: [...components], limit }) as { entries?: NativeEntry[]; truncated?: boolean }
    if (!Array.isArray(result.entries) || result.entries.length > limit || typeof result.truncated !== 'boolean' || result.entries.some(entry => !entry || typeof entry.name !== 'string' || !entry.name || entry.name === '.' || entry.name === '..' || /[\\/\0]/.test(entry.name) || !['file', 'directory', 'other'].includes(entry.kind) || !Number.isSafeInteger(entry.size) || entry.size < 0)) { this.dispose(); throw fail('INVALID_RESPONSE') }
    return result as { entries: NativeEntry[]; truncated: boolean }
  }
  async closeRoot(root: string): Promise<void> {
    this.validate(root, [])
    this.roots.delete(root)
    await this.request('close', { root })
  }
}
