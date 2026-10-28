import { DatabaseSync } from 'node:sqlite'
import { createConnection, createServer, type Server } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export function canonicalDataDir(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  return realpathSync(dataDir)
}

/** OS-managed SQLite locks are released on crashes; never infer ownership from a PID. */
export async function acquireLifecycleLock(dataDir: string, name: 'runtime' | 'launcher', timeoutMs = 0): Promise<() => void> {
  const file = join(canonicalDataDir(dataDir), `${name}.lock.sqlite`)
  const db = new DatabaseSync(file)
  if (process.platform !== 'win32') chmodSync(file, 0o600)
  db.exec('PRAGMA busy_timeout=0')
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      db.exec('BEGIN IMMEDIATE')
      let closed = false
      return () => { if (!closed) { closed = true; db.close() } }
    } catch (error) {
      if (!/locked|busy/i.test(String(error)) || Date.now() >= deadline) {
        db.close()
        throw new Error(`${name === 'runtime' ? 'Jarvis already owns this data directory' : 'Another launcher is still working'}: ${dataDir}`, { cause: error })
      }
      await delay(100)
    }
  }
}

interface Descriptor { version: 1; instanceId: string; token: string; endpoint: string }
export interface RuntimeStatus { instanceId: string; state: 'starting' | 'ready' | 'stopping'; url?: string }
export interface RuntimeLifecycle {
  setReady(url: string): void
  onShutdown(callback: () => void | Promise<void>): void
  close(): Promise<void>
}

function descriptorFile(dataDir: string): string { return join(dataDir, 'runtime-instance.json') }
function readDescriptor(dataDir: string): Descriptor | null {
  try {
    const file = descriptorFile(dataDir)
    const stat = statSync(file)
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) return null
    const value = JSON.parse(readFileSync(file, 'utf8')) as Descriptor
    if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.token) || !/^[a-f0-9]{32}$/.test(value.instanceId) || typeof value.endpoint !== 'string') return null
    return value
  } catch { return null }
}

/** Private authenticated IPC works on Windows named pipes and POSIX domain sockets. */
export async function requestRuntime(dataDir: string, command: 'status' | 'shutdown' = 'status', timeoutMs = 1500): Promise<RuntimeStatus | null> {
  const descriptor = readDescriptor(dataDir)
  if (!descriptor) return null
  return new Promise(resolve => {
    const socket = createConnection(descriptor.endpoint)
    let data = '', done = false
    const finish = (result: RuntimeStatus | null) => { if (done) return; done = true; socket.destroy(); resolve(result) }
    socket.setTimeout(timeoutMs, () => finish(null))
    socket.on('error', () => finish(null))
    socket.on('end', () => finish(null))
    socket.on('connect', () => socket.write(JSON.stringify({ token: descriptor.token, instanceId: descriptor.instanceId, command }) + '\n'))
    socket.on('data', chunk => {
      data += chunk.toString()
      if (data.length > 8192) return finish(null)
      if (!data.includes('\n')) return
      try {
        const value = JSON.parse(data.split('\n')[0]) as RuntimeStatus
        finish(value.instanceId === descriptor.instanceId && ['starting', 'ready', 'stopping'].includes(value.state) ? value : null)
      } catch { finish(null) }
    })
  })
}

export async function acquireRuntimeLifecycle(dataDir: string): Promise<RuntimeLifecycle> {
  dataDir = canonicalDataDir(dataDir)
  const release = await acquireLifecycleLock(dataDir, 'runtime')
  const instanceId = randomBytes(16).toString('hex')
  const token = randomBytes(32).toString('hex')
  let socketDir: string | undefined
  let server: Server | undefined
  let closed = false
  let state: RuntimeStatus['state'] = 'starting'
  let url: string | undefined
  let shutdown: (() => void | Promise<void>) | undefined
  try {
    if (process.platform !== 'win32') {
      socketDir = mkdtempSync(join(tmpdir(), 'jarvis-'))
      chmodSync(socketDir, 0o700)
    }
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\jarvis-${instanceId}` : join(socketDir!, 'control.sock')
    server = createServer(socket => {
      let data = ''
      socket.setTimeout(2000, () => socket.destroy())
      socket.on('error', () => socket.destroy())
      socket.on('data', chunk => {
        data += chunk.toString()
        if (data.length > 4096) { socket.destroy(); return }
        if (!data.includes('\n')) return
        socket.removeAllListeners('data')
        try {
          const request = JSON.parse(data.split('\n')[0])
          const received = Buffer.from(typeof request.token === 'string' ? request.token : '')
          if (received.length !== token.length || !timingSafeEqual(received, Buffer.from(token)) || request.instanceId !== instanceId || !['status', 'shutdown'].includes(request.command)) { socket.destroy(); return }
          const stop = request.command === 'shutdown' && state !== 'stopping' && shutdown
          if (stop) state = 'stopping'
          socket.end(JSON.stringify({ instanceId, state, url }) + '\n', () => {
            if (stop) void Promise.resolve().then(stop).catch(error => { console.error('Jarvis shutdown failed', error); process.exitCode = 1 })
          })
        } catch { socket.destroy() }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(endpoint, () => { server!.removeListener('error', reject); resolve() })
    })
    const file = descriptorFile(dataDir)
    const temporary = `${file}.${instanceId}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, instanceId, token, endpoint }), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
    return {
      setReady(value) { if (!shutdown) throw new Error('Register shutdown before marking runtime ready'); url = value; state = 'ready' },
      onShutdown(callback) { shutdown = callback },
      async close() {
        if (closed) return
        closed = true
        state = 'stopping'
        await new Promise<void>(resolve => server!.close(() => resolve()))
        // socketDir was created above by this owner; never delete paths from metadata.
        if (socketDir) rmSync(socketDir, { recursive: true, force: true })
        release()
      },
    }
  } catch (error) {
    server?.close()
    if (socketDir) rmSync(socketDir, { recursive: true, force: true })
    release()
    throw error
  }
}

/** Browser URL follows resolved TLS/host/port, translating wildcard bind addresses. */
export function launcherUrl(config: { host: string; port: number; tlsCert: string }): string {
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host
  return `${config.tlsCert ? 'https' : 'http'}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${config.port}/`
}
