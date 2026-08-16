import { WebSocket, type RawData } from 'ws'
import {
  APPROVAL_TTL_MS,
  MobileApprovalDecisionError,
  commandDigest,
  type MobileApproval,
  type MobileApprovalDecisionReceipt,
  type MobileApprovalOutcome,
} from './approval.js'
import type { JarvisEventPayload } from './event-log.js'
import {
  conversationMessageFromHarnessEvent,
  type ConversationSummary,
} from './harness-bridge.js'

const DEFAULT_RECONNECT_DELAY_MS = 1_000
const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const MAX_RECEIPT_BYTES = 64 * 1024
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

type ChannelName = 'mux' | 'host'

export interface ConversationEventSourceHandlers {
  onEvent(event: JarvisEventPayload): void
  onAvailability(available: boolean): void
}

export interface ConversationEventSource {
  start(handlers: ConversationEventSourceHandlers): void
  stop(): Promise<void>
  listApprovals(): readonly MobileApproval[]
  decideApproval(
    approvalId: string,
    digest: string | null,
    outcome: MobileApprovalOutcome,
    idempotencyKey: string,
  ): Promise<MobileApprovalDecisionReceipt>
}

export interface HarnessEventBridgeOptions {
  origin?: string
  reconnectDelayMs?: number
  maxFrameBytes?: number
  listVisibleConversations: () => Promise<readonly ConversationSummary[]>
  socketFactory?: (url: string, maxPayload: number) => WebSocket
  fetch?: typeof fetch
  now?: () => number
  requestTimeoutMs?: number
}

interface ChannelState {
  socket: WebSocket | undefined
  reconnectTimer: ReturnType<typeof setTimeout> | undefined
  open: boolean
}

interface ToolCallEvidence {
  conversationId: string
  callId: string
  toolName: string
  arguments: unknown
}

interface AskedEvidence {
  approvalId: string
  conversationId: string
  callId: string
  toolName: string
  requestedAt: number
}

interface PendingApproval {
  rpcId: string
  approvalId: string
  conversationId: string
  toolName: string
  callId: string | null
  announced: boolean
  submitted: boolean
}

interface IdempotentDecision {
  fingerprint: string
  promise: Promise<MobileApprovalDecisionReceipt>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key)) && allowed.every(key => Object.hasOwn(value, key))
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  return value
}

function validateOrigin(value: string): URL {
  const origin = new URL(value)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
    || origin.username !== '' || origin.password !== '' || origin.pathname !== '/'
    || origin.search !== '' || origin.hash !== '') {
    throw new Error('Harness event origin must be an exact http://127.0.0.1[:port] origin')
  }
  return origin
}

function sessionId(value: unknown): string | undefined {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : undefined
}

function opaqueId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined
}

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined
}

function socketUrl(origin: URL, channel: ChannelName): string {
  const url = new URL(`/api/events.${channel}`, origin)
  url.protocol = 'ws:'
  return url.toString()
}

export class HarnessEventBridge implements ConversationEventSource {
  private readonly origin: URL
  private readonly reconnectDelayMs: number
  private readonly maxFrameBytes: number
  private readonly listVisibleConversations: () => Promise<readonly ConversationSummary[]>
  private readonly socketFactory: (url: string, maxPayload: number) => WebSocket
  private readonly fetchValue: typeof fetch
  private readonly now: () => number
  private readonly requestTimeoutMs: number
  private readonly channels: Record<ChannelName, ChannelState> = {
    mux: { socket: undefined, reconnectTimer: undefined, open: false },
    host: { socket: undefined, reconnectTimer: undefined, open: false },
  }
  private readonly visibleSessions = new Set<string>()
  private readonly toolCalls = new Map<string, ToolCallEvidence>()
  private readonly asked = new Map<string, AskedEvidence>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly idempotentDecisions = new Map<string, IdempotentDecision>()
  private handlers: ConversationEventSourceHandlers | undefined
  private stopped = true
  private available = false
  private visibilityGeneration = 0

