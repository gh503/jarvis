import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { chmodSync, readFileSync } from 'node:fs'
import type { Logger } from '../logger.ts'
import type { EventBus } from '../events.ts'
import type { TuningStore } from '../tuning.ts'
import { NullEmbedder, cosineSimilarity, decodeEmbedding, encodeEmbedding } from './embedding.ts'
import { conflictCandidates } from './update.ts'
import {
  classifyQuery,
  confidenceFrom,
  filterActive,
  renderMemoryContext,
  toRecalled,
} from './recall.ts'
import type {
  ConsolidationStats,
  Embedder,
  Episode,
  EpisodeInput,
  MemoryInput,
  MemoryItem,
  MemoryKind,
  MemorySensitivity,
  MemoryStats,
  MemoryStatus,
  RecallOptions,
  RecallResult,
  RecalledMemory,
} from './types.ts'
import { emptyImportance, importanceScore, isActive, normalizeImportance } from './types.ts'

const MAX_VECTOR_SCAN = 5000
const MAX_LIST = 200
// Cosine similarity for unrelated Chinese sentences often sits around 0.2.
// Treating that as relevant pollutes the model's context; abstain instead.
const MIN_VECTOR_SIMILARITY = 0.32

const QUERY_STOP_CHARS = new Set([...'我你他她它的了吗呢吧啊是在有和就都这那哪个什么怎么', ' ', '\n', '\t', '？', '?', '。', '.', '，', ',', '！', '!'])

function lexicallyRelated(query: string, item: MemoryItem, threshold = 0.34): boolean {
  const haystack = `${item.content} ${item.gist}`
  const chars = [...query].filter(char => !QUERY_STOP_CHARS.has(char))
  if (chars.length === 0) return false
  const overlap = chars.filter(char => haystack.includes(char)).length
  return overlap / chars.length >= threshold
}

export interface MemoryStoreOptions {
  file: string
  embedder?: Embedder
  now?: () => Date
  logger?: Logger
  bus?: EventBus
  tuning?: TuningStore
}

interface Row {
  [key: string]: unknown
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown): boolean {
  return value === 1 || value === true || value === '1'
}

