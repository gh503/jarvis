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
  revision: number
  recurrence: Recurrence | null
  nextDueAt: string | null
  nextDisplay: string | null
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
  const recurrence = row.recurrence_json ? JSON.parse(String(row.recurrence_json)) as Recurrence : null
  const active = row.status === 'pending' || row.status === 'notified'
  return {
    revision: Number(row.revision ?? 1),
    recurrence,
    nextDueAt: active ? new Date(str(row.due_at)).toISOString() : null,
    nextDisplay: active ? displayDue(str(row.due_at), recurrence?.timeZone) : null,
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

export interface Recurrence {
  kind: 'daily' | 'weekly'
  time: string
  timeZone: string
  weekdays?: number[]
}
export interface ReminderPatch { text?: string; dueAt?: string; recurrence?: Recurrence | null }
export interface ReminderCreate { text: string; dueAt?: string; recurrence?: Recurrence }

export function validateRecurrence(value: unknown): Recurrence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recurrence must be an object')
  const r = value as Recurrence
  if (Object.keys(r).some(k => !['kind', 'time', 'timeZone', 'weekdays'].includes(k))) throw new Error('Unknown recurrence field')
  if (!['daily', 'weekly'].includes(r.kind) || typeof r.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)) throw new Error('Invalid recurrence kind or HH:mm time')
  if (typeof r.timeZone !== 'string' || /^[+-]/.test(r.timeZone)) throw new Error('An IANA timeZone is required')
  try { new Intl.DateTimeFormat('en', { timeZone: r.timeZone }).format() } catch { throw new Error('Invalid IANA timeZone') }
  if (r.kind === 'weekly') {
    if (!Array.isArray(r.weekdays) || !r.weekdays.length || r.weekdays.some(d => !Number.isInteger(d) || d < 1 || d > 7) || new Set(r.weekdays).size !== r.weekdays.length) throw new Error('weekdays must be unique ISO weekdays 1..7')
  } else if (r.weekdays !== undefined) throw new Error('weekdays is only valid for weekly recurrence')
  return { kind: r.kind, time: r.time, timeZone: r.timeZone, ...(r.kind === 'weekly' ? { weekdays: [...r.weekdays!].sort() } : {}) }
}

export function validateDueAt(value: unknown, now: Date): string {
  if (typeof value !== 'string') throw new Error('dueAt must be an ISO timestamp with timezone')
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/)
  if (!m) throw new Error('dueAt must be an ISO timestamp with timezone')
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number)
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  if (y < 100 || mo < 1 || mo > 12 || d < 1 || d > days || h > 23 || mi > 59 || se > 59 || (m[8] !== 'Z' && (Number(m[8].slice(1, 3)) > 23 || Number(m[8].slice(4)) > 59))) throw new Error('Invalid calendar date or time')
  const time = Date.parse(value)
  if (!Number.isFinite(time) || time <= now.getTime()) throw new Error('dueAt must be in the future')
  return new Date(time).toISOString()
}
function validText(text: unknown): string {
  if (typeof text !== 'string' || !text.trim() || text.length > 1000 || text.includes('\0')) throw new Error('Reminder text must contain 1..1000 characters')
  return text.trim()
}
export function displayDue(dueAt: string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return new Date(dueAt).toLocaleString('sv-SE', { timeZone, timeZoneName: 'longOffset', hour12: false }) + ` [${timeZone}]`
}

/** Resolve wall calendar dates by enumerating nearby timezone offsets and round-tripping
 * each candidate through Intl. Gaps have no candidate; folds select the earlier instant.
 * This handles non-hour transitions and skipped dates, without assuming a fixed offset. */
