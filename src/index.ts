import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ApprovalLedger } from './approval.js'
import { AppRegistry } from './apps.js'
import { AuditLog } from './audit.js'
import { DeviceCommandGatewayClient } from './device-command-client.js'
import { recallForModel } from './memory-recall.js'
import { MemoryStore } from './memory.js'
import { MqttCommandGatewayClient } from './mqtt-command-client.js'
import { ReminderStore, type Reminder } from './reminders.js'
import { readSystemStatus } from './system-status.js'

export const name = 'jarvis-mac-mvp'
export const inject = ['tools', 'webServer']

const JARVIS_TOOLS = new Set([
  'jarvis_system_status', 'jarvis_open_app', 'jarvis_reminder', 'jarvis_memory_recall',
  'jarvis_device_control', 'jarvis_mqtt_device_control',
])

function reminderOutput(reminders: Reminder[]) {
  return { reminders }
}

function safeAuditDetail(tool: string, argumentsValue: unknown): Record<string, string> | undefined {
  if (typeof argumentsValue !== 'object' || argumentsValue === null) return undefined
  const detail: Record<string, string> = {}
  const keys = tool === 'jarvis_open_app'
    ? ['application']
    : tool === 'jarvis_memory_recall'
      ? ['class', 'limit']
    : tool === 'jarvis_device_control'
      ? ['capability', 'externalEntityId', 'service', 'expectedState']
      : tool === 'jarvis_mqtt_device_control'
        ? ['capability', 'expectedState']
      : ['action', 'id', 'dueAt']
  for (const key of keys) {
    const value = Reflect.get(argumentsValue, key)
    if (typeof value === 'string') detail[key] = value.slice(0, 200)
  }
  return Object.keys(detail).length === 0 ? undefined : detail
}