  constructor(options: HarnessEventBridgeOptions) {
    this.origin = validateOrigin(options.origin ?? 'http://127.0.0.1:3080')
    this.reconnectDelayMs = positiveInteger(options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS, 'reconnectDelayMs')
    this.maxFrameBytes = positiveInteger(options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES, 'maxFrameBytes')
    this.listVisibleConversations = options.listVisibleConversations
    this.socketFactory = options.socketFactory ?? ((url, maxPayload) => new WebSocket(url, { maxPayload }))
    this.fetchValue = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs')
  }

  start(handlers: ConversationEventSourceHandlers): void {
    if (!this.stopped) throw new Error('Harness event bridge is already running')
    this.handlers = handlers
    this.stopped = false
    this.connect('mux')
    this.connect('host')
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.visibilityGeneration += 1
    this.setAvailable(false)
    for (const channel of Object.values(this.channels)) {
      if (channel.reconnectTimer !== undefined) clearTimeout(channel.reconnectTimer)
      channel.reconnectTimer = undefined
      channel.open = false
      channel.socket?.terminate()
      channel.socket = undefined
    }
    this.visibleSessions.clear()
    this.toolCalls.clear()
    this.asked.clear()
    this.pendingApprovals.clear()
    this.idempotentDecisions.clear()
    this.handlers = undefined
  }

  listApprovals(): readonly MobileApproval[] {
    return [...this.pendingApprovals.values()]
      .filter(pending => this.visibleSessions.has(pending.conversationId))
      .map(pending => this.viewOf(pending))
  }

  decideApproval(
    approvalId: string,
    digest: string | null,
    outcome: MobileApprovalOutcome,
    idempotencyKey: string,
  ): Promise<MobileApprovalDecisionReceipt> {
    if (opaqueId(approvalId) === undefined || (digest !== null && !/^[0-9a-f]{64}$/.test(digest))
      || (outcome !== 'allowed-once' && outcome !== 'rejected')
      || !/^[0-9a-f-]{36}$/.test(idempotencyKey)) {
      return Promise.reject(new MobileApprovalDecisionError('protocol'))
    }
    const fingerprint = JSON.stringify({ approvalId, digest, outcome })
    const previous = this.idempotentDecisions.get(idempotencyKey)
    if (previous !== undefined) {
      return previous.fingerprint === fingerprint
        ? previous.promise
        : Promise.reject(new MobileApprovalDecisionError('conflict'))
    }
    const pending = this.pendingApprovals.get(approvalId)
    if (pending === undefined || !this.visibleSessions.has(pending.conversationId)) {
      return Promise.reject(new MobileApprovalDecisionError('missing'))
    }
    if (!this.available) return Promise.reject(new MobileApprovalDecisionError('unavailable'))
    const view = this.viewOf(pending)
    if (outcome === 'allowed-once') {
      if (view.blockReason === 'expired') return Promise.reject(new MobileApprovalDecisionError('expired'))
      if (!view.canAllow || view.digest === null) return Promise.reject(new MobileApprovalDecisionError('unsupported'))
      if (digest !== view.digest) return Promise.reject(new MobileApprovalDecisionError('mismatch'))
    }
    if (pending.submitted) return Promise.reject(new MobileApprovalDecisionError('conflict'))
    pending.submitted = true
    const decision = this.submitDecision(pending, outcome).catch(error => {
      pending.submitted = false
      this.idempotentDecisions.delete(idempotencyKey)
      throw error
    })
    this.idempotentDecisions.set(idempotencyKey, { fingerprint, promise: decision })
    while (this.idempotentDecisions.size > 256) {
      this.idempotentDecisions.delete(this.idempotentDecisions.keys().next().value as string)
    }
    return decision
  }

  private connect(name: ChannelName): void {
    if (this.stopped) return
    const state = this.channels[name]
    let socket: WebSocket
    try {
      socket = this.socketFactory(socketUrl(this.origin, name), this.maxFrameBytes)
    } catch {
      this.scheduleReconnect(name)
      return
    }
    state.socket = socket
    socket.once('open', () => {
      if (state.socket !== socket || this.stopped) return
      state.open = true
      this.refreshVisibility()
    })
    socket.on('message', (data, isBinary) => {
      if (state.socket !== socket || this.stopped) return
      try {
        this.handleFrame(name, data, isBinary)
      } catch {
        socket.close(1002, 'invalid Harness event frame')
      }
    })
    const disconnected = (): void => {
      if (state.socket !== socket) return
      state.socket = undefined
      state.open = false
      this.visibilityGeneration += 1
      this.setAvailable(false)
      this.scheduleReconnect(name)
    }
    socket.once('close', disconnected)
    socket.once('error', disconnected)
  }

