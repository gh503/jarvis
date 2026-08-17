import { type MemoryClass, type MemoryItem, type MemorySource } from './memory.js'

interface MemoryReader {
  recallReadOnly(): Promise<MemoryItem[]>
}

export const MODEL_MEMORY_DEFAULT_LIMIT = 10
export const MODEL_MEMORY_MAX_ITEMS = 20
export const MODEL_MEMORY_MAX_BYTES = 16 * 1024

export interface ModelMemory {
  id: string
  class: MemoryClass
  content: string
  confidence: number
  source: MemorySource
  confirmedAt: string
}

export interface ModelMemoryRecall {
  memories: ModelMemory[]
  truncated: boolean
}

export interface ModelMemoryRecallOptions {
  class?: MemoryClass
  limit?: number
}

function project(item: MemoryItem): ModelMemory {
  return {
    id: item.id,
    class: item.class,
    content: item.content,
    confidence: item.confidence,
    source: structuredClone(item.source),
    confirmedAt: item.confirmedAt as string,
  }
}

function outputBytes(memories: ModelMemory[]): number {
  return Buffer.byteLength(JSON.stringify({ memories, truncated: false }), 'utf8')
}

export async function recallForModel(
  store: MemoryReader,
  options: ModelMemoryRecallOptions = {},
): Promise<ModelMemoryRecall> {
  if (options.class !== undefined && options.class !== 'profile' && options.class !== 'episodic') {
    throw new Error('memory class filter is invalid')
  }
  const limit = options.limit ?? MODEL_MEMORY_DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MODEL_MEMORY_MAX_ITEMS) {
    throw new Error(`memory recall limit must be an integer from 1 to ${MODEL_MEMORY_MAX_ITEMS}`)
  }

  const candidates = (await store.recallReadOnly())
    .filter(item => item.ownerId === 'local-owner' && item.sensitivity === 'standard'
      && (options.class === undefined || item.class === options.class))
    .sort((left, right) => (right.confirmedAt as string).localeCompare(left.confirmedAt as string)
      || left.id.localeCompare(right.id))
    .map(project)

  const memories: ModelMemory[] = []
  for (const candidate of candidates) {
    if (memories.length === limit || outputBytes([...memories, candidate]) > MODEL_MEMORY_MAX_BYTES) break
    memories.push(candidate)
  }
  return { memories, truncated: memories.length < candidates.length }
}
