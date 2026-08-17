import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import { RetainedEventLog } from '../dist/event-log.js'
import { DeviceApprovalGate, InMemoryDeviceApprovalStore } from '../dist/device-approval.js'
import { createJarvisGateway } from '../dist/gateway.js'
import { HarnessBridgeError } from '../dist/harness-bridge.js'
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

function decryptBrowserClaim(claim, claimToken) {
  const key = createHash('sha256').update('jarvis-pairing-claim-v1\0').update(claimToken, 'utf8').digest()
  const encrypted = Buffer.from(claim.encryptedCredential.ciphertext, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(claim.encryptedCredential.iv, 'base64url'))
  decipher.setAuthTag(encrypted.subarray(-16))
  return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8')
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

function socketInbox(socket) {
  const queued = []
  const waiters = []
  socket.on('message', data => {
    const value = JSON.parse(data.toString())
    const waiter = waiters.shift()
    if (waiter === undefined) queued.push(value)
    else waiter.resolve(value)
  })
  socket.on('error', error => {
    for (const waiter of waiters.splice(0)) waiter.reject(error)
  })
  return {
    next() {
      const value = queued.shift()
      if (value !== undefined) return Promise.resolve(value)
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    },
  }
}

function fakeConversationEvents() {
  let handlers
  let approvals = []
  const decisions = []
  return {
    start(value) {
      handlers = value
      handlers.onAvailability(true)
    },
    async stop() { handlers = undefined },
    emit(event) { handlers?.onEvent(event) },
    available(value) { handlers?.onAvailability(value) },
    listApprovals() { return approvals },
    setApprovals(value) { approvals = value },
    async decideApproval(approvalId, digest, outcome, idempotencyKey) {
      decisions.push({ approvalId, digest, outcome, idempotencyKey })
      return { approvalId, outcome, accepted: true }
    },
    decisions,
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

test('serves the exact PWA shell routes with restrictive browser headers', async () => {
  const service = createJarvisGateway({ ownerToken, pwaRoot: join(process.cwd(), 'web') })
  const gateway = await service.start()
  try {
    const root = await request(gateway, '/', { redirect: 'manual' })
    assert.equal(root.status, 308)
    assert.equal(root.headers.get('location'), '/app/')

    const index = await request(gateway, '/app/')
    assert.equal(index.status, 200)
    assert.match(index.headers.get('content-type') ?? '', /^text\/html/)
    assert.equal(index.headers.get('cache-control'), 'no-cache')
    assert.match(index.headers.get('content-security-policy') ?? '', /default-src 'self'/)
    assert.match(index.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    assert.equal(index.headers.get('permissions-policy'), 'camera=(), geolocation=(), microphone=()')
    assert.equal(index.headers.get('x-content-type-options'), 'nosniff')
    assert.match(await index.text(), /<title>Jarvis<\/title>/)

    const manifest = await request(gateway, '/app/manifest.webmanifest')
    assert.equal(manifest.status, 200)
    assert.match(manifest.headers.get('content-type') ?? '', /^application\/manifest\+json/)
    assert.deepEqual(await manifest.json(), {
      id: '/app/',
      name: 'Jarvis',
      short_name: 'Jarvis',
      description: 'Private mobile companion for Jarvis',
      lang: 'zh-CN',
      start_url: '/app/',
      scope: '/app/',
      display: 'standalone',
      background_color: '#f5f7f6',
      theme_color: '#161b1a',
      icons: [
        { src: '/app/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/app/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      ],
    })

    const head = await request(gateway, '/app/app.css', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.match(head.headers.get('content-type') ?? '', /^text\/css/)
    assert.equal(await head.text(), '')

    const notifications = await request(gateway, '/app/notifications.js?v=11')
    assert.equal(notifications.status, 200)
    assert.match(notifications.headers.get('content-type') ?? '', /^text\/javascript/)
    assert.match(await notifications.text(), /class NotificationCenter/)

    const icon = await request(gateway, '/app/icon-192.png')
    assert.equal(icon.status, 200)
    assert.equal(icon.headers.get('content-type'), 'image/png')

    const missing = await request(gateway, '/app/private-state.json')
    assert.equal(missing.status, 404)
    assert.equal(await missing.text(), '')
    const unsupported = await request(gateway, '/app/', { method: 'POST' })
    assert.equal(unsupported.status, 405)
    assert.equal(unsupported.headers.get('allow'), 'GET, HEAD')
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

test('gateway entrypoint rejects incomplete MQTT command configuration', () => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('JARVIS_MQTT_') && name !== 'JARVIS_DEVICE_COMMAND_TOKEN'),
  )
  const cases = [
    { values: { JARVIS_MQTT_DEVICE_ID: 'sensor-node-1' }, message: /JARVIS_MQTT_URL is required/ },
    { values: { JARVIS_MQTT_URL: 'mqtt://broker.invalid' }, message: /JARVIS_MQTT_DEVICE_ID is required/ },
    {
      values: { JARVIS_MQTT_URL: 'mqtt://broker.invalid', JARVIS_MQTT_DEVICE_ID: 'sensor-node-1' },
      message: /JARVIS_DEVICE_COMMAND_TOKEN is required/,
    },
  ]
  for (const entry of cases) {
    const result = spawnSync(process.execPath, ['dist/gateway-main.js'], {
      encoding: 'utf8',
      env: { ...environment, JARVIS_OWNER_TOKEN: ownerToken, JARVIS_GATEWAY_PORT: '0', ...entry.values },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, entry.message)
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
    assert.equal(rejectedRotation.status, 401)
  } finally {
    await service.stop()
  }
})

test('pairs a browser through owner approval and an encrypted idempotent claim', async () => {
  const authority = new PairingAuthority(() => 1_000, 60_000)
  const identity = createDeviceIdentity()
  const service = createJarvisGateway({ ownerToken, authority })
  const gateway = await service.start()
  try {
    const created = await request(gateway, '/v1/pairing/requests/browser', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'pwa-phone', publicKey: identity.publicKey, displayName: 'Owner Phone', platform: 'pwa',
      }),
    })
    assert.equal(created.status, 201)
    const challenge = await created.json()
    assert.match(challenge.verificationCode, /^\d{6}$/)
    assert.match(challenge.claimToken, /^[A-Za-z0-9_-]{43}$/)

    const pending = await request(gateway, '/v1/pairing/requests/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: challenge.requestId, claimToken: challenge.claimToken }),
    })
    assert.equal(pending.status, 202)
    assert.deepEqual(await pending.json(), { status: 'pending' })

    const badClaim = await request(gateway, '/v1/pairing/requests/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: challenge.requestId, claimToken: 'A'.repeat(43) }),
    })
    assert.equal(badClaim.status, 401)
    assert.equal((await badClaim.json()).code, 'pairing_claim_rejected')

    const unauthorizedApproval = await request(gateway, '/v1/pairing/requests/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verificationCode: challenge.verificationCode }),
    })
    assert.equal(unauthorizedApproval.status, 401)
    const approved = await request(gateway, '/v1/pairing/requests/approve', {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ verificationCode: challenge.verificationCode }),
    })
    assert.equal(approved.status, 200)
    assert.equal((await approved.json()).nodeId, 'pwa-phone')

    const claimRequest = () => request(gateway, '/v1/pairing/requests/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: challenge.requestId, claimToken: challenge.claimToken }),
    })
    const claimed = await claimRequest()
    assert.equal(claimed.status, 200)
    const claim = await claimed.json()
    const retry = await claimRequest()
    assert.equal(retry.status, 200)
    assert.deepEqual(await retry.json(), claim)

    const credential = decryptBrowserClaim(claim, challenge.claimToken)
    const session = await request(gateway, '/v1/sessions', {
      method: 'POST',
      headers: { authorization: `Device ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: challenge.nodeId }),
    })
    assert.equal(session.status, 201)
    assert.match((await session.json()).accessToken, /^[A-Za-z0-9_-]{43}$/)
  } finally {
    await service.stop()
  }
})

test('reports browser pairing capacity as temporarily unavailable', async () => {
  const authority = new PairingAuthority(() => 1_000, 60_000, undefined, 1)
  const identity = createDeviceIdentity()
  const service = createJarvisGateway({ ownerToken, authority })
  const gateway = await service.start()
  try {
    const createRequest = nodeId => request(gateway, '/v1/pairing/requests/browser', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId, publicKey: identity.publicKey, displayName: 'Owner Phone', platform: 'pwa' }),
    })
    assert.equal((await createRequest('pwa-first')).status, 201)
    const capacity = await createRequest('pwa-second')
    assert.equal(capacity.status, 503)
    assert.equal((await capacity.json()).code, 'pairing_capacity')
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

test('reports and self-revokes only the authenticated current device', async () => {
  const now = Date.now()
  const authority = new PairingAuthority(() => now, 60_000)
  const firstCredential = issueCredential(authority, 'device-one')
  const secondCredential = issueCredential(authority, 'device-two')
  const sessions = new SessionAuthority({ now: () => now })
  const first = sessions.issue('device-one')
  const sibling = sessions.issue('device-one')
  const other = sessions.issue('device-two')
  const service = createJarvisGateway({ ownerToken, authority, sessions })
  const gateway = await service.start()
  const socket = new WebSocket(`${gateway.origin.replace(/^http/, 'ws')}/v1/events`, { origin: gateway.origin })
  const inbox = socketInbox(socket)
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.send(JSON.stringify({ type: 'events.authenticate', accessToken: first.accessToken }))
    assert.equal((await inbox.next()).type, 'events.ready')

    assert.equal((await request(gateway, '/v1/devices/current')).status, 401)
    assert.equal((await request(gateway, '/v1/devices/current', {
      headers: { authorization: `Device ${firstCredential}` },
    })).status, 401)
    assert.equal((await request(gateway, '/v1/devices/current?extra=true', {
      headers: { authorization: `Session ${first.accessToken}` },
    })).status, 400)
    assert.equal((await request(gateway, '/v1/devices/current', {
      method: 'POST', headers: { authorization: `Session ${first.accessToken}` },
    })).status, 405)
    const current = await request(gateway, '/v1/devices/current', {
      headers: { authorization: `Session ${first.accessToken}` },
    })
    assert.equal(current.status, 200)
    const currentText = await current.text()
    assert.deepEqual(JSON.parse(currentText), {
      device: {
        nodeId: 'device-one', displayName: 'Test Mac', platform: 'macos', generation: 1, issuedAt: now,
      },
      session: {
        sessionId: first.sessionId, issuedAt: now, refreshedAt: now,
        accessExpiresAt: first.accessExpiresAt, refreshExpiresAt: first.refreshExpiresAt,
      },
    })
    for (const secret of [firstCredential, secondCredential, first.accessToken, first.refreshToken]) {
      assert.doesNotMatch(currentText, new RegExp(secret))
    }
    assert.doesNotMatch(currentText, /publicKey|credentialDigest|familyId/)

    const revoked = await request(gateway, '/v1/devices/current', {
      method: 'DELETE', headers: { authorization: `Session ${first.accessToken}` },
    })
    assert.equal(revoked.status, 204)
    let rejection = await inbox.next()
    if (rejection.type === 'sync.required') rejection = await inbox.next()
    assert.equal(rejection.version, 1)
    assert.equal(rejection.type, 'events.rejected')
    assert.equal(rejection.code, 'device_revoked')
    assert.match(rejection.correlationId, /^[0-9a-f-]{36}$/)
    assert.equal(authority.isActive('device-one'), false)
    assert.equal(authority.isActive('device-two'), true)
    assert.equal(sessions.get(first.sessionId).revokeReason, 'device')
    assert.equal(sessions.get(sibling.sessionId).revokeReason, 'device')
    assert.equal(sessions.get(other.sessionId).revokeReason, null)
    assert.equal((await request(gateway, '/v1/sessions/current', {
      headers: { authorization: `Session ${sibling.accessToken}` },
    })).status, 401)
    assert.equal((await request(gateway, '/v1/devices/current', {
      method: 'DELETE', headers: { authorization: `Session ${first.accessToken}` },
    })).status, 401)
    assert.equal((await request(gateway, '/v1/devices/current', {
      headers: { authorization: `Session ${other.accessToken}` },
    })).status, 200)
  } finally {
    socket.close()
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

test('limits sources before reading request bodies and returns retry metadata', async () => {
  const service = createJarvisGateway({
    ownerToken,
    maxBodyBytes: 8,
    sourceRateLimit: { capacity: 1, refillPerSecond: 0.001, maxKeys: 8 },
  })
  const gateway = await service.start()
  try {
    assert.equal((await request(gateway, '/v1/health')).status, 200)
    const limited = await request(gateway, '/v1/pairing/requests', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.20',
      },
      body: JSON.stringify({ oversized: 'this body must never be parsed' }),
    })
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '1000')
    assert.equal(limited.headers.get('x-ratelimit-limit'), '1')
    assert.equal(limited.headers.get('x-ratelimit-remaining'), '0')
    assert.equal(limited.headers.get('cache-control'), 'no-store')
    assert.match(limited.headers.get('x-correlation-id') ?? '', /^[0-9a-f-]{36}$/)
    assert.equal((await limited.json()).code, 'rate_limited')
  } finally {
    await service.stop()
  }
})

test('isolates owner, device, and session identity limits after authentication', async () => {
  const authority = new PairingAuthority()
  const firstCredential = issueCredential(authority, 'node-1')
  const secondCredential = issueCredential(authority, 'node-2')
  const service = createJarvisGateway({
    ownerToken,
    authority,
    sourceRateLimit: { capacity: 100, refillPerSecond: 100, maxKeys: 8 },
    identityRateLimit: { capacity: 1, refillPerSecond: 0.001, maxKeys: 8 },
  })
  const gateway = await service.start()
  const createSession = (nodeId, credential) => request(gateway, '/v1/sessions', {
    method: 'POST',
    headers: { authorization: `Device ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId }),
  })
  try {
    const invalid = await createSession('node-1', 'invalid-device-credential')
    assert.equal(invalid.status, 401)

    const first = await createSession('node-1', firstCredential)
    assert.equal(first.status, 201)
    const firstTokens = await first.json()
    assert.equal((await createSession('node-1', firstCredential)).status, 429)
    assert.equal((await createSession('node-2', secondCredential)).status, 201)

    const sessionHeaders = { authorization: `Session ${firstTokens.accessToken}` }
    assert.equal((await request(gateway, '/v1/sessions/current', { headers: sessionHeaders })).status, 200)
    assert.equal((await request(gateway, '/v1/sessions/current', { headers: sessionHeaders })).status, 429)

    const ownerHeaders = { authorization: `Bearer ${ownerToken}` }
    assert.equal((await request(gateway, '/v1/sessions', { headers: ownerHeaders })).status, 200)
    const ownerLimited = await request(gateway, '/v1/sessions', { headers: ownerHeaders })
    assert.equal(ownerLimited.status, 429)
    assert.equal(ownerLimited.headers.get('x-ratelimit-limit'), '1')
  } finally {
    await service.stop()
  }
})

