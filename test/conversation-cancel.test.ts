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
import { NullEmbedder } from '../src/memory/embedding.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { ProactivePolicy } from '../src/proactive/policy.ts'
import { ReminderStore } from '../src/proactive/reminders.ts'
import type { ModelClient } from '../src/model/types.ts'
import { TuningStore } from '../src/tuning.ts'
import { SecureFiles } from '../src/secure-files.ts'

const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } } as unknown as Logger
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function config(dataDir: string): JarvisConfig {
  return {
    version: '2.0.0', host: '127.0.0.1', port: 0, dataDir, webDir: join(import.meta.dirname, '..', 'web'),
    authToken: 'test-token-0123456789abcdef', tlsCert: '', tlsKey: '',
    ollama: { url: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', visionModel: 'qwen2.5vl:3b', embedModel: 'nomic-embed-text', keepAlive: '24h' },
    voice: { asrEngine: 'faster-whisper', whisperBin: '', whisperModel: '', fasterWhisperScript: '', fasterWhisperModel: 'tiny', ocrScript: '', pythonBin: 'python3', piperBin: '', piperVoice: '', ffmpeg: 'ffmpeg', arecord: 'arecord' },
    quiet: { start: '22:00', end: '08:00' }, dailySpeakBudget: 5, screenTimeoutMs: 15000, screenBlocklist: [],
  }
}

test('cancel prevents speech generated for a stopped turn from being emitted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-cancel-'))
  const cfg = config(dir)
  const bus = new EventBus()
  const memory = new MemoryStore({ file: ':memory:', embedder: new NullEmbedder() })
  const reminders = new ReminderStore(join(dir, 'jarvis.db'))
  const tuning = new TuningStore(join(dir, 'tuning.json'), cfg)
  await tuning.load()
  const model = {
    model: 'fake',
    health: async () => ({ ok: true, models: [{ name: 'fake' }] }),
    warmup: async () => ({ chatMs: 0, embedMs: 0 }),
    async *chatStream(_messages: unknown, options: { signal?: AbortSignal }) {
      yield '第一句。'
      await new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted) return reject(new Error('aborted'))
        const timer = setTimeout(resolve, 80)
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        }, { once: true })
      })
      yield '第二句。'
    },
  } as unknown as ModelClient
  const transcriber = { available: async () => true, state: () => ({ state: 'ready' as const }), transcribe: async () => ({ text: '', language: 'zh', durationMs: 0 }) }
  const synthesizer = {
    available: async () => true,
    warmup: async () => {},
    reconfigure: async () => {},
    synthesize: async (_text: string, path: string) => { await sleep(30); await (await import('node:fs/promises')).writeFile(path, 'wav') },
  }
  let audioEvents = 0
  bus.on('assistant.audio', () => { audioEvents += 1 })
  let cancelledEvents = 0
  bus.on('assistant.cancelled', () => { cancelledEvents += 1 })
  const conversation = new Conversation({
    config: cfg, bus, attention: new AttentionManager(bus), memory, model,
    transcriber: transcriber as never, synthesizer: synthesizer as never,
    screen: {} as never, camera: {} as never, ocr: {} as never, actions: {} as never,
    reminders, policy: new ProactivePolicy(cfg), tuning, secure: new SecureFiles(dir), logger,
  })
  await conversation.initialize()
  try {
    const pending = conversation.handleText('我们聊聊明天的安排', { voice: true, skipAttention: true })
    await sleep(12)
    conversation.cancel()
    conversation.cancel()
    const result = await pending
    assert.equal(result.cancelled, true)
    assert.equal(cancelledEvents, 1, 'a repeated cancel must not emit a second cancelled event')
    assert.equal(bus.history(50).filter(event => event.type === 'assistant.done').length, 0)
    await sleep(50)
    assert.equal(audioEvents, 0, 'audio from a cancelled turn must not reach the client')
  } finally {
    reminders.close()
    memory.close()
    await rm(dir, { recursive: true, force: true })
  }
})