export function nextOccurrence(input: Recurrence, after: Date): string {
  return calendarOccurrence(input, after, 1)
}
function calendarOccurrence(input: Recurrence, after: Date, direction: 1 | -1): string {
  const r = validateRecurrence(input)
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: r.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  const wall = (ms: number) => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p => [p.type, p.value]))
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  }
  const start = new Date(wall(after.getTime()))
  const [hour, minute] = r.time.split(':').map(Number)
  for (let day = 0; day < 370; day++) {
    const target = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + day * direction, hour, minute)
    const weekday = new Date(target).getUTCDay() || 7
    if (r.kind === 'weekly' && !r.weekdays!.includes(weekday)) continue
    const offsets = new Set<number>()
    // Include both sides of transitions, even for a whole skipped calendar day.
    for (let delta = -48; delta <= 48; delta += 6) {
      const instant = target + delta * 3600000
      offsets.add(wall(instant) - instant)
    }
    const matches = [...offsets].map(offset => target - offset).filter(ms => wall(ms) === target).sort((a, b) => a - b)
    // Always choose the first occurrence of an ambiguous wall time, even when the
    // caller is between the two instants; never deliver its second occurrence.
    if (matches.length && (direction === 1 ? matches[0] > after.getTime() : matches[0] <= after.getTime())) return new Date(matches[0]).toISOString()
  }
  throw new Error('No recurrence occurrence in the next year')
}