test('detects refresh reuse even after the session identity limit is exhausted', async () => {
  const authority = new PairingAuthority()
  issueCredential(authority)
  const sessions = new SessionAuthority()
  const first = sessions.issue('node-1')
  const service = createJarvisGateway({
    ownerToken,
    authority,
    sessions,
    sourceRateLimit: { capacity: 100, refillPerSecond: 100, maxKeys: 8 },
    identityRateLimit: { capacity: 2, refillPerSecond: 0.001, maxKeys: 8 },
  })
  const gateway = await service.start()
  const refresh = token => request(gateway, '/v1/sessions/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: token }),
  })
  try {
    const rotatedResponse = await refresh(first.refreshToken)
    assert.equal(rotatedResponse.status, 200)
    const rotated = await rotatedResponse.json()
    assert.equal((await request(gateway, '/v1/sessions/current', {
      headers: { authorization: `Session ${rotated.accessToken}` },
    })).status, 200)

    const reused = await refresh(first.refreshToken)
    assert.equal(reused.status, 401)
    assert.equal((await reused.json()).code, 'refresh_reuse_detected')
    assert.equal(sessions.get(first.sessionId).revokeReason, 'refresh-reuse')
    assert.equal((await request(gateway, '/v1/sessions/current', {
      headers: { authorization: `Session ${rotated.accessToken}` },
    })).status, 401)
  } finally {
    await service.stop()
  }
})

