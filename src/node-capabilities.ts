export const NODE_PROTOCOL_VERSION = 1

export type NodeCapabilityRisk = 'read' | 'write' | 'high'

export interface NodeCapabilityDescriptor {
  name: string
  version: number
  inputSchemaVersion: number
  outputSchemaVersion: number
  risk: NodeCapabilityRisk
  timeoutMs: number
  supportsCancellation: boolean
}

export interface NodeRegistration {
  protocolVersion: number
  nodeId: string
  platform: 'macos'
  softwareVersion: string
  capabilities: readonly NodeCapabilityDescriptor[]
}

export const MAC_NODE_CAPABILITIES: Readonly<Record<string, NodeCapabilityDescriptor>> = Object.freeze({
  open_app: Object.freeze({
    name: 'open_app',
    version: 1,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
    risk: 'write',
    timeoutMs: 10_000,
    supportsCancellation: true,
  }),
  system_status: Object.freeze({
    name: 'system_status',
    version: 1,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
    risk: 'read',
    timeoutMs: 5_000,
    supportsCancellation: false,
  }),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) {
    throw new TypeError(`${field} must be a non-empty string of at most 128 characters`)
  }
  return value
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`)
  }
  return value
}

function parseCapability(value: unknown, supported: Readonly<Record<string, NodeCapabilityDescriptor>>): NodeCapabilityDescriptor {
  if (!isRecord(value)) throw new TypeError('capability must be an object')
  const name = requiredString(value.name, 'capability name')
  const definition = supported[name]
  if (definition === undefined) throw new Error(`capability is not allowlisted: ${name}`)
  const descriptor = {
    name,
    version: requiredPositiveInteger(value.version, `${name}.version`),
    inputSchemaVersion: requiredPositiveInteger(value.inputSchemaVersion, `${name}.inputSchemaVersion`),
    outputSchemaVersion: requiredPositiveInteger(value.outputSchemaVersion, `${name}.outputSchemaVersion`),
    risk: value.risk,
    timeoutMs: value.timeoutMs,
    supportsCancellation: value.supportsCancellation,
  }
  if (descriptor.version !== definition.version
    || descriptor.inputSchemaVersion !== definition.inputSchemaVersion
    || descriptor.outputSchemaVersion !== definition.outputSchemaVersion
    || descriptor.risk !== definition.risk
    || descriptor.timeoutMs !== definition.timeoutMs
    || descriptor.supportsCancellation !== definition.supportsCancellation) {
    throw new Error(`capability definition does not match the allowlist: ${name}`)
  }
  if (descriptor.risk !== 'read' && descriptor.risk !== 'write' && descriptor.risk !== 'high') {
    throw new TypeError(`${name}.risk is invalid`)
  }
  if (typeof descriptor.timeoutMs !== 'number' || !Number.isInteger(descriptor.timeoutMs) || descriptor.timeoutMs < 1 || descriptor.timeoutMs > 120_000) {
    throw new TypeError(`${name}.timeoutMs is invalid`)
  }
  if (typeof descriptor.supportsCancellation !== 'boolean') {
    throw new TypeError(`${name}.supportsCancellation must be boolean`)
  }
  return descriptor as NodeCapabilityDescriptor
}

export function createNodeRegistration(
  input: Omit<NodeRegistration, 'protocolVersion'>,
  supported: Readonly<Record<string, NodeCapabilityDescriptor>> = MAC_NODE_CAPABILITIES,
): NodeRegistration {
  const nodeId = requiredString(input.nodeId, 'nodeId')
  const softwareVersion = requiredString(input.softwareVersion, 'softwareVersion')
  if (input.platform !== 'macos') throw new Error('node platform must be macos')
  const capabilities = input.capabilities
    .map(capability => parseCapability(capability, supported))
    .sort((left, right) => left.name.localeCompare(right.name))
  if (new Set(capabilities.map(capability => capability.name)).size !== capabilities.length) {
    throw new Error('registration contains duplicate capabilities')
  }
  return {
    protocolVersion: NODE_PROTOCOL_VERSION,
    nodeId,
    platform: 'macos',
    softwareVersion,
    capabilities,
  }
}

export function parseNodeRegistration(
  value: unknown,
  supported: Readonly<Record<string, NodeCapabilityDescriptor>> = MAC_NODE_CAPABILITIES,
): NodeRegistration {
  if (!isRecord(value)) throw new TypeError('node registration must be an object')
  if (value.protocolVersion !== NODE_PROTOCOL_VERSION) throw new Error('unsupported node protocol version')
  if (value.platform !== 'macos') throw new Error('node platform must be macos')
  if (!Array.isArray(value.capabilities)) throw new TypeError('registration capabilities must be an array')
  return createNodeRegistration({
    nodeId: value.nodeId as string,
    platform: 'macos',
    softwareVersion: value.softwareVersion as string,
    capabilities: value.capabilities as NodeCapabilityDescriptor[],
  }, supported)
}
