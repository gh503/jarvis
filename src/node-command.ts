import { commandDigest } from './approval.js'

export type NodeCommandState = 'acknowledged' | 'running' | 'succeeded' | 'failed' | 'expired' | 'denied'

export interface NodeCommand {
  commandId: string
  idempotencyKey: string
  nodeId: string
  capability: string
  capabilityVersion: number
  arguments: unknown
  expiresAt: number
}

export interface NodeCommandOutcome {
  commandId: string
  idempotencyKey: string
  capability: string
  state: NodeCommandState
  result?: unknown
  error?: string
}

export interface NodeCapabilityPolicy {
  enabled?: boolean
  version: number
  allowedApplications?: readonly string[]
}

export interface NodePolicyConfig {
  capabilities: Readonly<Record<string, NodeCapabilityPolicy>>
}

export type NodeCommandTransition = {
  command: NodeCommand
  state: NodeCommandState
}

function applicationFromArguments(argumentsValue: unknown): string | undefined {
  if (typeof argumentsValue !== 'object' || argumentsValue === null) return undefined
  const application = Reflect.get(argumentsValue, 'application')
  return typeof application === 'string' ? application : undefined
}

export class NodePolicy {
  private paused = false

  constructor(private readonly config: NodePolicyConfig) {}

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  denial(command: NodeCommand): string | undefined {
    if (this.paused) return 'node policy is paused'
    const capability = this.config.capabilities[command.capability]
    if (capability === undefined || capability.enabled === false) {
      return `capability is not enabled: ${command.capability}`
    }
    if (capability.version !== command.capabilityVersion) {
      return `capability version is not supported: ${command.capability}@${command.capabilityVersion}`
    }
    if (capability.allowedApplications !== undefined) {
      const application = applicationFromArguments(command.arguments)
      if (application === undefined || !capability.allowedApplications.includes(application)) {
        return `application is not allowed for capability: ${String(application)}`
      }
    }
    return undefined
  }
}

type PendingCommand = {
  command: NodeCommand
  resolve: (outcome: NodeCommandOutcome) => void
}

type OutcomeRecord = {
  fingerprint: string
  promise: Promise<NodeCommandOutcome>
}

function commandFingerprint(command: NodeCommand): string {
  return commandDigest({
    nodeId: command.nodeId,
    capability: command.capability,
    capabilityVersion: command.capabilityVersion,
    arguments: command.arguments,
    expiresAt: command.expiresAt,
  })
}

export class NodeCommandWorker {
  private readonly outcomes = new Map<string, OutcomeRecord>()
  private readonly queue: PendingCommand[] = []
  private active = 0

  constructor(
    private readonly nodeId: string,
    private readonly policy: NodePolicy,
    private readonly execute: (command: NodeCommand) => Promise<unknown>,
    private readonly now: () => number = Date.now,
    private readonly maxConcurrency = 1,
    private readonly onTransition?: (transition: NodeCommandTransition) => void,
  ) {
    if (maxConcurrency < 1 || !Number.isInteger(maxConcurrency)) {
      throw new RangeError('maxConcurrency must be a positive integer')
    }
  }

  dispatch(command: NodeCommand): Promise<NodeCommandOutcome> {
    const fingerprint = commandFingerprint(command)
    const existing = this.outcomes.get(command.idempotencyKey)
    if (existing !== undefined) {
      if (existing.fingerprint === fingerprint) return existing.promise
      return Promise.resolve(this.finish(command, 'denied', 'idempotency key was reused for a different command'))
    }

    const denial = command.nodeId === this.nodeId
      ? this.policy.denial(command)
      : `command targets a different node: ${command.nodeId}`
    if (denial !== undefined) {
      const outcome = Promise.resolve(this.finish(command, 'denied', denial))
      this.outcomes.set(command.idempotencyKey, { fingerprint, promise: outcome })
      return outcome
    }
    if (command.expiresAt <= this.now()) {
      const outcome = Promise.resolve(this.finish(command, 'expired'))
      this.outcomes.set(command.idempotencyKey, { fingerprint, promise: outcome })
      return outcome
    }

    let resolveOutcome!: (outcome: NodeCommandOutcome) => void
    const outcome = new Promise<NodeCommandOutcome>(resolve => { resolveOutcome = resolve })
    this.outcomes.set(command.idempotencyKey, { fingerprint, promise: outcome })
    this.transition(command, 'acknowledged')
    this.queue.push({ command, resolve: resolveOutcome })
    this.pump()
    return outcome
  }

  private pump(): void {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const pending = this.queue.shift()
      if (pending === undefined) return
      if (pending.command.expiresAt <= this.now()) {
        pending.resolve(this.finish(pending.command, 'expired'))
        continue
      }
      this.active += 1
      this.transition(pending.command, 'running')
      void this.execute(pending.command)
        .then(result => pending.resolve(this.finish(pending.command, 'succeeded', undefined, result)))
        .catch(error => pending.resolve(this.finish(pending.command, 'failed', String(error))))
        .finally(() => {
          this.active -= 1
          this.pump()
        })
    }
  }

  private finish(
    command: NodeCommand,
    state: Exclude<NodeCommandState, 'acknowledged' | 'running'>,
    error?: string,
    result?: unknown,
  ): NodeCommandOutcome {
    this.transition(command, state)
    return {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      capability: command.capability,
      state,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    }
  }

  private transition(command: NodeCommand, state: NodeCommandState): void {
    this.onTransition?.({ command, state })
  }
}
