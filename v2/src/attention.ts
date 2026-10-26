import type { EventBus } from './events.ts'

export const ATTENTION_STATES = [
  'idle',
  'considering',
  'listening',
  'capturing',
  'understanding',
  'need_context',
  'responding',
  'followup',
] as const

export type AttentionState = (typeof ATTENTION_STATES)[number]

export const ATTENTION_EVENTS = [
  'wake',
  'ptt_start',
  'ptt_stop',
  'speech_start',
  'speech_end',
  'context_needed',
  'context_ready',
  'context_denied',
  'respond_start',
  'respond_done',
  'proactive_consider',
  'proactive_speak',
  'proactive_silent',
  'barge_in',
  'cancel',
  'followup_expired',
  'timeout',
  'error',
] as const

export type AttentionEventType = (typeof ATTENTION_EVENTS)[number]

export interface AttentionEvent {
  type: AttentionEventType
  reason?: string
}

export interface AttentionTransition {
  from: AttentionState
  event: AttentionEventType
  to: AttentionState
}

export interface AttentionSnapshot {
  state: AttentionState
  since: string
  lastEvent: AttentionEvent | null
}

const TRANSITIONS: Record<AttentionState, Partial<Record<AttentionEventType, AttentionState>>> = {
  idle: {
    wake: 'listening',
    ptt_start: 'listening',
    speech_start: 'capturing',
    proactive_consider: 'considering',
  },
  considering: {
    proactive_speak: 'responding',
    proactive_silent: 'idle',
    timeout: 'idle',
    cancel: 'idle',
  },
  listening: {
    speech_start: 'capturing',
    ptt_stop: 'understanding',
    speech_end: 'understanding',
    cancel: 'idle',
    timeout: 'idle',
  },
  capturing: {
    ptt_stop: 'understanding',
    speech_end: 'understanding',
    cancel: 'idle',
    timeout: 'idle',
  },
  understanding: {
    context_needed: 'need_context',
    context_ready: 'understanding',
    context_denied: 'responding',
    respond_start: 'responding',
    cancel: 'idle',
    error: 'idle',
    timeout: 'idle',
  },
  need_context: {
    context_ready: 'understanding',
    context_denied: 'responding',
    cancel: 'idle',
    error: 'idle',
    timeout: 'idle',
  },
  responding: {
    respond_done: 'followup',
    barge_in: 'listening',
    cancel: 'idle',
    error: 'idle',
    timeout: 'followup',
  },
  followup: {
    wake: 'listening',
    ptt_start: 'listening',
    speech_start: 'capturing',
    followup_expired: 'idle',
    cancel: 'idle',
    timeout: 'idle',
  },
}

export interface ContextDecision {
  target: 'screen' | 'camera' | 'none' | 'ask'
  confidence: number
  reason: string
}

const CAMERA_PATTERN = /(我这边|我这里|我手上|手上|桌上|镜头|摄像头|拍一下|看一下我|看看我|我穿的|这个房间|面前)/
const SCREEN_PATTERN = /(屏幕|这页|这份|文档|当前窗口|代码|网页|页面|这个界面|看下这个|看一下这个|帮我看看这个)/

export class AttentionManager {
  private state: AttentionState = 'idle'
  private since = new Date().toISOString()
  private lastEvent: AttentionEvent | null = null
  private readonly listeners = new Set<(snapshot: AttentionSnapshot) => void>()

  constructor(private readonly bus: EventBus) {}

  getState(): AttentionState {
    return this.state
  }

  snapshot(): AttentionSnapshot {
    return { state: this.state, since: this.since, lastEvent: this.lastEvent }
  }

  onChange(listener: (snapshot: AttentionSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(event: AttentionEvent): { ok: boolean; state: AttentionState } {
    const next = TRANSITIONS[this.state][event.type]
    if (!next) {
      this.bus.emit('attention.invalid', {
        from: this.state,
        event: event.type,
        reason: event.reason ?? null,
      })
      return { ok: false, state: this.state }
    }
    const from = this.state
    this.state = next
    this.since = new Date().toISOString()
    this.lastEvent = event
    const snapshot = this.snapshot()
    this.bus.emit('attention.state', { ...snapshot, from, event: event.type, reason: event.reason ?? null })
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // State listeners must not break the state machine.
      }
    }
    return { ok: true, state: this.state }
  }

  decideContext(text: string): ContextDecision {
    const normalized = text.trim()
    if (!normalized) return { target: 'none', confidence: 0, reason: 'empty' }
    const camera = CAMERA_PATTERN.test(normalized) || /(摄像头|镜头|camera)/i.test(normalized)
    const screen = SCREEN_PATTERN.test(normalized) || /(屏幕|screenshot|screen)/i.test(normalized)
    if (camera && screen) return { target: 'ask', confidence: 0.4, reason: 'ambiguous_explicit' }
    if (/(摄像头|镜头|camera)/i.test(normalized)) return { target: 'camera', confidence: 0.95, reason: 'explicit_camera' }
    if (/(屏幕|screenshot|screen)/i.test(normalized)) return { target: 'screen', confidence: 0.95, reason: 'explicit_screen' }
    if (camera && !screen) return { target: 'camera', confidence: 0.8, reason: 'deictic_camera' }
    if (screen && !camera) return { target: 'screen', confidence: 0.8, reason: 'deictic_screen' }
    if (camera && screen) return { target: 'ask', confidence: 0.4, reason: 'ambiguous_deictic' }
    if (/(看|看看|瞧)/.test(normalized) && /(这个|那个|它)/.test(normalized)) {
      return { target: 'screen', confidence: 0.55, reason: 'work_default_screen' }
    }
    return { target: 'none', confidence: 0, reason: 'no_context_cue' }
  }

  reset(reason = 'manual'): void {
    this.state = 'idle'
    this.since = new Date().toISOString()
    this.lastEvent = { type: 'cancel', reason }
    this.bus.emit('attention.state', { ...this.snapshot(), from: 'any', event: 'cancel', reason })
  }
}