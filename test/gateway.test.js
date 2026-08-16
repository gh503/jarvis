import assert from 'node:assert/strict'
import test from 'node:test'
import { createJarvisGateway } from '../dist/gateway.js'
import { PairingAuthority, createDeviceIdentity } from '../dist/pairing.js'

const ownerToken = 'owner-token-for-gateway-tests'

async function request(gateway, path, options = {}) {
  return fetch(`http://127.0.0.1:${gateway.port}${path}`, options)
}

test('serves loopback health and protects versioned routes with owner auth', async () => {
  const service = createJarvisGateway({ ownerToken })
  const gateway = await service.start()
  try {
    assert.equal(new URL(`http://127.0.0.1:${gateway.port}`).hostname, '127.0.0.1')
    const health = await request(gateway, '/v1/health')
    assert.equal(health.status, 200)
    assert.equal((await health.json()).scope, 'loopback-only')
    const unauthorized = await request(gateway, '/v1/pairing/requests', { method: 'POST' })
    assert.equal(unauthorized.status, 401)
    assert.match(unauthorized.headers.get('x-correlation-id') ?? '', /^[0-9a-f-]{36}$/)
  } finally {
    await service.stop()
  }
})

test('runs authenticated pairing, device rotation, and owner revocation over versioned HTTP', async () => {
  const authority = new PairingAuthority(() => 1_000, 60_000)
  const service = createJarvisGateway({ ownerToken, authority })
  const gateway = await service.start()
  try {
    const identity = createDeviceIdentity()
    const headers = { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }
    const created = await request(gateway, '/v1/pairing/requests', {
      method: 'POST', headers, body: JSON.stringify({
        nodeId: 'node-1', publicKey: identity.publicKey, displayName: 'Test Mac', platform: 'macos',
      }),
    })
    assert.equal(created.status, 201)
    const pairing = await created.json()
    const confirmed = await request(gateway, '/v1/pairing/requests/confirm', {
      method: 'POST', headers, body: JSON.stringify({ requestId: pairing.requestId, verificationCode: pairing.verificationCode }),
    })
    assert.equal(confirmed.status, 200)
    const first = await confirmed.json()
    const rotated = await request(gateway, '/v1/devices/node-1', {
      method: 'POST', headers: { authorization: `Device ${first.credential}` },
    })
    assert.equal(rotated.status, 200)
    const second = await rotated.json()
    assert.equal(authority.authenticate('node-1', first.credential), false)
    assert.equal(authority.authenticate('node-1', second.credential), true)
    const revoked = await request(gateway, '/v1/devices/node-1', { method: 'DELETE', headers: { authorization: `Bearer ${ownerToken}` } })
    assert.equal(revoked.status, 204)
    assert.equal(authority.authenticate('node-1', second.credential), false)
    const rejectedRotation = await request(gateway, '/v1/devices/node-1', {
      method: 'POST', headers: { authorization: `Device ${second.credential}` },
    })
    assert.equal(rejectedRotation.status, 400)
  } finally {
    await service.stop()
  }
})

test('rejects oversized and malformed requests without exposing secrets', async () => {
  const service = createJarvisGateway({ ownerToken, maxBodyBytes: 32 })
  const gateway = await service.start()
  try {
    const response = await request(gateway, '/v1/pairing/requests', {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'this body is larger than thirty two bytes' }),
    })
    assert.equal(response.status, 413)
    assert.doesNotMatch(await response.text(), /owner-token-for-gateway-tests/)
  } finally {
    await service.stop()
  }
})
