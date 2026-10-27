import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/sessions.ts';
import { ToolJournal } from '../src/tool-journal.ts';
import { ToolRuntime, type ToolDefinition } from '../src/tools.ts';
import { EventBus } from '../src/events.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: test.TestContext, overrides: Partial<ToolDefinition> = {}) {
  const sessions = new SessionStore({ file: ':memory:' });
  const journal = new ToolJournal(sessions);
  const bus = new EventBus();
  const approvalReady = deferred<void>();
  const started = deferred<void>();
  bus.on('tool.approval', () => approvalReady.resolve());
  bus.on('tool.started', () => started.resolve());
  const awaitEvent = (event: Promise<void>, job: Promise<unknown>) => Promise.race([
    event, job.then(result => { throw new Error(`Tool completed before expected event: ${JSON.stringify(result)}`); }),
  ]);
  let executions = 0;
  let definitions: ToolDefinition[] = [{
    name: 'example', description: 'test tool', definitionHash: 'hash-1', usage: 'shared',
    permission: 'allow', effect: 'write', destination: 'local',
    parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
    execute: async () => { executions++; return { content: 'completed' }; }, ...overrides,
  }];
  const runtime = new ToolRuntime({ definitions: () => definitions, journal, bus });
  t.after(async () => { await runtime.quiesce(); sessions.close(); });
  const sessionId = sessions.create().id;
  const turnId = 'turn';
  sessions.beginTurn(sessionId, turnId, 'question', 'test');
  const key = { sessionId, turnId, step: 0 };
  const controller = new AbortController();
  const prepare = (args = '{"value":1}', name = 'example') => {
    const call = { id: 'call', name, arguments: args };
    journal.beginStep(key);
    journal.recordAssistant({ ...key, text: '', toolCalls: [call] });
    return { ...key, call, signal: controller.signal, allowedDefinitions: new Map(definitions.map(d => [d.name, d.definitionHash])), allowRemote: true, allowLocalResults: true };
  };
  const record = () => journal.getCall(sessionId, turnId, 'call')!;
  return { runtime, journal, bus, key, controller, prepare, record, executions: () => executions,
    approvalReady: (job: Promise<unknown>) => awaitEvent(approvalReady.promise, job),
    started: (job: Promise<unknown>) => awaitEvent(started.promise, job),
    definition: () => definitions[0]!, replace: (next: ToolDefinition[]) => { definitions = next; } };
}

test('ask approval requires exact session and turn, is single-use, and persists before success', async t => {
  const f = fixture(t, { permission: 'ask' });
  const input = f.prepare();
  const job = f.runtime.execute(input);
  await f.approvalReady(job);
  const [approval] = f.runtime.pending();
  assert.ok(approval);
  assert.equal(approval.callId, input.call.id);
  assert.equal(f.executions(), 0);
  assert.equal(f.runtime.approve(approval.id, true), false);
  assert.equal(f.runtime.approve(approval.id, true, { ...f.key, sessionId: 'wrong' }), false);
  assert.equal(f.runtime.approve(approval.id, true, { ...f.key, turnId: 'wrong' }), false);
  assert.equal(f.runtime.approve('wrong', true, f.key), false);
  assert.equal(f.executions(), 0);
  assert.equal(f.runtime.approve(approval.id, true, f.key), true);
  assert.equal(f.runtime.approve(approval.id, true, f.key), false);
  assert.equal((await job).status, 'succeeded');
  assert.equal(f.executions(), 1);
  assert.equal((f.record().approval as { approved: boolean }).approved, true);
  assert.equal(f.record().content, 'completed');
});

test('denial is terminal and duplicate calls never request approval or execute again', async t => {
  const f = fixture(t, { permission: 'ask' });
  const input = f.prepare();
  const job = f.runtime.execute(input);
  await f.approvalReady(job);
  assert.equal(f.runtime.approve(f.runtime.pending()[0]!.id, false, f.key), true);
  assert.equal((await job).status, 'denied');
  assert.equal((await f.runtime.execute(input)).status, 'denied');
  assert.equal(f.executions(), 0);
  assert.deepEqual(f.runtime.pending(), []);
  assert.equal((f.record().approval as { approved: boolean }).approved, false);
});

test('already cancelled turn never dispatches or asks approval', async t => {
  const f = fixture(t, { permission: 'ask' });
  const input = f.prepare();
  f.controller.abort();
  assert.equal((await f.runtime.execute(input)).status, 'cancelled');
  assert.equal(f.executions(), 0);
  assert.deepEqual(f.runtime.pending(), []);
});

test('cancellation while awaiting approval invalidates approval without executing', async t => {
  const f = fixture(t, { permission: 'ask' });
  const job = f.runtime.execute(f.prepare());
  await f.approvalReady(job);
  const approval = f.runtime.pending()[0]!;
  f.controller.abort();
  assert.equal((await job).status, 'cancelled');
  assert.equal(f.runtime.approve(approval.id, true, f.key), false);
  assert.equal(f.executions(), 0);
});

