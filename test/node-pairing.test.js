import assert from 'node:assert/strict'
import test from 'node:test'
import { createJarvisGateway } from '../dist/gateway.js'
import { NodePairingCoordinator } from '../dist/node-pairing.js'
import { PairingAuthority, createDeviceIdentity } from '../dist/pairing.js'

const ownerToken = 'owner-token-for-pairing-tests'

test('pairs through the real Gateway only after human code confirmation', async () => {
  const authority = new PairingAuthority()
  const identity = createDeviceIdentity()
  const credentials = []
  const service = createJarvisGateway({ ownerToken, authority })
  const gateway = await service.start()
  try {
    const coordinator = new NodePairingCoordinator(
      `http://127.0.0.1:${gateway.port}`,
      ownerToken,
      { loadOrCreate: async () => identity },
      { write: async (nodeId, credential) => credentials.push({ nodeId, credential }) },
    )
    const challenge = await coordinator.begin({ nodeId: 'node-1', displayName: 'Test Mac' })
    assert.equal(challenge.fingerprint, identity.fingerprint)
    assert.match(challenge.verificationCode, /^\d{6}$/)
    await assert.rejects(coordinator.confirm(challenge.requestId, 'not-the-code'), /not confirmed/)
    assert.equal(credentials.length, 0)

    const paired = await coordinator.confirm(challenge.requestId, challenge.verificationCode)
    assert.deepEqual(paired, {
      nodeId: 'node-1',
      publicKey: identity.publicKey,
      fingerprint: identity.fingerprint,
      generation: 1,
      issuedAt: paired.issuedAt,
    })
    assert.equal(credentials.length, 1)
    assert.equal(authority.authenticate('node-1', credentials[0].credential), true)
    await assert.rejects(coordinator.confirm(challenge.requestId, challenge.verificationCode), /not active/)
  } finally {
    await service.stop()
  }
})

test('revokes the issued Gateway credential when local Keychain storage fails', async () => {
  const authority = new PairingAuthority()
  const identity = createDeviceIdentity()
  let issuedCredential
  const service = createJarvisGateway({ ownerToken, authority })
  const gateway = await service.start()
  try {
    const coordinator = new NodePairingCoordinator(
      `http://127.0.0.1:${gateway.port}`,
      ownerToken,
      { loadOrCreate: async () => identity },
      {
        write: async (_nodeId, credential) => {
          issuedCredential = credential
          throw new Error('simulated keychain failure')
        },
      },
    )
    const challenge = await coordinator.begin({ nodeId: 'node-1', displayName: 'Test Mac' })
    await assert.rejects(
      coordinator.confirm(challenge.requestId, challenge.verificationCode),
      /paired device was revoked/,
    )
    assert.equal(typeof issuedCredential, 'string')
    assert.equal(authority.authenticate('node-1', issuedCredential), false)
  } finally {
    await service.stop()
  }
})

test('rejects non-loopback gateways and identity changes in Gateway responses', async () => {
  const identity = createDeviceIdentity()
  const dependencies = [
    { loadOrCreate: async () => identity },
    { write: async () => {} },
  ]
  assert.throws(
    () => new NodePairingCoordinator('https://gateway.example', ownerToken, ...dependencies),
    /127\.0\.0\.1/,
  )
  assert.throws(
    () => new NodePairingCoordinator('http://localhost:3090', ownerToken, ...dependencies),
    /127\.0\.0\.1/,
  )

  const coordinator = new NodePairingCoordinator(
    'http://127.0.0.1:3090',
    ownerToken,
    ...dependencies,
    async () => new Response(JSON.stringify({
      requestId: 'valid-request-id-1234',
      nodeId: 'another-node',
      publicKey: identity.publicKey,
      displayName: 'Test Mac',
      platform: 'macos',
      verificationCode: '123456',
      expiresAt: Date.now() + 60_000,
    }), { status: 201 }),
  )
  await assert.rejects(coordinator.begin({ nodeId: 'node-1', displayName: 'Test Mac' }), /invalid pairing challenge/)
  await assert.rejects(coordinator.begin({ nodeId: 'node-1', displayName: 'Fake\u001b[2JMac' }), /control characters/)
})