  private scheduleReconnect(name: ChannelName): void {
    if (this.stopped || this.channels[name].reconnectTimer !== undefined) return
    const timer = setTimeout(() => {
      const state = this.channels[name]
      state.reconnectTimer = undefined
      this.connect(name)
    }, this.reconnectDelayMs)
    timer.unref()
    this.channels[name].reconnectTimer = timer
  }

  private refreshVisibility(): void {
    if (!this.channels.mux.open || !this.channels.host.open || this.stopped) return
    const generation = ++this.visibilityGeneration
    void this.listVisibleConversations().then(conversations => {
      if (this.stopped || generation !== this.visibilityGeneration
        || !this.channels.mux.open || !this.channels.host.open) return
      this.visibleSessions.clear()
      for (const conversation of conversations) this.visibleSessions.add(conversation.id)
      this.setAvailable(true)
      this.announceApprovals()
    }).catch(() => {
      if (generation !== this.visibilityGeneration || this.stopped) return
      this.setAvailable(false)
      this.channels.mux.socket?.close(1011, 'Harness visibility unavailable')
      this.channels.host.socket?.close(1011, 'Harness visibility unavailable')
    })
  }

  private setAvailable(value: boolean): void {
    if (this.available === value) return
    this.available = value
    this.handlers?.onAvailability(value)
  }

  private handleFrame(channel: ChannelName, data: RawData, isBinary: boolean): void {
    if (isBinary) throw new Error('binary Harness event frame')
    let envelope: unknown
    try {
      envelope = JSON.parse(data.toString()) as unknown
    } catch {
      throw new Error('malformed Harness event frame')
    }
    if (!record(envelope) || envelope.type !== 'server-request' || typeof envelope.rpcId !== 'string'
      || typeof envelope.method !== 'string' || !record(envelope.payload)
      || envelope.method !== envelope.payload.type) throw new Error('invalid Harness event envelope')
    if (envelope.payload.type === 'stream/error') throw new Error('Harness event stream failed')
    if (channel === 'mux') this.handleMux(envelope.rpcId, envelope.payload)
    else this.handleHost(envelope.payload)
  }

  private handleMux(rpcId: string, payload: Record<string, unknown>): void {
    if (payload.type === 'session/subscribed') {
      if (sessionId(payload.sessionId) === undefined || !Number.isInteger(payload.lastSeq) || (payload.lastSeq as number) < -1) {
        throw new Error('invalid Harness subscription frame')
      }
      return
    }
    if (payload.type === 'approval/requested') {
      this.handleApprovalRequested(rpcId, payload)
      return
    }
    if (payload.type === 'approval/resolved') {
      this.handleApprovalResolved(payload)
      return
    }
    if (payload.type !== 'session/event') return
    const conversationId = sessionId(payload.sessionId)
    if (conversationId === undefined || !record(payload.event)) throw new Error('invalid Harness session event frame')
    this.captureApprovalEvidence(conversationId, payload.event)
    if (!this.available || !this.visibleSessions.has(conversationId)) return
    const message = conversationMessageFromHarnessEvent(payload.event)
    if (message !== undefined) {
      this.handlers?.onEvent({ type: 'conversation.message.committed', conversationId, message })
    }
  }

