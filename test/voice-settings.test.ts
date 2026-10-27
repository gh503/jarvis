import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeVoiceUpdate, VoiceSettingsStore, validateVoiceSettings } from '../src/voice/settings.ts'

const DEFAULTS = { asrModel: 'tiny', asrEngine: 'faster-whisper', asrLanguage: 'zh', ttsVoice: '/models/zh.onnx' }

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-voice-settings-'))
  return { dir, store: new VoiceSettingsStore(join(dir, 'voice.json'), DEFAULTS) }
}

test('voice settings start local-only and hide keys in the public view', async () => {
  const { dir, store } = await freshStore()
  try {
    const settings = await store.load()
    assert.deepEqual(settings.asr.map(entry => entry.id), ['local'])
    assert.deepEqual(settings.tts.map(entry => entry.id), ['local'])
    const view = store.publicView(settings)
    assert.equal('apiKey' in view.asr[0], false)
    assert.equal(view.asr[0].hasKey, false)
    assert.equal(view.tts[0].kind, 'local')
    await store.save(settings)
    assert.equal((await stat(join(dir, 'voice.json'))).mode & 0o777, 0o600)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an ordered chain of many providers round-trips and keeps keys on disk', async () => {
  const { dir, store } = await freshStore()
  try {
    const base = await store.load()
    const next = mergeVoiceUpdate(base, {
      asr: [
        { id: 'groq', label: 'Groq', kind: 'remote', transport: 'http', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3', apiKey: 'groq-key', language: 'zh' },
        { id: 'siliconflow', label: '硅基流动', kind: 'remote', transport: 'http', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall', apiKey: 'sf-key', language: 'zh' },
        { id: 'local', label: '本地 faster-whisper', kind: 'local', transport: 'http', baseUrl: '', model: 'tiny', language: 'zh' },
      ],
      tts: [
        { id: 'edge', label: 'Edge TTS', kind: 'remote', adapter: 'edge', baseUrl: '', model: 'edge-tts', voice: 'zh-CN-XiaoxiaoNeural', apiKey: '' },
        { id: 'openai', label: 'OpenAI', kind: 'remote', baseUrl: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy', apiKey: 'openai-key' },
        { id: 'local', label: '本地 Piper', kind: 'local', baseUrl: '', model: 'piper', voice: '/models/zh.onnx' },
      ],
    })
    assert.deepEqual(next.asr.map(entry => entry.id), ['groq', 'siliconflow', 'local'])
    assert.deepEqual(next.tts.map(entry => entry.id), ['edge', 'openai', 'local'])
    await store.save(next)
    const loaded = await store.load()
    assert.equal(loaded.asr[0].apiKey, 'groq-key')
    assert.equal(loaded.tts[0].adapter, 'edge')
    assert.equal(loaded.tts[0].model, 'edge-tts')
    assert.equal(loaded.tts[0].baseUrl, '')
    const serialized = await readFile(join(dir, 'voice.json'), 'utf8')
    assert.equal(serialized.includes('groq-key'), true)
    assert.equal('apiKey' in store.publicView(loaded).asr[0], false)
    assert.equal(store.publicView(loaded).asr[0].hasKey, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the legacy local/remote file migrates into a chain without losing the active side', async () => {
  const { dir, store } = await freshStore()
  try {
    const legacy = {
      activeAsr: 'remote',
      activeTts: 'local',
      asr: {
        local: { id: 'local', label: '本地', kind: 'local', transport: 'http', baseUrl: '', model: 'tiny', apiKey: '', language: 'zh' },
        remote: { id: 'remote', label: '远端 ASR', kind: 'remote', transport: 'websocket', baseUrl: 'wss://asr.example.com/v1/stream', model: 'whisper-1', apiKey: 'old-key', language: 'zh' },
      },
      tts: {
        local: { id: 'local', label: '本地', kind: 'local', baseUrl: '', model: 'piper', voice: '/models/zh.onnx', apiKey: '' },
        remote: { id: 'remote', label: '远端 TTS', kind: 'remote', baseUrl: '', model: 'tts-1', voice: 'alloy', apiKey: '' },
      },
    }
    await writeFile(join(dir, 'voice.json'), JSON.stringify(legacy))
    const loaded = await store.load()
    assert.deepEqual(loaded.asr.map(entry => entry.id), ['remote', 'local'])
    assert.equal(loaded.asr[0].apiKey, 'old-key')
    // An unconfigured remote TTS placeholder is not kept in the chain.
    assert.deepEqual(loaded.tts.map(entry => entry.id), ['local'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reordering and deleting providers is just a different array order', async () => {
  const { dir, store } = await freshStore()
  try {
    const configured = mergeVoiceUpdate(await store.load(), {
      asr: [
        { id: 'local', label: '本地', kind: 'local', transport: 'http', baseUrl: '', model: 'tiny', language: 'zh' },
        { id: 'remote', label: '远端', kind: 'remote', transport: 'http', baseUrl: 'https://asr.example.com/v1', model: 'whisper-1', apiKey: 'asr-secret', language: 'zh' },
      ],
    })
    const swapped = mergeVoiceUpdate(configured, {
      asr: [
        { ...configured.asr[1], apiKey: '' },
        { ...configured.asr[0], apiKey: '' },
      ],
    })
    assert.deepEqual(swapped.asr.map(entry => entry.id), ['remote', 'local'])
    assert.equal(swapped.asr[0].apiKey, 'asr-secret', 'a blank key field keeps the stored key')
    const trimmed = mergeVoiceUpdate(swapped, { asr: [swapped.asr[0]] })
    assert.deepEqual(trimmed.asr.map(entry => entry.id), ['remote'])
    assert.throws(() => mergeVoiceUpdate(trimmed, { asr: [] }), /至少需要一个服务/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a blank key is only reused for the same endpoint, and plain HTTP stays local', async () => {
  const { dir, store } = await freshStore()
  try {
    const configured = mergeVoiceUpdate(await store.load(), {
      asr: [{ id: 'remote', label: '远端', kind: 'remote', transport: 'http', baseUrl: 'https://asr.example.com/v1', model: 'whisper-1', apiKey: 'asr-secret', language: 'zh' }],
      tts: [{ id: 'remote', label: '远端', kind: 'remote', baseUrl: 'https://tts.example.com/v1', model: 'tts-1', voice: 'alloy', apiKey: 'tts-secret' }],
    })
    const sameHost = mergeVoiceUpdate(configured, {
      asr: [{ id: 'remote', baseUrl: 'https://asr.example.com/v1', model: 'whisper-large-v3', apiKey: '' }],
    })
    assert.equal(sameHost.asr[0].apiKey, 'asr-secret')
    assert.equal(sameHost.asr[0].model, 'whisper-large-v3')
    assert.throws(() => mergeVoiceUpdate(configured, {
      asr: [{ id: 'remote', baseUrl: 'https://evil.example.com/v1', apiKey: '' }],
    }), /重新输入 API Key/)
    assert.throws(() => mergeVoiceUpdate(configured, {
      tts: [{ id: 'remote', baseUrl: 'http://tts.example.com/v1', model: 'tts-1', voice: 'alloy', apiKey: '' }],
    }), /TLS/)
    // Loopback plain HTTP is allowed; that is how a self-hosted server works.
    const loopback = mergeVoiceUpdate(configured, {
      asr: [{ id: 'remote', baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper-1', apiKey: 'self-hosted' }],
    })
    assert.equal(loopback.asr[0].baseUrl, 'http://127.0.0.1:8000/v1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('chain validation rejects duplicate ids, empty chains and Edge as ASR', async () => {
  const local = { id: 'local', label: '本地', kind: 'local' as const, transport: 'http' as const, baseUrl: '', model: 'tiny', apiKey: '', language: 'zh' }
  const remote = { id: 'a', label: 'A', kind: 'remote' as const, baseUrl: 'https://a.example.com/v1', model: 'tts-1', voice: 'alloy', apiKey: '' }
  assert.throws(() => validateVoiceSettings({ asr: [], tts: [remote] }), /至少需要一个服务/)
  assert.throws(() => validateVoiceSettings({ asr: [local, { ...local, label: '重复' }], tts: [remote] }), /id 重复/)
  assert.throws(() => validateVoiceSettings({ asr: [{ ...local, kind: 'remote', adapter: 'edge', baseUrl: '' }], tts: [remote] }), /Edge TTS/)
  assert.doesNotThrow(() => validateVoiceSettings({ asr: [local], tts: [remote] }))
})
