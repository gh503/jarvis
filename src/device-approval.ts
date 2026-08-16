import { APPROVAL_TTL_MS, ApprovalLedger, commandDigest } from './approval.js'

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
