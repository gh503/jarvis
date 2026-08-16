import { isIP } from 'node:net'
import { normalizeHighRiskDeviceCommand, type DeviceApprovalRequest, type HighRiskDeviceCommand } from './device-approval.js'

export interface DeviceCommandGatewayClientOptions {
  url: string
  token: string
  fetchImpl?: typeof fetch
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('device Gateway URL is invalid')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('device Gateway URL must use HTTP(S) without embedded credentials')
  }
  const hostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname
  if (isIP(hostname) === 0 || (hostname !== '127.0.0.1' && hostname !== '::1')) {
    throw new TypeError('device Gateway URL must target loopback')
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') throw new TypeError('device Gateway URL must not contain a path or query')
  return parsed.origin
}

function validApproval(value: unknown): value is DeviceApprovalRequest {
  return record(value) && Object.keys(value).every(key => [
    'approvalId', 'capability', 'externalEntityId', 'service', 'expectedState', 'digest', 'risk', 'expiresAt',
  ].includes(key))
    && typeof value.approvalId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.approvalId)
    && (value.capability === 'lock.set' || value.capability === 'alarm.set')
    && typeof value.externalEntityId === 'string' && value.externalEntityId.length > 0
    && typeof value.service === 'string' && value.service.length > 0
    && typeof value.expectedState === 'string' && value.expectedState.length > 0
    && typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest)
    && value.risk === 'high' && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
}

export class DeviceCommandGatewayClient {
  private readonly origin: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(options: DeviceCommandGatewayClientOptions) {
    this.origin = validateUrl(options.url)
    if (options.token.length < 16) throw new Error('device Gateway token must contain at least 16 characters')
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async requestApproval(command: HighRiskDeviceCommand): Promise<DeviceApprovalRequest> {
    const normalized = normalizeHighRiskDeviceCommand(command)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.origin}/v1/device-commands`, {
        method: 'POST',
        headers: {
          authorization: `DeviceCommand ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(normalized),
      })
    } catch {
      throw new Error('device Gateway is unavailable')
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error('device Gateway returned an invalid response')
    }
    if (!response.ok) throw new Error(`device Gateway rejected the command (${response.status})`)
    if (!record(body) || !validApproval(body.approval)) throw new Error('device Gateway returned an invalid response')
    return body.approval
  }
}
