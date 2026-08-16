import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FileEventLogStore, RetainedEventLog } from '../dist/event-log.js'

function status(id, running) {
  return { type: 'conversation.status', conversationId: id, running }
}

test('retains monotonic events, replays from a cursor, and reports explicit gaps', () => {
  let now = 1_000
  const log = new RetainedEventLog({ maxEvents: 2, now: () => now++ })
  const initial = log.currentCursor()
  const first = log.publish(status('session-one', true))
  const second = log.publish(status('session-one', false))
  const third = log.publish({ type: 'conversation.removed', conversationId: 'session-one' })

  assert.equal(first.version, 1)
  assert.equal(first.occurredAt, 1_000)
  assert.deepEqual(log.replay(second.cursor), {
    cursor: third.cursor, events: [third], requiresSnapshot: false,
  })
  assert.deepEqual(log.replay(first.cursor), {
    cursor: third.cursor, events: [second, third], requiresSnapshot: false,
  })
  assert.equal(log.replay(initial).reason, 'cursor_expired')
  assert.equal(log.replay('invalid').reason, 'invalid_cursor')
  assert.equal(log.replay(`${third.cursor.split('.')[0]}.999`).reason, 'cursor_ahead')
  assert.equal(log.replay().reason, 'initial')
})

test('persists only normalized retained events with private permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-events-'))
  const path = join(directory, 'event-state.json')
  try {
    const first = new RetainedEventLog({ store: new FileEventLogStore(path) })
    const event = first.publish({
      type: 'conversation.message.committed',
      conversationId: 'session-one',
      message: { id: 'message-one', sequence: 2, createdAt: 3, role: 'assistant', text: 'Visible answer' },
    })
    const restored = new RetainedEventLog({ store: new FileEventLogStore(path) })
    assert.equal(restored.restored, true)
    assert.equal(restored.currentCursor(), event.cursor)
    assert.deepEqual(restored.replay(event.cursor), { cursor: event.cursor, events: [], requiresSnapshot: false })
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    const stored = await readFile(path, 'utf8')
    assert.match(stored, /Visible answer/)
    assert.doesNotMatch(stored, /cwd|agentPreset|reasoning|tool\/result/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects invalid payloads and oversized single events before publication', () => {
  const log = new RetainedEventLog({ maxBytes: 256 })
  assert.throws(() => log.publish({ type: 'conversation.status', conversationId: '../private', running: true }), /payload/)
  assert.throws(() => log.publish({
    type: 'conversation.status', conversationId: 'session-one', running: true, cwd: '/private/path',
  }), /payload/)
  assert.throws(() => log.publish({
    type: 'conversation.message.committed',
    conversationId: 'session-one',
    message: { id: 'message-one', sequence: 1, createdAt: 1, role: 'assistant', text: 'x'.repeat(512) },
  }), /retention byte limit/)
})

test('rolls back an event when durable persistence fails', () => {
  const log = new RetainedEventLog({
    store: { load: () => undefined, save: () => { throw new Error('disk unavailable') } },
  })
  const cursor = log.currentCursor()
  assert.throws(() => log.publish(status('session-one', true)), /disk unavailable/)
  assert.equal(log.currentCursor(), cursor)
  assert.equal(log.replay(cursor).events.length, 0)
})