function normalizeContent(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function gistOf(content: string, gist?: string): string {
  const clean = normalizeContent(gist ?? '')
  if (clean) return clean.slice(0, 240)
  return content.length <= 120 ? content : `${content.slice(0, 118)}…`
}

function statusForSource(source: MemoryInput['sourceKind']): MemoryStatus {
  if (source === 'inferred' || source === 'external') return 'proposed'
  return 'confirmed'
}

function trustForSource(source: MemoryInput['sourceKind']): MemoryInput['trust'] {
  switch (source) {
    case 'user-confirmed':
      return 'authoritative'
    case 'user-stated':
    case 'system-observed':
    case 'v1-import':
      return 'high'
    case 'inferred':
    case 'external':
      return 'low'
  }
}

export class MemoryStore {
  private readonly db: DatabaseSync
  private eraseGeneration = 0
  private readonly embedder: Embedder
  private readonly now: () => Date
  private readonly logger?: Logger
  private readonly bus?: EventBus
  private readonly tuning?: TuningStore

  constructor(options: MemoryStoreOptions) {
    this.db = new DatabaseSync(options.file)
    this.embedder = options.embedder ?? new NullEmbedder()
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger
    this.bus = options.bus
    this.tuning = options.tuning
    this.migrate()
    if (options.file !== ':memory:') {
      for (const suffix of ['', '-wal', '-shm']) {
        try { chmodSync(`${options.file}${suffix}`, 0o600) } catch { /* file may not exist yet */ }
      }
    }
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      -- Overwrite deleted rows instead of leaving their bytes in free pages.
      PRAGMA secure_delete = ON;

      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        gist TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_span TEXT NOT NULL,
        trust TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance_goal REAL NOT NULL,
        importance_novelty REAL NOT NULL,
        importance_social REAL NOT NULL,
        importance_repetition REAL NOT NULL,
        importance_explicit REAL NOT NULL,
        importance_deadline REAL NOT NULL,
        sensitivity TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        supersedes_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        retention TEXT NOT NULL,
        expires_at TEXT,
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_items(status, valid_to);
      CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_items(kind);
      CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_items(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_pinned ON memory_items(pinned, updated_at DESC);

      CREATE TABLE IF NOT EXISTS memory_episodes (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        app TEXT NOT NULL DEFAULT '',
        window TEXT NOT NULL DEFAULT '',
        participants TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        sensitivity TEXT NOT NULL DEFAULT 'standard',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_started ON memory_episodes(started_at DESC);

      CREATE TABLE IF NOT EXISTS memory_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'topic',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_links (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id, relation)
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        action TEXT NOT NULL,
        at TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_memory_events_memory ON memory_events(memory_id, at DESC);

      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        due_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        notified_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        content,
        gist,
        tokenize='trigram'
      );
    `)
  }

  private at(): string {
    return this.now().toISOString()
  }

  private event(memoryId: string, action: string, detail = ''): void {
    this.db.prepare(
      'INSERT INTO memory_events (id, memory_id, action, at, detail) VALUES (?, ?, ?, ?, ?)',
    ).run(randomUUID(), memoryId, action, this.at(), detail)
    this.bus?.emit('memory.event', { memoryId, action, detail })
  }

  private ftsUpsert(item: MemoryItem): void {
    this.db.prepare('DELETE FROM memory_fts WHERE id = ?').run(item.id)
    this.db.prepare('INSERT INTO memory_fts (id, content, gist) VALUES (?, ?, ?)').run(
      item.id,
      item.content,
      item.gist,
    )
  }

  async add(input: MemoryInput): Promise<MemoryItem> {
    const generation = this.eraseGeneration
    const content = normalizeContent(input.content)
    if (!content) throw new Error('memory content cannot be empty')
    if (content.length > 8000) throw new Error('memory content is too long')
    const now = this.at()
    const status = input.status ?? statusForSource(input.sourceKind)
    const item: MemoryItem = {
      id: input.id ?? randomUUID(),
      ownerId: 'local-owner',
      kind: input.kind,
      content,
      gist: gistOf(content, input.gist),
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      sourceSpan: input.sourceSpan ?? '',
      trust: input.trust ?? trustForSource(input.sourceKind) ?? 'medium',
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.8)),
      importance: normalizeImportance(input.importance),
      sensitivity: input.sensitivity ?? 'standard',
      validFrom: input.validFrom ?? now,
      validTo: input.validTo ?? null,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      useCount: 0,
      status,
      supersedesId: input.supersedesId ?? null,
      pinned: input.pinned ?? false,
      retention: input.retention ?? 'until-deleted',
      expiresAt: input.expiresAt ?? null,
    }

    // Embedding sends the text to the configured provider. Sensitive and
    // secret notes are only embedded by an on-device embedder; otherwise they
    // stay searchable through full-text search alone.
    const embedderIsLocal = (this.embedder as { isLocal?: boolean }).isLocal === true
    let embedding: Float32Array | null = null
    if (item.sensitivity === 'standard' || embedderIsLocal) {
      try {
        embedding = await this.embedder.embed(`${item.gist}\n${item.content}`)
      } catch (error) {
        this.logger?.warn('embedding failed; storing without vector', { error: String(error) })
      }
    }
    if (generation !== this.eraseGeneration) throw new Error('Memory write cancelled by privacy erase')
    this.insertItem(item, embedding)
    this.event(item.id, 'created', item.sourceKind)
    if (input.resolveConflicts && item.status === 'confirmed') {
      const conflicts = conflictCandidates(item.content, this.list({ includeSensitive: true, includeInactive: false, limit: 200 }))
        .filter(old => old.id !== item.id)
      if (conflicts.length > 0) {
        const at = this.at()
        for (const old of conflicts) {
          this.db.prepare("UPDATE memory_items SET status = 'superseded', valid_to = COALESCE(valid_to, ?), updated_at = ? WHERE id = ?").run(at, at, old.id)
          this.event(old.id, 'superseded_by_update', item.id)
        }
        const newest = conflicts[conflicts.length - 1]
        this.db.prepare('UPDATE memory_items SET supersedes_id = ? WHERE id = ?').run(newest.id, item.id)
        item.supersedesId = newest.id
      }
    }
    this.bus?.emit('memory.added', { item })
    return item
  }

  private insertItem(item: MemoryItem, embedding: Float32Array | null): void {
    this.db.prepare(`
      INSERT INTO memory_items (
        id, owner_id, kind, content, gist, source_kind, source_ref, source_span, trust,
        confidence, importance_goal, importance_novelty, importance_social,
        importance_repetition, importance_explicit, importance_deadline, sensitivity,
        valid_from, valid_to, created_at, updated_at, last_used_at, use_count, status,
        supersedes_id, pinned, retention, expires_at, embedding
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.ownerId,
      item.kind,
      item.content,
      item.gist,
      item.sourceKind,
      item.sourceRef,
      item.sourceSpan,
      item.trust,
      item.confidence,
      item.importance.goal,
      item.importance.novelty,
      item.importance.social,
      item.importance.repetition,
      item.importance.explicit,
      item.importance.deadline,
      item.sensitivity,
      item.validFrom,
      item.validTo,
      item.createdAt,
      item.updatedAt,
      item.lastUsedAt,
      item.useCount,
      item.status,
      item.supersedesId,
      item.pinned ? 1 : 0,
      item.retention,
      item.expiresAt,
      embedding ? encodeEmbedding(embedding) : null,
    )
    this.ftsUpsert(item)
  }

  private rowToItem(row: Row): MemoryItem {
    return {
      id: text(row.id),
      ownerId: text(row.owner_id, 'local-owner'),
      kind: text(row.kind, 'semantic') as MemoryKind,
      content: text(row.content),
      gist: text(row.gist),
      sourceKind: text(row.source_kind, 'inferred') as MemoryItem['sourceKind'],
      sourceRef: text(row.source_ref),
      sourceSpan: text(row.source_span),
      trust: text(row.trust, 'medium') as MemoryItem['trust'],
      confidence: num(row.confidence, 0.5),
      importance: normalizeImportance({
        goal: num(row.importance_goal, 0.5),
        novelty: num(row.importance_novelty, 0.5),
        social: num(row.importance_social, 0.5),
        repetition: num(row.importance_repetition, 0.5),
        explicit: num(row.importance_explicit, 0.5),
        deadline: num(row.importance_deadline, 0.5),
      }),
      sensitivity: text(row.sensitivity, 'standard') as MemorySensitivity,
      validFrom: text(row.valid_from),
      validTo: (row.valid_to as string | null) ?? null,
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      lastUsedAt: (row.last_used_at as string | null) ?? null,
      useCount: num(row.use_count),
      status: text(row.status, 'proposed') as MemoryStatus,
      supersedesId: (row.supersedes_id as string | null) ?? null,
      pinned: bool(row.pinned),
      retention: text(row.retention, 'until-deleted') as MemoryItem['retention'],
      expiresAt: (row.expires_at as string | null) ?? null,
    }
  }

  private embeddingOf(row: Row): Float32Array | null {
    return decodeEmbedding(row.embedding)
  }

  get(id: string): MemoryItem | null {
    const row = this.db.prepare('SELECT * FROM memory_items WHERE id = ?').get(id) as Row | undefined
    return row ? this.rowToItem(row) : null
  }

  list(options: { kind?: MemoryKind; includeSensitive?: boolean; limit?: number; includeInactive?: boolean } = {}): MemoryItem[] {
    const limit = Math.max(1, Math.min(MAX_LIST, options.limit ?? 100))
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (!options.includeInactive) clauses.push("status IN ('confirmed','proposed')")
    if (options.kind) {
      clauses.push('kind = ?')
      params.push(options.kind)
    }
    // Fail closed: a caller that does not explicitly ask for sensitive rows
    // gets standard ones only. Every local view that needs to show sensitive
    // memory passes includeSensitive: true, so a new call site cannot
    // accidentally widen what leaves the store.
    if (options.includeSensitive !== true) {
      clauses.push("sensitivity = 'standard'")
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    params.push(limit)
    const rows = this.db.prepare(
      `SELECT * FROM memory_items ${where} ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
    ).all(...params) as Row[]
    return rows.map(row => this.rowToItem(row))
  }

  private searchFts(query: string, limit: number): Array<{ id: string; rank: number }> {
    const clean = query.trim()
    if (!clean) return []
    const results = new Map<string, number>()
    if (clean.length >= 3) {
      try {
        const phrase = `"${clean.replace(/"/g, '""')}"`
        const rows = this.db.prepare(
          'SELECT id, bm25(memory_fts) AS rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?',
        ).all(phrase, limit) as Row[]
        for (const row of rows) results.set(text(row.id), Math.max(0, 0.5 - num(row.rank, 0) / 10))
      } catch {
        // Fall through to LIKE; a malformed FTS query must not break recall.
      }
    }
    const like = `%${clean.replace(/[%_]/g, '\\$&')}%`
    const rows = this.db.prepare(
      "SELECT id FROM memory_items WHERE content LIKE ? ESCAPE '\\' OR gist LIKE ? ESCAPE '\\' ORDER BY pinned DESC, updated_at DESC LIMIT ?",
    ).all(like, like, limit) as Row[]
    for (const row of rows) {
      const id = text(row.id)
      if (!results.has(id)) results.set(id, 0.45)
    }
    return [...results.entries()]
      .map(([id, rank]) => ({ id, rank }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit)
  }

  private activeRowsForVector(limit = MAX_VECTOR_SCAN, includeProposed = false): Row[] {
    const statuses = includeProposed ? "status IN ('confirmed','proposed')" : "status = 'confirmed'"
    return this.db.prepare(
      `SELECT * FROM memory_items WHERE ${statuses} AND (valid_to IS NULL OR valid_to > ?) AND embedding IS NOT NULL ORDER BY pinned DESC, updated_at DESC LIMIT ?`,
    ).all(this.at(), limit) as Row[]
  }

  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult> {
    const now = options.now ?? this.now()
    const queryType = classifyQuery(query)
    const limit = Math.max(1, Math.min(20, options.limit ?? 6))
    const effectiveOptions: RecallOptions = {
      ...options,
      includeProposed: options.includeProposed ?? this.tuning?.boolean('memory.includeProposed') ?? false,
    }
    const minVectorSimilarity = this.tuning?.number('memory.minVectorSimilarity') ?? MIN_VECTOR_SIMILARITY
    const lexicalThreshold = this.tuning?.number('memory.lexicalOverlap') ?? 0.34
    const candidates = new Map<string, { item: MemoryItem; semantic: number; why: string[] }>()

    const fts = this.searchFts(query, Math.max(30, limit * 6))
    for (const hit of fts) {
      const item = this.get(hit.id)
      if (item) candidates.set(item.id, { item, semantic: hit.rank, why: ['fts'] })
    }

    let queryVector: Float32Array | null = null
    try {
      queryVector = await this.embedder.embed(query)
    } catch (error) {
      this.logger?.warn('query embedding failed; using lexical recall', { error: String(error) })
    }
    if (queryVector) {
      for (const row of this.activeRowsForVector(MAX_VECTOR_SCAN, effectiveOptions.includeProposed)) {
        const item = this.rowToItem(row)
        if (item.sensitivity === 'secret' && !options.includeSensitive) continue
        const vector = this.embeddingOf(row)
        if (!vector) continue
        const semantic = Math.max(0, cosineSimilarity(queryVector, vector))
        const lexical = lexicallyRelated(query, item, lexicalThreshold)
        // Vector similarity is a useful gate for paraphrase, but an exact
        // lexical match must not be discarded just because the embedding model
        // scores a short Chinese question low. Keep either signal.
        if (semantic < minVectorSimilarity && !lexical) continue
        const existing = candidates.get(item.id)
        if (existing) {
          existing.semantic = Math.max(existing.semantic, semantic)
          if (semantic > 0.3) existing.why.push('vector')
          if (lexical) existing.why.push('lexical')
        } else {
          candidates.set(item.id, { item, semantic, why: [lexical ? 'lexical' : 'vector'] })
        }
      }
    }

    const pool = filterActive([...candidates.values()].map(value => value.item), effectiveOptions, now)
    if (pool.length === 0) {
      return {
        items: [],
        confidence: 0,
        why: ['no_candidate'],
        missing: [`没有找到与“${query}”相关的记忆。`],
        queryType,
      }
    }
    const scored: RecalledMemory[] = []
    for (const item of pool) {
      const candidate = candidates.get(item.id)
      const recalled = toRecalled(item, candidate?.semantic ?? 0.2, queryType, effectiveOptions, now)
      if (candidate?.why.includes('fts') && !recalled.why.includes('fts')) recalled.why.push('fts')
      scored.push(recalled)
    }
    scored.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
    const items = scored.slice(0, limit)
    if (this.tuning?.boolean('memory.markUsed') ?? true) this.markUsed(items.map(item => item.id))

    const confidence = confidenceFrom(items)
    const why = items.flatMap(item => item.why)
    const missing = items.length === 0 ? [`没有找到与“${query}”相关的记忆。`] : []
    this.bus?.emit('memory.recalled', { query, queryType, ids: items.map(item => item.id), confidence })
    return { items, confidence, why: [...new Set(why)], missing, queryType }
  }

  contextFor(items: RecalledMemory[], maxChars = 3000): string {
    return renderMemoryContext(items, maxChars)
  }

  markUsed(ids: string[]): void {
    if (ids.length === 0) return
    const at = this.at()
    const stmt = this.db.prepare('UPDATE memory_items SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
    for (const id of ids) stmt.run(at, id)
  }

  confirm(id: string): MemoryItem | null {
    const item = this.get(id)
    if (!item) return null
    this.db.prepare("UPDATE memory_items SET status = 'confirmed', trust = 'authoritative', updated_at = ? WHERE id = ?").run(this.at(), id)
    this.event(id, 'confirmed')
    return this.get(id)
  }

  reject(id: string): MemoryItem | null {
    const item = this.get(id)
    if (!item) return null
    this.db.prepare("UPDATE memory_items SET status = 'rejected', updated_at = ? WHERE id = ?").run(this.at(), id)
    this.event(id, 'rejected')
    return this.get(id)
  }

  async edit(id: string, content: string, gist?: string): Promise<MemoryItem | null> {
    const old = this.get(id)
    if (!old) return null
    const at = this.at()
    this.db.prepare("UPDATE memory_items SET status = 'superseded', valid_to = ?, updated_at = ? WHERE id = ?").run(at, at, id)
    this.event(id, 'superseded')
    return this.add({
      kind: old.kind,
      content,
      gist,
      sourceKind: 'user-confirmed',
      sourceRef: old.sourceRef,
      sourceSpan: old.sourceSpan,
      trust: 'authoritative',
      confidence: 1,
      importance: { ...old.importance, explicit: 1 },
      sensitivity: old.sensitivity,
      status: 'confirmed',
      supersedesId: old.id,
      pinned: old.pinned,
      retention: old.retention,
      expiresAt: old.expiresAt,
    })
  }

  delete(id: string): boolean {
    const item = this.get(id)
    if (!item) return false
    this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM memory_links WHERE from_id = ? OR to_id = ?').run(id, id)
    this.event(id, 'deleted')
    this.bus?.emit('memory.deleted', { id })
    return true
  }

  addEpisode(input: EpisodeInput): Episode {
    const episode: Episode = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: this.at(),
    }
    this.db.prepare(`
      INSERT INTO memory_episodes
        (id, started_at, ended_at, app, window, participants, summary, source_ref, sensitivity, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      episode.id,
      episode.startedAt,
      episode.endedAt,
      episode.app ?? '',
      episode.window ?? '',
      JSON.stringify(episode.participants ?? []),
      episode.summary,
      episode.sourceRef,
      episode.sensitivity ?? 'standard',
      episode.createdAt,
    )
    this.bus?.emit('memory.episode', { episode })
    return episode
  }

  listEpisodes(limit = 50): Episode[] {
    const rows = this.db.prepare('SELECT * FROM memory_episodes ORDER BY started_at DESC LIMIT ?').all(
      Math.max(1, Math.min(200, limit)),
    ) as Row[]
    return rows.map(row => ({
      id: text(row.id),
      startedAt: text(row.started_at),
      endedAt: text(row.ended_at),
      app: text(row.app),
      window: text(row.window),
      participants: JSON.parse(text(row.participants, '[]')) as string[],
      summary: text(row.summary),
      sourceRef: text(row.source_ref),
      sensitivity: text(row.sensitivity, 'standard') as MemorySensitivity,
      createdAt: text(row.created_at),
    }))
  }

  async consolidate(): Promise<ConsolidationStats> {
    const generation = this.eraseGeneration
    const started = Date.now()
    const at = this.at()
    const now = this.now().getTime()
    let expired = 0
    let expiredProposals = 0
    let deduped = 0
    let superseded = 0
    let embedded = 0
    let projected = 0

    const expiring = this.db.prepare(
      "SELECT id FROM memory_items WHERE retention = 'expires-at' AND expires_at IS NOT NULL AND expires_at <= ? AND status = 'confirmed'",
    ).all(at) as Row[]
    for (const row of expiring) {
      this.db.prepare("UPDATE memory_items SET status = 'expired', valid_to = ?, updated_at = ? WHERE id = ?").run(at, at, text(row.id))
      expired += 1
    }

    // A proposed memory is a suggestion, not a fact. If nobody confirmed or
    // rejected it for 30 days, retire it instead of letting the recall pool
    // fill with stale model guesses. The old row and event remain auditable.
    const proposalCutoff = new Date(this.now().getTime() - 30 * 86_400_000).toISOString()
    const staleProposals = this.db.prepare(
      "SELECT id FROM memory_items WHERE status = 'proposed' AND created_at <= ?",
    ).all(proposalCutoff) as Row[]
    for (const row of staleProposals) {
      this.db.prepare("UPDATE memory_items SET status = 'rejected', updated_at = ? WHERE id = ?").run(at, text(row.id))
      this.event(text(row.id), 'proposal_expired', '30d')
      expiredProposals += 1
    }

    // Follow explicit supersedes edges that may have arrived through import or
    // an older app version. The predecessor must never stay active beside its
    // replacement.
    const linked = this.db.prepare(
      "SELECT id, supersedes_id FROM memory_items WHERE supersedes_id IS NOT NULL AND status IN ('confirmed','proposed')",
    ).all() as Row[]
    for (const row of linked) {
      const oldId = text(row.supersedes_id)
      const old = this.get(oldId)
      if (!old || (old.status !== 'confirmed' && old.status !== 'proposed')) continue
      this.db.prepare("UPDATE memory_items SET status = 'superseded', valid_to = COALESCE(valid_to, ?), updated_at = ? WHERE id = ?").run(at, at, oldId)
      this.event(oldId, 'superseded', text(row.id))
      superseded += 1
    }

    const rows = this.db.prepare(
      "SELECT id, content, created_at FROM memory_items WHERE status = 'confirmed' ORDER BY created_at DESC, rowid DESC",
    ).all() as Row[]
    const seen = new Map<string, string>()
    for (const row of rows) {
      const content = normalizeContent(text(row.content)).toLowerCase()
      const existing = seen.get(content)
      if (existing) {
        // Rows are ordered newest first; keep the newest item and retire the
        // older duplicate, not the other way around.
        this.db.prepare("UPDATE memory_items SET status = 'superseded', valid_to = ?, supersedes_id = ?, updated_at = ? WHERE id = ?").run(
          at,
          existing,
          at,
          text(row.id),
        )
        this.event(text(row.id), 'deduped', existing)
        deduped += 1
      } else {
        seen.set(content, text(row.id))
      }
    }

    // Repair vectors for imported or degraded rows. This is deliberately
    // bounded so consolidation never turns into an unbounded model job.
    const embedderIsLocal = (this.embedder as { isLocal?: boolean }).isLocal === true
    const missingVectors = this.db.prepare(
      "SELECT * FROM memory_items WHERE status IN ('confirmed','proposed') AND embedding IS NULL LIMIT 100",
    ).all() as Row[]
    for (const row of missingVectors) {
      const item = this.rowToItem(row)
      if (item.sensitivity !== 'standard' && !embedderIsLocal) continue
      try {
        const vector = await this.embedder.embed(`${item.gist}\n${item.content}`)
        if (generation !== this.eraseGeneration) throw new Error('Consolidation cancelled by privacy erase')
        if (vector) {
          this.db.prepare('UPDATE memory_items SET embedding = ? WHERE id = ?').run(encodeEmbedding(vector), item.id)
          embedded += 1
        }
      } catch (error) {
        if (generation !== this.eraseGeneration) throw error
        this.logger?.warn('consolidation embedding failed', { id: item.id, error: String(error) })
      }
    }

    for (const row of this.db.prepare("SELECT id FROM memory_items WHERE status IN ('confirmed','proposed')").all() as Row[]) {
      const id = text(row.id)
      const item = this.get(id)
      if (item) this.ftsUpsert(item)
      projected += 1
    }

    // Keep the token budget honest: old, low-value, unpinned items naturally
    // rank lower because strength decays; we do not destroy them.
    void now
    const stats = { expired, expiredProposals, deduped, superseded, embedded, projected, durationMs: Date.now() - started }
    this.bus?.emit('memory.consolidated', stats)
    return stats
  }

  link(fromId: string, toId: string, relation = 'related', weight = 0.8): void {
    if (fromId === toId || !this.get(fromId) || !this.get(toId)) return
    this.db.prepare(
      `INSERT INTO memory_links (from_id, to_id, relation, weight, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(from_id, to_id, relation) DO UPDATE SET weight = excluded.weight`,
    ).run(fromId, toId, relation, Math.max(0.05, Math.min(1, weight)), this.at())
    this.bus?.emit('memory.linked', { fromId, toId, relation, weight })
  }

  graph(limit = 140): {
    nodes: Array<{
      id: string; gist: string; content: string; kind: MemoryKind; status: MemoryStatus;
      sensitivity: MemorySensitivity; trust: string; confidence: number; importance: number;
      importanceDetail: { goal: number; novelty: number; social: number; repetition: number; explicit: number; deadline: number };
      score: number; pinned: boolean; createdAt: string; updatedAt: string; validFrom: string; validTo: string | null; useCount: number;
      sourceKind: string; sourceRef: string; supersedesId: string | null; embedded: boolean;
      degree: number;
    }>
    edges: Array<{ source: string; target: string; type: 'supersedes' | 'similar' | 'link'; weight: number }>
    counts: Record<string, number>
    generatedAt: string
  } {
    const cap = Math.max(10, Math.min(200, limit))
    const rows = this.db.prepare(
      'SELECT * FROM memory_items ORDER BY pinned DESC, updated_at DESC LIMIT ?',
    ).all(cap) as Row[]
    const items = rows.map(row => this.rowToItem(row))
    const vectors = new Map<string, Float32Array | null>()
    for (const row of rows) vectors.set(text(row.id), this.embeddingOf(row))
    const nodes = items.map(item => ({
      id: item.id,
      gist: item.gist,
      content: item.content.slice(0, 4000),
      kind: item.kind,
      status: item.status,
      sensitivity: item.sensitivity,
      trust: item.trust,
      confidence: item.confidence,
      importance: Number(importanceScore(item.importance).toFixed(3)),
      importanceDetail: { ...item.importance },
      score: Number((importanceScore(item.importance) * 0.65 + item.confidence * 0.35).toFixed(3)),
      pinned: item.pinned,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      validFrom: item.validFrom,
      validTo: item.validTo,
      useCount: item.useCount,
      sourceKind: item.sourceKind,
      sourceRef: item.sourceRef,
      supersedesId: item.supersedesId,
      embedded: vectors.get(item.id) !== null,
      degree: 0,
    }))
    const byId = new Map(nodes.map(node => [node.id, node]))
    const edges: Array<{ source: string; target: string; type: 'supersedes' | 'similar' | 'link'; weight: number }> = []
    const seen = new Set<string>()
    const addEdge = (source: string, target: string, type: 'supersedes' | 'similar' | 'link', weight: number): void => {
      if (!byId.has(source) || !byId.has(target) || source === target) return
      const key = `${source}:${target}:${type}`
      if (seen.has(key)) return
      seen.add(key)
      edges.push({ source, target, type, weight: Number(Math.max(0.05, Math.min(1, weight)).toFixed(3)) })
      const a = byId.get(source)
      const b = byId.get(target)
      if (a) a.degree += 1
      if (b) b.degree += 1
    }

    for (const node of nodes) {
      if (node.supersedesId) addEdge(node.id, node.supersedesId, 'supersedes', 1)
    }
    const linkRows = this.db.prepare('SELECT from_id, to_id, relation, weight FROM memory_links').all() as Row[]
    for (const row of linkRows) addEdge(text(row.from_id), text(row.to_id), 'link', num(row.weight, 0.8))

    // Local embedding cosine + a lexical fallback for unembedded memories.
    const pairLimit = nodes.length
    const similar: Array<{ a: string; b: string; weight: number }> = []
    for (let i = 0; i < pairLimit; i += 1) {
      for (let j = i + 1; j < pairLimit; j += 1) {
        const a = nodes[i]
        const b = nodes[j]
        const va = vectors.get(a.id)
        const vb = vectors.get(b.id)
        let score = 0
        if (va && vb) score = Math.max(0, cosineSimilarity(va, vb))
        else {
          const setA = new Set([...`${a.gist}${a.content}`].slice(0, 160))
          const setB = new Set([...`${b.gist}${b.content}`].slice(0, 160))
          if (setA.size && setB.size) {
            let overlap = 0
            for (const char of setA) if (setB.has(char)) overlap += 1
            score = overlap / Math.min(setA.size, setB.size)
          }
        }
        if (score >= 0.58) similar.push({ a: a.id, b: b.id, weight: score })
      }
    }
    similar.sort((left, right) => right.weight - left.weight)
    const perNode = new Map<string, number>()
    for (const candidate of similar) {
      if (edges.length >= 320) break
      const countA = perNode.get(candidate.a) ?? 0
      const countB = perNode.get(candidate.b) ?? 0
      if (countA >= 3 || countB >= 3) continue
      perNode.set(candidate.a, countA + 1)
      perNode.set(candidate.b, countB + 1)
      addEdge(candidate.a, candidate.b, 'similar', candidate.weight)
    }

    const counts: Record<string, number> = {}
    for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1
    return { nodes, edges, counts, generatedAt: this.at() }
  }

  stats(): MemoryStats {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END) AS proposed,
        SUM(CASE WHEN sensitivity != 'standard' THEN 1 ELSE 0 END) AS sensitive,
        SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
      FROM memory_items
    `).get() as Row
    const episodes = this.db.prepare('SELECT COUNT(*) AS n FROM memory_episodes').get() as Row
    return {
      total: num(row.total),
      confirmed: num(row.confirmed),
      proposed: num(row.proposed),
      sensitive: num(row.sensitive),
      embedded: num(row.embedded),
      episodes: num(episodes.n),
    }
  }

  eraseAll(): { items: number; episodes: number; reminders: number; links: number; events: number } {
    this.eraseGeneration++
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Record<string, unknown>
      return num(row.n)
    }
    const result = {
      items: count('memory_items'),
      episodes: count('memory_episodes'),
      reminders: count('reminders'),
      links: count('memory_links'),
      events: count('memory_events'),
    }
    this.db.exec(`
      DELETE FROM memory_links;
      DELETE FROM memory_events;
      DELETE FROM memory_entities;
      DELETE FROM memory_fts;
      DELETE FROM memory_items;
      DELETE FROM memory_episodes;
      DELETE FROM reminders;
    `)
    this.db.exec('VACUUM')
    // VACUUM rewrites the database, but the write-ahead log can still hold the
    // old pages until it is truncated.
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* not in WAL mode */ }
    this.bus?.emit('memory.erased', result)
    return result
  }

  exportAll(): { version: 2; exportedAt: string; items: MemoryItem[]; episodes: Episode[] } {
    // Export is a user-requested full copy: never route it through the
    // paginated UI queries, which silently stop at 200 rows.
    const items = (this.db.prepare('SELECT * FROM memory_items ORDER BY updated_at DESC').all() as Row[])
      .map(row => this.rowToItem(row))
    const episodes = (this.db.prepare('SELECT * FROM memory_episodes ORDER BY started_at DESC').all() as Row[])
      .map(row => ({
        id: text(row.id),
        startedAt: text(row.started_at),
        endedAt: text(row.ended_at),
        app: text(row.app),
        window: text(row.window),
        participants: JSON.parse(text(row.participants, '[]')) as string[],
        summary: text(row.summary),
        sourceRef: text(row.source_ref),
        sensitivity: text(row.sensitivity, 'standard') as MemorySensitivity,
        createdAt: text(row.created_at),
      }))
    return { version: 2, exportedAt: this.at(), items, episodes }
  }

  migrateV1(file: string): { imported: number; skipped: number } {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { items?: Array<Record<string, unknown>> }
    const items = Array.isArray(raw.items) ? raw.items : []
    let imported = 0
    let skipped = 0
    for (const legacy of items) {
      const content = normalizeContent(String(legacy.content ?? ''))
      if (!content) {
        skipped += 1
        continue
      }
      const kind: MemoryKind = legacy.class === 'episodic' ? 'episodic' : 'semantic'
      const createdAt = String(legacy.createdAt ?? this.at())
      const id = String(legacy.id ?? randomUUID())
      if (this.get(id)) {
        skipped += 1
        continue
      }
      const item: MemoryItem = {
        id,
        ownerId: 'local-owner',
        kind,
        content,
        gist: gistOf(content),
        sourceKind: 'v1-import',
        sourceRef: `v1-import:${id}`,
        sourceSpan: '',
        trust: 'high',
        confidence: num(legacy.confidence, 0.9),
        importance: { ...emptyImportance(), explicit: 0.9 },
        sensitivity: legacy.sensitivity === 'sensitive' ? 'sensitive' : 'standard',
        validFrom: String(legacy.confirmedAt ?? createdAt),
        validTo: null,
        createdAt,
        updatedAt: createdAt,
        lastUsedAt: null,
        useCount: 0,
        status: 'confirmed',
        supersedesId: null,
        pinned: false,
        retention: 'until-deleted',
        expiresAt: null,
      }
      this.insertItem(item, null)
      this.event(id, 'imported', 'v1')
      imported += 1
    }
    return { imported, skipped }
  }

  close(): void {
    this.db.close()
  }

  // Exposed for tests and for the consolidation worker.
  importanceOf(item: MemoryItem): number {
    return importanceScore(item.importance)
  }

  active(item: MemoryItem, now = this.now()): boolean {
    return isActive(item, now)
  }
}