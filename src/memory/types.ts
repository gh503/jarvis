export type MemoryKind = 'semantic' | 'episodic' | 'procedural' | 'prospective'
export type MemorySourceKind = 'user-stated' | 'user-confirmed' | 'system-observed' | 'inferred' | 'external' | 'v1-import'
export type MemoryTrust = 'authoritative' | 'high' | 'medium' | 'low'
export type MemorySensitivity = 'standard' | 'sensitive' | 'secret'
export type MemoryStatus = 'proposed' | 'confirmed' | 'rejected' | 'superseded' | 'expired' | 'deleted'
export type MemoryRetention = 'until-deleted' | 'expires-at'

export interface MemoryImportance {
  goal: number
  novelty: number
  social: number
  repetition: number
  explicit: number
  deadline: number
}

export interface MemoryItem {
  id: string
  ownerId: string
  kind: MemoryKind
  content: string
  gist: string
  sourceKind: MemorySourceKind
  sourceRef: string
  sourceSpan: string
  trust: MemoryTrust
  confidence: number
  importance: MemoryImportance
  sensitivity: MemorySensitivity
  validFrom: string
  validTo: string | null
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
  useCount: number
  status: MemoryStatus
  supersedesId: string | null
  pinned: boolean
  retention: MemoryRetention
  expiresAt: string | null
}

export interface MemoryInput {
  id?: string
  kind: MemoryKind
  content: string
  gist?: string
  sourceKind: MemorySourceKind
  sourceRef: string
  sourceSpan?: string
  trust?: MemoryTrust
  confidence?: number
  importance?: Partial<MemoryImportance>
  sensitivity?: MemorySensitivity
  validFrom?: string
  validTo?: string | null
  status?: MemoryStatus
  supersedesId?: string | null
  pinned?: boolean
  retention?: MemoryRetention
  expiresAt?: string | null
  resolveConflicts?: boolean
}

export interface EpisodeInput {
  id?: string
  startedAt: string
  endedAt: string
  app?: string
  window?: string
  participants?: string[]
  summary: string
  sourceRef: string
  sensitivity?: MemorySensitivity
}

export interface Episode extends EpisodeInput {
  id: string
  createdAt: string
}

export interface RecallOptions {
  limit?: number
  kinds?: MemoryKind[]
  includeSensitive?: boolean
  includeProposed?: boolean
  now?: Date
  context?: {
    app?: string
    participants?: string[]
    task?: string
  }
}

export interface RecalledMemory extends MemoryItem {
  score: number
  semantic: number
  importanceScore: number
  strength: number
  why: string[]
}

export interface RecallResult {
  items: RecalledMemory[]
  confidence: number
  why: string[]
  missing: string[]
  queryType: QueryType
}

export type QueryType = 'fact' | 'preference' | 'temporal' | 'entity' | 'multihop' | 'procedural' | 'update' | 'general'

export interface ConsolidationStats {
  expired: number
  expiredProposals: number
  deduped: number
  superseded: number
  embedded: number
  projected: number
  durationMs: number
}

export interface MemoryStats {
  total: number
  confirmed: number
  proposed: number
  sensitive: number
  embedded: number
  episodes: number
}

export interface Embedder {
  readonly model: string
  embed(text: string): Promise<Float32Array | null>
}

export function emptyImportance(): MemoryImportance {
  return { goal: 0.5, novelty: 0.5, social: 0.5, repetition: 0.5, explicit: 0.5, deadline: 0.5 }
}

export function normalizeImportance(input?: Partial<MemoryImportance>): MemoryImportance {
  const base = emptyImportance()
  if (!input) return base
  const clamp = (value: number | undefined): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5
    return Math.max(0, Math.min(1, value))
  }
  return {
    goal: clamp(input.goal ?? base.goal),
    novelty: clamp(input.novelty ?? base.novelty),
    social: clamp(input.social ?? base.social),
    repetition: clamp(input.repetition ?? base.repetition),
    explicit: clamp(input.explicit ?? base.explicit),
    deadline: clamp(input.deadline ?? base.deadline),
  }
}

export function importanceScore(importance: MemoryImportance): number {
  return (
    0.3 * importance.goal +
    0.2 * importance.novelty +
    0.15 * importance.social +
    0.15 * importance.repetition +
    0.1 * importance.explicit +
    0.1 * importance.deadline
  )
}

export function trustScore(trust: MemoryTrust): number {
  switch (trust) {
    case 'authoritative':
      return 1
    case 'high':
      return 0.85
    case 'medium':
      return 0.6
    case 'low':
      return 0.3
  }
}

export function isActive(item: MemoryItem, now = new Date()): boolean {
  if (item.status !== 'confirmed') return false
  if (item.validTo && Date.parse(item.validTo) <= now.getTime()) return false
  if (item.retention === 'expires-at' && item.expiresAt && Date.parse(item.expiresAt) <= now.getTime()) return false
  return true
}