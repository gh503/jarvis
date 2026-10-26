import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadavg, totalmem, freemem, cpus } from 'node:os'
import type { EventBus, JarvisEvent } from './events.ts'
import type { SecureFiles } from './secure-files.ts'

export interface TurnTrace {
  id: string
  source: string
  text: string
  startedAt: string
  modelStartedAt?: string
  status: 'running' | 'ok' | 'error' | 'cancelled'
  firstTokenMs: number | null
  firstAudioMs: number | null
  totalMs: number | null
  asrMs: number | null
  asrAudioMs: number | null
  audioSegments: number
  contextCount: number
  memoryCount: number
  error?: string
}

export interface TelemetryOptions {
  /** JSONL file for completed traces; 0600 and append-only in production. */
  file?: string
  maxFileBytes?: number
  /** Encrypt each persisted trace line at rest. */
  secure?: SecureFiles
}

export interface TelemetrySnapshot {
  startedAt: string
  uptimeMs: number
  counters: {
    turns: number
    textTurns: number
    voiceTurns: number
    errors: number
    audioSegments: number
    recalls: number
    memoryAdded: number
    memoryProposed: number
    captures: number
    actions: number
    modelSwitches: number
    events: number
  }
  turns: TurnTrace[]
  series: Array<{
    at: string
    source: string
    totalMs: number | null
    firstTokenMs: number | null
    firstAudioMs: number | null
    ok: boolean
  }>
  recalls: Array<{ at: string; query: string; ids: string[]; confidence: number }>
  eventCounts: Record<string, number>
  events: JarvisEvent[]
  system: {
    load1: number
    load5: number
    load15: number
    cpuCount: number
    freeMemMb: number
    totalMemMb: number
    processRssMb: number
    heapUsedMb: number
  }
}

