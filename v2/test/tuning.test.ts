import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { JarvisConfig } from '../src/config.ts'
import { TuningStore } from '../src/tuning.ts'

function config(dir: string): JarvisConfig {
  return {
    version: '2.0.0',
    host: '127.0.0.1',
    port: 3081,
    dataDir: dir,
    webDir: join(dir, 'web'),
    authToken: '',
    tlsCert: '',
    tlsKey: '',
    ollama: { url: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', visionModel: 'qwen2.5vl:3b', embedModel: 'nomic-embed-text', keepAlive: '24h' },
    voice: { asrEngine: 'faster-whisper', whisperBin: '', whisperModel: '', fasterWhisperScript: '', fasterWhisperModel: 'tiny', ocrScript: '', pythonBin: 'python3', piperBin: '', piperVoice: '', ffmpeg: 'ffmpeg', arecord: 'arecord' },
    quiet: { start: '22:00', end: '08:00' },
    dailySpeakBudget: 5,
    screenTimeoutMs: 15000,
    screenBlocklist: ['bank'],
  }
}

test('tuning store clamps values, persists atomically and mutates runtime config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-tuning-'))
  try {
    const cfg = config(dir)
    const store = new TuningStore(join(dir, 'tuning.json'), cfg)
    await store.load()
    assert.equal(store.number('ui.particles'), 18)
    const result = await store.update({
      'ui.particles': 999,
      'conversation.temperature': -1,
      'proactive.dailySpeakBudget': 2,
      'proactive.quietStart': '23:30',
      'screens.blocklist': 'bank, 1password',
    })
    assert.deepEqual(result.changed.sort(), ['conversation.temperature', 'proactive.dailySpeakBudget', 'proactive.quietStart', 'screens.blocklist', 'ui.particles'].sort())
    assert.equal(store.number('ui.particles'), 60)
    assert.equal(store.number('conversation.temperature'), 0)
    assert.equal(cfg.dailySpeakBudget, 2)
    assert.equal(cfg.quiet.start, '23:30')
    assert.deepEqual(cfg.screenBlocklist, ['bank', '1password'])
    const mode = (await stat(join(dir, 'tuning.json'))).mode & 0o777
    assert.equal(mode, 0o600)
    const saved = JSON.parse(await readFile(join(dir, 'tuning.json'), 'utf8')) as { values: Record<string, unknown> }
    assert.equal(saved.values['ui.particles'], 60)

    const loaded = new TuningStore(join(dir, 'tuning.json'), config(dir))
    await loaded.load()
    assert.equal(loaded.number('proactive.dailySpeakBudget'), 2)
    assert.equal(loaded.text('proactive.quietStart'), '23:30')

    await store.reset()
    assert.equal(store.number('ui.particles'), 18)
    assert.equal(store.text('proactive.quietStart'), '22:00')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tuning rejects unknown keys and malformed quiet times', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-tuning-'))
  try {
    const store = new TuningStore(join(dir, 'tuning.json'), config(dir))
    await store.load()
    await assert.rejects(() => store.update({ 'nope.value': 1 }), /未知参数/)
    await assert.rejects(() => store.update({ 'proactive.quietStart': '25:00' }), /HH:MM/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tuning presets apply only their declared values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-tuning-'))
  try {
    const store = new TuningStore(join(dir, 'tuning.json'), config(dir))
    await store.load()
    await store.update({ 'conversation.temperature': 1.2 })
    const result = await store.preset('focus')
    assert.equal(store.number('ui.particles'), 4)
    assert.equal(store.text('ui.density'), 'compact')
    assert.ok(result.changed.includes('ui.density'))
    assert.equal(store.number('conversation.temperature'), 1.2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
