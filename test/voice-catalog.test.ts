import assert from 'node:assert/strict'
import test from 'node:test'
import { voiceByKind, voiceCatalog, voiceGuide, validateVoiceCatalog } from '../src/voice/catalog.ts'

test('voice catalogue has no structural problems', () => {
  assert.deepEqual(validateVoiceCatalog(), [])
})

test('covers both speech directions on three regions', () => {
  const entries = voiceCatalog()
  const asr = voiceByKind('asr')
  const tts = voiceByKind('tts')
  assert.ok(entries.length >= 15, `only ${entries.length} entries`)
  assert.ok(asr.length >= 6, `only ${asr.length} ASR entries`)
  assert.ok(tts.length >= 6, `only ${tts.length} TTS entries`)
  for (const region of ['cn', 'global', 'local'] as const) {
    assert.ok(entries.some(entry => entry.region === region), `missing ${region} region`)
  }
  // A guide that only lists foreign services is useless on a mainland network.
  assert.ok(entries.filter(entry => entry.region === 'cn').length >= 3)
})

test('ids are unique and url safe', () => {
  const ids = voiceCatalog().map(entry => entry.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.match(id, /^[a-z0-9-]+$/)
})

test('local presets never leak a remote endpoint', () => {
  for (const entry of voiceCatalog()) {
    if (entry.region !== 'local') continue
    if (!entry.baseUrl) continue
    assert.match(entry.baseUrl, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//, `${entry.id} points at ${entry.baseUrl}`)
  }
})

test('remote presets are https and declare where to get a key', () => {
  for (const entry of voiceCatalog()) {
    if (entry.region === 'local' || entry.baseUrl === '') continue
    assert.match(entry.baseUrl, /^https:\/\//, `${entry.id} is not https`)
    if (entry.adapter !== 'edge') assert.match(entry.keyUrl, /^https:\/\//, `${entry.id} has no key url`)
  }
})

test('every preset explains how to wire it up, including its pitfalls', () => {
  for (const entry of voiceCatalog()) {
    assert.ok(entry.setup.length >= 2, `${entry.id} has ${entry.setup.length} steps`)
    assert.ok(entry.summary.length >= 8, `${entry.id} summary is too thin`)
  }
})

test('the catalogue is not the caller\'s to mutate', () => {
  const first = voiceCatalog()
  first[0].setup.push('mutated')
  first[0].name = 'mutated'
  first[0].models?.push('mutated')
  first[0].voices?.push('mutated')
  const second = voiceCatalog()
  assert.notEqual(second[0].name, 'mutated')
  assert.ok(!second[0].setup.includes('mutated'))
  assert.ok(!(second[0].models ?? []).includes('mutated'))
  assert.ok(!(second[0].voices ?? []).includes('mutated'))
})

test('every preset carries pickable model ids, and TTS carries voices too', () => {
  for (const entry of voiceCatalog()) {
    assert.ok(Array.isArray(entry.models) && entry.models.length > 0, `${entry.id} 没有可选模型`)
    assert.ok((entry.models ?? []).includes(entry.model), `${entry.id} 的备选里没有默认模型 ${entry.model}`)
    if (entry.kind === 'tts') {
      assert.ok(Array.isArray(entry.voices) && entry.voices.length > 0, `${entry.id} 没有可选音色`)
      assert.ok((entry.voices ?? []).includes(entry.voice ?? ''), `${entry.id} 的备选里没有默认音色 ${entry.voice}`)
    } else {
      assert.ok(Array.isArray(entry.voices), `${entry.id} 的 voices 字段缺失`)
    }
  }
})

test('voice alternatives stay in the format their adapter expects', () => {
  const cosy = voiceCatalog().find(entry => entry.id === 'siliconflow-cosyvoice')
  assert.ok(cosy)
  for (const voice of cosy.voices ?? []) assert.match(voice, /^FunAudioLLM\/CosyVoice2-0\.5B:/)
  const edge = voiceCatalog().find(entry => entry.id === 'edge-tts')
  assert.ok(edge)
  assert.ok((edge.voices ?? []).includes('zh-CN-XiaoxiaoNeural'))
  const gemini = voiceCatalog().find(entry => entry.id === 'gemini-tts')
  assert.ok(gemini)
  assert.ok((gemini.voices ?? []).includes('Kore'))
})

test('docs mention every alternative model id so the two cannot drift', async () => {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const doc = await readFile(join(import.meta.dirname, '..', 'docs', 'voice-providers.md'), 'utf8')
  for (const entry of voiceCatalog()) {
    for (const model of entry.models ?? []) {
      assert.ok(doc.includes(model), `${entry.id} 的备选模型 ${model} 没有出现在 voice-providers.md`)
    }
  }
})

test('voiceGuide finds a preset by id and rejects unknown ones', () => {
  assert.equal(voiceGuide('local-piper')?.kind, 'tts')
  assert.equal(voiceGuide('nope'), undefined)
})

test('validation reports broken entries instead of throwing', () => {
  const broken = voiceCatalog()
  broken[0] = { ...broken[0], id: 'Bad Id', baseUrl: 'http://example.com', setup: [] }
  const problems = validateVoiceCatalog(broken)
  assert.ok(problems.length >= 2)
  assert.ok(problems.some(problem => problem.includes('id')))
})

test('docs/voice-providers.md stays in sync with the catalogue', async () => {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const doc = await readFile(join(import.meta.dirname, '..', 'docs', 'voice-providers.md'), 'utf8')
  for (const entry of voiceCatalog()) {
    const shortName = entry.name.split(/[（/\s]/)[0]
    assert.ok(shortName.length >= 2 && doc.includes(shortName), `${entry.id} 的名称没有出现在 voice-providers.md`)
    if (entry.baseUrl) assert.ok(doc.includes(entry.baseUrl), `${entry.id} 的地址没有出现在 voice-providers.md`)
  }
})
