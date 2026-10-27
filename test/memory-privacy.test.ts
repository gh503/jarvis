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
import type { ChatMessage, ModelClient } from '../src/model/types.ts'
import { ProactivePolicy } from '../src/proactive/policy.ts'
import { ReminderStore } from '../src/proactive/reminders.ts'
import { SecureFiles } from '../src/secure-files.ts'
import { TuningStore } from '../src/tuning.ts'

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

test('sensitive memories stay out of the model context but remain visible locally', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-memory-privacy-'))
  const cfg = config(dir)
  const bus = new EventBus()
  const memory = new MemoryStore({ file: ':memory:', embedder: new HashEmbedder() })
  await memory.add({
    kind: 'semantic',
    content: '普通记忆：工作日通勤路线是地铁 2 号线，代号 ORBIT-STANDARD。',
    sourceKind: 'user-confirmed', sourceRef: 'test', status: 'confirmed', sensitivity: 'standard',
    importance: { explicit: 0.9 },
  })
  await memory.add({
    kind: 'semantic',
    content: '敏感记忆：家住测试大道 1 号，门禁码 ORBIT-SECRET。',
    sourceKind: 'user-confirmed', sourceRef: 'test', status: 'confirmed', sensitivity: 'sensitive',
    importance: { explicit: 0.9 },
  })
  const tuning = new TuningStore(join(dir, 'tuning.json'), cfg)
  await tuning.load()
  const sent: ChatMessage[][] = []
  const model = {
    model: 'fake',
    health: async () => ({ ok: true, models: [{ name: 'fake' }] }),
    warmup: async () => ({ chatMs: 0, embedMs: 0 }),
    async *chatStream(messages: ChatMessage[]) { sent.push(messages.map(item => ({ ...item }))); yield '好的。' },
  } as unknown as ModelClient
  const conversation = new Conversation({
    config: cfg, bus, attention: new AttentionManager(bus), memory, model,
    transcriber: { available: async () => false, transcribe: async () => ({ text: '', language: 'zh', durationMs: 0 }) } as never,
    synthesizer: { available: async () => false, warmup: async () => {}, reconfigure: async () => {} } as never,
    screen: {} as never, camera: {} as never, ocr: {} as never, actions: {} as never,
    reminders: new ReminderStore(join(dir, 'jarvis.db')), policy: new ProactivePolicy(cfg), tuning,
    secure: new SecureFiles(dir), logger,
  })
  await conversation.initialize()
  try {
    await conversation.handleText('我的通勤路线和门禁码是什么？', { skipAttention: true })
    assert.equal(sent.length, 1, 'the model should have been called once')
    const context = JSON.stringify(sent[0])
    assert.match(context, /ORBIT-STANDARD/, 'standard memory should reach the model as context')
    assert.doesNotMatch(context, /ORBIT-SECRET/, 'sensitive memory must never reach the model')

    // The owner's own local views still include sensitive items, so the UI can
    // show and manage them. That is display-local, not an outbound leak.
    assert.ok(conversation.memoryItems().some(item => item.sensitivity === 'sensitive'))
    const withSensitive = memory.list({ includeSensitive: true, limit: 50 })
    const withoutSensitive = memory.list({ limit: 50 })
    assert.ok(withSensitive.some(item => item.content.includes('ORBIT-SECRET')))
    assert.ok(!withoutSensitive.some(item => item.content.includes('ORBIT-SECRET')), 'default listing excludes sensitive rows')
    assert.ok(!JSON.stringify(memory.recall('门禁码')).includes('ORBIT-SECRET'), 'default recall excludes sensitive rows')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('non-standard memories are never sent to a remote embedding provider', async () => {
  const embedded: string[] = []
  const spy = {
    isLocal: false,
    embed: async (text: string) => { embedded.push(text); return new Float32Array([1, 0, 0]) },
  }
  const memory = new MemoryStore({ file: ':memory:', embedder: spy as never })
  try {
    await memory.add({
      kind: 'semantic', content: '敏感：家里门锁密码是 1234。', sourceKind: 'user-confirmed',
      sourceRef: 'test', status: 'confirmed', sensitivity: 'sensitive', importance: { explicit: 0.9 },
    })
    await memory.add({
      kind: 'semantic', content: '普通：喜欢喝美式。', sourceKind: 'user-confirmed',
      sourceRef: 'test', status: 'confirmed', sensitivity: 'standard', importance: { explicit: 0.5 },
    })
    assert.equal(embedded.length, 1, 'only the standard note is embedded')
    assert.ok(embedded[0].includes('美式'))
    assert.ok(!embedded.some(text => text.includes('门锁')))
    // It is still findable in this browser session via full-text search.
    const found = await memory.recall('门锁密码', { includeSensitive: true })
    assert.ok(found.items.some(item => item.content.includes('门锁')))
  } finally {
    memory.close()
  }
})
