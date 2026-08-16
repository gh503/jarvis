import assert from 'node:assert/strict'
import { createDecipheriv, createHash } from 'node:crypto'
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

function decryptClaim(claim, claimToken) {
  const key = createHash('sha256').update('jarvis-pairing-claim-v1\0').update(claimToken, 'utf8').digest()
  const encrypted = Buffer.from(claim.encryptedCredential.ciphertext, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(claim.encryptedCredential.iv, 'base64url'))
  decipher.setAuthTag(encrypted.subarray(-16))
  return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8')
}

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

test('approves and idempotently claims an encrypted PWA credential without the owner token', () => {
  const identity = createDeviceIdentity()
  const authority = new PairingAuthority(() => 1_000, 60_000)
  const challenge = authority.createClaimableRequest(requestInput(identity, {
    nodeId: 'pwa-one', displayName: 'Owner Phone', platform: 'pwa',
  }))
  assert.match(challenge.claimToken, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(authority.claim(challenge.requestId, challenge.claimToken), undefined)
  assert.throws(() => authority.claim(challenge.requestId, 'A'.repeat(43)), /rejected/)
  assert.throws(() => authority.confirm(challenge.requestId, challenge.verificationCode), /requires owner approval/)

  const approval = authority.approveClaimable(challenge.verificationCode)
  assert.equal(approval.nodeId, 'pwa-one')
  assert.equal(authority.approveClaimable(challenge.verificationCode).approvedAt, approval.approvedAt)
  const firstClaim = authority.claim(challenge.requestId, challenge.claimToken)
  const secondClaim = authority.claim(challenge.requestId, challenge.claimToken)
  assert.deepEqual(secondClaim, firstClaim)
  const credential = decryptClaim(firstClaim, challenge.claimToken)
  assert.match(credential, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(authority.authenticate('pwa-one', credential), true)
  assert.equal(authority.revoke('pwa-one'), true)
  assert.throws(() => authority.claim(challenge.requestId, challenge.claimToken), /revoked/)
})

test('expires an unclaimed PWA request before approval or claim', () => {
  let now = 1_000
  const identity = createDeviceIdentity()
  const authority = new PairingAuthority(() => now, 60_000)
  const challenge = authority.createClaimableRequest(requestInput(identity, {
    nodeId: 'pwa-expired', displayName: 'Expired Phone', platform: 'pwa',
  }))
  now = 61_000
  assert.throws(() => authority.approveClaimable(challenge.verificationCode), /incorrect or ambiguous/)
  assert.throws(() => authority.claim(challenge.requestId, challenge.claimToken), /expired/)
})

test('bounds pending requests and prunes expired entries before admission', () => {
  let now = 1_000
  const identity = createDeviceIdentity()
  const authority = new PairingAuthority(() => now, 60_000, undefined, 1)
  authority.createClaimableRequest(requestInput(identity, {
    nodeId: 'pwa-first', displayName: 'First Phone', platform: 'pwa',
  }))
  assert.throws(() => authority.createClaimableRequest(requestInput(identity, {
    nodeId: 'pwa-second', displayName: 'Second Phone', platform: 'pwa',
  })), /capacity/)
  now = 61_000
  assert.doesNotThrow(() => authority.createClaimableRequest(requestInput(identity, {
    nodeId: 'pwa-second', displayName: 'Second Phone', platform: 'pwa',
  })))
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

test('persists claimable pairing across restart without plaintext claim or device credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-pwa-pairing-'))
  try {
    const path = join(directory, 'pairing-state.json')
    const identity = createDeviceIdentity()
    let authority = new PairingAuthority(() => 1_000, 60_000, new FilePairingStateStore(path))
    const challenge = authority.createClaimableRequest(requestInput(identity, {
      nodeId: 'pwa-restart', displayName: 'Restart Phone', platform: 'pwa',
    }))
    assert.doesNotMatch(await readFile(path, 'utf8'), new RegExp(challenge.claimToken))

    authority = new PairingAuthority(() => 1_000, 60_000, new FilePairingStateStore(path))
    authority.approveClaimable(challenge.verificationCode)
    const claim = authority.claim(challenge.requestId, challenge.claimToken)
    const credential = decryptClaim(claim, challenge.claimToken)
    const stored = await readFile(path, 'utf8')
    assert.doesNotMatch(stored, new RegExp(challenge.claimToken))
    assert.doesNotMatch(stored, new RegExp(credential))

    authority = new PairingAuthority(() => 1_000, 60_000, new FilePairingStateStore(path))
    assert.deepEqual(authority.claim(challenge.requestId, challenge.claimToken), claim)
    assert.equal(authority.authenticate('pwa-restart', credential), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rolls back an issued credential when persistence fails', () => {
  const identity = createDeviceIdentity()
  let failNextSave = false
  let snapshot
  const store = {
    load: () => snapshot,
    save: value => {
      if (failNextSave) {
        failNextSave = false
        throw new Error('disk unavailable')
      }
      snapshot = structuredClone(value)
    },
  }
  const authority = new PairingAuthority(() => 1_000, 60_000, store)
  const request = authority.createRequest(requestInput(identity))
  failNextSave = true
  assert.throws(() => authority.confirm(request.requestId, request.verificationCode), /disk unavailable/)
  const issued = authority.confirm(request.requestId, request.verificationCode)
  assert.equal(authority.authenticate(request.nodeId, issued.credential), true)
})

test('rejects inconsistent version two pairing snapshots', () => {
  const identity = createDeviceIdentity()
  let snapshot
  const store = {
    load: () => snapshot,
    save: value => { snapshot = structuredClone(value) },
  }
  const authority = new PairingAuthority(() => 1_000, 60_000, store)
  const challenge = authority.createClaimableRequest(requestInput(identity, {
    nodeId: 'pwa-corrupt', displayName: 'Corrupt Phone', platform: 'pwa',
  }))
  authority.approveClaimable(challenge.verificationCode)
  authority.claim(challenge.requestId, challenge.claimToken)
  const validSnapshot = structuredClone(snapshot)

  snapshot.devices = []
  assert.throws(() => new PairingAuthority(() => 1_000, 60_000, store), /inconsistent request state/)

  snapshot = structuredClone(validSnapshot)
  snapshot.requests[0].claim = undefined
  assert.throws(() => new PairingAuthority(() => 1_000, 60_000, store), /inconsistent request state/)
})

test('restores version one pairing state and migrates it on the next write', () => {
  const identity = createDeviceIdentity()
  const credential = 'A'.repeat(43)
  let saved
  const store = {
    load: () => ({
      version: 1,
      requests: [],
      devices: [{
        nodeId: 'legacy-node',
        publicKey: identity.publicKey,
        credentialDigest: createHash('sha256').update(credential).digest('base64url'),
        generation: 1,
        issuedAt: 1_000,
        revoked: false,
      }],
    }),
    save: snapshot => { saved = snapshot },
  }
  const authority = new PairingAuthority(() => 2_000, 60_000, store)
  assert.equal(authority.authenticate('legacy-node', credential), true)
  authority.rotate('legacy-node', credential)
  assert.equal(saved.version, 2)
  assert.equal(saved.devices[0].platform, 'macos')
})

test('rejects unsafe pairing data and unsupported platforms', () => {
  const identity = createDeviceIdentity()
  const authority = new PairingAuthority(() => 1_000, 60_000)
  assert.throws(() => authority.createRequest(requestInput(identity, { nodeId: 'node/1' })), /nodeId/)
  assert.throws(() => authority.createRequest(requestInput(identity, { platform: 'linux' })), /platform/)
  assert.throws(() => authority.createClaimableRequest(requestInput(identity)), /platform/)
  assert.throws(() => authority.createRequest(requestInput(identity, { publicKey: 'short' })), /publicKey/)
  assert.throws(() => authority.createRequest(requestInput(identity, { displayName: 'Fake\u001b[2JMac' })), /control characters/)
})
