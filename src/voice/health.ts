import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { cooldownActive, type CooldownEntry } from '../model/failover.ts'

export interface VoiceHealthSnapshot {
  asr: Record<string, CooldownEntry>
  tts: Record<string, CooldownEntry>
}

/**
 * Cooldowns for speech providers, persisted so a restart does not immediately
 * re-hit a provider that just returned 402/401. Best-effort on write: a failed
 * persist must never break transcription.
 */
export class VoiceHealthStore {
  private state: VoiceHealthSnapshot = { asr: {}, tts: {} }
  private loaded = false

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      await chmod(this.file, 0o600).catch(() => undefined)
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<VoiceHealthSnapshot>
      this.state = {
        asr: isRecord(parsed.asr) ? parsed.asr : {},
        tts: isRecord(parsed.tts) ? parsed.tts : {},
      }
    } catch {
      this.state = { asr: {}, tts: {} }
    }
  }

  get(kind: 'asr' | 'tts', id: string): CooldownEntry | undefined {
    return this.state[kind][id]
  }

  isCooling(kind: 'asr' | 'tts', id: string, now = Date.now()): boolean {
    return cooldownActive(this.state[kind][id], now)
  }

  async park(kind: 'asr' | 'tts', id: string, entry: CooldownEntry): Promise<void> {
    this.state[kind][id] = entry
    await this.persist()
  }

  /** Drop cooldowns for providers that no longer exist, and clear one entry. */
  async clear(kind: 'asr' | 'tts', id: string): Promise<void> {
    delete this.state[kind][id]
    await this.persist()
  }

  async retain(kind: 'asr' | 'tts', ids: Set<string>): Promise<void> {
    let changed = false
    for (const id of Object.keys(this.state[kind])) {
      if (!ids.has(id)) {
        delete this.state[kind][id]
        changed = true
      }
    }
    if (changed) await this.persist()
  }

  /** Privacy erase: cooldown reasons can quote a provider's error text. */
  async clearAll(): Promise<void> {
    this.state = { asr: {}, tts: {} }
    await rm(this.file, { force: true }).catch(() => undefined)
  }

  snapshot(): VoiceHealthSnapshot {
    const now = Date.now()
    const live = (entries: Record<string, CooldownEntry>) =>
      Object.fromEntries(Object.entries(entries).filter(([, entry]) => cooldownActive(entry, now)))
    return { asr: live(this.state.asr), tts: live(this.state.tts) }
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.file)
      await chmod(this.file, 0o600).catch(() => undefined)
    } catch {
      // Losing the cooldown file only costs one extra failed request.
    }
  }
}

function isRecord(value: unknown): value is Record<string, CooldownEntry> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
