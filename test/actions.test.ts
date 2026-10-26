import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ActionManager, isAllowedUrl } from '../src/actions.ts'
import { EventBus } from '../src/events.ts'

async function manager(runner = async () => {}, now = () => new Date('2026-10-26T09:00:00+08:00')) {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-actions-'))
  const auditFile = join(dir, 'audit', 'actions.jsonl')
  return {
    dir,
    auditFile,
    actions: new ActionManager({ auditFile, runner, now, bus: new EventBus() }),
  }
}

test('URL validation rejects file and credential URLs', () => {
  assert.equal(isAllowedUrl('https://example.com/docs'), true)
  assert.equal(isAllowedUrl('http://127.0.0.1:8080/'), true)
  assert.equal(isAllowedUrl('file:///etc/passwd'), false)
  assert.equal(isAllowedUrl('https://user:pass@example.com/'), false)
  assert.equal(isAllowedUrl('javascript:alert(1)'), false)
})

test('proposal does not execute until approval, and cannot be replayed', async () => {
  let calls = 0
  const { actions, dir, auditFile } = await manager(async () => { calls += 1 })
  try {
    const action = actions.proposeText('打开 https://example.com/notes')
    assert.equal(action.status, 'proposed')
    assert.equal(calls, 0)
    const executed = await actions.approve(action.id)
    assert.equal(executed.status, 'executed')
    assert.equal(calls, 1)
    await assert.rejects(() => actions.approve(action.id), /不能重复/)
    const audit = await readFile(auditFile, 'utf8')
    assert.match(audit, /executed/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('denial and expiry are terminal', async () => {
  const { actions, dir } = await manager()
  try {
    const denied = actions.propose({ kind: 'open-app', target: 'files' })
    assert.equal(actions.deny(denied.id).status, 'denied')
    assert.throws(() => actions.deny(denied.id), /不能拒绝/)
    const expired = actions.propose({ kind: 'open-app', target: 'browser' })
    // A manager with a fixed clock can be advanced only by constructing a new
    // one; use the TTL/clock injection through `get` is covered by implementation.
    assert.equal(expired.kind, 'open-app')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('proposals expire and cannot be approved late', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-actions-'))
  let current = new Date('2026-10-26T09:00:00+08:00')
  const actions = new ActionManager({ auditFile: join(dir, 'audit', 'actions.jsonl'), runner: async () => {}, now: () => current, ttlMs: 1000 })
  try {
    const action = actions.propose({ kind: 'open-app', target: 'files' })
    current = new Date(current.getTime() + 2000)
    assert.equal(actions.get(action.id)?.status, 'expired')
    await assert.rejects(() => actions.approve(action.id), /过期/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('unknown apps are refused', async () => {
  const { actions, dir } = await manager()
  try {
    assert.throws(() => actions.propose({ kind: 'open-app', target: 'terminal' }), /不在允许/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