  private captureApprovalEvidence(conversationId: string, event: Record<string, unknown>): void {
    if (!record(event.data)) return
    if (event.type === 'tool/call') {
      const callId = opaqueId(event.data.callId)
      const toolName = boundedText(event.data.name)
      if (callId === undefined || toolName === undefined || typeof event.data.arguments !== 'string') return
      let argumentsValue: unknown
      try {
        argumentsValue = JSON.parse(event.data.arguments) as unknown
      } catch {
        return
      }
      this.toolCalls.set(`${conversationId}\0${callId}`, { conversationId, callId, toolName, arguments: argumentsValue })
      while (this.toolCalls.size > 512) this.toolCalls.delete(this.toolCalls.keys().next().value as string)
      return
    }
    if (event.type === 'approval/asked') {
      const approvalId = opaqueId(event.data.id)
      const callId = opaqueId(event.data.callId)
      const toolName = boundedText(event.data.toolName)
      if (approvalId === undefined || callId === undefined || toolName === undefined
        || typeof event.time !== 'number' || !Number.isFinite(event.time)) return
      this.asked.set(approvalId, { approvalId, conversationId, callId, toolName, requestedAt: event.time })
      while (this.asked.size > 512) this.asked.delete(this.asked.keys().next().value as string)
    }
  }

  private handleApprovalRequested(rpcId: string, payload: Record<string, unknown>): void {
    const approvalId = opaqueId(payload.approvalId)
    const conversationId = sessionId(payload.sessionId)
    const toolName = boundedText(payload.toolName)
    const callId = payload.callId === undefined ? null : opaqueId(payload.callId)
    if (approvalId === undefined || conversationId === undefined || toolName === undefined
      || (payload.callId !== undefined && callId === undefined)) throw new Error('invalid Harness approval request frame')
    const previous = this.pendingApprovals.get(approvalId)
    this.pendingApprovals.set(approvalId, {
      rpcId,
      approvalId,
      conversationId,
      toolName,
      callId: callId ?? null,
      announced: previous?.announced ?? false,
      submitted: previous?.submitted ?? false,
    })
    this.announceApprovals()
  }

  private handleApprovalResolved(payload: Record<string, unknown>): void {
    const approvalId = opaqueId(payload.approvalId)
    const conversationId = sessionId(payload.sessionId)
    const outcome = payload.outcome
    if (approvalId === undefined || conversationId === undefined
      || (outcome !== 'allowed-once' && outcome !== 'rejected' && outcome !== 'cancelled' && outcome !== 'unavailable')) {
      throw new Error('invalid Harness approval resolution frame')
    }
    const pending = this.pendingApprovals.get(approvalId)
    this.pendingApprovals.delete(approvalId)
    this.asked.delete(approvalId)
    if (pending?.callId !== undefined && pending.callId !== null) {
      this.toolCalls.delete(`${pending.conversationId}\0${pending.callId}`)
    }
    if (this.available && this.visibleSessions.has(conversationId)) {
      this.handlers?.onEvent({ type: 'approval.resolved', approvalId, conversationId, outcome })
    }
  }

  private announceApprovals(): void {
    if (!this.available) return
    for (const pending of this.pendingApprovals.values()) {
      if (pending.announced || !this.visibleSessions.has(pending.conversationId)) continue
      pending.announced = true
      this.handlers?.onEvent({ type: 'approval.pending', approval: this.viewOf(pending) })
    }
  }

  private viewOf(pending: PendingApproval): MobileApproval {
    const evidence = this.asked.get(pending.approvalId)
    const call = pending.callId === null ? undefined : this.toolCalls.get(`${pending.conversationId}\0${pending.callId}`)
    const correlated = evidence !== undefined && call !== undefined
      && evidence.conversationId === pending.conversationId && call.conversationId === pending.conversationId
      && evidence.callId === pending.callId && call.callId === pending.callId
      && evidence.toolName === pending.toolName && call.toolName === pending.toolName
    if (pending.toolName !== 'jarvis_open_app') return this.blockedView(pending, 'unsupported_action')
    if (!correlated || !record(call.arguments) || !exactFields(call.arguments, ['application'])
      || typeof call.arguments.application !== 'string' || call.arguments.application.length < 1
      || call.arguments.application.length > 128) return this.blockedView(pending, 'evidence_missing')
    const requestedAt = evidence.requestedAt
    const expiresAt = requestedAt + APPROVAL_TTL_MS
    const expired = expiresAt <= this.now()
    const application = call.arguments.application
    return {
      id: pending.approvalId,
      conversationId: pending.conversationId,
      toolName: pending.toolName,
      callId: pending.callId,
      action: 'open_app',
      target: application,
      arguments: { application },
      digest: commandDigest({ action: 'open_app', application }),
      risk: 'high',
      requestedAt,
      expiresAt,
      canAllow: !expired,
      blockReason: expired ? 'expired' : null,
    }
  }

