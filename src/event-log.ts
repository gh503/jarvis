import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ConversationMessage } from './harness-bridge.js'
import type { MobileApproval, MobileApprovalOutcome } from './approval.js'
import type { DeviceApprovalRequest, DeviceApprovalOutcome } from './device-approval.js'

const DEFAULT_MAX_EVENTS = 512
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const CURSOR_PATTERN = /^([A-Za-z0-9_-]{22})\.([0-9]+)$/
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export type SyncReason = 'gateway_restarted' | 'harness_disconnected'

export type JarvisEventPayload =
  | { type: 'conversation.created'; conversation: { id: string; blank: boolean } }
  | { type: 'conversation.removed'; conversationId: string }
  | { type: 'conversation.status'; conversationId: string; running: boolean }
  | { type: 'conversation.message.committed'; conversationId: string; message: ConversationMessage }
  | { type: 'conversation.error'; conversationId: string; code: 'harness_agent_error' }
  | { type: 'approval.pending'; approval: MobileApproval }
  | { type: 'approval.resolved'; approvalId: string; conversationId: string; outcome: MobileApprovalOutcome | 'cancelled' | 'unavailable' }
  | { type: 'device.approval.pending'; approval: DeviceApprovalRequest }
  | { type: 'device.approval.resolved'; approvalId: string; outcome: DeviceApprovalOutcome }
  | { type: 'sync.required'; reason: SyncReason }

export type JarvisEvent = JarvisEventPayload & {
  version: 1
  eventId: string
  cursor: string
  occurredAt: number
}

export type ReplayReason = 'initial' | 'invalid_cursor' | 'gateway_restarted' | 'cursor_ahead' | 'cursor_expired'

export interface EventReplay {
  cursor: string
  events: readonly JarvisEvent[]
  requiresSnapshot: boolean
  reason?: ReplayReason
}

interface EventLogSnapshot {
  version: 1
  epoch: string
  nextSequence: number
  events: JarvisEvent[]
}

export interface EventLogStore {
  load(): EventLogSnapshot | undefined
  save(snapshot: EventLogSnapshot): void
}

export interface RetainedEventLogOptions {
  store?: EventLogStore
  maxEvents?: number
  maxBytes?: number
  now?: () => number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  return value
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && allowed.every(key => Object.hasOwn(value, key))
}

function validMessage(value: unknown): value is ConversationMessage {
  return record(value) && exactFields(value, ['id', 'sequence', 'createdAt', 'role', 'text'])
    && typeof value.id === 'string' && value.id.length > 0
    && Number.isSafeInteger(value.sequence) && (value.sequence as number) >= 0
    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
    && (value.role === 'user' || value.role === 'assistant') && typeof value.text === 'string' && value.text.length > 0
}

function validApproval(value: unknown): value is MobileApproval {
  if (!record(value) || !exactFields(value, [
    'id', 'conversationId', 'toolName', 'callId', 'action', 'target', 'arguments', 'digest',
    'risk', 'requestedAt', 'expiresAt', 'canAllow', 'blockReason',
  ])) return false
  if (!validId(value.id) || !validId(value.conversationId) || typeof value.toolName !== 'string'
    || value.toolName.length < 1 || value.toolName.length > 128
    || (value.callId !== null && !validId(value.callId)) || value.risk !== 'high'
    || typeof value.canAllow !== 'boolean') return false
  if (value.action === 'open_app') {
    return typeof value.target === 'string' && value.target.length > 0 && value.target.length <= 128
      && record(value.arguments) && exactFields(value.arguments, ['application'])
      && value.arguments.application === value.target
      && typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest)
      && typeof value.requestedAt === 'number' && Number.isFinite(value.requestedAt)
      && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
      && value.expiresAt > value.requestedAt
      && (value.blockReason === null || value.blockReason === 'expired')
      && value.canAllow === (value.blockReason === null)
  }
  return value.action === 'unsupported' && value.target === null && value.arguments === null
    && value.digest === null && value.requestedAt === null && value.expiresAt === null
    && value.canAllow === false
    && (value.blockReason === 'evidence_missing' || value.blockReason === 'unsupported_action')
}

