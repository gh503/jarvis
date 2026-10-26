import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinScenarios, detectScenario, normalizeScenario } from '../src/model/scenarios.ts'
import { ModelSettingsStore } from '../src/model/settings.ts'

const defaults = {
  local: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', visionModel: '', embedModel: '', keepAlive: '24h' },
}

test('scenario auto-detection is deterministic and conservative', () => {
  const scenarios = builtinScenarios()
  assert.equal(detectScenario('帮我写一个 Python 函数计算斐波那契', scenarios), 'coding')
  assert.equal(detectScenario('```ts\nconst x = 1\n``` 这段为什么报错', scenarios), 'coding')
  assert.equal(detectScenario('TypeError: cannot read properties of undefined', scenarios), 'coding')
  assert.equal(detectScenario('帮我把这段中文翻译成英文', scenarios), 'translate')
  assert.equal(detectScenario('润色一下这封邮件', scenarios), 'email')
  assert.equal(detectScenario('把刚才的语音整理成会议纪要', scenarios), 'meeting')
  assert.equal(detectScenario('帮我写本周的周报', scenarios), 'report')
  assert.equal(detectScenario('分析一下这两个方案的利弊', scenarios), 'research')
  assert.equal(detectScenario('头脑风暴一下产品名字', scenarios), 'brainstorm')
  assert.equal(detectScenario('什么是向量数据库，给我讲讲原理', scenarios), 'study')
  assert.equal(detectScenario('今天天气怎么样', scenarios), 'chat')
  // Disabled scenarios are never auto-selected.
  const disabled = scenarios.map(item => item.id === 'coding' ? { ...item, enabled: false } : item)
  assert.equal(detectScenario('帮我 debug 一下', disabled), 'chat')
  // Custom scenarios participate via their own patterns.
  const withCustom = [...scenarios, { ...scenarios[0], id: 'counsel', label: '树洞', custom: true, patterns: ['心情不好', '倾诉'] }]
  assert.equal(detectScenario('我今天心情不好，想聊聊', withCustom), 'counsel')
})

test('scenario normalization clamps temperature and caps fields', () => {
  const fallback = builtinScenarios()[1]
  const normalized = normalizeScenario({ temperature: 99, profileIds: ['a', 'b'], label: 'x'.repeat(100) }, fallback)
  assert.equal(normalized.temperature, 2)
  assert.deepEqual(normalized.profileIds, ['a', 'b'])
  assert.equal(normalized.label.length, 32)
  const nullTemp = normalizeScenario({ temperature: null }, fallback)
  assert.equal(nullTemp.temperature, fallback.temperature)
})