test('bridges normalized conversation routes only for authenticated sessions', async () => {
  const authority = new PairingAuthority()
  const credential = issueCredential(authority)
  const sessions = new SessionAuthority()
  const access = sessions.issue('node-1')
  const calls = []
  const harness = {
    async listConversations() {
      calls.push(['list'])
      return [{ id: 'session-one', title: 'Test', updatedAt: 1, running: false, blank: false }]
    },
    async createConversation() {
      calls.push(['create'])
      return { id: 'session-created' }
    },
    async getConversationHistory(id, beforeSequence, maxMessages) {
      calls.push(['history', id, beforeSequence, maxMessages])
      return { messages: [], hasMore: false, nextBeforeSequence: null }
    },
    async sendText(id, text, mode) {
      calls.push(['message', id, text, mode])
      return { accepted: true }
    },
    async cancelConversation(id) {
      calls.push(['cancel', id])
      return { accepted: true }
    },
  }
  const service = createJarvisGateway({ ownerToken, authority, sessions, harness })
  const gateway = await service.start()
  const sessionHeaders = { authorization: `Session ${access.accessToken}` }
  try {
    assert.equal((await request(gateway, '/v1/conversations')).status, 401)
    assert.equal((await request(gateway, '/v1/conversations', {
      headers: { authorization: `Bearer ${ownerToken}` },
    })).status, 401)
    assert.equal((await request(gateway, '/v1/conversations', {
      headers: { authorization: `Device ${credential}` },
    })).status, 401)
    assert.deepEqual(calls, [])

    const listed = await request(gateway, '/v1/conversations', { headers: sessionHeaders })
    assert.equal(listed.status, 200)
    assert.deepEqual(await listed.json(), { conversations: [
      { id: 'session-one', title: 'Test', updatedAt: 1, running: false, blank: false },
    ] })
    const created = await request(gateway, '/v1/conversations', { method: 'POST', headers: sessionHeaders })
    assert.equal(created.status, 201)
    assert.deepEqual(await created.json(), { conversation: { id: 'session-created' } })
    const history = await request(gateway, '/v1/conversations/session-one?beforeSequence=20&maxMessages=25', {
      headers: sessionHeaders,
    })
    assert.equal(history.status, 200)
    assert.deepEqual(await history.json(), { messages: [], hasMore: false, nextBeforeSequence: null })
    const sent = await request(gateway, '/v1/conversations/session-one/messages', {
      method: 'POST',
      headers: { ...sessionHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Continue', mode: 'steer' }),
    })
    assert.equal(sent.status, 202)
    assert.deepEqual(await sent.json(), { accepted: true })
    assert.equal((await request(gateway, '/v1/conversations/session-one/cancel', {
      method: 'POST', headers: sessionHeaders,
    })).status, 200)
    assert.deepEqual(calls, [
      ['list'],
      ['create'],
      ['history', 'session-one', 20, 25],
      ['message', 'session-one', 'Continue', 'steer'],
      ['cancel', 'session-one'],
    ])

    assert.equal((await request(gateway, '/v1/conversations?cursor=internal', { headers: sessionHeaders })).status, 400)
    assert.equal((await request(gateway, '/v1/conversations/session-one?maxMessages=101', { headers: sessionHeaders })).status, 400)
    assert.equal((await request(gateway, '/v1/conversations/session-one/messages', {
      method: 'POST',
      headers: { ...sessionHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', internal: true }),
    })).status, 400)
    assert.equal(calls.length, 5)
  } finally {
    await service.stop()
  }
})

test('maps Harness failures without exposing internal diagnostics', async () => {
  const authority = new PairingAuthority()
  issueCredential(authority)
  const sessions = new SessionAuthority()
  const access = sessions.issue('node-1')
  let failure = new HarnessBridgeError('timeout', 'secret timeout detail')
  const harness = {
    async listConversations() { throw failure },
    async createConversation() { throw failure },
    async getConversationHistory() { throw failure },
    async sendText() { throw failure },
    async cancelConversation() { throw failure },
  }
  const service = createJarvisGateway({ ownerToken, authority, sessions, harness })
  const gateway = await service.start()
  const headers = { authorization: `Session ${access.accessToken}` }
  const expectFailure = async (error, expectedStatus, expectedCode) => {
    failure = error
    const response = await request(gateway, '/v1/conversations', { headers })
    assert.equal(response.status, expectedStatus)
    const text = await response.text()
    assert.equal(JSON.parse(text).code, expectedCode)
    assert.doesNotMatch(text, /secret|upstream-private/)
    assert.match(response.headers.get('x-correlation-id') ?? '', /^[0-9a-f-]{36}$/)
  }
  try {
    await expectFailure(new HarnessBridgeError('timeout', 'secret'), 504, 'harness_timeout')
    await expectFailure(new HarnessBridgeError('unavailable', 'secret'), 503, 'harness_unavailable')
    await expectFailure(new HarnessBridgeError('protocol', 'secret'), 502, 'harness_protocol_error')
    await expectFailure(new HarnessBridgeError('rejected', 'upstream-private', 'session-not-found'), 404, 'conversation_not_found')
    await expectFailure(new HarnessBridgeError('rejected', 'upstream-private', 'agent-busy'), 409, 'conversation_busy')
    await expectFailure(new HarnessBridgeError('rejected', 'upstream-private', 'session-conflict'), 409, 'conversation_conflict')
    await expectFailure(new HarnessBridgeError('rejected', 'upstream-private', 'bad-request'), 400, 'harness_rejected')
    await expectFailure(new HarnessBridgeError('rejected', 'upstream-private', 'internal'), 502, 'harness_rejected')
  } finally {
    await service.stop()
  }
})

test('authenticates normalized approval snapshots and idempotent decisions', async () => {
  const authority = new PairingAuthority()
  issueCredential(authority)
  const sessions = new SessionAuthority()
  const access = sessions.issue('node-1')
  const harnessEvents = fakeConversationEvents()
  const digest = 'a'.repeat(64)
  harnessEvents.setApprovals([{
    id: 'approval-one', conversationId: 'session-one', toolName: 'jarvis_open_app', callId: 'call-one',
    action: 'open_app', target: 'notes', arguments: { application: 'notes' }, digest, risk: 'high',
    requestedAt: 1_000, expiresAt: 61_000, canAllow: true, blockReason: null,
  }])
  const service = createJarvisGateway({ ownerToken, authority, sessions, harnessEvents })
  const gateway = await service.start()
  const headers = { authorization: `Session ${access.accessToken}` }
  try {
    assert.equal((await request(gateway, '/v1/approvals')).status, 401)
    const snapshot = await request(gateway, '/v1/approvals', { headers })
    assert.equal(snapshot.status, 200)
    const body = await snapshot.json()
    assert.equal(body.approvals[0].digest, digest)
    assert.doesNotMatch(JSON.stringify(body), /rpc-/)

    const decision = await request(gateway, '/v1/approvals/approval-one/decision', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        digest, outcome: 'allowed-once', idempotencyKey: '00000000-0000-4000-8000-000000000001',
      }),
    })
    assert.equal(decision.status, 202)
    assert.deepEqual(await decision.json(), { approvalId: 'approval-one', outcome: 'allowed-once', accepted: true })
    assert.deepEqual(harnessEvents.decisions, [{
      approvalId: 'approval-one', digest, outcome: 'allowed-once',
      idempotencyKey: '00000000-0000-4000-8000-000000000001',
    }])
    assert.equal((await request(gateway, '/v1/approvals/approval-one/decision', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ digest, outcome: 'allowed-once', idempotencyKey: 'bad' }),
    })).status, 400)
    assert.equal((await request(gateway, '/v1/approvals?internal=true', { headers })).status, 400)
  } finally {
    await service.stop()
  }
})

