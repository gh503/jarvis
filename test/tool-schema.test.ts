import test from 'node:test'
import assert from 'node:assert/strict'
import { validateToolArguments, validateToolValue } from '../src/tool-schema.ts'

const objectSchema = { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false }

test('validates normal arguments without coercing or mutating them', async () => {
  const value = { count: 2 }
  assert.deepEqual(await validateToolArguments(objectSchema, value), { valid: true })
  assert.deepEqual(value, { count: 2 })
  assert.equal((await validateToolArguments(objectSchema, { count: '2' })).valid, false)
  assert.equal((await validateToolArguments(objectSchema, { count: 0 })).valid, false)
  assert.equal((await validateToolArguments(objectSchema, { count: 2, extra: true })).valid, false)
})

test('supports local refs and rejects malformed or unresolved schemas with fixed errors', async () => {
  assert.equal((await validateToolArguments({ $defs: { count: { type: 'integer' } }, $ref: '#/$defs/count' }, 2)).valid, true)
  for (const schema of [{ $ref: 'https://invalid.example/private-secret' }, { type: 'private-secret' }, { pattern: '[' }]) {
    const result = await validateToolArguments(schema, 'private-secret')
    assert.deepEqual(result, { valid: false, error: 'Invalid tool schema' })
    assert.equal(JSON.stringify(result).includes('private-secret'), false)
  }
})

test('catastrophic regex cannot block main event loop and is terminated on deadline', async () => {
  let responsive = false
  const tick = setTimeout(() => { responsive = true }, 20)
  const started = Date.now()
  const result = await validateToolArguments({ type: 'string', pattern: '^(a+)+$' }, 'a'.repeat(10000) + '!')
  clearTimeout(tick)
  assert.equal(responsive, true)
  assert.deepEqual(result, { valid: false, error: 'Tool validation timed out' })
  // Five-second startup cap plus one-second compute cap, allowing scheduling/termination overhead.
  assert.ok(Date.now() - started < 8000)
  assert.deepEqual(await validateToolArguments({}, {}), { valid: true })
})

test('short compute deadlines begin after worker startup', async () => {
  const started = Date.now()
  const result = await validateToolValue({ pattern: '^(a+)+$' }, 'a'.repeat(10000) + '!', { timeoutMs: 50 })
  assert.deepEqual(result, { valid: false, error: 'Tool validation timed out' })
  // A fresh Node/AJV worker takes longer than 50ms to start; startup must not consume that budget.
  assert.ok(Date.now() - started >= 50)
  assert.deepEqual(await validateToolValue({}, {}, { timeoutMs: 1000 }), { valid: true })
})

test('cancellation before and during worker validation returns no payload details', async () => {
  const before = new AbortController(); before.abort(new Error('private abort reason'))
  assert.deepEqual(await validateToolArguments({}, {}, before.signal), { valid: false, error: 'Tool validation cancelled' })
  const during = new AbortController()
  const task = validateToolArguments({ pattern: '^(a+)+$' }, 'a'.repeat(10000) + '!', during.signal)
  const timer = setTimeout(() => during.abort(new Error('private abort reason')), 30)
  assert.deepEqual(await task, { valid: false, error: 'Tool validation cancelled' })
  clearTimeout(timer)
  assert.deepEqual(await validateToolArguments({}, {}), { valid: true })
})

test('four worker limit rejects excess work and cancellation releases all reservations', async () => {
  const controller = new AbortController()
  const jobs = Array.from({ length: 4 }, () => validateToolArguments({ pattern: '^(a+)+$' }, 'a'.repeat(10000) + '!', controller.signal))
  assert.deepEqual(await validateToolArguments({}, {}), { valid: false, error: 'Tool validation busy' })
  controller.abort()
  assert.ok((await Promise.all(jobs)).every(result => result.error === 'Tool validation cancelled'))
  assert.deepEqual(await validateToolArguments({}, {}), { valid: true })
})

test('bounds schema bytes, depth, nodes and rejects lossy JSON without invoking getters', async () => {
  assert.equal((await validateToolArguments({ description: 'x'.repeat(65_536) }, {})).error, 'Tool schema exceeds JSON limits')
  let deep: Record<string, unknown> = {}
  for (let i = 0; i < 34; i++) deep = { child: deep }
  assert.equal((await validateToolArguments(deep, {})).valid, false)
  assert.equal((await validateToolArguments({ enum: Array.from({ length: 5001 }, () => 1) }, {})).valid, false)
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  for (const value of [cyclic, { value: undefined }, { value: Infinity }, { value: BigInt(2) }, new Date(), new Array(3)]) {
    assert.deepEqual(await validateToolArguments({}, value), { valid: false, error: 'Tool value exceeds JSON limits' })
  }
  let invoked = false
  const getter = { get value() { invoked = true; return 'secret' } }
  assert.equal((await validateToolArguments({}, getter)).valid, false)
  assert.equal(invoked, false)
})

test('value byte cap is UTF8-aware and configurable for bounded output validation', async () => {
  const value = '界'.repeat(30000)
  assert.deepEqual(await validateToolArguments({}, value), { valid: false, error: 'Tool value exceeds JSON limits' })
  assert.equal((await validateToolValue({ type: 'string' }, value, { maxValueBytes: 1_048_576 })).valid, true)
  assert.equal((await validateToolValue({}, 'x'.repeat(1_048_576), { maxValueBytes: 1_048_576 })).valid, false)
  for (const options of [{ maxValueBytes: 1_048_577 }, { timeoutMs: 1001 }, { timeoutMs: 0 }, { maxValueBytes: NaN }]) {
    assert.deepEqual(await validateToolValue({}, {}, options), { valid: false, error: 'Invalid tool validation limits' })
  }
})
