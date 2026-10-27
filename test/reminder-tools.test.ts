import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReminderStore, ReminderScheduler, nextOccurrence, type Recurrence, type Reminder } from '../src/proactive/reminders.ts'
import { reminderTools } from '../src/reminder-tools.ts'
import { validateToolArguments } from '../src/tool-schema.ts'

const fixed = new Date('2026-01-01T00:00:00Z')
const daily: Recurrence = { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' }
const context = { signal: new AbortController().signal, sessionId: 's', turnId: 't', callId: 'c' }

test('tool definitions enforce local permissions and schema, strict dates and UTC display', async () => {
  const store = new ReminderStore(':memory:', undefined, () => fixed)
  try {
    const tools = reminderTools(store)
    assert.equal(new Set(tools.map(t => t.name)).size, 5)
    for (const t of tools) {
      assert.equal(t.usage, 'local'); assert.equal(t.destination, 'local')
      assert.equal(t.permission, t.name === 'reminders_list' ? 'allow' : 'ask')
      assert.match(t.definitionHash, /^[a-f0-9]{64}$/)
    }
    const create = tools.find(t => t.name === 'reminder_create')!
    for (const args of [{ text: 'a' }, { text: 'a', dueAt: '2026-02-01T00:00:00Z', recurrence: daily }]) {
      assert.equal((await validateToolArguments(create.parameters, args, context.signal)).valid, false)
      assert.equal((await create.execute(args, context)).isError, true)
    }
    for (const dueAt of ['2026-02-30T10:00:00Z', '2026-01-02T24:00:00Z', '2026-01-02T10:00:00', '2025-12-31T10:00:00Z']) {
      assert.equal((await create.execute({ text: 'test', dueAt }, context)).isError, true)
    }
    assert.equal((await create.execute({ text: 'x'.repeat(1001), dueAt: '2026-02-01T00:00:00Z' }, context)).isError, true)
    const result = JSON.parse((await create.execute({ text: 'meeting', dueAt: '2026-02-01T09:00:00+08:00' }, context)).content)
    assert.equal(result.dueAt, '2026-02-01T01:00:00.000Z')
    assert.equal(result.requestedDueAt, '2026-02-01T09:00:00+08:00')
    assert.match(result.nextDisplay, /GMT/)
    const recurring = JSON.parse((await create.execute({ text: 'daily', recurrence: daily }, context)).content)
    assert.equal(recurring.nextDueAt, '2026-01-01T01:00:00.000Z')
    assert.match(recurring.nextDisplay, /09:00:00 GMT\+08:00 \[Asia\/Shanghai\]/)
  } finally { store.close() }
})

test('CAS editing, explicit recurrence clearing and cancellation retain records', () => {
  const store = new ReminderStore(':memory:', undefined, () => fixed)
  try {
    const r = store.create({ text: 'daily', recurrence: daily })
    const edited = store.update(r.id, { text: 'edited' }, r.revision)!
    assert.equal(edited.revision, 2)
    assert.throws(() => store.update(r.id, { text: 'stale' }, r.revision), /revision conflict/)
    assert.throws(() => store.cancel(r.id, r.revision), /revision conflict/)
    assert.throws(() => store.complete(r.id, r.revision), /revision conflict/)
    assert.throws(() => store.update(r.id, { dueAt: '2026-02-01T00:00:00Z' }, edited.revision), /Clear recurrence/)
    const one = store.update(r.id, { recurrence: null, dueAt: '2026-02-01T00:00:00Z' }, edited.revision)!
    assert.equal(one.recurrence, null)
    const again = store.update(r.id, { recurrence: daily }, one.revision)!
    const cancelled = store.cancel(r.id, again.revision)!
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.nextDueAt, null)
    assert.equal(store.list().length, 0); assert.equal(store.list('cancelled').length, 1)
    assert.equal(store.due(new Date('2027-01-01Z')).length, 0)
  } finally { store.close() }
})

