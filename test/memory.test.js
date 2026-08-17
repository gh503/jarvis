import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryStore, validateMemoryDocument } from '../dist/memory.js'

function deterministicStore(directory, clock) {
  let nextId = 0
  return new MemoryStore(directory, {
    now: () => new Date(clock.value),
    randomUUID: () => `memory-${++nextId}`,
  })
}

const persistentRetention = { kind: 'until-deleted', expiresAt: null }

test('persists an owner-controlled memory lifecycle and recalls only confirmed current facts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-memory-'))
  const clock = { value: '2030-01-01T00:00:00.000Z' }
  try {
    const store = deterministicStore(directory, clock)
    await store.initialize()
    const proposed = await store.propose({
      class: 'profile', content: '  Preferred language is Chinese  ', sensitivity: 'standard', confidence: 1,
      source: { kind: 'explicit-user', reference: 'conversation-one:message-one' }, retention: persistentRetention,
    })
    const duplicate = await store.propose({
      class: 'profile', content: 'Preferred language is Chinese', sensitivity: 'standard', confidence: 1,
      source: { kind: 'explicit-user', reference: 'conversation-one:message-one' }, retention: persistentRetention,
    })
    assert.equal(duplicate.id, proposed.id)
    assert.deepEqual(await store.recall(), [])

    clock.value = '2030-01-01T00:01:00.000Z'
    const confirmed = await store.confirm(proposed.id)
    assert.equal(confirmed.status, 'confirmed')
    assert.equal((await store.recall())[0].id, proposed.id)

    const candidate = await store.propose({
      class: 'episodic', content: 'Unconfirmed model candidate', sensitivity: 'sensitive', confidence: 0.7,
      source: { kind: 'model-candidate', reference: 'conversation-one:turn-two' }, retention: persistentRetention,
    })
    await store.reject(candidate.id)
    clock.value = '2030-01-01T00:02:00.000Z'
    const edited = await store.editConfirmed(proposed.id, 'Preferred language is Simplified Chinese')
    assert.equal(edited.status, 'confirmed')
    assert.equal(edited.supersedesId, proposed.id)
    assert.deepEqual(edited.source, { kind: 'owner-edit', reference: proposed.id })
    assert.deepEqual((await store.recall()).map(item => item.id), [edited.id])

    const exported = await store.export()
    assert.equal(exported.version, 1)
    assert.throws(() => validateMemoryDocument({ ...exported, items: [exported.items[0], exported.items[0]] }), /duplicate/)
    assert.equal(exported.items.find(item => item.id === proposed.id).status, 'superseded')
    assert.equal(exported.items.find(item => item.id === candidate.id).status, 'rejected')
    await store.delete(edited.id)
    assert.deepEqual(await store.recall(), [])
    assert.equal((await store.export()).items.some(item => item.id === edited.id), false)
    assert.equal((await stat(store.path)).mode & 0o777, 0o600)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('expires bounded memories deterministically and refuses late confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-memory-expiry-'))
  const clock = { value: '2030-01-01T00:00:00.000Z' }
  try {
    const store = deterministicStore(directory, clock)
    await store.initialize()
    const confirmed = await store.propose({
      class: 'episodic', content: 'Temporary project decision', sensitivity: 'standard', confidence: 0.9,
      source: { kind: 'explicit-user', reference: null },
      retention: { kind: 'expires-at', expiresAt: '2030-01-02T00:00:00.000Z' },
    })
    await store.confirm(confirmed.id)
    const unconfirmed = await store.propose({
      class: 'episodic', content: 'Temporary candidate', sensitivity: 'standard', confidence: 0.5,
      source: { kind: 'model-candidate', reference: null },
      retention: { kind: 'expires-at', expiresAt: '2030-01-02T00:00:00.000Z' },
    })
    clock.value = '2030-01-02T00:00:00.000Z'
    assert.deepEqual(await store.recall(), [])
    await assert.rejects(store.confirm(unconfirmed.id), /must be proposed/)
    assert.deepEqual((await store.list()).map(item => item.status), ['expired', 'expired'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('serializes concurrent proposals and rejects malformed or unsafe state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-memory-validation-'))
  const clock = { value: '2030-01-01T00:00:00.000Z' }
  try {
    const store = deterministicStore(directory, clock)
    await store.initialize()
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.propose({
      class: 'profile', content: `Fact ${index}`, sensitivity: 'standard', confidence: 1,
      source: { kind: 'explicit-user', reference: `message-${index}` }, retention: persistentRetention,
    })))
    assert.equal((await store.list()).length, 20)
    await assert.rejects(store.propose({
      class: 'profile', content: 'x'.repeat(4_097), sensitivity: 'standard', confidence: 1,
      source: { kind: 'explicit-user', reference: null }, retention: persistentRetention,
    }), /4096/)
    await assert.rejects(store.propose({
      class: 'profile', content: 'Already expired', sensitivity: 'standard', confidence: 1,
      source: { kind: 'explicit-user', reference: null },
      retention: { kind: 'expires-at', expiresAt: '2029-12-31T23:59:59.000Z' },
    }), /future/)
    const invalidIds = new MemoryStore(directory, {
      now: () => new Date(clock.value), randomUUID: () => '../outside',
    })
    await assert.rejects(invalidIds.propose({
      class: 'profile', content: 'Unsafe id', sensitivity: 'standard', confidence: 1,
      source: { kind: 'explicit-user', reference: null }, retention: persistentRetention,
    }), /id generator/)
    assert.throws(() => validateMemoryDocument({ version: 1, items: [], extra: true }), /invalid/)

    await writeFile(store.path, '{"version":1,"items":[{"id":"duplicate"},{"id":"duplicate"}]}\n')
    await chmod(store.path, 0o600)
    await assert.rejects(store.list(), /invalid|duplicate/)
    await rm(store.path)
    const target = join(directory, 'outside-memory.json')
    await writeFile(target, '{"version":1,"items":[]}\n', { mode: 0o600 })
    await symlink(target, store.path)
    await assert.rejects(store.initialize(), /regular file/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
