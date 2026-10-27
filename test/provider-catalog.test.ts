import test from 'node:test'
import assert from 'node:assert/strict'
import { providerCatalog, providerGuide, validateCatalog } from '../src/model/catalog.ts'

test('provider catalogue is internally consistent', () => {
  const problems = validateCatalog()
  assert.deepEqual(problems, [])
})

test('provider catalogue covers the three regions people actually choose between', () => {
  const entries = providerCatalog()
  assert.ok(entries.length >= 15, 'at least 15 providers so the guide is useful')
  const regions = new Set(entries.map(item => item.region))
  assert.deepEqual([...regions].sort(), ['cn', 'global', 'local'])
  assert.ok(entries.filter(item => item.region === 'cn').length >= 8, 'enough mainland providers')
  assert.ok(entries.filter(item => item.region === 'global').length >= 5)
})

test('catalogue ids are unique, lowercase and usable as profile ids', () => {
  const ids = providerCatalog().map(item => item.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.match(id, /^[a-z0-9-]{1,32}$/)
})

test('mainland providers are marked reachable and local ones stay on loopback', () => {
  const entries = providerCatalog()
  for (const entry of entries.filter(item => item.region === 'cn')) {
    assert.equal(entry.chinaDirect, true, `${entry.id} 应标记为国内直连`)
  }
  for (const entry of entries.filter(item => item.region === 'local')) {
    assert.match(entry.baseUrl, /^http:\/\/(127\.0\.0\.1|localhost)/, `${entry.id} 必须指向本机`)
  }
  for (const entry of entries.filter(item => item.region === 'global')) {
    assert.match(entry.baseUrl, /^https:\/\//, `${entry.id} 远端必须走 TLS`)
  }
})

test('every entry carries guidance a non-technical user can follow', () => {
  for (const entry of providerCatalog()) {
    assert.ok(entry.summary.length > 8, `${entry.id} 缺少说明`)
    assert.ok(entry.setup.length >= 2, `${entry.id} 缺少步骤`)
    for (const step of entry.setup) assert.ok(step.length > 6)
    assert.ok(entry.freeTier.length > 0, `${entry.id} 缺少费用说明`)
    assert.match(entry.keyUrl, /^https:\/\//)
    assert.match(entry.docsUrl, /^https:\/\//)
  }
})

test('catalogue copies are defensive (mutating one does not change the source)', () => {
  const first = providerCatalog()
  first[0].setup.push('mutated')
  first[0].tags.push('mutated')
  first[0].models.push('mutated')
  first[0].visionModels.push('mutated')
  first[0].embeddingModels.push('mutated')
  const second = providerCatalog()
  assert.ok(!second[0].setup.includes('mutated'))
  assert.ok(!second[0].tags.includes('mutated'))
  assert.ok(!second[0].models.includes('mutated'))
  assert.ok(!second[0].visionModels.includes('mutated'))
  assert.ok(!second[0].embeddingModels.includes('mutated'))
})

test('every remote provider offers curated ids or explains why it cannot', () => {
  for (const entry of providerCatalog()) {
    assert.ok(Array.isArray(entry.models), `${entry.id} 缺少 models`)
    assert.ok(Array.isArray(entry.visionModels), `${entry.id} 缺少 visionModels`)
    assert.ok(Array.isArray(entry.embeddingModels), `${entry.id} 缺少 embeddingModels`)
    for (const name of [...entry.models, ...entry.visionModels, ...entry.embeddingModels]) {
      assert.equal(name, name.trim(), `${entry.id} 的模型名有空白`)
      assert.ok(!/[\r\n]/.test(name), `${entry.id} 的模型名有换行`)
    }
    if (entry.region !== 'local' && entry.models.length === 0) {
      assert.ok(entry.modelNote, `${entry.id} 没有预置模型时必须说明原因`)
    }
  }
})

test('the well-known ids people search for are actually in the lists', () => {
  const byId = new Map(providerCatalog().map(entry => [entry.id, entry]))
  assert.ok(byId.get('deepseek')?.models.includes('deepseek-chat'))
  assert.ok(byId.get('siliconflow')?.embeddingModels.includes('BAAI/bge-m3'))
  assert.ok(byId.get('siliconflow')?.visionModels.some(name => name.includes('Qwen2.5-VL')))
  assert.ok(byId.get('openai')?.embeddingModels.includes('text-embedding-3-small'))
  assert.ok(byId.get('cloudflare')?.embeddingModels.includes('@cf/baai/bge-m3'))
  assert.ok(byId.get('ollama')?.visionModels.includes('qwen2.5vl:3b'))
  assert.ok(byId.get('ollama')?.embeddingModels.includes('nomic-embed-text'))
  assert.ok(byId.get('anthropic')?.visionModels.length, 'Anthropic 视觉应与对话同款')
})

test('at least a dozen guides carry vision or embedding hints', () => {
  const entries = providerCatalog()
  assert.ok(entries.filter(entry => entry.visionModels.length).length >= 8)
  assert.ok(entries.filter(entry => entry.embeddingModels.length).length >= 7)
})

test('lookup by id returns the entry, and unknown ids return undefined', () => {
  assert.equal(providerGuide('deepseek')?.name, 'DeepSeek')
  assert.equal(providerGuide('nope'), undefined)
})

test('validation catches a broken entry', () => {
  const broken = {
    ...providerCatalog()[0],
    id: 'Bad ID',
    baseUrl: 'ftp://example.com',
    setup: [],
  }
  const problems = validateCatalog([broken])
  assert.ok(problems.some(item => item.includes('id 不合法')))
  assert.ok(problems.some(item => item.includes('baseUrl')))
  assert.ok(problems.some(item => item.includes('两步引导')))
})

test('docs/providers-guide.md stays in sync with the catalogue', async () => {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const doc = await readFile(join(import.meta.dirname, '..', 'docs', 'providers-guide.md'), 'utf8')
  for (const entry of providerCatalog()) {
    // Each provider must be documented by name; the id is checked via its base URL.
    assert.ok(doc.includes(entry.baseUrl), `${entry.id} 的地址没有出现在 providers-guide.md`)
    const shortName = entry.name.split(/[（/\s]/)[0]
    assert.ok(shortName.length >= 2 && doc.includes(shortName), `${entry.id} 的名称没有出现在 providers-guide.md`)
  }
})
