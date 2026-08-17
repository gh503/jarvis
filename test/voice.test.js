import assert from 'node:assert/strict'
import test from 'node:test'
import { PushToTalkController, SpeechPlaybackController } from '../web/voice.js'

class FakeRecognition {
  startCalls = 0
  stopCalls = 0
  abortCalls = 0

  start() { this.startCalls += 1 }
  stop() { this.stopCalls += 1 }
  abort() { this.abortCalls += 1 }
}

function result(transcript, isFinal) {
  return { 0: { transcript }, isFinal }
}

test('requires explicit enable and creates one final editable transcript per press cycle', () => {
  const recognitions = []
  const states = []
  const finalTranscripts = []
  const controller = new PushToTalkController({
    recognitionFactory: () => {
      const recognition = new FakeRecognition()
      recognitions.push(recognition)
      return recognition
    },
    onState: state => states.push(state),
    onFinalTranscript: transcript => finalTranscripts.push(transcript),
  })

  assert.equal(controller.getState().phase, 'disabled')
  assert.equal(controller.start(), false)
  assert.equal(controller.setEnabled(true), true)
  assert.equal(controller.start(), true)
  const recognition = recognitions[0]
  assert.equal(recognition.startCalls, 1)
  recognition.onstart()
  recognition.onresult({ results: [result('你好', false)] })
  assert.deepEqual(states.at(-1), {
    phase: 'listening', enabled: true, supported: true, message: '正在听', transcript: '你好',
  })
  assert.equal(controller.stop(), true)
  assert.equal(recognition.stopCalls, 1)
  recognition.onresult({ results: [result('你好 Jarvis', true)] })
  recognition.onend()
  assert.deepEqual(finalTranscripts, ['你好 Jarvis'])
  assert.equal(states.at(-1).phase, 'idle')
  assert.equal(states.at(-1).transcript, '你好 Jarvis')
  recognition.onend()
  assert.deepEqual(finalTranscripts, ['你好 Jarvis'])
})

test('disabling aborts recognition and stale callbacks cannot produce a transcript', () => {
  const recognition = new FakeRecognition()
  const finalTranscripts = []
  const states = []
  const controller = new PushToTalkController({
    recognitionFactory: () => recognition,
    onState: state => states.push(state),
    onFinalTranscript: transcript => finalTranscripts.push(transcript),
  })
  controller.setEnabled(true)
  controller.start()
  const staleResult = recognition.onresult
  const staleEnd = recognition.onend
  controller.setEnabled(false)
  assert.equal(recognition.abortCalls, 1)
  staleResult({ results: [result('不应进入草稿', true)] })
  staleEnd()
  assert.deepEqual(finalTranscripts, [])
  assert.equal(states.at(-1).phase, 'disabled')
})

test('reports unsupported and permission-denied recognition without starting another operation', () => {
  const unsupportedStates = []
  const unsupported = new PushToTalkController({ recognitionFactory: null, onState: state => unsupportedStates.push(state) })
  assert.equal(unsupported.setEnabled(true), false)
  assert.equal(unsupported.start(), false)
  assert.equal(unsupportedStates.at(-1).phase, 'unavailable')

  const recognition = new FakeRecognition()
  const states = []
  const controller = new PushToTalkController({ recognitionFactory: () => recognition, onState: state => states.push(state) })
  controller.setEnabled(true)
  controller.start()
  recognition.onerror({ error: 'not-allowed' })
  assert.deepEqual(states.at(-1), {
    phase: 'error', enabled: true, supported: true, message: '麦克风权限未允许',
  })
})

test('automatically stops a bounded utterance and rejects oversized transcript callbacks', async () => {
  const timedRecognition = new FakeRecognition()
  const timed = new PushToTalkController({ recognitionFactory: () => timedRecognition, maxDurationMs: 5 })
  timed.setEnabled(true)
  timed.start()
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(timedRecognition.stopCalls, 1)
  timedRecognition.onend()

  const oversizedRecognition = new FakeRecognition()
  const states = []
  const finalTranscripts = []
  const oversized = new PushToTalkController({
    recognitionFactory: () => oversizedRecognition,
    onState: state => states.push(state),
    onFinalTranscript: transcript => finalTranscripts.push(transcript),
  })
  oversized.setEnabled(true)
  oversized.start()
  oversizedRecognition.onresult({ results: [result('x'.repeat(16 * 1024 + 1), true)] })
  assert.equal(oversizedRecognition.abortCalls, 1)
  assert.equal(states.at(-1).phase, 'error')
  assert.deepEqual(finalTranscripts, [])
})

class FakeSynthesis {
  spoken = []
  cancelCalls = 0

  speak(utterance) { this.spoken.push(utterance) }
  cancel() { this.cancelCalls += 1 }
}

test('speaks one bounded text and ignores callbacks from replaced playback', () => {
  const synthesis = new FakeSynthesis()
  const states = []
  const controller = new SpeechPlaybackController({
    synthesis,
    utteranceFactory: text => ({ text }),
    onState: state => states.push(state),
  })
  assert.equal(controller.speak('第一条回复'), true)
  const first = synthesis.spoken[0]
  assert.equal(first.lang, 'zh-CN')
  first.onstart()
  assert.equal(states.at(-1).phase, 'speaking')
  const staleEnd = first.onend

  assert.equal(controller.speak('第二条回复'), true)
  const second = synthesis.spoken[1]
  assert.equal(synthesis.cancelCalls, 1)
  staleEnd()
  assert.equal(controller.getState().phase, 'speaking')
  second.onend()
  assert.equal(controller.getState().phase, 'idle')
})

test('cancels playback synchronously and fails closed for unsupported or oversized text', () => {
  const synthesis = new FakeSynthesis()
  const states = []
  const controller = new SpeechPlaybackController({
    synthesis,
    utteranceFactory: text => ({ text }),
    onState: state => states.push(state),
  })
  controller.speak('可读回复')
  const staleEnd = synthesis.spoken[0].onend
  assert.equal(controller.cancel(), true)
  assert.equal(synthesis.cancelCalls, 1)
  assert.equal(states.at(-1).phase, 'cancelled')
  staleEnd()
  assert.equal(states.at(-1).phase, 'cancelled')
  assert.equal(controller.speak('x'.repeat(16 * 1024 + 1)), false)
  assert.equal(states.at(-1).phase, 'error')

  const unsupported = new SpeechPlaybackController({ synthesis: null, utteranceFactory: null })
  assert.equal(unsupported.speak('不会播放'), false)
  assert.equal(unsupported.getState().phase, 'unavailable')

  const brokenFactory = new SpeechPlaybackController({
    synthesis,
    utteranceFactory: () => { throw new Error('unavailable') },
  })
  assert.equal(brokenFactory.speak('仍可继续使用文字'), false)
  assert.equal(brokenFactory.getState().phase, 'error')
})
