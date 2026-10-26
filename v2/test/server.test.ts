import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ActionManager } from '../src/actions.ts'
import { AttentionManager } from '../src/attention.ts'
import type { JarvisConfig } from '../src/config.ts'
import type { Conversation } from '../src/conversation.ts'
import { EventBus } from '../src/events.ts'
import type { Logger } from '../src/logger.ts'
import { NullEmbedder } from '../src/memory/embedding.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { ModelRouter, createModelClient } from '../src/model/router.ts'
import { ModelSettingsStore } from '../src/model/settings.ts'
import { TuningStore } from '../src/tuning.ts'
import { TelemetryCollector } from '../src/telemetry.ts'
import { ProactivePolicy } from '../src/proactive/policy.ts'
import { ReminderStore } from '../src/proactive/reminders.ts'
import { JarvisServer } from '../src/server.ts'
import { WebSocket } from 'ws'

function testConfig(dataDir: string): JarvisConfig {
  return {
    version: '2.0.0',
    host: '127.0.0.1',
    port: 0,
    dataDir,
    webDir: join(import.meta.dirname, '..', 'web'),
    authToken: 'test-token-0123456789abcdef',
    tlsCert: '',
    tlsKey: '',
    ollama: { url: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', visionModel: 'qwen2.5vl:3b', embedModel: 'nomic-embed-text', keepAlive: '24h' },
    voice: { asrEngine: 'faster-whisper', whisperBin: '', whisperModel: '', fasterWhisperScript: '', fasterWhisperModel: 'tiny', ocrScript: '', pythonBin: 'python3', piperBin: '', piperVoice: '', ffmpeg: 'ffmpeg', arecord: 'arecord' },
    quiet: { start: '22:00', end: '08:00' },
    dailySpeakBudget: 5,
    screenTimeoutMs: 15000,
    screenBlocklist: [],
  }
}

const logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return this },
} as unknown as Logger