test('running and completed duplicate call IDs have no second side effect', async t => {
  const gate = deferred<{ content: string }>();
  let executions = 0;
  const f = fixture(t, { execute: async () => { executions++; return gate.promise; } });
  const input = f.prepare();
  const job = f.runtime.execute(input);
  await f.started(job);
  assert.equal((await f.runtime.execute(input)).status, 'running');
  assert.equal(executions, 1);
  gate.resolve({ content: 'one result' });
  assert.equal((await job).status, 'succeeded');
  assert.equal((await f.runtime.execute(input)).content, 'one result');
  assert.equal(executions, 1);
});

test('abort-ignoring write stays unknown after late side effect and cannot be retried', async t => {
  const gate = deferred<void>();
  const finished = deferred<void>();
  let dispatched = 0, sideEffects = 0;
  const f = fixture(t, { execute: async () => {
    dispatched++;
    await gate.promise;
    sideEffects++;
    finished.resolve();
    return { content: 'late success' };
  } });
  const input = f.prepare();
  const job = f.runtime.execute(input);
  await f.started(job);
  f.controller.abort();
  const outcome = await job;
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.isError, true);
  assert.equal(f.record().errorCode, 'TOOL_OUTCOME_UNKNOWN');
  assert.equal(sideEffects, 0);
  assert.equal((await f.runtime.execute(input)).status, 'unknown');
  gate.resolve();
  await finished.promise;
  await Promise.resolve();
  assert.equal(sideEffects, 1);
  assert.equal(dispatched, 1);
  assert.equal(f.record().status, 'unknown');
  assert.equal(f.record().content, outcome.content);
  assert.equal((await f.runtime.execute(input)).status, 'unknown');
  assert.equal(dispatched, 1);
});

test('write exception is unknown while read exception is failed', async t => {
  for (const effect of ['read', 'write'] as const) {
    await t.test(effect, async t => {
      const f = fixture(t, { effect, execute: async () => { throw new Error('transport lost'); } });
      assert.equal((await f.runtime.execute(f.prepare())).status, effect === 'write' ? 'unknown' : 'failed');
    });
  }
});