test('authenticates normalized smart-device approvals without exposing command payloads', async () => {
  const authority = new PairingAuthority()
  issueCredential(authority)
  const sessions = new SessionAuthority()
  const access = sessions.issue('node-1')
  const deviceApprovals = new InMemoryDeviceApprovalStore(new DeviceApprovalGate(() => 1_000))
  const pending = deviceApprovals.request('device-approval-one', {
    commandId: 'lock-command-one',
    idempotencyKey: 'lock-once-one',
    capability: 'lock.set',
    externalEntityId: 'lock.front_door',
    service: 'lock_unlock',
    serviceData: { token: 'private-provider-token' },
    expectedState: 'unlocked',
  })
  const service = createJarvisGateway({ ownerToken, authority, sessions, deviceApprovals })
  const gateway = await service.start()
  const headers = { authorization: `Session ${access.accessToken}` }
  try {
    assert.equal((await request(gateway, '/v1/device-approvals')).status, 401)
    const snapshot = await request(gateway, '/v1/device-approvals', { headers })
    assert.equal(snapshot.status, 200)
    const body = await snapshot.json()
    assert.deepEqual(body.approvals, [pending])
    assert.doesNotMatch(JSON.stringify(body), /private-provider-token/)

    const decisionBody = {
      digest: pending.digest, outcome: 'allowed-once', idempotencyKey: 'device-decision-one',
    }
    const decision = await request(gateway, '/v1/device-approvals/device-approval-one/decision', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(decisionBody),
    })
    assert.equal(decision.status, 202)
    assert.deepEqual(await decision.json(), { approvalId: 'device-approval-one', outcome: 'allowed-once', accepted: true })
    const retry = await request(gateway, '/v1/device-approvals/device-approval-one/decision', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(decisionBody),
    })
    assert.equal(retry.status, 202)
    assert.deepEqual(await retry.json(), { approvalId: 'device-approval-one', outcome: 'allowed-once', accepted: true })
    const after = await request(gateway, '/v1/device-approvals', { headers })
    assert.deepEqual(await after.json(), { approvals: [] })
  } finally {
    await service.stop()
  }
})

