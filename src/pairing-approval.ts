const MAX_RESPONSE_BYTES = 32 * 1024

export interface ApprovedBrowserDevice {
  requestId: string
  nodeId: string
  displayName: string
  platform: 'pwa'
  approvedAt: number
  expiresAt: number
}

function loopbackOrigin(value: string): string {
  const url = new URL(value)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.hostname !== '127.0.0.1'
    || url.username !== ''
    || url.password !== ''
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search !== ''
    || url.hash !== '') {
    throw new Error('pairing approval gateway must be an HTTP(S) 127.0.0.1 origin')
  }
  return url.origin
}

function validateOwnerToken(value: string): string {
  if (value.length < 16 || value.length > 4_096 || /[\r\n]/.test(value)) {
    throw new TypeError('ownerToken must be 16 to 4096 characters without line breaks')
  }
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseApproval(value: unknown): ApprovedBrowserDevice {
  if (!record(value)
    || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value.requestId)
    || typeof value.nodeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.nodeId)
    || typeof value.displayName !== 'string' || value.displayName.length < 1 || value.displayName.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.displayName)
    || value.platform !== 'pwa'
    || typeof value.approvedAt !== 'number' || !Number.isFinite(value.approvedAt)
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) {
    throw new Error('Gateway returned an invalid pairing approval')
  }
  return {
    requestId: value.requestId,
    nodeId: value.nodeId,
    displayName: value.displayName,
    platform: 'pwa',
    approvedAt: value.approvedAt,
    expiresAt: value.expiresAt,
  }
}

export class BrowserPairingApprovalCoordinator {
  private readonly origin: string
  private readonly ownerToken: string

  constructor(gatewayUrl: string, ownerToken: string, private readonly fetchValue: typeof fetch = fetch) {
    this.origin = loopbackOrigin(gatewayUrl)
    this.ownerToken = validateOwnerToken(ownerToken)
  }

  async approve(verificationCode: string): Promise<ApprovedBrowserDevice> {
    if (!/^\d{6}$/.test(verificationCode)) throw new Error('verification code must contain exactly six digits')
    const response = await this.fetchValue(new URL('/v1/pairing/requests/approve', this.origin), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.ownerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ verificationCode }),
    })
    const body = await response.text()
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('Gateway response is too large')
    if (!response.ok) throw new Error(`Gateway pairing approval failed with status ${response.status}`)
    try {
      return parseApproval(JSON.parse(body))
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Gateway returned invalid JSON')
      throw error
    }
  }
}
