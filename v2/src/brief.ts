import type { MemoryStore } from './memory/store.ts'
import { importanceScore } from './memory/types.ts'
import type { Reminder, ReminderStore } from './proactive/reminders.ts'
import { eventsForDay, readCalendar, type CalendarEvent } from './proactive/calendar.ts'

export interface BriefItem {
  kind: 'reminder' | 'memory' | 'calendar' | 'note'
  text: string
  detail?: string
  at?: string
}

export interface DailyBrief {
  at: string
  greeting: string
  headline: string
  items: BriefItem[]
  text: string
  stats: { reminders: number; overdue: number; memories: number; events: number }
}

function sameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate()
}

function formatDue(reminder: Reminder, now: Date): string {
  const due = new Date(reminder.dueAt)
  if (Number.isNaN(due.getTime())) return reminder.dueAt
  if (due.getTime() < now.getTime()) return '已过期'
  if (sameLocalDay(due, now)) return `今天 ${due.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`
  return due.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

export function buildDailyBrief(memory: MemoryStore, reminders: ReminderStore, now = new Date(), calendar: CalendarEvent[] = []): DailyBrief {
  const pending = reminders.list('pending')
  const todays = pending.filter(reminder => {
    const due = new Date(reminder.dueAt)
    return !Number.isNaN(due.getTime()) && (due.getTime() <= now.getTime() || sameLocalDay(due, now))
  })
  const items: BriefItem[] = []
  const todayEvents = eventsForDay(calendar, now).slice(0, 6)
  for (const event of todayEvents) {
    const start = new Date(event.start)
    items.push({
      kind: 'calendar',
      text: event.summary,
      detail: event.allDay ? '今天全天' : `今天 ${start.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}${event.location ? ` · ${event.location}` : ''}`,
      at: event.start,
    })
  }
  items.push(...todays.slice(0, 6).map(reminder => ({
    kind: 'reminder' as const,
    text: reminder.text,
    detail: formatDue(reminder, now),
    at: reminder.dueAt,
  })))

  const memories = memory.list({ includeSensitive: false, limit: 200 })
    .filter(item => item.status === 'confirmed')
    .filter(item => item.kind === 'prospective' || importanceScore(item.importance) >= 0.62)
    .sort((a, b) => {
      const deadline = (item: typeof a) => item.kind === 'prospective' ? 1 : 0
      return deadline(b) - deadline(a) || importanceScore(b.importance) - importanceScore(a.importance) || b.updatedAt.localeCompare(a.updatedAt)
    })
    .slice(0, 4)
  for (const item of memories) {
    items.push({ kind: 'memory', text: item.gist || item.content, detail: item.kind === 'prospective' ? '待兑现' : '长期记忆' })
  }

  const overdue = todays.filter(reminder => new Date(reminder.dueAt).getTime() < now.getTime()).length
  const greeting = now.getHours() < 11 ? '早上好' : now.getHours() < 18 ? '下午好' : '晚上好'
  const headline = items.length === 0
    ? '今天没有到期的提醒。把最重要的一件事告诉我，我帮你排。'
    : overdue > 0
      ? `有 ${overdue} 件已经过期，先处理它们。`
      : `今天有 ${todayEvents.length} 个日程、${todays.length} 件待办，另有 ${memories.length} 条相关记忆。`
  const lines = [`${greeting}。`, headline]
  for (const item of items) lines.push(`- ${item.kind === 'calendar' ? '日程' : item.kind === 'reminder' ? '提醒' : '记忆'}：${item.text}${item.detail ? `（${item.detail}）` : ''}`)
  if (items.length === 0) lines.push('你可以说“提醒我下午三点…”，或者让我根据记忆安排今天。')
  return {
    at: now.toISOString(),
    greeting,
    headline,
    items,
    text: lines.join('\n'),
    stats: { reminders: todays.length, overdue, memories: memories.length, events: todayEvents.length },
  }
}

export function parseBriefTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

export function nextBriefAt(now: Date, hour: number, minute: number): Date {
  const next = new Date(now)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next
}

export class BriefScheduler {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly memory: MemoryStore,
    private readonly reminders: ReminderStore,
    private readonly bus: { emit: (type: string, data: Record<string, unknown>) => void },
    private readonly time: string,
    private readonly calendarPath?: string,
    private readonly logger?: { info: (message: string, data?: Record<string, unknown>) => void; warn: (message: string, data?: Record<string, unknown>) => void },
  ) {}

  start(now = new Date()): void {
    if (this.timer) return
    const parsed = parseBriefTime(this.time)
    if (!parsed) {
      this.logger?.warn('invalid brief time; scheduler disabled', { time: this.time })
      return
    }
    const next = nextBriefAt(now, parsed.hour, parsed.minute)
    const delay = Math.max(1000, next.getTime() - now.getTime())
    this.timer = setTimeout(() => {
      this.timer = null
      void readCalendar(this.calendarPath)
        .then(calendar => {
          const brief = buildDailyBrief(this.memory, this.reminders, new Date(), calendar)
          if (brief.items.length > 0) this.bus.emit('brief.ready', { brief })
        })
        .catch(error => this.logger?.warn('daily brief failed', { error: String(error) }))
      this.start()
    }, delay)
    this.timer.unref()
    this.logger?.info('daily brief scheduled', { at: next.toISOString(), time: this.time })
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
