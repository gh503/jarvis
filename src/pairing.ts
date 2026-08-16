import { createCipheriv, createHash, generateKeyPairSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_PAIRING_TTL_MS = 5 * 60_000
export const DEFAULT_MAX_PENDING_PAIRINGS = 256

export interface DeviceIdentity {
  publicKey: string
  privateKey: string
  fingerprint: string
}

export interface PairingRequestInput {
  nodeId: string
  publicKey: string
  displayName: string
  platform: 'macos' | 'pwa'
}

export interface PairingRequest extends PairingRequestInput {
  requestId: string
  verificationCode: string
  expiresAt: number
}

export interface IssuedCredential {
  nodeId: string
  publicKey: string
  credential: string
  generation: number
  issuedAt: number
}

export interface BrowserPairingChallenge extends PairingRequest {
  claimToken: string
}

export interface EncryptedCredential {
  algorithm: 'A256GCM'
  iv: string
  ciphertext: string
}

export interface BrowserPairingClaim {
  requestId: string
  nodeId: string
  publicKey: string
  generation: number
  issuedAt: number
  encryptedCredential: EncryptedCredential
}

export interface PairingApproval {
  requestId: string
  nodeId: string
  displayName: string
  platform: 'pwa'
  approvedAt: number
  expiresAt: number
}

interface PairingStateSnapshotV1 {
  version: 1
  requests: Array<PairingRequest & { platform: 'macos', used: boolean }>
  devices: Array<{
    nodeId: string
    publicKey: string
    credentialDigest: string
    generation: number
    issuedAt: number
    revoked: boolean
  }>
}

export interface PairingStateSnapshotV2 {
  version: 2
  requests: Array<PairingRequest & {
    used: boolean
    flow: 'direct' | 'claimable'
    approvedAt?: number
    claimTokenDigest?: string
    claim?: BrowserPairingClaim
  }>
  devices: Array<{
    nodeId: string
    publicKey: string
    displayName: string
    platform: 'macos' | 'pwa'
    credentialDigest: string
    generation: number
    issuedAt: number
    revoked: boolean
  }>
}

export type PairingStateSnapshot = PairingStateSnapshotV1 | PairingStateSnapshotV2

export interface PairingStateStore {
  load(): PairingStateSnapshot | undefined
  save(snapshot: PairingStateSnapshotV2): void
}

interface CredentialRecord {
  nodeId: string
  publicKey: string
  displayName: string
  platform: 'macos' | 'pwa'
  credentialDigest: Buffer
  generation: number
  issuedAt: number
  revoked: boolean
}

interface PendingPairing extends PairingRequest {
  used: boolean
  flow: 'direct' | 'claimable'
  approvedAt?: number
  claimTokenDigest?: Buffer
  claim?: BrowserPairingClaim
}

export class FilePairingStateStore implements PairingStateStore {
  constructor(readonly path: string) {}

  load(): PairingStateSnapshot | undefined {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as PairingStateSnapshot
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw new Error('pairing state could not be read')
    }
  }

  save(snapshot: PairingStateSnapshotV2): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
  }
}

function validateIdentifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new TypeError(`${field} contains unsupported characters`)
  }
  return value
}

