import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NullEmbedder } from '../src/memory/embedding.ts'
import { MemoryStore } from '../src/memory/store.ts'

test('privacy export is not truncated by the paginated list cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-export-all-'))
  const store = new MemoryStore({ file: join(dir, 'jarvis.db'), embedder: new NullEmbedder() })
  try {
    for (let index = 0; index < 205; index += 1) {
      await store.add({
        kind: 'semantic',
        content: `导出测试记忆 ${index}`,
        sourceKind: 'user-confirmed',
        sourceRef: `export:${index}`,
        status: 'confirmed',
      })
    }
    for (let index = 0; index < 205; index += 1) {
      store.addEpisode({
        startedAt: new Date(Date.now() + index).toISOString(),
        endedAt: new Date(Date.now() + index + 1).toISOString(),
        summary: `导出测试片段 ${index}`,
        sourceRef: `episode:${index}`,
      })
    }
    const exported = store.exportAll()
    assert.equal(exported.items.length, 205)
    assert.equal(exported.episodes.length, 205)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
