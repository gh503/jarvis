import type { Embedder } from './types.ts'

export class NullEmbedder implements Embedder {
  readonly model = 'none'

  async embed(): Promise<Float32Array | null> {
    return null
  }
}

/**
 * Deterministic bag-of-character embeddings for tests and for graceful
 * degradation when the local embedding model is not available. This is not a
 * semantic model; it only keeps the memory pipeline testable offline.
 */
export class HashEmbedder implements Embedder {
  readonly model = 'hash-test'

  constructor(private readonly dimensions = 64) {}

  async embed(text: string): Promise<Float32Array> {
    const out = new Float32Array(this.dimensions)
    const normalized = text.toLowerCase()
    for (let i = 0; i < normalized.length; i += 1) {
      const code = normalized.charCodeAt(i)
      const a = (code * 31 + i * 17) % this.dimensions
      const b = (code * 131 + i * 7) % this.dimensions
      out[a] += 1
      out[b] += 0.5
    }
    let norm = 0
    for (const value of out) norm += value * value
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < out.length; i += 1) out[i] /= norm
    return out
  }
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i]
    leftNorm += left[i] * left[i]
    rightNorm += right[i] * right[i]
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

export function encodeEmbedding(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

export function decodeEmbedding(value: unknown): Float32Array | null {
  if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value.byteLength)
    copy.set(value)
    return new Float32Array(copy.buffer)
  }
  if (value instanceof ArrayBuffer) return new Float32Array(value)
  return null
}