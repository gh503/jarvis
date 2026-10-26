import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore } from '../src/memory/store.ts'
import { HashEmbedder } from '../src/memory/embedding.ts'

test('on-disk memory database is private to the owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-db-'))
  try {
    const file = join(dir, 'jarvis.db')
    const store = new MemoryStore({ file, embedder: new HashEmbedder() })
    await store.add({ kind: 'semantic', content: '本地数据库权限测试', sourceKind: 'user-stated', sourceRef: 'test', status: 'confirmed' })
    const mode = (await stat(file)).mode & 0o777
    assert.equal(mode, 0o600)
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
