import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  child(scope: string): Logger
}

function redact(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (/token|key|secret|password|authorization/i.test(key)) {
      out[key] = '<redacted>'
    } else if (typeof value === 'string' && value.length > 500) {
      out[key] = `${value.slice(0, 500)}…`
    } else {
      out[key] = value
    }
  }
  return out
}

export function createLogger(level: LogLevel = 'info', file?: string): Logger {
  if (file) mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const threshold = LEVELS[level] ?? LEVELS.info

  function write(scope: string, lineLevel: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVELS[lineLevel] < threshold) return
    const at = new Date().toISOString()
    const clean = meta ? redact(meta) : undefined
    const suffix = clean && Object.keys(clean).length ? ` ${JSON.stringify(clean)}` : ''
    const line = `${at} ${lineLevel.toUpperCase().padEnd(5)} ${scope} ${message}${suffix}`
    if (lineLevel === 'error') console.error(line)
    else if (lineLevel === 'warn') console.warn(line)
    else console.log(line)
    if (file) {
      try {
        appendFileSync(file, `${line}\n`, { mode: 0o600 })
      } catch {
        // Logging must never take the assistant down.
      }
    }
  }

  function make(scope: string): Logger {
    return {
      debug: (message, meta) => write(scope, 'debug', message, meta),
      info: (message, meta) => write(scope, 'info', message, meta),
      warn: (message, meta) => write(scope, 'warn', message, meta),
      error: (message, meta) => write(scope, 'error', message, meta),
      child: (childScope) => make(`${scope}/${childScope}`),
    }
  }

  return make('jarvis')
}

export function defaultLogFile(dataDir: string): string {
  return join(dataDir, 'jarvis.log')
}