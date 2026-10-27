import test from 'node:test'
import assert from 'node:assert/strict'
import { builtinTools } from '../src/builtin-tools.ts'
import type { ActionInput, ActionManager } from '../src/actions.ts'
import type { MemoryStore } from '../src/memory/store.ts'
import type { ReminderStore } from '../src/proactive/reminders.ts'
import { validateToolArguments } from '../src/tool-schema.ts'

function fixture() {
  const proposals: ActionInput[] = []
  const approvals: string[] = []
  const actions = {
    propose(input: ActionInput) { proposals.push(input); return { id: `a${proposals.length}` } },
    async approve(id: string) { approvals.push(id); return { id, status: 'executed', label: 'opened' } },
  } as unknown as ActionManager
  const tools = builtinTools({ actions, memory: {} as MemoryStore, reminders: {} as ReminderStore })
  return { tools, proposals, approvals, url: tools.find(t => t.name === 'open_url')!, app: tools.find(t => t.name === 'open_app')! }
}
const context = { signal: new AbortController().signal, sessionId: 's', turnId: 't', callId: 'c' }

test('separate opening tools preserve permission boundaries and compatibility alias', async () => {
  const { tools, url, app } = fixture()
  assert.ok(tools.some(t => t.name === 'open_target'))
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length)
  for (const tool of [url, app]) {
    assert.equal(tool.permission, 'ask'); assert.equal(tool.effect, 'write'); assert.equal(tool.usage, 'shared')
    assert.match(tool.definitionHash, /^[0-9a-f]{64}$/)
  }
  assert.equal(url.destination, 'remote'); assert.equal(app.destination, 'local')
  assert.equal((await validateToolArguments(app.parameters, { app: 'terminal' }, context.signal)).valid, false)
  assert.equal((await validateToolArguments(url.parameters, { url: 'https://example.com', extra: true }, context.signal)).valid, false)
})

test('URL tool rejects unsafe targets before action dispatch and preserves exact URLs', async () => {
  const { url, proposals, approvals } = fixture()
  for (const target of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.com', 'https://user@example.com', 'https://example.com/\nother', 'open https://example.com', 'https:example.com', 'https://', '']) {
    assert.equal((await url.execute({ url: target }, context)).isError, true, target)
  }
  assert.deepEqual(proposals, []); assert.deepEqual(approvals, [])
  for (const target of ['https://example.com/path?q=a%20b&x=。', 'http://localhost:3000/', 'https://example.com/#anchor']) {
    const result = await url.execute({ url: target }, context)
    assert.equal(result.isError, undefined)
    assert.deepEqual(proposals.at(-1), { kind: 'open-url', target })
    assert.equal(JSON.parse(result.content).status, 'executed')
  }
  assert.equal(approvals.length, 3)
})

test('app tool uses exact allowlist mapping and cancellation prevents all dispatch', async () => {
  const { app, url, proposals, approvals } = fixture()
  for (const target of ['terminal', 'files', 'https://example.com', 'browser --flag', null]) {
    assert.equal((await app.execute({ app: target }, context)).isError, true)
  }
  await app.execute({ app: 'browser' }, context)
  await app.execute({ app: 'file-manager' }, context)
  assert.deepEqual(proposals, [{ kind: 'open-app', target: 'browser' }, { kind: 'open-app', target: 'files' }])
  assert.deepEqual(approvals, ['a1', 'a2'])
  const aborted = { ...context, signal: AbortSignal.abort() }
  await assert.rejects(app.execute({ app: 'browser' }, aborted), /已取消/)
  await assert.rejects(url.execute({ url: 'https://example.com' }, aborted), /已取消/)
  assert.equal(proposals.length, 2)
})

test('current time returns matching local and UTC representations of one instant', async () => {
  const tool = fixture().tools.find(t => t.name === 'current_time')!
  const result = JSON.parse((await tool.execute({}, context)).content)
  assert.equal(result.local, new Date(result.iso).toLocaleString('zh-CN'))
  assert.equal(result.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone)
})
