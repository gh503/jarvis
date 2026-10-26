import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AttentionManager } from '../src/attention.ts'
import type { JarvisConfig } from '../src/config.ts'
import { Conversation } from '../src/conversation.ts'
import { EventBus } from '../src/events.ts'
import type { Logger } from '../src/logger.ts'
import { HashEmbedder } from '../src/memory/embedding.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { ProactivePolicy } from '../src/proactive/policy.ts'
import { ReminderStore } from '../src/proactive/reminders.ts'
import type { ModelClient } from '../src/model/types.ts'
import { TuningStore } from '../src/tuning.ts'
import { SecureFiles } from '../src/secure-files.ts'

const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } } as unknown as Logger

function config(dataDir: string): JarvisConfig {
  return {
    version: '2.0.0', host: '127.0.0.1', port: 0, dataDir, webDir: join(import.meta.dirname, '..', 'web'),
    authToken: 'test-token-0123456789abcdef', tlsCert: '', tlsKey: '',
    ollama: { url: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', visionModel: 'qwen2.5vl:3b', embedModel: 'nomic-embed-text', keepAlive: '24h' },
    voice: { asrEngine: 'faster-whisper', whisperBin: '', whisperModel: '', fasterWhisperScript: '', fasterWhisperModel: 'tiny', ocrScript: '', pythonBin: 'python3', piperBin: '', piperVoice: '', ffmpeg: 'ffmpeg', arecord: 'arecord' },
    quiet: { start: '22:00', end: '08:00' }, dailySpeakBudget: 5, screenTimeoutMs: 15000, screenBlocklist: [],
  }
}

test('a plain-language move updates the old location without calling the model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-update-'))
  const cfg = config(dir)
  const bus = new EventBus()
  const memory = new MemoryStore({ file: ':memory:', embedder: new HashEmbedder() })
  const old = await memory.add({ kind: 'semantic', content: '我住在上海浦东。', sourceKind: 'user-stated', sourceRef: 'old', status: 'confirmed' })
  const reminders = new ReminderStore(join(dir, 'jarvis.db'))
  const tuning = new TuningStore(join(dir, 'tuning.json'), cfg)
  await tuning.load()
  let modelCalls = 0
  const model = {
    model: 'fake',
    health: async () => ({ ok: true, models: [{ name: 'fake' }] }),
    warmup: async () => ({ chatMs: 0, embedMs: 0 }),
    async *chatStream() { modelCalls += 1; yield '不应调用模型。' },
  } as unknown as ModelClient
  const conversation = new Conversation({
    config: cfg, bus, attention: new AttentionManager(bus), memory, model,
    transcriber: { available: async () => false, transcribe: async () => ({ text: '', language: 'zh', durationMs: 0 }) } as never,
    synthesizer: { available: async () => false, warmup: async () => {}, reconfigure: async () => {} } as never,
    screen: {} as never, camera: {} as never, ocr: {} as never, actions: {} as never,
    reminders, policy: new ProactivePolicy(cfg), tuning, secure: new SecureFiles(dir), logger,
  })
  await conversation.initialize()
  try {
    const result = await conversation.handleText('我搬到杭州西湖区了。', { skipAttention: true })
    assert.match(result.reply, /杭州/)
    assert.match(result.reply, /上海/)
    assert.equal(modelCalls, 0)
    assert.equal(memory.get(old.id)?.status, 'superseded')
    const current = await memory.recall('杭州 住址')
    assert.equal(current.items[0]?.content.includes('杭州'), true)
  } finally {
    reminders.close()
    memory.close()
    await rm(dir, { recursive: true, force: true })
  }
})
