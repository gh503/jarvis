import test from 'node:test'
import assert from 'node:assert/strict'
import { EventBus } from '../src/events.ts'
import { TelemetryCollector } from '../src/telemetry.ts'
import { SecureFiles } from '../src/secure-files.ts'

test('telemetry builds a turn trace from ordered events', async () => {
  const bus = new EventBus()
  const telemetry = new TelemetryCollector(bus)
  const turnId = 'turn-test-1'
  bus.emit('voice.asr.start', { turnId })
  bus.emit('voice.transcribed', { turnId, text: '周五要做什么', asrMs: 280 })
  bus.emit('turn.start', { turnId, source: 'voice', text: '周五要做什么' })
  bus.emit('memory.recalled', { query: '周五要做什么', ids: ['m1'], confidence: 0.72 })
  bus.emit('assistant.delta', { turnId, text: '你' })
  bus.emit('assistant.audio', { turnId, url: '/api/audio/a.wav', text: '你' })
  bus.emit('assistant.done', { turnId, text: '你周五要提交周报。', durationMs: 1400, contextUsed: ['m1'] })
  const snapshot = telemetry.snapshot()
  assert.equal(snapshot.counters.turns, 1)
  assert.equal(snapshot.counters.voiceTurns, 1)
  assert.equal(snapshot.counters.recalls, 1)
  assert.equal(snapshot.counters.audioSegments, 1)
  const trace = snapshot.turns[0]
  assert.equal(trace.id, turnId)
  assert.equal(trace.source, 'voice')
  assert.equal(trace.asrMs, 280)
  assert.equal(trace.totalMs, 1400)
  assert.equal(trace.contextCount, 1)
  assert.equal(trace.status, 'ok')
  assert.equal(trace.firstTokenMs !== null, true)
  assert.equal(snapshot.series.length, 1)
  assert.equal(snapshot.events[0]?.type, 'assistant.done')
  telemetry.close()
})

test('completed traces survive a restart on disk', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-telemetry-'))
  try {
    const file = join(dir, 'telemetry.jsonl')
    const bus = new EventBus()
    const first = new TelemetryCollector(bus, { file })
    bus.emit('turn.start', { turnId: 'persisted-1', source: 'text', text: 'hello', at: '2026-10-26T01:00:00.000Z' })
    bus.emit('assistant.done', { turnId: 'persisted-1', text: 'hi', durationMs: 42 })
    first.close()
    const second = new TelemetryCollector(new EventBus(), { file })
    const traces = second.historyTraces(10)
    assert.equal(traces[0]?.id, 'persisted-1')
    assert.equal(traces[0]?.totalMs, 42)
    second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('late audio never reports a first-audio time beyond the turn total', async () => {
  const bus = new EventBus()
  const telemetry = new TelemetryCollector(bus)
  bus.emit('turn.start', { turnId: 'late-audio', source: 'voice', text: 'hi' })
  bus.emit('assistant.done', { turnId: 'late-audio', durationMs: 80 })
  await new Promise(resolve => setTimeout(resolve, 120))
  bus.emit('assistant.audio', { turnId: 'late-audio' })
  const trace = telemetry.historyTraces(1)[0]
  assert.equal(trace.firstAudioMs, 80)
  telemetry.close()
})

test('persisted telemetry is encrypted and still reloads', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-telemetry-secure-'))
  try {
    const file = join(dir, 'telemetry.jsonl')
    const secure = new SecureFiles(dir)
    const bus = new EventBus()
    const first = new TelemetryCollector(bus, { file, secure })
    bus.emit('turn.start', { turnId: 'secret-turn', source: 'text', text: '我的门牌号是 42', at: '2026-10-26T01:00:00.000Z' })
    bus.emit('assistant.done', { turnId: 'secret-turn', text: '记住了', durationMs: 10 })
    first.close()
    const raw = await readFile(file, 'utf8')
    assert.match(raw, /^J1:/)
    assert.doesNotMatch(raw, /门牌号|secret-turn/)
    const second = new TelemetryCollector(new EventBus(), { file, secure })
    assert.equal(second.historyTraces(5)[0]?.id, 'secret-turn')
    second.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
