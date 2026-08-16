import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ReminderStore } from '../dist/reminders.js'

test('persists reminder lifecycle with private permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-reminders-'))
  try {
    const store = new ReminderStore(directory)
    await store.initialize()
    const created = await store.create('Review Jarvis plan', '2030-01-01T09:00:00+08:00')
    assert.equal((await store.list()).length, 1)
    await store.complete(created.id)
    assert.equal((await store.list()).length, 0)
    assert.equal((await store.list(true)).length, 1)
    await store.delete(created.id)
    assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')), [])
    assert.equal((await stat(store.path)).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects invalid reminder input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-reminders-'))
  try {
    const store = new ReminderStore(directory)
    await store.initialize()
    await assert.rejects(store.create('   '), /1 to 500/)
    await assert.rejects(store.create('valid', 'not-a-date'), /Invalid time value/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