export async function apply(ctx: Context): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const dataDir = resolve(process.env.JARVIS_DATA_DIR ?? join(projectRoot, 'data'))
  const apps = await AppRegistry.load(join(projectRoot, 'config', 'apps.json'))
  const audit = new AuditLog(dataDir)
  const reminders = new ReminderStore(dataDir)
  const approvals = new ApprovalLedger()
  const deviceCommandToken = process.env.JARVIS_DEVICE_COMMAND_TOKEN
  const deviceClient = deviceCommandToken === undefined ? undefined : new DeviceCommandGatewayClient({
    url: process.env.JARVIS_DEVICE_GATEWAY_URL ?? 'http://127.0.0.1:3090',
    token: deviceCommandToken,
  })
  const mqttClient = deviceCommandToken === undefined ? undefined : new MqttCommandGatewayClient({
    url: process.env.JARVIS_DEVICE_GATEWAY_URL ?? 'http://127.0.0.1:3090',
    token: deviceCommandToken,
  })
  const memories = new MemoryStore(dataDir)
  await Promise.all([audit.initialize(), reminders.initialize(), memories.initialize()])

  ctx.tools.guard(exec => JARVIS_TOOLS.has(exec.name) || exec.name === 'ask_user_question'
    ? undefined
    : `Jarvis MVP blocks non-Jarvis tool "${exec.name}"`)

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!JARVIS_TOOLS.has(exec.name) && exec.name !== 'ask_user_question') {
      await audit.append({
        tool: exec.name,
        callId: String(exec.callId),
        phase: 'policy',
        decision: 'denied',
      })
      return { kind: 'deny', reason: `Jarvis MVP blocks non-Jarvis tool "${exec.name}"` }
    }
    if (!JARVIS_TOOLS.has(exec.name)) return next()
    const detail = safeAuditDetail(exec.name, exec.arguments)
    if (exec.name === 'jarvis_open_app') {
      const application = typeof exec.arguments === 'object' && exec.arguments !== null
        ? Reflect.get(exec.arguments, 'application')
        : undefined
      const definition = typeof application === 'string' ? apps.resolve(application) : undefined
      if (definition === undefined) {
        await audit.append({
          tool: exec.name,
          callId: String(exec.callId),
          phase: 'policy',
          decision: 'denied',
          ...(detail === undefined ? {} : { detail }),
        })
        return { kind: 'deny', reason: `Application is not allowlisted. Allowed values: ${apps.keys().join(', ')}` }
      }
      const approval = approvals.propose(String(exec.callId), {
        action: 'open_app',
        application,
      })
      const approvalDetail = {
        ...(detail ?? {}),
        digest: approval.digest,
        expiresAt: new Date(approval.expiresAt).toISOString(),
      }
      await audit.append({
        tool: exec.name,
        callId: String(exec.callId),
        phase: 'policy',
        decision: 'awaiting-approval',
        detail: approvalDetail,
      })
      return {
        kind: 'ask',
        reason: `Open allowlisted application "${definition.displayName}" (${application}). Approval digest ${approval.digest}; expires in 60 seconds.`,
      }
    }
    await audit.append({
      tool: exec.name,
      callId: String(exec.callId),
      phase: 'policy',
      decision: 'allowed',
      ...(detail === undefined ? {} : { detail }),
    })
    return next()
  })

  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'jarvis_open_app') {
      const application = typeof exec.arguments === 'object' && exec.arguments !== null
        ? Reflect.get(exec.arguments, 'application')
        : undefined
      const approval = approvals.consume(String(exec.callId), {
        action: 'open_app',
        application,
      })
      await audit.append({
        tool: exec.name,
        callId: String(exec.callId),
        phase: 'dispatch',
        decision: 'approved',
        detail: { application: String(application), digest: approval.digest },
      })
    }
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    if (!JARVIS_TOOLS.has(exec.name)) return
    if (exec.name === 'jarvis_open_app') approvals.clear(String(exec.callId))
    const detail = safeAuditDetail(exec.name, exec.arguments)
    void audit.append({
      tool: exec.name,
      callId: String(exec.callId),
      phase: 'result',
      decision: result.isError ? 'failed' : 'completed',
      ...(detail === undefined ? {} : { detail }),
    }).catch(error => ctx.logger.error(`Jarvis audit append failed: ${String(error)}`))
  })

  ctx.tools.register(defineTool({
    name: 'jarvis_system_status',
    description: 'Read current macOS host status without changing the computer.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hostname: { type: 'string', required: true },
          platform: { type: 'string', required: true },
          release: { type: 'string', required: true },
          architecture: { type: 'string', required: true },
          uptimeMinutes: { type: 'integer', required: true },
          totalMemoryGB: { type: 'number', required: true },
          freeMemoryGB: { type: 'number', required: true },
          loadAverage: { type: 'array', required: true, items: { type: 'number' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      return readSystemStatus()
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jarvis_memory_recall',
    description: 'Recall bounded owner-confirmed, non-sensitive personal memory. This tool is read-only and may omit results because of privacy or output limits.',
    parameters: {
      class: { type: 'string', enum: ['profile', 'episodic'], description: 'Optional memory class filter' },
      limit: { type: 'integer', description: 'Maximum memories to return from 1 to 20; defaults to 10' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memories: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                class: { type: 'string', required: true, enum: ['profile', 'episodic'] },
                content: { type: 'string', required: true },
                confidence: { type: 'number', required: true },
                source: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    kind: { type: 'string', required: true, enum: ['explicit-user', 'model-candidate', 'owner-edit'] },
                    reference: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                  },
                },
                confirmedAt: { type: 'string', required: true },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return recallForModel(memories, {
        ...(args.class === undefined ? {} : { class: args.class }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jarvis_mqtt_device_control',
    description: 'Send one bounded low-risk command to the configured MQTT device. Lock and alarm capabilities require the separate approval tool.',
    parameters: {
      capability: { type: 'string', required: true, enum: ['switch.set', 'light.set', 'media.play_pause', 'cover.set'] },
      payload: { type: 'object', required: true, additionalProperties: true, description: 'Private device payload; never returned in the public result' },
      expectedState: { type: 'string', description: 'Expected reported device state' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          commandId: { type: 'string', required: true },
          idempotencyKey: { type: 'string', required: true },
          capability: { type: 'string', required: true },
          state: { type: 'string', required: true },
          acknowledged: { type: 'boolean', required: true },
          observedState: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `MQTT device command ${String(value.state)}.` }],
    },
    async execute(args, exec) {
      if (mqttClient === undefined) throw new Error('MQTT device control is not configured')
      if (!['switch.set', 'light.set', 'media.play_pause', 'cover.set'].includes(args.capability)) {
        throw new Error('MQTT device capability is invalid')
      }
      if (typeof args.payload !== 'object' || args.payload === null || Array.isArray(args.payload)) {
        throw new Error('MQTT device payload is invalid')
      }
      if (args.expectedState !== undefined && typeof args.expectedState !== 'string') throw new Error('MQTT expectedState is invalid')
      return mqttClient.sendCommand({
        commandId: String(exec.callId),
        idempotencyKey: String(exec.callId),
        capability: args.capability,
        payload: args.payload as Readonly<Record<string, unknown>>,
        ...(args.expectedState === undefined ? {} : { expectedState: args.expectedState }),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jarvis_device_control',
    description: 'Request one allowlisted high-risk Home Assistant lock or alarm action. The paired PWA must approve it before the device adapter can execute it.',
    parameters: {
      capability: { type: 'string', required: true, enum: ['lock.set', 'alarm.set'] },
      externalEntityId: { type: 'string', required: true, description: 'Normalized Home Assistant entity id' },
      service: { type: 'string', required: true, description: 'Allowlisted Home Assistant service' },
      expectedState: { type: 'string', required: true, description: 'Expected resulting entity state' },
      serviceData: { type: 'object', additionalProperties: true, description: 'Provider service data; never returned in the public approval view' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', required: true, enum: ['awaiting-approval'] },
          approvalId: { type: 'string', required: true },
          capability: { type: 'string', required: true },
          externalEntityId: { type: 'string', required: true },
          service: { type: 'string', required: true },
          expectedState: { type: 'string', required: true },
          risk: { type: 'string', required: true, enum: ['high'] },
          expiresAt: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Smart-device approval ${String(value.approvalId)} is waiting for a decision.` }],
    },
    async execute(args, exec) {
      if (deviceClient === undefined) throw new Error('smart-device control is not configured')
      if (args.capability !== 'lock.set' && args.capability !== 'alarm.set') throw new Error('smart-device capability is invalid')
      if (typeof args.externalEntityId !== 'string' || typeof args.service !== 'string' || typeof args.expectedState !== 'string') {
        throw new Error('smart-device command fields are invalid')
      }
      if (args.serviceData !== undefined && (typeof args.serviceData !== 'object' || args.serviceData === null || Array.isArray(args.serviceData))) {
        throw new Error('smart-device service data is invalid')
      }
      const approval = await deviceClient.requestApproval({
        commandId: String(exec.callId),
        idempotencyKey: String(exec.callId),
        capability: args.capability,
        externalEntityId: args.externalEntityId,
        service: args.service,
        expectedState: args.expectedState,
        ...(args.serviceData === undefined ? {} : { serviceData: args.serviceData as Readonly<Record<string, unknown>> }),
      })
      return {
        state: 'awaiting-approval' as const,
        approvalId: approval.approvalId,
        capability: approval.capability,
        externalEntityId: approval.externalEntityId,
        service: approval.service,
        expectedState: approval.expectedState,
        risk: approval.risk,
        expiresAt: approval.expiresAt,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jarvis_open_app',
    description: `Open one allowlisted macOS application after the owner approves. Allowed applications: ${apps.keys().join(', ')}.`,
    parameters: {
      application: { type: 'string', required: true, enum: apps.keys(), description: 'Allowlisted application key' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          application: { type: 'string', required: true },
          displayName: { type: 'string', required: true },
          launched: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Opened ${String(value.displayName)}.` }],
    },
    async execute(args, exec) {
      const definition = await apps.open(args.application, exec.signal)
      return { application: args.application, displayName: definition.displayName, launched: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jarvis_reminder',
    description: 'Create, list, complete, or delete reminders stored locally on this Mac.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'list', 'complete', 'delete'] },
      text: { type: 'string', description: 'Reminder text; required for create' },
      dueAt: { type: 'string', description: 'Optional ISO 8601 due time for create' },
      id: { type: 'string', description: 'Reminder id; required for complete or delete' },
      includeCompleted: { type: 'boolean', description: 'Include completed reminders when listing' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reminders: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                ownerId: { type: 'string', required: true },
                text: { type: 'string', required: true },
                dueAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                createdAt: { type: 'string', required: true },
                completedAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      await audit.append({
        tool: 'jarvis_reminder',
        callId: String(exec.callId),
        phase: 'dispatch',
        decision: 'recorded-before-write',
        detail: { action: args.action, ...(args.id === undefined ? {} : { id: args.id }) },
      })
      if (args.action === 'create') {
        if (args.text === undefined) throw new Error('text is required for create')
        return reminderOutput([await reminders.create(args.text, args.dueAt)])
      }
      if (args.action === 'complete') {
        if (args.id === undefined) throw new Error('id is required for complete')
        return reminderOutput([await reminders.complete(args.id)])
      }
      if (args.action === 'delete') {
        if (args.id === undefined) throw new Error('id is required for delete')
        return reminderOutput([await reminders.delete(args.id)])
      }
      return reminderOutput(await reminders.list(args.includeCompleted))
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/jarvis/health',
    handler(req, res) {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ service: 'jarvis-mac-mvp', status: 'ok', scope: 'loopback-only' }))
    },
  }), 'jarvis-mac-mvp: health route')
}