test('schema and recursive prototype keys reject before dispatch without coercion', async t => {
  const invalid = ['{"value":"1"}', '{"value":1,"extra":true}', '{}', '[]', 'null', '{',
    '{"value":1,"__proto__":{"polluted":true}}', '{"value":1,"nested":{"constructor":{"prototype":{"polluted":true}}}}'];
  for (const args of invalid) await t.test(args, async t => {
    const f = fixture(t);
    assert.equal((await f.runtime.execute(f.prepare(args))).status, 'denied');
    assert.equal(f.executions(), 0);
    assert.equal(f.record().errorCode, 'INVALID_TOOL_CALL');
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

test('definition hash change while approval is pending prevents execution', async t => {
  const f = fixture(t, { permission: 'ask' });
  const job = f.runtime.execute(f.prepare());
  await f.approvalReady(job);
  const approval = f.runtime.pending()[0]!;
  f.replace([{ ...f.definition(), definitionHash: 'hash-2' }]);
  f.runtime.approve(approval.id, true, f.key);
  assert.equal((await job).status, 'denied');
  assert.equal(f.executions(), 0);
  assert.equal(f.record().errorCode, 'DEFINITION_CHANGED');
});

test('local usage and remote destination are independent catalogue and dispatch gates', async t => {
  for (const usage of ['local', 'shared'] as const) for (const destination of ['local', 'remote'] as const) {
    for (const allowLocalResults of [false, true]) for (const allowRemote of [false, true]) {
      await t.test(JSON.stringify({ usage, destination, allowLocalResults, allowRemote }), async t => {
        const f = fixture(t, { usage, destination });
        const policy = { allowLocalResults, allowRemote };
        const allowed = (usage === 'shared' || allowLocalResults) && (destination === 'local' || allowRemote);
        assert.equal(f.runtime.schemas(policy).length, Number(allowed));
        const result = await f.runtime.execute({ ...f.prepare(), ...policy });
        assert.equal(result.status, allowed ? 'succeeded' : 'denied');
        assert.equal(result.localOnly, usage === 'local');
        assert.equal(f.executions(), Number(allowed));
      });
    }
  }
});

test('explicit deny is excluded from schemas and rejected even with an advertised hash', async t => {
  const f = fixture(t, { permission: 'deny' });
  assert.deepEqual(f.runtime.schemas({ allowRemote: true, allowLocalResults: true }), []);
  assert.equal((await f.runtime.execute(f.prepare())).status, 'denied');
  assert.equal(f.executions(), 0);
});

test('approval snapshots and events cannot mutate the validated execution arguments', async t => {
  let received: unknown;
  const f = fixture(t, { permission: 'ask', execute: async args => { received = args; return { content: 'ok' }; } });
  f.bus.on('tool.approval', event => {
    ((event.data as { args: Record<string, unknown> }).args).value = 'event mutation';
  });
  const job = f.runtime.execute(f.prepare());
  await f.approvalReady(job);
  const approval = f.runtime.pending()[0]!;
  (approval.args as Record<string, unknown>).value = 'snapshot mutation';
  assert.deepEqual(f.runtime.pending()[0]!.args, { value: 1 });
  f.runtime.approve(approval.id, true, f.key);
  assert.equal((await job).status, 'succeeded');
  assert.deepEqual(received, { value: 1 });
  assert.equal(f.record().args, '{"value":1}');
});

test('quiesce waits for actual executor completion after cancellation returns unknown', async t => {
  const gate = deferred<{ content: string }>();
  const f = fixture(t, { execute: () => gate.promise });
  const job = f.runtime.execute(f.prepare());
  await f.started(job);
  let quiet = false;
  const quiescence = f.runtime.quiesce().then(() => { quiet = true; });
  try {
    assert.equal((await job).status, 'unknown');
    // A full event-loop turn lets an incorrectly resolved barrier settle deterministically.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(quiet, false);
  } finally {
    gate.resolve({ content: 'late result' });
    await quiescence;
  }
  assert.equal(quiet, true);
  assert.equal(f.record().status, 'unknown');
});

test('unsafe JSON values yield durable denials rather than journal exceptions', async t => {
  for (const args of ['{"value":"\\u0000"}', '{"value":1e400}', '{"value":{"nested":"\\u0000"}}']) {
    await t.test(args, async t => {
      const f = fixture(t, { parameters: { type: 'object' } });
      const result = await f.runtime.execute(f.prepare(args));
      assert.equal(result.status, 'denied');
      assert.equal(f.record().status, 'denied');
      assert.equal(f.record().args, '{}');
      assert.equal(f.executions(), 0);
    });
  }
});

test('NUL in executor output or read error is sanitized into durable results', async t => {
  for (const throwing of [false, true]) await t.test(String(throwing), async t => {
    const f = fixture(t, { effect: 'read', execute: async () => {
      if (throwing) throw new Error('bad\u0000error');
      return { content: 'before\u0000after' };
    } });
    const result = await f.runtime.execute(f.prepare());
    assert.equal(result.status, throwing ? 'failed' : 'succeeded');
    assert.equal(result.content.includes('\u0000'), false);
    assert.equal(result.content.includes('�'), true);
    assert.equal(f.record().content, result.content);
  });
});

test('cancelAll during asynchronous validation prevents dispatch and approval', async t => {
  for (const permission of ['allow', 'ask'] as const) await t.test(permission, async t => {
    const f = fixture(t, { permission });
    const job = f.runtime.execute(f.prepare());
    f.runtime.cancelAll();
    assert.equal((await job).status, 'cancelled');
    assert.equal(f.executions(), 0);
    assert.deepEqual(f.runtime.pending(), []);
  });
});

test('definition or permission change during asynchronous validation prevents dispatch', async t => {
  for (const change of [{ definitionHash: 'hash-2' }, { permission: 'deny' as const }]) await t.test(JSON.stringify(change), async t => {
    const f = fixture(t);
    const job = f.runtime.execute(f.prepare());
    f.replace([{ ...f.definition(), ...change }]);
    assert.equal((await job).status, 'denied');
    assert.equal(f.executions(), 0);
    assert.equal(f.record().errorCode, 'DEFINITION_CHANGED');
  });
});

test('cancelAll immediately after approval still prevents dispatch', async t => {
  const f = fixture(t, { permission: 'ask' });
  const job = f.runtime.execute(f.prepare());
  await f.approvalReady(job);
  f.runtime.approve(f.runtime.pending()[0]!.id, true, f.key);
  f.runtime.cancelAll();
  assert.equal((await job).status, 'cancelled');
  assert.equal(f.executions(), 0);
});

test('allow changed to ask during validation requires approval even with unchanged hash', async t => {
  const f = fixture(t);
  const job = f.runtime.execute(f.prepare());
  f.replace([{ ...f.definition(), permission: 'ask' }]);
  await f.approvalReady(job);
  assert.equal(f.executions(), 0);
  f.runtime.approve(f.runtime.pending()[0]!.id, true, f.key);
  assert.equal((await job).status, 'succeeded');
  assert.equal(f.executions(), 1);
});

test('usage destination and effect changes during validation reject despite unchanged hash', async t => {
  for (const change of [{ usage: 'local' as const }, { destination: 'remote' as const }, { effect: 'read' as const }]) {
    await t.test(JSON.stringify(change), async t => {
      const f = fixture(t);
      const job = f.runtime.execute(f.prepare());
      f.replace([{ ...f.definition(), ...change }]);
      assert.equal((await job).status, 'denied');
      assert.equal(f.executions(), 0);
    });
  }
});

test('concurrent duplicate validations dispatch at most one write', async t => {
  const f = fixture(t);
  const input = f.prepare();
  const results = await Promise.all([f.runtime.execute(input), f.runtime.execute(input)]);
  assert.equal(f.executions(), 1);
  assert.ok(results.some(result => result.status === 'succeeded'));
  assert.equal(f.record().status, 'succeeded');
});

test('cancellation from started event must not dispatch executor', async t => {
  const f = fixture(t);
  f.bus.on('tool.started', () => f.controller.abort());
  const result = await f.runtime.execute(f.prepare());
  assert.equal(f.executions(), 0);
  assert.equal(result.status, 'cancelled');
});
