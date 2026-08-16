import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { MobileApprovalDecisionError } from './approval.js'
import { normalizeHighRiskDeviceCommand, type DeviceApprovalOutcome, type DeviceApprovalSource, type HighRiskDeviceCommand } from './device-approval.js'
import { FileEventLogStore, RetainedEventLog, type JarvisEvent } from './event-log.js'
import { HarnessBridge, HarnessBridgeError, type HarnessClient } from './harness-bridge.js'
import { HarnessEventBridge, type ConversationEventSource } from './harness-events.js'
import { NODE_PROTOCOL_VERSION, parseNodeRegistration, type NodeRegistration } from './node-capabilities.js'
import type { NodeCommand } from './node-command.js'
import { FilePairingStateStore, PairingAuthority } from './pairing.js'
import { PwaShell } from './pwa.js'
import { TokenBucketRateLimiter, type RateLimitDecision, type TokenBucketRateLimiterOptions } from './rate-limit.js'
import { FileSessionStateStore, SessionAuthenticationError, SessionAuthority, type SessionPrincipal } from './sessions.js'

const MAX_BODY_BYTES = 32 * 1024
const NODE_PATH = '/v1/node'
const EVENTS_PATH = '/v1/events'
const NODE_HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_NODE_CONNECTIONS = 128
const EVENT_HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_EVENT_CONNECTIONS = 128
const DEFAULT_SOURCE_RATE_LIMIT = { capacity: 60, refillPerSecond: 1, maxKeys: 4_096 }
const DEFAULT_IDENTITY_RATE_LIMIT = { capacity: 120, refillPerSecond: 2, maxKeys: 1_024 }
const ALLOWED_BIND_ADDRESSES = new BlockList()
ALLOWED_BIND_ADDRESSES.addAddress('127.0.0.1', 'ipv4')
ALLOWED_BIND_ADDRESSES.addAddress('::1', 'ipv6')
ALLOWED_BIND_ADDRESSES.addSubnet('10.0.0.0', 8, 'ipv4')
ALLOWED_BIND_ADDRESSES.addSubnet('172.16.0.0', 12, 'ipv4')
ALLOWED_BIND_ADDRESSES.addSubnet('192.168.0.0', 16, 'ipv4')
ALLOWED_BIND_ADDRESSES.addSubnet('100.64.0.0', 10, 'ipv4')
ALLOWED_BIND_ADDRESSES.addSubnet('fc00::', 7, 'ipv6')

type GatewayServer = HttpServer | HttpsServer

export interface GatewayTlsOptions {
  key: string | Buffer
  cert: string | Buffer
  ca?: string | Buffer
}

export interface JarvisGatewayOptions {
  ownerToken: string
  authority?: PairingAuthority
  pairingStatePath?: string
  maxBodyBytes?: number
  nodeHandshakeTimeoutMs?: number
  maxNodeConnections?: number
  bindHost?: string
  tls?: GatewayTlsOptions
  sessions?: SessionAuthority
  sessionStatePath?: string
  sourceRateLimit?: TokenBucketRateLimiterOptions
  identityRateLimit?: TokenBucketRateLimiterOptions
  harness?: HarnessClient
  harnessOrigin?: string
  harnessRequestTimeoutMs?: number
  harnessEvents?: ConversationEventSource
  deviceApprovals?: DeviceApprovalSource
  deviceCommandToken?: string
  eventLog?: RetainedEventLog
  eventStatePath?: string
  eventHandshakeTimeoutMs?: number
  maxEventConnections?: number
  pwaRoot?: string
}

export interface RunningGateway {
  server: GatewayServer
  host: string
  port: number
  secure: boolean
  origin: string
}

export interface JarvisGateway {
  start(port?: number): Promise<RunningGateway>
  stop(): Promise<void>
  connectedNodeIds(): readonly string[]
  dispatchCommand(command: NodeCommand): boolean
}

interface NodeConnectionState {
  phase: 'authenticate' | 'register' | 'ready'
  correlationId: string
  nodeId?: string
  registration?: NodeRegistration
  handshakeTimer: ReturnType<typeof setTimeout>
}

interface EventConnectionState {
  phase: 'authenticate' | 'ready'
  correlationId: string
  handshakeTimer: ReturnType<typeof setTimeout>
  expiryTimer?: ReturnType<typeof setTimeout>
  sessionId?: string
  nodeId?: string
  accessToken?: string
  lastAcknowledgedCursor?: string
  unsubscribe?: () => void
}

function sameSecret(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(actual, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function requestCorrelationId(request: IncomingMessage): string {
  const supplied = request.headers['x-correlation-id']
  if (typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) return supplied
  return randomUUID()
}

function sendJson(
  response: ServerResponse,
  status: number,
  correlationId: string,
  value: unknown,
  headers: Record<string, string | number> = {},
): void {
  if (status === 204) {
    response.writeHead(status, { 'cache-control': 'no-store', 'x-correlation-id': correlationId, ...headers })
    response.end()
    return
  }
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-correlation-id': correlationId,
    ...headers,
  })
  response.end(body)
}

function rateLimitHeaders(decision: RateLimitDecision): Record<string, string | number> {
  return {
    'retry-after': Math.max(1, Math.ceil(decision.retryAfterMs / 1_000)),
    'x-ratelimit-limit': decision.limit,
    'x-ratelimit-remaining': decision.remaining,
  }
}

function sendRateLimited(response: ServerResponse, correlationId: string, decision: RateLimitDecision): void {
  sendJson(response, 429, correlationId, {
    error: 'rate limit exceeded',
    code: 'rate_limited',
    correlationId,
  }, rateLimitHeaders(decision))
}

function sendHarnessError(response: ServerResponse, correlationId: string, error: HarnessBridgeError): void {
  let status = 502
  let code = 'harness_protocol_error'
  let message = 'Harness returned an invalid response'
  if (error.code === 'timeout') {
    status = 504
    code = 'harness_timeout'
    message = 'Harness request timed out'
  } else if (error.code === 'unavailable') {
    status = 503
    code = 'harness_unavailable'
    message = 'Harness is unavailable'
  } else if (error.code === 'rejected') {
    code = 'harness_rejected'
    message = 'Harness rejected the request'
    if (error.upstreamCode === 'session-not-found') {
      status = 404
      code = 'conversation_not_found'
      message = 'Conversation was not found'
    } else if (error.upstreamCode === 'agent-busy') {
      status = 409
      code = 'conversation_busy'
      message = 'Conversation is busy'
    } else if (error.upstreamCode === 'session-conflict') {
      status = 409
      code = 'conversation_conflict'
      message = 'Conversation conflicts with existing state'
    } else if (error.upstreamCode === 'bad-request') {
      status = 400
    }
  }
  sendJson(response, status, correlationId, { error: message, code, correlationId })
}

