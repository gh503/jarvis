import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SessionStore } from '../src/sessions.ts';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-summary-'));
  const file = join(dir, 'sessions.db');
  const store = new SessionStore({ file });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, file };
}
function turn(store: SessionStore, sessionId: string, turnId: string, scenario = 'work') {
  store.beginTurn(sessionId, turnId, `question ${turnId}`, 'text', scenario);
  store.finishTurn(turnId, { status: 'complete', text: `answer ${turnId}` });
  const pair = store.getTurn(turnId)!;
  return [pair.user.id, pair.assistant.id];
}
function save(store: SessionStore, sessionId: string, sourceIds: number[], scope = 'local') {
  return store.saveSummary({ sessionId, scope, text: 'derived summary', sourceIds,
    throughMessageId: sourceIds.at(-1)!, expectedRevision: store.contextState(sessionId, scope).revision });
}

test('summary scope, cumulative provenance, persistence and transcript-only export', t => {
  const { store, file } = fixture(t);
  const id = store.create().id;
  const first = turn(store, id, 'first');
  const second = turn(store, id, 'second', 'home');
  const other = store.create().id;
  turn(store, other, 'other');
  const initial = store.contextState(id, 'local');
  assert.deepEqual(initial.messages.map(m => m.id), [...first, ...second]);
  assert.equal(initial.hasMore, false);
  const summary = save(store, id, first);
  assert.deepEqual(store.contextState(id, 'local').messages.map(m => m.id), second);
  assert.equal(store.contextState(id, 'cloud').summary, null);
  assert.deepEqual(store.contextState(id, 'cloud').messages.map(m => m.id), [...first, ...second]);
  assert.equal(JSON.stringify(store.exportAll()).includes('derived summary'), false);
  store.close();
  const reopened = new SessionStore({ file });
  try {
    assert.deepEqual(reopened.contextState(id, 'local').summary, summary);
    assert.throws(() => save(reopened, id, second), /source prefix/);
    const replacement = save(reopened, id, [...first, ...second]);
    assert.deepEqual(replacement.sourceIds, [...first, ...second]);
    assert.deepEqual(reopened.contextState(id, 'local').messages, []);
  } finally { reopened.close(); }
});

test('CAS rejects stale writes across scopes, invalidation, exclusion and restart', t => {
  const { store, file } = fixture(t);
  const id = store.create().id;
  const ids = turn(store, id, 'one');
  const input = { sessionId: id, scope: 'local', text: 'old', sourceIds: ids,
    throughMessageId: ids.at(-1)!, expectedRevision: store.contextState(id, 'local').revision };
  save(store, id, ids, 'cloud');
  assert.throws(() => store.saveSummary(input), /revision changed/);
  input.expectedRevision = store.contextState(id, 'local').revision;
  store.invalidateSummaries();
  assert.equal(store.contextState(id, 'cloud').summary, null);
  store.close();
  const reopened = new SessionStore({ file });
  try {
    assert.throws(() => reopened.saveSummary(input), /revision changed/);
    save(reopened, id, ids);
    input.expectedRevision = reopened.contextState(id, 'local').revision;
    reopened.excludeTurnFromContext('one');
    assert.equal(reopened.contextState(id, 'local').summary, null);
    assert.deepEqual(reopened.contextState(id, 'local').messages, []);
    assert.throws(() => reopened.saveSummary(input), /revision changed/);
    assert.throws(() => save(reopened, id, ids), /source prefix/);
    assert.equal(reopened.messages(id).items.length, 2);
  } finally { reopened.close(); }
});

test('delete and clear cannot resurrect a summary for the recreated default session', t => {
  const { store } = fixture(t);
  for (const erase of [() => store.delete('default'), () => store.clearAll()]) {
    const id = store.getOrCreateDefault().id;
    const ids = turn(store, id, `turn-${Math.random()}`);
    save(store, id, ids);
    const revision = store.contextState(id, 'local').revision;
    erase();
    store.getOrCreateDefault();
    assert.ok(store.contextState(id, 'local').revision > revision);
    assert.equal(store.contextState(id, 'local').summary, null);
    assert.throws(() => store.saveSummary({ sessionId: id, scope: 'local', text: 'stale',
      throughMessageId: ids.at(-1)!, sourceIds: ids, expectedRevision: revision }), /revision changed/);
  }
});

test('only whole eligible prefixes can be summarized; late completion invalidates a cursor', t => {
  const { store } = fixture(t);
  const id = store.create().id;
  store.beginTurn(id, 'pending', 'pending', 'text');
  const ids = turn(store, id, 'complete');
  store.beginTurn(id, 'failed', 'failed', 'text');
  store.finishTurn('failed', { status: 'error' });
  const excluded = turn(store, id, 'excluded');
  store.excludeTurnFromContext('excluded');
  assert.deepEqual(store.contextState(id, 'local').messages.map(m => m.id), ids);
  assert.throws(() => save(store, id, [ids[0]]), /source prefix/);
  assert.throws(() => save(store, id, [...ids, ...excluded]), /source prefix/);
  save(store, id, ids);
  store.finishTurn('pending', { status: 'complete', text: 'late answer' });
  assert.equal(store.contextState(id, 'local').summary, null);
  assert.equal(store.contextState(id, 'local').messages.length, 4);
});

test('exclusion of an in-flight turn survives completion metadata', t => {
  const { store } = fixture(t);
  const id = store.create().id;
  store.beginTurn(id, 'excluded-pending', 'question', 'text');
  store.excludeTurnFromContext('excluded-pending');
  store.finishTurn('excluded-pending', { status: 'complete', text: 'answer', metadata: { model: 'local' } });
  assert.deepEqual(store.contextState(id, 'local').messages, []);
  assert.deepEqual(store.context(id, 10), []);
});

test('contextState explicitly bounds the earliest whole pairs and flags the remaining tail', t => {
  const { store, file } = fixture(t);
  const id = store.create().id;
  const db = new DatabaseSync(file);
  const insert = db.prepare(`INSERT INTO messages(session_id,turn_id,role,content,status,created_at,updated_at,source)
    VALUES(?,?,?,'text','complete',1,1,'test')`);
  db.exec('BEGIN');
  for (let i = 0; i < 5001; i++) {
    insert.run(id, `bound-${i}`, 'user');
    insert.run(id, `bound-${i}`, 'assistant');
  }
  db.exec('COMMIT');
  db.close();
  const state = store.contextState(id, 'local');
  assert.equal(state.messages.length, 10_000);
  assert.equal(state.hasMore, true);
  assert.equal(state.messages[0].id, 1);
  assert.equal(state.messages.at(-1)!.id, 10_000);
  save(store, id, state.messages.map(m => m.id));
  const tail = store.contextState(id, 'local');
  assert.deepEqual(tail.messages.map(m => m.id), [10_001, 10_002]);
  assert.equal(tail.hasMore, false);
});

test('migrates v1 transcripts to v2 without losing history; new stores are v2', t => {
  const { store, file } = fixture(t);
  const id = store.create().id;
  const ids = turn(store, id, 'legacy');
  store.close();
  const db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 2);
  db.exec('DROP TABLE session_summaries; DROP TABLE context_revisions; PRAGMA user_version=1;');
  db.close();
  const migrated = new SessionStore({ file });
  try {
    assert.deepEqual(migrated.contextState(id, 'local').messages.map(m => m.id), ids);
    save(migrated, id, ids);
  } finally { migrated.close(); }
  const check = new DatabaseSync(file);
  assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 2);
  assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
  check.close();
});
