import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { buildDailyBrief } from './brief.ts'
import { DeviceStore } from './devices.ts'
import type { SecureFiles } from './secure-files.ts'
import { readCalendar } from './proactive/calendar.ts'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { capabilities, type Capabilities } from './platform.ts'
import { providerCatalog } from './model/catalog.ts'
import { voiceCatalog } from './voice/catalog.ts'
import { WebSocket, WebSocketServer } from 'ws'
import type { ActionManager } from './actions.ts'
import type { ModelRouter } from './model/router.ts'
import { isLoopbackHost, validateProfile, type ModelProfile, type ModelSettings, type ModelSettingsStore } from './model/settings.ts'
import type { AttentionManager } from './attention.ts'
import type { JarvisConfig } from './config.ts'
import type { Conversation } from './conversation.ts'
import type { ToolRuntime } from './tools.ts'
import type { LocalToolSettings } from './local-tools/settings.ts'
import type { FileTools } from './local-tools/files.ts'
import type { TaskTools } from './local-tools/tasks.ts'
import type { ToolJournal } from './tool-journal.ts'
import type { McpManager } from './mcp/manager.ts'
import { PresetError, type McpPresets } from './mcp/presets.ts'
import { RevisionConflict, type ServerInput } from './mcp/settings.ts'
import { SessionStoreError, type SessionStore } from './sessions.ts'
import { ProfileError, type ProfileStore, type ProfileEntryInput, type ProfilePersonInput } from './profile.ts'
import type { EventBus, JarvisEvent } from './events.ts'
import type { Logger } from './logger.ts'
import type { MemoryStore } from './memory/store.ts'
import type { ReminderStore } from './proactive/reminders.ts'
import type { ProactivePolicy } from './proactive/policy.ts'
import type { TuningStore } from './tuning.ts'
import type { MemoryInput } from './memory/types.ts'
import type { TelemetryCollector } from './telemetry.ts'
import type { VoiceRuntime } from './voice/runtime.ts'
import { mergeVoiceUpdate, type VoiceSettingsStore, type VoiceUpdate } from './voice/settings.ts'

export interface ServerDeps {
  config: JarvisConfig
  bus: EventBus
  attention: AttentionManager
  conversation: Conversation
  models: ModelRouter
  modelSettings: ModelSettingsStore
  voiceSettings?: VoiceSettingsStore
  voice?: VoiceRuntime
  tuning: TuningStore
  telemetry: TelemetryCollector
  actions: ActionManager
  memory: MemoryStore
  sessions?: SessionStore
  localSettings?: LocalToolSettings
  fileTools?: FileTools
  taskTools?: TaskTools
  tools?: ToolRuntime
  toolJournal?: ToolJournal
  mcp?: McpManager
  presets?: McpPresets
  profile?: ProfileStore
  reminders: ReminderStore
  policy: ProactivePolicy
  secure: SecureFiles
  logger: Logger
}

const MAX_CHAT_CHARS = 8000
const MAX_MEMORY_CHARS = 8000
const MAX_REMINDER_CHARS = 500

function conversationIdentity(input: { sessionId?: unknown; turnId?: unknown }): { sessionId?: string; turnId?: string } {
  const result: { sessionId?: string; turnId?: string } = {}
  for (const key of ['sessionId', 'turnId'] as const) {
    const value = input[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new HttpError(400, `${key} 不合法`)
    result[key] = value
  }
  return result
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
  response.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()')
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  )
}

function sendJson(response: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(data)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  for (const [key, value] of Object.entries(headers)) response.setHeader(key, value)
  response.end(body)
}

function sendText(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status
  response.setHeader('content-type', 'text/plain; charset=utf-8')
  response.end(message)
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** Keep deliberate 4xx errors distinct from unexpected 5xx failures. */
function errorStatus(error: unknown, fallback = 500): number {
  if (error instanceof HttpError) return error.status
  if (error instanceof SessionStoreError || error instanceof ProfileError) return error.statusCode
  if (error instanceof URIError) return 400
  return fallback
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) throw new HttpError(413, `请求太大（上限 ${limit} 字节）`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson<T = Record<string, unknown>>(request: IncomingMessage, limit = 1_000_000): Promise<T> {
  const body = await readBody(request, limit)
  if (body.length === 0) return {} as T
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpError(400, '请求不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象')
  }
  return parsed as T
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 1) continue
    const raw = part.slice(index + 1).trim()
    try {
      out[part.slice(0, index).trim()] = decodeURIComponent(raw)
    } catch {
      out[part.slice(0, index).trim()] = raw
    }
  }
  return out
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Best-effort client identity for throttling; the proxy header wins. */
function clientKey(request: IncomingMessage): string {
  const forwarded = request.headers['x-forwarded-for']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const hop = first?.split(',')[0]?.trim()
  return hop || request.socket.remoteAddress || 'unknown'
}

