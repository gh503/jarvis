import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/sessions.ts';
import { ToolJournal } from '../src/tool-journal.ts';

function fixture(t: test.TestContext, file = ':memory:') {
  const sessions = new SessionStore({ file });
  t.after(() => sessions.close());
  const journal = new ToolJournal(sessions);
  const sessionId = sessions.create().id;
  const turnId = 'turn';
  sessions.beginTurn(sessionId, turnId, 'question', 'test');
  const key = { sessionId, turnId, step: 0 };
  const prepare = (ids = ['call']) => {
    journal.beginStep({ ...key, requestMessages: [{ role: 'user', content: 'question' }], tools: [] });
    journal.recordAssistant({ ...key, text: 'checking', toolCalls: ids.map(id => ({ id, name: 'lookup', arguments: '{"z":1,"a":2}' })) });
  };
  const start = (callId = 'call') => journal.startCall({ ...key, callId, name: 'lookup', args: { z: 1, a: 2 }, definitionHash: 'hash', localOnly: false });
  const finish = (callId = 'call') => journal.finishCall({ ...key, callId, status: 'succeeded', content: callId + ' result', localOnly: false });
  return { sessions, journal, key, prepare, start, finish };
}

test('request precedes dispatch; call IDs and terminal results are immutable', t => {
  const f = fixture(t);
  assert.throws(() => f.start(), /before dispatch/);
  f.prepare();
  const first = f.start();
  assert.equal(first.created, true);
  assert.equal(first.record.status, 'running');
  assert.equal(first.record.args, '{"a":2,"z":1}');
  assert.deepEqual(f.start(), { created: false, record: first.record });
  f.journal.recordApproval(f.key.sessionId, f.key.turnId, 'call', { allowed: true });
  f.journal.recordApproval(f.key.sessionId, f.key.turnId, 'call', false);
  const final = f.finish();
  assert.deepEqual(final.approval, { allowed: true });
  assert.deepEqual(f.journal.finishCall({ ...f.key, callId: 'call', status: 'failed', content: 'replace', localOnly: false }), final);
  assert.equal(f.start().created, false);
  assert.ok(final.updatedAt >= final.createdAt);
});

