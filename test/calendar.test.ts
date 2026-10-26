import test from 'node:test'
import assert from 'node:assert/strict'
import { eventsForDay, parseIcs } from '../src/proactive/calendar.ts'

test('ICS parser keeps today events and unescapes summaries', () => {
  const events = parseIcs([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'DTSTART:20261026T100000',
    'DTEND:20261026T110000',
    'SUMMARY:项目周会\\, 讨论发布',
    'LOCATION:会议室 A',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20261027',
    'SUMMARY:明天的事',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'))
  assert.equal(events.length, 2)
  assert.equal(events[0].summary, '项目周会, 讨论发布')
  const today = eventsForDay(events, new Date('2026-10-26T09:00:00+08:00'))
  assert.equal(today.length, 1)
  assert.equal(today[0].location, '会议室 A')
})