function bearerToken(request: IncomingMessage, scheme: 'Bearer' | 'Device' | 'Session' | 'DeviceCommand'): string | undefined {
  const value = request.headers.authorization
  const prefix = `${scheme} `
  return typeof value === 'string' && value.startsWith(prefix) ? value.slice(prefix.length) : undefined
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body must be valid JSON')
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSocketMessage(data: RawData, isBinary: boolean): Record<string, unknown> | undefined {
  if (isBinary) return undefined
  try {
    const value: unknown = JSON.parse(data.toString())
    return record(value) ? value : undefined
  } catch {
    return undefined
  }
}

function sendSocket(socket: WebSocket, message: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(message))
  return true
}

function rejectUpgrade(
  socket: import('node:stream').Duplex,
  status: 403 | 404 | 429 | 503,
  headers: Record<string, string | number> = {},
): void {
  const reasons = { 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 503: 'Service Unavailable' }
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')
  socket.end(`HTTP/1.1 ${status} ${reasons[status]}\r\n${lines}Connection: close\r\nContent-Length: 0\r\n\r\n`)
}

function sourceKey(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown'
}

function routeParts(request: IncomingMessage): string[] {
  const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
  return parsed.pathname.split('/').filter(Boolean)
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function requestQuery(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
}

function optionalIntegerParameter(query: URLSearchParams, name: string, minimum: number, maximum: number): number | undefined {
  const values = query.getAll(name)
  if (values.length === 0) return undefined
  if (values.length !== 1 || !/^\d+$/.test(values[0] as string)) throw new Error(`${name} query parameter is invalid`)
  const value = Number(values[0])
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} query parameter is invalid`)
  return value
}

function validateBindHost(value: string): { host: string, loopback: boolean } {
  const family = isIP(value)
  const type = family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : undefined
  if (type === undefined || !ALLOWED_BIND_ADDRESSES.check(value, type)) {
    throw new Error('bindHost must be a specific loopback, private, or overlay IP address')
  }
  return { host: value, loopback: value === '127.0.0.1' || value === '::1' }
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value
  return normalized === '127.0.0.1' || normalized === '::1'
}

function validateTls(options: GatewayTlsOptions | undefined): GatewayTlsOptions | undefined {
  if (options === undefined) return undefined
  const present = (value: string | Buffer): boolean => typeof value === 'string' ? value.length > 0 : value.byteLength > 0
  if (!present(options.key) || !present(options.cert)) throw new Error('TLS key and certificate must not be empty')
  if (options.ca !== undefined && !present(options.ca)) throw new Error('TLS CA must not be empty')
  return options
}

export function createJarvisGateway(options: JarvisGatewayOptions): JarvisGateway {
  if (options.ownerToken.length < 16) throw new Error('ownerToken must contain at least 16 characters')
  if (options.deviceCommandToken !== undefined && options.deviceCommandToken.length < 16) {
    throw new Error('deviceCommandToken must contain at least 16 characters')
  }
  const authority = options.authority ?? new PairingAuthority(
    undefined,
    undefined,
    options.pairingStatePath === undefined ? undefined : new FilePairingStateStore(options.pairingStatePath),
  )
  const sessions = options.sessions ?? new SessionAuthority(
    options.sessionStatePath === undefined ? {} : { store: new FileSessionStateStore(options.sessionStatePath) },
  )
  for (const nodeId of new Set(sessions.list().map(session => session.nodeId))) {
    if (!authority.isActive(nodeId)) sessions.revokeDevice(nodeId)
  }
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new RangeError('maxBodyBytes must be positive')
  const nodeHandshakeTimeoutMs = options.nodeHandshakeTimeoutMs ?? NODE_HANDSHAKE_TIMEOUT_MS
  if (!Number.isInteger(nodeHandshakeTimeoutMs) || nodeHandshakeTimeoutMs < 1) {
    throw new RangeError('nodeHandshakeTimeoutMs must be a positive integer')
  }
  const maxNodeConnections = options.maxNodeConnections ?? MAX_NODE_CONNECTIONS
  if (!Number.isInteger(maxNodeConnections) || maxNodeConnections < 1) {
    throw new RangeError('maxNodeConnections must be a positive integer')
  }
  const eventHandshakeTimeoutMs = options.eventHandshakeTimeoutMs ?? EVENT_HANDSHAKE_TIMEOUT_MS
  if (!Number.isInteger(eventHandshakeTimeoutMs) || eventHandshakeTimeoutMs < 1) {
    throw new RangeError('eventHandshakeTimeoutMs must be a positive integer')
  }
  const maxEventConnections = options.maxEventConnections ?? MAX_EVENT_CONNECTIONS
  if (!Number.isInteger(maxEventConnections) || maxEventConnections < 1) {
    throw new RangeError('maxEventConnections must be a positive integer')
  }
  const binding = validateBindHost(options.bindHost ?? '127.0.0.1')
  const tls = validateTls(options.tls)
  if (!binding.loopback && tls === undefined) throw new Error('TLS is required for non-loopback Gateway binding')
  const secure = tls !== undefined
  const scope = binding.loopback ? 'loopback-only' : 'private-network-only'
  const harness = options.harness ?? new HarnessBridge({
    ...(options.harnessOrigin === undefined ? {} : { origin: options.harnessOrigin }),
    ...(options.harnessRequestTimeoutMs === undefined ? {} : { timeoutMs: options.harnessRequestTimeoutMs }),
  })
  const eventLog = options.eventLog ?? new RetainedEventLog(
    options.eventStatePath === undefined ? {} : { store: new FileEventLogStore(options.eventStatePath) },
  )
  const pwa = options.pwaRoot === undefined ? undefined : new PwaShell(options.pwaRoot)
  const harnessEvents = options.harnessEvents ?? (options.harness === undefined
    ? new HarnessEventBridge({
        ...(options.harnessOrigin === undefined ? {} : { origin: options.harnessOrigin }),
        ...(options.harnessRequestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.harnessRequestTimeoutMs }),
        listVisibleConversations: () => harness.listConversations(),
      })
    : {
        start() {},
        stop: () => Promise.resolve(),
        listApprovals: () => [],
        decideApproval: () => Promise.reject(new MobileApprovalDecisionError('unavailable')),
      })
  const sourceRateLimiter = new TokenBucketRateLimiter(options.sourceRateLimit ?? DEFAULT_SOURCE_RATE_LIMIT)
  const identityRateLimiter = new TokenBucketRateLimiter(options.identityRateLimit ?? DEFAULT_IDENTITY_RATE_LIMIT)
  let server: GatewayServer | undefined
  let nodeSocketServer: WebSocketServer | undefined
  let eventSocketServer: WebSocketServer | undefined
  let deviceApprovalUnsubscribe: (() => void) | undefined
  let harnessAvailable = false
  let harnessWasAvailable = false
  const nodeConnections = new Map<string, WebSocket>()
  const connectionStates = new Map<WebSocket, NodeConnectionState>()
  const eventConnectionStates = new Map<WebSocket, EventConnectionState>()

  const rejectNode = (socket: WebSocket, reason: string): void => {
    const state = connectionStates.get(socket)
    if (state !== undefined) clearTimeout(state.handshakeTimer)
    if (socket.readyState !== WebSocket.OPEN) {
      socket.terminate()
      return
    }
    socket.send(JSON.stringify({
      type: 'node.rejected',
      reason,
      correlationId: state?.correlationId ?? randomUUID(),
    }), () => socket.close(1008, reason))
  }

  const disconnectNode = (nodeId: string, reason: string): void => {
    const socket = nodeConnections.get(nodeId)
    if (socket !== undefined) rejectNode(socket, reason)
  }

  const handleNodeMessage = (socket: WebSocket, data: RawData, isBinary: boolean): void => {
    const state = connectionStates.get(socket)
    if (state === undefined) return
    const message = parseSocketMessage(data, isBinary)
    if (message === undefined || typeof message.type !== 'string') {
      rejectNode(socket, 'invalid node message')
      return
    }
    if (state.phase === 'authenticate') {
      if (message.type !== 'node.authenticate'
        || message.protocolVersion !== NODE_PROTOCOL_VERSION
        || typeof message.nodeId !== 'string'
        || typeof message.credential !== 'string'
        || !authority.authenticate(message.nodeId, message.credential)) {
        rejectNode(socket, 'node authentication rejected')
        return
      }
      const identityDecision = identityRateLimiter.consume(`device:${message.nodeId}`)
      if (!identityDecision.allowed) {
        rejectNode(socket, 'node rate limit exceeded')
        return
      }
      state.nodeId = message.nodeId
      state.phase = 'register'
      sendSocket(socket, { type: 'node.authenticated', correlationId: state.correlationId })
      return
    }
    if (state.phase === 'register') {
      if (message.type !== 'node.register') {
        rejectNode(socket, 'node registration required')
        return
      }
      try {
        const registration = parseNodeRegistration(message.registration)
        if (registration.nodeId !== state.nodeId) throw new Error('registration node identity does not match')
        const previous = nodeConnections.get(registration.nodeId)
        state.registration = registration
        state.phase = 'ready'
        clearTimeout(state.handshakeTimer)
        nodeConnections.set(registration.nodeId, socket)
        if (previous !== undefined && previous !== socket) rejectNode(previous, 'node connection replaced')
        sendSocket(socket, { type: 'node.ready', correlationId: state.correlationId })
      } catch {
        rejectNode(socket, 'node registration rejected')
      }
      return
    }
    if (message.type !== 'command.acknowledged'
      && message.type !== 'command.running'
      && message.type !== 'command.outcome'
      && message.type !== 'node.error') {
      rejectNode(socket, 'unsupported node message')
    }
  }

  const handleNodeConnection = (socket: WebSocket, request: IncomingMessage): void => {
    const state: NodeConnectionState = {
      phase: 'authenticate',
      correlationId: requestCorrelationId(request),
      handshakeTimer: setTimeout(() => rejectNode(socket, 'node handshake timed out'), nodeHandshakeTimeoutMs),
    }
    state.handshakeTimer.unref()
    connectionStates.set(socket, state)
    socket.on('message', (data, isBinary) => handleNodeMessage(socket, data, isBinary))
    socket.on('close', () => {
      clearTimeout(state.handshakeTimer)
      connectionStates.delete(socket)
      if (state.nodeId !== undefined && nodeConnections.get(state.nodeId) === socket) {
        nodeConnections.delete(state.nodeId)
      }
    })
    socket.on('error', () => socket.terminate())
  }

  const eventOriginAllowed = (request: IncomingMessage): boolean => {
    const origin = request.headers.origin
    if (origin === undefined) return true
    if (typeof origin !== 'string' || request.headers.host === undefined) return false
    try {
      const parsed = new URL(origin)
      const expected = new URL(`${secure ? 'https' : 'http'}://${request.headers.host}`)
      return parsed.origin === expected.origin
        && parsed.username === '' && parsed.password === '' && parsed.pathname === '/'
        && parsed.search === '' && parsed.hash === ''
    } catch {
      return false
    }
  }

  const rejectEvent = (socket: WebSocket, code: string, reason: string): void => {
    const state = eventConnectionStates.get(socket)
    if (state !== undefined) {
      clearTimeout(state.handshakeTimer)
      if (state.expiryTimer !== undefined) clearTimeout(state.expiryTimer)
      state.unsubscribe?.()
    }
    if (socket.readyState !== WebSocket.OPEN) {
      socket.terminate()
      return
    }
    socket.send(JSON.stringify({
      version: 1,
      type: 'events.rejected',
      code,
      correlationId: state?.correlationId ?? randomUUID(),
    }), () => socket.close(1008, reason))
  }

  const disconnectEventSession = (sessionId: string, reason: string): void => {
    for (const [socket, state] of eventConnectionStates) {
      if (state.sessionId === sessionId) rejectEvent(socket, 'session_invalid', reason)
    }
  }

  const disconnectEventDevice = (nodeId: string, reason: string): void => {
    for (const [socket, state] of eventConnectionStates) {
      if (state.nodeId === nodeId) rejectEvent(socket, 'device_revoked', reason)
    }
  }

  const revalidateEventSockets = (): void => {
    for (const [socket, state] of eventConnectionStates) {
      if (state.accessToken !== undefined && sessions.authenticate(state.accessToken) === undefined) {
        rejectEvent(socket, 'session_invalid', 'session access ended')
      } else if (state.nodeId !== undefined && !authority.isActive(state.nodeId)) {
        rejectEvent(socket, 'device_revoked', 'device access revoked')
      }
    }
  }

  const handleEventMessage = (socket: WebSocket, data: RawData, isBinary: boolean): void => {
    const state = eventConnectionStates.get(socket)
    if (state === undefined) return
    const message = parseSocketMessage(data, isBinary)
    if (message === undefined || typeof message.type !== 'string') {
      rejectEvent(socket, 'invalid_message', 'invalid event message')
      return
    }
    if (state.phase === 'authenticate') {
      if (message.type !== 'events.authenticate' || !exactFields(message, ['type', 'accessToken', 'cursor'])
        || typeof message.accessToken !== 'string'
        || (message.cursor !== undefined && (typeof message.cursor !== 'string' || message.cursor.length > 200))) {
        rejectEvent(socket, 'authentication_rejected', 'event authentication rejected')
        return
      }
      const principal = sessions.authenticate(message.accessToken)
      if (principal === undefined || !authority.isActive(principal.nodeId)) {
        if (principal !== undefined) sessions.revokeDevice(principal.nodeId)
        rejectEvent(socket, 'authentication_rejected', 'event authentication rejected')
        return
      }
      const identityDecision = identityRateLimiter.consume(`session:${principal.sessionId}`)
      if (!identityDecision.allowed) {
        rejectEvent(socket, 'rate_limited', 'event rate limit exceeded')
        return
      }
      const view = sessions.get(principal.sessionId)
      if (view === undefined || view.revokedAt !== null) {
        rejectEvent(socket, 'authentication_rejected', 'event authentication rejected')
        return
      }
      const replay = eventLog.replay(message.cursor as string | undefined)
      const queued: JarvisEvent[] = []
      let replaying = true
      state.unsubscribe = eventLog.subscribe(event => {
        if (replaying) queued.push(event)
        else sendSocket(socket, event)
      })
      state.sessionId = principal.sessionId
      state.nodeId = principal.nodeId
      state.accessToken = message.accessToken
      state.phase = 'ready'
      clearTimeout(state.handshakeTimer)
      const expiryTimer = setTimeout(
        () => rejectEvent(socket, 'session_expired', 'session access expired'),
        Math.max(1, view.accessExpiresAt - Date.now()),
      )
      expiryTimer.unref()
      state.expiryTimer = expiryTimer
      const requiresSnapshot = replay.requiresSnapshot || !harnessAvailable
      const reason = !harnessAvailable ? 'harness_unavailable' : replay.reason
      sendSocket(socket, {
        version: 1,
        type: 'events.ready',
        cursor: replay.cursor,
        replayCount: replay.events.length,
        requiresSnapshot,
        ...(reason === undefined ? {} : { reason }),
        correlationId: state.correlationId,
      })
      if (!requiresSnapshot) {
        for (const event of replay.events) sendSocket(socket, event)
      }
      replaying = false
      for (const event of queued) sendSocket(socket, event)
      return
    }
    if (message.type !== 'events.ack' || !exactFields(message, ['type', 'cursor']) || typeof message.cursor !== 'string'
      || message.cursor.length > 200 || state.accessToken === undefined
      || sessions.authenticate(state.accessToken) === undefined) {
      rejectEvent(socket, 'invalid_message', 'invalid event acknowledgement')
      return
    }
    const identityDecision = identityRateLimiter.consume(`session:${state.sessionId as string}`)
    if (!identityDecision.allowed) {
      rejectEvent(socket, 'rate_limited', 'event rate limit exceeded')
      return
    }
    const acknowledged = eventLog.replay(message.cursor)
    if (acknowledged.requiresSnapshot) {
      rejectEvent(socket, 'invalid_cursor', 'event acknowledgement cursor is invalid')
      return
    }
    state.lastAcknowledgedCursor = message.cursor
  }

  const handleEventConnection = (socket: WebSocket, request: IncomingMessage): void => {
    const state: EventConnectionState = {
      phase: 'authenticate',
      correlationId: requestCorrelationId(request),
      handshakeTimer: setTimeout(() => rejectEvent(socket, 'handshake_timeout', 'event handshake timed out'), eventHandshakeTimeoutMs),
    }
    state.handshakeTimer.unref()
    eventConnectionStates.set(socket, state)
    socket.on('message', (data, isBinary) => handleEventMessage(socket, data, isBinary))
    socket.on('close', () => {
      clearTimeout(state.handshakeTimer)
      if (state.expiryTimer !== undefined) clearTimeout(state.expiryTimer)
      state.unsubscribe?.()
      eventConnectionStates.delete(socket)
    })
    socket.on('error', () => socket.terminate())
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const correlationId = requestCorrelationId(request)
    try {
      const sourceDecision = sourceRateLimiter.consume(sourceKey(request))
      if (!sourceDecision.allowed) {
        sendRateLimited(response, correlationId, sourceDecision)
        return
      }
      const parts = routeParts(request)
      if (request.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'health') {
        sendJson(response, 200, correlationId, {
          service: 'jarvis-gateway',
          status: 'ok',
          scope,
          transport: secure ? 'https' : 'http',
        })
        return
      }
      if (pwa?.serve(request, response, correlationId) === true) return
      if (request.method === 'POST' && parts.length === 4 && parts[0] === 'v1'
        && parts[1] === 'pairing' && parts[2] === 'requests' && parts[3] === 'browser') {
        const body = await readJson(request, maxBodyBytes)
        if (!record(body) || !exactFields(body, ['nodeId', 'publicKey', 'displayName', 'platform'])
          || typeof body.nodeId !== 'string' || typeof body.publicKey !== 'string'
          || typeof body.displayName !== 'string' || body.platform !== 'pwa') {
          throw new Error('browser pairing request body is invalid')
        }
        sendJson(response, 201, correlationId, authority.createClaimableRequest({
          nodeId: body.nodeId,
          publicKey: body.publicKey,
          displayName: body.displayName,
          platform: 'pwa',
        }))
        return
      }
      if (request.method === 'POST' && parts.length === 4 && parts[0] === 'v1'
        && parts[1] === 'pairing' && parts[2] === 'requests' && parts[3] === 'claim') {
        const body = await readJson(request, maxBodyBytes)
        if (!record(body) || !exactFields(body, ['requestId', 'claimToken'])
          || typeof body.requestId !== 'string' || typeof body.claimToken !== 'string') {
          throw new Error('browser pairing claim body is invalid')
        }
        const claim = authority.claim(body.requestId, body.claimToken)
        sendJson(response, claim === undefined ? 202 : 200, correlationId, claim ?? { status: 'pending' })
        return
      }
      const ownerAuthenticated = sameSecret(options.ownerToken, bearerToken(request, 'Bearer'))
      const deviceCredential = bearerToken(request, 'Device')
      const deviceNodeId = deviceCredential === undefined ? undefined : authority.identify(deviceCredential)
      const sessionToken = bearerToken(request, 'Session')
      let sessionPrincipal: SessionPrincipal | undefined = sessionToken === undefined
        ? undefined
        : sessions.authenticate(sessionToken)
      if (sessionPrincipal !== undefined && !authority.isActive(sessionPrincipal.nodeId)) {
        sessions.revokeDevice(sessionPrincipal.nodeId)
        disconnectEventDevice(sessionPrincipal.nodeId, 'device access revoked')
        sessionPrincipal = undefined
      }
      if (parts[0] === 'v1' && parts[1] === 'device-commands') {
        if (!binding.loopback || options.deviceCommandToken === undefined) {
          sendJson(response, 404, correlationId, { error: 'route not found', correlationId })
          return
        }
        if (!isLoopbackAddress(request.socket.remoteAddress)) {
          sendJson(response, 403, correlationId, { error: 'loopback device command required', correlationId })
          return
        }
        if (!sameSecret(options.deviceCommandToken, bearerToken(request, 'DeviceCommand'))) {
          sendJson(response, 401, correlationId, { error: 'device command authentication required', correlationId })
          return
        }
        if (request.method !== 'POST' || parts.length !== 2 || options.deviceApprovals?.requestApproval === undefined) {
          sendJson(response, options.deviceApprovals?.requestApproval === undefined ? 503 : 405, correlationId, {
            error: options.deviceApprovals?.requestApproval === undefined ? 'device approval service is unavailable' : 'method not allowed',
            ...(options.deviceApprovals?.requestApproval === undefined ? { code: 'device_approval_unavailable' } : {}),
            correlationId,
          })
          return
        }
        const body = await readJson(request, maxBodyBytes)
        if (!record(body) || !exactFields(body, [
          'commandId', 'idempotencyKey', 'capability', 'externalEntityId', 'service', 'expectedState', 'serviceData',
        ])) throw new Error('device command body is invalid')
        const command = normalizeHighRiskDeviceCommand(body as unknown as HighRiskDeviceCommand)
        const approval = await options.deviceApprovals.requestApproval(command)
        sendJson(response, 202, correlationId, { approval })
        return
      }
      if (request.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'sessions' && parts[2] === 'refresh') {
        const body = await readJson(request, maxBodyBytes)
        if (!record(body) || typeof body.refreshToken !== 'string') throw new Error('session refresh body is invalid')
        const refreshPrincipal = sessions.identifyRefresh(body.refreshToken)
        if (refreshPrincipal !== undefined) {
          if (!authority.isActive(refreshPrincipal.nodeId)) {
            sessions.revokeDevice(refreshPrincipal.nodeId)
            disconnectEventDevice(refreshPrincipal.nodeId, 'device access revoked')
            sendJson(response, 401, correlationId, { error: 'session device is revoked', code: 'device_revoked', correlationId })
            return
          }
          const identityDecision = identityRateLimiter.consume(`session:${refreshPrincipal.sessionId}`)
          if (!identityDecision.allowed) {
            sendRateLimited(response, correlationId, identityDecision)
            return
          }
        }
        try {
          const refreshed = sessions.refresh(body.refreshToken)
          disconnectEventSession(refreshed.sessionId, 'session access refreshed')
          if (!authority.isActive(refreshed.nodeId)) {
            sessions.revokeDevice(refreshed.nodeId)
            disconnectEventDevice(refreshed.nodeId, 'device access revoked')
            sendJson(response, 401, correlationId, { error: 'session device is revoked', code: 'device_revoked', correlationId })
            return
          }
          sendJson(response, 200, correlationId, refreshed)
        } catch (error) {
          if (!(error instanceof SessionAuthenticationError)) throw error
          revalidateEventSockets()
          const code = error.code === 'reuse' ? 'refresh_reuse_detected' : `refresh_${error.code}`
          sendJson(response, 401, correlationId, { error: 'session refresh rejected', code, correlationId })
        }
        return
      }
      const identityKey = ownerAuthenticated
        ? 'owner'
        : deviceNodeId !== undefined
          ? `device:${deviceNodeId}`
          : sessionPrincipal === undefined
            ? undefined
            : `session:${sessionPrincipal.sessionId}`
      if (identityKey !== undefined) {
        const identityDecision = identityRateLimiter.consume(identityKey)
        if (!identityDecision.allowed) {
          sendRateLimited(response, correlationId, identityDecision)
          return
        }
      }
      if (parts[0] === 'v1' && parts[1] === 'conversations') {
        if (sessionPrincipal === undefined) {
          sendJson(response, 401, correlationId, { error: 'session authentication required', correlationId })
          return
        }
        const query = requestQuery(request)
        if (request.method === 'GET' && parts.length === 2) {
          if ([...query.keys()].length !== 0) throw new Error('conversation list query is invalid')
          sendJson(response, 200, correlationId, { conversations: await harness.listConversations() })
          return
        }
        if (request.method === 'POST' && parts.length === 2) {
          if ([...query.keys()].length !== 0) throw new Error('conversation creation query is invalid')
          const body = await readJson(request, maxBodyBytes)
          if (!record(body) || !exactFields(body, [])) throw new Error('conversation creation body must be empty')
          sendJson(response, 201, correlationId, { conversation: await harness.createConversation() })
          return
        }
        if (request.method === 'GET' && parts.length === 3 && typeof parts[2] === 'string') {
          if ([...query.keys()].some(key => key !== 'beforeSequence' && key !== 'maxMessages')) {
            throw new Error('conversation history query is invalid')
          }
          const beforeSequence = optionalIntegerParameter(query, 'beforeSequence', 0, Number.MAX_SAFE_INTEGER)
          const maxMessages = optionalIntegerParameter(query, 'maxMessages', 1, 100)
          sendJson(response, 200, correlationId, await harness.getConversationHistory(parts[2], beforeSequence, maxMessages))
          return
        }
        if (request.method === 'POST' && parts.length === 4 && parts[3] === 'messages' && typeof parts[2] === 'string') {
          if ([...query.keys()].length !== 0) throw new Error('conversation message query is invalid')
          const body = await readJson(request, maxBodyBytes)
          if (!record(body) || !exactFields(body, ['text', 'mode']) || typeof body.text !== 'string'
            || (body.mode !== undefined && body.mode !== 'queue' && body.mode !== 'steer')) {
            throw new Error('conversation message body is invalid')
          }
          sendJson(response, 202, correlationId, await harness.sendText(parts[2], body.text, body.mode ?? 'queue'))
          return
        }
        if (request.method === 'POST' && parts.length === 4 && parts[3] === 'cancel' && typeof parts[2] === 'string') {
          if ([...query.keys()].length !== 0) throw new Error('conversation cancellation query is invalid')
          const body = await readJson(request, maxBodyBytes)
          if (!record(body) || !exactFields(body, [])) throw new Error('conversation cancellation body must be empty')
          sendJson(response, 200, correlationId, await harness.cancelConversation(parts[2]))
          return
        }
        sendJson(response, 404, correlationId, { error: 'route not found', correlationId })
        return
      }
      if (parts[0] === 'v1' && parts[1] === 'approvals') {
        if (sessionPrincipal === undefined) {
          sendJson(response, 401, correlationId, { error: 'session authentication required', correlationId })
          return
        }
        const query = requestQuery(request)
        if ([...query.keys()].length !== 0) throw new Error('approval query is invalid')
        if (request.method === 'GET' && parts.length === 2) {
          sendJson(response, 200, correlationId, { approvals: harnessEvents.listApprovals() })
          return
        }
        if (request.method === 'POST' && parts.length === 4 && parts[3] === 'decision' && typeof parts[2] === 'string') {
          const body = await readJson(request, maxBodyBytes)
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(parts[2])
            || !record(body) || !exactFields(body, ['digest', 'outcome', 'idempotencyKey'])
            || (body.digest !== null && (typeof body.digest !== 'string' || !/^[0-9a-f]{64}$/.test(body.digest)))
            || (body.outcome !== 'allowed-once' && body.outcome !== 'rejected')
            || typeof body.idempotencyKey !== 'string' || !/^[0-9a-f-]{36}$/.test(body.idempotencyKey)) {
            throw new Error('approval decision body is invalid')
          }
          sendJson(response, 202, correlationId, await harnessEvents.decideApproval(
            parts[2], body.digest, body.outcome, body.idempotencyKey,
          ))
          return
        }
        sendJson(response, 404, correlationId, { error: 'route not found', correlationId })
        return
      }
      if (parts[0] === 'v1' && parts[1] === 'device-approvals') {
        if (sessionPrincipal === undefined) {
          sendJson(response, 401, correlationId, { error: 'session authentication required', correlationId })
          return
        }
        if (options.deviceApprovals === undefined) {
          sendJson(response, 503, correlationId, { error: 'device approval service is unavailable', code: 'device_approval_unavailable', correlationId })
          return
        }
        const query = requestQuery(request)
        if ([...query.keys()].length !== 0) throw new Error('device approval query is invalid')
        if (request.method === 'GET' && parts.length === 2) {
          sendJson(response, 200, correlationId, { approvals: options.deviceApprovals.listApprovals() })
          return
        }
        if (request.method === 'POST' && parts.length === 4 && parts[3] === 'decision' && typeof parts[2] === 'string') {
          const body = await readJson(request, maxBodyBytes)
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(parts[2])
            || !record(body) || !exactFields(body, ['digest', 'outcome', 'idempotencyKey'])
            || typeof body.digest !== 'string' || !/^[0-9a-f]{64}$/.test(body.digest)
            || (body.outcome !== 'allowed-once' && body.outcome !== 'rejected')
            || typeof body.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.idempotencyKey)) {
            throw new Error('device approval decision body is invalid')
          }
          sendJson(response, 202, correlationId, await options.deviceApprovals.decideApproval(
            parts[2], body.digest, body.outcome as DeviceApprovalOutcome, body.idempotencyKey,
          ))
          return
        }
        sendJson(response, 404, correlationId, { error: 'route not found', correlationId })
        return
      }
      if (request.method === 'POST' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'sessions') {
        if (deviceNodeId === undefined) {
          sendJson(response, 401, correlationId, { error: 'device authentication required', correlationId })
          return
        }
        const body = await readJson(request, maxBodyBytes)
        if (!record(body) || typeof body.nodeId !== 'string') throw new Error('session request body is invalid')
        if (body.nodeId !== deviceNodeId) {
          sendJson(response, 401, correlationId, { error: 'device credential is invalid or revoked', correlationId })
          return
        }
        sendJson(response, 201, correlationId, sessions.issue(body.nodeId))
        return
      }
      if (request.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'sessions' && parts[2] === 'current') {
        if (sessionPrincipal === undefined) {
          sendJson(response, 401, correlationId, { error: 'session authentication required', correlationId })
          return
        }
        sendJson(response, 200, correlationId, sessions.get(sessionPrincipal.sessionId))
        return
      }
      if (parts.length === 3 && parts[0] === 'v1' && parts[1] === 'devices' && parts[2] === 'current') {
        if ([...requestQuery(request).keys()].length !== 0) throw new Error('current device query is invalid')
        if (sessionPrincipal === undefined) {
          sendJson(response, 401, correlationId, { error: 'session authentication required', correlationId })
          return
        }
        if (request.method === 'GET') {
          const device = authority.getDevice(sessionPrincipal.nodeId)
          const session = sessions.get(sessionPrincipal.sessionId)
          if (device === undefined || session === undefined || session.revokedAt !== null) {
            sendJson(response, 401, correlationId, { error: 'current device is unavailable', correlationId })
            return
          }
          sendJson(response, 200, correlationId, {
            device,
            session: {
              sessionId: session.sessionId,
              issuedAt: session.issuedAt,
              refreshedAt: session.refreshedAt,
              accessExpiresAt: session.accessExpiresAt,
              refreshExpiresAt: session.refreshExpiresAt,
            },
          })
          return
        }
        if (request.method === 'DELETE') {
          const nodeId = sessionPrincipal.nodeId
          if (!authority.revoke(nodeId)) {
            sendJson(response, 401, correlationId, { error: 'current device is unavailable', correlationId })
            return
          }
          sessions.revokeDevice(nodeId)
          disconnectNode(nodeId, 'device access revoked')
          disconnectEventDevice(nodeId, 'device access revoked')
          sendJson(response, 204, correlationId, {})
          return
        }
        sendJson(response, 405, correlationId, { error: 'method not allowed', correlationId })
        return
      }
      if (parts[0] !== 'v1' || (!ownerAuthenticated && deviceNodeId === undefined && sessionPrincipal === undefined)) {
        sendJson(response, 401, correlationId, { error: 'authentication required', correlationId })
        return
      }
      if (request.method === 'GET' && parts.length === 2 && parts[1] === 'sessions') {
        if (!ownerAuthenticated) {
          sendJson(response, 403, correlationId, { error: 'owner authentication required', correlationId })
          return
        }
        sendJson(response, 200, correlationId, { sessions: sessions.list() })
        return
      }
      if (request.method === 'DELETE' && parts.length === 3 && parts[1] === 'sessions') {
        if (!ownerAuthenticated) {
          sendJson(response, 403, correlationId, { error: 'owner authentication required', correlationId })
          return
        }
        if (!sessions.revokeSession(parts[2] as string)) {
          sendJson(response, 404, correlationId, { error: 'session not found or already revoked', correlationId })
          return
        }
        disconnectEventSession(parts[2] as string, 'session signed out')
        sendJson(response, 204, correlationId, {})
        return
      }
      if (request.method === 'POST' && parts.length === 3 && parts[1] === 'pairing' && parts[2] === 'requests') {
        if (!ownerAuthenticated) {
          sendJson(response, 403, correlationId, { error: 'owner authentication required', correlationId })
          return
        }
        const body = await readJson(request, maxBodyBytes)
        if (!record(body)) throw new Error('pairing request body must be an object')
        const requestValue = authority.createRequest({
          nodeId: body.nodeId as string,
          publicKey: body.publicKey as string,
          displayName: body.displayName as string,
          platform: body.platform as 'macos',
        })
        sendJson(response, 201, correlationId, requestValue)
        return
      }
      if (request.method === 'POST' && parts.length === 4 && parts[1] === 'pairing' && parts[2] === 'requests' && parts[3] === 'confirm') {
        if (!ownerAuthenticated) {
          sendJson(response, 403, correlationId, { error: 'owner authentication required', correlationId })
          return
        }
        const body = await readJson(request, maxBodyBytes)
        if (!record(body) || typeof body.requestId !== 'string' || typeof body.verificationCode !== 'string') {
          throw new Error('pairing confirmation body is invalid')
        }
        sendJson(response, 200, correlationId, authority.confirm(body.requestId, body.verificationCode))
        return
      }
      if (request.method === 'POST' && parts.length === 4 && parts[1] === 'pairing' && parts[2] === 'requests' && parts[3] === 'approve') {
        if (!ownerAuthenticated) {
          sendJson(response, 403, correlationId, { error: 'owner authentication required', correlationId })
          return
        }
        const body = await readJson(request, maxBodyBytes)
        if (!record(body) || !exactFields(body, ['verificationCode']) || typeof body.verificationCode !== 'string') {
          throw new Error('pairing approval body is invalid')
        }
        sendJson(response, 200, correlationId, authority.approveClaimable(body.verificationCode))
        return
      }
      if (parts.length === 3 && parts[1] === 'devices' && typeof parts[2] === 'string') {
        const nodeId = parts[2]
        if (request.method === 'POST' && parts.length === 3 && parts[2] === nodeId) {
          if (deviceNodeId === undefined || deviceCredential === undefined || deviceNodeId !== nodeId) {
            sendJson(response, 401, correlationId, { error: 'device authentication required', correlationId })
            return
          }
          const credential = authority.rotate(nodeId, deviceCredential)
          sendJson(response, 200, correlationId, credential)
          disconnectNode(nodeId, 'device credential rotated')
          return
        }
        if (request.method === 'DELETE' && parts.length === 3 && parts[2] === nodeId) {
          if (!ownerAuthenticated) {
            sendJson(response, 403, correlationId, { error: 'owner authentication required', correlationId })
            return
          }
          if (!authority.isActive(nodeId)) {
            sendJson(response, 404, correlationId, { error: 'device not found or already revoked', correlationId })
            return
          }
          sessions.revokeDevice(nodeId)
          if (!authority.revoke(nodeId)) throw new Error('device revocation failed')
          sendJson(response, 204, correlationId, {})
          disconnectNode(nodeId, 'device access revoked')
          disconnectEventDevice(nodeId, 'device access revoked')
          return
        }
      }
      sendJson(response, 404, correlationId, { error: 'route not found', correlationId })
    } catch (error) {
      if (error instanceof HarnessBridgeError) {
        sendHarnessError(response, correlationId, error)
        return
      }
      if (error instanceof MobileApprovalDecisionError) {
        const statuses = {
          conflict: 409,
          expired: 410,
          mismatch: 409,
          missing: 404,
          protocol: 502,
          unavailable: 503,
          unsupported: 422,
        } as const
        sendJson(response, statuses[error.code], correlationId, {
          error: 'approval decision rejected', code: `approval_${error.code}`, correlationId,
        })
        return
      }
      const message = error instanceof Error ? error.message : 'request failed'
      if (message === 'pairing claim rejected' || message === 'paired device is revoked') {
        sendJson(response, 401, correlationId, {
          error: 'pairing claim rejected', code: 'pairing_claim_rejected', correlationId,
        })
        return
      }
      if (message === 'pairing request has expired') {
        sendJson(response, 410, correlationId, {
          error: 'pairing request expired', code: 'pairing_expired', correlationId,
        })
        return
      }
      if (message === 'pairing request capacity has been reached') {
        sendJson(response, 503, correlationId, {
          error: 'pairing service is at capacity', code: 'pairing_capacity', correlationId,
        })
        return
      }
      const status = message.includes('too large') ? 413 : 400
      sendJson(response, status, correlationId, { error: message, correlationId })
    }
  }

  const handleHarnessAvailability = (available: boolean): void => {
    if (!available) {
      if (harnessAvailable) eventLog.publish({ type: 'sync.required', reason: 'harness_disconnected' })
      harnessAvailable = false
      return
    }
    harnessAvailable = true
    if (!harnessWasAvailable) {
      eventLog.publish({ type: 'sync.required', reason: 'gateway_restarted' })
    }
    harnessWasAvailable = true
  }

  return {
    start(port = 0) {
      if (server !== undefined) return Promise.reject(new Error('gateway is already running'))
      server = tls === undefined
        ? createHttpServer((request, response) => { void handle(request, response) })
        : createHttpsServer({ ...tls, minVersion: 'TLSv1.2' }, (request, response) => { void handle(request, response) })
      nodeSocketServer = new WebSocketServer({ noServer: true, maxPayload: maxBodyBytes })
      eventSocketServer = new WebSocketServer({ noServer: true, maxPayload: maxBodyBytes })
      nodeSocketServer.on('connection', handleNodeConnection)
      eventSocketServer.on('connection', handleEventConnection)
      server.on('upgrade', (request, socket, head) => {
        const correlationId = requestCorrelationId(request)
        const sourceDecision = sourceRateLimiter.consume(sourceKey(request))
        if (!sourceDecision.allowed) {
          rejectUpgrade(socket, 429, {
            ...rateLimitHeaders(sourceDecision),
            'cache-control': 'no-store',
            'x-correlation-id': correlationId,
          })
          return
        }
        const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
        if ([...parsed.searchParams.keys()].length !== 0) {
          rejectUpgrade(socket, 404)
          return
        }
        if (parsed.pathname === NODE_PATH) {
          if (request.headers.origin !== undefined) {
            rejectUpgrade(socket, 403)
            return
          }
          if (nodeSocketServer === undefined || nodeSocketServer.clients.size >= maxNodeConnections) {
            rejectUpgrade(socket, 503)
            return
          }
          nodeSocketServer.handleUpgrade(request, socket, head, upgraded => nodeSocketServer?.emit('connection', upgraded, request))
          return
        }
        if (parsed.pathname === EVENTS_PATH) {
          if (!eventOriginAllowed(request)) {
            rejectUpgrade(socket, 403)
            return
          }
          if (eventSocketServer === undefined || eventSocketServer.clients.size >= maxEventConnections) {
            rejectUpgrade(socket, 503)
            return
          }
          eventSocketServer.handleUpgrade(request, socket, head, upgraded => eventSocketServer?.emit('connection', upgraded, request))
          return
        }
        rejectUpgrade(socket, 404)
      })
      return new Promise<RunningGateway>((resolve, reject) => {
        server?.once('error', reject)
        server?.listen(port, binding.host, () => {
          const address = server?.address()
          if (address === null || typeof address === 'string' || address === undefined) {
            reject(new Error('gateway did not expose a TCP address'))
            return
          }
          const host = binding.host.includes(':') ? `[${binding.host}]` : binding.host
          const protocol = secure ? 'https' : 'http'
          try {
            deviceApprovalUnsubscribe = options.deviceApprovals?.subscribe?.(event => eventLog.publish(event))
            harnessEvents.start({
              onEvent: event => { eventLog.publish(event) },
              onAvailability: handleHarnessAvailability,
            })
          } catch (error) {
            const failedServer = server
            server = undefined
            nodeSocketServer?.close()
            eventSocketServer?.close()
            nodeSocketServer = undefined
            eventSocketServer = undefined
            deviceApprovalUnsubscribe?.()
            deviceApprovalUnsubscribe = undefined
            failedServer?.close()
            reject(error)
            return
          }
          resolve({
            server: server as GatewayServer,
            host: binding.host,
            port: address.port,
            secure,
            origin: `${protocol}://${host}:${address.port}`,
          })
        })
      })
    },
    stop() {
      if (server === undefined) return Promise.resolve()
      const current = server
      const currentNodeSocketServer = nodeSocketServer
      const currentEventSocketServer = eventSocketServer
      server = undefined
      nodeSocketServer = undefined
      eventSocketServer = undefined
      deviceApprovalUnsubscribe?.()
      deviceApprovalUnsubscribe = undefined
      for (const state of connectionStates.values()) clearTimeout(state.handshakeTimer)
      for (const state of eventConnectionStates.values()) {
        clearTimeout(state.handshakeTimer)
        if (state.expiryTimer !== undefined) clearTimeout(state.expiryTimer)
        state.unsubscribe?.()
      }
      for (const socket of currentNodeSocketServer?.clients ?? []) socket.terminate()
      for (const socket of currentEventSocketServer?.clients ?? []) socket.terminate()
      nodeConnections.clear()
      connectionStates.clear()
      eventConnectionStates.clear()
      currentNodeSocketServer?.close()
      currentEventSocketServer?.close()
      const serverClosed = new Promise<void>((resolve, reject) => current.close(error => error === undefined ? resolve() : reject(error)))
      return Promise.all([serverClosed, harnessEvents.stop()]).then(() => undefined)
    },
    connectedNodeIds() {
      return [...nodeConnections.keys()].sort()
    },
    dispatchCommand(command) {
      const socket = nodeConnections.get(command.nodeId)
      const state = socket === undefined ? undefined : connectionStates.get(socket)
      if (socket === undefined || state?.phase !== 'ready') return false
      return sendSocket(socket, { type: 'command.requested', command })
    },
  }
}
