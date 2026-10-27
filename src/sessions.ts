import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type MessageStatus = 'streaming' | 'complete' | 'cancelled' | 'error';
export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  messageCount: number;
  preview: string;
}
export interface SessionMessage {
  /** Globally increasing database sequence; also the messages() pagination cursor. */
  id: number;
  sessionId: string;
  turnId: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  createdAt: number;
  updatedAt: number;
  source: string;
  scenario: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
}
export interface SessionStoreOptions { file: string; now?: () => number }
export interface SessionListOptions { query?: string; limit?: number; offset?: number; archived?: boolean }
export interface MessageListOptions { before?: number; limit?: number }
export interface FinishTurnOptions {
  text?: string;
  status: 'complete' | 'cancelled' | 'error';
  error?: string;
  metadata?: Record<string, unknown>;
}
export interface TurnMessages { user: SessionMessage; assistant: SessionMessage }
export interface SessionExport { version: 1; sessions: Array<Session & { messages: SessionMessage[] }> }

export class SessionStoreError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT';
  readonly statusCode: 404 | 409;
  constructor(code: 'NOT_FOUND' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'SessionStoreError';
    this.code = code;
    this.statusCode = code === 'NOT_FOUND' ? 404 : 409;
  }
}

type Row = Record<string, unknown>;
const UNTITLED = '新会话';
const MAX_TEXT = 1_000_000;
const SESSION_SELECT = `SELECT s.id, s.title, s.created_at, s.updated_at, s.archived,
  (SELECT count(*) FROM messages m WHERE m.session_id=s.id) AS message_count,
  coalesce((SELECT substr(content,1,160) FROM messages m WHERE m.session_id=s.id AND content<>'' ORDER BY id DESC LIMIT 1),'') AS preview
  FROM sessions s`;

function text(value: unknown, name: string, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\0')) {
    throw new TypeError(`${name} must be ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${max} characters without NUL`);
  }
}
function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function session(row: Row): Session {
  return { id: String(row.id), title: String(row.title), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    archived: Boolean(row.archived), messageCount: Number(row.message_count), preview: String(row.preview) };
}
function message(row: Row): SessionMessage {
  return { id: Number(row.id), sessionId: String(row.session_id), turnId: String(row.turn_id), role: row.role as SessionMessage['role'],
    content: String(row.content), status: row.status as MessageStatus, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    source: String(row.source), scenario: row.scenario as string | null, error: row.error as string | null,
    metadata: row.metadata === null ? null : JSON.parse(String(row.metadata)) as Record<string, unknown> };
}

/**
 * Synchronous transcript store. Pass {file: '/private/path/sessions.db', now?: () => epochMilliseconds}.
 * Use a dedicated database and one owning instance: opening it recovers all unfinished turns.
 * Missing get() returns undefined; missing mutation targets throw. delete() returns whether it existed.
 * list() includes archived sessions unless archived is specified; defaults limit=50, offset=0 (max limit=500).
 * messages() returns the newest page before an exclusive numeric message id, ordered oldest first.
 * context() preserves whole successful pairs within both budgets, newest pairs first selected, chronological returned.
 * Exact beginTurn retries return the existing pair, including finished turns; mismatches throw.
 * appendDelta is append-only (callers must deduplicate transport events). Finished turns cannot be changed.
 * No summary or memory database is imported. exportAll() returns {version:1,sessions:[{...session,messages}]}.
 */
