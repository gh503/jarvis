import { NodeCommandWorker, NodePolicy, type NodeCommand, type NodeCommandOutcome, type NodeCommandTransition } from './node-command.js'
import { createNodeRegistration, type NodeRegistration } from './node-capabilities.js'

const SOCKET_OPEN = 1

export type NodeAgentState = 'stopped' | 'connecting' | 'connected' | 'ready' | 'backoff'

interface SocketMessageEvent {
  data: unknown
}

export interface OutboundSocket {
  readonly readyState: number
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: SocketMessageEvent) => void): void
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type OutboundSocketFactory = (endpoint: string) => OutboundSocket

export interface NodeAgentTimers {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface NodeAgentConfig {
  endpoint: string
  credential?: string
  credentialProvider?: () => Promise<string | undefined>
  registration: Omit<NodeRegistration, 'protocolVersion'>
  policy: NodePolicy
  execute: (command: NodeCommand) => Promise<unknown>
  socketFactory?: OutboundSocketFactory
  timers?: NodeAgentTimers
  reconnectDelayMs?: number
  now?: () => number
  maxConcurrency?: number
}

type WireMessage = Record<string, unknown>

function defaultSocketFactory(endpoint: string): OutboundSocket {
  return new WebSocket(endpoint) as unknown as OutboundSocket
}

function defaultTimers(): NodeAgentTimers {
  return {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
}

function parseWireMessage(data: unknown): WireMessage | undefined {
  if (typeof data !== 'string') return undefined
  try {
    const value: unknown = JSON.parse(data)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as WireMessage
      : undefined
  } catch {
    return undefined
  }
}

function parseCommand(value: unknown): NodeCommand | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.commandId !== 'string'
    || typeof record.idempotencyKey !== 'string'
    || typeof record.nodeId !== 'string'
    || typeof record.capability !== 'string'
    || typeof record.capabilityVersion !== 'number'
    || !Number.isInteger(record.capabilityVersion)
    || typeof record.expiresAt !== 'number'
    || !Number.isFinite(record.expiresAt)
    || !('arguments' in record)) return undefined
  return {
    commandId: record.commandId,
    idempotencyKey: record.idempotencyKey,
    nodeId: record.nodeId,
    capability: record.capability,
    capabilityVersion: record.capabilityVersion,
    arguments: record.arguments,
    expiresAt: record.expiresAt,
  }
}

export class NodeAgent {
  private readonly socketFactory: OutboundSocketFactory
  private readonly timers: NodeAgentTimers
  private readonly reconnectDelayMs: number
  private readonly registration: NodeRegistration
  private readonly worker: NodeCommandWorker
  private stateValue: NodeAgentState = 'stopped'
  private socket: OutboundSocket | undefined
  private reconnectHandle: unknown
  private authenticated = false
  private stopped = true
  private credentialValue: string | undefined

  constructor(private readonly config: NodeAgentConfig) {
    const endpoint = new URL(config.endpoint)
    if (endpoint.protocol !== 'wss:') throw new Error('node agent endpoint must use wss://')
    if ((config.credential === undefined) === (config.credentialProvider === undefined)) {
      throw new Error('node agent requires exactly one credential source')
    }
    if (config.credential !== undefined && config.credential.length < 1) {
      throw new Error('node agent credential must not be empty')
    }
    this.registration = createNodeRegistration(config.registration)
    this.socketFactory = config.socketFactory ?? defaultSocketFactory
    this.timers = config.timers ?? defaultTimers()
    this.reconnectDelayMs = config.reconnectDelayMs ?? 1_000
    if (!Number.isInteger(this.reconnectDelayMs) || this.reconnectDelayMs < 1) {
      throw new RangeError('reconnectDelayMs must be a positive integer')
    }
    this.worker = new NodeCommandWorker(
      this.registration.nodeId,
      config.policy,
      config.execute,
      config.now,
      config.maxConcurrency,
      transition => this.handleTransition(transition),
    )
  }

