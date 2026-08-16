export type DeviceCapabilityRisk = 'read' | 'low' | 'medium' | 'high'
export type DeviceAvailability = 'available' | 'unavailable'

export interface DeviceSource {
  adapter: string
  instance?: string
}

export interface DeviceState {
  value: unknown
  sourceTimestamp: number
}

export interface DeviceCapability {
  id: string
  name: string
  risk: DeviceCapabilityRisk
}

export interface NormalizedDevice {
  id: string
  externalEntityId: string
  name: string
  location: string
  source: DeviceSource
  aliases: readonly string[]
  capabilities: readonly DeviceCapability[]
  availability: DeviceAvailability
  reportedState?: DeviceState
}

export interface DiscoveredDevice {
  externalEntityId: string
  name: string
  location: string
  source: DeviceSource
  capabilities: readonly string[]
  aliases?: readonly string[]
  riskOverrides?: Readonly<Record<string, DeviceCapabilityRisk>>
  reportedState?: DeviceState
}

const DEFAULT_RISKS: Readonly<Record<string, DeviceCapabilityRisk>> = Object.freeze({
  'sensor.read': 'read',
  'switch.set': 'low',
  'light.set': 'low',
  'climate.set_target': 'medium',
  'media.play_pause': 'low',
  'cover.set': 'medium',
  'lock.set': 'high',
  'alarm.set': 'high',
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string of at most ${maxLength} characters`)
  }
  return value
}

function validateRisk(value: unknown, field: string): DeviceCapabilityRisk {
  if (value !== 'read' && value !== 'low' && value !== 'medium' && value !== 'high') {
    throw new TypeError(`${field} is an invalid capability risk`)
  }
  return value
}

function validateSource(source: DeviceSource): DeviceSource {
  if (!isRecord(source)) throw new TypeError('device source must be an object')
  const adapter = requiredText(source.adapter, 'source.adapter', 64)
  const instance = source.instance === undefined ? undefined : requiredText(source.instance, 'source.instance', 128)
  return instance === undefined ? { adapter } : { adapter, instance }
}

function validateState(state: DeviceState | undefined): DeviceState | undefined {
  if (state === undefined) return undefined
  if (!isRecord(state) || typeof state.sourceTimestamp !== 'number' || !Number.isFinite(state.sourceTimestamp)) {
    throw new TypeError('reported state must contain a finite sourceTimestamp')
  }
  return { value: state.value, sourceTimestamp: state.sourceTimestamp }
}

function identity(source: DeviceSource, externalEntityId: string): string {
  return `${source.adapter}\u0000${source.instance ?? ''}\u0000${externalEntityId}`
}

function deviceId(source: DeviceSource, externalEntityId: string): string {
  return `device:${source.adapter}:${source.instance ?? 'default'}:${externalEntityId}`
}

function capabilityId(device: string, name: string): string {
  return `${device}#${name}`
}

function cloneState(state: DeviceState): DeviceState {
  return { value: state.value, sourceTimestamp: state.sourceTimestamp }
}

function cloneDevice(device: NormalizedDevice): NormalizedDevice {
  return {
    ...device,
    source: { ...device.source },
    aliases: [...device.aliases],
    capabilities: device.capabilities.map(capability => ({ ...capability })),
    ...(device.reportedState === undefined ? {} : { reportedState: cloneState(device.reportedState) }),
  }
}

export class DeviceRegistry {
  private readonly devices = new Map<string, NormalizedDevice>()

  sync(discovered: readonly DiscoveredDevice[]): readonly NormalizedDevice[] {
    const next = new Map<string, NormalizedDevice>()
    for (const input of discovered) {
      const normalized = this.normalize(input)
      const key = identity(normalized.source, normalized.externalEntityId)
      if (next.has(key)) throw new Error(`duplicate external device identity: ${key}`)
      next.set(key, normalized)
    }

    for (const [key, existing] of this.devices) {
      if (!next.has(key)) {
        const { reportedState: _reportedState, ...withoutState } = existing
        next.set(key, { ...withoutState, availability: 'unavailable' })
      }
    }
    this.devices.clear()
    for (const [key, device] of next) this.devices.set(key, device)
    return this.list()
  }

  updateState(source: DeviceSource, externalEntityId: string, state: DeviceState): NormalizedDevice {
    const validatedSource = validateSource(source)
    const externalId = requiredText(externalEntityId, 'externalEntityId')
    const key = identity(validatedSource, externalId)
    const device = this.devices.get(key)
    if (device === undefined) throw new Error(`unknown external device identity: ${key}`)
    const validatedState = validateState(state)
    if (validatedState === undefined) throw new TypeError('state is required')
    if (device.reportedState !== undefined && validatedState.sourceTimestamp < device.reportedState.sourceTimestamp) return cloneDevice(device)
    device.reportedState = validatedState
    device.availability = 'available'
    return cloneDevice(device)
  }

  get(source: DeviceSource, externalEntityId: string): NormalizedDevice | undefined {
    const key = identity(validateSource(source), requiredText(externalEntityId, 'externalEntityId'))
    const device = this.devices.get(key)
    return device === undefined ? undefined : cloneDevice(device)
  }

  list(): readonly NormalizedDevice[] {
    return [...this.devices.values()].sort((left, right) => left.id.localeCompare(right.id)).map(cloneDevice)
  }

  serialize(): readonly NormalizedDevice[] {
    return this.list()
  }

  private normalize(input: DiscoveredDevice): NormalizedDevice {
    if (!isRecord(input)) throw new TypeError('discovered device must be an object')
    const externalEntityId = requiredText(input.externalEntityId, 'externalEntityId')
    const name = requiredText(input.name, 'name')
    const location = requiredText(input.location, 'location')
    const source = validateSource(input.source)
    if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) throw new TypeError('device capabilities must be a non-empty array')
    const aliases = [...new Set((input.aliases ?? []).map(alias => requiredText(alias, 'alias')))].sort((left, right) => left.localeCompare(right))
    const names = [...new Set(input.capabilities.map(capability => requiredText(capability, 'capability')))]
    if (names.length !== input.capabilities.length) throw new Error(`duplicate capability on device: ${externalEntityId}`)
    const overrides = input.riskOverrides ?? {}
    const capabilities = names.map(name => {
      const risk = overrides[name] ?? DEFAULT_RISKS[name]
      if (risk === undefined) throw new Error(`unsupported device capability: ${name}`)
      return { id: capabilityId(deviceId(source, externalEntityId), name), name, risk: validateRisk(risk, `${name}.risk`) }
    }).sort((left, right) => left.name.localeCompare(right.name))
    const reportedState = validateState(input.reportedState)
    return {
      id: deviceId(source, externalEntityId),
      externalEntityId,
      name,
      location,
      source,
      aliases,
      capabilities,
      availability: 'available',
      ...(reportedState === undefined ? {} : { reportedState }),
    }
  }
}
