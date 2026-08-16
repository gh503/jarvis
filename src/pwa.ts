import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

interface PwaAssetDefinition {
  file: string
  contentType: string
}

interface PwaAsset extends PwaAssetDefinition {
  body: Buffer
}

const APP_PREFIX = '/app/'
const ASSET_DEFINITIONS = new Map<string, PwaAssetDefinition>([
  ['/app/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app/index.html', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app/app.css', { file: 'app.css', contentType: 'text/css; charset=utf-8' }],
  ['/app/app.js', { file: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/app/pairing.js', { file: 'pairing.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/app/manifest.webmanifest', { file: 'manifest.webmanifest', contentType: 'application/manifest+json; charset=utf-8' }],
  ['/app/sw.js', { file: 'sw.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/app/icon.svg', { file: 'icon.svg', contentType: 'image/svg+xml' }],
  ['/app/icon-192.png', { file: 'icon-192.png', contentType: 'image/png' }],
  ['/app/icon-512.png', { file: 'icon-512.png', contentType: 'image/png' }],
  ['/app/apple-touch-icon.png', { file: 'apple-touch-icon.png', contentType: 'image/png' }],
])

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; base-uri 'none'; connect-src 'self' ws: wss:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; manifest-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'",
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
}

function sendEmpty(response: ServerResponse, status: number, correlationId: string, headers: Record<string, string>): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': 0,
    'x-correlation-id': correlationId,
    ...SECURITY_HEADERS,
    ...headers,
  })
  response.end()
}

export class PwaShell {
  private readonly assets: ReadonlyMap<string, PwaAsset>

  constructor(root: string) {
    this.assets = new Map([...ASSET_DEFINITIONS].map(([path, definition]) => [path, {
      ...definition,
      body: readFileSync(join(root, definition.file)),
    }]))
  }

  serve(request: IncomingMessage, response: ServerResponse, correlationId: string): boolean {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname !== '/' && pathname !== '/app' && !pathname.startsWith(APP_PREFIX)) return false
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendEmpty(response, 405, correlationId, { allow: 'GET, HEAD' })
      return true
    }
    if (pathname === '/' || pathname === '/app') {
      sendEmpty(response, 308, correlationId, { location: '/app/' })
      return true
    }
    const asset = this.assets.get(pathname)
    if (asset === undefined) {
      sendEmpty(response, 404, correlationId, {})
      return true
    }
    response.writeHead(200, {
      'cache-control': 'no-cache',
      'content-length': asset.body.byteLength,
      'content-type': asset.contentType,
      'x-correlation-id': correlationId,
      ...SECURITY_HEADERS,
    })
    response.end(request.method === 'HEAD' ? undefined : asset.body)
    return true
  }
}
