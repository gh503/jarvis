import test from 'node:test'
import assert from 'node:assert/strict'
import { EventBus } from '../src/events.ts'
import { TelemetryCollector } from '../src/telemetry.ts'

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
