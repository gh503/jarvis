import type { JarvisConfig } from '../config.ts'

export interface ProactiveSignal {
  urgency: number
  relevance: number
  timeliness: number
  preference: number
  interruptCost: number
  channelCost: number
}

export interface SpeakDecision {
  speak: boolean
  score: number
  reason: string
  channel: 'voice' | 'toast' | 'silent'
}

function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export class ProactivePolicy {
  private focusMode = false
  private spokenDate = ''
  private spokenCount = 0
  private lastInteraction = 0

  constructor(private readonly config: JarvisConfig) {}

  setFocus(enabled: boolean): void {
    this.focusMode = enabled
  }

  isFocus(): boolean {
    return this.focusMode
  }

  noteInteraction(at = Date.now()): void {
    this.lastInteraction = at
  }

  isQuiet(now = new Date()): boolean {
    const minutes = now.getHours() * 60 + now.getMinutes()
    const [startH, startM] = this.config.quiet.start.split(':').map(Number)
    const [endH, endM] = this.config.quiet.end.split(':').map(Number)
    const start = startH * 60 + startM
    const end = endH * 60 + endM
    if (start === end) return false
    if (start < end) return minutes >= start && minutes < end
    return minutes >= start || minutes < end
  }

  private budget(): number {
    const today = localDay(new Date())
    if (today !== this.spokenDate) {
      this.spokenDate = today
      this.spokenCount = 0
    }
    return Math.max(0, this.config.dailySpeakBudget - this.spokenCount)
  }

  noteSpoken(): void {
    const today = localDay(new Date())
    if (today !== this.spokenDate) {
      this.spokenDate = today
      this.spokenCount = 0
    }
    this.spokenCount += 1
  }

  decide(signal: ProactiveSignal, now = new Date()): SpeakDecision {
    const score =
      0.3 * signal.urgency +
      0.2 * signal.relevance +
      0.15 * signal.timeliness +
      0.15 * signal.preference -
      0.3 * signal.interruptCost -
      0.2 * signal.channelCost

    if (this.focusMode) return { speak: false, score, reason: 'focus_mode', channel: 'silent' }
    if (this.isQuiet(now)) return { speak: false, score, reason: 'quiet_hours', channel: 'silent' }
    if (this.budget() <= 0) return { speak: false, score, reason: 'daily_budget_exhausted', channel: 'toast' }
    if (score < 0.15) return { speak: false, score, reason: 'interrupt_cost', channel: 'toast' }
    return { speak: true, score, reason: 'worth_interrupting', channel: 'voice' }
  }
}