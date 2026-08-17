import { validateLoopbackGatewayUrl } from './device-command-client.js'
import { normalizeMqttDeviceCommand, type MqttDeviceCommand, type MqttDeviceCommandResult } from './device-mqtt.js'

export interface MqttCommandGatewayClientOptions {
  url: string
  token: string
  fetchImpl?: typeof fetch
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validResult(value: unknown): value is MqttDeviceCommandResult {
  return record(value)
    && Object.keys(value).every(key => ['commandId', 'idempotencyKey', 'capability', 'state', 'acknowledged', 'observedState', 'error'].includes(key))
    && typeof value.commandId === 'string' && value.commandId.length > 0
    && typeof value.idempotencyKey === 'string' && value.idempotencyKey.length > 0
    && typeof value.capability === 'string' && value.capability.length > 0
    && ['succeeded', 'acknowledged-unconfirmed', 'failed', 'timed-out', 'unavailable', 'expired'].includes(value.state as string)
    && typeof value.acknowledged === 'boolean'
    && (value.observedState === undefined || typeof value.observedState === 'string')
    && (value.error === undefined || typeof value.error === 'string')
}

export class MqttCommandGatewayClient {
  private readonly origin: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(options: MqttCommandGatewayClientOptions) {
    this.origin = validateLoopbackGatewayUrl(options.url)
    if (options.token.length < 16) throw new Error('device Gateway token must contain at least 16 characters')
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async sendCommand(command: MqttDeviceCommand): Promise<MqttDeviceCommandResult> {
    const normalized = normalizeMqttDeviceCommand(command)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.origin}/v1/mqtt-commands`, {
        method: 'POST',
        headers: { authorization: `DeviceCommand ${this.token}`, 'content-type': 'application/json' },
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
    if (!record(body) || !validResult(body.result)) throw new Error('device Gateway returned an invalid response')
    if (body.result.commandId !== normalized.commandId || body.result.idempotencyKey !== normalized.idempotencyKey
      || body.result.capability !== normalized.capability) throw new Error('device Gateway returned an invalid response')
    return body.result
  }
}