function validDeviceApproval(value: unknown): value is DeviceApprovalRequest {
  return record(value) && exactFields(value, [
    'approvalId', 'capability', 'externalEntityId', 'service', 'expectedState', 'digest', 'risk', 'expiresAt',
  ]) && validId(value.approvalId)
    && (value.capability === 'lock.set' || value.capability === 'alarm.set')
    && typeof value.externalEntityId === 'string' && value.externalEntityId.length > 0 && value.externalEntityId.length <= 256
    && typeof value.service === 'string' && value.service.length > 0 && value.service.length <= 64
    && typeof value.expectedState === 'string' && value.expectedState.length > 0 && value.expectedState.length <= 128
    && typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest)
    && value.risk === 'high' && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
}

function validPayload(value: Record<string, unknown>): boolean {
  if (value.type === 'conversation.created') {
    return exactFields(value, ['version', 'eventId', 'cursor', 'occurredAt', 'type', 'conversation'])
      && record(value.conversation) && exactFields(value.conversation, ['id', 'blank'])
      && validId(value.conversation.id) && typeof value.conversation.blank === 'boolean'
  }
  if (value.type === 'conversation.removed') {
    return exactFields(value, ['version', 'eventId', 'cursor', 'occurredAt', 'type', 'conversationId'])
      && validId(value.conversationId)
  }
  if (value.type === 'conversation.status') {
    return exactFields(value, ['version', 'eventId', 'cursor', 'occurredAt', 'type', 'conversationId', 'running'])
      && validId(value.conversationId) && typeof value.running === 'boolean'
  }
  if (value.type === 'conversation.message.committed') {
    return exactFields(value, ['version', 'eventId', 'cursor', 'occurredAt', 'type', 'conversationId', 'message'])
      && validId(value.conversationId) && validMessage(value.message)
  }
  if (value.type === 'conversation.error') {
    return exactFields(value, ['version', 'eventId', 'cursor', 'occurredAt', 'type', 'conversationId', 'code'])
      && validId(value.conversationId) && value.code === 'harness_agent_error'
  }
  if (value.type === 'approval.pending') {
    return exactFields(value, ['version', 'eventId', 'cursor', 'occurredAt', 'type', 'approval'])
      && validApproval(value.approval)
  }
  if (value.type === 'approval.resolved') {
    return exactFields(value, ['version', 'eventId', 'cursor', 'occurredAt', 'type', 'approvalId', 'conversationId', 'outcome'])
      && validId(value.approvalId) && validId(value.conversationId)
      && (value.outcome === 'allowed-once' || value.outcome === 'rejected'
        || value.outcome === 'cancelled' || value.outcome === 'unavailable')
  }
  if (value.type === 'device.approval.pending') {
    return exactFields(value, ['version', 'eventId', 'cursor', 'occurredAt', 'type', 'approval'])
      && validDeviceApproval(value.approval)
  }
  if (value.type === 'device.approval.resolved') {
    return exactFields(value, ['version', 'eventId', 'cursor', 'occurredAt', 'type', 'approvalId', 'outcome'])
      && validId(value.approvalId) && (value.outcome === 'allowed-once' || value.outcome === 'rejected')
  }
  return value.type === 'sync.required' && exactFields(value, ['version', 'eventId', 'cursor', 'occurredAt', 'type', 'reason'])
    && (value.reason === 'gateway_restarted' || value.reason === 'harness_disconnected')
}

function parseCursor(value: string): { epoch: string; sequence: number } | undefined {
  const match = CURSOR_PATTERN.exec(value)
  if (match === null) return undefined
  const sequence = Number(match[2])
  if (!Number.isSafeInteger(sequence) || sequence < 0) return undefined
  return { epoch: match[1] as string, sequence }
}

function validEvent(value: unknown, epoch: string): value is JarvisEvent {
  if (!record(value) || value.version !== 1 || typeof value.eventId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(value.eventId) || typeof value.cursor !== 'string'
    || typeof value.occurredAt !== 'number' || !Number.isFinite(value.occurredAt) || !validPayload(value)) return false
  return parseCursor(value.cursor)?.epoch === epoch
}

function eventBytes(event: JarvisEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8')
}

export class FileEventLogStore implements EventLogStore {
  constructor(readonly path: string) {}

  load(): EventLogSnapshot | undefined {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as EventLogSnapshot
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw new Error('event state could not be read')
    }
  }

  save(snapshot: EventLogSnapshot): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
  }
}

export class RetainedEventLog {
  private readonly store: EventLogStore | undefined
  private readonly maxEvents: number
  private readonly maxBytes: number
  private readonly now: () => number
  private readonly epoch: string
  private nextSequence: number
  private events: JarvisEvent[]
  private readonly listeners = new Set<(event: JarvisEvent) => void>()
  readonly restored: boolean

