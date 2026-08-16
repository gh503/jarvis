import { randomUUID } from 'node:crypto'
import { appendFile, chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface AuditInput {
  tool: string
  callId: string
  phase: string
  decision?: string
  detail?: Record<string, string | number | boolean | null>
}

export class AuditLog {
  readonly path: string
  private pending: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.path = join(dataDir, 'audit.jsonl')
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.path, '..'), { recursive: true, mode: 0o700 })
    await appendFile(this.path, '', { encoding: 'utf8', mode: 0o600 })
    await chmod(this.path, 0o600)
  }

  async append(input: AuditInput): Promise<void> {
    const event = {
      id: randomUUID(),
      ownerId: 'local-owner',
      time: new Date().toISOString(),
      ...input,
    }
    const operation = this.pending.then(() => appendFile(this.path, `${JSON.stringify(event)}\n`, 'utf8'))
    this.pending = operation.catch(() => undefined)
    await operation
  }
}
