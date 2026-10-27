import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SessionStore, SessionStoreError } from '../src/sessions.ts';

function fixture(t: { after(fn: () => void): void }, fixedTime = false) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-sessions-'));
  const file = join(dir, 'sessions.db');
  let time = 100;
  const store = new SessionStore({ file, now: () => fixedTime ? time : ++time });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, file };
}

test('session CRUD, auto-title, explicit rename, archive, stable default and durable export', t => {
  const { store, file } = fixture(t);
  const first = store.create();
  assert.equal(first.messageCount, 0);
  assert.equal(first.title, '新会话');
  store.beginTurn(first.id, 'one', '  A useful\n question  ', 'text', 'work');
  assert.equal(store.get(first.id)?.title, 'A useful question');
  store.appendDelta('one', 'Hello');
  const done = store.finishTurn('one', { status: 'complete', metadata: { model: 'local', tokens: 5 } });
  assert.equal(done.content, 'Hello');
  assert.equal(store.get(first.id)?.messageCount, 2);
  assert.equal(store.get(first.id)?.preview, 'Hello');
  store.rename(first.id, 'My title');
  store.beginTurn(first.id, 'two', 'Next question', 'voice');
  assert.equal(store.get(first.id)?.title, 'My title');
  const named = store.create('Chosen title');
  store.beginTurn(named.id, 'three', 'Will not replace title', 'text');
  assert.equal(store.get(named.id)?.title, 'Chosen title');
  const renamedEmpty = store.create();
  store.rename(renamedEmpty.id, 'Renamed before first message');
  store.beginTurn(renamedEmpty.id, 'four', 'Not the title', 'text');
  assert.equal(store.get(renamedEmpty.id)?.title, 'Renamed before first message');
  store.setArchived(first.id, true);
  assert.deepEqual(store.list({ archived: true }).items.map(s => s.id), [first.id]);
  assert.equal(store.list({ archived: false }).total, 2);
  assert.equal(store.list({ limit: 1, offset: 1 }).items.length, 1);
  assert.equal(store.list({ limit: 1 }).total, 3);
  const def = store.getOrCreateDefault();
  assert.equal(store.getOrCreateDefault().id, def.id);
  assert.equal(store.list().total, 4);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const exported = store.exportAll();
  assert.equal(exported.version, 1);
  assert.deepEqual(store.exportSession(first.id), exported.sessions.find(s => s.id === first.id));
  assert.deepEqual(exported.sessions.find(s => s.id === first.id)?.messages[1].metadata, { model: 'local', tokens: 5 });
  store.close();
  const reopened = new SessionStore({ file });
  try {
    assert.equal(reopened.get(first.id)?.title, 'My title');
    assert.equal(reopened.messages(first.id).items[1].content, 'Hello');
    assert.equal(reopened.getOrCreateDefault().id, def.id);
  } finally { reopened.close(); }
});

test('duplicate turns are idempotent but differing payloads and finished mutations are rejected', t => {
  const { store } = fixture(t);
  const a = store.create(); const b = store.create();
  const original = store.beginTurn(a.id, 'unique', 'Question', 'text', 'home');
  assert.deepEqual(store.beginTurn(a.id, 'unique', 'Question', 'text', 'home'), original);
  assert.deepEqual(store.getTurn('unique'), original);
  assert.equal(store.getTurn('missing'), undefined);
  assert.throws(() => store.beginTurn(b.id, 'unique', 'Question', 'text', 'home'),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'CONFLICT' && error.statusCode === 409);
  assert.throws(() => store.exportSession('missing'),
    (error: unknown) => error instanceof SessionStoreError && error.code === 'NOT_FOUND' && error.statusCode === 404);
  for (const args of [[a.id, 'Other', 'text', 'home'], [b.id, 'Question', 'text', 'home'],
    [a.id, 'Question', 'voice', 'home'], [a.id, 'Question', 'text', 'work']] as const) {
    assert.throws(() => store.beginTurn(args[0], 'unique', args[1], args[2], args[3]), /different payload or session/);
  }
  assert.equal(store.get(a.id)?.messageCount, 2);
  assert.equal(store.get(b.id)?.messageCount, 0);
  store.appendDelta('unique', 'a'); store.appendDelta('unique', 'b');
  const done = store.finishTurn('unique', { status: 'complete' });
  assert.equal(done.content, 'ab');
  assert.deepEqual(store.finishTurn('unique', { status: 'complete' }), done);
  assert.equal(store.beginTurn(a.id, 'unique', 'Question', 'text', 'home').assistant.status, 'complete');
  assert.throws(() => store.appendDelta('unique', 'c'), /already finished/);
  assert.throws(() => store.finishTurn('unique', { status: 'cancelled' }), /already finished/);
  assert.throws(() => store.finishTurn('unique', { status: 'complete', text: 'changed' }), /already finished/);
});