test('accepts only loopback internal device-command submissions and returns a redacted approval', async () => {
  const authority = new PairingAuthority()
  issueCredential(authority)
  const deviceApprovals = new InMemoryDeviceApprovalStore(new DeviceApprovalGate(() => 1_000))
  const deviceCommandToken = 'device-command-token-for-tests'
  const service = createJarvisGateway({ ownerToken, authority, deviceApprovals, deviceCommandToken })
  const gateway = await service.start()
  const body = {
    commandId: 'lock-command-gateway', idempotencyKey: 'lock-once-gateway', capability: 'lock.set',
    externalEntityId: 'lock.front_door', service: 'unlock', serviceData: { token: 'private-provider-token' }, expectedState: 'unlocked',
  }
  const headers = { 'content-type': 'application/json', authorization: `DeviceCommand ${deviceCommandToken}` }
  try {
    assert.equal((await request(gateway, '/v1/device-commands', {
      method: 'POST', headers: { ...headers, authorization: 'DeviceCommand wrong-token' }, body: JSON.stringify(body),
    })).status, 401)
    const response = await request(gateway, '/v1/device-commands', { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal(response.status, 202)
    const responseBody = await response.json()
    assert.equal(responseBody.approval.capability, 'lock.set')
    assert.doesNotMatch(JSON.stringify(responseBody), /private-provider-token/)
    assert.equal((await request(gateway, '/v1/device-approvals')).status, 401)
    assert.deepEqual(deviceApprovals.listApprovals(), [responseBody.approval])
    const invalid = await request(gateway, '/v1/device-commands', {
      method: 'POST', headers, body: JSON.stringify({ ...body, capability: 'switch.set' }),
    })
    assert.equal(invalid.status, 400)
  } finally {
    await service.stop()
  }
})

test('accepts only bounded loopback MQTT commands and returns a redacted outcome', async () => {
  const deviceCommandToken = 'device-command-token-for-tests'
  const received = []
  const mqttCommands = {
    async sendCommand(command) {
      received.push(command)
      if (command.commandId === 'mqtt-command-unredacted') {
        return {
          commandId: command.commandId, idempotencyKey: command.idempotencyKey, capability: command.capability,
          state: 'succeeded', acknowledged: true, payload: { providerToken: 'private-provider-token' },
        }
      }
      return {
        commandId: command.commandId, idempotencyKey: command.idempotencyKey, capability: command.capability,
        state: 'succeeded', acknowledged: true, observedState: command.expectedState,
      }
    },
  }
  const service = createJarvisGateway({ ownerToken, deviceCommandToken, mqttCommands })
  const gateway = await service.start()
  const body = {
    commandId: 'mqtt-command-gateway', idempotencyKey: 'mqtt-once-gateway', capability: 'light.set',
    payload: { brightness: 50, providerToken: 'private-provider-token' }, expectedState: 'on',
  }
  const headers = { 'content-type': 'application/json', authorization: `DeviceCommand ${deviceCommandToken}` }
  try {
    assert.equal((await request(gateway, '/v1/mqtt-commands', {
      method: 'POST', headers: { ...headers, authorization: 'DeviceCommand wrong-token' }, body: JSON.stringify(body),
    })).status, 401)
    const response = await request(gateway, '/v1/mqtt-commands', { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    const responseBody = await response.json()
    assert.equal(received.length, 1)
    assert.equal(received[0].payload.providerToken, 'private-provider-token')
    assert.equal(responseBody.result.state, 'succeeded')
    assert.equal('payload' in responseBody.result, false)
    assert.doesNotMatch(JSON.stringify(responseBody), /private-provider-token/)

    const unredacted = await request(gateway, '/v1/mqtt-commands', {
      method: 'POST', headers,
      body: JSON.stringify({ ...body, commandId: 'mqtt-command-unredacted', idempotencyKey: 'mqtt-once-unredacted' }),
    })
    assert.equal(unredacted.status, 400)
    assert.doesNotMatch(JSON.stringify(await unredacted.json()), /private-provider-token/)

    for (const invalidBody of [
      { ...body, capability: 'lock.set' },
      { ...body, payload: 'not-an-object' },
      { ...body, rawFrame: 'private-provider-token' },
    ]) {
      const invalid = await request(gateway, '/v1/mqtt-commands', { method: 'POST', headers, body: JSON.stringify(invalidBody) })
      assert.equal(invalid.status, 400)
    }
    assert.equal(received.length, 2)
  } finally {
    await service.stop()
  }

  const unavailableService = createJarvisGateway({ ownerToken, deviceCommandToken })
  const unavailableGateway = await unavailableService.start()
  try {
    const unavailable = await request(unavailableGateway, '/v1/mqtt-commands', { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal(unavailable.status, 503)
    assert.equal((await unavailable.json()).code, 'mqtt_device_unavailable')
  } finally {
    await unavailableService.stop()
  }
})

test('publishes smart-device approval lifecycle events and replays them to authenticated clients', async () => {
  const authority = new PairingAuthority()
  issueCredential(authority)
  const sessions = new SessionAuthority()
  const access = sessions.issue('node-1')
  const deviceApprovals = new InMemoryDeviceApprovalStore(new DeviceApprovalGate(() => 1_000))
  const harnessEvents = fakeConversationEvents()
  const service = createJarvisGateway({ ownerToken, authority, sessions, deviceApprovals, harnessEvents })
  const gateway = await service.start()
  const endpoint = `ws://127.0.0.1:${gateway.port}/v1/events`
  const sockets = []
  const nextEvent = (inbox, label) => Promise.race([
    inbox.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2_000)),
  ])
  const command = {
    commandId: 'lock-command-live', idempotencyKey: 'lock-once-live', capability: 'lock.set',
    externalEntityId: 'lock.front_door', service: 'lock_unlock', serviceData: { token: 'secret' }, expectedState: 'unlocked',
  }
  try {
    const socket = new WebSocket(endpoint)
    sockets.push(socket)
    const inbox = socketInbox(socket)
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.send(JSON.stringify({ type: 'events.authenticate', accessToken: access.accessToken }))
    const ready = await nextEvent(inbox, 'initial ready')
    assert.equal(ready.type, 'events.ready')

    const pending = deviceApprovals.request('device-approval-live', command)
    let pendingEvent = await nextEvent(inbox, 'device approval pending')
    while (pendingEvent.type !== 'device.approval.pending') pendingEvent = await nextEvent(inbox, 'device approval pending after sync')
    assert.deepEqual({
      type: pendingEvent.type, approval: pendingEvent.approval, serviceData: pendingEvent.approval.serviceData,
    }, { type: 'device.approval.pending', approval: pending, serviceData: undefined })
    socket.send(JSON.stringify({ type: 'events.ack', cursor: pendingEvent.cursor }))

    deviceApprovals.decideApproval('device-approval-live', pending.digest, 'rejected', 'decision-live')
    const resolvedEvent = await nextEvent(inbox, 'device approval resolved')
    assert.deepEqual({
      type: resolvedEvent.type, approvalId: resolvedEvent.approvalId, outcome: resolvedEvent.outcome,
    }, { type: 'device.approval.resolved', approvalId: pending.approvalId, outcome: 'rejected' })
    socket.send(JSON.stringify({ type: 'events.ack', cursor: resolvedEvent.cursor }))
    const socketClosed = new Promise((resolve, reject) => {
      socket.once('close', resolve)
      socket.once('error', reject)
    })
    socket.close()
    await socketClosed

    const replaySocket = new WebSocket(endpoint)
    sockets.push(replaySocket)
    const replayInbox = socketInbox(replaySocket)
    await new Promise((resolve, reject) => {
      replaySocket.once('open', resolve)
      replaySocket.once('error', reject)
    })
    replaySocket.send(JSON.stringify({ type: 'events.authenticate', accessToken: access.accessToken, cursor: ready.cursor }))
    const replayReady = await nextEvent(replayInbox, 'replay ready')
    assert.equal(replayReady.type, 'events.ready')
    const replayed = []
    for (let index = 0; index < replayReady.replayCount; index += 1) replayed.push(await nextEvent(replayInbox, 'replayed event'))
    assert.deepEqual(replayed.filter(event => event.type.startsWith('device.approval.')).map(event => event.type), [
      'device.approval.pending', 'device.approval.resolved',
    ])
  } finally {
    for (const socket of sockets) socket.terminate()
    await service.stop()
  }
})

test('authenticates conversation events, replays retained cursors, and closes revoked sessions', async () => {
  const authority = new PairingAuthority()
  issueCredential(authority)
  const sessions = new SessionAuthority()
  const access = sessions.issue('node-1')
  const harnessEvents = fakeConversationEvents()
  const eventLog = new RetainedEventLog()
  const service = createJarvisGateway({ ownerToken, authority, sessions, harnessEvents, eventLog })
  const gateway = await service.start()
  const endpoint = `ws://127.0.0.1:${gateway.port}/v1/events`
  const sockets = []
  try {
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = new WebSocket(`${endpoint}?accessToken=forbidden`)
      socket.once('open', resolve)
      socket.once('error', reject)
    }), /Unexpected server response: 404/)
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint, { origin: 'https://untrusted.example' })
      socket.once('open', resolve)
      socket.once('error', reject)
    }), /Unexpected server response: 403/)

    const unauthorized = new WebSocket(endpoint)
    sockets.push(unauthorized)
    const unauthorizedInbox = socketInbox(unauthorized)
    await new Promise((resolve, reject) => {
      unauthorized.once('open', resolve)
      unauthorized.once('error', reject)
    })
    unauthorized.send(JSON.stringify({ type: 'events.authenticate', accessToken: ownerToken }))
    assert.equal((await unauthorizedInbox.next()).type, 'events.rejected')

    const first = new WebSocket(endpoint, { origin: gateway.origin })
    sockets.push(first)
    const firstInbox = socketInbox(first)
    await new Promise((resolve, reject) => {
      first.once('open', resolve)
      first.once('error', reject)
    })
    first.send(JSON.stringify({ type: 'events.authenticate', accessToken: access.accessToken }))
    const initialReady = await firstInbox.next()
    assert.deepEqual({
      type: initialReady.type,
      replayCount: initialReady.replayCount,
      requiresSnapshot: initialReady.requiresSnapshot,
      reason: initialReady.reason,
    }, { type: 'events.ready', replayCount: 0, requiresSnapshot: true, reason: 'initial' })
    assert.match(initialReady.cursor, /^[A-Za-z0-9_-]{22}\.[0-9]+$/)

    harnessEvents.emit({ type: 'conversation.status', conversationId: 'session-one', running: true })
    const live = await firstInbox.next()
    assert.equal(live.type, 'conversation.status')
    assert.equal(live.running, true)
    first.send(JSON.stringify({ type: 'events.ack', cursor: live.cursor }))
    first.close()

    const resumed = new WebSocket(endpoint)
    sockets.push(resumed)
    const resumedInbox = socketInbox(resumed)
    await new Promise((resolve, reject) => {
      resumed.once('open', resolve)
      resumed.once('error', reject)
    })
    resumed.send(JSON.stringify({
      type: 'events.authenticate', accessToken: access.accessToken, cursor: initialReady.cursor,
    }))
    const resumedReady = await resumedInbox.next()
    assert.equal(resumedReady.type, 'events.ready')
    assert.equal(resumedReady.requiresSnapshot, false)
    assert.equal(resumedReady.replayCount, 1)
    assert.deepEqual(await resumedInbox.next(), live)

    const revoked = await request(gateway, `/v1/sessions/${access.sessionId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${ownerToken}` },
    })
    assert.equal(revoked.status, 204)
    const rejection = await resumedInbox.next()
    assert.equal(rejection.type, 'events.rejected')
    assert.equal(rejection.code, 'session_invalid')
  } finally {
    for (const socket of sockets) socket.terminate()
    await service.stop()
  }
})