function hostnameOf(hostHeader: string): string {
  const parsed = new URL(`http://${hostHeader}`)
  return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

function sameOrigin(request: IncomingMessage): boolean {
  // Defence in depth: modern browsers state the relationship outright, and a
  // cross-site value is a clear signal regardless of Origin handling.
  const site = request.headers['sec-fetch-site']
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    const host = request.headers.host ?? ''
    if (!host) return false
    if (parsed.host === host) return true
    const localNames = new Set(['127.0.0.1', 'localhost', '::1'])
    return localNames.has(parsed.hostname) && localNames.has(hostnameOf(host))
  } catch {
    return false
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}

interface SocketAuth {
  credential: string
  /** The connection was accepted because it came from loopback, not a token. */
  loopbackTrusted: boolean
}

type JarvisSocket = WebSocket & { jarvisAuth?: SocketAuth }

export class JarvisServer {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private readonly clients = new Set<WebSocket>()
  private readonly startedAt = Date.now()
  private readonly devices: DeviceStore
  private readonly pairing = new Map<string, { expiresAt: number }>()
  private claimFailures: number[] = []
  private readonly claimFailuresByClient = new Map<string, number[]>()
  private listeningPort = 0
  private erasing = false
  private changingMcp = false
  private changingModel = false
  private changingLocalSettings = false
  private readonly deletingSessions = new Set<string>()
  private readonly caps: Capabilities = capabilities(resolve(import.meta.dirname, '..'))

  constructor(private readonly deps: ServerDeps) {
    this.devices = new DeviceStore(join(deps.config.dataDir, 'devices.json'))
  }

  async start(): Promise<{ url: string }> {
    const handler = (request: IncomingMessage, response: ServerResponse): void => {
      void this.handle(request, response).catch(error => {
        const status = errorStatus(error)
        if (status >= 500) this.deps.logger.error('request failed', { error: String(error) })
        if (response.headersSent) {
          response.end()
          return
        }
        // A body that was rejected before it was fully read (413) leaves
        // unread bytes on the socket. Without an explicit close the client
        // keeps the connection in its pool and the next request on it fails
        // with ECONNRESET — which surfaces in the browser as an intermittent
        // "Failed to fetch". Drain the rest, then politely close.
        if (status === 413) {
          response.setHeader('connection', 'close')
          request.resume()
        }
        sendJson(response, status, { error: status >= 500 ? 'internal error' : error instanceof Error ? error.message : String(error) })
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

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws') {
        socket.destroy()
        return
      }
      if (!this.hostAllowed(request) || !sameOrigin(request) || !this.authorized(request, url, true)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss?.handleUpgrade(request, socket, head, ws => {
        const auth = ws as JarvisSocket
        auth.jarvisAuth = {
          credential: this.credentialOf(request, url),
          // Mirror authorized(): a plain loopback socket needs no token, and a
          // proxy header forces token authentication even on loopback.
          loopbackTrusted: isLoopback(request) && !request.headers['x-forwarded-for'] && !request.headers['x-real-ip'] && !request.headers['forwarded'],
        }
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

  private authorized(request: IncomingMessage, url: URL, allowQueryToken = false): boolean {
    if (!this.deps.config.authToken) return true
    // A loopback socket is not proof of a local user when a reverse proxy is
    // in front of us. Proxy headers force token authentication.
    const proxied = Boolean(request.headers['x-forwarded-for'] || request.headers['x-real-ip'] || request.headers['forwarded'])
    if (isLoopback(request) && !proxied) return true
    const header = request.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : ''
    const cookies = parseCookies(request.headers.cookie)
    const query = allowQueryToken ? (url.searchParams.get('token') ?? '') : ''
    return [bearer, cookies.jarvis_token ?? '', query].some(candidate =>
      Boolean(candidate) && (safeEqual(candidate, this.deps.config.authToken) || this.devices.verify(candidate)))
  }

  private credentialOf(request: IncomingMessage, url: URL): string {
    const header = request.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : ''
    return bearer || parseCookies(request.headers.cookie).jarvis_token || url.searchParams.get('token') || ''
  }

  /** A live socket must stay authorised: revoking a device closes its streams. */
  private socketAuthorized(ws: JarvisSocket): boolean {
    const auth = ws.jarvisAuth
    if (!auth) return false
    if (auth.loopbackTrusted) return true
    if (!auth.credential) return false
    if (this.deps.config.authToken && safeEqual(auth.credential, this.deps.config.authToken)) return true
    return this.devices.verify(auth.credential)
  }

  private pruneSockets(): void {
    for (const client of [...this.clients]) {
      if (this.socketAuthorized(client as JarvisSocket)) continue
      this.clients.delete(client)
      try { client.close(4401, 'unauthorized') } catch { /* already gone */ }
    }
  }

  private closeAllSockets(): void {
    for (const client of [...this.clients]) {
      try { client.close(1001, 'server reset') } catch { /* already gone */ }
    }
    this.clients.clear()
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws)
    ws.send(JSON.stringify({
      kind: 'hello',
      at: new Date().toISOString(),
      status: this.deps.conversation.status(),
      attention: this.deps.attention.snapshot(),
      recent: this.deps.bus.history(30),
      activeTurn: this.deps.conversation.status().activeTurn ?? null,
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
    let message: { kind?: string; text?: string; scenario?: string; sessionId?: string; turnId?: string }
    try {
      message = JSON.parse(raw) as { kind?: string; text?: string; scenario?: string }
    } catch {
      this.send(ws, { kind: 'error', error: 'invalid JSON' })
      return
    }
    if (message.kind === 'ping') {
      this.send(ws, { kind: 'pong', at: new Date().toISOString() })
      return
    }
    if (message.kind === 'cancel') {
      const identity = conversationIdentity(message)
      this.deps.conversation.cancel(identity)
      return
    }
    if (!this.socketAuthorized(ws as JarvisSocket)) {
      this.send(ws, { kind: 'error', error: 'unauthorized' })
      try { ws.close(4401, 'unauthorized') } catch { /* already gone */ }
      return
    }
    if (message.kind === 'chat') {
      const text = String(message.text ?? '').trim()
      if (!text) return
      if (text.length > MAX_CHAT_CHARS) {
        this.send(ws, { kind: 'error', error: `消息太长（上限 ${MAX_CHAT_CHARS} 字）` })
        return
      }
      const scenario = typeof message.scenario === 'string' && /^[a-z0-9-]{1,32}$/.test(message.scenario) ? message.scenario : undefined
      try {
        const identity = conversationIdentity(message)
        if (identity.sessionId && this.deps.sessions && (this.deletingSessions.has(identity.sessionId) || !this.deps.sessions.get(identity.sessionId))) throw new HttpError(404, '会话不存在或已删除')
        const result = await this.deps.conversation.handleText(text, { source: 'text', scenario, ...identity })
        if (result.busy) this.send(ws, { kind: 'error', ...identity, error: result.reply, busy: true, activeTurn: this.deps.conversation.status().activeTurn ?? null })
        else this.send(ws, { kind: 'chat.result', ...identity, ...result })
      } catch (error) {
        this.send(ws, { kind: 'error', sessionId: message.sessionId, turnId: message.turnId, error: error instanceof Error ? error.message : String(error) })
      }
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
    if (this.deps.config.tlsCert) response.setHeader('Strict-Transport-Security', 'max-age=15552000')
    const url = new URL(request.url ?? '/', 'http://localhost')
    let path: string
    try {
      path = decodeURIComponent(url.pathname)
    } catch {
      throw new HttpError(400, '请求路径编码无效')
    }

    if (!this.hostAllowed(request)) {
      // 421 Misdirected Request: the request reached a server that does not
      // serve this host name.
      sendJson(response, 421, { error: 'host not allowed' })
      return
    }

    if (path === '/' && url.searchParams.has('token')) {
      const token = url.searchParams.get('token') ?? ''
      if (this.deps.config.authToken && (safeEqual(token, this.deps.config.authToken) || this.devices.verify(token))) {
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

    if (request.method === 'POST' && path === '/api/devices/claim') {
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'cross-origin request rejected' })
        return
      }
      const now = Date.now()
      // Throttle per client first so one noisy caller cannot lock the owner out,
      // with a global cap as a backstop against distributed guessing.
      const key = clientKey(request)
      const recent = (this.claimFailuresByClient.get(key) ?? []).filter(at => at > now - 60_000)
      this.claimFailures = this.claimFailures.filter(at => at > now - 60_000)
      if (recent.length >= 8 || this.claimFailures.length >= 60) {
        sendJson(response, 429, { error: '尝试过于频繁，稍后再试' })
        return
      }
      const body = await readJson<{ code?: string; name?: string }>(request)
      const code = String(body.code ?? '').trim()
      const pending = this.pairing.get(code)
      if (!pending || pending.expiresAt < now) {
        recent.push(now)
        this.claimFailuresByClient.set(key, recent)
        this.claimFailures.push(now)
        // Only drop the pending code once the attempts look deliberate.
        if (recent.length >= 8) this.pairing.delete(code)
        sendJson(response, 401, { error: '配对码无效或已过期' })
        return
      }
      const issued = this.devices.issue(String(body.name ?? '已配对设备'))
      this.deps.logger.info('device paired', { deviceId: issued.device.id, name: issued.device.name })
      this.pairing.delete(code)
      response.setHeader(
        'set-cookie',
        `jarvis_token=${encodeURIComponent(issued.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${this.deps.config.tlsCert ? '; Secure' : ''}`,
      )
      sendJson(response, 200, { ok: true, token: issued.token, device: issued.device })
      return
    }

    // Public on purpose: this is the page that teaches a new user how to get
    // an API key in the first place, so it must work before any token exists.
    // It contains no user data — only provider names, public URLs and steps.
    if (request.method === 'GET' && path === '/api/providers/catalog') {
      sendJson(response, 200, { providers: providerCatalog(), platform: this.caps })
      return
    }

    if (request.method === 'GET' && path === '/api/voice/catalog') {
      sendJson(response, 200, { voices: voiceCatalog(), platform: this.caps })
      return
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

    if (this.erasing && path.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method ?? 'GET')) {
      throw new HttpError(503, '正在清空数据，请稍后再试')
    }

    const modelMutation = request.method === 'POST' && ['/api/model/apply', '/api/model/activate', '/api/model/profile/add', '/api/model/profile/update', '/api/model/profile/delete', '/api/model/priority', '/api/model/scenarios'].includes(path)
    if (modelMutation) {
      this.assertModelMutable()
      this.changingModel = true
    }
    try {
    if (modelMutation) {
      await this.deps.conversation.quiesce?.()
      await this.deps.tools?.quiesce()
      await this.deps.taskTools?.quiesce()
    }

    if (request.method === 'GET' && path === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        version: this.deps.config.version,
        uptimeMs: Date.now() - this.startedAt,
        status: this.deps.conversation.status(),
        platform: this.caps,
      })
      return
    }

    if (request.method === 'POST' && path === '/api/devices/pair') {
      let body: { name?: string }
      try {
        body = await readJson<{ name?: string }>(request)
      } catch (error) {
        sendJson(response, errorStatus(error, 400), { error: error instanceof Error ? error.message : String(error) })
        return
      }
      const code = String(randomInt(100000, 1000000))
      this.pairing.set(code, { expiresAt: Date.now() + 5 * 60 * 1000 })
      for (const [key, value] of this.pairing) {
        if (value.expiresAt < Date.now()) this.pairing.delete(key)
      }
      sendJson(response, 200, { code, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), name: body.name ?? '' })
      return
    }

    if (request.method === 'GET' && path === '/api/devices') {
      sendJson(response, 200, { devices: this.devices.list() })
      return
    }

    if (request.method === 'DELETE' && path.startsWith('/api/devices/')) {
      const id = path.slice('/api/devices/'.length)
      if (!/^[0-9a-f-]{36}$/.test(id) || !this.devices.revoke(id)) {
        sendJson(response, 404, { error: 'device not found' })
        return
      }
      this.deps.logger.info('device revoked', { deviceId: id })
      // A revoked token must not keep a live WebSocket: close those streams.
      this.pruneSockets()
      sendJson(response, 200, { ok: true })
      return
    }

    if (request.method === 'GET' && path === '/pair') {
      await this.serveStatic(response, '/pair.html')
      return
    }

    if (request.method === 'GET' && path === '/providers') {
      await this.serveStatic(response, '/providers.html')
      return
    }

    if (request.method === 'GET' && path === '/install') {
      await this.serveStatic(response, '/install.html')
      return
    }


    if (request.method === 'GET' && path === '/api/bootstrap') {
      const defaultSessionId = this.deps.sessions?.getOrCreateDefault().id
      sendJson(response, 200, {
        version: this.deps.config.version,
        status: this.deps.conversation.status(),
        attention: this.deps.attention.snapshot(),
        memory: this.deps.conversation.memoryItems(),
        sessions: this.deps.sessions?.list({ limit: 50 }),
        defaultSessionId,
        activeTurn: this.deps.conversation.status().activeTurn ?? null,
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

    if (path === '/api/local-tools' || path.startsWith('/api/local-tools/')) {
      const { localSettings, taskTools, fileTools, sessions } = this.deps
      if (!localSettings || !taskTools || !fileTools || !sessions) throw new HttpError(503, '本地工具未启用')
      const snapshot = () => ({ settings: localSettings.snapshot(), capabilities: taskTools.status(), questions: taskTools.pendingQuestions() })
      const requireSession = (id: string | undefined): string => {
        if (!id) throw new HttpError(400, 'sessionId 必填')
        if (!sessions.get(id)) throw new HttpError(404, '会话不存在或已删除')
        return id
      }
      if (path === '/api/local-tools' && request.method === 'GET') {
        sendJson(response, 200, snapshot())
        return
      }
      if (path === '/api/local-tools/settings' && request.method === 'PATCH') {
        const body = await readJson(request, 64_000)
        if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) throw new HttpError(400, 'expectedRevision 必填且须为非负整数')
        if ('outputDir' in body) throw new HttpError(400, 'outputDir 为只读配置')
        if (Object.keys(body).some(key => !['expectedRevision', 'readRoots', 'writeRoots', 'webEnabled', 'shellEnabled', 'skillsDir'].includes(key))) throw new HttpError(400, '配置包含未知字段')
        this.assertModelMutable()
        this.changingLocalSettings = true
        try {
          await this.deps.conversation.quiesce()
          await this.deps.tools?.quiesce()
          await taskTools.quiesce()
          if (body.expectedRevision !== localSettings.snapshot().revision) throw new HttpError(409, '本地工具配置已变化，请刷新后重试')
          await localSettings.update(body as Parameters<LocalToolSettings['update']>[0])
          sendJson(response, 200, snapshot())
        } catch (error) {
          if (error instanceof HttpError) throw error
          if (error instanceof Error && (error.message === 'Settings revision conflict' || ('code' in error && error.code === 'REVISION_CONFLICT'))) throw new HttpError(409, '本地工具配置已变化，请刷新后重试')
          throw new HttpError(400, '本地工具配置更新失败，请检查配置')
        } finally {
          this.deps.conversation.resumeAdmissions()
          this.changingLocalSettings = false
        }
        return
      }
      const question = /^\/api\/local-tools\/questions\/([a-zA-Z0-9_-]{1,128})$/.exec(path)
      if (question && request.method === 'POST') {
        const body = await readJson(request, 64_000)
        if (Object.keys(body).some(key => !['sessionId', 'turnId', 'answers'].includes(key))) throw new HttpError(400, '回答包含未知字段')
        const identity = conversationIdentity(body)
        const sessionId = requireSession(identity.sessionId)
        if (!identity.turnId || !Array.isArray(body.answers) || body.answers.length === 0 || body.answers.length > 20 || body.answers.some(answer =>
          !answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).some(key => !['id', 'selected', 'custom'].includes(key)) ||
          typeof answer.id !== 'string' || !answer.id || answer.id.length > 128 || !Array.isArray(answer.selected) || answer.selected.length > 100 ||
          answer.selected.some((value: unknown) => typeof value !== 'string' || value.length > 2000) ||
          (answer.custom !== undefined && (typeof answer.custom !== 'string' || answer.custom.length > 8000)))) throw new HttpError(400, '需要完整回合标识和合法 answers 数组')
        if (!taskTools.answer(question[1], { sessionId, turnId: identity.turnId }, { answers: body.answers } as Parameters<TaskTools['answer']>[2])) throw new HttpError(409, '问题已失效或不属于此回合')
        sendJson(response, 200, { ok: true })
        return
      }
      const session = /^\/api\/local-tools\/session\/([a-zA-Z0-9_-]{1,128})$/.exec(path)
      if (session && request.method === 'GET') {
        const id = requireSession(session[1])
        sendJson(response, 200, { plan: taskTools.plan(id), jobs: taskTools.jobs(id), artifacts: fileTools.artifacts(id) })
        return
      }
      const job = /^\/api\/local-tools\/jobs\/([a-zA-Z0-9_-]{1,128})\/cancel$/.exec(path)
      if (job && request.method === 'POST') {
        const body = await readJson(request, 4096)
        if (Object.keys(body).some(key => key !== 'sessionId')) throw new HttpError(400, '取消请求包含未知字段')
        const sessionId = requireSession(conversationIdentity(body).sessionId)
        if (!await taskTools.cancelJob(job[1], sessionId)) throw new HttpError(409, '任务已失效或不属于此会话')
        sendJson(response, 200, { ok: true })
        return
      }
      const artifact = /^\/api\/local-tools\/artifacts\/([a-zA-Z0-9_-]{1,128})$/.exec(path)
      if (artifact && request.method === 'GET') {
        const sessionId = requireSession(conversationIdentity({ sessionId: url.searchParams.get('sessionId') }).sessionId)
        let file: Awaited<ReturnType<FileTools['readArtifact']>>
        try { file = await fileTools.readArtifact(artifact[1], sessionId) } catch { throw new HttpError(404, '产物不存在或不可读取') }
        const filename = encodeURIComponent(file.name.replace(/[\r\n\x00-\x1f\x7f]/g, '_')).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
        response.setHeader('content-type', 'application/octet-stream')
        response.setHeader('content-disposition', `attachment; filename="artifact"; filename*=UTF-8''${filename}`)
        response.setHeader('cache-control', 'no-store')
        response.setHeader('content-security-policy', "sandbox; default-src 'none'")
        response.end(file.bytes)
        return
      }
      throw new HttpError(404, '本地工具接口不存在')
    }

    if (path === '/api/tools' && request.method === 'GET') {
      if (!this.deps.tools) throw new HttpError(503, '工具运行时未启用')
      sendJson(response, 200, { definitions: this.deps.tools.catalogue().map(({ execute, ...definition }) => definition), approvals: this.deps.tools.pending() })
      return
    }

    if (path === '/api/tools/calls' && request.method === 'GET') {
      if (!this.deps.toolJournal || !this.deps.sessions) throw new HttpError(503, '工具记录未启用')
      const identity = conversationIdentity({ sessionId: url.searchParams.get('sessionId'), turnId: url.searchParams.get('turnId') })
      if (!identity.sessionId) throw new HttpError(400, 'sessionId 必填')
      if (!this.deps.sessions.get(identity.sessionId)) throw new HttpError(404, '会话不存在或已删除')
      sendJson(response, 200, { items: this.deps.toolJournal.listCalls(identity.sessionId, identity.turnId) })
      return
    }

    const approvalMatch = /^\/api\/tools\/approvals\/([a-zA-Z0-9_-]{1,128})$/.exec(path)
    if (approvalMatch && request.method === 'POST') {
      if (!this.deps.tools) throw new HttpError(503, '工具运行时未启用')
      const body = await readJson<{ approved?: unknown; sessionId?: unknown; turnId?: unknown }>(request, 4096)
      const identity = conversationIdentity(body)
      if (typeof body.approved !== 'boolean' || !identity.sessionId || !identity.turnId) throw new HttpError(400, '需要 approved 布尔值和完整会话、回合标识')
      if (!this.deps.tools.approve(approvalMatch[1], body.approved, { sessionId: identity.sessionId, turnId: identity.turnId })) throw new HttpError(409, '审批已失效或不属于此回合')
      sendJson(response, 200, { ok: true })
      return
    }

    if (path === '/api/mcp' && request.method === 'GET') {
      if (!this.deps.mcp) throw new HttpError(503, 'MCP 未启用')
      sendJson(response, 200, this.deps.mcp.snapshot())
      return
    }

    if (path === '/api/mcp/services' || path.startsWith('/api/mcp/services/')) {
      const presets = this.deps.presets
      if (!presets) throw new HttpError(503, '服务连接未启用')
      if (path === '/api/mcp/services' && request.method === 'GET') {
        try { sendJson(response, 200, presets.snapshot()) } catch { throw new HttpError(500, '服务连接操作失败，请稍后重试') }
        return
      }
      const match = /^\/api\/mcp\/services\/([a-zA-Z0-9_-]{1,48})(?:\/(configure|verify|toggle))?$/.exec(path)
      if (!match || ['__proto__', 'constructor', 'prototype'].includes(match[1])) throw new HttpError(400, '服务标识不合法')
      const action = match[2]
      if (!(request.method === 'POST' && action || request.method === 'DELETE' && !action)) throw new HttpError(405, '服务接口不支持此操作')
      const body = await readJson(request, 100_000)
      const fields = action === 'configure' ? ['expectedRevision', 'credentials', 'mode'] : action === 'toggle' ? ['expectedRevision', 'enabled'] : ['expectedRevision']
      if (Object.keys(body).some(key => !fields.includes(key))) throw new HttpError(400, '服务请求包含未知字段')
      if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) throw new HttpError(400, 'expectedRevision 必填且须为非负整数')
      if (action === 'configure') {
        if ('mode' in body && body.mode !== 'read' && body.mode !== 'write') throw new HttpError(400, '服务模式不合法')
        if ('credentials' in body) {
          const credentials = body.credentials
          if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || Object.getPrototypeOf(credentials) !== Object.prototype ||
              Object.keys(credentials).length > 10 || Object.entries(credentials).some(([key, value]) =>
                !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || typeof value !== 'string' || value.length > 8192)) throw new HttpError(400, '服务凭据格式不合法')
        }
      }
      if (action === 'toggle' && typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值')
      this.assertModelMutable()
      this.changingMcp = true
      try {
        await this.deps.conversation.quiesce()
        await this.deps.tools?.quiesce()
        await this.deps.taskTools?.quiesce()
        const revision = body.expectedRevision as number
        const snapshot = action === 'configure' ? await presets.configure(match[1], body as Parameters<McpPresets['configure']>[1])
          : action === 'verify' ? await presets.verify(match[1], revision)
          : action === 'toggle' ? await presets.toggle(match[1], body.enabled as boolean, revision)
          : await presets.disconnect(match[1], revision)
        sendJson(response, 200, snapshot)
      } catch (error) {
        // Only trusted error classes and fixed messages may cross this boundary.
        if (error instanceof RevisionConflict) sendJson(response, 409, { error: 'MCP 配置已变化，请刷新后重试', code: 'REVISION_CONFLICT' })
        else {
          const errors = {
            AUTH_REQUIRED: { status: 400, error: '服务授权无效，请检查凭据' },
            RATE_LIMITED: { status: 429, error: '服务请求过于频繁，请稍后重试' },
            UNREACHABLE: { status: 502, error: '无法连接服务，请稍后重试' },
            INVALID_SERVER: { status: 400, error: '服务配置无效，请检查配置' },
            TIMEOUT: { status: 504, error: '服务连接超时，请稍后重试' },
            INVALID_INPUT: { status: 400, error: '服务请求无效，请检查输入' },
            NOT_FOUND: { status: 404, error: '服务不存在' },
            UNAVAILABLE: { status: 503, error: '服务暂不可用' },
          }
          const safe = error instanceof PresetError && Object.hasOwn(errors, error.code) ? errors[error.code] : undefined
          sendJson(response, safe?.status ?? 500, { error: safe?.error ?? '服务连接操作失败，请稍后重试', ...(safe ? { code: (error as PresetError).code } : {}) })
        }
      } finally {
        try { this.deps.conversation.resumeAdmissions() } finally { this.changingMcp = false }
      }
      return
    }

    const mcpMatch = /^\/api\/mcp\/servers\/([a-zA-Z0-9_-]{1,48})(\/reconnect)?$/.exec(path)
    if ((path === '/api/mcp/servers' && request.method === 'POST') ||
        (mcpMatch && ((!mcpMatch[2] && request.method === 'DELETE') || (mcpMatch[2] && request.method === 'POST')))) {
      const mcp = this.deps.mcp
      if (!mcp) throw new HttpError(503, 'MCP 未启用')
      const body = await readJson<ServerInput>(request, 1_000_000)
      if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)) throw new HttpError(400, 'expectedRevision 不合法')
      if (request.method === 'DELETE' && body.expectedRevision === undefined) throw new HttpError(400, 'expectedRevision 必填')
      if (path === '/api/mcp/servers' && (typeof body.id !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(body.id))) throw new HttpError(400, 'MCP server id 不合法')
      if ((mcpMatch?.[1] ?? body.id)?.startsWith('preset-')) throw new HttpError(403, '预置服务请通过服务连接接口管理')
      // Recheck after reading the body: another request may have started erasing.
      if (this.erasing || this.changingMcp || this.changingModel || this.changingLocalSettings || this.deps.conversation.status().busy) throw new HttpError(409, '请先停止回复或等待配置更新完成')
      this.changingMcp = true
      try {
        // quiesce blocks new text, audio and proactive admissions synchronously.
        await this.deps.conversation.quiesce()
        await this.deps.tools?.quiesce()
        await this.deps.taskTools?.quiesce()
        if (!mcpMatch) await mcp.save(body)
        else if (mcpMatch[2]) await mcp.reconnect(mcpMatch[1])
        else await mcp.remove(mcpMatch[1], body.expectedRevision!)
        sendJson(response, 200, mcp.snapshot())
      } catch (error) {
        // Never echo transport/configuration errors: they may contain credentials.
        throw new HttpError(error instanceof RevisionConflict ? 409 : 400, error instanceof RevisionConflict ? 'MCP 配置已变化，请刷新后重试' : 'MCP 配置操作失败，请检查配置')
      } finally {
        this.deps.conversation.resumeAdmissions()
        this.changingMcp = false
      }
      return
    }

    if (request.method === 'GET' && path === '/api/models') {
      sendJson(response, 200, await this.deps.conversation.status())
      return
    }

    if (request.method === 'GET' && path === '/api/observatory') {
      const status = this.deps.conversation.status()
      const items = this.deps.memory.list({ includeSensitive: true, includeInactive: true, limit: 200 })
      const byKind: Record<string, number> = {}
      const byStatus: Record<string, number> = {}
      const bySensitivity: Record<string, number> = {}
      for (const item of items) {
        byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
        byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
        bySensitivity[item.sensitivity] = (bySensitivity[item.sensitivity] ?? 0) + 1
      }
      sendJson(response, 200, {
        now: new Date().toISOString(),
        version: this.deps.config.version,
        uptimeMs: Date.now() - this.startedAt,
        status,
        attention: this.deps.attention.snapshot(),
        model: this.deps.models.status(),
        voice: status.voice,
        telemetry: this.deps.telemetry.snapshot(),
        memory: {
          stats: this.deps.memory.stats(),
          byKind,
          byStatus,
          bySensitivity,
        },
        tuning: this.deps.tuning.current(),
        config: this.publicConfig(),
      })
      return
    }

    if (request.method === 'GET' && path === '/api/config') {
      sendJson(response, 200, { config: this.publicConfig(), tuning: this.deps.tuning.snapshot() })
      return
    }

    if (request.method === 'GET' && path === '/api/tuning') {
      sendJson(response, 200, this.deps.tuning.snapshot())
      return
    }

    if (request.method === 'PUT' && path === '/api/tuning') {
      try {
        const body = await readJson<{ values?: Record<string, unknown> }>(request)
        if (!body.values || typeof body.values !== 'object') throw new Error('values is required')
        const result = await this.deps.tuning.update(body.values)
        if (result.changed.some(key => key.startsWith('voice.'))) await this.deps.conversation.reconfigureVoice()
        this.deps.bus.emit('tuning.changed', { changed: result.changed, values: result.values })
        sendJson(response, 200, { ...result, tuning: this.deps.tuning.snapshot() })
      } catch (error) {
        sendJson(response, errorStatus(error, 400), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/tuning/reset') {
      try {
        const body = await readJson<{ group?: string }>(request)
        const result = await this.deps.tuning.reset(body.group)
        if (result.changed.some(key => key.startsWith('voice.'))) await this.deps.conversation.reconfigureVoice()
        this.deps.bus.emit('tuning.changed', { changed: result.changed, values: result.values })
        sendJson(response, 200, { ...result, tuning: this.deps.tuning.snapshot() })
      } catch (error) {
        sendJson(response, errorStatus(error, 400), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/tuning/preset') {
      try {
        const body = await readJson<{ id?: string }>(request)
        const result = await this.deps.tuning.preset(String(body.id ?? ''))
        if (result.changed.some(key => key.startsWith('voice.'))) await this.deps.conversation.reconfigureVoice()
        this.deps.bus.emit('tuning.changed', { preset: result.preset.id, values: result.values })
        sendJson(response, 200, { ...result, tuning: this.deps.tuning.snapshot() })
      } catch (error) {
        sendJson(response, errorStatus(error, 400), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (path === '/api/dev/demo-memory' && (request.method === 'POST' || request.method === 'DELETE')) {
      if (!this.isLoopback(request) || request.headers['x-jarvis-demo'] !== '1') {
        sendJson(response, 403, { error: 'demo data is only available from loopback with x-jarvis-demo: 1' })
        return
      }
      if (request.method === 'DELETE') {
        const list = this.deps.memory.list({ includeSensitive: true, includeInactive: true, limit: 200 })
        let removed = 0
        for (const item of list) {
          if (item.sourceRef.startsWith('demo:')) removed += this.deps.memory.delete(item.id) ? 1 : 0
        }
        sendJson(response, 200, { removed, graph: this.deps.memory.graph(160) })
        return
      }
      const items: MemoryInput[] = [
        { id: 'demo-semantic-review-old', kind: 'semantic', content: '用户以前把周复盘放在周五上午，后来改到了下午。', gist: '周复盘（旧时间）', sourceKind: 'user-stated', sourceRef: 'demo:seed', trust: 'medium', confidence: 0.7, importance: { explicit: 0.5 }, sensitivity: 'standard', status: 'superseded' },
        { id: 'demo-semantic-review', kind: 'semantic', content: '用户偏好把周复盘放在周五下午，先看结果，再决定下周重点。', gist: '周五下午做周复盘', sourceKind: 'user-confirmed', sourceRef: 'demo:seed', trust: 'authoritative', confidence: 0.96, importance: { explicit: 0.9, repetition: 0.7, goal: 0.8 }, sensitivity: 'standard', status: 'confirmed', supersedesId: 'demo-semantic-review-old' },
        { id: 'demo-semantic-style', kind: 'semantic', content: '用户偏好先给结论，再给一两个理由；不喜欢客套和长开场。', gist: '先结论，后理由', sourceKind: 'user-stated', sourceRef: 'demo:seed', trust: 'high', confidence: 0.9, importance: { explicit: 0.85, social: 0.2 }, sensitivity: 'standard', status: 'confirmed' },
        { id: 'demo-semantic-privacy', kind: 'semantic', content: 'Jarvis 的屏幕与摄像头只在明确需要时读取；不保留连续录制。', gist: '感知按需，不连续录制', sourceKind: 'user-confirmed', sourceRef: 'demo:seed', trust: 'authoritative', confidence: 0.99, importance: { goal: 1, explicit: 1 }, sensitivity: 'sensitive', status: 'confirmed', pinned: true },
        { id: 'demo-episodic-arch', kind: 'episodic', content: '10 月 20 日和团队讨论了 v2 的模块化单体方案，确定 SQLite + 本地模型优先。', gist: 'v2 架构评审', sourceKind: 'system-observed', sourceRef: 'demo:seed', trust: 'high', confidence: 0.84, importance: { novelty: 0.7, social: 0.6, goal: 0.5 }, sensitivity: 'standard', status: 'confirmed' },
        { id: 'demo-episodic-latency', kind: 'episodic', content: '10 月 22 日排查语音首响：模型冷加载和逐句 Piper 是主要瓶颈，改为常驻 worker 后降到一秒级。', gist: '语音延迟排查', sourceKind: 'system-observed', sourceRef: 'demo:seed', trust: 'high', confidence: 0.88, importance: { novelty: 0.8, goal: 0.7 }, sensitivity: 'standard', status: 'confirmed' },
        { id: 'demo-episodic-acceptance', kind: 'episodic', content: '10 月 24 日跑通首次端到端验收，文本、语音、记忆和提醒均可工作。', gist: '首次端到端验收', sourceKind: 'system-observed', sourceRef: 'demo:seed', trust: 'high', confidence: 0.9, importance: { goal: 0.8, novelty: 0.6 }, sensitivity: 'standard', status: 'confirmed' },
        { id: 'demo-procedural-start', kind: 'procedural', content: '启动 Jarvis：进入 v2，npm start；服务监听 127.0.0.1:3081，日志在 /tmp/jarvis-v2.log。', gist: '启动 Jarvis 的步骤', sourceKind: 'user-confirmed', sourceRef: 'demo:seed', trust: 'authoritative', confidence: 0.99, importance: { explicit: 0.9, repetition: 0.9 }, sensitivity: 'standard', status: 'confirmed' },
        { id: 'demo-procedural-model', kind: 'procedural', content: '切换模型：打开设置 → 模型来源 → 选择本地或远端 → 测试 → 应用；远端地址必须 HTTPS。', gist: '切换模型来源', sourceKind: 'user-confirmed', sourceRef: 'demo:seed', trust: 'authoritative', confidence: 0.95, importance: { explicit: 0.8, goal: 0.6 }, sensitivity: 'standard', status: 'confirmed' },
        { id: 'demo-prospective-report', kind: 'prospective', content: '周五 17:00 前提交本周周报，重点写清三个阻塞和下周的一个实验。', gist: '周五提交周报', sourceKind: 'user-stated', sourceRef: 'demo:seed', trust: 'high', confidence: 0.92, importance: { deadline: 1, goal: 0.9, explicit: 0.9 }, sensitivity: 'standard', status: 'confirmed', retention: 'until-deleted' },
        { id: 'demo-prospective-checkup', kind: 'prospective', content: '下周二 10:00 复诊，带上上次的化验单。', gist: '周二复诊', sourceKind: 'user-stated', sourceRef: 'demo:seed', trust: 'high', confidence: 0.9, importance: { deadline: 0.9, explicit: 0.8 }, sensitivity: 'sensitive', status: 'confirmed' },
        { id: 'demo-proposed-coffee', kind: 'semantic', content: '用户可能更喜欢浅烘焙咖啡；这是从对话里推断的，尚未确认。', gist: '可能偏好浅烘焙', sourceKind: 'inferred', sourceRef: 'demo:seed', trust: 'low', confidence: 0.55, importance: { novelty: 0.4, social: 0.2 }, sensitivity: 'standard', status: 'proposed' },
        { id: 'demo-proposed-desk', kind: 'semantic', content: '用户可能计划把工作台移到窗边；来自一次未确认的提及。', gist: '可能想移动工作台', sourceKind: 'inferred', sourceRef: 'demo:seed', trust: 'low', confidence: 0.48, importance: { novelty: 0.5 }, sensitivity: 'standard', status: 'proposed' },
      ]
      const created = []
      for (const item of items) {
        this.deps.memory.delete(item.id ?? '')
        created.push(await this.deps.memory.add(item, true))
      }
      this.deps.memory.link('demo-semantic-review', 'demo-prospective-report', 'related', 0.9)
      this.deps.memory.link('demo-episodic-latency', 'demo-procedural-start', 'related', 0.65)
      this.deps.memory.link('demo-procedural-model', 'demo-semantic-privacy', 'related', 0.6)
      sendJson(response, 200, { items: created.length, graph: this.deps.memory.graph(160) })
      return
    }

    if (request.method === 'POST' && path === '/api/memory/consolidate') {
      const stats = await this.deps.memory.consolidate()
      sendJson(response, 200, { ok: true, stats })
      return
    }

    if (request.method === 'GET' && path === '/api/traces') {
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50))
      sendJson(response, 200, { traces: this.deps.telemetry.historyTraces(limit) })
      return
    }

    if (request.method === 'GET' && path === '/api/memory/graph') {
      const limit = Number(url.searchParams.get('limit') ?? 140)
      sendJson(response, 200, this.deps.memory.graph(Number.isFinite(limit) ? limit : 140))
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

    if (request.method === 'POST' && path === '/api/model/list') {
      try {
        const body = await readJson<Partial<ModelProfile>>(request)
        const profile = await this.profileFromBody(body)
        const result = await this.deps.models.list(profile)
        sendJson(response, result.ok ? 200 : 502, result)
      } catch (error) {
        sendJson(response, 400, { ok: false, models: [], error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/model/test') {
      try {
        const body = await readJson<Partial<ModelProfile>>(request)
        const profile = await this.profileFromBody(body)
        const result = await this.deps.models.test(profile)
        sendJson(response, result.ok ? 200 : 502, { ...result, error: result.ok ? undefined : result.message })
      } catch (error) {
        sendJson(response, errorStatus(error, 400), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/model/apply') {
      try {
        const body = await readJson<Partial<ModelProfile>>(request)
        const profile = await this.profileFromBody(body)
        this.assertActivatable(profile)
        const previous = await this.deps.modelSettings.load()
        await this.deps.modelSettings.upsert(profile, false)
        try {
          const switched = await this.deps.models.switchTo(profile)
          const { settings } = await this.deps.modelSettings.activate(profile.id)
          await this.deps.conversation.refreshModel()
          const active = this.deps.models.status()
          this.deps.bus.emit('model.changed', { active, test: switched.test })
          sendJson(response, 200, {
            settings: this.deps.modelSettings.publicView(settings),
            active,
            test: switched.test,
          })
        } catch (error) {
          await this.deps.modelSettings.save(previous).catch(() => undefined)
          await this.restoreModelRuntime(previous)
          throw error
        }
      } catch (error) {
        sendJson(response, errorStatus(error, 409), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/model/activate') {
      try {
        const body = await readJson<{ id?: string }>(request)
        const id = typeof body.id === 'string' && /^[a-z0-9-]{1,32}$/.test(body.id) ? body.id : ''
        if (!id) throw new Error('模型配置 id 不合法')
        const loaded = await this.deps.modelSettings.load()
        const found = loaded.profiles.find(item => item.id === id)
        if (!found) throw new Error('没有这个模型配置')
        const profile = validateProfile(found)
        this.assertActivatable(profile)
        const previous = loaded
        try {
          const switched = await this.deps.models.switchTo(profile)
          const { settings } = await this.deps.modelSettings.activate(id)
          await this.deps.conversation.refreshModel()
          const active = this.deps.models.status()
          this.deps.bus.emit('model.changed', { active, test: switched.test })
          sendJson(response, 200, { settings: this.deps.modelSettings.publicView(settings), active, test: switched.test })
        } catch (error) {
          await this.deps.modelSettings.save(previous).catch(() => undefined)
          await this.restoreModelRuntime(previous)
          throw error
        }
      } catch (error) {
        sendJson(response, errorStatus(error, 409), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/model/profile/add') {
      try {
        const body = await readJson<Partial<ModelProfile>>(request)
        const settings = await this.deps.modelSettings.addProfile(body)
        sendJson(response, 200, { settings: this.deps.modelSettings.publicView(settings) })
      } catch (error) {
        sendJson(response, errorStatus(error, 400), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/model/profile/update') {
      try {
        const body = await readJson<Partial<ModelProfile>>(request)
        const profile = await this.profileFromBody(body)
        const settings = await this.deps.modelSettings.load()
        if (settings.active === profile.id) {
          sendJson(response, 409, { error: '当前使用的供应商请用「保存并切换」，会先测试再生效' })
          return
        }
        const saved = await this.deps.modelSettings.upsert(profile, false)
        sendJson(response, 200, { settings: this.deps.modelSettings.publicView(saved) })
      } catch (error) {
        sendJson(response, errorStatus(error, 400), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/model/profile/delete') {
      try {
        const body = await readJson<{ id?: string }>(request)
        if (!body.id) throw new Error('缺少供应商 id')
        const settings = await this.deps.modelSettings.removeProfile(String(body.id))
        sendJson(response, 200, { settings: this.deps.modelSettings.publicView(settings) })
      } catch (error) {
        sendJson(response, errorStatus(error, 400), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/model/priority') {
      try {
        const body = await readJson<{ priority?: string[] }>(request)
        if (!Array.isArray(body.priority)) throw new Error('priority 需要是字符串数组')
        const settings = await this.deps.modelSettings.setPriority(body.priority)
        sendJson(response, 200, { settings: this.deps.modelSettings.publicView(settings) })
      } catch (error) {
        sendJson(response, errorStatus(error, 400), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/model/scenarios') {
      try {
        const body = await readJson<{ scenarios?: unknown[]; scenarioAuto?: boolean; defaultScenario?: string }>(request)
        const settings = await this.deps.modelSettings.setScenarios(body)
        sendJson(response, 200, { settings: this.deps.modelSettings.publicView(settings) })
      } catch (error) {
        sendJson(response, errorStatus(error, 400), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (path === '/api/profile' || path.startsWith('/api/profile/')) {
      const profile = this.deps.profile
      if (!profile) throw new HttpError(503, '个人资料尚未启用')
      const changed = () => {
        this.deps.conversation.invalidateProfileUsage?.()
        this.deps.bus.emit('profile.changed', { at: Date.now() })
      }
      if (path === '/api/profile' && request.method === 'GET') {
        sendJson(response, 200, profile.snapshot())
        return
      }
      if (path === '/api/profile/entries' && request.method === 'POST') {
        const body = await readJson<ProfileEntryInput>(request)
        const previous = body.id ? profile.snapshot().entries.find(entry => entry.id === body.id) : undefined
        // A browser may edit facts, never forge provenance or bypass user locks.
        const entry = profile.saveEntry({ id: body.id, expectedRevision: body.expectedRevision,
          subjectId: body.subjectId, category: body.category, field: body.field, value: body.value,
          content: body.content, status: body.status, usage: body.usage, scope: body.scope,
          sourceKind: 'user-confirmed', sourceRef: 'profile:manual', userLocked: true })
        if (previous?.sourceRef.startsWith('turn:')) this.deps.sessions?.excludeTurnFromContext(previous.sourceRef.slice(5))
        changed()
        sendJson(response, body.id ? 200 : 201, { entry })
        return
      }
      if (path === '/api/profile/people' && request.method === 'POST') {
        const body = await readJson<ProfilePersonInput>(request)
        const person = profile.savePerson({ id: body.id, expectedRevision: body.expectedRevision, name: body.name, relationship: body.relationship })
        changed()
        sendJson(response, body.id ? 200 : 201, { person })
        return
      }
      if (path === '/api/profile/settings' && request.method === 'PATCH') {
        const body = await readJson<{ learningEnabled?: boolean; useEnabled?: boolean }>(request)
        const settings = profile.updateSettings({ ...(body.learningEnabled === undefined ? {} : { learningEnabled: body.learningEnabled }), ...(body.useEnabled === undefined ? {} : { useEnabled: body.useEnabled }) })
        for (const entry of profile.snapshot().entries) if (entry.sourceRef.startsWith('turn:')) this.deps.sessions?.excludeTurnFromContext(entry.sourceRef.slice(5))
        changed()
        sendJson(response, 200, { settings })
        return
      }
      const match = /^\/api\/profile\/(entries|people)\/([a-zA-Z0-9_-]{1,128})(\/source)?$/.exec(path)
      if (match) {
        const [, kind, id, action] = match
        if (kind === 'entries' && action === '/source' && request.method === 'GET') {
          const entry = profile.snapshot().entries.find(item => item.id === id)
          if (!entry) throw new HttpError(404, '这条理解已不存在')
          const memory = this.deps.memory.get(entry.memoryId)
          const turnId = memory?.sourceRef.startsWith('turn:') ? memory.sourceRef.slice(5) : undefined
          const turn = turnId ? this.deps.sessions?.getTurn(turnId) : undefined
          sendJson(response, 200, turn ? { available: true, text: turn.user.content, sessionId: turn.user.sessionId, turnId } : {
            available: false, reason: memory?.sourceRef === 'profile:manual' ? '由你在资料页直接填写或订正' : '原始对话不可用，可能已删除或来自旧版本记忆',
          })
          return
        }
        if (!action && request.method === 'DELETE') {
          const body = await readJson<{ expectedRevision: number }>(request)
          const sources = profile.snapshot().entries.filter(entry => kind === 'entries' ? entry.id === id : entry.subjectId === id).map(entry => entry.sourceRef)
          if (kind === 'entries') profile.deleteEntry(id, body.expectedRevision)
          else profile.deletePerson(id, body.expectedRevision)
          for (const source of sources) if (source.startsWith('turn:')) this.deps.sessions?.excludeTurnFromContext(source.slice(5))
          changed()
          sendJson(response, 200, { ok: true })
          return
        }
      }
      throw new HttpError(404, '个人资料接口不存在')
    }

    if (path === '/api/sessions' || path.startsWith('/api/sessions/')) {
      const store = this.deps.sessions
      if (!store) throw new HttpError(503, '会话存储未启用')
      const match = /^\/api\/sessions\/([a-zA-Z0-9_-]{1,128})(\/export)?$/.exec(path)
      const id = match?.[1]
      const activeTurn = this.deps.conversation.status().activeTurn as { sessionId: string; turnId: string } | null
      try {
        if (path === '/api/sessions' && request.method === 'GET') {
          const archived = url.searchParams.get('archived')
          if (archived !== null && archived !== 'true' && archived !== 'false') throw new HttpError(400, 'archived 应为 true 或 false')
          sendJson(response, 200, store.list({ query: url.searchParams.get('query') ?? '', limit: Number(url.searchParams.get('limit') ?? 50), offset: Number(url.searchParams.get('offset') ?? 0), ...(archived === null ? {} : { archived: archived === 'true' }) }))
          return
        }
        if (path === '/api/sessions' && request.method === 'POST') {
          const body = await readJson<{ title?: string }>(request)
          const session = store.create(body.title)
          this.deps.bus.emit('session.changed', { sessionId: session.id, action: 'created' })
          sendJson(response, 201, { session })
          return
        }
        if (path === '/api/sessions' && request.method === 'DELETE') {
          const body = await readJson<{ confirm?: string }>(request)
          if (body.confirm !== 'DELETE ALL SESSIONS') throw new HttpError(400, '需要确认清空会话')
          if (this.deps.conversation.status().busy) throw new HttpError(409, '请先停止正在进行的回复，再清空会话')
          await this.clearLocalSessionData(undefined, () => store.clearAll())
          this.deps.bus.clear()
          const session = store.getOrCreateDefault()
          this.deps.bus.emit('session.changed', { action: 'cleared', sessionId: session.id })
          sendJson(response, 200, { ok: true, session })
          return
        }
        if (!id) throw new HttpError(404, '会话接口不存在')
        const session = store.get(id)
        if (!session) throw new HttpError(404, '会话不存在或已删除')
        if (match?.[2] === '/export' && request.method === 'GET') {
          sendJson(response, 200, { ...store.exportSession(id), ...(this.deps.toolJournal ? { toolCalls: this.deps.toolJournal.listCalls(id) } : {}), ...(this.deps.taskTools ? { localTools: this.deps.taskTools.exportSession(id) } : {}), ...(this.deps.fileTools ? { artifacts: this.deps.fileTools.artifacts(id) } : {}) }, { 'content-disposition': `attachment; filename="jarvis-session-${id}.json"` })
          return
        }
        if (match?.[2]) throw new HttpError(405, '不支持此方法')
        if (request.method === 'GET') {
          const before = url.searchParams.get('before')
          sendJson(response, 200, { session, messages: store.messages(id, { limit: Number(url.searchParams.get('limit') ?? 100), ...(before === null ? {} : { before: Number(before) }) }), activeTurn: activeTurn ?? null })
          return
        }
        if (request.method === 'PATCH') {
          const body = await readJson<{ title?: string; archived?: boolean }>(request)
          if (body.title === undefined && body.archived === undefined) throw new HttpError(400, '需要标题或归档状态')
          if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120)) throw new HttpError(400, '标题须为 1–120 个字符')
          if (body.archived !== undefined && typeof body.archived !== 'boolean') throw new HttpError(400, '归档状态须为布尔值')
          if (activeTurn?.sessionId === id && body.archived === true) throw new HttpError(409, '请先停止回复，再归档会话')
          if (body.title !== undefined) store.rename(id, body.title)
          if (body.archived !== undefined) store.setArchived(id, body.archived)
          this.deps.bus.emit('session.changed', { sessionId: id, action: 'updated' })
          sendJson(response, 200, { session: store.get(id) })
          return
        }
        if (request.method === 'DELETE') {
          if (activeTurn?.sessionId === id) throw new HttpError(409, '请先停止正在进行的回复，再删除会话')
          await this.clearLocalSessionData(id, () => store.delete(id))
          this.deps.bus.clear()
          this.deps.bus.emit('session.changed', { sessionId: id, action: 'deleted' })
          sendJson(response, 200, { ok: true })
          return
        }
        throw new HttpError(405, '不支持此方法')
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) throw new HttpError(400, error.message)
        throw error
      }
    }

    if (request.method === 'POST' && path === '/api/chat') {
      const body = await readJson<{ text?: string; scenario?: string; sessionId?: string; turnId?: string }>(request)
      if (typeof body.text !== 'string' || !body.text.trim()) {
        sendJson(response, 400, { error: 'text is required' })
        return
      }
      if (body.text.length > MAX_CHAT_CHARS) {
        sendJson(response, 400, { error: `消息太长（上限 ${MAX_CHAT_CHARS} 字）` })
        return
      }
      const scenario = typeof body.scenario === 'string' && /^[a-z0-9-]{1,32}$/.test(body.scenario) ? body.scenario : undefined
      const identity = conversationIdentity(body)
      if (identity.sessionId && this.deps.sessions && (this.deletingSessions.has(identity.sessionId) || !this.deps.sessions.get(identity.sessionId))) throw new HttpError(404, '会话不存在或已删除')
      const result = await this.deps.conversation.handleText(body.text, { source: 'text', scenario, ...identity })
      sendJson(response, result.busy ? 409 : 200, { ...result, ...(result.busy ? { error: result.reply, activeTurn: this.deps.conversation.status().activeTurn ?? null } : {}) })
      return
    }

    if (request.method === 'GET' && path === '/api/voice') {
      if (!this.deps.voice || !this.deps.voiceSettings) {
        sendJson(response, 503, { error: '语音运行时未启用' })
        return
      }
      sendJson(response, 200, {
        settings: this.deps.voice.settingsView(),
        status: this.deps.voice.status(),
        cooldowns: this.deps.voice.cooldowns(),
      })
      return
    }

    if (request.method === 'POST' && path === '/api/voice/apply') {
      if (!this.deps.voice || !this.deps.voiceSettings) {
        sendJson(response, 503, { error: '语音运行时未启用' })
        return
      }
      try {
        const body = await readJson<VoiceUpdate>(request)
        const current = await this.deps.voiceSettings.load()
        const next = mergeVoiceUpdate(current, body)
        const settings = await this.deps.voice.apply(next)
        await this.deps.conversation.refreshVoiceReadiness()
        const status = this.deps.voice.status()
        this.deps.bus.emit('voice.changed', { asr: status.asr, tts: status.tts })
        sendJson(response, 200, { settings, status, cooldowns: this.deps.voice.cooldowns() })
      } catch (error) {
        sendJson(response, errorStatus(error, 409), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'POST' && path === '/api/voice') {
      const mime = request.headers['content-type'] ?? 'audio/webm'
      const body = await readBody(request, 30_000_000)
      if (body.length === 0) {
        sendJson(response, 400, { error: 'empty audio' })
        return
      }
      const identity = conversationIdentity({ sessionId: url.searchParams.get('sessionId') ?? undefined, turnId: url.searchParams.get('turnId') ?? undefined })
      if (identity.sessionId && this.deps.sessions && (this.deletingSessions.has(identity.sessionId) || !this.deps.sessions.get(identity.sessionId))) throw new HttpError(404, '会话不存在或已删除')
      const scenario = url.searchParams.get('scenario') ?? undefined
      const result = await this.deps.conversation.handleAudio(body, mime, { ...identity, scenario })
      sendJson(response, result.busy ? 409 : 200, { ...result, ...(result.busy ? { error: result.reply, activeTurn: this.deps.conversation.status().activeTurn ?? null } : {}) })
      return
    }

    if (request.method === 'POST' && path === '/api/look') {
      const body = await readJson<{ target?: string; vision?: boolean; sessionId?: string; turnId?: string }>(request)
      const target = body.target === 'camera' ? 'camera' : 'screen'
      const text = target === 'camera' ? '看下摄像头' : body.vision ? '用视觉看屏幕' : '看下屏幕'
      const identity = conversationIdentity(body)
      if (identity.sessionId && this.deps.sessions && (this.deletingSessions.has(identity.sessionId) || !this.deps.sessions.get(identity.sessionId))) throw new HttpError(404, '会话不存在或已删除')
      const result = await this.deps.conversation.handleText(text, { source: 'text', ...identity })
      sendJson(response, result.busy ? 409 : 200, { ...result, ...(result.busy ? { error: result.reply } : {}) })
      return
    }

    if (request.method === 'GET' && path === '/api/privacy/export') {
      const exported = this.deps.memory.exportAll()
      const settings = await this.deps.modelSettings.load()
      const conversations = this.deps.sessions?.exportAll()
      const payload = {
        ...exported,
        conversations: conversations && { ...conversations, sessions: conversations.sessions.map(session => ({
          ...session, ...(this.deps.toolJournal ? { toolCalls: this.deps.toolJournal.listCalls(session.id) } : {}),
          ...(this.deps.taskTools ? { localTools: this.deps.taskTools.exportSession(session.id) } : {}),
          ...(this.deps.fileTools ? { artifacts: this.deps.fileTools.artifacts(session.id) } : {}),
        })) },
        localToolSettings: this.deps.localSettings?.snapshot(),
        reminders: this.deps.reminders.list(),
        devices: this.devices.list(),
        config: {
          host: this.deps.config.host,
          port: this.deps.config.port,
          model: settings.profiles.find(item => item.id === settings.active)?.label ?? 'local',
          scenarios: settings.scenarios.length,
        },
      }
      sendJson(response, 200, payload, { 'content-disposition': `attachment; filename="jarvis-export-${new Date().toISOString().slice(0, 10)}.json"` })
      return
    }

    if (request.method === 'POST' && path === '/api/privacy/erase') {
      const body = await readJson<{ confirm?: string }>(request)
      if (body.confirm !== 'ERASE ALL') {
        sendJson(response, 400, { error: 'confirmation phrase is required' })
        return
      }
      if (this.erasing || this.changingMcp || this.changingModel || this.changingLocalSettings) throw new HttpError(409, '正在更新配置或清空数据，请稍后再试')
      this.erasing = true
      try {
      await this.deps.conversation.quiesce()
      await this.deps.tools?.quiesce()
      await this.deps.taskTools?.quiesce()
      await this.deps.taskTools?.clearAll()
      await this.deps.fileTools?.clearAll()
      await this.deps.localSettings?.reset()
      this.deps.sessions?.clearAll()
      const counts = this.deps.memory.eraseAll()
      this.pairing.clear()
      this.devices.clear()
      this.deps.actions.clear()
      this.deps.telemetry.clearAll()
      // In-memory echoes: a reconnecting client must not receive the previous
      // conversation through the replay ring or the model's history.
      this.deps.bus.clear()
      this.deps.conversation.reset()
      for (const name of ['audio', 'captures']) {
        await rm(join(this.deps.config.dataDir, name), { recursive: true, force: true })
        await mkdir(join(this.deps.config.dataDir, name), { recursive: true, mode: 0o700 })
      }
      for (const name of ['audit/actions.jsonl', 'telemetry.jsonl', 'telemetry.jsonl.1', 'jarvis.log']) {
        await rm(join(this.deps.config.dataDir, name), { force: true })
      }
      // Provider files hold remote API keys, so a full erase resets them and
      // falls back to the local model and local speech.
      const modelDefaults = await this.deps.modelSettings.resetToDefaults()
      const localProfile = modelDefaults.profiles.find(item => item.id === 'local')
      if (localProfile) {
        const profile = validateProfile(localProfile)
        this.deps.models.resetTo(profile)
        await this.deps.conversation.refreshModel().catch(() => undefined)
      }
      let voiceReset = false
      if (this.deps.voiceSettings) {
        const voiceDefaults = await this.deps.voiceSettings.resetToDefaults()
        voiceReset = true
        await this.deps.voice?.clearHealth?.().catch(() => undefined)
        // Rebuild the chain in memory too, otherwise status keeps advertising
        // the providers whose keys were just erased.
        await this.deps.voice?.apply(voiceDefaults).catch(() => undefined)
      }
      // This endpoint explicitly erases all data, including MCP credentials.
      // Memory-only deletion never changes MCP configuration.
      if (this.deps.mcp) {
        try {
          if (this.deps.mcp.erase) await this.deps.mcp.erase()
          else for (const server of this.deps.mcp.snapshot().servers) {
            await this.deps.mcp.remove(server.id, this.deps.mcp.snapshot().revision)
          }
        } catch {
          throw new HttpError(409, 'MCP 配置清空失败，请重试')
        }
      }
      // Rotate only after the files that used the old key are gone.
      this.deps.secure.rotate()
      // No session may keep streaming after a wipe.
      this.closeAllSockets()
      this.deps.logger.info('privacy erase completed', { ...counts, voiceReset })
      sendJson(response, 200, {
        ok: true,
        erased: counts,
        providersReset: true,
        voiceReset,
        socketsClosed: true,
        conversationsErased: true,
      })
      } finally {
        this.deps.conversation.resumeAdmissions()
        this.erasing = false
      }
      return
    }

    if (request.method === 'GET' && path === '/api/brief') {
      sendJson(response, 200, buildDailyBrief(this.deps.memory, this.deps.reminders, new Date(), await readCalendar(process.env.JARVIS_CALENDAR_ICS)))
      return
    }

    if (request.method === 'POST' && path === '/api/brief/read') {
      const brief = buildDailyBrief(this.deps.memory, this.deps.reminders, new Date(), await readCalendar(process.env.JARVIS_CALENDAR_ICS))
      const audioUrl = await this.deps.conversation.speakText(brief.text)
      sendJson(response, 200, { ...brief, audioUrl })
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
      if (typeof body.content !== 'string' || !body.content.trim()) {
        sendJson(response, 400, { error: 'content is required' })
        return
      }
      if (body.content.length > MAX_MEMORY_CHARS) {
        sendJson(response, 400, { error: `记忆太长（上限 ${MAX_MEMORY_CHARS} 字）` })
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
      const previousMemory = this.deps.memory.get(id)
      if (previousMemory && ['POST', 'DELETE'].includes(request.method ?? '')) {
        this.deps.conversation.invalidateProfileUsage?.()
        if (previousMemory.sourceRef.startsWith('turn:')) this.deps.sessions?.excludeTurnFromContext(previousMemory.sourceRef.slice(5))
      }
      if (request.method === 'DELETE' && !memoryMatch[2]) {
        if (!this.deps.memory.delete(id)) {
          sendJson(response, 404, { ok: false, error: 'memory not found' })
          return
        }
        sendJson(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && memoryMatch[2] === 'confirm') {
        const item = this.deps.memory.confirm(id)
        if (!item) {
          sendJson(response, 404, { error: 'memory not found' })
          return
        }
        sendJson(response, 200, { item })
        return
      }
      if (request.method === 'POST' && memoryMatch[2] === 'reject') {
        const item = this.deps.memory.reject(id)
        if (!item) {
          sendJson(response, 404, { error: 'memory not found' })
          return
        }
        sendJson(response, 200, { item })
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
        sendJson(response, errorStatus(error, 409), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    if (request.method === 'GET' && path === '/api/reminders') {
      sendJson(response, 200, { items: this.deps.reminders.list() })
      return
    }

    if (request.method === 'POST' && path === '/api/reminders') {
      const body = await readJson<{ text?: string; dueAt?: string }>(request)
      if (typeof body.text !== 'string' || !body.text.trim() || typeof body.dueAt !== 'string' || !body.dueAt.trim()) {
        sendJson(response, 400, { error: 'text and dueAt are required' })
        return
      }
      if (body.text.length > MAX_REMINDER_CHARS) {
        sendJson(response, 400, { error: `提醒太长（上限 ${MAX_REMINDER_CHARS} 字）` })
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
        if (!this.deps.reminders.remove(id)) {
          sendJson(response, 404, { ok: false, error: 'reminder not found' })
          return
        }
        sendJson(response, 200, { ok: true })
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
      const body = await readJson<{ sessionId?: string; turnId?: string }>(request)
      const cancelled = this.deps.conversation.cancel(conversationIdentity(body))
      sendJson(response, 200, { ok: true, cancelled, activeTurn: this.deps.conversation.status().activeTurn ?? null })
      return
    }

    if ((request.method === 'GET' || request.method === 'DELETE') && path.startsWith('/api/captures/')) {
      const name = decodeURIComponent(path.slice('/api/captures/'.length))
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
        sendJson(response, 400, { error: 'invalid capture name' })
        return
      }
      if (request.method === 'DELETE') {
        await rm(join(this.deps.config.dataDir, 'captures', name), { force: true })
        sendJson(response, 200, { ok: true, deleted: name })
        return
      }
      await this.serveDataFile(response, join(this.deps.config.dataDir, 'captures'), name)
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
    } finally {
      if (modelMutation) {
        this.deps.conversation.resumeAdmissions?.()
        this.changingModel = false
      }
    }
  }

  /**
   * DNS-rebinding defence: the Host header must name this machine. A malicious
   * page can rebind its own domain to 127.0.0.1, which makes the socket look
   * local — but the Host header still carries the attacker's domain, so
   * rejecting unknown hosts closes the hole. Add LAN names through
   * JARVIS_ALLOWED_HOSTS (comma separated) when serving beyond localhost.
   */
  private allowedHosts(): Set<string> {
    const hosts = new Set(['localhost', '127.0.0.1', '::1'])
    const configured = this.deps.config.host.trim().toLowerCase()
    if (configured && configured !== '0.0.0.0' && configured !== '::') hosts.add(configured.replace(/^\[|\]$/g, ''))
    for (const extra of (process.env.JARVIS_ALLOWED_HOSTS ?? '').split(',')) {
      const name = extra.trim().toLowerCase().replace(/^\[|\]$/g, '')
      if (name) hosts.add(name)
    }
    return hosts
  }

  private hostAllowed(request: IncomingMessage): boolean {
    const header = request.headers.host
    if (!header) return false
    try {
      return this.allowedHosts().has(hostnameOf(header))
    } catch {
      return false
    }
  }

  private isLoopback(request: IncomingMessage): boolean {
    const address = request.socket.remoteAddress ?? ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  private publicConfig(): Record<string, unknown> {
    return {
      version: this.deps.config.version,
      host: this.deps.config.host,
      port: this.deps.config.port,
      dataDir: this.deps.config.dataDir,
      webDir: this.deps.config.webDir,
      auth: { required: !isLoopbackHost(this.deps.config.host), tokenConfigured: Boolean(this.deps.config.authToken), tokenLength: this.deps.config.authToken.length },
      tls: { enabled: Boolean(this.deps.config.tlsCert), cert: this.deps.config.tlsCert || null, keyConfigured: Boolean(this.deps.config.tlsKey), key: null },
      ollama: { ...this.deps.config.ollama },
      voice: { ...this.deps.config.voice },
      quiet: { ...this.deps.config.quiet },
      dailySpeakBudget: this.deps.config.dailySpeakBudget,
      screenTimeoutMs: this.deps.config.screenTimeoutMs,
      screenBlocklist: [...this.deps.config.screenBlocklist],
      model: this.deps.models.status(),
      runtime: {
        pid: process.pid,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        startedAt: new Date(this.startedAt).toISOString(),
      },
    }
  }

  private async clearLocalSessionData(id: string | undefined, remove: () => unknown): Promise<void> {
    if (this.erasing || this.changingMcp || this.changingModel || this.changingLocalSettings) throw new HttpError(409, '正在更新配置或清空数据，请稍后再试')
    const activeTurn = this.deps.conversation.status().activeTurn as { sessionId: string } | null
    if (!id || activeTurn?.sessionId === id) this.assertModelMutable()
    this.changingLocalSettings = true
    try {
      if (id) {
        this.deletingSessions.add(id)
        this.deps.conversation.blockSessionAdmissions?.(id)
        await this.deps.taskTools?.clearSession(id)
        await this.deps.fileTools?.clearSession(id)
      } else {
        await this.deps.conversation.quiesce?.()
        await this.deps.tools?.quiesce()
        await this.deps.taskTools?.clearAll()
        await this.deps.fileTools?.clearAll()
      }
      remove()
    } finally {
      if (!id) this.deps.conversation.resumeAdmissions?.()
      if (id) {
        this.deletingSessions.delete(id)
        this.deps.conversation.resumeSessionAdmissions?.(id)
      }
      this.changingLocalSettings = false
    }
  }

  private assertModelMutable(): void {
    if (this.erasing || this.changingMcp || this.changingModel || this.changingLocalSettings || this.deps.conversation.status().busy) throw new HttpError(409, '请先停止回复或等待配置更新完成')
  }

  private assertActivatable(profile: ModelProfile): void {
    if (profile.kind !== 'openai' || profile.apiKey) return
    let loopback = false
    try { loopback = isLoopbackHost(new URL(profile.baseUrl).hostname) } catch { /* validated elsewhere */ }
    if (!loopback) throw new Error('远端配置还没有 API Key')
  }

  private async restoreModelRuntime(previous: ModelSettings): Promise<void> {
    const profile = previous.profiles.find(item => item.id === previous.active)
    if (!profile) return
    try {
      await this.deps.models.switchTo(validateProfile(profile))
      await this.deps.conversation.refreshModel()
    } catch {
      // The previous runtime may itself be unreachable. The persisted config is
      // still rolled back, so the next restart starts from a consistent state.
    }
  }

  private async profileFromBody(body: Partial<ModelProfile>): Promise<ModelProfile> {
    const settings = await this.deps.modelSettings.load()
    if (body.id !== undefined && !/^[a-z0-9-]{1,32}$/.test(String(body.id))) throw new Error('供应商 id 不合法')
    const id = body.id ? String(body.id) : 'local'
    const existing = settings.profiles.find(item => item.id === id)
    if (!existing) throw new Error('没有这个模型配置')
    const nextBase = String(body.baseUrl ?? existing.baseUrl).trim().replace(/\/+$/, '')
    if (existing.kind === 'openai' && nextBase !== existing.baseUrl.replace(/\/+$/, '') && !body.apiKey?.trim()) {
      let loopback = false
      try { loopback = isLoopbackHost(new URL(nextBase).hostname) } catch { /* validateProfile reports it */ }
      if (!loopback) throw new Error('更换远端地址时请重新输入 API Key，避免把旧密钥发给新地址')
    }
    const protocol = body.protocol === 'responses' || body.protocol === 'anthropic' || body.protocol === 'chat-completions'
      ? body.protocol
      : existing.protocol
    const merged: ModelProfile = {
      ...existing,
      ...body,
      id,
      kind: body.kind === 'openai' ? 'openai' : body.kind === 'ollama' ? 'ollama' : existing.kind,
      protocol,
      apiKey: body.apiKey?.trim() ? body.apiKey.trim() : existing.apiKey,
    }
    return validateProfile(merged)
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
      response.setHeader('cache-control', 'private, no-store')
      response.end(this.deps.secure.decryptFile(path))
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
      const extension = extname(file).toLowerCase()
      const revalidate = ['.html', '.js', '.css', '.webmanifest', '.json'].includes(extension)
      response.setHeader('cache-control', revalidate ? 'no-cache' : 'public, max-age=300')
      response.end(await readFile(file))
    } catch {
      sendText(response, 404, 'not found')
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      try {
        client.close()
        // A stalled client must not hold the process open on SIGTERM.
        setTimeout(() => { try { client.terminate() } catch { /* already gone */ } }, 1000).unref()
      } catch {
        // Already closed.
      }
    }
    this.clients.clear()
    await new Promise<void>(resolvePromise => {
      if (!this.server) return resolvePromise()
      const timer = setTimeout(resolvePromise, 3000)
      timer.unref()
      this.server.close(() => {
        clearTimeout(timer)
        resolvePromise()
      })
    })
    this.wss?.close()
  }
}