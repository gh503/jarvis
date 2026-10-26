import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../src/memory/store.ts'
import { HashEmbedder } from '../src/memory/embedding.ts'

const now = () => new Date('2026-10-26T09:00:00+08:00')

function store(): MemoryStore {
  return new MemoryStore({ file: ':memory:', embedder: new HashEmbedder(), now })
}

test('explicit memory survives short Chinese recall', async () => {
  const db = store()
  await db.add({
    kind: 'semantic',
    content: '我对花生过敏，不能吃花生酱。',
    sourceKind: 'user-stated',
    sourceRef: 'test',
    status: 'confirmed',
  })
  const result = await db.recall('花生')
  assert.equal(result.items.length, 1)
  assert.match(result.items[0].content, /花生/)
  assert.ok(result.confidence > 0)
  db.close()
})

test('unrelated questions abstain instead of using recent memory', async () => {
  const db = store()
  await db.add({
    kind: 'semantic',
    content: '我每周三晚上要整理项目进度。',
    sourceKind: 'user-stated',
    sourceRef: 'test',
    status: 'confirmed',
  })
  const result = await db.recall('你准备好了吗？')
  assert.equal(result.items.length, 0)
  assert.equal(result.why.includes('no_candidate'), true)
  db.close()
})

test('sensitive memory is excluded from model recall by default', async () => {
  const db = store()
  await db.add({
    kind: 'semantic',
    content: '我的银行卡密码是 123456。',
    sourceKind: 'user-stated',
    sourceRef: 'test',
    sensitivity: 'sensitive',
    status: 'confirmed',
  })
  const modelView = await db.recall('银行卡')
  assert.equal(modelView.items.length, 0)
  const ownerView = await db.recall('银行卡', { includeSensitive: true })
  assert.equal(ownerView.items.length, 1)
  db.close()
})

test('proposed memories do not enter model context before confirmation', async () => {
  const db = store()
  const item = await db.add({
    kind: 'semantic',
    content: '用户可能喜欢在周三整理项目。',
    sourceKind: 'inferred',
    sourceRef: 'test',
  })
  assert.equal(item.status, 'proposed')
  assert.equal((await db.recall('周三')).items.length, 0)
  db.confirm(item.id)
  assert.equal((await db.recall('周三')).items.length, 1)
  db.close()
})

test('editing supersedes rather than mutating history', async () => {
  const db = store()
  const old = await db.add({
    kind: 'semantic',
    content: '我的项目代号是 A。',
    sourceKind: 'user-stated',
    sourceRef: 'test',
    status: 'confirmed',
  })
  const replacement = await db.edit(old.id, '我的项目代号是 B。')
  assert.ok(replacement)
  assert.equal(replacement?.supersedesId, old.id)
  assert.equal(db.get(old.id)?.status, 'superseded')
  const result = await db.recall('项目代号')
  assert.equal(result.items.length, 1)
  assert.match(result.items[0].content, /B/)
  db.close()
})

test('consolidation retires older exact duplicates', async () => {
  const db = store()
  await db.add({ kind: 'semantic', content: '重复的事实', sourceKind: 'user-stated', sourceRef: 'a', status: 'confirmed' })
  await new Promise(resolve => setTimeout(resolve, 5))
  await db.add({ kind: 'semantic', content: '重复的事实', sourceKind: 'user-stated', sourceRef: 'b', status: 'confirmed' })
  const stats = await db.consolidate()
  assert.equal(stats.deduped, 1)
  assert.equal(db.list({ includeInactive: false }).length, 1)
  db.close()
})

test('deleting a memory removes its FTS row too', async () => {
  const db = store()
  const item = await db.add({
    kind: 'semantic',
    content: '删除测试：我的旧地址是 A 路 1 号。',
    sourceKind: 'user-stated',
    sourceRef: 'test',
    status: 'confirmed',
  })
  assert.equal(db.delete(item.id), true)
  assert.equal((await db.recall('旧地址')).items.length, 0)
  assert.equal(db.get(item.id), null)
  db.close()
})

test('episodes are stored separately from semantic memories', async () => {
  const db = store()
  db.addEpisode({
    startedAt: '2026-10-26T08:00:00+08:00',
    endedAt: '2026-10-26T08:05:00+08:00',
    summary: '用户让我看了一个页面。',
    sourceRef: 'episode',
  })
  assert.equal(db.listEpisodes().length, 1)
  assert.equal(db.stats().episodes, 1)
  db.close()
})
