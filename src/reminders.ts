import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface Reminder {
  id: string
  ownerId: 'local-owner'
  text: string
  dueAt: string | null
  createdAt: string
  completedAt: string | null
}

export class ReminderStore {
  readonly path: string
  private pending: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.path = join(dataDir, 'reminders.json')
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    try {
      await readFile(this.path, 'utf8')
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      await writeFile(this.path, '[]\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    }
    await chmod(this.path, 0o600)
    await this.read()
  }

  async list(includeCompleted = false): Promise<Reminder[]> {
    const reminders = await this.read()
    return reminders
      .filter(reminder => includeCompleted || reminder.completedAt === null)
      .sort((left, right) => (left.dueAt ?? '9999').localeCompare(right.dueAt ?? '9999'))
  }

  async create(text: string, dueAt?: string): Promise<Reminder> {
    const normalizedText = text.trim()
    if (normalizedText.length < 1 || normalizedText.length > 500) {
      throw new Error('reminder text must contain 1 to 500 characters')
    }
    const normalizedDueAt = dueAt === undefined || dueAt.trim() === '' ? null : new Date(dueAt).toISOString()
    const reminder: Reminder = {
      id: randomUUID(),
      ownerId: 'local-owner',
      text: normalizedText,
      dueAt: normalizedDueAt,
      createdAt: new Date().toISOString(),
      completedAt: null,
    }
    await this.update(reminders => [...reminders, reminder])
    return reminder
  }

  async complete(id: string): Promise<Reminder> {
    let completed: Reminder | undefined
    await this.update(reminders => reminders.map(reminder => {
      if (reminder.id !== id) return reminder
      completed = { ...reminder, completedAt: reminder.completedAt ?? new Date().toISOString() }
      return completed
    }))
    if (completed === undefined) throw new Error(`reminder not found: ${id}`)
    return completed
  }

  async delete(id: string): Promise<Reminder> {
    let deleted: Reminder | undefined
    await this.update(reminders => reminders.filter(reminder => {
      if (reminder.id !== id) return true
      deleted = reminder
      return false
    }))
    if (deleted === undefined) throw new Error(`reminder not found: ${id}`)
    return deleted
  }

  private async read(): Promise<Reminder[]> {
    const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
    if (!Array.isArray(value)) throw new Error('reminders.json must contain an array')
    return value as Reminder[]
  }

  private async update(transform: (reminders: Reminder[]) => Reminder[]): Promise<void> {
    const operation = this.pending.then(async () => {
      const reminders = transform(await this.read())
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(reminders, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, this.path)
      await chmod(this.path, 0o600)
    })
    this.pending = operation.catch(() => undefined)
    await operation
  }
}
