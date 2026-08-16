import assert from 'node:assert/strict'
import test from 'node:test'
import { DeviceApprovalGate } from '../dist/device-approval.js'

const command = (overrides = {}) => ({
  commandId: 'command-lock',
  idempotencyKey: 'once-lock',
  capability: 'lock.set',
  externalEntityId: 'lock.front_door',
  service: 'lock_unlock',
  serviceData: { user: 'owner', token: 'provider-secret' },
  expectedState: 'unlocked',
  ...overrides,
})

test('creates a redacted high-risk approval and authorizes the exact command once', () => {
  const gate = new DeviceApprovalGate(() => 1_000, 60_000)
  const request = gate.request('approval-lock-1', command())
  assert.equal(request.risk, 'high')
  assert.equal(request.externalEntityId, 'lock.front_door')
  assert.equal('serviceData' in request, false)
  assert.equal(JSON.stringify(request).includes('provider-secret'), false)
  const authorization = gate.authorize('approval-lock-1', command())
  assert.deepEqual(authorization, {
    approvalId: 'approval-lock-1',
    digest: request.digest,
    risk: 'high',
    allowedOnce: true,
    approvedAt: 1_000,
    expiresAt: 61_000,
  })
  assert.throws(() => gate.authorize('approval-lock-1', command()), /missing or already consumed/)
})

test('rejects mutated, expired, cancelled, and low-risk approval requests', () => {
  const gate = new DeviceApprovalGate(() => 1_000, 60_000)
  gate.request('approval-mutated', command())
  assert.throws(() => gate.authorize('approval-mutated', command({ externalEntityId: 'lock.back_door' })), /does not match/)
  assert.throws(() => gate.authorize('approval-mutated', command()), /missing or already consumed/)

  let now = 1_000
  const expiring = new DeviceApprovalGate(() => now, 60_000)
  expiring.request('approval-expired', command())
  now = 61_000
  assert.throws(() => expiring.authorize('approval-expired', command()), /expired/)

  const cancelled = new DeviceApprovalGate(() => 1_000)
  cancelled.request('approval-cancelled', command())
  cancelled.cancel('approval-cancelled')
  assert.throws(() => cancelled.authorize('approval-cancelled', command()), /missing or already consumed/)
  assert.throws(() => cancelled.request('approval-low', { ...command(), capability: 'switch.set' }), /only for mandatory high-risk/)
})

test('digest is stable across object key order but changes target or arguments', () => {
  const gate = new DeviceApprovalGate(() => 1_000)
  const first = command()
  const reordered = { ...first, serviceData: { token: 'provider-secret', user: 'owner' } }
  assert.equal(gate.digest(first), gate.digest(reordered))
  assert.notEqual(gate.digest(first), gate.digest(command({ serviceData: { user: 'other', token: 'provider-secret' } })))
})