test('calendar recurrence handles DST gaps, earlier fold only, non-hour transition and skipped date', () => {
  const ny = (time: string): Recurrence => ({ kind: 'daily', time, timeZone: 'America/New_York' })
  assert.equal(nextOccurrence(ny('02:30'), new Date('2026-03-08T00:00:00Z')), '2026-03-09T06:30:00.000Z')
  assert.equal(nextOccurrence(ny('01:30'), new Date('2026-11-01T00:00:00Z')), '2026-11-01T05:30:00.000Z')
  assert.equal(nextOccurrence(ny('01:30'), new Date('2026-11-01T05:45:00Z')), '2026-11-02T06:30:00.000Z')
  assert.equal(nextOccurrence({ kind: 'daily', time: '02:15', timeZone: 'Australia/Lord_Howe' }, new Date('2026-10-03T14:00:00Z')), '2026-10-04T15:15:00.000Z')
  assert.equal(nextOccurrence({ kind: 'daily', time: '09:00', timeZone: 'Pacific/Apia' }, new Date('2011-12-29T20:00:00Z')), '2011-12-30T19:00:00.000Z')
  assert.equal(nextOccurrence({ kind: 'weekly', time: '09:00', timeZone: 'Asia/Shanghai', weekdays: [1] }, fixed), '2026-01-05T01:00:00.000Z')
  for (const recurrence of [{ ...daily, timeZone: 'Mars/Foo' }, { ...daily, time: '24:00' }, { ...daily, kind: 'weekly', weekdays: [0] }, { ...daily, kind: 'weekly', weekdays: [1, 1] }]) {
    assert.throws(() => nextOccurrence(recurrence as Recurrence, fixed))
  }
})

test('offline occurrences coalesce to latest, advance before delivery and complete keeps next', async () => {
  let now = fixed
  const store = new ReminderStore(':memory:', undefined, () => now)
  try {
    const r = store.create({ text: 'daily', recurrence: daily })
    now = new Date('2026-01-10T03:00:00Z')
    const delivered: Reminder[] = []
    const scheduler = new ReminderScheduler(store, async item => {
      delivered.push(item)
      assert.equal(store.get(item.id)!.dueAt, '2026-01-11T01:00:00.000Z')
      throw new Error('delivery failed')
    })
    await Promise.all([scheduler.tick(now), scheduler.tick(now)])
    await scheduler.tick(now)
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].dueAt, '2026-01-10T01:00:00.000Z')
    const completed = store.complete(r.id, store.get(r.id)!.revision)!
    assert.equal(completed.dueAt, '2026-01-11T01:00:00.000Z')
    assert.equal(completed.status, 'pending')
    store.cancel(r.id)
    await scheduler.tick(new Date('2026-02-01T00:00:00Z'))
    assert.equal(delivered.length, 1)
    const early = store.create({ text: 'early', recurrence: daily })
    assert.equal(store.complete(early.id)!.dueAt, '2026-01-12T01:00:00.000Z')
  } finally { store.close() }
})

test('legacy database migrates and recurrence/revision survive reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reminder-migration-'))
  const file = join(dir, 'state.db')
  let store: ReminderStore | undefined
  try {
    const db = new DatabaseSync(file)
    db.exec("CREATE TABLE reminders(id TEXT PRIMARY KEY,text TEXT NOT NULL,due_at TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,notified_at TEXT,completed_at TEXT); INSERT INTO reminders VALUES('legacy','old','2026-02-01T00:00:00Z','pending','2026-01-01T00:00:00Z',NULL,NULL)")
    db.close()
    store = new ReminderStore(file, undefined, () => fixed)
    assert.equal(store.get('legacy')!.revision, 1)
    assert.equal(store.get('legacy')!.recurrence, null)
    const r = store.update('legacy', { recurrence: daily }, 1)!
    store.close(); store = new ReminderStore(file, undefined, () => fixed)
    assert.deepEqual(store.get('legacy'), r)
    const other = new ReminderStore(file, undefined, () => fixed)
    try {
      other.update('legacy', { text: 'another connection' }, r.revision)
      assert.throws(() => store!.update('legacy', { text: 'stale' }, r.revision), /revision conflict/)
    } finally { other.close() }
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }) }
})
