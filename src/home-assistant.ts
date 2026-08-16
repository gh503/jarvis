import type { DeviceState, DeviceSource, DiscoveredDevice } from './device-registry.js'
import { commandDigest } from './approval.js'
import { deviceApprovalDigest, type DeviceApprovalAuthorization, type HighRiskDeviceCommand } from './device-approval.js'

export type HomeAssistantAdapterState = 'stopped' | 'connecting' | 'syncing' | 'ready' | 'degraded'
export type HomeAssistantCommandState = 'succeeded' | 'acknowledged-unconfirmed' | 'failed' | 'timed-out' | 'unavailable'
export type HomeAssistantCommandPhase = 'submitted' | 'acknowledged' | HomeAssistantCommandState

export interface HomeAssistantServiceCommand {
  commandId: string
  idempotencyKey: string
  capability: 'switch.set' | 'light.set' | 'media.play_pause'
  externalEntityId: string
  service: string
  serviceData?: Readonly<Record<string, unknown>>
  expectedState: string
  timeoutMs: number
}

export interface HomeAssistantApprovedServiceCommand extends HighRiskDeviceCommand {
  timeoutMs: number
}

export type HomeAssistantDispatchCommand = HomeAssistantServiceCommand | HomeAssistantApprovedServiceCommand
export type HomeAssistantCapability = HomeAssistantDispatchCommand['capability']

export interface HomeAssistantCommandResult {
  commandId: string
  idempotencyKey: string
  capability: HomeAssistantCapability
  state: HomeAssistantCommandState
  acknowledged: boolean
  observedState?: string
  error?: string
}

export interface HomeAssistantCommandTransition {
  commandId: string
  idempotencyKey: string
  phase: HomeAssistantCommandPhase
  observedState?: string
  error?: string
}

export interface HomeAssistantSocketMessage {
  data: string
}

export interface HomeAssistantSocket {
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: HomeAssistantSocketMessage) => void): void
  send(data: string): void
  close(): void
}

export type HomeAssistantSocketFactory = (url: string) => HomeAssistantSocket

export interface HomeAssistantTimers {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface HomeAssistantAdapterOptions {
  url: string
  accessToken: string
  socketFactory: HomeAssistantSocketFactory
  onSnapshot: (devices: readonly DiscoveredDevice[]) => void
  onState: (source: DeviceSource, externalEntityId: string, state: DeviceState) => void
  onUnavailable?: (source: DeviceSource, externalEntityId: string) => void
  onStatus?: (state: HomeAssistantAdapterState) => void
  onCommand?: (transition: HomeAssistantCommandTransition) => void
  now?: () => number
  timers?: HomeAssistantTimers
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}

const DEFAULT_RECONNECT_BASE_MS = 500
const DEFAULT_RECONNECT_MAX_MS = 30_000
const SOURCE_ADAPTER = 'home-assistant'
const SOCKET_PROTOCOLS = new Set(['ws:', 'wss:'])
const ENTITY_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  sensor: 'sensor.read',
  switch: 'switch.set',
  light: 'light.set',
  climate: 'climate.set_target',
  media_player: 'media.play_pause',
  cover: 'cover.set',
  lock: 'lock.set',
  alarm_control_panel: 'alarm.set',
})
const LOW_RISK_SERVICES: Readonly<Record<HomeAssistantServiceCommand['capability'], readonly string[]>> = Object.freeze({
  'switch.set': ['turn_on', 'turn_off'],
  'light.set': ['turn_on', 'turn_off'],
  'media.play_pause': ['media_play', 'media_pause'],
})
const HIGH_RISK_SERVICES: Readonly<Record<HomeAssistantApprovedServiceCommand['capability'], readonly string[]>> = Object.freeze({
  'lock.set': ['lock', 'unlock'],
  'alarm.set': ['alarm_arm_home', 'alarm_arm_away', 'alarm_arm_night', 'alarm_arm_custom_bypass', 'alarm_disarm'],
})

type WireRecord = Record<string, unknown>

interface KnownEntity {
  capability: string
  sourceTimestamp: number
  state: string
}

interface PendingCommand {
  command: HomeAssistantDispatchCommand
  requestId: number
  resolve: (result: HomeAssistantCommandResult) => void
  acknowledged: boolean
  timer: unknown
}

