import test from 'node:test'
import assert from 'node:assert/strict'
import { AttentionManager } from '../src/attention.ts'
import { EventBus } from '../src/events.ts'

test('attention follows an explicit conversation path', () => {
  const bus = new EventBus()
  const attention = new AttentionManager(bus)
  assert.equal(attention.getState(), 'idle')
  assert.equal(attention.send({ type: 'wake' }).state, 'listening')
  assert.equal(attention.send({ type: 'speech_start' }).state, 'capturing')
  assert.equal(attention.send({ type: 'speech_end' }).state, 'understanding')
  assert.equal(attention.send({ type: 'context_needed' }).state, 'need_context')
  assert.equal(attention.send({ type: 'context_ready' }).state, 'understanding')
  assert.equal(attention.send({ type: 'respond_start' }).state, 'responding')
  assert.equal(attention.send({ type: 'respond_done' }).state, 'followup')
  assert.equal(attention.send({ type: 'followup_expired' }).state, 'idle')
})

test('invalid transitions do not move state', () => {
  const attention = new AttentionManager(new EventBus())
  const result = attention.send({ type: 'respond_done' })
  assert.equal(result.ok, false)
  assert.equal(attention.getState(), 'idle')
})

test('context policy is conservative about deictic references', () => {
  const attention = new AttentionManager(new EventBus())
  assert.equal(attention.decideContext('看下这个').target, 'screen')
  assert.equal(attention.decideContext('看看我这边').target, 'camera')
  assert.equal(attention.decideContext('看一下摄像头').target, 'camera')
  assert.equal(attention.decideContext('今天天气怎么样').target, 'none')
  assert.equal(attention.decideContext('看看我的代码和摄像头').target, 'ask')
})
