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
import { ProactivePolicy } from '../src/proactive/policy.ts'
import { ReminderStore } from '../src/proactive/reminders.ts'
import { JarvisServer } from '../src/server.ts'
import { SecureFiles } from '../src/secure-files.ts'
import { TelemetryCollector } from '../src/telemetry.ts'
import { TuningStore } from '../src/tuning.ts'

const logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return this },
} as unknown as Logger

async function startServer(dir: string) {
  const config = {
    version: '2.0.0', host: '127.0.0.1', port: 0, dataDir: dir,
    webDir: join(import.meta.dirname, '..', 'web'),
    authToken: 'test-token-0123456789abcdef', tlsCert: '', tlsKey: '',
    ollama: { url: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', visionModel: '', embedModel: '', keepAlive: '24h' },
    voice: { asrEngine: 'faster-whisper', whisperBin: '', whisperModel: '', fasterWhisperScript: '', fasterWhisperModel: 'tiny', ocrScript: '', pythonBin: 'python3', piperBin: '', piperVoice: '', ffmpeg: 'ffmpeg', arecord: 'arecord' },
    quiet: { start: '22:00', end: '08:00' }, dailySpeakBudget: 5, screenTimeoutMs: 15000, screenBlocklist: [],
  } as JarvisConfig
  const bus = new EventBus()
  const conversation = {
    status: () => ({ modelReady: true, model: 'qwen2.5:3b' }),
    handleText: async () => ({ reply: 'ok' }),
    handleAudio: async () => ({ reply: 'ok' }),
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
    id: 'local', label: '本地 Ollama', kind: 'ollama' as const, protocol: 'chat-completions' as const,
    baseUrl: config.ollama.url, model: config.ollama.model, apiKey: '',
    visionModel: '', embedModel: '', keepAlive: '24h',
  }
  const models = new ModelRouter(createModelClient(localProfile), localProfile)
  const modelSettings = new ModelSettingsStore(join(dir, 'model-config.json'), {
    local: { baseUrl: config.ollama.url, model: config.ollama.model, visionModel: '', embedModel: '', keepAlive: '24h' },
  })
  const server = new JarvisServer({
    config, bus, attention: new AttentionManager(bus), conversation, models, modelSettings,
    tuning: new TuningStore(join(dir, 'tuning.json'), config),
    telemetry: new TelemetryCollector(bus),
    actions: new ActionManager({ auditFile: join(dir, 'audit', 'actions.jsonl'), runner: async () => {} }),
    memory: new MemoryStore({ file: join(dir, 'jarvis.db'), embedder: new NullEmbedder() }),
    reminders: new ReminderStore(join(dir, 'jarvis.db')),
    policy: new ProactivePolicy(config),
    secure: new SecureFiles(config.dataDir),
    logger,
  })
  const { url } = await server.start()
  return { server, url }
}

test('provider pool and scenario endpoints persist settings and hide keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-model-api-'))
  const { server, url } = await startServer(dir)
  try {
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })

    // Add a provider; it lands in the priority chain before local.
    const add = await post('/api/model/profile/add', {
      id: 'groq', label: 'Groq', kind: 'openai', protocol: 'chat-completions',
      baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', apiKey: 'gsk_secret',
    })
    assert.equal(add.status, 200)
    const added = await add.json() as { settings: { profiles: Array<{ id: string; hasKey?: boolean; apiKey?: string }>; priority: string[] } }
    const groq = added.settings.profiles.find(item => item.id === 'groq')
    assert.equal(groq?.hasKey, true)
    assert.equal(groq && 'apiKey' in groq, false)
    assert.deepEqual(added.settings.priority, ['remote', 'groq', 'local'])

    // Duplicate id rejected.
    const dup = await post('/api/model/profile/add', { id: 'groq', baseUrl: 'https://x.example/v1', model: 'm' })
    assert.equal(dup.status, 400)

    // Priority update reorders; unknown ids rejected.
    const priority = await post('/api/model/priority', { priority: ['groq', 'local', 'remote'] })
    assert.equal(priority.status, 200)
    assert.deepEqual((await priority.json() as { settings: { priority: string[] } }).settings.priority, ['groq', 'local', 'remote'])
    const badPriority = await post('/api/model/priority', { priority: ['ghost'] })
    assert.equal(badPriority.status, 400)

    // Scenario update persists chain/model/temperature.
    const scenarios = await post('/api/model/scenarios', {
      scenarios: [{ id: 'coding', profileIds: ['groq'], model: 'openai/gpt-oss-120b', temperature: 0.1 }],
      scenarioAuto: true,
      defaultScenario: 'chat',
    })
    assert.equal(scenarios.status, 200)
    const saved = await scenarios.json() as { settings: { scenarios: Array<{ id: string; profileIds: string[]; model: string; temperature: number | null }> } }
    const coding = saved.settings.scenarios.find(item => item.id === 'coding')
    assert.deepEqual(coding?.profileIds, ['groq'])
    assert.equal(coding?.temperature, 0.1)

    // Editing a non-active profile works via profile/update.
    const update = await post('/api/model/profile/update', { id: 'groq', label: 'Groq 免费层' })
    assert.equal(update.status, 200)
    const updated = await update.json() as { settings: { profiles: Array<{ id: string; label: string }> } }
    assert.equal(updated.settings.profiles.find(item => item.id === 'groq')?.label, 'Groq 免费层')

    // Delete removes it from chains and scenarios.
    const deleted = await post('/api/model/profile/delete', { id: 'groq' })
    assert.equal(deleted.status, 200)
    const afterDelete = await deleted.json() as { settings: { priority: string[]; scenarios: Array<{ id: string; profileIds: string[] }> } }
    assert.ok(!afterDelete.settings.priority.includes('groq'))
    assert.ok(!afterDelete.settings.scenarios.find(item => item.id === 'coding')?.profileIds.includes('groq'))

    const gone = await post('/api/model/profile/delete', { id: 'groq' })
    assert.equal(gone.status, 400)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