export class ReminderStore {
  private readonly db: DatabaseSync
  constructor(file: string, private readonly bus?: EventBus, private readonly clock: () => Date = () => new Date()) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, due_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
        notified_at TEXT, completed_at TEXT, revision INTEGER NOT NULL DEFAULT 1, recurrence_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);
    `)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const columns = this.db.prepare('PRAGMA table_info(reminders)').all().map(row => row.name)
      if (!columns.includes('revision')) this.db.exec('ALTER TABLE reminders ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
      if (!columns.includes('recurrence_json')) this.db.exec('ALTER TABLE reminders ADD COLUMN recurrence_json TEXT')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  now(): Date { return this.clock() }

  // Legacy API permits past timestamps (existing UI/import callers). New tool writes
  // use create/update, which enforce future dates and strict calendar validation.
  add(text: string, dueAt: string): Reminder { return this.insert(validText(text), dueAt, null) }
  private insert(text: string, dueAt: string, recurrence: Recurrence | null): Reminder {
    const id = randomUUID()
    this.db.prepare("INSERT INTO reminders (id,text,due_at,status,created_at,revision,recurrence_json) VALUES (?,?,?,'pending',?,1,?)")
      .run(id, text, dueAt, this.now().toISOString(), recurrence ? JSON.stringify(recurrence) : null)
    const reminder = this.get(id)!
    this.bus?.emit('reminder.added', { reminder })
    return reminder
  }
  create(input: ReminderCreate): Reminder {
    const text = validText(input.text)
    if ((input.dueAt !== undefined) === (input.recurrence !== undefined)) throw new Error('Provide exactly one of dueAt or recurrence')
    const r = input.recurrence === undefined ? null : validateRecurrence(input.recurrence)
    return this.insert(text, r ? nextOccurrence(r, this.now()) : validateDueAt(input.dueAt, this.now()), r)
  }
  addParsed(input: string, now = this.now()): Reminder | null {
    const parsed = parseReminder(input, now)
    return parsed ? this.add(parsed.text, parsed.dueAt) : null
  }
  list(status?: Reminder['status']): Reminder[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM reminders WHERE status = ?').all(status)
      : this.db.prepare("SELECT * FROM reminders WHERE status IN ('pending','notified')").all()
    return rows.map(toReminder).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
  }
  due(now = this.now()): Reminder[] {
    return this.list('pending').filter(r => Date.parse(r.dueAt) <= now.getTime()).slice(0, 20)
  }
  private check(id: string, revision?: number): Reminder | null {
    const r = this.get(id)
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1 || (r && r.revision !== revision))) throw new Error('Reminder revision conflict; list reminders and retry with the current revision')
    return r
  }
  private save(r: Reminder): Reminder {
    const changed = this.db.prepare('UPDATE reminders SET text=?,due_at=?,status=?,notified_at=?,completed_at=?,recurrence_json=?,revision=revision+1 WHERE id=? AND revision=?')
      .run(r.text, r.dueAt, r.status, r.notifiedAt, r.completedAt, r.recurrence ? JSON.stringify(r.recurrence) : null, r.id, r.revision).changes
    if (!changed) throw new Error('Reminder revision conflict; list reminders and retry with the current revision')
    return this.get(r.id)!
  }
  update(id: string, patch: ReminderPatch, expectedRevision: number): Reminder | null {
    if (expectedRevision === undefined) throw new Error('expectedRevision is required')
    const r = this.check(id, expectedRevision)
    if (!r) return null
    if (r.status === 'cancelled' || r.status === 'completed') throw new Error('Cannot update an inactive reminder')
    if (!Object.keys(patch).length || Object.keys(patch).some(k => !['text','dueAt','recurrence'].includes(k))) throw new Error('Provide a valid reminder patch')
    if (patch.text !== undefined) r.text = validText(patch.text)
    if (patch.recurrence !== undefined) r.recurrence = patch.recurrence === null ? null : validateRecurrence(patch.recurrence)
    if (patch.dueAt !== undefined && r.recurrence) throw new Error('Clear recurrence explicitly with null before setting dueAt')
    if (patch.dueAt !== undefined) r.dueAt = validateDueAt(patch.dueAt, this.now())
    else if (patch.recurrence !== undefined && r.recurrence) r.dueAt = nextOccurrence(r.recurrence, this.now())
    else if (patch.recurrence === null) r.dueAt = validateDueAt(r.dueAt, this.now())
    if (patch.dueAt !== undefined || patch.recurrence !== undefined) { r.status = 'pending'; r.notifiedAt = null; r.completedAt = null }
    return this.save(r)
  }
  /** Claims an occurrence before external delivery. At-most-once: a crash or callback
   * failure after this write loses the notification; it is deliberately not retried.
   * Recurrences persist their next future instant in the same CAS write, coalescing
   * all offline missed occurrences to one notification per tick. */
  markNotified(id: string, now = this.now(), expectedRevision?: number): Reminder | null {
    const r = this.check(id, expectedRevision)
    if (!r || r.status !== 'pending') return null
    const occurrence = { ...r, status: 'notified' as const, notifiedAt: now.toISOString() }
    r.notifiedAt = occurrence.notifiedAt
    if (r.recurrence) {
      occurrence.dueAt = calendarOccurrence(r.recurrence, now, -1)
      r.dueAt = nextOccurrence(r.recurrence, now)
    } else r.status = 'notified'
    const saved = this.save(r)
    return { ...occurrence, revision: saved.revision, nextDueAt: saved.nextDueAt, nextDisplay: saved.nextDisplay }
  }
  complete(id: string, expectedRevision?: number): Reminder | null {
    const r = this.check(id, expectedRevision)
    if (!r || r.status === 'cancelled' || r.status === 'completed') return r
    r.completedAt = this.now().toISOString()
    if (r.recurrence) {
      // An already delivered occurrence has advanced; completing it must not skip
      // tomorrow. Completing a pending occurrence early explicitly advances it.
      if (!r.notifiedAt || Date.parse(r.dueAt) <= this.now().getTime()) r.dueAt = nextOccurrence(r.recurrence, new Date(Math.max(this.now().getTime(), Date.parse(r.dueAt))))
      r.notifiedAt = null
      r.status = 'pending'
    } else r.status = 'completed'
    return this.save(r)
  }
  cancel(id: string, expectedRevision?: number): Reminder | null {
    const r = this.check(id, expectedRevision)
    if (!r || r.status === 'cancelled') return r
    r.status = 'cancelled'
    return this.save(r)
  }
  remove(id: string): boolean { return this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id).changes > 0 }
  get(id: string): Reminder | null {
    const row = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Row | undefined
    return row ? toReminder(row) : null
  }
  close(): void { this.db.close() }
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

  async tick(now = this.store.now()): Promise<void> {
    for (const reminder of this.store.due(now)) {
      try {
        const current = this.store.get(reminder.id)
        if (!current || current.revision !== reminder.revision) continue
        const marked = this.store.markNotified(reminder.id, now, reminder.revision)
        if (!marked) continue
        this.bus?.emit('reminder.due', { reminder: marked })
        await this.onDue(marked)
      } catch (error) {
        // Another process may win the CAS between get and claim. Never deliver
        // after a failed claim, and never leave the interval promise rejected.
        this.bus?.emit('reminder.error', { id: reminder.id, error: String(error) })
      }
    }
  }
}

export function formatReminder(reminder: Reminder): string {
  return `${displayDue(reminder.dueAt, reminder.recurrence?.timeZone)} · ${reminder.text}`
}