test('reopen marks running and pending calls unknown and interrupted steps failed without resuming', t => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-tool-journal-'));
  assert.equal(resolve(dir), dir);
  assert.ok(dir.startsWith(join(tmpdir(), 'jarvis-tool-journal-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sessions.db');
  const f = fixture(t, file);
  f.prepare(['call', 'pending', 'not-started']); f.start(); f.start('pending');
  f.sessions.databaseForTools().prepare("UPDATE tool_calls SET status='pending' WHERE call_id='pending'").run();
  f.journal.beginStep({ ...f.key, step: 1 });
  f.sessions.close();
  const reopened = new SessionStore({ file });
  t.after(() => reopened.close());
  const journal = new ToolJournal(reopened);
  assert.deepEqual(journal.listCalls(f.key.sessionId).map(call => call.status), ['unknown', 'unknown', 'cancelled']);
  const unstarted = journal.getCall(f.key.sessionId, f.key.turnId, 'not-started')!;
  assert.equal(unstarted.errorCode, 'TOOL_NOT_STARTED');
  assert.equal(unstarted.localOnly, true);
  assert.equal(unstarted.args, '{"a":2,"z":1}');
  assert.equal(journal.startCall({ ...f.key, callId: 'not-started', name: 'lookup', args: {}, definitionHash: 'hash', localOnly: false }).created, false);
  assert.equal(reopened.databaseForTools().prepare('SELECT status FROM tool_steps WHERE step=1').get()!.status, 'failed');
  assert.equal(reopened.databaseForTools().prepare('SELECT status FROM tool_steps WHERE step=0').get()!.status, 'failed');
  assert.equal(journal.finishCall({ ...f.key, callId: 'call', status: 'succeeded', content: 'late result', localOnly: false }).status, 'unknown');
  assert.equal(journal.startCall({ ...f.key, callId: 'call', name: 'lookup', args: {}, definitionHash: 'changed', localOnly: false }).created, false);
  assert.equal(journal.messages(f.key.sessionId, f.key.turnId).length, 4);
});

test('closeTurn reconciles missing proposals once while preserving completed records and replay order', t => {
  const f = fixture(t);
  f.journal.beginStep(f.key);
  f.journal.recordAssistant({ ...f.key, text: 'batch', toolCalls: [
    { id: 'missing', name: 'lookup', arguments: '{bad JSON' },
    { id: 'done', name: 'lookup', arguments: '{}' },
    { id: 'running', name: 'lookup', arguments: '{}' },
  ] });
  f.start('done'); const done = f.finish('done'); f.start('running');
  f.journal.closeTurn(f.key.sessionId, f.key.turnId);
  assert.deepEqual(f.journal.getCall(f.key.sessionId, f.key.turnId, 'done'), done);
  assert.equal(f.journal.getCall(f.key.sessionId, f.key.turnId, 'running')?.status, 'unknown');
  const missing = f.journal.getCall(f.key.sessionId, f.key.turnId, 'missing')!;
  assert.equal(missing.status, 'cancelled');
  assert.equal(missing.errorCode, 'TOOL_NOT_STARTED');
  assert.equal(missing.localOnly, true);
  assert.equal(JSON.parse(missing.args), '{bad JSON');
  assert.deepEqual(f.journal.messages(f.key.sessionId, f.key.turnId).map(m => m.role === 'tool' ? m.toolCallId : m.role), ['assistant', 'missing', 'done', 'running']);
  const before = f.journal.listCalls(f.key.sessionId);
  f.journal.closeTurn(f.key.sessionId, f.key.turnId);
  assert.deepEqual(f.journal.listCalls(f.key.sessionId), before);
  assert.equal(f.start('missing').created, false);
  f.sessions.delete(f.key.sessionId);
  f.journal.closeTurn(f.key.sessionId, f.key.turnId);
  assert.deepEqual(f.journal.listCalls(f.key.sessionId), []);
});

test('replay orders results by assistant call order, and withholds incomplete prefixes', t => {
  const f = fixture(t);
  f.prepare(['first', 'second']);
  f.start('second'); f.finish('second');
  assert.deepEqual(f.journal.messages(f.key.sessionId, f.key.turnId), []);
  f.start('first'); f.finish('first');
  assert.deepEqual(f.journal.messages(f.key.sessionId, f.key.turnId).map(message => message.role === 'tool' ? message.toolCallId : message.role), ['assistant', 'first', 'second']);
  f.journal.beginStep({ ...f.key, step: 1 });
  f.journal.recordAssistant({ ...f.key, step: 1, text: 'done', toolCalls: [] });
  assert.equal(f.journal.messages(f.key.sessionId, f.key.turnId).at(-1)!.content, 'done');
});

test('session deletion and erase cascade journal data without resetting call sequence', t => {
  const f = fixture(t); f.prepare();
  const first = f.start().record;
  f.sessions.delete(f.key.sessionId);
  assert.deepEqual(f.journal.listCalls(f.key.sessionId), []);
  assert.equal(f.sessions.databaseForTools().prepare('SELECT count(*) AS n FROM tool_steps').get()!.n, 0);
  const sessionId = f.sessions.create().id;
  f.sessions.beginTurn(sessionId, 'new', 'question', 'test');
  const key = { sessionId, turnId: 'new', step: 0 };
  f.journal.beginStep(key);
  f.journal.recordAssistant({ ...key, text: '', toolCalls: [{ id: 'next', name: 'lookup', arguments: '{}' }] });
  const next = f.journal.startCall({ ...key, callId: 'next', name: 'lookup', args: {}, definitionHash: 'hash', localOnly: true }).record;
  assert.ok(next.id > first.id);
  assert.equal(f.journal.finishCall({ ...key, callId: 'next', status: 'succeeded', content: '', localOnly: false }).localOnly, true);
  f.sessions.clearAll();
  assert.deepEqual(f.journal.listCalls(sessionId), []);
});

test('rejects oversized, cyclic, lossy metadata and cross-session turns', t => {
  const f = fixture(t);
  assert.throws(() => f.journal.beginStep({ ...f.key, tools: 'x'.repeat(100_001) }), /at most/);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => f.journal.beginStep({ ...f.key, tools: cyclic }), /acyclic/);
  assert.throws(() => f.journal.beginStep({ ...f.key, tools: { value: undefined } }), /acyclic/);
  assert.throws(() => f.journal.beginStep({ ...f.key, sessionId: f.sessions.create().id }), /not found/);
  f.prepare();
  assert.throws(() => f.journal.startCall({ ...f.key, callId: 'call', name: 'lookup', args: 'x'.repeat(100_001), definitionHash: 'hash', localOnly: false }), /at most/);
  assert.equal(f.journal.listCalls(f.key.sessionId).length, 0);
});
