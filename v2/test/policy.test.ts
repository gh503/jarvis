import test from 'node:test'
import assert from 'node:assert/strict'
import { ProactivePolicy } from '../src/proactive/policy.ts'
import type { JarvisConfig } from '../src/config.ts'

function config(overrides: Partial<JarvisConfig> = {}): JarvisConfig {
  return {
    version: '2.0.0',
    host: '127.0.0.1',
    port: 3081,
    dataDir: '/tmp/jarvis-policy-test',
    webDir: '/tmp',
    authToken: '',
    tlsCert: '',
    tlsKey: '',
    ollama: { url: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', visionModel: 'qwen2.5vl:3b', embedModel: 'nomic-embed-text' },
    voice: { asrEngine: 'faster-whisper', pythonBin: 'python3', fasterWhisperScript: '', fasterWhisperModel: 'tiny', ocrScript: '', whisperBin: '', whisperModel: '', piperBin: '', piperVoice: '', ffmpeg: 'ffmpeg', arecord: 'arecord' },
    quiet: { start: '22:00', end: '08:00' },
    dailySpeakBudget: 5,
    screenTimeoutMs: 15000,
    screenBlocklist: [],
    ...overrides,
  }
}

const urgent = { urgency: 1, relevance: 1, timeliness: 1, preference: 1, interruptCost: 0, channelCost: 0 }

test('quiet hours suppress speech', () => {
  const policy = new ProactivePolicy(config())
  const decision = policy.decide(urgent, new Date('2026-10-26T23:00:00+08:00'))
  assert.equal(decision.speak, false)
  assert.equal(decision.reason, 'quiet_hours')
})

test('focus mode wins over an urgent signal', () => {
  const policy = new ProactivePolicy(config())
  policy.setFocus(true)
  const decision = policy.decide(urgent, new Date('2026-10-26T12:00:00+08:00'))
  assert.equal(decision.speak, false)
  assert.equal(decision.reason, 'focus_mode')
})

test('daily budget degrades to a toast, not silence', () => {
  const policy = new ProactivePolicy(config({ dailySpeakBudget: 1 }))
  policy.noteSpoken()
  const decision = policy.decide(urgent, new Date('2026-10-26T12:00:00+08:00'))
  assert.equal(decision.speak, false)
  assert.equal(decision.reason, 'daily_budget_exhausted')
  assert.equal(decision.channel, 'toast')
})

test('a strong signal is allowed to speak', () => {
  const policy = new ProactivePolicy(config())
  const decision = policy.decide(urgent, new Date('2026-10-26T12:00:00+08:00'))
  assert.equal(decision.speak, true)
  assert.equal(decision.channel, 'voice')
})
