import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../src/memory/store.ts'
import { HashEmbedder } from '../src/memory/embedding.ts'
import { conflictsWith, extractSubject } from '../src/memory/update.ts'

const now = () => new Date('2026-10-26T09:00:00+08:00')

test('explicit location updates retire the old fact', async () => {
  const db = new MemoryStore({ file: ':memory:', embedder: new HashEmbedder(), now })
  const old = await db.add({ kind: 'semantic', content: '我住在上海浦东。', sourceKind: 'user-stated', sourceRef: 'a', status: 'confirmed' })
  const next = await db.add({
    kind: 'semantic', content: '我搬到杭州西湖区了。', sourceKind: 'user-stated', sourceRef: 'b', status: 'confirmed', resolveConflicts: true,
  })
  assert.equal(next.supersedesId, old.id)
  assert.equal(db.get(old.id)?.status, 'superseded')
  assert.ok(db.get(old.id)?.validTo)
  const recalled = await db.recall('杭州 住址')
  assert.deepEqual(recalled.items.map(item => item.id), [next.id])
  db.close()
})

test('opposite preferences conflict but different objects do not', () => {
  assert.equal(conflictsWith('我不喜欢咖啡。', '我喜欢咖啡。'), true)
  assert.equal(conflictsWith('我喜欢茶。', '我喜欢咖啡。'), false)
  assert.equal(extractSubject('我搬到成都了。')?.key, 'location')
  assert.equal(extractSubject('我的手机号是 13800000000。')?.key, 'contact:手机号')
})
