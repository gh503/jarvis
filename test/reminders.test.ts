import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReminder } from '../src/proactive/reminders.ts'

const now = new Date('2026-10-26T09:00:00+08:00')

test('parses tomorrow with a Chinese time', () => {
  const parsed = parseReminder('提醒我明天上午 9 点开周会', now)
  assert.ok(parsed)
  assert.equal(parsed?.dueAt, '2026-10-27T09:00:00+08:00')
  assert.match(parsed?.text ?? '', /开周会/)
})

test('parses relative minutes', () => {
  const parsed = parseReminder('10 分钟后喝水', now)
  assert.ok(parsed)
  assert.equal(parsed?.dueAt, '2026-10-26T09:10:00+08:00')
})

test('returns null rather than guessing', () => {
  assert.equal(parseReminder('提醒我早点睡', now), null)
})
