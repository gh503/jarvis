import assert from 'node:assert/strict'
import test from 'node:test'
import { NodeCommandWorker, NodePolicy } from '../dist/node-command.js'

const policy = () => new NodePolicy({
  capabilities: {
    system_status: { version: 1 },
    open_app: { version: 1, allowedApplications: ['notes'] },
  },
})

const command = (overrides = {}) => ({
  commandId: 'command-1',
  idempotencyKey: 'idempotency-1',
  nodeId: 'node-1',
  capability: 'open_app',
  capabilityVersion: 1,
  arguments: { application: 'notes' },
  expiresAt: 10_000,
  ...overrides,
})

test('acknowledgement is distinct from terminal success and duplicate delivery executes once', async () => {
  const transitions = []
  let executions = 0
  const worker = new NodeCommandWorker('node-1', policy(), async () => {
    executions += 1
    return { launched: true }
  }, () => 1_000, 1, transition => transitions.push(transition.state))

  const first = worker.dispatch(command())
  const duplicate = worker.dispatch(command({ commandId: 'different-delivery' }))
  assert.deepEqual(await first, {
    commandId: 'command-1',
    idempotencyKey: 'idempotency-1',
    capability: 'open_app',
    state: 'succeeded',
    result: { launched: true },
  })
  assert.strictEqual(await duplicate, await first)
  assert.equal(executions, 1)
  assert.deepEqual(transitions, ['acknowledged', 'running', 'succeeded'])
})

test('expired queued command never reaches the executor', async () => {
  let now = 1_000
  let releaseFirst
  const firstStarted = new Promise(resolve => { releaseFirst = resolve })
  let executions = 0
  const worker = new NodeCommandWorker('node-1', policy(), async () => {
    executions += 1
    if (executions === 1) await firstStarted
    return true
  }, () => now, 1)

  const first = worker.dispatch(command())
  const second = worker.dispatch(command({ commandId: 'command-2', idempotencyKey: 'idempotency-2', expiresAt: 1_500 }))
  now = 2_000
  releaseFirst()
  assert.equal((await first).state, 'succeeded')
  assert.equal((await second).state, 'expired')
  assert.equal(executions, 1)
})

test('local policy denies wrong node, unsupported capability version, and application', async () => {
  const executed = []
  const worker = new NodeCommandWorker('node-1', policy(), async input => {
    executed.push(input)
    return true
  }, () => 1_000)
  assert.equal((await worker.dispatch(command({ nodeId: 'node-2' }))).state, 'denied')
  assert.equal((await worker.dispatch(command({ idempotencyKey: 'version', capabilityVersion: 2 }))).state, 'denied')
  assert.equal((await worker.dispatch(command({ idempotencyKey: 'app', arguments: { application: 'terminal' } }))).state, 'denied')
  assert.equal(executed.length, 0)
})

test('idempotency key cannot be reused with changed command data', async () => {
  let executions = 0
  const worker = new NodeCommandWorker('node-1', policy(), async () => {
    executions += 1
    return true
  }, () => 1_000)
  const first = worker.dispatch(command())
  const changed = await worker.dispatch(command({ arguments: { application: 'terminal' } }))
  assert.equal(changed.state, 'denied')
  assert.match(changed.error ?? '', /different command/)
  assert.equal((await first).state, 'succeeded')
  assert.equal(executions, 1)
})

test('emergency pause applies to new commands', async () => {
  const localPolicy = policy()
  localPolicy.setPaused(true)
  const worker = new NodeCommandWorker('node-1', localPolicy, async () => true, () => 1_000)
  assert.equal((await worker.dispatch(command())).state, 'denied')
})