test('message pagination is chronological, exclusive and isolated even with equal timestamps', t => {
  const { store } = fixture(t, true);
  const a = store.create(); const b = store.create();
  for (let n = 0; n < 5; n++) {
    store.beginTurn(a.id, `a${n}`, `q${n}`, 'text'); store.finishTurn(`a${n}`, { status: 'complete', text: `a${n}` });
    store.beginTurn(b.id, `b${n}`, 'other', 'text');
  }
  const newest = store.messages(a.id, { limit: 3 });
  assert.equal(newest.hasMore, true);
  const previous = store.messages(a.id, { before: newest.items[0].id, limit: 3 });
  const oldest = store.messages(a.id, { before: previous.items[0].id, limit: 10 });
  assert.equal(oldest.hasMore, false);
  const all = [...oldest.items, ...previous.items, ...newest.items];
  assert.equal(all.length, 10);
  assert.equal(new Set(all.map(m => m.id)).size, 10);
  assert.ok(all.every(m => m.sessionId === a.id));
  assert.deepEqual(all.map(m => m.id), all.map(m => m.id).sort((a, b) => a - b));
  assert.equal(store.messages(a.id, { before: all[0].id }).items.length, 0);
});

test('context preserves complete successful pairs and budgets, excludes pending, failed, cancelled and other sessions', t => {
  const { store } = fixture(t);
  const a = store.create(); const b = store.create();
  store.beginTurn(a.id, 'ok1', 'q1', 'text'); store.finishTurn('ok1', { status: 'complete', text: 'a1' });
  store.beginTurn(a.id, 'failed', 'bad', 'text'); store.finishTurn('failed', { status: 'error', text: 'partial', error: 'network' });
  store.beginTurn(a.id, 'ok2', 'q2', 'text'); store.finishTurn('ok2', { status: 'complete', text: 'a2' });
  store.beginTurn(a.id, 'cancelled', 'stop', 'text'); store.finishTurn('cancelled', { status: 'cancelled' });
  store.beginTurn(a.id, 'pending', 'current', 'text'); store.appendDelta('pending', 'in progress');
  store.beginTurn(b.id, 'private', 'secret', 'text'); store.finishTurn('private', { status: 'complete', text: 'secret' });
  store.beginTurn(a.id, 'capture', 'look', 'text'); store.finishTurn('capture', { status: 'complete', text: 'private pixels', metadata: { contextExcluded: true } });
  assert.deepEqual(store.context(a.id, 100).map(m => m.content), ['q1', 'a1', 'q2', 'a2']);
  assert.deepEqual(store.context(a.id, 3).map(m => m.content), ['q2', 'a2']);
  assert.deepEqual(store.context(a.id, 100, 4).map(m => m.content), ['q2', 'a2']);
  assert.deepEqual(store.context(a.id, 100, 3), []);
  assert.deepEqual(store.context(a.id, 1), []);
});

test('restart recovers interrupted turns without reopening or losing deltas', t => {
  const { store, file } = fixture(t);
  const s = store.create();
  store.beginTurn(s.id, 'interrupted', 'Question', 'voice'); store.appendDelta('interrupted', 'partial');
  store.close();
  const recovered = new SessionStore({ file });
  try {
    const pair = recovered.beginTurn(s.id, 'interrupted', 'Question', 'voice');
    assert.equal(pair.user.status, 'complete');
    assert.equal(pair.assistant.status, 'error');
    assert.equal(pair.assistant.content, 'partial');
    assert.match(pair.assistant.error!, /Interrupted/);
    assert.deepEqual(recovered.context(s.id, 20), []);
    assert.throws(() => recovered.appendDelta('interrupted', 'more'), /finished/);
  } finally { recovered.close(); }
});

