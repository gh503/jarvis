import { commandDigest } from './approval.js'

export type MqttDeviceAdapterState = 'stopped' | 'connecting' | 'ready' | 'degraded'
export type MqttDeviceCommandState = 'succeeded' | 'acknowledged-unconfirmed' | 'failed' | 'timed-out' | 'unavailable' | 'expired'

export interface MqttDeviceCommand {
  commandId: string
  idempotencyKey: string
  capability: string
  payload: Readonly<Record<string, unknown>>
  expectedState?: string
}

export interface MqttDeviceCommandResult {
  commandId: string
  idempotencyKey: string
  capability: string
  state: MqttDeviceCommandState
  acknowledged: boolean
  observedState?: string
  error?: string
}

export interface MqttDeviceCommandTransition {
  commandId: string
  idempotencyKey: string
  phase: 'submitted' | 'acknowledged' | MqttDeviceCommandState
  observedState?: string
  error?: string
}

export interface MqttDevicePresence {
  deviceId: string
  available: boolean
  observedAt: number
}

export interface MqttDeviceCapabilities {
  deviceId: string
  capabilities: readonly string[]
}

export interface MqttDeviceReportedState {
  deviceId: string
  externalEntityId: string
  state: string
  sourceTimestamp: number
}

export interface MqttDeviceTransport {
  connect(): Promise<void>
  subscribe(topic: string): Promise<void>
  publish(topic: string, payload: string, options: { qos: 1; retain: false; messageExpiryInterval: number }): Promise<void>
  onMessage(listener: (topic: string, payload: Uint8Array) => void): () => void
  onConnect(listener: () => void): () => void
  onClose(listener: () => void): () => void
  close(): Promise<void>
}

export interface MqttDeviceAdapterOptions {
  deviceId: string
  transport: MqttDeviceTransport
  topicPrefix?: string
  commandTtlMs?: number
  now?: () => number
  onStatus?: (state: MqttDeviceAdapterState) => void
  onPresence?: (presence: MqttDevicePresence) => void
  onCapabilities?: (capabilities: MqttDeviceCapabilities) => void
  onState?: (state: MqttDeviceReportedState) => void
  onCommand?: (transition: MqttDeviceCommandTransition) => void
}

