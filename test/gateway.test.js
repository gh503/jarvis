import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import { createJarvisGateway } from '../dist/gateway.js'
import { NodeAgent } from '../dist/node-agent.js'
import { MAC_NODE_CAPABILITIES } from '../dist/node-capabilities.js'
import { NodePolicy } from '../dist/node-command.js'
import { PairingAuthority, createDeviceIdentity } from '../dist/pairing.js'
import { SessionAuthority } from '../dist/sessions.js'

const ownerToken = 'owner-token-for-gateway-tests'

async function request(gateway, path, options = {}) {
  if (!gateway.secure) return fetch(`${gateway.origin}${path}`, options)
  return new Promise((resolve, reject) => {
    const requestValue = httpsRequest(`${gateway.origin}${path}`, {
      method: options.method,
      headers: options.headers,
      rejectUnauthorized: false,
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve({
          status: response.statusCode,
          headers: {
            get(name) {
              const value = response.headers[name.toLowerCase()]
              return Array.isArray(value) ? value.join(', ') : value ?? null
            },
          },
          json: async () => JSON.parse(body),
          text: async () => body,
        })
      })
    })
    requestValue.once('error', reject)
    if (options.body !== undefined) requestValue.write(options.body)
    requestValue.end()
  })
}

async function createTlsMaterial() {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-gateway-tls-'))
  const keyPath = join(directory, 'key.pem')
  const certPath = join(directory, 'cert.pem')
  execFileSync('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-subj', '/CN=127.0.0.1', '-days', '1',
    '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' })
  return {
    tls: { key: await readFile(keyPath), cert: await readFile(certPath) },
    keyPath,
    certPath,
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
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
    assert.deepEqual(await health.json(), {
      service: 'jarvis-gateway', status: 'ok', scope: 'loopback-only', transport: 'http',
    })
    const unauthorized = await request(gateway, '/v1/pairing/requests', { method: 'POST' })
    assert.equal(unauthorized.status, 401)
    assert.match(unauthorized.headers.get('x-correlation-id') ?? '', /^[0-9a-f-]{36}$/)
  } finally {
    await service.stop()
  }
})

test('rejects public, wildcard, named, and plaintext private-network bindings', () => {
  assert.throws(() => createJarvisGateway({ ownerToken, bindHost: '0.0.0.0' }), /specific loopback/)
  assert.throws(() => createJarvisGateway({ ownerToken, bindHost: '8.8.8.8' }), /specific loopback/)
  assert.throws(() => createJarvisGateway({ ownerToken, bindHost: 'gateway.local' }), /specific loopback/)
  assert.throws(() => createJarvisGateway({ ownerToken, bindHost: '100.64.0.10' }), /TLS is required/)
  assert.doesNotThrow(() => createJarvisGateway({
    ownerToken,
    bindHost: '100.64.0.10',
    tls: { key: 'configured-key', cert: 'configured-cert' },
  }))
})

