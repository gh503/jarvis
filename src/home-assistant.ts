import type { DeviceState, DeviceSource, DiscoveredDevice } from './device-registry.js'

export type HomeAssistantAdapterState = 'stopped' | 'connecting' | 'syncing' | 'ready' | 'degraded'

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

type WireRecord = Record<string, unknown>

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
  private readonly timers: HomeAssistantTimers
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly instance: string
  private socket: HomeAssistantSocket | undefined
  private reconnectHandle: unknown
  private nextRequestId = 1
  private expectedSubscriptionId: number | undefined
  private pendingSnapshotId: number | undefined
  private state: HomeAssistantAdapterState = 'stopped'
  private reconnectAttempt = 0
  private knownEntities = new Map<string, number>()

  constructor(options: HomeAssistantAdapterOptions) {
    this.url = validateUrl(options.url)
    this.accessToken = requiredText(options.accessToken, 'accessToken', 4096)
    this.socketFactory = options.socketFactory
    this.onSnapshot = options.onSnapshot
    this.onState = options.onState
    this.onUnavailable = options.onUnavailable
    this.onStatus = options.onStatus
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
    socket?.close()
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
        this.knownEntities = new Map(snapshot.map(device => [device.externalEntityId, device.reportedState?.sourceTimestamp ?? 0]))
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
    this.protocolFailure('unexpected Home Assistant response id')
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
        return
      }
      if (!isRecord(data.new_state)) return
      const parsed = parseEntityState(data.new_state)
      const previousTimestamp = this.knownEntities.get(entityId) ?? -1
      if (parsed.state.sourceTimestamp < previousTimestamp) return
      this.knownEntities.set(entityId, parsed.state.sourceTimestamp)
      this.onState({ adapter: SOURCE_ADAPTER, instance: this.instance }, entityId, parsed.state)
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
}
