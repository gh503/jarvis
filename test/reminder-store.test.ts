import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ReminderStore } from '../src/proactive/reminders.ts'

test('due reminders compare instants, not ISO strings with mixed offsets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-reminder-due-'))
  const store = new ReminderStore(join(dir, 'jarvis.db'))
  try {
    // 00:30 on 27 Oct in Asia/Shanghai is 16:30Z on 26 Oct. A local-time
    // string comparison against "2026-10-27T01:00+08:00" sees "26" < "27"
    // and silently misses it for the whole night.
    const due = store.add('夜间提醒', '2026-10-26T16:30:00.000Z')
    const notYet = store.add('稍后提醒', '2026-10-26T17:30:00.000Z')
    const now = new Date('2026-10-27T01:00:00+08:00')
    const items = store.due(now)
    assert.deepEqual(items.map(item => item.id), [due.id])
    assert.equal(items.some(item => item.id === notYet.id), false)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('reminder list orders mixed offsets by instant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-reminder-list-'))
  const store = new ReminderStore(join(dir, 'jarvis.db'))
  try {
    const later = store.add('UTC 09:00', '2026-10-27T01:00:00.000Z')
    const earlier = store.add('local 02:00', '2026-10-27T02:00:00+08:00')
    assert.deepEqual(store.list().map(item => item.id), [earlier.id, later.id])
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
})
