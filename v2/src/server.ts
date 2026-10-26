import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { ActionManager } from './actions.ts'
import type { ModelRouter } from './model/router.ts'
import type { ModelProfile, ModelSettingsStore } from './model/settings.ts'
import type { AttentionManager } from './attention.ts'
import type { JarvisConfig } from './config.ts'
import type { Conversation } from './conversation.ts'
import type { EventBus, JarvisEvent } from './events.ts'
import type { Logger } from './logger.ts'
import type { MemoryStore } from './memory/store.ts'
import type { ReminderStore } from './proactive/reminders.ts'
import type { ProactivePolicy } from './proactive/policy.ts'

export interface ServerDeps {
  config: JarvisConfig
  bus: EventBus
  attention: AttentionManager
  conversation: Conversation
  models: ModelRouter
  modelSettings: ModelSettingsStore
  actions: ActionManager
  memory: MemoryStore
  reminders: ReminderStore
  policy: ProactivePolicy
  logger: Logger
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  )
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

function sendText(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status
  response.setHeader('content-type', 'text/plain; charset=utf-8')
  response.end(message)
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) throw new Error(`请求太大（上限 ${limit} 字节）`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson<T = Record<string, unknown>>(request: IncomingMessage, limit = 1_000_000): Promise<T> {
  const body = await readBody(request, limit)
  if (body.length === 0) return {} as T
  try {
    return JSON.parse(body.toString('utf8')) as T
  } catch {
    throw new Error('请求不是合法 JSON')
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 1) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    const host = request.headers.host ?? ''
    const [hostname, port = ''] = host.includes(':') ? [host.slice(0, host.lastIndexOf(':')), host.slice(host.lastIndexOf(':') + 1)] : [host, '']
    if (parsed.host === host) return true
    const localNames = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
    return localNames.has(parsed.hostname) && localNames.has(hostname) && (parsed.port || '') === port
  } catch {
    return false
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}

export class JarvisServer {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private readonly clients = new Set<WebSocket>()
  private readonly startedAt = Date.now()
  private listeningPort = 0

  constructor(private readonly deps: ServerDeps) {}

  async start(): Promise<{ url: string }> {
    const handler = (request: IncomingMessage, response: ServerResponse): void => {
      void this.handle(request, response).catch(error => {
        this.deps.logger.error('request failed', { error: String(error) })
        if (!response.headersSent) sendJson(response, 500, { error: 'internal error' })
        else response.end()
      })
    }

    if (this.deps.config.tlsCert && this.deps.config.tlsKey) {
      const [cert, key] = await Promise.all([
        readFile(this.deps.config.tlsCert),
        readFile(this.deps.config.tlsKey),
      ])
      this.server = createHttpsServer({ cert, key }, handler)
    } else {
      this.server = createHttpServer(handler)
    }

    this.wss = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws') {
        socket.destroy()
        return
      }
      if (!sameOrigin(request) || !this.authorized(request, url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss?.handleUpgrade(request, socket, head, ws => {
        this.wss?.emit('connection', ws, request)
      })
    })

    this.wss.on('connection', ws => this.onConnection(ws))
    this.deps.bus.onAny(event => this.broadcast(event))

    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => reject(error)
      this.server?.once('error', onError)
      this.server?.listen(this.deps.config.port, this.deps.config.host, () => {
        this.server?.off('error', onError)
        resolvePromise()
      })
    })

    const scheme = this.deps.config.tlsCert ? 'https' : 'http'
    const host = this.deps.config.host === '0.0.0.0' || this.deps.config.host === '::' ? '127.0.0.1' : this.deps.config.host
    const address = this.server?.address()
    this.listeningPort = address && typeof address === 'object' ? address.port : this.deps.config.port
    return { url: `${scheme}://${host}:${this.listeningPort}` }
  }

  private authorized(request: IncomingMessage, url: URL): boolean {
    if (!this.deps.config.authToken) return true
    // A loopback socket is not proof of a local user when a reverse proxy is
    // in front of us. Proxy headers force token authentication.
    const proxied = Boolean(request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || request.headers['forwarded'])
    if (isLoopback(request) && !proxied) return true
    const header = request.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : ''
    const cookies = parseCookies(request.headers.cookie)
    const query = url.searchParams.get('token') ?? ''
    return [bearer, cookies.jarvis_token ?? '', query].some(candidate => candidate && safeEqual(candidate, this.deps.config.authToken))
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws)
    ws.send(JSON.stringify({
      kind: 'hello',
      at: new Date().toISOString(),
      status: this.deps.conversation.status(),
      attention: this.deps.attention.snapshot(),
      recent: this.deps.bus.history(30),
    }))
    ws.on('message', data => {
      void this.onMessage(ws, data.toString()).catch(error => {
        this.send(ws, { kind: 'error', error: error instanceof Error ? error.message : String(error) })
      })
    })
    ws.on('close', () => this.clients.delete(ws))
    ws.on('error', () => this.clients.delete(ws))
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let message: { kind?: string; text?: string }
    try {
      message = JSON.parse(raw) as { kind?: string; text?: string }
    } catch {
      this.send(ws, { kind: 'error', error: 'invalid JSON' })
      return
    }
    if (message.kind === 'ping') {
      this.send(ws, { kind: 'pong', at: new Date().toISOString() })
      return
    }
    if (message.kind === 'cancel') {
      this.deps.conversation.cancel()
      return
    }
    if (message.kind === 'chat') {
      const text = String(message.text ?? '').trim()
      if (!text) return
      await this.deps.conversation.handleText(text, { source: 'text' })
      return
    }
    this.send(ws, { kind: 'error', error: `unknown message kind: ${message.kind ?? 'undefined'}` })
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }

  private broadcast(event: JarvisEvent): void {
    const payload = JSON.stringify({ kind: 'event', event })
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload)
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    securityHeaders(response)
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = decodeURIComponent(url.pathname)

    if (path === '/' && url.searchParams.has('token')) {
      const token = url.searchParams.get('token') ?? ''
      if (this.deps.config.authToken && safeEqual(token, this.deps.config.authToken)) {
        response.setHeader(
          'set-cookie',
          `jarvis_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${this.deps.config.tlsCert ? '; Secure' : ''}`,
        )
        response.statusCode = 302
        response.setHeader('location', '/')
        response.end()
        return
      }
    }

    if (path.startsWith('/api/')) {
      if (!this.authorized(request, url)) {
        sendJson(response, 401, { error: 'unauthorized' })
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'cross-origin request rejected' })
        return
      }
    }

    if (request.method === 'GET' && path === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        version: this.deps.config.version,
        uptimeMs: Date.now() - this.startedAt,
        status: this.deps.conversation.status(),
      })
      return
    }

    if (request.method === 'GET' && path === '/api/bootstrap') {
      sendJson(response, 200, {
        version: this.deps.config.version,
        status: this.deps.conversation.status(),
        attention: this.deps.attention.snapshot(),
        memory: this.deps.conversation.memoryItems(),
        reminders: this.deps.reminders.list(),
        models: {
          llm: this.deps.models.model,
          vision: this.deps.models.visionModel,
          embedding: this.deps.models.embedModel,
          provider: this.deps.models.status(),
        },
        modelSettings: this.deps.modelSettings.publicView(await this.deps.modelSettings.load()),
        config: {
          host: this.deps.config.host,
          quiet: this.deps.config.quiet,
          dailySpeakBudget: this.deps.config.dailySpeakBudget,
        },
      })
      return
    }

    if (request.method === 'GET' && path === '/api/models') {
      sendJson(response, 200, await this.deps.conversation.status())
      return
    }

    if (request.method === 'GET' && path === '/api/model') {
      const settings = await this.deps.modelSettings.load()
      sendJson(response, 200, {
        settings: this.deps.modelSettings.publicView(settings),
        active: this.deps.models.status(),
        health: await this.deps.models.health(2000),
      })
      return
    }

    if (request.method === 'POST' && path === '/api/model/test') {
      try {
        const body = await readJson<Partial<ModelProfile>>(request)
        const profile = await this.profileFromBody(body)
        const result = await this.deps.models.test(profile)
        sendJson(response, result.ok ? 200 : 502, { ...result, error: result.ok ? undefined : result.message })
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/model/apply') {
      try {
        const body = await readJson<Partial<ModelProfile>>(request)
        const profile = await this.profileFromBody(body)
        const switched = await this.deps.models.switchTo(profile)
        const settings = await this.deps.modelSettings.upsert(profile, true)
        await this.deps.conversation.refreshModel()
        const active = this.deps.models.status()
        this.deps.bus.emit('model.changed', { active, test: switched.test })
        sendJson(response, 200, {
          settings: this.deps.modelSettings.publicView(settings),
          active,
          test: switched.test,
        })
      } catch (error) {
        sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/model/activate') {
      try {
        const body = await readJson<{ id?: string }>(request)
        const id = body.id === 'remote' ? 'remote' : body.id === 'local' ? 'local' : ''
        if (!id) throw new Error('只能切换 local 或 remote')
        const loaded = await this.deps.modelSettings.load()
        const profile = loaded.profiles.find(item => item.id === id)
        if (!profile) throw new Error('没有这个模型配置')
        const switched = await this.deps.models.switchTo(profile)
        const { settings } = await this.deps.modelSettings.activate(id)
        await this.deps.conversation.refreshModel()
        const active = this.deps.models.status()
        this.deps.bus.emit('model.changed', { active, test: switched.test })
        sendJson(response, 200, { settings: this.deps.modelSettings.publicView(settings), active, test: switched.test })
      } catch (error) {
        sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/chat') {
      const body = await readJson<{ text?: string }>(request)
      if (!body.text?.trim()) {
        sendJson(response, 400, { error: 'text is required' })
        return
      }
      const result = await this.deps.conversation.handleText(body.text, { source: 'text' })
      sendJson(response, 200, result)
      return
    }

    if (request.method === 'POST' && path === '/api/voice') {
      const mime = request.headers['content-type'] ?? 'audio/webm'
      const body = await readBody(request, 30_000_000)
      if (body.length === 0) {
        sendJson(response, 400, { error: 'empty audio' })
        return
      }
      const result = await this.deps.conversation.handleAudio(body, mime)
      sendJson(response, 200, result)
      return
    }

    if (request.method === 'POST' && path === '/api/look') {
      const body = await readJson<{ target?: string; vision?: boolean }>(request)
      const target = body.target === 'camera' ? 'camera' : 'screen'
      const text = body.vision ? '用视觉看屏幕' : target === 'camera' ? '看下摄像头' : '看下屏幕'
      const result = await this.deps.conversation.handleText(text, { source: 'text' })
      sendJson(response, 200, result)
      return
    }

    if (request.method === 'GET' && path === '/api/memory') {
      const query = url.searchParams.get('query')?.trim() ?? ''
      if (query) {
        sendJson(response, 200, await this.deps.conversation.recall(query))
      } else {
        sendJson(response, 200, { items: this.deps.conversation.memoryItems() })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/memory') {
      const body = await readJson<{ content?: string; kind?: string; sensitivity?: string }>(request)
      if (!body.content?.trim()) {
        sendJson(response, 400, { error: 'content is required' })
        return
      }
      const kind = ['semantic', 'episodic', 'procedural', 'prospective'].includes(body.kind ?? '')
        ? (body.kind as 'semantic' | 'episodic' | 'procedural' | 'prospective')
        : 'semantic'
      const sensitivity = body.sensitivity === 'sensitive' ? 'sensitive' : 'standard'
      const item = await this.deps.memory.add({
        kind,
        content: body.content,
        sourceKind: 'user-confirmed',
        sourceRef: `api:${new Date().toISOString()}`,
        trust: 'authoritative',
        confidence: 1,
        importance: { explicit: 1 },
        sensitivity,
        status: 'confirmed',
      })
      sendJson(response, 201, { item })
      return
    }

    const memoryMatch = path.match(/^\/api\/memory\/([^/]+)(?:\/(confirm|reject))?$/)
    if (memoryMatch) {
      const id = memoryMatch[1]
      if (request.method === 'DELETE' && !memoryMatch[2]) {
        sendJson(response, this.deps.memory.delete(id) ? 200 : 404, { ok: true })
        return
      }
      if (request.method === 'POST' && memoryMatch[2] === 'confirm') {
        sendJson(response, 200, { item: this.deps.memory.confirm(id) })
        return
      }
      if (request.method === 'POST' && memoryMatch[2] === 'reject') {
        sendJson(response, 200, { item: this.deps.memory.reject(id) })
        return
      }
    }

    if (request.method === 'GET' && path === '/api/actions') {
      sendJson(response, 200, { items: this.deps.actions.list() })
      return
    }

    const actionMatch = path.match(/^\/api\/actions\/([^/]+)\/(approve|deny)$/)
    if (actionMatch && request.method === 'POST') {
      try {
        if (actionMatch[2] === 'approve') {
          sendJson(response, 200, { action: await this.deps.actions.approve(actionMatch[1]) })
        } else {
          sendJson(response, 200, { action: this.deps.actions.deny(actionMatch[1]) })
        }
      } catch (error) {
        sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'GET' && path === '/api/reminders') {
      sendJson(response, 200, { items: this.deps.reminders.list() })
      return
    }

    if (request.method === 'POST' && path === '/api/reminders') {
      const body = await readJson<{ text?: string; dueAt?: string }>(request)
      if (!body.text?.trim() || !body.dueAt) {
        sendJson(response, 400, { error: 'text and dueAt are required' })
        return
      }
      const date = new Date(body.dueAt)
      if (Number.isNaN(date.getTime())) {
        sendJson(response, 400, { error: 'invalid dueAt' })
        return
      }
      const reminder = this.deps.reminders.add(body.text, date.toISOString())
      sendJson(response, 201, { reminder })
      return
    }

    const reminderMatch = path.match(/^\/api\/reminders\/([^/]+)(?:\/(complete))?$/)
    if (reminderMatch) {
      const id = reminderMatch[1]
      if (request.method === 'POST' && reminderMatch[2] === 'complete') {
        const reminder = this.deps.reminders.complete(id)
        if (!reminder) {
          sendJson(response, 404, { error: 'reminder not found' })
          return
        }
        this.deps.bus.emit('reminder.completed', { reminder })
        sendJson(response, 200, { reminder })
        return
      }
      if (request.method === 'DELETE' && !reminderMatch[2]) {
        sendJson(response, this.deps.reminders.remove(id) ? 200 : 404, { ok: true })
        return
      }
    }

    if (request.method === 'POST' && path === '/api/focus') {
      const body = await readJson<{ enabled?: boolean }>(request)
      this.deps.policy.setFocus(Boolean(body.enabled))
      sendJson(response, 200, { focus: this.deps.policy.isFocus() })
      return
    }

    if (request.method === 'POST' && path === '/api/cancel') {
      this.deps.conversation.cancel()
      sendJson(response, 200, { ok: true })
      return
    }

    if (request.method === 'GET' && path.startsWith('/api/captures/')) {
      await this.serveDataFile(response, join(this.deps.config.dataDir, 'captures'), path.slice('/api/captures/'.length))
      return
    }

    if (request.method === 'GET' && path.startsWith('/api/audio/')) {
      await this.serveDataFile(response, join(this.deps.config.dataDir, 'audio'), path.slice('/api/audio/'.length))
      return
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      await this.serveStatic(response, path)
      return
    }

    sendJson(response, 405, { error: 'method not allowed' })
  }

  private async profileFromBody(body: Partial<ModelProfile>): Promise<ModelProfile> {
    const settings = await this.deps.modelSettings.load()
    const id = body.id === 'remote' ? 'remote' : body.id === 'local' ? 'local' : 'local'
    const existing = settings.profiles.find(item => item.id === id)
    if (!existing) throw new Error('只能配置 local / remote')
    const nextBase = String(body.baseUrl ?? existing.baseUrl).trim().replace(/\/+$/, '')
    if (existing.kind === 'openai' && nextBase !== existing.baseUrl.replace(/\/+$/, '') && !body.apiKey?.trim()) {
      throw new Error('更换远端地址时请重新输入 API Key，避免把旧密钥发给新地址')
    }
    const merged: ModelProfile = {
      ...existing,
      ...body,
      id,
      kind: body.kind === 'openai' ? 'openai' : body.kind === 'ollama' ? 'ollama' : existing.kind,
      apiKey: body.apiKey?.trim() ? body.apiKey.trim() : existing.apiKey,
    }
    return merged
  }

  private async serveDataFile(response: ServerResponse, root: string, requested: string): Promise<void> {
    const name = requested.split('/').pop() ?? ''
    if (!name || name.includes('..') || name.includes('\0')) {
      sendText(response, 400, 'bad path')
      return
    }
    const path = resolve(root, name)
    const rootResolved = resolve(root)
    if (!path.startsWith(`${rootResolved}${sep}`) && path !== rootResolved) {
      sendText(response, 403, 'forbidden')
      return
    }
    try {
      const info = await stat(path)
      if (!info.isFile()) throw new Error('not a file')
      response.statusCode = 200
      response.setHeader('content-type', MIME[extname(path).toLowerCase()] ?? 'application/octet-stream')
      response.setHeader('cache-control', 'private, max-age=3600')
      response.end(await readFile(path))
    } catch {
      sendText(response, 404, 'not found')
    }
  }

  private async serveStatic(response: ServerResponse, path: string): Promise<void> {
    const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
    if (relative.includes('..') || relative.includes('\0')) {
      sendText(response, 400, 'bad path')
      return
    }
    const file = resolve(this.deps.config.webDir, relative)
    const root = resolve(this.deps.config.webDir)
    if (!file.startsWith(`${root}${sep}`) && file !== root) {
      sendText(response, 403, 'forbidden')
      return
    }
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('not a file')
      response.statusCode = 200
      response.setHeader('content-type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
      response.setHeader('cache-control', relative === 'index.html' ? 'no-cache' : 'public, max-age=300')
      response.end(await readFile(file))
    } catch {
      sendText(response, 404, 'not found')
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.close()
    this.clients.clear()
    await new Promise<void>(resolvePromise => {
      if (!this.server) return resolvePromise()
      this.server.close(() => resolvePromise())
    })
    this.wss?.close()
  }
}