import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { NODE_PROTOCOL_VERSION, parseNodeRegistration, type NodeRegistration } from './node-capabilities.js'
import type { NodeCommand } from './node-command.js'
import { FilePairingStateStore, PairingAuthority } from './pairing.js'

const MAX_BODY_BYTES = 32 * 1024
const NODE_PATH = '/v1/node'
const NODE_HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_NODE_CONNECTIONS = 128
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

function sendJson(response: ServerResponse, status: number, correlationId: string, value: unknown): void {
  if (status === 204) {
    response.writeHead(status, { 'x-correlation-id': correlationId })
    response.end()
    return
  }
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-correlation-id': correlationId,
  })
  response.end(body)
}

function bearerToken(request: IncomingMessage, scheme: 'Bearer' | 'Device'): string | undefined {
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

function sendSocket(socket: WebSocket, message: Record<string, unknown>): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(message))
  return true
}

function rejectUpgrade(socket: import('node:stream').Duplex, status: 403 | 404 | 503): void {
  const reason = status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Service Unavailable'
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function routeParts(request: IncomingMessage): string[] {
  const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
  return parsed.pathname.split('/').filter(Boolean)
}

function validateBindHost(value: string): { host: string, loopback: boolean } {
  const family = isIP(value)
  const type = family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : undefined
  if (type === undefined || !ALLOWED_BIND_ADDRESSES.check(value, type)) {
    throw new Error('bindHost must be a specific loopback, private, or overlay IP address')
  }
  return { host: value, loopback: value === '127.0.0.1' || value === '::1' }
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
  const authority = options.authority ?? new PairingAuthority(
    undefined,
    undefined,
    options.pairingStatePath === undefined ? undefined : new FilePairingStateStore(options.pairingStatePath),
  )
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
  const binding = validateBindHost(options.bindHost ?? '127.0.0.1')
  const tls = validateTls(options.tls)
  if (!binding.loopback && tls === undefined) throw new Error('TLS is required for non-loopback Gateway binding')
  const secure = tls !== undefined
  const scope = binding.loopback ? 'loopback-only' : 'private-network-only'
  let server: GatewayServer | undefined
  let socketServer: WebSocketServer | undefined
  const nodeConnections = new Map<string, WebSocket>()
  const connectionStates = new Map<WebSocket, NodeConnectionState>()

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

  const handleNodeConnection = (socket: WebSocket): void => {
    const state: NodeConnectionState = {
      phase: 'authenticate',
      correlationId: randomUUID(),
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

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const correlationId = requestCorrelationId(request)
    const parts = routeParts(request)
    try {
      if (request.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'health') {
        sendJson(response, 200, correlationId, {
          service: 'jarvis-gateway',
          status: 'ok',
          scope,
          transport: secure ? 'https' : 'http',
        })
        return
      }
      const ownerAuthenticated = sameSecret(options.ownerToken, bearerToken(request, 'Bearer'))
      const deviceCredential = bearerToken(request, 'Device')
      if (parts[0] !== 'v1' || (!ownerAuthenticated && deviceCredential === undefined)) {
        sendJson(response, 401, correlationId, { error: 'authentication required', correlationId })
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
      if (parts.length === 3 && parts[1] === 'devices' && typeof parts[2] === 'string') {
        const nodeId = parts[2]
        if (request.method === 'POST' && parts.length === 3 && parts[2] === nodeId) {
          if (deviceCredential === undefined) {
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
          if (!authority.revoke(nodeId)) {
            sendJson(response, 404, correlationId, { error: 'device not found or already revoked', correlationId })
            return
          }
          sendJson(response, 204, correlationId, {})
          disconnectNode(nodeId, 'device access revoked')
          return
        }
      }
      sendJson(response, 404, correlationId, { error: 'route not found', correlationId })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request failed'
      const status = message.includes('too large') ? 413 : 400
      sendJson(response, status, correlationId, { error: message, correlationId })
    }
  }

  return {
    start(port = 0) {
      if (server !== undefined) return Promise.reject(new Error('gateway is already running'))
      server = tls === undefined
        ? createHttpServer((request, response) => { void handle(request, response) })
        : createHttpsServer({ ...tls, minVersion: 'TLSv1.2' }, (request, response) => { void handle(request, response) })
      socketServer = new WebSocketServer({ noServer: true, maxPayload: maxBodyBytes })
      socketServer.on('connection', handleNodeConnection)
      server.on('upgrade', (request, socket, head) => {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
        if (path !== NODE_PATH) {
          rejectUpgrade(socket, 404)
          return
        }
        if (request.headers.origin !== undefined) {
          rejectUpgrade(socket, 403)
          return
        }
        if (socketServer === undefined || socketServer.clients.size >= maxNodeConnections) {
          rejectUpgrade(socket, 503)
          return
        }
        socketServer.handleUpgrade(request, socket, head, upgraded => socketServer?.emit('connection', upgraded, request))
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
      const currentSocketServer = socketServer
      server = undefined
      socketServer = undefined
      for (const state of connectionStates.values()) clearTimeout(state.handshakeTimer)
      for (const socket of currentSocketServer?.clients ?? []) socket.terminate()
      nodeConnections.clear()
      connectionStates.clear()
      currentSocketServer?.close()
      return new Promise<void>((resolve, reject) => current.close(error => error === undefined ? resolve() : reject(error)))
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