test('requires event-stream resync after an upstream continuity gap', async () => {
  const authority = new PairingAuthority()
  issueCredential(authority)
  const sessions = new SessionAuthority()
  const access = sessions.issue('node-1')
  const harnessEvents = fakeConversationEvents()
  const service = createJarvisGateway({ ownerToken, authority, sessions, harnessEvents })
  const gateway = await service.start()
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/events`)
  const inbox = socketInbox(socket)
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.send(JSON.stringify({ type: 'events.authenticate', accessToken: access.accessToken }))
    assert.equal((await inbox.next()).type, 'events.ready')
    harnessEvents.available(false)
    const event = await inbox.next()
    assert.equal(event.type, 'sync.required')
    assert.equal(event.reason, 'harness_disconnected')
  } finally {
    socket.terminate()
    await service.stop()
  }
})

test('closes an active event stream when its access token expires', async () => {
  const authority = new PairingAuthority()
  issueCredential(authority)
  const sessions = new SessionAuthority({ accessTtlMs: 1_000, refreshTtlMs: 2_000 })
  const access = sessions.issue('node-1')
  const harnessEvents = fakeConversationEvents()
  const service = createJarvisGateway({ ownerToken, authority, sessions, harnessEvents })
  const gateway = await service.start()
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/events`)
  const inbox = socketInbox(socket)
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.send(JSON.stringify({ type: 'events.authenticate', accessToken: access.accessToken }))
    assert.equal((await inbox.next()).type, 'events.ready')
    const rejection = await Promise.race([
      inbox.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('event stream did not expire')), 2_000)),
    ])
    assert.equal(rejection.type, 'events.rejected')
    assert.equal(rejection.code, 'session_expired')
  } finally {
    socket.terminate()
    await service.stop()
  }
})

