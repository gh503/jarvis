import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ModelSettingsStore, validateProfile } from '../src/model/settings.ts'

const defaults = {
  local: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', visionModel: 'qwen2.5vl:3b', embedModel: 'nomic-embed-text', keepAlive: '24h' },
}

test('model settings keep local defaults, hide keys, and preserve saved secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-model-'))
  const file = join(dir, 'model-config.json')
  const store = new ModelSettingsStore(file, defaults)
  try {
    const initial = await store.load()
    assert.equal(initial.active, 'local')
    assert.equal(initial.profiles.find(item => item.id === 'remote')?.kind, 'openai')

    const saved = await store.upsert({
      id: 'remote', label: '远端', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'remote-model', apiKey: 'sk-secret', embedModel: '', visionModel: '', keepAlive: '',
    }, true)
    assert.equal(saved.active, 'remote')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const publicView = store.publicView(saved)
    assert.equal(publicView.active, 'remote')
    assert.equal(publicView.profiles.find(item => item.id === 'remote')?.hasKey, true)
    assert.equal('apiKey' in (publicView.profiles[0] as object), false)
    assert.match(await readFile(file, 'utf8'), /sk-secret/)

    // An empty key from the browser means keep the existing secret.
    const updated = await store.upsert({
      id: 'remote', label: '远端', kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'changed-model', apiKey: '', embedModel: '', visionModel: '', keepAlive: '',
    }, false)
    assert.equal(updated.profiles.find(item => item.id === 'remote')?.apiKey, 'sk-secret')
    assert.equal(updated.active, 'remote')

    const activated = await store.activate('local')
    assert.equal(activated.profile.id, 'local')
    await assert.rejects(() => store.activate('missing'), /没有这个模型配置/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('remote profile URLs require TLS except on loopback', () => {
  const base = {
    id: 'remote', label: '远端', kind: 'openai' as const, protocol: 'chat-completions' as const, model: 'm', apiKey: 'k',
    visionModel: '', embedModel: '', keepAlive: '',
  }
  assert.doesNotThrow(() => validateProfile({ ...base, baseUrl: 'https://api.example.com/v1' }))
  assert.doesNotThrow(() => validateProfile({ ...base, baseUrl: 'http://127.0.0.1:1234/v1' }))
  assert.throws(() => validateProfile({ ...base, baseUrl: 'http://api.example.com/v1' }), /HTTPS/)
  assert.throws(() => validateProfile({ ...base, baseUrl: 'https://169.254.169.254/latest' }), /元数据/)
  assert.throws(() => validateProfile({ ...base, baseUrl: 'https://user:pass@example.com/v1' }), /用户名/)
})

test('LLM protocol persists and defaults to Chat Completions for old files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-model-protocol-'))
  const store = new ModelSettingsStore(join(dir, 'model-config.json'), {
    local: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', visionModel: '', embedModel: '', keepAlive: '24h' },
  })
  const settings = await store.upsert({
    id: 'remote', label: 'Claude', kind: 'openai', protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', apiKey: 'sk-ant',
    visionModel: '', embedModel: '', keepAlive: '',
  })
  assert.equal(settings.profiles.find(item => item.id === 'remote')?.protocol, 'anthropic')
  const loaded = await store.load()
  assert.equal(loaded.profiles.find(item => item.id === 'remote')?.protocol, 'anthropic')
  assert.equal(store.publicView(loaded).profiles.find(item => item.id === 'remote')?.protocol, 'anthropic')
})


test('legacy model config without protocol still loads as Chat Completions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-model-legacy-'))
  const file = join(dir, 'model-config.json')
  await writeFile(file, JSON.stringify({
    active: 'remote',
    profiles: [{
      id: 'remote', label: '旧远端', kind: 'openai',
      baseUrl: 'https://api.example.com/v1', model: 'legacy-chat', apiKey: 'sk-old',
      visionModel: '', embedModel: '', keepAlive: '',
    }],
  }))
  const store = new ModelSettingsStore(file, {
    local: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', visionModel: '', embedModel: '', keepAlive: '24h' },
  })
  const loaded = await store.load()
  assert.equal(loaded.profiles.find(item => item.id === 'remote')?.protocol, 'chat-completions')
  assert.equal(loaded.active, 'remote')
})
