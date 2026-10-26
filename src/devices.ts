import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

interface DeviceRecord {
  id: string
  name: string
  tokenHash: string
  createdAt: string
  revokedAt: string | null
}

export interface PublicDevice {
  id: string
  name: string
  createdAt: string
  revoked: boolean
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Revocable device tokens; only SHA-256 hashes are persisted. */
export class DeviceStore {
  private records: DeviceRecord[] = []

  constructor(private readonly file: string) {
    if (!existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { devices?: DeviceRecord[] }
      this.records = Array.isArray(parsed.devices) ? parsed.devices : []
    } catch {
      this.records = []
    }
  }

  list(): PublicDevice[] {
    return this.records.map(record => ({
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      revoked: Boolean(record.revokedAt),
    }))
  }

  verify(token: string): boolean {
    if (!token) return false
    const digest = hash(token)
    return this.records.some(record => !record.revokedAt && sameHash(record.tokenHash, digest))
  }

  issue(name: string): { token: string; device: PublicDevice } {
    const token = randomBytes(32).toString('base64url')
    const record: DeviceRecord = {
      id: randomUUID(),
      name: name.trim().slice(0, 80) || '已配对设备',
      tokenHash: hash(token),
      createdAt: new Date().toISOString(),
      revokedAt: null,
    }
    this.records.push(record)
    this.save()
    return { token, device: { id: record.id, name: record.name, createdAt: record.createdAt, revoked: false } }
  }

  revoke(id: string): boolean {
    const record = this.records.find(item => item.id === id && !item.revokedAt)
    if (!record) return false
    record.revokedAt = new Date().toISOString()
    this.save()
    return true
  }

  clear(): void {
    this.records = []
    rmSync(this.file, { force: true })
  }

  private save(): void {
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({ version: 1, devices: this.records }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.file)
    chmodSync(this.file, 0o600)
  }
}