test('server enforces proxy auth, CSRF and serves the shell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-server-'))
  const config = testConfig(dir)
  const bus = new EventBus()
  const memory = new MemoryStore({ file: join(dir, 'jarvis.db'), embedder: new NullEmbedder() })
  await memory.add({ kind: 'semantic', content: '测试记忆：观察台需要可读。', sourceKind: 'user-confirmed', sourceRef: 'test', status: 'confirmed' })
  const reminders = new ReminderStore(join(dir, 'jarvis.db'))
  const actions = new ActionManager({ auditFile: join(dir, 'audit', 'actions.jsonl'), runner: async () => {} })
  const conversation = {
    status: () => ({ modelReady: true, model: 'qwen2.5:3b' }),
    handleText: async (text: string) => ({ reply: `echo:${text}` }),
    handleAudio: async () => ({ reply: 'audio' }),
    recall: async () => ({ items: [], confidence: 0, why: [], missing: [], queryType: 'fact' }),
    memoryItems: () => [],
    cancel: () => {},
    cleanupAudio: async () => {},
    cleanupCaptures: async () => {},
    handleReminder: async () => {},
    refreshModel: async () => true,
    reconfigureVoice: async () => {},
  } as unknown as Conversation
  const localProfile = {
    id: 'local', label: '本地 Ollama', kind: 'ollama' as const,
    baseUrl: config.ollama.url, model: config.ollama.model, apiKey: '',
    visionModel: config.ollama.visionModel, embedModel: config.ollama.embedModel, keepAlive: '24h',
  }
  const models = new ModelRouter(createModelClient(localProfile), localProfile)
  const tuning = new TuningStore(join(dir, 'tuning.json'), config)
  const telemetry = new TelemetryCollector(bus)
  const modelSettings = new ModelSettingsStore(join(dir, 'model-config.json'), {
    local: { baseUrl: config.ollama.url, model: config.ollama.model, visionModel: config.ollama.visionModel, embedModel: config.ollama.embedModel, keepAlive: '24h' },
  })
  const server = new JarvisServer({
    config,
    bus,
    attention: new AttentionManager(bus),
    conversation,
    models,
    modelSettings,
    tuning,
    telemetry,
    actions,
    memory,
    reminders,
    policy: new ProactivePolicy(config),
    logger,
  })
  const { url } = await server.start()
  try {
    const shell = await fetch(`${url}/`)
    assert.equal(shell.status, 200)
    assert.equal(shell.headers.get('cache-control'), 'no-cache')
    assert.match(await shell.text(), /Jarvis/)

    const proxied = await fetch(`${url}/api/health`, { headers: { 'x-forwarded-for': '203.0.113.9' } })
    assert.equal(proxied.status, 401)

    const authed = await fetch(`${url}/api/health`, {
      headers: { 'x-forwarded-for': '203.0.113.9', authorization: `Bearer ${config.authToken}` },
    })
    assert.equal(authed.status, 200)

    const evil = await fetch(`${url}/api/health`, {
      headers: { 'x-forwarded-for': '203.0.113.9', authorization: `Bearer ${config.authToken}`, origin: 'https://evil.example' },
    })
    assert.equal(evil.status, 403)

    const local = await fetch(`${url}/api/health`)
    assert.equal(local.status, 200)

    const model = await fetch(`${url}/api/model`)
    assert.equal(model.status, 200)
    assert.doesNotMatch(await model.text(), /apiKey|sk-secret/)

    const observatory = await fetch(`${url}/api/observatory`)
    assert.equal(observatory.status, 200)
    const observatoryBody = await observatory.json() as { telemetry?: unknown; memory?: { stats?: { total?: number } } }
    assert.ok(observatoryBody.telemetry)
    assert.equal(observatoryBody.memory?.stats?.total, 1)

    const configResponse = await fetch(`${url}/api/config`)
    assert.equal(configResponse.status, 200)
    const configText = await configResponse.text()
    assert.doesNotMatch(configText, /test-token-0123456789abcdef/)
    assert.match(configText, /tokenConfigured/)

    const tuningResponse = await fetch(`${url}/api/tuning`)
    assert.equal(tuningResponse.status, 200)
    const tuningUpdate = await fetch(`${url}/api/tuning`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { 'conversation.temperature': 1.1, 'ui.particles': 999 } }),
    })
    assert.equal(tuningUpdate.status, 200)
    const tuningBody = await tuningUpdate.json() as { values: Record<string, number> }
    assert.equal(tuningBody.values['conversation.temperature'], 1.1)
    assert.equal(tuningBody.values['ui.particles'], 60)
    const badTuning = await fetch(`${url}/api/tuning`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { 'nope.key': 1 } }),
    })
    assert.equal(badTuning.status, 400)

    const demoGuard = await fetch(`${url}/api/dev/demo-memory`, { method: 'POST' })
    assert.equal(demoGuard.status, 403)

    const graph = await fetch(`${url}/api/memory/graph`)
    assert.equal(graph.status, 200)
    const graphBody = await graph.json() as { nodes?: unknown[] }
    assert.equal(graphBody.nodes?.length, 1)

    const noKeyRemote = await fetch(`${url}/api/model/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'remote' }),
    })
    assert.equal(noKeyRemote.status, 409)
    const plainRemote = await fetch(`${url}/api/model/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'remote', kind: 'openai', baseUrl: 'http://example.com/v1', model: 'm', apiKey: 'sk-secret' }),
    })
    assert.equal(plainRemote.status, 400)
    assert.match(await plainRemote.text(), /HTTPS/)

    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws?token=${config.authToken}`)
    const hello = await new Promise<{ kind: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket hello timeout')), 3000)
      ws.once('message', data => {
        clearTimeout(timer)
        resolve(JSON.parse(data.toString()) as { kind: string })
      })
      ws.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
    })
    assert.equal(hello.kind, 'hello')
    ws.close()
  } finally {
    await server.close()
    reminders.close()
    memory.close()
    await rm(dir, { recursive: true, force: true })
  }
})
