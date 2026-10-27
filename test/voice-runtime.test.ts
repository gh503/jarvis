import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceHealthStore } from '../src/voice/health.ts'
import { VoiceRuntime } from '../src/voice/runtime.ts'
import { VoiceSettingsStore, mergeVoiceUpdate } from '../src/voice/settings.ts'
import type { Transcriber } from '../src/voice/asr.ts'
import type { Synthesizer } from '../src/voice/tts.ts'

const DEFAULTS = { asrModel: 'tiny', asrEngine: 'faster-whisper', asrLanguage: 'zh', ttsVoice: '/models/zh.onnx' }

function tinyWav(): Buffer {
  const samples = Buffer.alloc(1600)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples.length, 40)
  return Buffer.concat([header, samples])
}

interface FakeSpeech {
  localAsr: Transcriber & { start(): Promise<void> }
  localTts: Synthesizer
  state: { asrCalls: number, ttsCalls: number, closed: boolean }
}

function fakeSpeech(): FakeSpeech {
  const state = { asrCalls: 0, ttsCalls: 0, closed: false }
  const localAsr: Transcriber & { start(): Promise<void> } = {
    available: async () => true,
    transcribe: async () => { state.asrCalls += 1; return { text: '本地识别', language: 'zh', durationMs: 1 } },
    state: () => ({ state: 'ready' }),
    start: async () => undefined,
    close: async () => { state.closed = true },
  }
  const localTts: Synthesizer = {
    available: async () => true,
    synthesize: async () => { state.ttsCalls += 1 },
    warmup: async () => undefined,
    reconfigure: async () => undefined,
  }
  return { localAsr, localTts, state }
}

async function listeningServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server, base: string, hits: string[] }> {
  const hits: string[] = []
  const server = createServer((request, response) => {
    hits.push(request.url || '')
    handler(request, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { server, base: `http://127.0.0.1:${address.port}/v1`, hits }
}

test('a failed ASR provider falls through to the next one and is parked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-voice-failover-'))
  const speech = fakeSpeech()
  const { server, base, hits } = await listeningServer((_request, response) => {
    response.writeHead(402, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'insufficient balance' } }))
  })
  const health = new VoiceHealthStore(join(dir, 'health.json'))
  const store = new VoiceSettingsStore(join(dir, 'voice.json'), DEFAULTS)
  const events: Array<{ event: string, payload: Record<string, unknown> }> = []
  const runtime = new VoiceRuntime({
    store,
    localTranscriber: speech.localAsr,
    localSynthesizer: speech.localTts,
    ffmpeg: 'false',
    health,
    emit: (event, payload) => events.push({ event, payload }),
  })
  try {
    await runtime.initialize()
    const configured = mergeVoiceUpdate(await store.load(), {
      asr: [
        { id: 'cloud', label: '云端识别', kind: 'remote', transport: 'http', baseUrl: base, model: 'whisper-1', apiKey: 'k', language: 'zh' },
        { id: 'local', label: '本地', kind: 'local', transport: 'http', baseUrl: '', model: 'tiny', language: 'zh' },
      ],
    })
    await runtime.apply(configured)
    const first = await runtime.transcribe(tinyWav(), 'wav')
    assert.equal(first.text, '本地识别')
    assert.equal(hits.length, 1)
    assert.equal(health.snapshot().asr.cloud?.kind, 'quota')
    const failover = events.find(event => event.event === 'voice.failover')
    assert.equal(failover?.payload.from, 'cloud')
    assert.equal(failover?.payload.to, 'local')
    assert.equal(failover?.payload.failure, 'quota')
    assert.equal(typeof failover?.payload.cooldownUntil, 'number')

    // Second request skips the parked provider entirely.
    const second = await runtime.transcribe(tinyWav(), 'wav')
    assert.equal(second.text, '本地识别')
    assert.equal(hits.length, 1, 'cooldown prevents a second doomed request')
    assert.equal(runtime.status().serving.asr, 'local')
    assert.equal((runtime.status().asr.chain.find(entry => entry.id === 'cloud')?.coolingUntil ?? 0) > Date.now(), true)
  } finally {
    await runtime.close()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a rejected TTS key switches to the next voice and the chain can be reordered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-voice-tts-'))
  const speech = fakeSpeech()
  const { server, base, hits } = await listeningServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'invalid api key' } }))
  })
  const health = new VoiceHealthStore(join(dir, 'health.json'))
  const store = new VoiceSettingsStore(join(dir, 'voice.json'), DEFAULTS)
  const runtime = new VoiceRuntime({
    store,
    localTranscriber: speech.localAsr,
    localSynthesizer: speech.localTts,
    ffmpeg: 'false',
    health,
  })
  try {
    await runtime.initialize()
    await runtime.apply(mergeVoiceUpdate(await store.load(), {
      tts: [
        { id: 'cloud', label: '云端合成', kind: 'remote', baseUrl: base, model: 'tts-1', voice: 'alloy', apiKey: 'bad' },
        { id: 'local', label: '本地', kind: 'local', baseUrl: '', model: 'piper', voice: '/models/zh.onnx' },
      ],
    }))
    await runtime.synthesize('你好', join(dir, 'out.wav'))
    assert.equal(speech.state.ttsCalls, 1)
    assert.equal(hits.length, 1)
    assert.equal(health.snapshot().tts.cloud?.kind, 'auth')
    assert.equal(runtime.status().serving.tts, 'local')

    // Move the local engine to the top: it is used immediately, no probing.
    await runtime.apply(mergeVoiceUpdate(await store.load(), {
      tts: [
        { id: 'local', label: '本地', kind: 'local', baseUrl: '', model: 'piper', voice: '/models/zh.onnx' },
        { id: 'cloud', label: '云端合成', kind: 'remote', baseUrl: base, model: 'tts-1', voice: 'alloy', apiKey: '' },
      ],
    }))
    await runtime.synthesize('再来一句', join(dir, 'out2.wav'))
    assert.equal(speech.state.ttsCalls, 2)
    assert.equal(hits.length, 1)
    assert.equal(runtime.status().tts.kind, 'local')
  } finally {
    await runtime.close()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a client-side 4xx is surfaced instead of silently switching engines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-voice-client-'))
  const speech = fakeSpeech()
  const { server, base, hits } = await listeningServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'unsupported model' } }))
  })
  const store = new VoiceSettingsStore(join(dir, 'voice.json'), DEFAULTS)
  const runtime = new VoiceRuntime({
    store,
    localTranscriber: speech.localAsr,
    localSynthesizer: speech.localTts,
    ffmpeg: 'false',
    health: new VoiceHealthStore(join(dir, 'health.json')),
  })
  try {
    await runtime.initialize()
    await runtime.apply(mergeVoiceUpdate(await store.load(), {
      asr: [
        { id: 'cloud', label: '云端识别', kind: 'remote', transport: 'http', baseUrl: base, model: 'bad-model', apiKey: 'k' },
        { id: 'local', label: '本地', kind: 'local', transport: 'http', baseUrl: '', model: 'tiny' },
      ],
    }))
    await assert.rejects(runtime.transcribe(tinyWav(), 'wav'), /HTTP 400/)
    assert.equal(speech.state.asrCalls, 0, 'a configuration error must not be masked by a fallback')
    assert.equal(hits.length, 1)
  } finally {
    await runtime.close()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