test('legacy model-config migrates to priority, scenarios and cooldowns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-migrate-'))
  const file = join(dir, 'model-config.json')
  await writeFile(file, JSON.stringify({
    active: 'remote',
    profiles: [
      { id: 'local', label: '本地 Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', apiKey: '', visionModel: '', embedModel: '', keepAlive: '24h' },
      { id: 'remote', label: '远端模型', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-x', visionModel: '', embedModel: '', keepAlive: '' },
    ],
  }))
  const store = new ModelSettingsStore(file, defaults)
  try {
    const settings = await store.load()
    assert.equal(settings.active, 'remote')
    assert.deepEqual(settings.priority, ['remote', 'local'])
    assert.equal(settings.scenarios.length, 10)
    assert.equal(settings.scenarioAuto, true)
    assert.equal(settings.defaultScenario, 'chat')
    assert.deepEqual(settings.cooldowns, {})
    const view = store.publicView(settings)
    assert.equal(view.profiles.find(item => item.id === 'remote')?.hasKey, true)
    assert.equal('apiKey' in (view.profiles[1] as object), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('provider add/remove/priority/scenario updates validate references', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-pool-'))
  const store = new ModelSettingsStore(join(dir, 'model-config.json'), defaults)
  try {
    const added = await store.addProfile({ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', apiKey: 'gsk_x' })
    assert.ok(added.profiles.some(item => item.id === 'groq'))
    assert.deepEqual(added.priority, ['remote', 'groq', 'local'])
    await assert.rejects(() => store.addProfile({ id: 'groq' }), /已存在/)
    await assert.rejects(() => store.addProfile({ id: 'Bad ID' }), /id 需为/)

    const priority = await store.setPriority(['groq', 'local'])
    assert.deepEqual(priority.priority, ['groq', 'local', 'remote'])
    await assert.rejects(() => store.setPriority(['ghost']), /不存在/)

    const scenarios = await store.setScenarios({
      scenarios: [{ id: 'coding', profileIds: ['groq', 'local'], model: 'openai/gpt-oss-120b', temperature: 0.1 }],
      defaultScenario: 'coding',
      scenarioAuto: false,
    })
    const coding = scenarios.scenarios.find(item => item.id === 'coding')
    assert.deepEqual(coding?.profileIds, ['groq', 'local'])
    assert.equal(coding?.temperature, 0.1)
    assert.equal(scenarios.defaultScenario, 'coding')
    assert.equal(scenarios.scenarioAuto, false)
    await assert.rejects(() => store.setScenarios({ scenarios: [{ id: 'coding', profileIds: ['ghost'] }] }), /不存在的配置/)

    await assert.rejects(() => store.removeProfile('local'), /本地配置不能删除/)
    await store.upsert({ id: 'remote', label: 'r', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'm', apiKey: 'k', visionModel: '', embedModel: '', keepAlive: '' }, true)
    await assert.rejects(() => store.removeProfile('remote'), /先切换到其他供应商/)
    const removed = await store.removeProfile('groq')
    assert.ok(!removed.profiles.some(item => item.id === 'groq'))
    assert.ok(!removed.priority.includes('groq'))
    assert.ok(!removed.scenarios.some(item => item.profileIds.includes('groq')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('custom scenarios can be added, persisted and removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-custom-scenario-'))
  const store = new ModelSettingsStore(join(dir, 'model-config.json'), defaults)
  try {
    const saved = await store.setScenarios({
      scenarios: [{
        id: 'counsel', label: '树洞倾听', custom: true, enabled: true,
        profileIds: [], model: '', temperature: 0.8, systemExtra: '温柔倾听，少给建议。', patterns: ['心情不好'],
      }],
    })
    const counsel = saved.scenarios.find(item => item.id === 'counsel')
    assert.equal(counsel?.custom, true)
    assert.equal(counsel?.temperature, 0.8)

    // Survives a reload.
    const reloaded = await new ModelSettingsStore(join(dir, 'model-config.json'), defaults).load()
    assert.equal(reloaded.scenarios.find(item => item.id === 'counsel')?.label, '树洞倾听')

    // Invalid ids are rejected; builtin ids in the payload are edits (rename ok).
    await assert.rejects(() => store.setScenarios({ scenarios: [{ id: 'Bad ID', label: 'x' }] }), /id 需为/)
    const renamed = await store.setScenarios({ scenarios: [{ id: 'coding', label: '写码' }] })
    assert.equal(renamed.scenarios.find(item => item.id === 'coding')?.label, '写码')

    // Omitting a custom scenario deletes it; built-ins stay.
    const after = await store.setScenarios({ scenarios: [] })
    assert.ok(!after.scenarios.some(item => item.id === 'counsel'))
    assert.ok(after.scenarios.some(item => item.id === 'coding'))

    // Default scenario can point at a custom one.
    const pinned = await store.setScenarios({
      scenarios: [{ id: 'counsel', label: '树洞倾听', custom: true }],
      defaultScenario: 'counsel',
    })
    assert.equal(pinned.defaultScenario, 'counsel')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('legacy reasoning scenario folds into research instead of duplicating', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-legacy-scenario-'))
  const file = join(dir, 'model-config.json')
  await writeFile(file, JSON.stringify({
    active: 'local',
    profiles: [{ id: 'local', label: '本地', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'm', apiKey: '', visionModel: '', embedModel: '', keepAlive: '' }],
    scenarios: [{ id: 'reasoning', label: '深度分析', temperature: 0.15, patterns: ['论证'] }],
  }))
  const store = new ModelSettingsStore(file, defaults)
  try {
    const settings = await store.load()
    assert.ok(!settings.scenarios.some(item => item.id === 'reasoning'), 'old id must not linger')
    const research = settings.scenarios.find(item => item.id === 'research')
    assert.equal(research?.label, '深度分析')
    assert.equal(research?.temperature, 0.15)
    assert.ok(research?.patterns.includes('论证'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
