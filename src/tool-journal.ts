import type { DatabaseSync } from 'node:sqlite';
import { SessionStore, SessionStoreError } from './sessions.ts';

export type ToolCallStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'unknown';
export interface ToolCallRecord {
  id: number; sessionId: string; turnId: string; step: number; callId: string; name: string;
  /** Canonical JSON. Secret removal is the caller's responsibility. */
  args: string; definitionHash: string; status: ToolCallStatus; content: string;
  errorCode?: string; localOnly: boolean; approval?: unknown;
  createdAt: number; updatedAt: number; finishedAt?: number;
}
export interface JournalToolCall { id: string; name: string; arguments: string }
export type JournalMessage = { role: 'assistant'; content: string; toolCalls?: JournalToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };
interface Key { sessionId: string; turnId: string }
interface StepKey extends Key { step: number }
export interface StartCallInput extends StepKey {
  callId: string; name: string; args: unknown; definitionHash: string; localOnly: boolean;
}
export interface FinishCallInput extends Key {
  callId: string; status: Exclude<ToolCallStatus, 'pending' | 'running'>;
  content: string; errorCode?: string; localOnly: boolean;
}
const MAX_JSON = 100_000;
function text(value: unknown, name: string, max = 256, empty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) {
    throw new TypeError(`${name} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters without NUL`);
  }
}
/** Sort object keys recursively; reject lossy/non-JSON values and bound both depth and encoded size. */
function canonical(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > MAX_JSON || depth > 64) throw new RangeError('JSON metadata exceeds complexity limit');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') { text(item, 'JSON string', MAX_JSON, true); return item; }
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || seen.has(item)) throw new TypeError('Metadata must be acyclic JSON');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError('Metadata must contain plain JSON objects');
    }
    seen.add(item);
    const result = Array.isArray(item) ? Array.from(item, value => visit(value, depth + 1))
      : Object.fromEntries(Object.keys(item).sort().map(key => [key, visit((item as Record<string, unknown>)[key], depth + 1)]));
    seen.delete(item);
    return result;
  }
  const result = JSON.stringify(visit(value, 0));
  text(result, 'JSON metadata', MAX_JSON);
  return result;
}
function record(row: Record<string, unknown>): ToolCallRecord {
  return {
    id: Number(row.id), sessionId: String(row.session_id), turnId: String(row.turn_id), step: Number(row.step),
    callId: String(row.call_id), name: String(row.name), args: String(row.args), definitionHash: String(row.definition_hash),
    status: row.status as ToolCallStatus, content: String(row.content), localOnly: Boolean(row.local_only),
    ...(row.error_code === null ? {} : { errorCode: String(row.error_code) }),
    ...(row.approval === null ? {} : { approval: JSON.parse(String(row.approval)) as unknown }),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    ...(row.finished_at === null ? {} : { finishedAt: Number(row.finished_at) }),
  };
}

/** One journal per owning SessionStore, constructed at startup before dispatch begins.
 * Recovery never retries operations. Every existing call key, including unknown, blocks dispatch.
 * Request payloads and localOnly records are private storage, never automatically cloud context.
 */
