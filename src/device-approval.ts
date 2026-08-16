import { APPROVAL_TTL_MS, ApprovalLedger, commandDigest } from './approval.js'
import type { JarvisEventPayload } from './event-log.js'

export type HighRiskDeviceCapability = 'lock.set' | 'alarm.set'

export interface HighRiskDeviceCommand {
  commandId: string
  idempotencyKey: string
  capability: HighRiskDeviceCapability
  externalEntityId: string
  service: string
  serviceData?: Readonly<Record<string, unknown>>
  expectedState: string
}

export interface DeviceApprovalRequest {
  approvalId: string
  capability: HighRiskDeviceCapability
  externalEntityId: string
  service: string
  expectedState: string
  digest: string
  risk: 'high'
  expiresAt: number
}

export interface DeviceApprovalAuthorization {
  approvalId: string
  digest: string
  risk: 'high'
  allowedOnce: true
  approvedAt: number
  expiresAt: number
}

export type DeviceApprovalOutcome = 'allowed-once' | 'rejected'

export interface DeviceApprovalDecisionReceipt {
  approvalId: string
  outcome: DeviceApprovalOutcome
  accepted: true
}

export interface DeviceApprovalExecution {
  command: HighRiskDeviceCommand
  authorization: DeviceApprovalAuthorization
}

export type DeviceApprovalExecutionHandler = (execution: DeviceApprovalExecution) => void

