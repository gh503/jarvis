import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface JarvisConfig {
  version: string
  host: string
  port: number
  dataDir: string
  webDir: string
  authToken: string
  tlsCert: string
  tlsKey: string
  ollama: {
    url: string
    model: string
    visionModel: string
    embedModel: string
  }
  voice: {
    asrEngine: 'faster-whisper' | 'whisper.cpp'
    whisperBin: string
    whisperModel: string
    fasterWhisperScript: string
    fasterWhisperModel: string
    ocrScript: string
    pythonBin: string
    piperBin: string
    piperVoice: string
    ffmpeg: string
    arecord: string
  }
  quiet: {
    start: string
    end: string
  }
  dailySpeakBudget: number
  screenTimeoutMs: number
  screenBlocklist: string[]
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3081,
  dataDir: '~/.local/share/jarvis/data',
  ollamaUrl: 'http://127.0.0.1:11434',
  llmModel: 'qwen2.5:3b',
  visionModel: 'qwen2.5vl:3b',
  embedModel: 'nomic-embed-text',
  whisperBin: '~/.local/share/jarvis/src/whisper.cpp/build/bin/whisper-cli',
  whisperModel: '~/.local/share/jarvis/models/ggml-small.bin',
  fasterWhisperModel: 'tiny',
  pythonBin: 'python3',
  piperBin: '~/.local/share/jarvis/src/piper/piper/piper',
  piperVoice: '~/.local/share/jarvis/models/zh_CN-huayan-medium.onnx',
  quietStart: '22:00',
  quietEnd: '08:00',
  dailySpeakBudget: '5',
  screenTimeoutMs: '15000',
  screenBlocklist: '1password,bitwarden,keepass,银行,网银,密码',
} as const

function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

function absolute(value: string, fallback: string): string {
  const expanded = expandHome(value || fallback)
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
}

export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 1) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function loadDotEnv(): void {
  const file = join(import.meta.dirname, '..', '.env')
  if (!existsSync(file)) return
  const parsed = parseEnvFile(readFileSync(file, 'utf8'))
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`JARVIS_PORT must be an integer from 1 to 65535 (got ${value})`)
  }
  return port
}

function parseTime(value: string, name: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${name} must be HH:MM (got ${value})`)
  }
  return value
}

export function loadConfig(): JarvisConfig {
  loadDotEnv()

  const host = env('JARVIS_HOST', DEFAULTS.host)
  const authToken = env('JARVIS_AUTH_TOKEN', '')
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (!loopback && authToken.length < 24) {
    throw new Error('Remote access requires JARVIS_AUTH_TOKEN of at least 24 characters')
  }

  const tlsCert = env('JARVIS_TLS_CERT', '')
  const tlsKey = env('JARVIS_TLS_KEY', '')
  if (Boolean(tlsCert) !== Boolean(tlsKey)) {
    throw new Error('JARVIS_TLS_CERT and JARVIS_TLS_KEY must be set together')
  }
  if (!loopback && !tlsCert) {
    throw new Error('Remote access requires JARVIS_TLS_CERT/JARVIS_TLS_KEY (or run behind a TLS tunnel)')
  }

  const dataDir = absolute(env('JARVIS_DATA_DIR', DEFAULTS.dataDir), DEFAULTS.dataDir)
  const webDir = absolute(env('JARVIS_WEB_DIR', join(import.meta.dirname, '..', 'web')), join(import.meta.dirname, '..', 'web'))

  return {
    version: '2.0.0',
    host,
    port: parsePort(env('JARVIS_PORT', String(DEFAULTS.port))),
    dataDir,
    webDir,
    authToken,
    tlsCert: tlsCert ? absolute(tlsCert, tlsCert) : '',
    tlsKey: tlsKey ? absolute(tlsKey, tlsKey) : '',
    ollama: {
      url: env('JARVIS_OLLAMA_URL', DEFAULTS.ollamaUrl).replace(/\/+$/, ''),
      model: env('JARVIS_LLM_MODEL', DEFAULTS.llmModel),
      visionModel: env('JARVIS_VISION_MODEL', DEFAULTS.visionModel),
      embedModel: env('JARVIS_EMBED_MODEL', DEFAULTS.embedModel),
    },
    voice: {
      asrEngine: env('JARVIS_ASR_ENGINE', 'faster-whisper') === 'whisper.cpp' ? 'whisper.cpp' : 'faster-whisper',
      whisperBin: absolute(env('JARVIS_WHISPER_BIN', DEFAULTS.whisperBin), DEFAULTS.whisperBin),
      whisperModel: absolute(env('JARVIS_WHISPER_MODEL', DEFAULTS.whisperModel), DEFAULTS.whisperModel),
      fasterWhisperScript: absolute(env('JARVIS_ASR_SCRIPT', join(import.meta.dirname, '..', 'scripts', 'asr_worker.py')), join(import.meta.dirname, '..', 'scripts', 'asr_worker.py')),
      fasterWhisperModel: env('JARVIS_ASR_MODEL', DEFAULTS.fasterWhisperModel),
      ocrScript: absolute(env('JARVIS_OCR_SCRIPT', join(import.meta.dirname, '..', 'scripts', 'ocr_worker.py')), join(import.meta.dirname, '..', 'scripts', 'ocr_worker.py')),
      pythonBin: env('JARVIS_PYTHON', DEFAULTS.pythonBin),
      piperBin: absolute(env('JARVIS_PIPER_BIN', DEFAULTS.piperBin), DEFAULTS.piperBin),
      piperVoice: absolute(env('JARVIS_PIPER_VOICE', DEFAULTS.piperVoice), DEFAULTS.piperVoice),
      ffmpeg: env('JARVIS_FFMPEG', 'ffmpeg'),
      arecord: env('JARVIS_ARECORD', 'arecord'),
    },
    quiet: {
      start: parseTime(env('JARVIS_QUIET_START', DEFAULTS.quietStart), 'JARVIS_QUIET_START'),
      end: parseTime(env('JARVIS_QUIET_END', DEFAULTS.quietEnd), 'JARVIS_QUIET_END'),
    },
    dailySpeakBudget: Math.max(0, Math.min(50, Number(env('JARVIS_DAILY_SPEAK_BUDGET', DEFAULTS.dailySpeakBudget)))),
    screenTimeoutMs: Math.max(3000, Math.min(120000, Number(env('JARVIS_SCREEN_TIMEOUT_MS', DEFAULTS.screenTimeoutMs)) || 15000)),
    screenBlocklist: env('JARVIS_SCREEN_BLOCKLIST', DEFAULTS.screenBlocklist)
      .split(',')
      .map(item => item.trim().toLowerCase())
      .filter(Boolean),
  }
}

export function ensureRuntimeDirs(config: JarvisConfig): void {
  for (const dir of [
    config.dataDir,
    join(config.dataDir, 'tmp'),
    join(config.dataDir, 'audio'),
    join(config.dataDir, 'captures'),
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const tokenFile = join(config.dataDir, 'auth-token')
  if (!config.authToken && existsSync(tokenFile)) {
    config.authToken = readFileSync(tokenFile, 'utf8').trim()
  }
  if (!config.authToken) {
    // A loopback-only server does not need a token. Generate one anyway so a
    // later switch to a private host is fail-closed rather than open.
    const token = randomBytes(24).toString('base64url')
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
    config.authToken = token
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function defaultDataDir(): string {
  return join(homedir(), '.local', 'share', 'jarvis', 'data')
}

export function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
}