import assert from 'node:assert/strict'
import test from 'node:test'
import { ApprovalLedger, commandDigest } from '../dist/approval.js'

test('command digest is deterministic across object key order', () => {
  assert.equal(
    commandDigest({ application: 'notes', action: 'open_app' }),
    commandDigest({ action: 'open_app', application: 'notes' }),
  )
  assert.notEqual(commandDigest({ application: 'notes' }), commandDigest({ application: 'safari' }))
})

test('consumes an approval exactly once', () => {
  const ledger = new ApprovalLedger(() => 1_000, 60_000)
  const command = { action: 'open_app', application: 'notes' }
  const record = ledger.propose('call-1', command)
  assert.equal(ledger.consume('call-1', command).digest, record.digest)
  assert.throws(() => ledger.consume('call-1', command), /missing or already consumed/)
  assert.throws(() => ledger.propose('call-1', command), /already been used/)
})

test('rejects an expired approval before dispatch', () => {
  let now = 1_000
  const ledger = new ApprovalLedger(() => now, 60_000)
  const command = { action: 'open_app', application: 'notes' }
  ledger.propose('call-expired', command)
  now = 61_000
  assert.throws(() => ledger.consume('call-expired', command), /expired/)
})

test('rejects a changed command and permanently consumes the call id', () => {
  const ledger = new ApprovalLedger(() => 1_000, 60_000)
  ledger.propose('call-mutated', { action: 'open_app', application: 'notes' })
  assert.throws(
    () => ledger.consume('call-mutated', { action: 'open_app', application: 'safari' }),
    /does not match/,
  )
  assert.throws(() => ledger.consume('call-mutated', { action: 'open_app', application: 'notes' }), /missing or already consumed/)
})