const DEFAULT_TTL_MS = 60_000
const MAX_PAYLOAD_BYTES = 32 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown, field: string, maxLength = 128): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`)
  }
  return value
}

function validateDeviceId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new TypeError('deviceId contains unsupported characters')
  return value
}

function validateTopicPrefix(value: string): string {
  const prefix = requiredText(value, 'topicPrefix', 128).replace(/\/+$/, '')
  if (prefix.includes('+') || prefix.includes('#') || prefix.includes('\u0000')) throw new TypeError('topicPrefix contains MQTT wildcards')
  return prefix
}

function topicParts(prefix: string, deviceId: string, suffix: string): string {
  return `${prefix}/devices/${deviceId}/${suffix}`
}

function commandFingerprint(command: MqttDeviceCommand): string {
  return commandDigest(command)
}

function parseJson(payload: Uint8Array): unknown {
  if (payload.byteLength > MAX_PAYLOAD_BYTES) throw new Error('MQTT payload is too large')
  return JSON.parse(Buffer.from(payload).toString('utf8')) as unknown
}

interface PendingCommand {
  command: MqttDeviceCommand
  result: MqttDeviceCommandResult
  resolve: (result: MqttDeviceCommandResult) => void
  timer: ReturnType<typeof setTimeout>
}

interface StoredOutcome {
  fingerprint: string
  promise: Promise<MqttDeviceCommandResult>
}

export class MqttDeviceAdapter {
  private readonly deviceId: string
  private readonly transport: MqttDeviceTransport
  private readonly topicPrefix: string
  private readonly commandTtlMs: number
  private readonly now: () => number
  private readonly onStatus: ((state: MqttDeviceAdapterState) => void) | undefined
  private readonly onPresence: ((presence: MqttDevicePresence) => void) | undefined
  private readonly onCapabilities: ((capabilities: MqttDeviceCapabilities) => void) | undefined
  private readonly onState: ((state: MqttDeviceReportedState) => void) | undefined
  private readonly onCommand: ((transition: MqttDeviceCommandTransition) => void) | undefined
  private readonly pending = new Map<string, PendingCommand>()
  private readonly outcomes = new Map<string, StoredOutcome>()
  private state: MqttDeviceAdapterState = 'stopped'
  private removeMessageListener: (() => void) | undefined
  private removeConnectListener: (() => void) | undefined
  private removeCloseListener: (() => void) | undefined

  constructor(options: MqttDeviceAdapterOptions) {
    this.deviceId = validateDeviceId(requiredText(options.deviceId, 'deviceId'))
    this.transport = options.transport
    this.topicPrefix = validateTopicPrefix(options.topicPrefix ?? 'jarvis/v1')
    this.commandTtlMs = options.commandTtlMs ?? DEFAULT_TTL_MS
    if (!Number.isInteger(this.commandTtlMs) || this.commandTtlMs < 1 || this.commandTtlMs > 120_000) {
      throw new RangeError('commandTtlMs must be an integer between 1 and 120000')
    }
    this.now = options.now ?? Date.now
    this.onStatus = options.onStatus
    this.onPresence = options.onPresence
    this.onCapabilities = options.onCapabilities
    this.onState = options.onState
    this.onCommand = options.onCommand
  }

  getStatus(): MqttDeviceAdapterState {
    return this.state
  }

  toJSON(): { deviceId: string; topicPrefix: string; state: MqttDeviceAdapterState } {
    return { deviceId: this.deviceId, topicPrefix: this.topicPrefix, state: this.state }
  }

  async start(): Promise<void> {
    if (this.state === 'ready' || this.state === 'connecting') return
    this.state = 'connecting'
    this.notifyStatus()
    this.removeMessageListener?.()
    this.removeConnectListener?.()
    this.removeCloseListener?.()
    this.removeMessageListener = this.transport.onMessage((topic, payload) => this.receive(topic, payload))
    this.removeConnectListener = this.transport.onConnect(() => {
      if (this.state === 'degraded') void this.resubscribe()
    })
    this.removeCloseListener = this.transport.onClose(() => this.handleClose())
    try {
      await this.transport.connect()
      for (const suffix of ['presence', 'capabilities', 'state/reported', 'acks', 'results']) {
        await this.transport.subscribe(topicParts(this.topicPrefix, this.deviceId, suffix))
      }
      this.state = 'ready'
      this.notifyStatus()
    } catch (error) {
      this.state = 'degraded'
      this.notifyStatus()
      throw error
    }
  }

  async stop(): Promise<void> {
    this.removeMessageListener?.()
    this.removeConnectListener?.()
    this.removeCloseListener?.()
    this.removeMessageListener = undefined
    this.removeConnectListener = undefined
    this.removeCloseListener = undefined
    for (const pending of [...this.pending.values()]) this.finish(pending, 'unavailable', false, undefined, 'MQTT adapter stopped')
    this.state = 'stopped'
    this.notifyStatus()
    await this.transport.close()
  }

  sendCommand(command: MqttDeviceCommand): Promise<MqttDeviceCommandResult> {
    const normalized = this.normalizeCommand(command)
    const fingerprint = commandFingerprint(normalized)
    const existing = this.outcomes.get(normalized.idempotencyKey)
    if (existing !== undefined) {
      if (existing.fingerprint === fingerprint) return existing.promise
      return this.immediateResult(normalized, 'failed', false, 'idempotency key was reused for a different command')
    }
    const expiresAt = this.now() + this.commandTtlMs
    if (expiresAt <= this.now()) return this.immediateResult(normalized, 'expired', false, 'MQTT command expired before publish')
    if (this.state !== 'ready') return this.immediateResult(normalized, 'unavailable', false, 'MQTT adapter is not ready')
    let resolveResult!: (result: MqttDeviceCommandResult) => void
    const promise = new Promise<MqttDeviceCommandResult>(resolve => { resolveResult = resolve })
    this.outcomes.set(normalized.idempotencyKey, { fingerprint, promise })
    const pending: PendingCommand = {
      command: normalized,
      result: { commandId: normalized.commandId, idempotencyKey: normalized.idempotencyKey, capability: normalized.capability, state: 'timed-out', acknowledged: false },
      resolve: resolveResult,
      timer: setTimeout(() => this.finish(pending, 'expired', false, undefined, 'MQTT command expired'), this.commandTtlMs),
    }
    this.pending.set(normalized.idempotencyKey, pending)
    void this.transport.publish(topicParts(this.topicPrefix, this.deviceId, 'commands'), JSON.stringify({
        version: 1,
        ...normalized,
        expiresAt,
      }), { qos: 1, retain: false, messageExpiryInterval: Math.ceil(this.commandTtlMs / 1_000) }).then(() => {
      this.emitCommand(normalized, 'submitted')
    }).catch(() => {
      this.finish(pending, 'unavailable', false, undefined, 'MQTT command publish failed')
    })
    return promise
  }

  private normalizeCommand(command: MqttDeviceCommand): MqttDeviceCommand {
    if (!isRecord(command)) throw new TypeError('MQTT command must be an object')
    const commandId = requiredText(command.commandId, 'commandId')
    const idempotencyKey = requiredText(command.idempotencyKey, 'idempotencyKey')
    const capability = requiredText(command.capability, 'capability')
    if (!isRecord(command.payload)) throw new TypeError('MQTT command payload must be an object')
    const expectedState = command.expectedState === undefined ? undefined : requiredText(command.expectedState, 'expectedState')
    return { commandId, idempotencyKey, capability, payload: command.payload, ...(expectedState === undefined ? {} : { expectedState }) }
  }

  private receive(topic: string, payload: Uint8Array): void {
    const base = `${this.topicPrefix}/devices/${this.deviceId}/`
    if (!topic.startsWith(base)) return
    const suffix = topic.slice(base.length)
    try {
      const value = parseJson(payload)
      if (suffix === 'presence') this.receivePresence(value)
      else if (suffix === 'capabilities') this.receiveCapabilities(value)
      else if (suffix === 'state/reported') this.receiveState(value)
      else if (suffix === 'acks') this.receiveAck(value)
      else if (suffix === 'results') this.receiveResult(value)
    } catch {
      this.state = 'degraded'
      this.notifyStatus()
    }
  }

  private receivePresence(value: unknown): void {
    if (!isRecord(value) || value.version !== 1 || value.deviceId !== this.deviceId || typeof value.available !== 'boolean'
      || typeof value.observedAt !== 'number' || !Number.isFinite(value.observedAt)) throw new Error('MQTT presence is invalid')
    this.onPresence?.({ deviceId: this.deviceId, available: value.available, observedAt: value.observedAt })
  }

  private receiveCapabilities(value: unknown): void {
    if (!isRecord(value) || value.version !== 1 || value.deviceId !== this.deviceId || !Array.isArray(value.capabilities)
      || value.capabilities.some(capability => typeof capability !== 'string' || capability.length < 1 || capability.length > 128)) throw new Error('MQTT capabilities are invalid')
    const capabilities = [...new Set(value.capabilities)].sort((left, right) => left.localeCompare(right))
    this.onCapabilities?.({ deviceId: this.deviceId, capabilities })
  }

  private receiveState(value: unknown): void {
    if (!isRecord(value) || value.version !== 1 || value.deviceId !== this.deviceId
      || typeof value.externalEntityId !== 'string' || value.externalEntityId.length < 1 || value.externalEntityId.length > 256
      || typeof value.state !== 'string' || value.state.length < 1 || value.state.length > 128
      || typeof value.sourceTimestamp !== 'number' || !Number.isFinite(value.sourceTimestamp)) throw new Error('MQTT reported state is invalid')
    this.onState?.({ deviceId: this.deviceId, externalEntityId: value.externalEntityId, state: value.state, sourceTimestamp: value.sourceTimestamp })
  }

  private receiveAck(value: unknown): void {
    if (!isRecord(value) || value.version !== 1 || typeof value.idempotencyKey !== 'string' || typeof value.accepted !== 'boolean') throw new Error('MQTT acknowledgement is invalid')
    const pending = this.pending.get(value.idempotencyKey)
    if (pending === undefined) return
    if (!value.accepted) {
      this.finish(pending, 'failed', false, undefined, 'MQTT device rejected the command')
      return
    }
    pending.result.acknowledged = true
    this.emitCommand(pending.command, 'acknowledged')
  }

  private receiveResult(value: unknown): void {
    if (!isRecord(value) || value.version !== 1 || typeof value.commandId !== 'string' || typeof value.idempotencyKey !== 'string'
      || typeof value.state !== 'string' || !['succeeded', 'acknowledged-unconfirmed', 'failed', 'timed-out', 'unavailable', 'expired'].includes(value.state)
      || typeof value.acknowledged !== 'boolean') throw new Error('MQTT result is invalid')
    const pending = this.pending.get(value.idempotencyKey)
    if (pending === undefined) return
    if (value.commandId !== pending.command.commandId) throw new Error('MQTT result command does not match the pending command')
    if (value.state === 'succeeded' && !value.acknowledged) throw new Error('MQTT success lacks acknowledgement')
    const observedState = value.observedState === undefined ? undefined : requiredText(value.observedState, 'observedState')
    const error = value.error === undefined ? undefined : requiredText(value.error, 'error', 512)
    this.finish(pending, value.state as MqttDeviceCommandState, value.acknowledged, observedState, error)
  }

  private finish(pending: PendingCommand, state: MqttDeviceCommandState, acknowledged: boolean, observedState?: string, error?: string): void {
    if (!this.pending.has(pending.command.idempotencyKey)) return
    clearTimeout(pending.timer)
    this.pending.delete(pending.command.idempotencyKey)
    const result: MqttDeviceCommandResult = {
      commandId: pending.command.commandId,
      idempotencyKey: pending.command.idempotencyKey,
      capability: pending.command.capability,
      state,
      acknowledged,
      ...(observedState === undefined ? {} : { observedState }),
      ...(error === undefined ? {} : { error }),
    }
    pending.result = result
    this.emitCommand(pending.command, state, observedState, error)
    pending.resolve(result)
  }

  private immediateResult(command: MqttDeviceCommand, state: MqttDeviceCommandState, acknowledged: boolean, error: string): Promise<MqttDeviceCommandResult> {
    const result = { commandId: command.commandId, idempotencyKey: command.idempotencyKey, capability: command.capability, state, acknowledged, error }
    const promise = Promise.resolve(result)
    this.outcomes.set(command.idempotencyKey, { fingerprint: commandFingerprint(command), promise })
    this.emitCommand(command, state, undefined, error)
    return promise
  }

  private handleClose(): void {
    if (this.state === 'stopped') return
    for (const pending of [...this.pending.values()]) this.finish(pending, 'unavailable', false, undefined, 'MQTT connection became unavailable')
    this.state = 'degraded'
    this.notifyStatus()
  }

  private async resubscribe(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'connecting') return
    this.state = 'connecting'
    this.notifyStatus()
    try {
      for (const suffix of ['presence', 'capabilities', 'state/reported', 'acks', 'results']) {
        await this.transport.subscribe(topicParts(this.topicPrefix, this.deviceId, suffix))
      }
      this.state = 'ready'
      this.notifyStatus()
    } catch {
      this.state = 'degraded'
      this.notifyStatus()
    }
  }

  private emitCommand(command: MqttDeviceCommand, phase: 'submitted' | 'acknowledged' | MqttDeviceCommandState, observedState?: string, error?: string): void {
    this.onCommand?.({ commandId: command.commandId, idempotencyKey: command.idempotencyKey, phase,
      ...(observedState === undefined ? {} : { observedState }), ...(error === undefined ? {} : { error }) })
  }

  private notifyStatus(): void {
    this.onStatus?.(this.state)
  }
}