const MAX_TRACES = 80
const MAX_EVENTS = 240

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export class TelemetryCollector {
  private readonly startedAt = new Date()
  private readonly traces = new Map<string, TurnTrace>()
  private readonly order: string[] = []
  private readonly eventRing: JarvisEvent[] = []
  private readonly eventCounts: Record<string, number> = {}
  private readonly recalls: Array<{ at: string; query: string; ids: string[]; confidence: number }> = []
  private readonly series: TelemetrySnapshot['series'] = []
  private counters = {
    turns: 0,
    textTurns: 0,
    voiceTurns: 0,
    errors: 0,
    audioSegments: 0,
    recalls: 0,
    memoryAdded: 0,
    memoryProposed: 0,
    captures: 0,
    actions: 0,
    modelSwitches: 0,
    events: 0,
  }
  private readonly unsubscribe: () => void
  private readonly history: TurnTrace[] = []
  private readonly maxFileBytes: number

  constructor(private readonly bus: EventBus, private readonly options: TelemetryOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024
    this.loadHistory()
    this.unsubscribe = bus.onAny(event => this.record(event))
  }

  private loadHistory(): void {
    const file = this.options.file
    if (!file) return
    try {
      const lines = readFileSync(file, 'utf8').trim().split('\n').slice(-MAX_TRACES * 3)
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const payload = line.startsWith('J1:') && this.options.secure
            ? this.options.secure.decryptBuffer(Buffer.from(line.slice(3), 'base64')).toString('utf8')
            : line
          const trace = JSON.parse(payload) as TurnTrace
          if (trace.id && trace.status !== 'running') this.history.push(trace)
        } catch { /* skip a torn line */ }
      }
      this.history.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      if (this.history.length > MAX_TRACES * 2) this.history.splice(0, this.history.length - MAX_TRACES * 2)
    } catch {
      // First run or unreadable history must never stop the app.
    }
  }

  private persist(trace: TurnTrace): void {
    const file = this.options.file
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      let size = 0
      try { size = statSync(file).size } catch { /* first write */ }
      if (size > this.maxFileBytes) renameSync(file, `${file}.1`)
      const line = this.options.secure
        ? `J1:${this.options.secure.encryptBuffer(Buffer.from(JSON.stringify(trace))).toString('base64')}`
        : JSON.stringify(trace)
      appendFileSync(file, `${line}\n`, { mode: 0o600 })
    } catch {
      // Observability is best-effort; it must not break a conversation.
    }
  }

  clearAll(): void {
    this.traces.clear()
    this.order.length = 0
    this.series.length = 0
    this.recalls.length = 0
    this.eventRing.length = 0
    this.history.length = 0
    for (const key of Object.keys(this.eventCounts)) delete this.eventCounts[key]
    this.counters = {
      turns: 0, textTurns: 0, voiceTurns: 0, errors: 0, audioSegments: 0, recalls: 0,
      memoryAdded: 0, memoryProposed: 0, captures: 0, actions: 0, modelSwitches: 0, events: 0,
    }
  }

  historyTraces(limit = 50): TurnTrace[] {
    const live = this.order
      .map(id => this.traces.get(id))
      .filter((trace): trace is TurnTrace => Boolean(trace) && trace?.status !== 'running')
    const byId = new Map<string, TurnTrace>()
    for (const trace of [...this.history, ...live]) byId.set(trace.id, trace)
    return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, Math.max(1, Math.min(200, limit)))
  }

  close(): void {
    this.unsubscribe()
  }

  private record(event: JarvisEvent): void {
    this.counters.events += 1
    this.eventCounts[event.type] = (this.eventCounts[event.type] ?? 0) + 1
    this.eventRing.push(event)
    if (this.eventRing.length > MAX_EVENTS) this.eventRing.splice(0, this.eventRing.length - MAX_EVENTS)
    const data = (event.data ?? {}) as Record<string, unknown>
    const turnId = str(data.turnId)
    switch (event.type) {
      case 'voice.asr.start': {
        if (!turnId) break
        const trace = this.ensure(turnId, 'voice', '', event.at)
        trace.modelStartedAt = undefined
        break
      }
      case 'turn.start': {
        this.counters.turns += 1
        const source = str(data.source, 'text')
        if (source === 'voice') this.counters.voiceTurns += 1
        else this.counters.textTurns += 1
        if (!turnId) break
        const trace = this.ensure(turnId, source, str(data.text), event.at)
        trace.text = str(data.text) || trace.text
        trace.source = source
        trace.modelStartedAt = event.at
        break
      }
      case 'voice.transcribed': {
        if (!turnId) break
        const trace = this.ensure(turnId, 'voice', '', event.at)
        trace.asrMs = num(data.asrMs, trace.asrMs ?? 0)
        trace.asrAudioMs = num(data.audioMs, trace.asrAudioMs ?? 0)
        if (!trace.text) trace.text = str(data.text)
        break
      }
      case 'assistant.delta': {
        if (!turnId) break
        const trace = this.ensure(turnId, 'text', '', event.at)
        if (trace.firstTokenMs === null) {
          const base = Date.parse(trace.modelStartedAt ?? trace.startedAt)
          trace.firstTokenMs = Math.max(0, Date.parse(event.at) - base)
          this.clampTimings(trace)
        }
        break
      }
      case 'assistant.audio': {
        if (!turnId) break
        const trace = this.ensure(turnId, 'voice', '', event.at)
        this.counters.audioSegments += 1
        trace.audioSegments += 1
        if (trace.firstAudioMs === null) {
          trace.firstAudioMs = Math.max(0, Date.parse(event.at) - Date.parse(trace.startedAt))
          this.clampTimings(trace)
        }
        break
      }
      case 'assistant.done': {
        if (!turnId) break
        const trace = this.ensure(turnId, str(data.source, 'text'), str(data.text), event.at)
        trace.totalMs = num(data.durationMs, Date.parse(event.at) - Date.parse(trace.startedAt))
        this.clampTimings(trace)
        trace.contextCount = Array.isArray(data.contextUsed) ? data.contextUsed.length : trace.contextCount
        trace.memoryCount = Array.isArray(data.memoryIds) ? data.memoryIds.length : trace.memoryCount
        if (data.error) {
          trace.status = 'error'
          trace.error = str(data.error)
          this.counters.errors += 1
        } else {
          trace.status = 'ok'
        }
        this.pushSeries(trace)
        break
      }
      case 'assistant.cancelled': {
        const trace = this.latestRunning()
        if (trace) {
          trace.status = 'cancelled'
          trace.totalMs = Date.parse(event.at) - Date.parse(trace.startedAt)
          this.pushSeries(trace)
        }
        break
      }
      case 'memory.recalled': {
        this.counters.recalls += 1
        this.recalls.push({
          at: event.at,
          query: str(data.query),
          ids: Array.isArray(data.ids) ? data.ids.map(String) : [],
          confidence: num(data.confidence),
        })
        if (this.recalls.length > 30) this.recalls.splice(0, this.recalls.length - 30)
        break
      }
      case 'memory.added':
        this.counters.memoryAdded += 1
        break
      case 'memory.proposed':
        this.counters.memoryProposed += 1
        break
      case 'sense.capture':
        this.counters.captures += 1
        break
      case 'action.proposed':
      case 'action.executed':
      case 'action.denied':
      case 'action.failed':
        this.counters.actions += 1
        break
      case 'model.changed':
        this.counters.modelSwitches += 1
        break
      default:
        break
    }
  }

  private clampTimings(trace: TurnTrace): void {
    if (trace.totalMs === null) return
    if (trace.firstTokenMs !== null) trace.firstTokenMs = Math.min(trace.firstTokenMs, trace.totalMs)
    if (trace.firstAudioMs !== null) trace.firstAudioMs = Math.min(trace.firstAudioMs, trace.totalMs)
    if (trace.asrMs !== null) trace.asrMs = Math.min(trace.asrMs, trace.totalMs)
  }

  private ensure(id: string, source: string, text: string, at: string): TurnTrace {
    let trace = this.traces.get(id)
    if (!trace) {
      trace = {
        id,
        source,
        text,
        startedAt: at,
        status: 'running',
        firstTokenMs: null,
        firstAudioMs: null,
        totalMs: null,
        asrMs: null,
        asrAudioMs: null,
        audioSegments: 0,
        contextCount: 0,
        memoryCount: 0,
      }
      this.traces.set(id, trace)
      this.order.push(id)
      while (this.order.length > MAX_TRACES) {
        const removed = this.order.shift()
        if (removed) this.traces.delete(removed)
      }
    }
    return trace
  }

  private pushSeries(trace: TurnTrace): void {
    this.persist(trace)
    this.series.push({
      at: new Date().toISOString(),
      source: trace.source,
      totalMs: trace.totalMs,
      firstTokenMs: trace.firstTokenMs,
      firstAudioMs: trace.firstAudioMs,
      ok: trace.status === 'ok',
    })
    while (this.series.length > MAX_TRACES) this.series.shift()
  }

  private latestRunning(): TurnTrace | null {
    for (let i = this.order.length - 1; i >= 0; i -= 1) {
      const trace = this.traces.get(this.order[i])
      if (trace?.status === 'running') return trace
    }
    return null
  }

  snapshot(): TelemetrySnapshot {
    const memory = process.memoryUsage()
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeMs: Date.now() - this.startedAt.getTime(),
      counters: { ...this.counters },
      turns: this.order.map(id => this.traces.get(id)).filter((item): item is TurnTrace => Boolean(item)).slice().reverse(),
      series: [...this.series],
      recalls: [...this.recalls].reverse(),
      eventCounts: { ...this.eventCounts },
      events: [...this.eventRing].reverse(),
      system: {
        load1: loadavg()[0] ?? 0,
        load5: loadavg()[1] ?? 0,
        load15: loadavg()[2] ?? 0,
        cpuCount: cpus().length,
        freeMemMb: Math.round(freemem() / 1024 / 1024),
        totalMemMb: Math.round(totalmem() / 1024 / 1024),
        processRssMb: Math.round(memory.rss / 1024 / 1024),
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      },
    }
  }
}