test('applies the authenticated session rate limit to event acknowledgements', async () => {
  const authority = new PairingAuthority()
  issueCredential(authority)
  const sessions = new SessionAuthority()
  const access = sessions.issue('node-1')
  const harnessEvents = fakeConversationEvents()
  const service = createJarvisGateway({
    ownerToken,
    authority,
    sessions,
    harnessEvents,
    identityRateLimit: { capacity: 1, refillPerSecond: 0.001, maxKeys: 16 },
  })
  const gateway = await service.start()
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/events`)
  const inbox = socketInbox(socket)
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.send(JSON.stringify({ type: 'events.authenticate', accessToken: access.accessToken }))
    const ready = await inbox.next()
    assert.equal(ready.type, 'events.ready')
    socket.send(JSON.stringify({ type: 'events.ack', cursor: ready.cursor }))
    const rejection = await inbox.next()
    assert.equal(rejection.type, 'events.rejected')
    assert.equal(rejection.code, 'rate_limited')
  } finally {
    socket.terminate()
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

test('rate limits WebSocket upgrades by source and authenticated node identity', async () => {
  const sourceLimitedService = createJarvisGateway({
    ownerToken,
    sourceRateLimit: { capacity: 1, refillPerSecond: 0.001, maxKeys: 8 },
  })
  const sourceGateway = await sourceLimitedService.start()
  try {
    assert.equal((await request(sourceGateway, '/v1/health')).status, 200)
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${sourceGateway.port}/v1/node`)
      socket.once('unexpected-response', (_request, response) => {
        try {
          assert.equal(response.statusCode, 429)
          assert.equal(response.headers['x-ratelimit-limit'], '1')
          assert.match(response.headers['x-correlation-id'] ?? '', /^[0-9a-f-]{36}$/)
          response.resume()
          resolve()
        } catch (error) {
          reject(error)
        }
      })
      socket.once('error', reject)
    })
  } finally {
    await sourceLimitedService.stop()
  }

  const authority = new PairingAuthority()
  const credential = issueCredential(authority)
  const identityLimitedService = createJarvisGateway({
    ownerToken,
    authority,
    sourceRateLimit: { capacity: 100, refillPerSecond: 100, maxKeys: 8 },
    identityRateLimit: { capacity: 1, refillPerSecond: 0.001, maxKeys: 8 },
  })
  const identityGateway = await identityLimitedService.start()
  try {
    const issued = await request(identityGateway, '/v1/sessions', {
      method: 'POST',
      headers: { authorization: `Device ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: 'node-1' }),
    })
    assert.equal(issued.status, 201)
    const rejection = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${identityGateway.port}/v1/node`)
      socket.once('open', () => socket.send(JSON.stringify({
        type: 'node.authenticate',
        protocolVersion: 1,
        nodeId: 'node-1',
        credential,
      })))
      socket.once('message', data => resolve(JSON.parse(data.toString())))
      socket.once('error', reject)
    })
    assert.equal(rejection.type, 'node.rejected')
    assert.equal(rejection.reason, 'node rate limit exceeded')
  } finally {
    await identityLimitedService.stop()
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
