import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FilePairingStateStore, PairingAuthority, createDeviceIdentity } from '../dist/pairing.js'

const requestInput = (identity, overrides = {}) => ({
  nodeId: 'node-1',
  publicKey: identity.publicKey,
  displayName: 'MacBook Air',
  platform: 'macos',
  ...overrides,
})

test('generates an Ed25519 identity with a stable public-key fingerprint', () => {
  const first = createDeviceIdentity()
  const second = createDeviceIdentity()
  assert.notEqual(first.publicKey, second.publicKey)
  assert.notEqual(first.privateKey, second.privateKey)
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/)
  assert.notEqual(first.fingerprint, second.fingerprint)
})

test('confirms a short-lived pairing request exactly once', () => {
  let now = 1_000
  const identity = createDeviceIdentity()
  const authority = new PairingAuthority(() => now, 60_000)
  const request = authority.createRequest(requestInput(identity))
  assert.match(request.verificationCode, /^\d{6}$/)
  const issued = authority.confirm(request.requestId, request.verificationCode)
  assert.equal(issued.nodeId, 'node-1')
  assert.equal(issued.publicKey, identity.publicKey)
  assert.equal(authority.authenticate('node-1', issued.credential), true)
  assert.throws(() => authority.confirm(request.requestId, request.verificationCode), /already been used/)
  now = 100_000
  assert.equal(authority.authenticate('node-1', issued.credential), true)
})

test('wrong verification code does not issue a credential', () => {
  const identity = createDeviceIdentity()
  const authority = new PairingAuthority(() => 1_000, 60_000)
  const request = authority.createRequest(requestInput(identity))
  assert.throws(() => authority.confirm(request.requestId, '000000'), /incorrect/)
  const issued = authority.confirm(request.requestId, request.verificationCode)
  assert.equal(authority.authenticate('node-1', issued.credential), true)
  assert.equal(authority.identify(issued.credential), 'node-1')
})

test('expired pairing requests cannot be confirmed', () => {
  let now = 1_000
  const identity = createDeviceIdentity()
  const authority = new PairingAuthority(() => now, 60_000)
  const request = authority.createRequest(requestInput(identity))
  now = 61_000
  assert.throws(() => authority.confirm(request.requestId, request.verificationCode), /expired/)
})

test('an active device identity cannot be claimed by a second pairing request', () => {
  const firstIdentity = createDeviceIdentity()
  const secondIdentity = createDeviceIdentity()
  const authority = new PairingAuthority(() => 1_000, 60_000)
  const firstRequest = authority.createRequest(requestInput(firstIdentity))
  authority.confirm(firstRequest.requestId, firstRequest.verificationCode)
  const secondRequest = authority.createRequest(requestInput(secondIdentity))
  assert.throws(() => authority.confirm(secondRequest.requestId, secondRequest.verificationCode), /already paired/)
})

test('rotation invalidates the old credential while preserving device identity', () => {
  const identity = createDeviceIdentity()
  const authority = new PairingAuthority(() => 1_000, 60_000)
  const request = authority.createRequest(requestInput(identity))
  const first = authority.confirm(request.requestId, request.verificationCode)
  const rotated = authority.rotate('node-1', first.credential)
  assert.equal(rotated.generation, 2)
  assert.equal(rotated.publicKey, first.publicKey)
  assert.equal(authority.authenticate('node-1', first.credential), false)
  assert.equal(authority.identify(first.credential), undefined)
  assert.equal(authority.authenticate('node-1', rotated.credential), true)
  assert.equal(authority.identify(rotated.credential), 'node-1')
  assert.throws(() => authority.rotate('node-1', first.credential), /invalid or revoked/)
})

test('revocation blocks current and future authentication', () => {
  const identity = createDeviceIdentity()
  const authority = new PairingAuthority(() => 1_000, 60_000)
  const request = authority.createRequest(requestInput(identity))
  const issued = authority.confirm(request.requestId, request.verificationCode)
  assert.equal(authority.revoke('node-1'), true)
  assert.equal(authority.authenticate('node-1', issued.credential), false)
  assert.equal(authority.identify(issued.credential), undefined)
  assert.equal(authority.revoke('node-1'), false)
  assert.throws(() => authority.rotate('node-1', issued.credential), /invalid or revoked/)
})

test('persists credential digests and revocation across authority restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-pairing-'))
  try {
    const path = join(directory, 'pairing-state.json')
    const identity = createDeviceIdentity()
    const firstAuthority = new PairingAuthority(() => 1_000, 60_000, new FilePairingStateStore(path))
    const request = firstAuthority.createRequest(requestInput(identity))
    const issued = firstAuthority.confirm(request.requestId, request.verificationCode)
    const stored = await readFile(path, 'utf8')
    assert.doesNotMatch(stored, new RegExp(issued.credential))
    assert.equal((await stat(path)).mode & 0o777, 0o600)

    const restarted = new PairingAuthority(() => 1_000, 60_000, new FilePairingStateStore(path))
    assert.equal(restarted.authenticate('node-1', issued.credential), true)
    assert.throws(() => restarted.confirm(request.requestId, request.verificationCode), /already been used/)
    assert.equal(restarted.revoke('node-1'), true)

    const restoredAgain = new PairingAuthority(() => 1_000, 60_000, new FilePairingStateStore(path))
    assert.equal(restoredAgain.authenticate('node-1', issued.credential), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects unsafe pairing data and unsupported platforms', () => {
  const identity = createDeviceIdentity()
  const authority = new PairingAuthority(() => 1_000, 60_000)
  assert.throws(() => authority.createRequest(requestInput(identity, { nodeId: 'node/1' })), /nodeId/)
  assert.throws(() => authority.createRequest(requestInput(identity, { platform: 'linux' })), /platform/)
  assert.throws(() => authority.createRequest(requestInput(identity, { publicKey: 'short' })), /publicKey/)
  assert.throws(() => authority.createRequest(requestInput(identity, { displayName: 'Fake\u001b[2JMac' })), /control characters/)
})
