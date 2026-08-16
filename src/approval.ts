import { createHash } from 'node:crypto'

export const APPROVAL_TTL_MS = 60_000

export type MobileApprovalOutcome = 'allowed-once' | 'rejected'

export type MobileApprovalBlockReason = 'expired' | 'evidence_missing' | 'unsupported_action'

export interface MobileApproval {
  readonly id: string
  readonly conversationId: string
  readonly toolName: string
  readonly callId: string | null
  readonly action: 'open_app' | 'unsupported'
  readonly target: string | null
  readonly arguments: Readonly<Record<string, string>> | null
  readonly digest: string | null
  readonly risk: 'high'
  readonly requestedAt: number | null
  readonly expiresAt: number | null
  readonly canAllow: boolean
  readonly blockReason: MobileApprovalBlockReason | null
}

export interface MobileApprovalDecisionReceipt {
  readonly approvalId: string
  readonly outcome: MobileApprovalOutcome
  readonly accepted: true
}

export type MobileApprovalDecisionErrorCode =
  | 'conflict'
  | 'expired'
  | 'mismatch'
  | 'missing'
  | 'protocol'
  | 'unavailable'
  | 'unsupported'

export class MobileApprovalDecisionError extends Error {
  constructor(readonly code: MobileApprovalDecisionErrorCode) {
    super(`mobile approval decision failed: ${code}`)
    this.name = 'MobileApprovalDecisionError'
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
    return `{${entries.join(',')}}`
  }
  throw new TypeError('approval arguments must be lossless JSON')
}

export function commandDigest(command: unknown): string {
  return createHash('sha256').update(canonicalJson(command), 'utf8').digest('hex')
}

export interface ApprovalRecord {
  readonly callId: string
  readonly digest: string
  readonly expiresAt: number
}

export class ApprovalLedger {
  private readonly pending = new Map<string, ApprovalRecord>()
  private readonly used = new Set<string>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = APPROVAL_TTL_MS,
  ) {}

  propose(callId: string, command: unknown): ApprovalRecord {
    if (this.pending.has(callId) || this.used.has(callId)) {
      throw new Error(`approval call id has already been used: ${callId}`)
    }
    const record = Object.freeze({ callId, digest: commandDigest(command), expiresAt: this.now() + this.ttlMs })
    this.pending.set(callId, record)
    return record
  }

  consume(callId: string, command: unknown): ApprovalRecord {
    const record = this.pending.get(callId)
    if (record === undefined) throw new Error('approval is missing or already consumed')
    this.pending.delete(callId)
    this.used.add(callId)
    if (record.expiresAt <= this.now()) throw new Error('approval has expired')
    if (record.digest !== commandDigest(command)) throw new Error('approved command does not match the requested command')
    return record
  }

  clear(callId: string): void {
    if (this.pending.delete(callId)) this.used.add(callId)
  }
}
