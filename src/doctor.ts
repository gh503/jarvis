import { access, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type JarvisConfig } from './config.ts'
import { capabilities } from './platform.ts'
import { commandExists } from './util/process.ts'
import { validateProfile, type ModelProfile } from './model/settings.ts'

interface Check { name: string; ok: boolean; required: boolean; detail: string }
const checks: Check[] = []
function add(name: string, ok: boolean, detail: string, required = false): void {
  checks.push({ name, ok, required, detail })
}
async function readableFile(path: string): Promise<boolean> {
  try { await access(path, constants.R_OK); return (await stat(path)).isFile() } catch { return false }
}

/** Do not use ModelSettingsStore.load: it chmods the settings file. */
async function modelDiagnostics(config: JarvisConfig): Promise<void> {
  let saved: { active?: unknown; profiles?: Partial<ModelProfile>[] } = {}
  try {
    saved = JSON.parse(await readFile(join(config.dataDir, 'model-config.json'), 'utf8'))
    if (!saved || typeof saved !== 'object' || (saved.profiles !== undefined && !Array.isArray(saved.profiles))) throw new Error('invalid settings')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      add('model configuration', false, 'unreadable or invalid model-config.json; runtime falls back to defaults; connection not probed')
      return
    }
  }
  const known = ['local', 'remote', ...(saved.profiles ?? []).filter(item => item && typeof item.id === 'string' && /^[a-z0-9-]{1,32}$/.test(item.id)).map(item => item.id!)]
  const id = typeof saved.active === 'string' && known.includes(saved.active) ? saved.active : 'local'
  const defaults: ModelProfile = id === 'local' ? {
    id, label: 'Local', kind: 'ollama', protocol: 'chat-completions', baseUrl: config.ollama.url,
    model: config.ollama.model, apiKey: '', visionModel: config.ollama.visionModel,
    embedModel: config.ollama.embedModel, keepAlive: config.ollama.keepAlive,
  } : {
    id, label: 'Remote', kind: 'openai', protocol: 'chat-completions', baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat', apiKey: '', visionModel: '', embedModel: '', keepAlive: '',
  }
  const incoming = saved.profiles?.find(item => item && item.id === id)
  const profile = { ...defaults }
  for (const key of ['baseUrl', 'model', 'apiKey', 'visionModel', 'embedModel', 'keepAlive'] as const) {
    if (incoming?.[key] != null) profile[key] = String(incoming[key]).trim()
  }
  if (incoming?.kind === 'openai' || incoming?.kind === 'ollama') profile.kind = incoming.kind
  if (['responses', 'anthropic', 'chat-completions'].includes(incoming?.protocol ?? '')) profile.protocol = incoming!.protocol!
  try { validateProfile(profile) } catch {
    add('model configuration', false, `active=${id}; configured=false; invalid provider settings (values withheld); readiness=unknown`)
    return
  }
  const url = new URL(profile.baseUrl)
  add('model configuration', true, `active=${id}; kind=${profile.kind}; protocol=${profile.protocol}; configured=true; credentials=${profile.apiKey ? 'present' : 'absent'}; scenario/priority routing may choose another provider`)
  // Only unauthenticated GET on a literal loopback endpoint; no redirects,
  // inference, provider-store writes, or URLs/keys in diagnostic output.
  if (profile.kind !== 'ollama' || !['127.0.0.1', '[::1]'].includes(url.hostname) || profile.apiKey) {
    add('model connection', true, 'readiness=unknown; not probed (remote/authenticated provider); no inference or credentials sent')
    return
  }
  try {
    const response = await fetch(`${profile.baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(2000), redirect: 'error' })
    if (!response.ok) throw new Error('HTTP failure')
    const body = await response.json() as { models?: { name?: string }[] }
    if (!Array.isArray(body.models)) throw new Error('Invalid response')
    const installed = body.models.some(item => item.name === profile.model || item.name?.startsWith(`${profile.model}:`))
    add('model connection', true, `reachable=true; configured model installed=${installed}; inference readiness=unknown (read-only model list)`)
  } catch {
    add('model connection', false, 'reachable=false; readiness=unknown (loopback model-list probe failed; provider optional for core)')
  }
}

async function main(): Promise<void> {
  add('Node.js >= 24', Number(process.versions.node.split('.')[0]) >= 24, process.versions.node, true)
  let config: JarvisConfig
  try {
    config = loadConfig()
    if (!Number.isFinite(config.dailySpeakBudget)) throw new Error('invalid budget')
    add('configuration', true, 'valid; read-only inspection (no state directories or auth token created)', true)
  } catch {
    add('configuration', false, 'invalid configuration; check host/auth/TLS, port, quiet times and numeric settings (values withheld)', true)
    print()
    return
  }
  add('web assets', await readableFile(join(config.webDir, 'index.html')), 'configured web directory must contain a readable index.html', true)
  if (config.tlsCert) add('TLS files', await readableFile(config.tlsCert) && await readableFile(config.tlsKey), 'configured certificate/key readability; certificate validity not probed', true)
  await modelDiagnostics(config)
  const caps = capabilities(join(import.meta.dirname, '..'))
  for (const [name, detail] of Object.entries(caps.reasons)) add(name, false, detail)
  for (const [name, command] of [
    ['configured ffmpeg', config.voice.ffmpeg], ['configured Python', config.voice.pythonBin],
    ['configured Piper', config.voice.piperBin], ['configured arecord', config.voice.arecord],
  ]) {
    const installed = await commandExists(command!)
    add(name!, installed, `installed=${installed}; configured=true; readiness=unknown (executable discovery only)`)
  }
  const sandboxInstalled = process.platform === 'linux' && await commandExists('/usr/bin/bwrap')
  add('local shell sandbox', sandboxInstalled, `supported=${process.platform === 'linux'}; installed=${sandboxInstalled}; configured=unknown; readiness=unknown; permission=unknown (isolation not executed)`)
  const ocrWorker = await readableFile(config.voice.ocrScript)
  add('configured OCR', ocrWorker, `configured=true; worker present=${ocrWorker}; dependencies/model runtime readiness=unknown (no imports or downloads)`)
  const asrFiles = config.voice.asrEngine === 'faster-whisper'
    ? await readableFile(config.voice.fasterWhisperScript)
    : await commandExists(config.voice.whisperBin) && await readableFile(config.voice.whisperModel)
  add('configured ASR', asrFiles, `engine=${config.voice.asrEngine}; configured=true; worker/model files present=${asrFiles}; dependencies/model runtime readiness=unknown (no Python imports, model loads or downloads)`)
  add('configured Piper voice', await readableFile(config.voice.piperVoice), 'configured=true; readiness=unknown (voice not loaded)')
  add('memory database', await readableFile(join(config.dataDir, 'jarvis.db')), 'SQLite; existing database only inspected for presence, never opened or created; flock is not required')
  print()
}
function print(): void {
  for (const check of checks) console.log(`${check.ok ? '✓' : check.required ? '✗' : '!'} ${check.name.padEnd(28)} ${check.detail}`)
  const failed = checks.filter(check => !check.ok && check.required)
  console.log(`\n${failed.length ? `${failed.length} required check(s) failed.` : 'Core checks passed. Optional capabilities may be unavailable or unverified.'}`)
  process.exitCode = failed.length ? 1 : 0
}
void main().catch(() => { console.error('Diagnostics failed unexpectedly (details withheld to protect configuration secrets).'); process.exitCode = 1 })
