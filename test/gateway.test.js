import assert from 'node:assert/strict'
import test from 'node:test'
import WebSocket from 'ws'
import { createJarvisGateway } from '../dist/gateway.js'
import { NodeAgent } from '../dist/node-agent.js'
import { MAC_NODE_CAPABILITIES } from '../dist/node-capabilities.js'
import { NodePolicy } from '../dist/node-command.js'
import { PairingAuthority, createDeviceIdentity } from '../dist/pairing.js'

const ownerToken = 'owner-token-for-gateway-tests'

async function request(gateway, path, options = {}) {
  return fetch(`http://127.0.0.1:${gateway.port}${path}`, options)
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function issueCredential(authority, nodeId = 'node-1') {
  const identity = createDeviceIdentity()
  const pairing = authority.createRequest({
    nodeId,
    publicKey: identity.publicKey,
    displayName: 'Test Mac',
    platform: 'macos',
  })
  return authority.confirm(pairing.requestId, pairing.verificationCode).credential
}

function nodeAgentConfig(endpoint, credential, socketFactory, execute) {
  return {
    endpoint,
    credential,
    socketFactory,
    reconnectDelayMs: 20,
    registration: {
      nodeId: 'node-1',
      platform: 'macos',
      softwareVersion: '0.2.0-dev',
      capabilities: Object.values(MAC_NODE_CAPABILITIES),
    },
    policy: new NodePolicy({ capabilities: { system_status: { version: 1 } } }),
    execute,
  }
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

test('isolates the node WebSocket path and requires authentication as the first message', async () => {
  const service = createJarvisGateway({ ownerToken })
  const gateway = await service.start()
  try {
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/not-a-node`)
      socket.once('open', resolve)
      socket.once('error', reject)
    }), /Unexpected server response: 404/)
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/node`, { origin: 'https://untrusted.example' })
      socket.once('open', resolve)
      socket.once('error', reject)
    }), /Unexpected server response: 403/)

    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/node`)
    const rejection = await new Promise((resolve, reject) => {
      socket.once('open', () => socket.send(JSON.stringify({ type: 'node.register', registration: {} })))
      socket.once('message', data => resolve(JSON.parse(data.toString())))
      socket.once('error', reject)
    })
    assert.equal(rejection.type, 'node.rejected')
    assert.equal(rejection.reason, 'node authentication rejected')
    socket.close()
  } finally {
    await service.stop()
  }
})

test('authenticates a real node, preserves idempotency across reconnect, and revokes active access', async () => {
  const authority = new PairingAuthority()
  const credential = issueCredential(authority)
  const service = createJarvisGateway({ ownerToken, authority })
  let gateway = await service.start()
  let executions = 0
  const socketFactory = () => new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/node`)
  const agent = new NodeAgent(nodeAgentConfig(
    `wss://127.0.0.1:${gateway.port}/v1/node`,
    credential,
    socketFactory,
    async () => {
      executions += 1
      return { hostname: 'test-mac' }
    },
  ))
  const command = {
    commandId: 'gateway-command-1',
    idempotencyKey: 'gateway-idempotency-1',
    nodeId: 'node-1',
    capability: 'system_status',
    capabilityVersion: 1,
    arguments: {},
    expiresAt: Date.now() + 60_000,
  }
  let rejectedAgent
  try {
    await agent.start()
    await waitFor(() => agent.state === 'ready', 'node did not become ready')
    assert.deepEqual(service.connectedNodeIds(), ['node-1'])
    assert.equal(service.dispatchCommand(command), true)
    await waitFor(() => executions === 1, 'node did not execute the first command')

    const port = gateway.port
    await service.stop()
    await waitFor(() => agent.state !== 'ready', 'node did not observe the gateway shutdown')
    gateway = await service.start(port)
    await waitFor(
      () => agent.state === 'ready' && service.connectedNodeIds().includes('node-1'),
      'node did not reconnect after gateway restart',
    )
    assert.equal(service.dispatchCommand(command), true)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(executions, 1)

    const revoked = await request(gateway, '/v1/devices/node-1', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ownerToken}` },
    })
    assert.equal(revoked.status, 204)
    await waitFor(() => agent.state === 'stopped', 'revoked active node did not stop')
    await waitFor(() => service.connectedNodeIds().length === 0, 'revoked node remained online')

    rejectedAgent = new NodeAgent(nodeAgentConfig(
      `wss://127.0.0.1:${gateway.port}/v1/node`,
      credential,
      socketFactory,
      async () => { throw new Error('revoked node must not execute') },
    ))
    await rejectedAgent.start()
    await waitFor(() => rejectedAgent.state === 'stopped', 'revoked node reconnect was not rejected')
    assert.deepEqual(service.connectedNodeIds(), [])
  } finally {
    rejectedAgent?.stop()
    agent.stop()
    await service.stop()
  }
})
