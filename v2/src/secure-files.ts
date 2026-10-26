import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const MAGIC = Buffer.from('JARVIS-ENC1\n', 'utf8')
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

/**
 * Encrypt transient artifacts (captures, synthesized speech) at rest with a
 * per-install AES-256-GCM key. The key never leaves the data directory and is
 * created with 0600. This is deliberately not full-database encryption: FTS5
 * needs plaintext for recall, so that boundary is documented instead of
 * pretending search can run over ciphertext.
 */
export class SecureFiles {
  private key: Buffer

  constructor(private readonly dataDir: string) {
    const path = `${dataDir}/secret.key`
    if (existsSync(path)) {
      const value = readFileSync(path)
      if (value.length !== KEY_BYTES) throw new Error('secret.key is corrupt; refusing to start')
      chmodSync(path, 0o600)
      this.key = value
      return
    }
    mkdirSync(dirname(path), { recursive: true })
    const key = randomBytes(KEY_BYTES)
    this.writeKey(key)
    this.key = key
  }

  private writeKey(key: Buffer): void {
    const path = `${this.dataDir}/secret.key`
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, key, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, path)
    chmodSync(path, 0o600)
  }

  /** Rotate after an erase so any surviving ciphertext is no longer decryptable. */
  rotate(): void {
    const key = randomBytes(KEY_BYTES)
    this.writeKey(key)
    this.key = key
  }

  encryptDirectory(directory: string): void {
    if (!existsSync(directory)) return
    for (const name of readdirSync(directory)) {
      const path = `${directory}/${name}`
      try {
        if (!statSync(path).isFile()) continue
        const raw = readFileSync(path)
        if (raw.subarray(0, MAGIC.length).equals(MAGIC)) continue
        const temp = `${path}.${process.pid}.enc`
        writeFileSync(temp, this.encryptBuffer(raw), { mode: 0o600 })
        renameSync(temp, path)
        chmodSync(path, 0o600)
      } catch {
        // A file may disappear during cleanup; skip it.
      }
    }
  }

  /** Upgrade a legacy plaintext JSONL file in place, one encrypted line at a time. */
  encryptJsonl(path: string): void {
    if (!existsSync(path)) return
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    if (lines.length === 0 || lines.every(line => line.startsWith('J1:'))) return
    const out = lines.map(line => line.startsWith('J1:')
      ? line
      : `J1:${this.encryptBuffer(Buffer.from(line)).toString('base64')}`).join('\n') + '\n'
    const temp = `${path}.${process.pid}.enc`
    writeFileSync(temp, out, { mode: 0o600 })
    renameSync(temp, path)
    chmodSync(path, 0o600)
  }

  isEncrypted(path: string): boolean {
    try {
      return statSync(path).isFile() && readFileSync(path, { encoding: null }).subarray(0, MAGIC.length).equals(MAGIC)
    } catch {
      return false
    }
  }

  encryptBuffer(plain: Buffer): Buffer {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([cipher.update(plain), cipher.final()])
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
  }

  decryptBuffer(raw: Buffer): Buffer {
    if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) return raw
    let offset = MAGIC.length
    if (raw.length < offset + IV_BYTES + TAG_BYTES) throw new Error('encrypted buffer is truncated')
    const iv = raw.subarray(offset, offset += IV_BYTES)
    const tag = raw.subarray(offset, offset += TAG_BYTES)
    const body = raw.subarray(offset)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  }

  /** Replace a plaintext file atomically with magic|iv|tag|ciphertext. */
  async encryptFile(path: string): Promise<void> {
    let plain: Buffer
    try {
      plain = readFileSync(path)
    } catch {
      return
    }
    if (plain.subarray(0, MAGIC.length).equals(MAGIC)) return
    const temp = `${path}.${process.pid}.enc`
    writeFileSync(temp, this.encryptBuffer(plain), { mode: 0o600 })
    renameSync(temp, path)
    chmodSync(path, 0o600)
  }

  decryptFile(path: string): Buffer {
    return this.decryptBuffer(readFileSync(path))
  }
}
