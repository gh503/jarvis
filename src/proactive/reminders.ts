import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { EventBus } from '../events.ts'

export interface Reminder {
  id: string
  text: string
  dueAt: string
  status: 'pending' | 'notified' | 'completed' | 'cancelled'
  createdAt: string
  notifiedAt: string | null
  completedAt: string | null
}

export interface ParsedReminder {
  text: string
  dueAt: string
}

interface Row {
  [key: string]: unknown
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function toReminder(row: Row): Reminder {
  return {
    id: str(row.id),
    text: str(row.text),
    dueAt: str(row.due_at),
    status: str(row.status, 'pending') as Reminder['status'],
    createdAt: str(row.created_at),
    notifiedAt: (row.notified_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hours = Math.floor(Math.abs(offset) / 60)
  const minutes = Math.abs(offset) % 60
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(hours)}:${pad(minutes)}`
}

function nextAt(hour: number, minute: number, base: Date): Date {
  const result = new Date(base)
  result.setHours(hour, minute, 0, 0)
  if (result.getTime() <= base.getTime()) result.setDate(result.getDate() + 1)
  return result
}

export function parseReminder(input: string, now = new Date()): ParsedReminder | null {
  const original = input.trim()
  const text = original
    .replace(/^提醒我(一下)?[，,]?\s*/, '')
    .replace(/^记得[，,]?\s*/, '')
    .trim()
  if (!text) return null

  const iso = original.match(/(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (iso) {
    const date = new Date(`${iso[1]}T${pad(Number(iso[2]))}:${iso[3]}:${iso[4] ?? '00'}`)
    if (!Number.isNaN(date.getTime())) {
      return { text: cleanReminderText(text.replace(iso[0], '')) || cleanReminderText(text), dueAt: localIso(date) }
    }
  }

  const relative = original.match(/(\d+)\s*(分钟|分|小时|钟头|天)后/)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2]
    const date = new Date(now)
    if (unit.includes('分')) date.setMinutes(date.getMinutes() + amount)
    else if (unit.includes('小时') || unit.includes('钟头')) date.setHours(date.getHours() + amount)
    else date.setDate(date.getDate() + amount)
    return { text: cleanReminderText(text.replace(relative[0], '')) || cleanReminderText(text), dueAt: localIso(date) }
  }

  const dayMatch = original.match(/(今天|明天|后天)/)
  const timeMatch = original.match(/(上午|下午|晚上|中午)?\s*(\d{1,2})\s*[点:：]\s*(\d{1,2})?\s*(半)?/)
  if (dayMatch && timeMatch) {
    const base = new Date(now)
    if (dayMatch[1] === '明天') base.setDate(base.getDate() + 1)
    if (dayMatch[1] === '后天') base.setDate(base.getDate() + 2)
    let hour = Number(timeMatch[2])
    const minute = timeMatch[4] ? 30 : Number(timeMatch[3] ?? 0)
    const period = timeMatch[1]
    if ((period === '下午' || period === '晚上') && hour < 12) hour += 12
    if (period === '中午' && hour < 11) hour += 12
    const date = new Date(base)
    date.setHours(hour, minute, 0, 0)
    if (!dayMatch && date.getTime() <= now.getTime()) date.setDate(date.getDate() + 1)
    return { text: cleanReminderText(text.replace(dayMatch[0], '').replace(timeMatch[0], '')) || cleanReminderText(text), dueAt: localIso(date) }
  }

  return null
}

function cleanReminderText(value: string): string {
  return value.replace(/^[，,。.!！\s]+/, '').replace(/[，,。.!！\s]+$/, '').trim()
}

export class ReminderStore {
  private readonly db: DatabaseSync

  constructor(file: string, private readonly bus?: EventBus) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        due_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        notified_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);
    `)
  }

  add(text: string, dueAt: string): Reminder {
    const reminder: Reminder = {
      id: randomUUID(),
      text: text.trim(),
      dueAt,
      status: 'pending',
      createdAt: new Date().toISOString(),
      notifiedAt: null,
      completedAt: null,
    }
    this.db.prepare(
      'INSERT INTO reminders (id, text, due_at, status, created_at, notified_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(reminder.id, reminder.text, reminder.dueAt, reminder.status, reminder.createdAt, null, null)
    this.bus?.emit('reminder.added', { reminder })
    return reminder
  }

  addParsed(input: string, now = new Date()): Reminder | null {
    const parsed = parseReminder(input, now)
    if (!parsed) return null
    return this.add(parsed.text, parsed.dueAt)
  }

  list(status?: Reminder['status']): Reminder[] {
    const rows = status
      ? (this.db.prepare('SELECT * FROM reminders WHERE status = ? ORDER BY due_at ASC').all(status) as Row[])
      : (this.db.prepare("SELECT * FROM reminders WHERE status IN ('pending','notified') ORDER BY due_at ASC").all() as Row[])
    return rows.map(toReminder).sort((left, right) => {
      const a = Date.parse(left.dueAt)
      const b = Date.parse(right.dueAt)
      if (!Number.isFinite(a)) return 1
      if (!Number.isFinite(b)) return -1
      return a - b
    })
  }

  due(now = new Date()): Reminder[] {
    const rows = (this.db.prepare(
      "SELECT * FROM reminders WHERE status = 'pending'",
    ).all() as Row[]).map(toReminder)
    const nowMs = now.getTime()
    return rows
      .filter(item => {
        const due = Date.parse(item.dueAt)
        return Number.isFinite(due) && due <= nowMs
      })
      .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt))
      .slice(0, 20)
  }

  markNotified(id: string): Reminder | null {
    const at = new Date().toISOString()
    this.db.prepare("UPDATE reminders SET status = 'notified', notified_at = ? WHERE id = ? AND status = 'pending'").run(at, id)
    return this.get(id)
  }

  complete(id: string): Reminder | null {
    const at = new Date().toISOString()
    this.db.prepare("UPDATE reminders SET status = 'completed', completed_at = ? WHERE id = ?").run(at, id)
    return this.get(id)
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id).changes > 0
  }

  get(id: string): Reminder | null {
    const row = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Row | undefined
    return row ? toReminder(row) : null
  }

  close(): void {
    this.db.close()
  }
}

export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly store: ReminderStore,
    private readonly onDue: (reminder: Reminder) => void | Promise<void>,
    private readonly bus?: EventBus,
    private readonly intervalMs = 15_000,
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(now = new Date()): Promise<void> {
    for (const reminder of this.store.due(now)) {
      const marked = this.store.markNotified(reminder.id)
      if (!marked) continue
      this.bus?.emit('reminder.due', { reminder: marked })
      try {
        await this.onDue(marked)
      } catch (error) {
        this.bus?.emit('reminder.error', { id: marked.id, error: String(error) })
      }
    }
  }
}

export function formatReminder(reminder: Reminder): string {
  const date = new Date(reminder.dueAt)
  return `${date.toLocaleString('zh-CN', { hour12: false })} · ${reminder.text}`
}