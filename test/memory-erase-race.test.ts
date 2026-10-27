import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../src/memory/store.ts'

test('privacy erase invalidates an embedding-backed write already in flight', async () => {
  let release!: (value: Float32Array | null) => void
  const store = new MemoryStore({ file: ':memory:', embedder: { model: 'test', embed: () => new Promise(resolve => { release = resolve }) } })
  try {
    const pending = store.add({ content: 'must not reappear', kind: 'semantic', sourceKind: 'user-stated', sourceRef: 'test' })
    store.eraseAll()
    release(new Float32Array([1, 0]))
    await assert.rejects(pending, /privacy erase/)
    assert.equal(store.stats().total, 0)
  } finally { store.close() }
})
