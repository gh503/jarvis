import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../src/memory/store.ts'
import { HashEmbedder } from '../src/memory/embedding.ts'

test('memory graph exposes nodes, supersedes and manual links', async () => {
  const db = new MemoryStore({ file: ':memory:', embedder: new HashEmbedder(), now: () => new Date('2026-10-26T09:00:00+08:00') })
  const oldItem = await db.add({
    kind: 'semantic', content: '周五下午做周复盘。', sourceKind: 'user-stated', sourceRef: 'test',
    status: 'confirmed', importance: { explicit: 0.8 },
  })
  const target = await db.add({
    kind: 'prospective', content: '周五提交周报。', sourceKind: 'user-stated', sourceRef: 'test',
    status: 'confirmed', importance: { deadline: 1 },
  })
  db.link(oldItem.id, target.id, 'related', 0.8)
  const graph = db.graph(160)
  assert.equal(graph.nodes.length, 2)
  assert.ok(graph.edges.some(edge => edge.type === 'link'))
  assert.equal(graph.nodes[0]?.importanceDetail.explicit > 0, true)
  assert.equal(graph.counts.semantic, 1)
  db.close()
})
