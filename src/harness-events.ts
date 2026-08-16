import { WebSocket, type RawData } from 'ws'
import type { JarvisEventPayload } from './event-log.js'
import {
  conversationMessageFromHarnessEvent,
  type ConversationSummary,
} from './harness-bridge.js'

const DEFAULT_RECONNECT_DELAY_MS = 1_000
const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

type ChannelName = 'mux' | 'host'

export interface ConversationEventSourceHandlers {
  onEvent(event: JarvisEventPayload): void
  onAvailability(available: boolean): void
}

export interface ConversationEventSource {
  start(handlers: ConversationEventSourceHandlers): void
  stop(): Promise<void>
}

export interface HarnessEventBridgeOptions {
  origin?: string
  reconnectDelayMs?: number
  maxFrameBytes?: number
  listVisibleConversations: () => Promise<readonly ConversationSummary[]>
  socketFactory?: (url: string, maxPayload: number) => WebSocket
}

interface ChannelState {
  socket: WebSocket | undefined
  reconnectTimer: ReturnType<typeof setTimeout> | undefined
  open: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  private readonly channels: Record<ChannelName, ChannelState> = {
    mux: { socket: undefined, reconnectTimer: undefined, open: false },
    host: { socket: undefined, reconnectTimer: undefined, open: false },
  }
  private readonly visibleSessions = new Set<string>()
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
    this.handlers = undefined
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
    if (channel === 'mux') this.handleMux(envelope.payload)
    else this.handleHost(envelope.payload)
  }

  private handleMux(payload: Record<string, unknown>): void {
    if (payload.type === 'session/subscribed') {
      if (sessionId(payload.sessionId) === undefined || !Number.isInteger(payload.lastSeq) || (payload.lastSeq as number) < -1) {
        throw new Error('invalid Harness subscription frame')
      }
      return
    }
    if (payload.type !== 'session/event') return
    const conversationId = sessionId(payload.sessionId)
    if (conversationId === undefined || !record(payload.event)) throw new Error('invalid Harness session event frame')
    if (!this.available || !this.visibleSessions.has(conversationId)) return
    const message = conversationMessageFromHarnessEvent(payload.event)
    if (message !== undefined) {
      this.handlers?.onEvent({ type: 'conversation.message.committed', conversationId, message })
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
