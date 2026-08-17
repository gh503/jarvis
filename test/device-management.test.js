import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { DeviceManagementClient } from '../dist/device-management.js'
import { createJarvisGateway } from '../dist/gateway.js'
import { PairingAuthority, createDeviceIdentity } from '../dist/pairing.js'

const ownerToken = 'owner-token-for-device-management'
const entrypoint = join(process.cwd(), 'dist', 'device-management-main.js')

function runCli(args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], {
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

test('lists sanitized devices and revokes one device through loopback owner authentication', async () => {
  const calls = []
  const client = new DeviceManagementClient('http://127.0.0.1:3090', ownerToken, async (url, init) => {
    calls.push({ url: url.toString(), init })
    if (init.method === 'DELETE') return new Response(undefined, { status: 204 })
    return new Response(JSON.stringify({ devices: [{
      nodeId: 'pwa-phone', displayName: 'Owner Phone', platform: 'pwa', generation: 3,
      issuedAt: 1_000, revoked: false,
    }] }), { status: 200 })
  })
  assert.deepEqual(await client.list(), [{
    nodeId: 'pwa-phone', displayName: 'Owner Phone', platform: 'pwa', generation: 3,
    issuedAt: 1_000, revoked: false,
  }])
  await client.revoke('pwa-phone')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'http://127.0.0.1:3090/v1/devices')
  assert.equal(calls[1].url, 'http://127.0.0.1:3090/v1/devices/pwa-phone')
  assert.equal(calls[0].init.headers.authorization, `Bearer ${ownerToken}`)
})

test('rejects remote origins, malformed device records, and oversized responses', async () => {
  assert.throws(() => new DeviceManagementClient('https://gateway.example', ownerToken), /127\.0\.0\.1/)
  const malformed = new DeviceManagementClient('http://127.0.0.1:3090', ownerToken, async () => new Response(JSON.stringify({
    devices: [{ nodeId: 'phone', displayName: 'Phone', platform: 'pwa', generation: 1, issuedAt: 1, revoked: false,
      credentialDigest: 'private' }],
  }), { status: 200 }))
  await assert.rejects(malformed.list(), /invalid device record/)
  const oversized = new DeviceManagementClient('http://127.0.0.1:3090', ownerToken, async () => new Response('x'.repeat(65 * 1024)))
  await assert.rejects(oversized.list(), /too large/)
})

test('runs the owner CLI without printing credentials and requires destructive confirmation', async () => {
  const authority = new PairingAuthority()
  const identity = createDeviceIdentity()
  const pairing = authority.createRequest({
    nodeId: 'owner-phone', publicKey: identity.publicKey, displayName: 'Owner Phone', platform: 'macos',
  })
  const credential = authority.confirm(pairing.requestId, pairing.verificationCode).credential
  const service = createJarvisGateway({ ownerToken, authority })
  const gateway = await service.start()
  const environment = { JARVIS_OWNER_TOKEN: ownerToken, JARVIS_GATEWAY_URL: gateway.origin }
  try {
    const listed = await runCli(['list'], environment)
    assert.equal(listed.code, 0, listed.stderr)
    assert.equal(listed.stderr, '')
    assert.deepEqual(JSON.parse(listed.stdout).devices, [{
      nodeId: 'owner-phone', displayName: 'Owner Phone', platform: 'macos', generation: 1,
      issuedAt: JSON.parse(listed.stdout).devices[0].issuedAt, revoked: false,
    }])
    assert.doesNotMatch(listed.stdout, new RegExp(credential))
    assert.doesNotMatch(listed.stdout, new RegExp(ownerToken))

    const unconfirmed = await runCli(['revoke', '--id', 'owner-phone'], environment)
    assert.notEqual(unconfirmed.code, 0)
    assert.match(unconfirmed.stderr, /requires --yes/)
    assert.equal(authority.isActive('owner-phone'), true)

    const revoked = await runCli(['revoke', '--id', 'owner-phone', '--yes'], environment)
    assert.equal(revoked.code, 0, revoked.stderr)
    assert.deepEqual(JSON.parse(revoked.stdout).revoked, true)
    assert.equal(authority.isActive('owner-phone'), false)
    assert.doesNotMatch(revoked.stdout + revoked.stderr, new RegExp(credential))
    assert.doesNotMatch(revoked.stdout + revoked.stderr, new RegExp(ownerToken))
  } finally {
    await service.stop()
  }
})
