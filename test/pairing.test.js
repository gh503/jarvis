import assert from 'node:assert/strict'
import test from 'node:test'
import { PairingAuthority, createDeviceIdentity } from '../dist/pairing.js'

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
  assert.equal(authority.authenticate('node-1', rotated.credential), true)
  assert.throws(() => authority.rotate('node-1', first.credential), /invalid or revoked/)
})

test('revocation blocks current and future authentication', () => {
  const identity = createDeviceIdentity()
  const authority = new PairingAuthority(() => 1_000, 60_000)
  const request = authority.createRequest(requestInput(identity))
  const issued = authority.confirm(request.requestId, request.verificationCode)
  assert.equal(authority.revoke('node-1'), true)
  assert.equal(authority.authenticate('node-1', issued.credential), false)
  assert.equal(authority.revoke('node-1'), false)
  assert.throws(() => authority.rotate('node-1', issued.credential), /invalid or revoked/)
})

test('rejects unsafe pairing data and unsupported platforms', () => {
  const identity = createDeviceIdentity()
  const authority = new PairingAuthority(() => 1_000, 60_000)
  assert.throws(() => authority.createRequest(requestInput(identity, { nodeId: 'node/1' })), /nodeId/)
  assert.throws(() => authority.createRequest(requestInput(identity, { platform: 'linux' })), /platform/)
  assert.throws(() => authority.createRequest(requestInput(identity, { publicKey: 'short' })), /publicKey/)
})