  get state(): NodeAgentState {
    return this.stateValue
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    try {
      const credential = this.config.credentialProvider === undefined
        ? this.config.credential
        : await this.config.credentialProvider()
      if (credential === undefined || credential.length < 1) throw new Error('node agent credential is unavailable')
      if (this.stopped) return
      this.credentialValue = credential
    } catch {
      this.stopped = true
      this.stateValue = 'stopped'
      this.credentialValue = undefined
      throw new Error('node agent credential load failed')
    }
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.stateValue = 'stopped'
    this.authenticated = false
    this.credentialValue = undefined
    if (this.reconnectHandle !== undefined) {
      this.timers.clearTimeout(this.reconnectHandle)
      this.reconnectHandle = undefined
    }
    const socket = this.socket
    this.socket = undefined
    socket?.close(1000, 'node agent stopped')
  }

  private connect(): void {
    if (this.stopped) return
    this.stateValue = 'connecting'
    const socket = this.socketFactory(this.config.endpoint)
    this.socket = socket
    socket.addEventListener('open', () => this.handleOpen(socket))
    socket.addEventListener('message', event => this.handleMessage(socket, event.data))
    socket.addEventListener('close', () => this.handleClose(socket))
    socket.addEventListener('error', () => this.handleClose(socket))
  }

  private handleOpen(socket: OutboundSocket): void {
    if (socket !== this.socket || this.stopped) return
    this.stateValue = 'connected'
    this.send(socket, {
      type: 'node.authenticate',
      protocolVersion: this.registration.protocolVersion,
      nodeId: this.registration.nodeId,
      credential: this.credentialValue,
    })
  }

  private handleMessage(socket: OutboundSocket, data: unknown): void {
    if (socket !== this.socket || this.stopped) return
    const message = parseWireMessage(data)
    if (message === undefined || typeof message.type !== 'string') {
      this.sendError(socket, 'invalid wire message')
      return
    }
    if (message.type === 'node.authenticated') {
      this.authenticated = true
      this.send(socket, { type: 'node.register', registration: this.registration })
      return
    }
    if (message.type === 'node.ready') {
      if (!this.authenticated) {
        this.rejectConnection(socket, 'node ready received before authentication')
        return
      }
      this.stateValue = 'ready'
      return
    }
    if (message.type === 'node.rejected') {
      this.rejectConnection(socket, 'node authentication rejected')
      return
    }
    if (message.type === 'command.requested') {
      if (this.stateValue !== 'ready') {
        this.sendError(socket, 'command received before node ready')
        return
      }
      const command = parseCommand(message.command)
      if (command === undefined) {
        this.sendError(socket, 'invalid command')
        return
      }
      void this.worker.dispatch(command).then(outcome => {
        if (socket === this.socket && this.stateValue === 'ready') {
          this.send(socket, { type: 'command.outcome', outcome })
        }
      })
      return
    }
    this.sendError(socket, `unsupported wire message: ${message.type}`)
  }

  private handleClose(socket: OutboundSocket): void {
    if (socket !== this.socket) return
    this.socket = undefined
    this.authenticated = false
    if (this.stopped) return
    this.stateValue = 'backoff'
    this.reconnectHandle = this.timers.setTimeout(() => {
      this.reconnectHandle = undefined
      this.connect()
    }, this.reconnectDelayMs)
  }

  private handleTransition(transition: NodeCommandTransition): void {
    if (this.stateValue !== 'ready' || this.socket === undefined) return
    if (transition.state === 'acknowledged' || transition.state === 'running') {
      this.send(this.socket, {
        type: `command.${transition.state}`,
        commandId: transition.command.commandId,
        idempotencyKey: transition.command.idempotencyKey,
      })
    }
  }

  private sendError(socket: OutboundSocket, reason: string): void {
    this.send(socket, { type: 'node.error', reason })
  }

  private rejectConnection(socket: OutboundSocket, reason: string): void {
    this.sendError(socket, reason)
    this.stopped = true
    this.stateValue = 'stopped'
    this.authenticated = false
    this.socket = undefined
    socket.close(1008, reason)
  }

  private send(socket: OutboundSocket, message: WireMessage): void {
    if (socket.readyState !== SOCKET_OPEN) return
    socket.send(JSON.stringify(message))
  }
}
