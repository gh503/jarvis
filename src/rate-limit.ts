export interface TokenBucketRateLimiterOptions {
  capacity: number
  refillPerSecond: number
  maxKeys: number
  now?: () => number
}

export interface RateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  retryAfterMs: number
}

interface Bucket {
  tokens: number
  updatedAt: number
  lastSeenAt: number
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`)
  return value
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  return value
}

export class TokenBucketRateLimiter {
  private readonly capacity: number
  private readonly refillPerMs: number
  private readonly maxKeys: number
  private readonly now: () => number
  private readonly buckets = new Map<string, Bucket>()

  constructor(options: TokenBucketRateLimiterOptions) {
    this.capacity = positiveInteger(options.capacity, 'capacity')
    this.refillPerMs = positive(options.refillPerSecond, 'refillPerSecond') / 1_000
    this.maxKeys = positiveInteger(options.maxKeys, 'maxKeys')
    this.now = options.now ?? Date.now
  }

  consume(key: string): RateLimitDecision {
    if (key.length === 0) throw new Error('rate limit key must not be empty')
    const now = this.now()
    if (!Number.isFinite(now)) throw new Error('rate limit clock must be finite')
    let bucket = this.buckets.get(key)
    if (bucket === undefined) {
      this.pruneRecovered(now)
      if (this.buckets.size >= this.maxKeys) {
        return {
          allowed: false,
          limit: this.capacity,
          remaining: 0,
          retryAfterMs: this.capacityRetryAfter(now),
        }
      }
      bucket = { tokens: this.capacity, updatedAt: now, lastSeenAt: now }
      this.buckets.set(key, bucket)
    }

    this.refill(bucket, now)
    bucket.lastSeenAt = Math.max(bucket.lastSeenAt, now)
    if (bucket.tokens < 1) {
      return {
        allowed: false,
        limit: this.capacity,
        remaining: 0,
        retryAfterMs: Math.ceil((1 - bucket.tokens) / this.refillPerMs),
      }
    }
    bucket.tokens -= 1
    return {
      allowed: true,
      limit: this.capacity,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs: 0,
    }
  }

  private refill(bucket: Bucket, now: number): void {
    const elapsed = Math.max(0, now - bucket.updatedAt)
    if (elapsed === 0) return
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs)
    bucket.updatedAt = now
  }

  private pruneRecovered(now: number): void {
    for (const [key, bucket] of [...this.buckets].sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)) {
      this.refill(bucket, now)
      if (bucket.tokens >= this.capacity) this.buckets.delete(key)
    }
  }

  private capacityRetryAfter(now: number): number {
    let retryAfterMs = Number.POSITIVE_INFINITY
    for (const bucket of this.buckets.values()) {
      const elapsed = Math.max(0, now - bucket.updatedAt)
      const tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs)
      retryAfterMs = Math.min(retryAfterMs, Math.ceil((this.capacity - tokens) / this.refillPerMs))
    }
    return Number.isFinite(retryAfterMs) ? Math.max(1, retryAfterMs) : 1
  }
}
