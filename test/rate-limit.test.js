import assert from 'node:assert/strict'
import test from 'node:test'
import { TokenBucketRateLimiter } from '../dist/rate-limit.js'

function limiter(overrides = {}) {
  let now = 1_000
  const value = new TokenBucketRateLimiter({
    capacity: 2,
    refillPerSecond: 1,
    maxKeys: 2,
    now: () => now,
    ...overrides,
  })
  return { value, advance: milliseconds => { now += milliseconds }, rewind: milliseconds => { now -= milliseconds } }
}

test('consumes capacity, reports retry delay, and refills over time', () => {
  const clock = limiter()
  assert.deepEqual(clock.value.consume('source-a'), { allowed: true, limit: 2, remaining: 1, retryAfterMs: 0 })
  assert.deepEqual(clock.value.consume('source-a'), { allowed: true, limit: 2, remaining: 0, retryAfterMs: 0 })
  assert.deepEqual(clock.value.consume('source-a'), { allowed: false, limit: 2, remaining: 0, retryAfterMs: 1_000 })
  clock.advance(500)
  assert.deepEqual(clock.value.consume('source-a'), { allowed: false, limit: 2, remaining: 0, retryAfterMs: 500 })
  clock.advance(500)
  assert.deepEqual(clock.value.consume('source-a'), { allowed: true, limit: 2, remaining: 0, retryAfterMs: 0 })
})

test('isolates keys and does not refill when the clock moves backwards', () => {
  const clock = limiter()
  clock.value.consume('source-a')
  clock.value.consume('source-a')
  assert.equal(clock.value.consume('source-b').allowed, true)
  clock.rewind(500)
  assert.equal(clock.value.consume('source-a').allowed, false)
  clock.advance(1_500)
  assert.equal(clock.value.consume('source-a').allowed, true)
})

test('fails closed at key capacity and reclaims only fully recovered buckets', () => {
  const clock = limiter()
  clock.value.consume('source-a')
  clock.value.consume('source-b')
  const full = clock.value.consume('source-c')
  assert.equal(full.allowed, false)
  assert.equal(full.retryAfterMs, 1_000)
  clock.advance(999)
  assert.equal(clock.value.consume('source-c').allowed, false)
  clock.advance(1)
  assert.equal(clock.value.consume('source-c').allowed, true)
})

test('rejects invalid limiter configuration and keys', () => {
  assert.throws(() => new TokenBucketRateLimiter({ capacity: 0, refillPerSecond: 1, maxKeys: 1 }), /capacity/)
  assert.throws(() => new TokenBucketRateLimiter({ capacity: 1.5, refillPerSecond: 1, maxKeys: 1 }), /capacity/)
  assert.throws(() => new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0, maxKeys: 1 }), /refillPerSecond/)
  assert.throws(() => new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 1, maxKeys: 0 }), /maxKeys/)
  assert.throws(() => limiter().value.consume(''), /must not be empty/)
})
