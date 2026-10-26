import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceRuntime } from '../src/voice/runtime.ts'
import { VoiceSettingsStore, mergeVoiceUpdate } from '../src/voice/settings.ts'
import type { Transcriber } from '../src/voice/asr.ts'
import type { Synthesizer } from '../src/voice/tts.ts'

test('voice runtime swaps ASR/TTS independently without touching the conversation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-voice-runtime-'))
  const store = new VoiceSettingsStore(join(dir, 'voice.json'), {
    asrModel: 'tiny', asrEngine: 'faster-whisper', asrLanguage: 'zh', ttsVoice: '/models/zh.onnx',
  })
  let localAsrClosed = false
  let localTtsClosed = false
  const localAsr: Transcriber & { start(): Promise<void> } = {
    available: async () => true,
    transcribe: async () => ({ text: '本地', language: 'zh', durationMs: 1 }),
    state: () => ({ state: 'ready' }),
    start: async () => undefined,
    close: async () => { localAsrClosed = true },
  }
  const localTts: Synthesizer = {
    available: async () => true,
    synthesize: async () => undefined,
    warmup: async () => undefined,
    reconfigure: async () => undefined,
    close: async () => { localTtsClosed = true },
  }
  const runtime = new VoiceRuntime({ store, localTranscriber: localAsr, localSynthesizer: localTts, ffmpeg: 'false' })
  try {
    await runtime.initialize()
    assert.equal(runtime.status().asr.kind, 'local')
    const current = await store.load()
    const next = mergeVoiceUpdate(current, {
      activeAsr: 'remote',
      asr: { remote: { transport: 'websocket', baseUrl: 'wss://asr.example.com/v1/stream', model: 'whisper-1', language: 'zh', apiKey: 'asr-key' } },
      tts: { remote: { baseUrl: 'https://tts.example.com/v1', model: 'tts-1', voice: 'alloy', apiKey: 'tts-key' } },
    })
    const publicSettings = await runtime.apply(next)
    assert.equal(runtime.status().asr.kind, 'remote')
    assert.equal(runtime.status().tts.kind, 'local')
    assert.equal('apiKey' in publicSettings.asr.remote, false)
    assert.equal((await store.load()).activeAsr, 'remote')
    const local = mergeVoiceUpdate(await store.load(), { activeAsr: 'local', activeTts: 'local' })
    await runtime.apply(local)
    assert.equal(runtime.status().asr.kind, 'local')
    assert.equal(runtime.status().tts.kind, 'local')
  } finally {
    await runtime.close()
  }
  assert.equal(localAsrClosed, true)
  assert.equal(localTtsClosed, true)
})
