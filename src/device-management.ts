const MAX_RESPONSE_BYTES = 64 * 1024

export interface ManagedDevice {
  nodeId: string
  displayName: string
  platform: 'macos' | 'pwa'
  generation: number
  issuedAt: number
  revoked: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactFields(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).every(key => fields.includes(key)) && fields.every(key => Object.hasOwn(value, key))
}

function validateIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function parseDevice(value: unknown): ManagedDevice {
  if (!record(value) || !exactFields(value, ['nodeId', 'displayName', 'platform', 'generation', 'issuedAt', 'revoked'])
    || !validateIdentifier(value.nodeId)
    || typeof value.displayName !== 'string' || value.displayName.length < 1 || value.displayName.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.displayName)
    || (value.platform !== 'macos' && value.platform !== 'pwa')
    || !Number.isInteger(value.generation) || (value.generation as number) < 1
    || typeof value.issuedAt !== 'number' || !Number.isFinite(value.issuedAt)
    || typeof value.revoked !== 'boolean') {
    throw new Error('Gateway returned an invalid device record')
  }
  return value as unknown as ManagedDevice
}

function loopbackOrigin(value: string): string {
  const url = new URL(value)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname !== '127.0.0.1'
    || url.username !== '' || url.password !== '' || (url.pathname !== '' && url.pathname !== '/')
    || url.search !== '' || url.hash !== '') {
    throw new Error('device management gateway must be an HTTP(S) 127.0.0.1 origin')
  }
  return url.origin
}

function validateOwnerToken(value: string): string {
  if (value.length < 16 || value.length > 4_096 || /[\r\n]/.test(value)) {
    throw new TypeError('ownerToken must be 16 to 4096 characters without line breaks')
  }
  return value
}

export class DeviceManagementClient {
  private readonly origin: string
  private readonly ownerToken: string

  constructor(gatewayUrl: string, ownerToken: string, private readonly fetchValue: typeof fetch = fetch) {
    this.origin = loopbackOrigin(gatewayUrl)
    this.ownerToken = validateOwnerToken(ownerToken)
  }

  async list(): Promise<ManagedDevice[]> {
    const { response, body } = await this.request('/v1/devices', { method: 'GET' })
    if (!response.ok) throw new Error(`Gateway device list failed with status ${response.status}`)
    let value: unknown
    try {
      value = JSON.parse(body)
    } catch {
      throw new Error('Gateway returned invalid JSON')
    }
    if (!record(value) || !exactFields(value, ['devices']) || !Array.isArray(value.devices)) {
      throw new Error('Gateway returned an invalid device list')
    }
    return value.devices.map(parseDevice)
  }

  async revoke(nodeId: string): Promise<void> {
    if (!validateIdentifier(nodeId)) throw new Error('device id contains unsupported characters')
    const { response } = await this.request(`/v1/devices/${encodeURIComponent(nodeId)}`, { method: 'DELETE' })
    if (response.status === 204) return
    if (response.status === 404) throw new Error('device was not found or was already revoked')
    throw new Error(`Gateway device revocation failed with status ${response.status}`)
  }

  private async request(path: string, init: RequestInit): Promise<{ response: Response, body: string }> {
    const response = await this.fetchValue(new URL(path, this.origin), {
      ...init,
      headers: { authorization: `Bearer ${this.ownerToken}` },
    })
    const body = await response.text()
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('Gateway response is too large')
    return { response, body }
  }
}