test('search treats SQL, LIKE wildcard and escape characters literally across titles and messages', t => {
  const { store } = fixture(t);
  const a = store.create('100% literal_title \\ path'); const b = store.create('100X literalXtitle');
  store.beginTurn(a.id, 'search', "Robert'); DROP TABLE sessions; --", 'text');
  store.finishTurn('search', { status: 'complete', text: 'needle in assistant' });
  for (const query of ['%', '_', '\\', "Robert'); DROP TABLE sessions; --", 'needle']) {
    assert.deepEqual(store.list({ query }).items.map(s => s.id), [a.id]);
  }
  assert.equal(store.list({ query: "' OR 1=1 --" }).total, 0);
  assert.ok(store.get(b.id)); assert.equal(store.list({ query: '' }).total, 2);
});

test('deletion cascades, isolates remaining sessions and clearAll removes persisted text', t => {
  const { store, file } = fixture(t);
  const a = store.create(); const b = store.create();
  store.beginTurn(a.id, 'deleted', 'erase this message', 'text');
  store.beginTurn(b.id, 'remaining', 'unique sensitive payload 8e0ee9', 'text');
  assert.equal(store.delete(a.id), true); assert.equal(store.delete(a.id), false);
  assert.equal(store.get(a.id), undefined);
  assert.throws(() => store.appendDelta('deleted', '!'), /not found/);
  assert.equal(store.get(b.id)?.messageCount, 2);
  const inspect = new DatabaseSync(file);
  try {
    assert.equal(inspect.prepare('SELECT count(*) AS n FROM messages WHERE session_id=?').get(a.id)!.n, 0);
  } finally { inspect.close(); }
  store.clearAll();
  assert.equal(store.list().total, 0); assert.deepEqual(store.exportAll().sessions, []);
  assert.equal(readFileSync(file).includes(Buffer.from('unique sensitive payload 8e0ee9')), false);
  assert.equal(statSync(file + '-wal').size, 0);
  assert.equal(store.getOrCreateDefault().id, 'default');
});

test('validation and transaction rollback prevent half-written turns', t => {
  const { store, file } = fixture(t);
  const a = store.create();
  assert.throws(() => store.create(' '));
  assert.throws(() => store.rename(a.id, 'x'.repeat(201)));
  for (const limit of [0, -1, 1.5, NaN, 501]) assert.throws(() => store.list({ limit }));
  assert.throws(() => store.list({ offset: -1 }));
  assert.throws(() => store.messages(a.id, { before: 0 }));
  assert.throws(() => store.context(a.id, -1));
  assert.throws(() => store.beginTurn(a.id, 'too-long', 'x'.repeat(1_000_001), 'text'));
  const inspect = new DatabaseSync(file);
  try {
    inspect.exec(`CREATE TRIGGER reject_assistant BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'test failure'); END`);
    assert.throws(() => store.beginTurn(a.id, 'rollback', 'question', 'text'), /test failure/);
    assert.equal(store.get(a.id)?.messageCount, 0);
    assert.equal(store.get(a.id)?.title, a.title);
    inspect.exec('DROP TRIGGER reject_assistant');
  } finally { inspect.close(); }
  store.beginTurn(a.id, 'rollback', 'question', 'text');
  assert.equal(store.get(a.id)?.messageCount, 2);
  store.appendDelta('rollback', 'x'.repeat(1_000_000));
  assert.throws(() => store.appendDelta('rollback', '!'), RangeError);
  assert.equal(store.getTurn('rollback')?.assistant.content.length, 1_000_000);
});

test('migration refuses unrelated schemas and future versions', t => {
  const { store, file } = fixture(t);
  store.close();
  const db = new DatabaseSync(file); db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => new SessionStore({ file }), /Unsupported/);
  const unrelated = join(file, '..', 'memory.db');
  const memory = new DatabaseSync(unrelated); memory.exec('CREATE TABLE summaries(content TEXT)'); memory.close();
  assert.throws(() => new SessionStore({ file: unrelated }), /non-session database/);
  const check = new DatabaseSync(unrelated);
  try { assert.ok(check.prepare("SELECT name FROM sqlite_master WHERE name='summaries'").get()); }
  finally { check.close(); }
});