test('gateway entrypoint rejects incomplete TLS and permissive private-key files', async () => {
  const material = await createTlsMaterial()
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('JARVIS_GATEWAY_TLS_')),
  )
  try {
    const incomplete = spawnSync(process.execPath, ['dist/gateway-main.js'], {
      encoding: 'utf8',
      env: {
        ...environment,
        JARVIS_OWNER_TOKEN: ownerToken,
        JARVIS_GATEWAY_PORT: '0',
        JARVIS_GATEWAY_TLS_KEY: material.keyPath,
      },
    })
    assert.notEqual(incomplete.status, 0)
    assert.match(incomplete.stderr, /must be configured together/)

    await chmod(material.keyPath, 0o644)
    const permissive = spawnSync(process.execPath, ['dist/gateway-main.js'], {
      encoding: 'utf8',
      env: {
        ...environment,
        JARVIS_OWNER_TOKEN: ownerToken,
        JARVIS_GATEWAY_PORT: '0',
        JARVIS_GATEWAY_TLS_KEY: material.keyPath,
        JARVIS_GATEWAY_TLS_CERT: material.certPath,
        JARVIS_DATA_DIR: material.directory,
      },
    })
    assert.notEqual(permissive.status, 0)
    assert.match(permissive.stderr, /mode 0600 or stricter/)
  } finally {
    await material.cleanup()
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

test('issues, refreshes, inventories, and revokes device-bound access sessions', async () => {
  let now = 10_000
  const authority = new PairingAuthority()
  const credential = issueCredential(authority)
  const sessions = new SessionAuthority({
    now: () => now,
    accessTtlMs: 1_000,
    refreshTtlMs: 10_000,
  })
  const service = createJarvisGateway({ ownerToken, authority, sessions })
  const gateway = await service.start()
  const deviceHeaders = { authorization: `Device ${credential}`, 'content-type': 'application/json' }
  const ownerHeaders = { authorization: `Bearer ${ownerToken}` }
  let lastCreateResponse
  const createSession = async () => {
    const response = await request(gateway, '/v1/sessions', {
      method: 'POST', headers: deviceHeaders, body: JSON.stringify({ nodeId: 'node-1' }),
    })
    assert.equal(response.status, 201)
    lastCreateResponse = response
    return response.json()
  }
  try {
    const unauthorized = await request(gateway, '/v1/sessions')
    assert.equal(unauthorized.status, 401)
    const badDevice = await request(gateway, '/v1/sessions', {
      method: 'POST',
      headers: { authorization: 'Device invalid-device-credential', 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-1' }),
    })
    assert.equal(badDevice.status, 401)

    const first = await createSession()
    assert.equal(lastCreateResponse.headers.get('cache-control'), 'no-store')
    const current = await request(gateway, '/v1/sessions/current', {
      headers: { authorization: `Session ${first.accessToken}` },
    })
    assert.equal(current.status, 200)
    assert.equal((await current.json()).nodeId, 'node-1')

    const inventory = await request(gateway, '/v1/sessions', { headers: ownerHeaders })
    assert.equal(inventory.status, 200)
    const inventoryText = await inventory.text()
    assert.doesNotMatch(inventoryText, new RegExp(first.accessToken))
    assert.doesNotMatch(inventoryText, new RegExp(first.refreshToken))
    assert.equal(JSON.parse(inventoryText).sessions[0].sessionId, first.sessionId)

    now += 500
    const refreshedResponse = await request(gateway, '/v1/sessions/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: first.refreshToken }),
    })
    assert.equal(refreshedResponse.status, 200)
    const refreshed = await refreshedResponse.json()
    assert.equal((await request(gateway, '/v1/sessions/current', {
      headers: { authorization: `Session ${first.accessToken}` },
    })).status, 401)
    assert.equal((await request(gateway, '/v1/sessions/current', {
      headers: { authorization: `Session ${refreshed.accessToken}` },
    })).status, 200)

    const reused = await request(gateway, '/v1/sessions/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: first.refreshToken }),
    })
    assert.equal(reused.status, 401)
    assert.equal((await reused.json()).code, 'refresh_reuse_detected')
    assert.equal((await request(gateway, '/v1/sessions/current', {
      headers: { authorization: `Session ${refreshed.accessToken}` },
    })).status, 401)

    const ownerRevoked = await createSession()
    assert.equal((await request(gateway, `/v1/sessions/${ownerRevoked.sessionId}`, {
      method: 'DELETE', headers: ownerHeaders,
    })).status, 204)
    assert.equal((await request(gateway, '/v1/sessions/current', {
      headers: { authorization: `Session ${ownerRevoked.accessToken}` },
    })).status, 401)

    const deviceRevoked = await createSession()
    assert.equal((await request(gateway, '/v1/devices/node-1', {
      method: 'DELETE', headers: ownerHeaders,
    })).status, 204)
    assert.equal((await request(gateway, '/v1/sessions/current', {
      headers: { authorization: `Session ${deviceRevoked.accessToken}` },
    })).status, 401)
    assert.equal(sessions.get(deviceRevoked.sessionId).revokeReason, 'device')
  } finally {
    await service.stop()
  }
})

test('fails closed when persisted device revocation precedes session revocation', async () => {
  const authority = new PairingAuthority()
  const credential = issueCredential(authority)
  const sessions = new SessionAuthority()
  const tokens = sessions.issue('node-1')
  assert.equal(authority.authenticate('node-1', credential), true)
  assert.equal(authority.revoke('node-1'), true)

  const service = createJarvisGateway({ ownerToken, authority, sessions })
  const gateway = await service.start()
  try {
    const response = await request(gateway, '/v1/sessions/current', {
      headers: { authorization: `Session ${tokens.accessToken}` },
    })
    assert.equal(response.status, 401)
    assert.equal(sessions.get(tokens.sessionId).revokeReason, 'device')
  } finally {
    await service.stop()
  }
})

test('restores Gateway access sessions from digest-only state after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-gateway-sessions-'))
  const sessionStatePath = join(directory, 'session-state.json')
  const authority = new PairingAuthority()
  const credential = issueCredential(authority)
  let service = createJarvisGateway({ ownerToken, authority, sessionStatePath })
  let gateway = await service.start()
  try {
    const issuedResponse = await request(gateway, '/v1/sessions', {
      method: 'POST',
      headers: { authorization: `Device ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-1' }),
    })
    assert.equal(issuedResponse.status, 201)
    const issued = await issuedResponse.json()
    await service.stop()

    const stored = await readFile(sessionStatePath, 'utf8')
    assert.doesNotMatch(stored, new RegExp(issued.accessToken))
    assert.doesNotMatch(stored, new RegExp(issued.refreshToken))
    service = createJarvisGateway({ ownerToken, authority, sessionStatePath })
    gateway = await service.start()
    const restored = await request(gateway, '/v1/sessions/current', {
      headers: { authorization: `Session ${issued.accessToken}` },
    })
    assert.equal(restored.status, 200)
    assert.equal((await restored.json()).sessionId, issued.sessionId)
  } finally {
    await service.stop()
    await rm(directory, { recursive: true, force: true })
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

test('authenticates a real node over WSS, preserves idempotency across reconnect, and revokes active access', async () => {
  const authority = new PairingAuthority()
  const credential = issueCredential(authority)
  const material = await createTlsMaterial()
  const service = createJarvisGateway({ ownerToken, authority, tls: material.tls })
  let gateway = await service.start()
  let executions = 0
  const socketFactory = endpoint => new WebSocket(endpoint, { rejectUnauthorized: false })
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
    assert.equal(gateway.secure, true)
    assert.match(gateway.origin, /^https:\/\/127\.0\.0\.1:/)
    const health = await request(gateway, '/v1/health')
    assert.equal((await health.json()).transport, 'https')
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
    await material.cleanup()
  }
})
