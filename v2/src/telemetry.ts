import { loadavg, totalmem, freemem, cpus } from 'node:os'
import type { EventBus, JarvisEvent } from './events.ts'

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
  audioSegments: number
  contextCount: number
  memoryCount: number
  error?: string
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

  constructor(private readonly bus: EventBus) {
    this.unsubscribe = bus.onAny(event => this.record(event))
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
        if (!trace.text) trace.text = str(data.text)
        break
      }
      case 'assistant.delta': {
        if (!turnId) break
        const trace = this.ensure(turnId, 'text', '', event.at)
        if (trace.firstTokenMs === null) {
          const base = Date.parse(trace.modelStartedAt ?? trace.startedAt)
          trace.firstTokenMs = Math.max(0, Date.parse(event.at) - base)
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
        }
        break
      }
      case 'assistant.done': {
        if (!turnId) break
        const trace = this.ensure(turnId, str(data.source, 'text'), str(data.text), event.at)
        trace.totalMs = num(data.durationMs, Date.parse(event.at) - Date.parse(trace.startedAt))
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