function isRecord(value: unknown): value is WireRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`)
  }
  return value
}

function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'string') throw new TypeError(`${field} must be an ISO timestamp`)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new TypeError(`${field} must be a valid ISO timestamp`)
  return timestamp
}

function entityDomain(entityId: string): string {
  const separator = entityId.indexOf('.')
  if (separator < 1 || separator === entityId.length - 1) throw new TypeError('entity_id is malformed')
  return entityId.slice(0, separator)
}

function parseEntityState(value: unknown): { entityId: string; state: DeviceState; name: string; location: string; capability: string } {
  if (!isRecord(value)) throw new TypeError('Home Assistant state must be an object')
  const entityId = requiredText(value.entity_id, 'entity_id', 256)
  const capability = ENTITY_CAPABILITIES[entityDomain(entityId)]
  if (capability === undefined) throw new Error(`unsupported Home Assistant entity domain: ${entityDomain(entityId)}`)
  const stateValue = requiredText(value.state, 'state', 128)
  const attributes = isRecord(value.attributes) ? value.attributes : {}
  const friendlyName = typeof attributes.friendly_name === 'string' && attributes.friendly_name.trim() === attributes.friendly_name
    ? attributes.friendly_name
    : entityId
  const areaName = typeof attributes.area_name === 'string' && attributes.area_name.trim() === attributes.area_name
    ? attributes.area_name
    : 'unknown'
  const timestampValue = value.last_updated ?? value.last_changed
  return {
    entityId,
    name: requiredText(friendlyName, 'friendly_name'),
    location: requiredText(areaName, 'area_name'),
    capability,
    state: { value: stateValue, sourceTimestamp: parseTimestamp(timestampValue, 'state timestamp') },
  }
}

function normalizedSnapshot(result: unknown, instance: string): readonly DiscoveredDevice[] {
  if (!Array.isArray(result)) throw new TypeError('Home Assistant get_states result must be an array')
  const devices = result.flatMap(state => {
    try {
      const parsed = parseEntityState(state)
      return [{
        externalEntityId: parsed.entityId,
        name: parsed.name,
        location: parsed.location,
        source: { adapter: SOURCE_ADAPTER, instance },
        capabilities: [parsed.capability],
        reportedState: parsed.state,
      } satisfies DiscoveredDevice]
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('unsupported Home Assistant entity domain:')) return []
      throw error
    }
  })
  devices.sort((left, right) => left.externalEntityId.localeCompare(right.externalEntityId))
  for (let index = 1; index < devices.length; index += 1) {
    if (devices[index - 1]?.externalEntityId === devices[index]?.externalEntityId) throw new Error('duplicate Home Assistant entity_id')
  }
  return devices
}

function validateUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('Home Assistant URL is invalid')
  }
  if (!SOCKET_PROTOCOLS.has(parsed.protocol) || parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('Home Assistant URL must be ws/wss without embedded credentials')
  }
  return parsed.toString()
}

function validateBackoff(value: number | undefined, field: string, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < 1 || result > 300_000) throw new RangeError(`${field} must be an integer between 1 and 300000`)
  return result
}

export class HomeAssistantAdapter {
  private readonly url: string
  private readonly accessToken: string
  private readonly socketFactory: HomeAssistantSocketFactory
  private readonly onSnapshot: (devices: readonly DiscoveredDevice[]) => void
  private readonly onState: (source: DeviceSource, externalEntityId: string, state: DeviceState) => void
  private readonly onUnavailable: ((source: DeviceSource, externalEntityId: string) => void) | undefined
  private readonly onStatus: ((state: HomeAssistantAdapterState) => void) | undefined
  private readonly onCommand: ((transition: HomeAssistantCommandTransition) => void) | undefined
  private readonly timers: HomeAssistantTimers
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly now: () => number
  private readonly instance: string
  private socket: HomeAssistantSocket | undefined
  private reconnectHandle: unknown
  private nextRequestId = 1
  private expectedSubscriptionId: number | undefined
  private pendingSnapshotId: number | undefined
  private state: HomeAssistantAdapterState = 'stopped'
  private reconnectAttempt = 0
  private knownEntities = new Map<string, KnownEntity>()
  private readonly pendingCommands = new Map<number, PendingCommand>()
  private readonly commandOutcomes = new Map<string, { fingerprint: string; promise: Promise<HomeAssistantCommandResult> }>()
  private readonly consumedApprovalIds = new Set<string>()

  constructor(options: HomeAssistantAdapterOptions) {
    this.url = validateUrl(options.url)
    this.accessToken = requiredText(options.accessToken, 'accessToken', 4096)
    this.socketFactory = options.socketFactory
    this.onSnapshot = options.onSnapshot
    this.onState = options.onState
    this.onUnavailable = options.onUnavailable
    this.onStatus = options.onStatus
    this.onCommand = options.onCommand
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }
    this.reconnectBaseMs = validateBackoff(options.reconnectBaseMs, 'reconnectBaseMs', DEFAULT_RECONNECT_BASE_MS)
    this.reconnectMaxMs = validateBackoff(options.reconnectMaxMs, 'reconnectMaxMs', DEFAULT_RECONNECT_MAX_MS)
    if (this.reconnectBaseMs > this.reconnectMaxMs) throw new RangeError('reconnectBaseMs cannot exceed reconnectMaxMs')
    this.instance = new URL(this.url).host
  }

  getStatus(): HomeAssistantAdapterState {
    return this.state
  }

  toJSON(): { url: string; instance: string; state: HomeAssistantAdapterState } {
    return { url: this.url, instance: this.instance, state: this.state }
  }

  start(): void {
    if (this.state !== 'stopped' && this.state !== 'degraded') return
    this.clearReconnect()
    this.connect()
  }

  stop(): void {
    this.clearReconnect()
    this.state = 'stopped'
    this.notifyStatus()
    const socket = this.socket
    this.socket = undefined
    this.failPendingCommands('unavailable', 'Home Assistant adapter stopped')
    socket?.close()
  }

  callService(command: HomeAssistantServiceCommand): Promise<HomeAssistantCommandResult> {
    const normalized = this.validateCommand(command)
    return this.dispatchService(normalized)
  }

  callApprovedService(
    command: HomeAssistantApprovedServiceCommand,
    authorization: DeviceApprovalAuthorization,
  ): Promise<HomeAssistantCommandResult> {
    const normalized = this.validateApprovedCommand(command)
    const fingerprint = this.commandFingerprint(normalized)
    const existing = this.commandOutcomes.get(normalized.idempotencyKey)
    if (existing !== undefined) {
      if (existing.fingerprint === fingerprint) return existing.promise
      return Promise.resolve(this.finalResult(normalized, 'failed', false, undefined, 'idempotency key was reused for a different command'))
    }
    if (!this.validAuthorization(authorization) || authorization.expiresAt <= this.now()) {
      return Promise.resolve(this.finalResult(normalized, 'failed', false, undefined, 'device approval authorization is invalid or expired'))
    }
    const approvalCommand: HighRiskDeviceCommand = {
      commandId: normalized.commandId,
      idempotencyKey: normalized.idempotencyKey,
      capability: normalized.capability,
      externalEntityId: normalized.externalEntityId,
      service: normalized.service,
      expectedState: normalized.expectedState,
      ...(normalized.serviceData === undefined ? {} : { serviceData: normalized.serviceData }),
    }
    if (authorization.digest !== deviceApprovalDigest(approvalCommand)) {
      return Promise.resolve(this.finalResult(normalized, 'failed', false, undefined, 'device approval authorization does not match the command'))
    }
    if (this.consumedApprovalIds.has(authorization.approvalId)) {
      return Promise.resolve(this.finalResult(normalized, 'failed', false, undefined, 'device approval authorization has already been consumed'))
    }
    this.consumedApprovalIds.add(authorization.approvalId)
    return this.dispatchService(normalized)
  }

  private dispatchService(normalized: HomeAssistantDispatchCommand): Promise<HomeAssistantCommandResult> {
    const fingerprint = this.commandFingerprint(normalized)
    const existing = this.commandOutcomes.get(normalized.idempotencyKey)
    if (existing !== undefined) {
      if (existing.fingerprint === fingerprint) return existing.promise
      return Promise.resolve(this.finalResult(normalized, 'failed', false, undefined, 'idempotency key was reused for a different command'))
    }
    if (this.state !== 'ready' || this.socket === undefined) {
      const result = this.finalResult(normalized, 'unavailable', false, undefined, 'Home Assistant adapter is not ready')
      const promise = Promise.resolve(result)
      this.commandOutcomes.set(normalized.idempotencyKey, { fingerprint, promise })
      return promise
    }
    const knownEntity = this.knownEntities.get(normalized.externalEntityId)
    if (knownEntity === undefined) {
      const result = this.finalResult(normalized, 'unavailable', false, undefined, 'Home Assistant entity is not currently available')
      const promise = Promise.resolve(result)
      this.commandOutcomes.set(normalized.idempotencyKey, { fingerprint, promise })
      return promise
    }
    if (knownEntity.capability !== normalized.capability) {
      const result = this.finalResult(normalized, 'failed', false, undefined, 'command capability does not match the registered entity')
      const promise = Promise.resolve(result)
      this.commandOutcomes.set(normalized.idempotencyKey, { fingerprint, promise })
      return promise
    }
    let resolveResult!: (result: HomeAssistantCommandResult) => void
    const promise = new Promise<HomeAssistantCommandResult>(resolve => { resolveResult = resolve })
    this.commandOutcomes.set(normalized.idempotencyKey, { fingerprint, promise })
    const requestId = this.send({
      type: 'call_service',
      domain: entityDomain(normalized.externalEntityId),
      service: normalized.service,
      service_data: normalized.serviceData ?? {},
      target: { entity_id: normalized.externalEntityId },
    })
    const timer = this.timers.setTimeout(() => {
      const pending = this.pendingCommands.get(requestId)
      if (pending === undefined) return
      this.finishCommand(pending, pending.acknowledged ? 'acknowledged-unconfirmed' : 'timed-out', pending.acknowledged ? undefined : 'Home Assistant service acknowledgement timed out')
    }, normalized.timeoutMs)
    this.pendingCommands.set(requestId, { command: normalized, requestId, resolve: resolveResult, acknowledged: false, timer })
    this.emitCommand(normalized, 'submitted')
    const currentState = this.knownEntities.get(normalized.externalEntityId)?.state
    if (currentState === normalized.expectedState) this.emitCommand(normalized, 'submitted', currentState)
    return promise
  }

  private connect(): void {
    this.state = 'connecting'
    this.notifyStatus()
    this.resetConnectionState()
    const socket = this.socketFactory(this.url)
    this.socket = socket
    socket.addEventListener('open', () => {})
    socket.addEventListener('message', event => {
      if (this.socket === socket) this.receive(event.data)
    })
    socket.addEventListener('close', () => this.handleDisconnect(socket))
    socket.addEventListener('error', () => this.handleDisconnect(socket))
  }

  private resetConnectionState(): void {
    this.nextRequestId = 1
    this.expectedSubscriptionId = undefined
    this.pendingSnapshotId = undefined
    this.knownEntities.clear()
  }

  private receive(data: string): void {
    let message: unknown
    try {
      message = JSON.parse(data)
    } catch {
      this.protocolFailure('Home Assistant sent malformed JSON')
      return
    }
    if (!isRecord(message) || typeof message.type !== 'string') {
      this.protocolFailure('Home Assistant sent a malformed frame')
      return
    }
    if (message.type === 'auth_required') {
      this.sendAuth()
      return
    }
    if (message.type === 'auth_ok') {
      this.state = 'syncing'
      this.notifyStatus()
      this.pendingSnapshotId = this.send({ type: 'get_states' })
      return
    }
    if (message.type === 'auth_invalid') {
      this.protocolFailure('Home Assistant rejected authentication')
      return
    }
    if (message.type === 'result') {
      this.receiveResult(message)
      return
    }
    if (message.type === 'event') {
      this.receiveEvent(message)
      return
    }
    this.protocolFailure(`unsupported Home Assistant frame type: ${message.type}`)
  }

  private receiveResult(message: WireRecord): void {
    if (typeof message.id !== 'number' || !Number.isInteger(message.id) || typeof message.success !== 'boolean') {
      this.protocolFailure('Home Assistant result correlation is malformed')
      return
    }
    if (message.id === this.pendingSnapshotId) {
      if (!message.success) {
        this.protocolFailure('Home Assistant get_states failed')
        return
      }
      try {
        const snapshot = normalizedSnapshot(message.result, this.instance)
        this.knownEntities = new Map(snapshot.map(device => [device.externalEntityId, {
          capability: device.capabilities[0] ?? 'unknown',
          sourceTimestamp: device.reportedState?.sourceTimestamp ?? 0,
          state: typeof device.reportedState?.value === 'string' ? device.reportedState.value : '',
        }]))
        this.onSnapshot(snapshot)
      } catch (error) {
        this.protocolFailure(error instanceof Error ? error.message : 'Home Assistant snapshot is invalid')
        return
      }
      this.pendingSnapshotId = undefined
      this.expectedSubscriptionId = this.send({ type: 'subscribe_events', event_type: 'state_changed' })
      return
    }
    if (message.id === this.expectedSubscriptionId) {
      if (!message.success) {
        this.protocolFailure('Home Assistant state subscription failed')
        return
      }
      this.reconnectAttempt = 0
      this.state = 'ready'
      this.notifyStatus()
      return
    }
    const pending = this.pendingCommands.get(message.id)
    if (pending !== undefined) {
      this.receiveCommandResult(message, pending)
      return
    }
    this.protocolFailure('unexpected Home Assistant response id')
  }

  private receiveCommandResult(message: WireRecord, pending: PendingCommand): void {
    if (!message.success) {
      this.finishCommand(pending, 'failed', 'Home Assistant rejected the service call')
      return
    }
    pending.acknowledged = true
    this.emitCommand(pending.command, 'acknowledged')
    const observedState = this.knownEntities.get(pending.command.externalEntityId)?.state
    if (observedState === pending.command.expectedState) {
      this.finishCommand(pending, 'succeeded', undefined, observedState)
    }
  }

  private receiveEvent(message: WireRecord): void {
    if (message.id !== this.expectedSubscriptionId || !isRecord(message.event)) return
    if (message.event.event_type !== 'state_changed' || !isRecord(message.event.data)) return
    try {
      const data = message.event.data
      const entityId = requiredText(data.entity_id, 'event.entity_id', 256)
      if (!this.knownEntities.has(entityId)) return
      if (data.new_state === null) {
        this.knownEntities.delete(entityId)
        this.onUnavailable?.({ adapter: SOURCE_ADAPTER, instance: this.instance }, entityId)
        for (const pending of this.pendingCommands.values()) {
          if (pending.command.externalEntityId === entityId) this.finishCommand(pending, 'unavailable', 'Home Assistant entity disappeared')
        }
        return
      }
      if (!isRecord(data.new_state)) return
      const parsed = parseEntityState(data.new_state)
      const previous = this.knownEntities.get(entityId)
      if (previous === undefined || parsed.state.sourceTimestamp < previous.sourceTimestamp) return
      this.knownEntities.set(entityId, { ...previous, sourceTimestamp: parsed.state.sourceTimestamp, state: String(parsed.state.value) })
      this.onState({ adapter: SOURCE_ADAPTER, instance: this.instance }, entityId, parsed.state)
      for (const pending of this.pendingCommands.values()) {
        if (pending.command.externalEntityId === entityId && String(parsed.state.value) === pending.command.expectedState && pending.acknowledged) {
          this.finishCommand(pending, 'succeeded', undefined, String(parsed.state.value))
        }
      }
    } catch {
      this.protocolFailure('Home Assistant state event is invalid')
    }
  }

  private send(payload: WireRecord): number {
    const id = this.nextRequestId
    this.nextRequestId += 1
    this.socket?.send(JSON.stringify({ id, ...payload }))
    return id
  }

  private sendAuth(): void {
    this.socket?.send(JSON.stringify({ type: 'auth', access_token: this.accessToken }))
  }

  private protocolFailure(reason: string): void {
    const socket = this.socket
    this.handleDisconnect(socket, reason)
    socket?.close()
  }

  private handleDisconnect(socket: HomeAssistantSocket | undefined, _reason?: string): void {
    if (socket !== undefined && socket !== this.socket) return
    if (this.state === 'stopped') return
    this.socket = undefined
    this.failPendingCommands('unavailable', 'Home Assistant connection became unavailable')
    this.resetConnectionState()
    this.state = 'degraded'
    this.notifyStatus()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectHandle !== undefined) return
    const delayMs = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** this.reconnectAttempt))
    this.reconnectAttempt += 1
    this.reconnectHandle = this.timers.setTimeout(() => {
      this.reconnectHandle = undefined
      this.connect()
    }, delayMs)
  }

  private clearReconnect(): void {
    if (this.reconnectHandle === undefined) return
    this.timers.clearTimeout(this.reconnectHandle)
    this.reconnectHandle = undefined
  }

  private notifyStatus(): void {
    this.onStatus?.(this.state)
  }

  private validateCommand(command: HomeAssistantServiceCommand): HomeAssistantServiceCommand {
    if (!isRecord(command)) throw new TypeError('Home Assistant command must be an object')
    const capability = command.capability
    if (capability !== 'switch.set' && capability !== 'light.set' && capability !== 'media.play_pause') throw new Error('Home Assistant command capability is not low risk')
    const commandId = requiredText(command.commandId, 'commandId', 128)
    const idempotencyKey = requiredText(command.idempotencyKey, 'idempotencyKey', 128)
    const externalEntityId = requiredText(command.externalEntityId, 'externalEntityId', 256)
    const service = requiredText(command.service, 'service', 64)
    if (!LOW_RISK_SERVICES[capability].includes(service)) throw new Error(`service is not allowlisted for ${capability}`)
    const expectedState = requiredText(command.expectedState, 'expectedState', 128)
    if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 120_000) throw new RangeError('timeoutMs must be an integer between 1 and 120000')
    if (command.serviceData !== undefined && !isRecord(command.serviceData)) throw new TypeError('serviceData must be an object')
    commandDigest({ commandId, idempotencyKey, capability, externalEntityId, service, serviceData: command.serviceData ?? {}, expectedState, timeoutMs: command.timeoutMs })
    return { commandId, idempotencyKey, capability, externalEntityId, service, expectedState, timeoutMs: command.timeoutMs, ...(command.serviceData === undefined ? {} : { serviceData: command.serviceData }) }
  }

  private validateApprovedCommand(command: HomeAssistantApprovedServiceCommand): HomeAssistantApprovedServiceCommand {
    if (!isRecord(command)) throw new TypeError('approved Home Assistant command must be an object')
    if (command.capability !== 'lock.set' && command.capability !== 'alarm.set') {
      throw new Error('approved Home Assistant command capability must be high risk')
    }
    const commandId = requiredText(command.commandId, 'commandId', 128)
    const idempotencyKey = requiredText(command.idempotencyKey, 'idempotencyKey', 128)
    const externalEntityId = requiredText(command.externalEntityId, 'externalEntityId', 256)
    const service = requiredText(command.service, 'service', 64)
    if (!HIGH_RISK_SERVICES[command.capability].includes(service)) throw new Error(`service is not allowlisted for ${command.capability}`)
    const expectedState = requiredText(command.expectedState, 'expectedState', 128)
    if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 120_000) throw new RangeError('timeoutMs must be an integer between 1 and 120000')
    if (command.serviceData !== undefined && !isRecord(command.serviceData)) throw new TypeError('serviceData must be an object')
    return {
      commandId, idempotencyKey, capability: command.capability, externalEntityId, service, expectedState, timeoutMs: command.timeoutMs,
      ...(command.serviceData === undefined ? {} : { serviceData: command.serviceData }),
    }
  }

  private commandFingerprint(command: HomeAssistantDispatchCommand): string {
    return commandDigest({
      idempotencyKey: command.idempotencyKey,
      capability: command.capability,
      externalEntityId: command.externalEntityId,
      service: command.service,
      serviceData: command.serviceData ?? {},
      expectedState: command.expectedState,
      timeoutMs: command.timeoutMs,
    })
  }

  private validAuthorization(value: unknown): value is DeviceApprovalAuthorization {
    return isRecord(value) && typeof value.approvalId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.approvalId)
      && typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest)
      && value.risk === 'high' && value.allowedOnce === true
      && typeof value.approvedAt === 'number' && Number.isFinite(value.approvedAt)
      && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
      && value.expiresAt > value.approvedAt
  }

  private emitCommand(command: HomeAssistantDispatchCommand, phase: HomeAssistantCommandPhase, observedState?: string, error?: string): void {
    this.onCommand?.({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      phase,
      ...(observedState === undefined ? {} : { observedState }),
      ...(error === undefined ? {} : { error }),
    })
  }

  private finishCommand(pending: PendingCommand, state: HomeAssistantCommandState, error?: string, observedState?: string): void {
    if (!this.pendingCommands.has(pending.requestId)) return
    this.pendingCommands.delete(pending.requestId)
    this.timers.clearTimeout(pending.timer)
    this.emitCommand(pending.command, state, observedState, error)
    pending.resolve(this.finalResult(pending.command, state, pending.acknowledged, observedState, error))
  }

  private finalResult(command: HomeAssistantDispatchCommand, state: HomeAssistantCommandState, acknowledged: boolean, observedState?: string, error?: string): HomeAssistantCommandResult {
    return {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      capability: command.capability,
      state,
      acknowledged,
      ...(observedState === undefined ? {} : { observedState }),
      ...(error === undefined ? {} : { error }),
    }
  }

  private failPendingCommands(state: HomeAssistantCommandState, error: string): void {
    for (const pending of [...this.pendingCommands.values()]) this.finishCommand(pending, state, error)
  }
}
