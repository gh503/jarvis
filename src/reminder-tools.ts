import { createHash } from 'node:crypto'
import type { ToolDefinition } from './tools.ts'
import { ReminderStore, type ReminderPatch, type ReminderCreate } from './proactive/reminders.ts'

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const recurrence = object({
  kind: { type: 'string', enum: ['daily', 'weekly'] },
  time: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
  timeZone: { type: 'string', minLength: 1, maxLength: 100 },
  weekdays: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 7 } },
}, ['kind', 'time', 'timeZone'])
const text = { type: 'string', minLength: 1, maxLength: 1000 }
const dueAt = { type: 'string', minLength: 17, maxLength: 40 }
const id = { type: 'string', minLength: 1, maxLength: 64 }
const expectedRevision = { type: 'integer', minimum: 1 }

/** ToolRuntime journals call identities before dispatch; do not bypass it for retries. */
export function reminderTools(store: ReminderStore): ToolDefinition[] {
  const make = (name: string, description: string, parameters: Record<string, unknown>, run: (args: Record<string, unknown>) => unknown, read = false): ToolDefinition => {
    const definition = {
      name, description, parameters, usage: 'local' as const, destination: 'local' as const,
      permission: read ? 'allow' as const : 'ask' as const, effect: read ? 'read' as const : 'write' as const,
    }
    return {
      ...definition,
      definitionHash: createHash('sha256').update(JSON.stringify({ schemaVersion: 2, ...definition })).digest('hex'),
      async execute(args, ctx) {
        if (ctx.signal.aborted) return { content: '已取消', isError: true }
        try {
          const result = run(args)
          if (result === null) throw new Error('Reminder does not exist')
          return { content: JSON.stringify(result) }
        } catch (error) {
          return { content: error instanceof Error ? error.message : String(error), isError: true }
        }
      },
    }
  }
  return [
    make('reminders_list', '列出提醒及 revision、recurrence、下次 UTC 时间 nextDueAt 和带时区显示 nextDisplay。默认待处理；weekdays 为 ISO 周一1至周日7。', object({ status: { type: 'string', enum: ['pending', 'notified', 'completed', 'cancelled'] } }), args => store.list(args.status as Parameters<ReminderStore['list']>[0]), true),
    make('reminder_create', '创建提醒：正文及 dueAt 或 recurrence 二选一。dueAt 必须是含时区的未来 ISO 时间，不能猜测日期时区。循环使用 IANA 时区；夏令时缺失时间跳过、重复时间仅较早一次。报告 nextDisplay，勿将 UTC 钟面重新标为本地时间。', {
      ...object({ text, dueAt, recurrence }, ['text']),
      oneOf: [{ required: ['dueAt'], not: { required: ['recurrence'] } }, { required: ['recurrence'], not: { required: ['dueAt'] } }],
    }, args => ({ ...store.create(args as unknown as ReminderCreate), requestedDueAt: args.dueAt ?? null })),
    make('reminder_update', '编辑正文或时间，必须提供查询到的 expectedRevision。清除循环须 recurrence:null；将循环改为单次时同时提供 dueAt。循环改动重新计算下一次时间。', object({ id, expectedRevision, text, dueAt, recurrence: { anyOf: [recurrence, { type: 'null' }] } }, ['id', 'expectedRevision']), args => {
      const { id: reminderId, expectedRevision: revision, ...patch } = args
      return store.update(String(reminderId), patch as ReminderPatch, Number(revision))
    }),
    make('reminder_cancel', '取消指定提醒；循环提醒取消整个系列，保留记录。建议提供查询到的 expectedRevision 防止覆盖并发更新。', object({ id, expectedRevision }, ['id']), args => store.cancel(String(args.id), args.expectedRevision as number | undefined)),
    make('reminder_complete', '完成当前提醒。循环提醒完成当前一次并保留下一次；取消整个系列请用 reminder_cancel。建议提供 expectedRevision。', object({ id, expectedRevision }, ['id']), args => store.complete(String(args.id), args.expectedRevision as number | undefined)),
  ]
}
