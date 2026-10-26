import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDailyBrief } from '../src/brief.ts'
import { MemoryStore } from '../src/memory/store.ts'
import { HashEmbedder } from '../src/memory/embedding.ts'
import { ReminderStore } from '../src/proactive/reminders.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('daily brief prioritizes due reminders and prospective memories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-brief-'))
  try {
    const now = new Date('2026-10-26T09:00:00+08:00')
    const memory = new MemoryStore({ file: ':memory:', embedder: new HashEmbedder(), now: () => now })
    const reminders = new ReminderStore(join(dir, 'jarvis.db'))
    await memory.add({ kind: 'prospective', content: '周五前提交周报。', sourceKind: 'user-confirmed', sourceRef: 'test', status: 'confirmed' })
    await memory.add({ kind: 'semantic', content: '我偏好上午做深度工作。', sourceKind: 'user-confirmed', sourceRef: 'test', status: 'confirmed', importance: { goal: 0.9 } })
    reminders.add('10 点开会', '2026-10-26T10:00:00+08:00')
    reminders.add('明天的事', '2026-10-27T10:00:00+08:00')
    const brief = buildDailyBrief(memory, reminders, now)
    assert.equal(brief.stats.reminders, 1)
    assert.equal(brief.stats.memories, 2)
    assert.match(brief.text, /10 点开会/)
    assert.match(brief.text, /周报/)
    assert.doesNotMatch(brief.text, /明天的事/)
    memory.close()
    reminders.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('brief schedule parses time and rolls to tomorrow after the target', async () => {
  const { parseBriefTime, nextBriefAt } = await import('../src/brief.ts')
  assert.deepEqual(parseBriefTime('08:30'), { hour: 8, minute: 30 })
  assert.equal(parseBriefTime('25:00'), null)
  const next = nextBriefAt(new Date('2026-10-26T09:00:00+08:00'), 8, 30)
  assert.equal(next.toISOString(), '2026-10-27T00:30:00.000Z')
})