  private blockedView(pending: PendingApproval, blockReason: 'evidence_missing' | 'unsupported_action'): MobileApproval {
    return {
      id: pending.approvalId,
      conversationId: pending.conversationId,
      toolName: pending.toolName,
      callId: pending.callId,
      action: 'unsupported',
      target: null,
      arguments: null,
      digest: null,
      risk: 'high',
      requestedAt: null,
      expiresAt: null,
      canAllow: false,
      blockReason,
    }
  }

  private async submitDecision(pending: PendingApproval, outcome: MobileApprovalOutcome): Promise<MobileApprovalDecisionReceipt> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), this.requestTimeoutMs)
    timer.unref()
    try {
      const response = await this.fetchValue(new URL('/api/respond', this.origin), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-response',
          rpcId: pending.rpcId,
          result: { ok: true, value: { sessionId: pending.conversationId, approvalId: pending.approvalId, outcome } },
        }),
        redirect: 'error',
        signal: abort.signal,
      })
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        throw new MobileApprovalDecisionError('protocol')
      }
      const declared = response.headers.get('content-length')
      if (declared !== null && Number(declared) > MAX_RECEIPT_BYTES) throw new MobileApprovalDecisionError('protocol')
      if (response.body === null) throw new MobileApprovalDecisionError('protocol')
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.byteLength
        if (size > MAX_RECEIPT_BYTES) throw new MobileApprovalDecisionError('protocol')
        chunks.push(chunk)
      }
      let value: unknown
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      } catch {
        throw new MobileApprovalDecisionError('protocol')
      }
      if (!record(value) || typeof value.accepted !== 'boolean') throw new MobileApprovalDecisionError('protocol')
      if (!value.accepted) {
        if (value.reason === 'not-pending') {
          this.pendingApprovals.delete(pending.approvalId)
          throw new MobileApprovalDecisionError('missing')
        }
        throw new MobileApprovalDecisionError('protocol')
      }
      return { approvalId: pending.approvalId, outcome, accepted: true }
    } catch (error) {
      if (error instanceof MobileApprovalDecisionError) throw error
      throw new MobileApprovalDecisionError('unavailable')
    } finally {
      clearTimeout(timer)
    }
  }

  private handleHost(payload: Record<string, unknown>): void {
    const conversationId = sessionId(payload.sessionId)
    if (payload.type === 'host/session-added') {
      if (conversationId === undefined || typeof payload.blank !== 'boolean') throw new Error('invalid Harness session-added frame')
      if (payload.origin !== undefined && payload.origin !== 'subagent') throw new Error('invalid Harness session origin')
      if (payload.origin === 'subagent') return
      this.visibleSessions.add(conversationId)
      if (this.available) {
        this.handlers?.onEvent({ type: 'conversation.created', conversation: { id: conversationId, blank: payload.blank } })
      }
      return
    }
    if (payload.type === 'host/session-removed') {
      if (conversationId === undefined) throw new Error('invalid Harness session-removed frame')
      if (!this.visibleSessions.delete(conversationId) || !this.available) return
      this.handlers?.onEvent({ type: 'conversation.removed', conversationId })
      return
    }
    if (payload.type === 'host/session-status') {
      if (conversationId === undefined || typeof payload.running !== 'boolean') throw new Error('invalid Harness session-status frame')
      if (!this.available || !this.visibleSessions.has(conversationId)) return
      this.handlers?.onEvent({ type: 'conversation.status', conversationId, running: payload.running })
    } else if (payload.type === 'host/agent-error') {
      if (conversationId === undefined || typeof payload.message !== 'string') throw new Error('invalid Harness agent-error frame')
      if (!this.available || !this.visibleSessions.has(conversationId)) return
      this.handlers?.onEvent({ type: 'conversation.error', conversationId, code: 'harness_agent_error' })
    }
  }
}
