import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserPairingApprovalCoordinator } from '../dist/pairing-approval.js'

const ownerToken = 'owner-token-for-approval-tests'

test('submits one six-digit approval to a loopback Gateway', async () => {
  const calls = []
  const coordinator = new BrowserPairingApprovalCoordinator('http://127.0.0.1:3090', ownerToken, async (url, init) => {
    calls.push({ url: url.toString(), init })
    return new Response(JSON.stringify({
      requestId: 'request-id-valid-1234',
      nodeId: 'pwa-phone',
      displayName: 'Owner Phone',
      platform: 'pwa',
      approvedAt: 1_000,
      expiresAt: 61_000,
    }), { status: 200 })
  })
  const approved = await coordinator.approve('123456')
  assert.equal(approved.nodeId, 'pwa-phone')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:3090/v1/pairing/requests/approve')
  assert.equal(calls[0].init.headers.authorization, `Bearer ${ownerToken}`)
  assert.deepEqual(JSON.parse(calls[0].init.body), { verificationCode: '123456' })
})

test('rejects remote origins, malformed codes, and invalid Gateway responses', async () => {
  assert.throws(() => new BrowserPairingApprovalCoordinator('https://gateway.example', ownerToken), /127\.0\.0\.1/)
  const coordinator = new BrowserPairingApprovalCoordinator(
    'http://127.0.0.1:3090', ownerToken, async () => new Response('{}', { status: 200 }),
  )
  await assert.rejects(coordinator.approve('12345'), /six digits/)
  await assert.rejects(coordinator.approve('123456'), /invalid pairing approval/)
})