function validateText(value: string, field: string): string {
  if (value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${field} must be 1 to 128 characters without control characters`)
  }
  return value
}

function validatePublicKey(value: string): string {
  if (!/^[A-Za-z0-9_-]{40,256}$/.test(value)) throw new TypeError('publicKey is not valid encoded key data')
  return value
}

function credentialDigest(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest()
}

function validatePlatform(value: string): 'macos' | 'pwa' {
  if (value !== 'macos' && value !== 'pwa') throw new Error('pairing platform is unsupported')
  return value
}

function validateClaimToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('pairing claim rejected')
  return value
}

function encryptCredential(credential: string, claimToken: string): EncryptedCredential {
  const key = createHash('sha256').update('jarvis-pairing-claim-v1\0').update(claimToken, 'utf8').digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(credential, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return {
    algorithm: 'A256GCM',
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  }
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function publicRequest(request: PendingPairing): PairingRequest {
  return {
    requestId: request.requestId,
    nodeId: request.nodeId,
    publicKey: request.publicKey,
    displayName: request.displayName,
    platform: request.platform,
    verificationCode: request.verificationCode,
    expiresAt: request.expiresAt,
  }
}

export function createDeviceIdentity(): DeviceIdentity {
  const pair = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  const publicKey = pair.publicKey.toString('base64url')
  const privateKey = pair.privateKey.toString('base64url')
  return {
    publicKey,
    privateKey,
    fingerprint: createHash('sha256').update(pair.publicKey).digest('hex'),
  }
}

export class PairingAuthority {
  private readonly requests = new Map<string, PendingPairing>()
  private readonly devices = new Map<string, CredentialRecord>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly pairingTtlMs = DEFAULT_PAIRING_TTL_MS,
    private readonly store?: PairingStateStore,
    private readonly maxPendingPairings = DEFAULT_MAX_PENDING_PAIRINGS,
  ) {
    if (!Number.isInteger(pairingTtlMs) || pairingTtlMs < 1_000) {
      throw new RangeError('pairingTtlMs must be at least one second')
    }
    if (!Number.isInteger(maxPendingPairings) || maxPendingPairings < 1) {
      throw new RangeError('maxPendingPairings must be a positive integer')
    }
    this.restore(this.store?.load())
  }

  createRequest(input: PairingRequestInput): PairingRequest {
    if (input.platform !== 'macos') throw new Error('direct pairing platform must be macos')
    const request = this.createPending(input, 'direct')
    return publicRequest(request)
  }

  createClaimableRequest(input: PairingRequestInput): BrowserPairingChallenge {
    if (input.platform !== 'pwa') throw new Error('claimable pairing platform must be pwa')
    const claimToken = randomBytes(32).toString('base64url')
    const request = this.createPending(input, 'claimable', credentialDigest(claimToken))
    return { ...publicRequest(request), claimToken }
  }

  confirm(requestId: string, verificationCode: string): IssuedCredential {
    const request = this.requests.get(requestId)
    if (request === undefined) throw new Error('pairing request not found')
    if (request.flow !== 'direct') throw new Error('pairing request requires owner approval and device claim')
    if (request.used) throw new Error('pairing request has already been used')
    if (request.expiresAt <= this.now()) throw new Error('pairing request has expired')
    if (!/^\d{6}$/.test(verificationCode) || verificationCode !== request.verificationCode) {
      throw new Error('pairing verification code is incorrect')
    }
    const existing = this.devices.get(request.nodeId)
    if (existing !== undefined && !existing.revoked) throw new Error('device is already paired')
    request.used = true
    try {
      return this.issue(request.nodeId, request.publicKey, request.displayName, request.platform, 1)
    } catch (error) {
      request.used = false
      throw error
    }
  }

  approveClaimable(verificationCode: string): PairingApproval {
    if (!/^\d{6}$/.test(verificationCode)) throw new Error('pairing verification code is incorrect')
    const matches = [...this.requests.values()].filter(request => request.flow === 'claimable'
      && request.verificationCode === verificationCode && request.expiresAt > this.now())
    if (matches.length !== 1) throw new Error('pairing verification code is incorrect or ambiguous')
    const request = matches[0] as PendingPairing
    const existing = this.devices.get(request.nodeId)
    if (request.claim === undefined && existing !== undefined && !existing.revoked) throw new Error('device is already paired')
    if (request.approvedAt === undefined) {
      request.approvedAt = this.now()
      try {
        this.persist()
      } catch (error) {
        delete request.approvedAt
        throw error
      }
    }
    return {
      requestId: request.requestId,
      nodeId: request.nodeId,
      displayName: request.displayName,
      platform: 'pwa',
      approvedAt: request.approvedAt,
      expiresAt: request.expiresAt,
    }
  }

  claim(requestId: string, claimToken: string): BrowserPairingClaim | undefined {
    const request = this.requests.get(requestId)
    if (request === undefined || request.flow !== 'claimable' || request.claimTokenDigest === undefined) {
      throw new Error('pairing claim rejected')
    }
    if (request.expiresAt <= this.now()) throw new Error('pairing request has expired')
    const token = validateClaimToken(claimToken)
    if (!sameDigest(request.claimTokenDigest, credentialDigest(token))) throw new Error('pairing claim rejected')
    if (request.approvedAt === undefined) return undefined
    if (request.claim !== undefined) {
      if (!this.isActive(request.nodeId)) throw new Error('paired device is revoked')
      return { ...request.claim, encryptedCredential: { ...request.claim.encryptedCredential } }
    }
    const existing = this.devices.get(request.nodeId)
    if (existing !== undefined && !existing.revoked) throw new Error('device is already paired')
    const credential = randomBytes(32).toString('base64url')
    const issuedAt = this.now()
    const generation = 1
    const claim: BrowserPairingClaim = {
      requestId: request.requestId,
      nodeId: request.nodeId,
      publicKey: request.publicKey,
      generation,
      issuedAt,
      encryptedCredential: encryptCredential(credential, token),
    }
    this.devices.set(request.nodeId, {
      nodeId: request.nodeId,
      publicKey: request.publicKey,
      displayName: request.displayName,
      platform: request.platform,
      credentialDigest: credentialDigest(credential),
      generation,
      issuedAt,
      revoked: false,
    })
    request.used = true
    request.claim = claim
    try {
      this.persist()
    } catch (error) {
      if (existing === undefined) this.devices.delete(request.nodeId)
      else this.devices.set(request.nodeId, existing)
      request.used = false
      delete request.claim
      throw error
    }
    return { ...claim, encryptedCredential: { ...claim.encryptedCredential } }
  }

  authenticate(nodeId: string, credential: string): boolean {
    const record = this.devices.get(nodeId)
    if (record === undefined || record.revoked) return false
    return sameDigest(record.credentialDigest, credentialDigest(credential))
  }

  identify(credential: string): string | undefined {
    const digest = credentialDigest(credential)
    for (const record of this.devices.values()) {
      if (!record.revoked && sameDigest(record.credentialDigest, digest)) return record.nodeId
    }
    return undefined
  }

  isActive(nodeId: string): boolean {
    const record = this.devices.get(nodeId)
    return record !== undefined && !record.revoked
  }

  rotate(nodeId: string, currentCredential: string): IssuedCredential {
    const record = this.requireAuthenticated(nodeId, currentCredential)
    return this.issue(record.nodeId, record.publicKey, record.displayName, record.platform, record.generation + 1)
  }

  revoke(nodeId: string): boolean {
    const record = this.devices.get(nodeId)
    if (record === undefined || record.revoked) return false
    record.revoked = true
    try {
      this.persist()
    } catch (error) {
      record.revoked = false
      throw error
    }
    return true
  }

  private createPending(input: PairingRequestInput, flow: 'direct' | 'claimable', claimTokenDigest?: Buffer): PendingPairing {
    for (const [requestId, request] of this.requests) {
      if (request.expiresAt <= this.now()) this.requests.delete(requestId)
    }
    if (this.requests.size >= this.maxPendingPairings) throw new Error('pairing request capacity has been reached')
    const request: PendingPairing = {
      requestId: randomBytes(16).toString('base64url'),
      nodeId: validateIdentifier(input.nodeId, 'nodeId'),
      publicKey: validatePublicKey(input.publicKey),
      displayName: validateText(input.displayName, 'displayName'),
      platform: validatePlatform(input.platform),
      verificationCode: randomInt(0, 1_000_000).toString().padStart(6, '0'),
      expiresAt: this.now() + this.pairingTtlMs,
      used: false,
      flow,
      ...(claimTokenDigest === undefined ? {} : { claimTokenDigest }),
    }
    this.requests.set(request.requestId, request)
    try {
      this.persist()
    } catch (error) {
      this.requests.delete(request.requestId)
      throw error
    }
    return request
  }

  private persist(): void {
    this.store?.save({
      version: 2,
      requests: [...this.requests.values()].map(request => ({
        ...publicRequest(request),
        used: request.used,
        flow: request.flow,
        ...(request.approvedAt === undefined ? {} : { approvedAt: request.approvedAt }),
        ...(request.claimTokenDigest === undefined ? {} : { claimTokenDigest: request.claimTokenDigest.toString('base64url') }),
        ...(request.claim === undefined ? {} : { claim: request.claim }),
      })),
      devices: [...this.devices.values()].map(device => ({
        nodeId: device.nodeId,
        publicKey: device.publicKey,
        displayName: device.displayName,
        platform: device.platform,
        credentialDigest: device.credentialDigest.toString('base64url'),
        generation: device.generation,
        issuedAt: device.issuedAt,
        revoked: device.revoked,
      })),
    })
  }

  private restore(snapshot: PairingStateSnapshot | undefined): void {
    if (snapshot === undefined) return
    if ((snapshot.version !== 1 && snapshot.version !== 2)
      || !Array.isArray(snapshot.requests) || !Array.isArray(snapshot.devices)) {
      throw new Error('pairing state has an unsupported format')
    }
    for (const request of snapshot.requests) {
      const requestV2 = snapshot.version === 2
        ? request as PairingStateSnapshotV2['requests'][number]
        : undefined
      if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(request.requestId)
        || typeof request.verificationCode !== 'string' || !/^\d{6}$/.test(request.verificationCode)
        || typeof request.expiresAt !== 'number' || !Number.isFinite(request.expiresAt)
        || typeof request.used !== 'boolean') throw new Error('pairing state contains an invalid request')
      const platform = validatePlatform(request.platform)
      const flow = requestV2 === undefined ? 'direct' : requestV2.flow
      if (flow !== 'direct' && flow !== 'claimable') throw new Error('pairing state contains an invalid request flow')
      const approvedAt = requestV2?.approvedAt
      if (approvedAt !== undefined && (typeof approvedAt !== 'number' || !Number.isFinite(approvedAt))) {
        throw new Error('pairing state contains an invalid approval')
      }
      const claimTokenDigest = requestV2?.claimTokenDigest !== undefined
        ? Buffer.from(requestV2.claimTokenDigest, 'base64url')
        : undefined
      if (claimTokenDigest !== undefined && claimTokenDigest.length !== 32) {
        throw new Error('pairing state contains an invalid claim digest')
      }
      const claim = requestV2?.claim
      if (claim !== undefined) {
        if (claim.requestId !== request.requestId || claim.nodeId !== request.nodeId || claim.publicKey !== request.publicKey
          || !Number.isInteger(claim.generation) || claim.generation < 1
          || typeof claim.issuedAt !== 'number' || !Number.isFinite(claim.issuedAt)
          || claim.encryptedCredential?.algorithm !== 'A256GCM'
          || typeof claim.encryptedCredential.iv !== 'string' || Buffer.from(claim.encryptedCredential.iv, 'base64url').length !== 12
          || typeof claim.encryptedCredential.ciphertext !== 'string'
          || Buffer.from(claim.encryptedCredential.ciphertext, 'base64url').length < 17) {
          throw new Error('pairing state contains an invalid encrypted claim')
        }
      }
      const restored: PendingPairing = {
        requestId: request.requestId,
        nodeId: validateIdentifier(request.nodeId, 'nodeId'),
        publicKey: validatePublicKey(request.publicKey),
        displayName: validateText(request.displayName, 'displayName'),
        platform,
        verificationCode: request.verificationCode,
        expiresAt: request.expiresAt,
        used: request.used,
        flow,
        ...(approvedAt === undefined ? {} : { approvedAt }),
        ...(claimTokenDigest === undefined ? {} : { claimTokenDigest }),
        ...(claim === undefined ? {} : { claim: { ...claim, encryptedCredential: { ...claim.encryptedCredential } } }),
      }
      if ((flow === 'direct' && (platform !== 'macos' || claimTokenDigest !== undefined || approvedAt !== undefined || claim !== undefined))
        || (flow === 'claimable' && (platform !== 'pwa' || claimTokenDigest === undefined))
        || (claim !== undefined && (!restored.used || approvedAt === undefined))) {
        throw new Error('pairing state contains inconsistent request state')
      }
      if (this.requests.has(restored.requestId)) throw new Error('pairing state contains duplicate requests')
      this.requests.set(restored.requestId, restored)
    }
    for (const device of snapshot.devices) {
      const deviceV2 = snapshot.version === 2
        ? device as PairingStateSnapshotV2['devices'][number]
        : undefined
      if (typeof device.credentialDigest !== 'string' || typeof device.generation !== 'number'
        || !Number.isInteger(device.generation) || device.generation < 1
        || typeof device.issuedAt !== 'number' || !Number.isFinite(device.issuedAt)
        || typeof device.revoked !== 'boolean') throw new Error('pairing state contains an invalid device')
      const digest = Buffer.from(device.credentialDigest, 'base64url')
      const restored: CredentialRecord = {
        nodeId: validateIdentifier(device.nodeId, 'nodeId'),
        publicKey: validatePublicKey(device.publicKey),
        displayName: deviceV2 === undefined ? validateIdentifier(device.nodeId, 'nodeId') : validateText(deviceV2.displayName, 'displayName'),
        platform: deviceV2 === undefined ? 'macos' : validatePlatform(deviceV2.platform),
        credentialDigest: digest,
        generation: device.generation,
        issuedAt: device.issuedAt,
        revoked: device.revoked,
      }
      if (digest.length !== 32 || this.devices.has(restored.nodeId)) throw new Error('pairing state contains duplicate or invalid devices')
      this.devices.set(restored.nodeId, restored)
    }
    for (const request of this.requests.values()) {
      const device = this.devices.get(request.nodeId)
      const matchingDevice = device !== undefined
        && device.publicKey === request.publicKey
        && device.displayName === request.displayName
        && device.platform === request.platform
      if (request.flow === 'direct' && request.used && !matchingDevice) {
        throw new Error('pairing state contains inconsistent request state')
      }
      if (request.flow === 'claimable') {
        if (request.used !== (request.claim !== undefined) || (request.claim !== undefined && !matchingDevice)) {
          throw new Error('pairing state contains inconsistent request state')
        }
        if (request.claim !== undefined && device !== undefined
          && (device.generation < request.claim.generation
            || (device.generation === request.claim.generation && device.issuedAt !== request.claim.issuedAt)
            || (device.generation > request.claim.generation && device.issuedAt < request.claim.issuedAt))) {
          throw new Error('pairing state contains inconsistent request state')
        }
      }
    }
  }

  private requireAuthenticated(nodeId: string, credential: string): CredentialRecord {
    const record = this.devices.get(nodeId)
    if (record === undefined || record.revoked || !sameDigest(record.credentialDigest, credentialDigest(credential))) {
      throw new Error('device credential is invalid or revoked')
    }
    return record
  }

  private issue(
    nodeId: string,
    publicKey: string,
    displayName: string,
    platform: 'macos' | 'pwa',
    generation: number,
  ): IssuedCredential {
    const credential = randomBytes(32).toString('base64url')
    const issuedAt = this.now()
    const previous = this.devices.get(nodeId)
    this.devices.set(nodeId, {
      nodeId,
      publicKey,
      displayName,
      platform,
      credentialDigest: credentialDigest(credential),
      generation,
      issuedAt,
      revoked: false,
    })
    try {
      this.persist()
    } catch (error) {
      if (previous === undefined) this.devices.delete(nodeId)
      else this.devices.set(nodeId, previous)
      throw error
    }
    return { nodeId, publicKey, credential, generation, issuedAt }
  }
}