  constructor(options: RetainedEventLogOptions = {}) {
    this.store = options.store
    this.maxEvents = positiveInteger(options.maxEvents ?? DEFAULT_MAX_EVENTS, 'maxEvents')
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes')
    this.now = options.now ?? Date.now
    const snapshot = this.store?.load()
    this.restored = snapshot !== undefined
    if (snapshot === undefined) {
      this.epoch = randomBytes(16).toString('base64url')
      this.nextSequence = 1
      this.events = []
      return
    }
    if (snapshot.version !== 1 || typeof snapshot.epoch !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(snapshot.epoch)
      || !Number.isSafeInteger(snapshot.nextSequence) || snapshot.nextSequence < 1 || !Array.isArray(snapshot.events)
      || snapshot.events.length > this.maxEvents || snapshot.events.some(event => !validEvent(event, snapshot.epoch))) {
      throw new Error('event state contains invalid data')
    }
    const sequences = snapshot.events.map(event => parseCursor(event.cursor)?.sequence as number)
    if (sequences.some((sequence, index) => sequence < 1 || (index > 0 && sequence !== (sequences[index - 1] as number) + 1))
      || (sequences.length === 0 ? snapshot.nextSequence !== 1 : sequences.at(-1) !== snapshot.nextSequence - 1)
      || new Set(snapshot.events.map(event => event.eventId)).size !== snapshot.events.length
      || snapshot.events.reduce((total, event) => total + eventBytes(event), 0) > this.maxBytes) {
      throw new Error('event state contains invalid sequence or retention data')
    }
    this.epoch = snapshot.epoch
    this.nextSequence = snapshot.nextSequence
    this.events = [...snapshot.events]
  }

  currentCursor(): string {
    return `${this.epoch}.${this.nextSequence - 1}`
  }

  publish(payload: JarvisEventPayload): JarvisEvent {
    const event = {
      version: 1 as const,
      eventId: randomUUID(),
      cursor: `${this.epoch}.${this.nextSequence}`,
      occurredAt: this.now(),
      ...payload,
    } as JarvisEvent
    if (!validEvent(event, this.epoch)) throw new TypeError('event payload is invalid')
    const previousNextSequence = this.nextSequence
    const previousEvents = this.events
    this.nextSequence += 1
    this.events = [...this.events, event]
    let bytes = this.events.reduce((total, item) => total + eventBytes(item), 0)
    while (this.events.length > 1 && (this.events.length > this.maxEvents || bytes > this.maxBytes)) {
      bytes -= eventBytes(this.events.shift() as JarvisEvent)
    }
    if (bytes > this.maxBytes) {
      this.events = previousEvents
      this.nextSequence = previousNextSequence
      throw new RangeError('event exceeds the retention byte limit')
    }
    try {
      this.persist()
    } catch (error) {
      this.events = previousEvents
      this.nextSequence = previousNextSequence
      throw error
    }
    for (const listener of this.listeners) listener(event)
    return event
  }

  replay(cursor?: string): EventReplay {
    const current = this.currentCursor()
    if (cursor === undefined) return { cursor: current, events: [], requiresSnapshot: true, reason: 'initial' }
    const parsed = parseCursor(cursor)
    if (parsed === undefined) return { cursor: current, events: [], requiresSnapshot: true, reason: 'invalid_cursor' }
    if (parsed.epoch !== this.epoch) return { cursor: current, events: [], requiresSnapshot: true, reason: 'gateway_restarted' }
    const currentSequence = this.nextSequence - 1
    if (parsed.sequence > currentSequence) return { cursor: current, events: [], requiresSnapshot: true, reason: 'cursor_ahead' }
    const oldestSequence = this.events.length === 0
      ? currentSequence + 1
      : parseCursor((this.events[0] as JarvisEvent).cursor)?.sequence as number
    if (parsed.sequence < oldestSequence - 1) {
      return { cursor: current, events: [], requiresSnapshot: true, reason: 'cursor_expired' }
    }
    return {
      cursor: current,
      events: this.events.filter(event => (parseCursor(event.cursor)?.sequence as number) > parsed.sequence),
      requiresSnapshot: false,
    }
  }

  subscribe(listener: (event: JarvisEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private persist(): void {
    this.store?.save({ version: 1, epoch: this.epoch, nextSequence: this.nextSequence, events: this.events })
  }
}