export class ToolJournal {
  private readonly db: DatabaseSync;
  private readonly sessions: SessionStore;
  constructor(sessions: SessionStore) {
    this.sessions = sessions;
    this.db = sessions.databaseForTools();
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT DISTINCT session_id,turn_id FROM tool_steps').all()) {
        this.reconcileTurn(String(row.session_id), String(row.turn_id));
      }
    });
  }
  /** Call after runtime work settles. Never dispatches: undispatched proposals become cancelled,
   * unfinished dispatched calls become unknown, and existing terminal records stay immutable. */
  closeTurn(sessionId: string, turnId: string): void {
    this.key({ sessionId, turnId });
    this.transaction(() => this.reconcileTurn(sessionId, turnId));
  }
  private reconcileTurn(sessionId: string, turnId: string): void {
    const at = Date.now();
    const steps = this.db.prepare('SELECT * FROM tool_steps WHERE session_id=? AND turn_id=? ORDER BY step').all(sessionId, turnId);
    for (const step of steps) {
      let interrupted = step.status === 'running';
      const calls = step.tool_calls === null ? [] : JSON.parse(String(step.tool_calls)) as JournalToolCall[];
      for (const call of calls) {
        const existing = this.getCall(sessionId, turnId, call.id);
        if (existing) {
          if (existing.status === 'running' || existing.status === 'pending') interrupted = true;
          continue;
        }
        interrupted = true;
        let args: string;
        try { args = canonical(JSON.parse(call.arguments) as unknown); }
        catch {
          // Raw provider arguments already fit inside the bounded canonical tool_calls array.
          args = canonical(call.arguments);
        }
        const stamp = Math.max(at, Number(step.updated_at));
        this.db.prepare(`INSERT INTO tool_calls(session_id,turn_id,step,call_id,name,args,definition_hash,status,
          content,error_code,local_only,created_at,updated_at,finished_at)
          VALUES(?,?,?,?,?,?,'unavailable','cancelled','Tool was not started. No operation was dispatched.',
            'TOOL_NOT_STARTED',1,?,?,?)`)
          .run(sessionId, turnId, Number(step.step), call.id, call.name, args, Number(step.created_at), stamp, stamp);
      }
      if (interrupted) this.db.prepare(`UPDATE tool_steps SET status='failed',updated_at=max(updated_at,?)
        WHERE session_id=? AND turn_id=? AND step=?`).run(at, sessionId, turnId, Number(step.step));
    }
    this.db.prepare(`UPDATE tool_calls SET status='unknown', error_code='INTERRUPTED',
      content='Operation interrupted; outcome unknown. Do not retry automatically.',
      updated_at=max(updated_at,?), finished_at=max(updated_at,?)
      WHERE session_id=? AND turn_id=? AND status IN ('pending','running')`).run(at, at, sessionId, turnId);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private key(input: Key): void { text(input.sessionId, 'sessionId'); text(input.turnId, 'turnId'); }
  private step(input: StepKey): void {
    this.key(input);
    if (!Number.isSafeInteger(input.step) || input.step < 0) throw new RangeError('step must be a nonnegative safe integer');
  }
  beginStep(input: StepKey & { requestMessages?: unknown; tools?: unknown }): void {
    this.step(input);
    const request = input.requestMessages === undefined ? null : canonical(input.requestMessages);
    const tools = input.tools === undefined ? null : canonical(input.tools);
    const pair = this.sessions.getTurn(input.turnId);
    if (!pair || pair.user.sessionId !== input.sessionId) throw new SessionStoreError('NOT_FOUND', 'Journal turn not found in session');
    const at = Date.now();
    this.db.prepare(`INSERT INTO tool_steps(session_id,turn_id,step,status,request_messages,tools,created_at,updated_at)
      VALUES(?,?,?,'running',?,?,?,?) ON CONFLICT(session_id,turn_id,step) DO NOTHING`)
      .run(input.sessionId, input.turnId, input.step, request, tools, at, at);
  }
  recordAssistant(input: StepKey & { text: string; toolCalls: JournalToolCall[] }): void {
    this.step(input); text(input.text, 'assistant text', 1_000_000, true);
    if (!Array.isArray(input.toolCalls)) throw new TypeError('toolCalls must be an array');
    const ids = new Set<string>();
    for (const call of input.toolCalls) {
      text(call.id, 'callId'); text(call.name, 'name'); text(call.arguments, 'arguments', MAX_JSON, true);
      if (ids.has(call.id)) throw new TypeError('Duplicate assistant call ID');
      ids.add(call.id);
    }
    const calls = canonical(input.toolCalls);
    const changed = this.db.prepare(`UPDATE tool_steps SET assistant_text=?,tool_calls=?,status='complete',updated_at=max(updated_at,?)
      WHERE session_id=? AND turn_id=? AND step=? AND status='running' AND assistant_text IS NULL`)
      .run(input.text, calls, Date.now(), input.sessionId, input.turnId, input.step).changes;
    if (!changed) {
      const existing = this.db.prepare('SELECT assistant_text,tool_calls FROM tool_steps WHERE session_id=? AND turn_id=? AND step=?')
        .get(input.sessionId, input.turnId, input.step);
      if (!existing || existing.assistant_text !== input.text || existing.tool_calls !== calls) throw new SessionStoreError('CONFLICT', 'Journal step missing or immutable');
    }
  }
  startCall(input: StartCallInput): { record: ToolCallRecord; created: boolean } {
    this.step(input); text(input.callId, 'callId');
    return this.transaction(() => {
      const existing = this.getCall(input.sessionId, input.turnId, input.callId);
      if (existing) return { record: existing, created: false };
      text(input.name, 'name'); text(input.definitionHash, 'definitionHash', 4096);
      if (typeof input.localOnly !== 'boolean') throw new TypeError('localOnly must be boolean');
      const args = canonical(input.args);
      const step = this.db.prepare('SELECT status,tool_calls FROM tool_steps WHERE session_id=? AND turn_id=? AND step=?')
        .get(input.sessionId, input.turnId, input.step);
      if (!step || step.status !== 'complete') throw new SessionStoreError('CONFLICT', 'Record assistant request before dispatch');
      const calls = JSON.parse(String(step.tool_calls)) as JournalToolCall[];
      if (!calls.some(call => call.id === input.callId && call.name === input.name)) throw new SessionStoreError('CONFLICT', 'Call not in assistant request');
      const at = Date.now();
      this.db.prepare(`INSERT INTO tool_calls(session_id,turn_id,step,call_id,name,args,definition_hash,status,local_only,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'running',?,?,?)`)
        .run(input.sessionId, input.turnId, input.step, input.callId, input.name, args, input.definitionHash, Number(input.localOnly), at, at);
      return { record: this.getCall(input.sessionId, input.turnId, input.callId)!, created: true };
    });
  }
  finishCall(input: FinishCallInput): ToolCallRecord {
    this.key(input); text(input.callId, 'callId');
    if (!['succeeded', 'failed', 'denied', 'cancelled', 'unknown'].includes(input.status)) throw new TypeError('Invalid terminal status');
    text(input.content, 'content', 1_000_000, true);
    if (input.errorCode !== undefined) text(input.errorCode, 'errorCode', 256);
    if (typeof input.localOnly !== 'boolean') throw new TypeError('localOnly must be boolean');
    return this.transaction(() => {
      const existing = this.getCall(input.sessionId, input.turnId, input.callId);
      if (!existing) throw new SessionStoreError('NOT_FOUND', 'Journal call not found');
      if (existing.status !== 'running' && existing.status !== 'pending') return existing;
      const at = Math.max(Date.now(), existing.updatedAt);
      this.db.prepare(`UPDATE tool_calls SET status=?,content=?,error_code=?,local_only=max(local_only,?),updated_at=?,finished_at=? WHERE id=?`)
        .run(input.status, input.content, input.errorCode ?? null, Number(input.localOnly), at, at, existing.id);
      return this.getCall(input.sessionId, input.turnId, input.callId)!;
    });
  }
  /** Audit only. Approval grants and cancellation signals remain in runtime memory. First decision wins. */
  recordApproval(sessionId: string, turnId: string, callId: string, decision: unknown): void {
    this.key({ sessionId, turnId }); text(callId, 'callId');
    const value = canonical(decision);
    const existing = this.getCall(sessionId, turnId, callId);
    if (!existing) throw new SessionStoreError('NOT_FOUND', 'Journal call not found');
    this.db.prepare('UPDATE tool_calls SET approval=?,updated_at=max(updated_at,?) WHERE id=? AND approval IS NULL')
      .run(value, Date.now(), existing.id);
  }
  getCall(sessionId: string, turnId: string, callId: string): ToolCallRecord | undefined {
    this.key({ sessionId, turnId }); text(callId, 'callId');
    const row = this.db.prepare('SELECT * FROM tool_calls WHERE session_id=? AND turn_id=? AND call_id=?').get(sessionId, turnId, callId);
    return row ? record(row) : undefined;
  }
  listCalls(sessionId: string, turnId?: string): ToolCallRecord[] {
    text(sessionId, 'sessionId');
    if (turnId !== undefined) { text(turnId, 'turnId'); return this.db.prepare('SELECT * FROM tool_calls WHERE session_id=? AND turn_id=? ORDER BY id').all(sessionId, turnId).map(record); }
    return this.db.prepare('SELECT * FROM tool_calls WHERE session_id=? ORDER BY id').all(sessionId).map(record);
  }
  /** Within-turn replay only; callers must apply localOnly/privacy checks before sending anywhere. */
  messages(sessionId: string, turnId: string): JournalMessage[] {
    this.key({ sessionId, turnId });
    const output: JournalMessage[] = [];
    const steps = this.db.prepare('SELECT * FROM tool_steps WHERE session_id=? AND turn_id=? ORDER BY step').all(sessionId, turnId);
    for (const step of steps) {
      if (step.assistant_text === null) break;
      const calls = JSON.parse(String(step.tool_calls)) as JournalToolCall[];
      const results = calls.map(call => this.getCall(sessionId, turnId, call.id));
      // Never replay an orphaned assistant call, nor later steps across an incomplete prefix.
      if (results.some(result => !result || result.status === 'running' || result.status === 'pending')) break;
      output.push({ role: 'assistant', content: String(step.assistant_text), ...(calls.length ? { toolCalls: calls } : {}) });
      for (const result of results) output.push({ role: 'tool', content: result!.content, toolCallId: result!.callId });
    }
    return output;
  }
}