export interface DeviceApprovalSource {
  listApprovals(): readonly DeviceApprovalRequest[]
  decideApproval(
    approvalId: string,
    digest: string,
    outcome: DeviceApprovalOutcome,
    idempotencyKey: string,
  ): DeviceApprovalDecisionReceipt | Promise<DeviceApprovalDecisionReceipt>
  subscribe?(listener: (event: Extract<JarvisEventPayload, { type: `device.approval.${string}` }>) => void): () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`)
  }
  return value
}

function normalizedCommand(command: HighRiskDeviceCommand): HighRiskDeviceCommand {
  if (!isRecord(command)) throw new TypeError('high-risk device command must be an object')
  const capability = command.capability
  if (capability !== 'lock.set' && capability !== 'alarm.set') throw new Error('device approval is only for mandatory high-risk capabilities')
  const normalized = {
    commandId: requiredText(command.commandId, 'commandId'),
    idempotencyKey: requiredText(command.idempotencyKey, 'idempotencyKey'),
    capability,
    externalEntityId: requiredText(command.externalEntityId, 'externalEntityId'),
    service: requiredText(command.service, 'service', 64),
    expectedState: requiredText(command.expectedState, 'expectedState', 128),
    ...(command.serviceData === undefined ? {} : { serviceData: command.serviceData }),
  }
  if (command.serviceData !== undefined && !isRecord(command.serviceData)) throw new TypeError('serviceData must be an object')
  commandDigest(normalized)
  return normalized
}

function commandFingerprint(command: HighRiskDeviceCommand): string {
  return commandDigest({
    idempotencyKey: command.idempotencyKey,
    capability: command.capability,
    externalEntityId: command.externalEntityId,
    service: command.service,
    serviceData: command.serviceData ?? {},
    expectedState: command.expectedState,
  })
}

export function deviceApprovalDigest(command: HighRiskDeviceCommand): string {
  return commandDigest(normalizedCommand(command))
}

export class DeviceApprovalGate {
  private readonly ledger: ApprovalLedger

  constructor(
    private readonly now: () => number = Date.now,
    ttlMs = APPROVAL_TTL_MS,
  ) {
    this.ledger = new ApprovalLedger(now, ttlMs)
  }

  request(approvalId: string, command: HighRiskDeviceCommand): DeviceApprovalRequest {
    const normalizedApprovalId = requiredText(approvalId, 'approvalId', 128)
    const normalized = normalizedCommand(command)
    const record = this.ledger.propose(normalizedApprovalId, normalized)
    return {
      approvalId: normalizedApprovalId,
      capability: normalized.capability,
      externalEntityId: normalized.externalEntityId,
      service: normalized.service,
      expectedState: normalized.expectedState,
      digest: record.digest,
      risk: 'high',
      expiresAt: record.expiresAt,
    }
  }

  authorize(approvalId: string, command: HighRiskDeviceCommand): DeviceApprovalAuthorization {
    const normalized = normalizedCommand(command)
    const record = this.ledger.consume(requiredText(approvalId, 'approvalId', 128), normalized)
    return {
      approvalId: record.callId,
      digest: record.digest,
      risk: 'high',
      allowedOnce: true,
      approvedAt: this.now(),
      expiresAt: record.expiresAt,
    }
  }

  cancel(approvalId: string): void {
    this.ledger.clear(requiredText(approvalId, 'approvalId', 128))
  }

  digest(command: HighRiskDeviceCommand): string {
    return commandFingerprint(normalizedCommand(command))
  }
}

interface PendingDeviceApproval {
  command: HighRiskDeviceCommand
  request: DeviceApprovalRequest
}

interface StoredDeviceDecision {
  fingerprint: string
  receipt: DeviceApprovalDecisionReceipt
}

export class InMemoryDeviceApprovalStore implements DeviceApprovalSource {
  private readonly pending = new Map<string, PendingDeviceApproval>()
  private readonly decisions = new Map<string, StoredDeviceDecision>()
  private readonly listeners = new Set<(event: Extract<JarvisEventPayload, { type: `device.approval.${string}` }>) => void>()

  constructor(
    private readonly gate = new DeviceApprovalGate(),
    private readonly onAllowed?: DeviceApprovalExecutionHandler,
  ) {}

  request(approvalId: string, command: HighRiskDeviceCommand): DeviceApprovalRequest {
    const request = this.gate.request(approvalId, command)
    this.pending.set(request.approvalId, { command, request })
    this.emit({ type: 'device.approval.pending', approval: { ...request } })
    return request
  }

  listApprovals(): readonly DeviceApprovalRequest[] {
    return [...this.pending.values()]
      .map(item => ({ ...item.request }))
      .sort((left, right) => left.approvalId.localeCompare(right.approvalId))
  }

  decideApproval(
    approvalId: string,
    digest: string,
    outcome: DeviceApprovalOutcome,
    idempotencyKey: string,
  ): DeviceApprovalDecisionReceipt {
    const normalizedApprovalId = requiredText(approvalId, 'approvalId', 128)
    const normalizedDigest = requiredText(digest, 'digest', 64)
    const normalizedIdempotencyKey = requiredText(idempotencyKey, 'idempotencyKey', 128)
    if (!/^[0-9a-f]{64}$/.test(normalizedDigest)) throw new Error('device approval digest is invalid')
    if (outcome !== 'allowed-once' && outcome !== 'rejected') throw new Error('device approval outcome is invalid')
    const fingerprint = commandDigest({ approvalId: normalizedApprovalId, digest: normalizedDigest, outcome })
    const existing = this.decisions.get(normalizedIdempotencyKey)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new Error('device approval idempotency key conflict')
      return existing.receipt
    }
    const pending = this.pending.get(normalizedApprovalId)
    if (pending === undefined) throw new Error('device approval is missing or already resolved')
    if (pending.request.digest !== normalizedDigest) throw new Error('device approval digest does not match')
    this.pending.delete(normalizedApprovalId)
    const authorization = outcome === 'allowed-once'
      ? this.gate.authorize(normalizedApprovalId, pending.command)
      : undefined
    if (outcome === 'rejected') this.gate.cancel(normalizedApprovalId)
    const receipt = { approvalId: normalizedApprovalId, outcome, accepted: true as const }
    this.decisions.set(normalizedIdempotencyKey, { fingerprint, receipt })
    this.emit({ type: 'device.approval.resolved', approvalId: normalizedApprovalId, outcome })
    if (authorization !== undefined) this.onAllowed?.({ command: pending.command, authorization })
    return receipt
  }

  subscribe(listener: (event: Extract<JarvisEventPayload, { type: `device.approval.${string}` }>) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: Extract<JarvisEventPayload, { type: `device.approval.${string}` }>): void {
    for (const listener of this.listeners) listener(event)
  }
}
