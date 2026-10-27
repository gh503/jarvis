import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeVoiceUpdate, VoiceSettingsStore } from '../src/voice/settings.ts'

test('voice settings default to local, WebSocket remote ASR and hide keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-voice-settings-'))
  const store = new VoiceSettingsStore(join(dir, 'voice.json'), {
    asrModel: 'tiny', asrEngine: 'faster-whisper', asrLanguage: 'zh', ttsVoice: '/models/zh.onnx',
  })
  const settings = await store.load()
  assert.equal(settings.activeAsr, 'local')
  assert.equal(settings.activeTts, 'local')
  assert.equal(settings.asr.remote.transport, 'websocket')
  assert.equal(settings.asr.remote.kind, 'remote')
  assert.equal('apiKey' in store.publicView(settings).asr.remote, false)
  assert.equal(store.publicView(settings).asr.remote.hasKey, false)
  await store.save(settings)
  assert.equal(mergeVoiceUpdate(settings, { activeAsr: 'local' }).activeAsr, 'local')
})

test('voice settings merge keeps a saved key when the field is blank and validates TLS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-voice-merge-'))
  const store = new VoiceSettingsStore(join(dir, 'voice.json'), {
    asrModel: 'tiny', asrEngine: 'faster-whisper', asrLanguage: 'zh', ttsVoice: '/models/zh.onnx',
  })
  const base = await store.load()
  const configured = mergeVoiceUpdate(base, {
    asr: { remote: { baseUrl: 'https://asr.example.com/v1', model: 'whisper-1', apiKey: 'asr-secret', transport: 'http', language: 'zh' } },
    tts: { remote: { baseUrl: 'https://tts.example.com/v1', model: 'tts-1', voice: 'alloy', apiKey: 'tts-secret' } },
  })
  await store.save(configured)
  const info = await stat(join(dir, 'voice.json'))
  assert.equal(info.mode & 0o777, 0o600)
  const loaded = await store.load()
  const merged = mergeVoiceUpdate(loaded, {
    activeAsr: 'remote',
    asr: { remote: { baseUrl: 'https://asr.example.com/v1', model: 'whisper-large-v3', apiKey: '' } },
  })
  assert.equal(merged.asr.remote.apiKey, 'asr-secret')
  assert.equal(merged.asr.remote.model, 'whisper-large-v3')
  assert.equal(merged.activeAsr, 'remote')
  assert.throws(() => mergeVoiceUpdate(merged, {
    tts: { remote: { baseUrl: 'http://tts.example.com/v1', model: 'tts-1', voice: 'alloy', apiKey: '' } },
  }), /TLS/)
  assert.equal((await readFile(join(dir, 'voice.json'), 'utf8')).includes('asr-secret'), true)
})

test('re-pointing a voice provider at a new origin requires a fresh key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-voice-keybind-'))
  const store = new VoiceSettingsStore(join(dir, 'voice.json'), {
    asrModel: 'tiny', asrEngine: 'faster-whisper', asrLanguage: 'zh', ttsVoice: '/models/zh.onnx',
  })
  try {
    const configured = mergeVoiceUpdate(await store.load(), {
      asr: { remote: { baseUrl: 'https://asr.example.com/v1', model: 'whisper-1', apiKey: 'asr-secret', transport: 'http' } },
      tts: { remote: { baseUrl: 'https://tts.example.com/v1', model: 'tts-1', voice: 'alloy', apiKey: 'tts-secret' } },
    })
    // Same origin, blank key: keeps working.
    const same = mergeVoiceUpdate(configured, { asr: { remote: { baseUrl: 'https://asr.example.com/v2', model: 'whisper-2', apiKey: '' } } })
    assert.equal(same.asr.remote.apiKey, 'asr-secret')
    // Different origin, blank key: refused instead of shipping the old secret.
    assert.throws(() => mergeVoiceUpdate(configured, {
      asr: { remote: { baseUrl: 'https://evil.example.net/v1', model: 'whisper-1', apiKey: '' } },
    }), /重新输入 API Key/)
    assert.throws(() => mergeVoiceUpdate(configured, {
      tts: { remote: { baseUrl: 'https://evil.example.net/v1', model: 'tts-1', voice: 'alloy', apiKey: '' } },
    }), /重新输入 API Key/)
    // Different origin with a new key: allowed.
    const moved = mergeVoiceUpdate(configured, {
      asr: { remote: { baseUrl: 'https://evil.example.net/v1', model: 'whisper-1', apiKey: 'brand-new' } },
    })
    assert.equal(moved.asr.remote.apiKey, 'brand-new')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