export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private closed = false;

  constructor(options: SessionStoreOptions) {
    text(options.file, 'file', 4096);
    this.now = options.now ?? Date.now;
    const file = options.file === ':memory:' ? options.file : resolve(options.file);
    if (file !== ':memory:') {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      try { closeSync(openSync(file, 'wx', 0o600)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('Session database must be a regular file');
      chmodSync(file, 0o600);
    }
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;');
      this.migrate();
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        const at = this.timestamp();
        this.db.prepare(`UPDATE sessions SET updated_at=max(updated_at,?) WHERE id IN
          (SELECT session_id FROM messages WHERE status='streaming')`).run(at);
        this.db.prepare(`UPDATE messages SET status='error', error='Interrupted before completion', updated_at=max(updated_at,?) WHERE status='streaming'`).run(at);
      });
      if (file !== ':memory:') {
        for (const suffix of ['', '-wal', '-shm']) {
          try { chmodSync(file + suffix, 0o600); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
    } catch (error) { this.db.close(); throw error; }
  }

  private migrate(): void {
    this.transaction(() => {
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version === 1) return;
      if (version !== 0) throw new Error(`Unsupported sessions database version: ${version}`);
      if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) {
        throw new Error('Refusing to adopt an existing non-session database');
      }
      this.db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, title_explicit INTEGER NOT NULL DEFAULT 0 CHECK(title_explicit IN (0,1)),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          turn_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('streaming','complete','cancelled','error')),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL, scenario TEXT, error TEXT, metadata TEXT,
          UNIQUE(turn_id,role)
        );
        CREATE INDEX sessions_updated ON sessions(updated_at DESC,id);
        CREATE INDEX sessions_archived_updated ON sessions(archived,updated_at DESC,id);
        CREATE INDEX messages_session_id ON messages(session_id,id);
        CREATE INDEX messages_status ON messages(status);
        PRAGMA user_version=1;
      `);
    });
  }
  private timestamp(): number { return integer(this.now(), 'now()', 0, Number.MAX_SAFE_INTEGER); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private requireSession(id: string): Session {
    const found = this.get(id);
    if (!found) throw new SessionStoreError('NOT_FOUND', `Session not found: ${id}`);
    return found;
  }
  private touch(id: string, at: number): void {
    this.db.prepare('UPDATE sessions SET updated_at=max(updated_at,?) WHERE id=?').run(at, id);
  }
  private pair(turnId: string): TurnMessages | undefined {
    text(turnId, 'turnId', 256);
    const rows = this.db.prepare('SELECT * FROM messages WHERE turn_id=? ORDER BY id').all(turnId);
    if (!rows.length) return undefined;
    if (rows.length !== 2 || rows[0].role !== 'user' || rows[1].role !== 'assistant') throw new Error('Corrupt turn pair');
    return { user: message(rows[0]), assistant: message(rows[1]) };
  }
  private requirePair(turnId: string): TurnMessages {
    const pair = this.pair(turnId);
    if (!pair) throw new SessionStoreError('NOT_FOUND', `Turn not found: ${turnId}`);
    return pair;
  }

  create(title?: string): Session {
    if (title !== undefined) text(title, 'title', 200);
    return this.insertSession(randomUUID(), title);
  }
  private insertSession(id: string, title?: string): Session {
    const at = this.timestamp();
    this.db.prepare('INSERT INTO sessions(id,title,title_explicit,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(id, title?.trim() ?? UNTITLED, title === undefined ? 0 : 1, at, at);
    return this.requireSession(id);
  }
  /** Stable legacy conversation, recreated after deletion or clearAll(). */
  getOrCreateDefault(): Session {
    return this.transaction(() => this.get('default') ?? this.insertSession('default'));
  }
  get(id: string): Session | undefined {
    text(id, 'sessionId', 256);
    const row = this.db.prepare(`${SESSION_SELECT} WHERE s.id=?`).get(id);
    return row ? session(row) : undefined;
  }
  list(options: SessionListOptions = {}): { items: Session[]; total: number } {
    const limit = integer(options.limit ?? 50, 'limit', 1, 500);
    const offset = integer(options.offset ?? 0, 'offset', 0, Number.MAX_SAFE_INTEGER);
    if (options.query !== undefined) text(options.query, 'query', 1000, true);
    if (options.archived !== undefined && typeof options.archived !== 'boolean') throw new TypeError('archived must be boolean');
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.archived !== undefined) { clauses.push('s.archived=?'); params.push(Number(options.archived)); }
    if (options.query) {
      const pattern = `%${options.query.replace(/[\\%_]/g, '\\$&')}%`;
      clauses.push(`(s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id=s.id AND m.content LIKE ? ESCAPE '\\'))`);
      params.push(pattern, pattern);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.transaction(() => ({
      items: this.db.prepare(`${SESSION_SELECT}${where} ORDER BY s.updated_at DESC,s.id LIMIT ? OFFSET ?`).all(...params, limit, offset).map(session),
      total: Number(this.db.prepare(`SELECT count(*) AS total FROM sessions s${where}`).get(...params)!.total),
    }));
  }
  rename(id: string, title: string): Session {
    text(title, 'title', 200);
    this.requireSession(id);
    this.db.prepare('UPDATE sessions SET title=?,title_explicit=1,updated_at=max(updated_at,?) WHERE id=?').run(title.trim(), this.timestamp(), id);
    return this.requireSession(id);
  }
  setArchived(id: string, archived: boolean): Session {
    if (typeof archived !== 'boolean') throw new TypeError('archived must be boolean');
    this.requireSession(id);
    this.db.prepare('UPDATE sessions SET archived=?,updated_at=max(updated_at,?) WHERE id=?').run(Number(archived), this.timestamp(), id);
    return this.requireSession(id);
  }
  delete(id: string): boolean {
    text(id, 'sessionId', 256);
    return this.db.prepare('DELETE FROM sessions WHERE id=?').run(id).changes > 0;
  }
  /** Deletes transcripts and checkpoints/truncates WAL; cannot erase external backups or filesystem snapshots. */
  clearAll(): void {
    this.transaction(() => { this.db.exec('DELETE FROM sessions'); });
    const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint && Number(checkpoint.busy)) throw new Error('Sessions erased, but WAL checkpoint is busy; close other database readers and retry clearAll');
    this.db.exec('VACUUM');
    const final = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (final && Number(final.busy)) throw new Error('Sessions erased, but final WAL checkpoint is busy');
  }
  /** Direct lookup for callers checking an idempotency key before starting work. */
  getTurn(turnId: string): TurnMessages | undefined { return this.pair(turnId); }
  exportSession(id: string): Session & { messages: SessionMessage[] } {
    return this.transaction(() => ({
      ...this.requireSession(id),
      messages: this.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all(id).map(message),
    }));
  }
  exportAll(): SessionExport {
    return this.transaction(() => ({ version: 1, sessions: this.db.prepare(`${SESSION_SELECT} ORDER BY s.created_at,s.id`).all().map(row => ({
      ...session(row), messages: this.db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id').all(String(row.id)).map(message),
    })) }));
  }
  beginTurn(sessionId: string, turnId: string, content: string, source: string, scenario?: string): TurnMessages {
    text(sessionId, 'sessionId', 256); text(turnId, 'turnId', 256); text(content, 'text', MAX_TEXT);
    text(source, 'source', 100); if (scenario !== undefined) text(scenario, 'scenario', 200);
    return this.transaction(() => {
      this.requireSession(sessionId);
      const existing = this.pair(turnId);
      if (existing) {
        const user = existing.user;
        if (user.sessionId !== sessionId || user.content !== content || user.source !== source || user.scenario !== (scenario ?? null)) {
          throw new SessionStoreError('CONFLICT', 'turnId already belongs to a different payload or session');
        }
        return existing;
      }
      const at = this.timestamp();
      const insert = this.db.prepare(`INSERT INTO messages(session_id,turn_id,role,content,status,created_at,updated_at,source,scenario) VALUES(?,?,?,?,?,?,?,?,?)`);
      insert.run(sessionId, turnId, 'user', content, 'complete', at, at, source, scenario ?? null);
      insert.run(sessionId, turnId, 'assistant', '', 'streaming', at, at, source, scenario ?? null);
      const title = content.trim().replace(/\s+/g, ' ').slice(0, 80) || UNTITLED;
      this.db.prepare(`UPDATE sessions SET title=? WHERE id=? AND title_explicit=0
        AND (SELECT count(*) FROM messages WHERE session_id=?)=2`).run(title, sessionId, sessionId);
      this.touch(sessionId, at);
      return this.requirePair(turnId);
    });
  }
  appendDelta(turnId: string, delta: string): SessionMessage {
    text(delta, 'delta', MAX_TEXT, true);
    return this.transaction(() => {
      const { assistant } = this.requirePair(turnId);
      if (assistant.status !== 'streaming') throw new SessionStoreError('CONFLICT', 'Turn is already finished');
      if (assistant.content.length + delta.length > MAX_TEXT) throw new RangeError('Assistant text exceeds maximum length');
      const at = this.timestamp();
      this.db.prepare('UPDATE messages SET content=content||?,updated_at=max(updated_at,?) WHERE id=?').run(delta, at, assistant.id);
      this.touch(assistant.sessionId, at);
      return this.requirePair(turnId).assistant;
    });
  }
  finishTurn(turnId: string, options: FinishTurnOptions): SessionMessage {
    if (!['complete', 'cancelled', 'error'].includes(options.status)) throw new TypeError('Invalid final status');
    if (options.text !== undefined) text(options.text, 'text', MAX_TEXT, true);
    if (options.error !== undefined) text(options.error, 'error', 10_000, true);
    let metadata: string | null = null;
    if (options.metadata !== undefined) {
      if (!options.metadata || typeof options.metadata !== 'object' || Array.isArray(options.metadata)) throw new TypeError('metadata must be a JSON object');
      metadata = JSON.stringify(options.metadata);
      text(metadata, 'metadata', 100_000);
      const parsed: unknown = JSON.parse(metadata);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('metadata must serialize as a JSON object');
    }
    return this.transaction(() => {
      const { assistant } = this.requirePair(turnId);
      if (assistant.status !== 'streaming') {
        if (assistant.status === options.status && (options.text === undefined || options.text === assistant.content)
          && (options.error === undefined || options.error === assistant.error)
          && (options.metadata === undefined || metadata === JSON.stringify(assistant.metadata))) return assistant;
        throw new SessionStoreError('CONFLICT', 'Turn is already finished');
      }
      const at = this.timestamp();
      this.db.prepare('UPDATE messages SET content=?,status=?,error=?,metadata=?,updated_at=max(updated_at,?) WHERE id=?')
        .run(options.text ?? assistant.content, options.status, options.error ?? null, metadata, at, assistant.id);
      this.touch(assistant.sessionId, at);
      return this.requirePair(turnId).assistant;
    });
  }
  messages(sessionId: string, options: MessageListOptions = {}): { items: SessionMessage[]; hasMore: boolean } {
    this.requireSession(sessionId);
    const limit = integer(options.limit ?? 50, 'limit', 1, 500);
    const before = integer(options.before ?? Number.MAX_SAFE_INTEGER, 'before', 1, Number.MAX_SAFE_INTEGER);
    const rows = this.db.prepare('SELECT * FROM messages WHERE session_id=? AND id<? ORDER BY id DESC LIMIT ?').all(sessionId, before, limit + 1);
    return { items: rows.slice(0, limit).reverse().map(message), hasMore: rows.length > limit };
  }
  context(sessionId: string, maxMessages: number, maxChars = MAX_TEXT): SessionMessage[] {
    this.requireSession(sessionId);
    integer(maxMessages, 'maxMessages', 0, 10_000); integer(maxChars, 'maxChars', 0, 10_000_000);
    if (maxMessages < 2 || maxChars === 0) return [];
    const rows = this.db.prepare(`SELECT u.id AS user_id,a.id AS assistant_id FROM messages u JOIN messages a ON a.turn_id=u.turn_id AND a.role='assistant'
      WHERE u.session_id=? AND a.session_id=? AND u.role='user' AND u.status='complete' AND a.status='complete'
       AND coalesce(json_extract(a.metadata,'$.contextExcluded'),0)<>1
      ORDER BY u.id DESC LIMIT ?`).all(sessionId, sessionId, Math.floor(maxMessages / 2));
    const pairs: SessionMessage[][] = [];
    let chars = 0;
    const select = this.db.prepare('SELECT * FROM messages WHERE id=?');
    for (const row of rows) {
      const user = message(select.get(Number(row.user_id))!);
      const assistant = message(select.get(Number(row.assistant_id))!);
      if (assistant.metadata?.contextExcluded === true) continue;
      const size = user.content.length + assistant.content.length;
      if (chars + size > maxChars) break;
      pairs.push([user, assistant]); chars += size;
    }
    return pairs.reverse().flat();
  }
  /** Retain visible evidence while preventing a corrected source from replaying into prompts. */
  excludeTurnFromContext(turnId: string): void {
    this.db.prepare("UPDATE messages SET metadata=json_set(coalesce(metadata,'{}'),'$.contextExcluded',json('true')) WHERE turn_id=? AND role='assistant'").run(turnId);
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
