import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { FilePairingStateStore, PairingAuthority } from './pairing.js'

const MAX_BODY_BYTES = 32 * 1024

export interface JarvisGatewayOptions {
  ownerToken: string
  authority?: PairingAuthority
  pairingStatePath?: string
  maxBodyBytes?: number
}

export interface RunningGateway {
  server: Server
  port: number
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

function routeParts(request: IncomingMessage): string[] {
  const parsed = new URL(request.url ?? '/', 'http://127.0.0.1')
  return parsed.pathname.split('/').filter(Boolean)
}

export function createJarvisGateway(options: JarvisGatewayOptions): {
  start(port?: number): Promise<RunningGateway>
  stop(): Promise<void>
} {
  if (options.ownerToken.length < 16) throw new Error('ownerToken must contain at least 16 characters')
  const authority = options.authority ?? new PairingAuthority(
    undefined,
    undefined,
    options.pairingStatePath === undefined ? undefined : new FilePairingStateStore(options.pairingStatePath),
  )
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new RangeError('maxBodyBytes must be positive')
  let server: Server | undefined

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const correlationId = requestCorrelationId(request)
    const parts = routeParts(request)
    try {
      if (request.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'health') {
        sendJson(response, 200, correlationId, { service: 'jarvis-gateway', status: 'ok', scope: 'loopback-only' })
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
          sendJson(response, 200, correlationId, authority.rotate(nodeId, deviceCredential))
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
      server = createServer((request, response) => { void handle(request, response) })
      return new Promise<RunningGateway>((resolve, reject) => {
        server?.once('error', reject)
        server?.listen(port, '127.0.0.1', () => {
          const address = server?.address()
          if (address === null || typeof address === 'string' || address === undefined) {
            reject(new Error('gateway did not expose a TCP address'))
            return
          }
          resolve({ server: server as Server, port: address.port })
        })
      })
    },
    stop() {
      if (server === undefined) return Promise.resolve()
      const current = server
      server = undefined
      return new Promise<void>((resolve, reject) => current.close(error => error === undefined ? resolve() : reject(error)))
    },
  }
}
