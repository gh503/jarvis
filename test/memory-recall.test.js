import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MODEL_MEMORY_MAX_BYTES, recallForModel } from '../dist/memory-recall.js'
import { MemoryStore } from '../dist/memory.js'

const persistentRetention = { kind: 'until-deleted', expiresAt: null }

function deterministicStore(directory, clock) {
  let nextId = 0
  return new MemoryStore(directory, {
    now: () => new Date(clock.value),
    randomUUID: () => `memory-${String(++nextId).padStart(3, '0')}`,
  })
}

async function addMemory(store, input) {
  const item = await store.propose({
    class: input.class ?? 'profile',
    content: input.content,
    sensitivity: input.sensitivity ?? 'standard',
    confidence: input.confidence ?? 1,
    source: input.source ?? { kind: 'explicit-user', reference: null },
    retention: input.retention ?? persistentRetention,
  })
  return store.confirm(item.id)
}

test('recalls only current confirmed standard memories with provenance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-model-memory-'))
  const clock = { value: '2030-01-01T00:00:00.000Z' }
  try {
    const store = deterministicStore(directory, clock)
    await store.initialize()
    const profile = await addMemory(store, {
      content: 'Preferred language is Chinese',
      source: { kind: 'explicit-user', reference: 'conversation-one:message-one' },
    })
    clock.value = '2030-01-01T00:01:00.000Z'
    const episodic = await addMemory(store, { class: 'episodic', content: 'Project uses the MIT license', confidence: 0.9 })
    await addMemory(store, { content: 'Private account detail', sensitivity: 'sensitive' })
    const expiring = await addMemory(store, {
      content: 'Temporary preference',
      retention: { kind: 'expires-at', expiresAt: '2030-01-01T00:02:00.000Z' },
    })
    const proposed = await store.propose({
      class: 'profile', content: 'Unconfirmed candidate', sensitivity: 'standard', confidence: 0.5,
      source: { kind: 'model-candidate', reference: null }, retention: persistentRetention,
    })
    await store.reject(proposed.id)
    const edited = await store.editConfirmed(profile.id, 'Preferred language is Simplified Chinese')

    clock.value = '2030-01-01T00:02:00.000Z'
    assert.deepEqual((await recallForModel(store)).memories.map(item => item.id), [episodic.id, edited.id])
    assert.deepEqual((await recallForModel(store, { class: 'profile' })).memories, [{
      id: edited.id,
      class: 'profile',
      content: 'Preferred language is Simplified Chinese',
      confidence: 1,
      source: { kind: 'owner-edit', reference: profile.id },
      confirmedAt: edited.confirmedAt,
    }])
    assert.equal((await recallForModel(store)).memories.some(item => item.id === proposed.id), false)
    const persisted = JSON.parse(await readFile(store.path, 'utf8'))
    assert.equal(persisted.items.find(item => item.id === expiring.id).status, 'confirmed')

    await store.delete(edited.id)
    assert.deepEqual((await recallForModel(store, { class: 'profile' })).memories, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('validates recall filters and bounds deterministic model output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-model-memory-bounds-'))
  const clock = { value: '2030-01-01T00:00:00.000Z' }
  try {
    const store = deterministicStore(directory, clock)
    await store.initialize()
    for (let index = 0; index < 8; index += 1) {
      clock.value = new Date(Date.parse(clock.value) + 1_000).toISOString()
      await addMemory(store, { content: `${index}:${'x'.repeat(3_900)}` })
    }

    const limited = await recallForModel(store, { limit: 2 })
    assert.equal(limited.memories.length, 2)
    assert.equal(limited.truncated, true)
    assert.ok(Buffer.byteLength(JSON.stringify(limited), 'utf8') <= MODEL_MEMORY_MAX_BYTES)
    assert.deepEqual(limited.memories.map(item => item.content.slice(0, 1)), ['7', '6'])

    const byteBounded = await recallForModel(store, { limit: 20 })
    assert.equal(byteBounded.truncated, true)
    assert.ok(byteBounded.memories.length < 8)
    assert.ok(Buffer.byteLength(JSON.stringify(byteBounded), 'utf8') <= MODEL_MEMORY_MAX_BYTES)
    await assert.rejects(recallForModel(store, { limit: 0 }), /integer from 1 to 20/)
    await assert.rejects(recallForModel(store, { limit: 21 }), /integer from 1 to 20/)
    await assert.rejects(recallForModel(store, { class: 'secret' }), /class filter/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
