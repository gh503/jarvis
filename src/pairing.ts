import { createHash, generateKeyPairSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

export const DEFAULT_PAIRING_TTL_MS = 5 * 60_000

export interface DeviceIdentity {
  publicKey: string
  privateKey: string
  fingerprint: string
}

export interface PairingRequestInput {
  nodeId: string
  publicKey: string
  displayName: string
  platform: 'macos'
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

interface CredentialRecord {
  nodeId: string
  publicKey: string
  credentialDigest: Buffer
  generation: number
  issuedAt: number
  revoked: boolean
}

interface PendingPairing extends PairingRequest {
  used: boolean
}

function validateIdentifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new TypeError(`${field} contains unsupported characters`)
  }
  return value
}

function validateText(value: string, field: string): string {
  if (value.length < 1 || value.length > 128 || /[\r\n]/.test(value)) {
    throw new TypeError(`${field} must be 1 to 128 characters without line breaks`)
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

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
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
  ) {
    if (!Number.isInteger(pairingTtlMs) || pairingTtlMs < 1_000) {
      throw new RangeError('pairingTtlMs must be at least one second')
    }
  }

  createRequest(input: PairingRequestInput): PairingRequest {
    const nodeId = validateIdentifier(input.nodeId, 'nodeId')
    const publicKey = validatePublicKey(input.publicKey)
    const displayName = validateText(input.displayName, 'displayName')
    if (input.platform !== 'macos') throw new Error('pairing platform must be macos')
    const request: PendingPairing = {
      requestId: randomBytes(16).toString('base64url'),
      nodeId,
      publicKey,
      displayName,
      platform: 'macos',
      verificationCode: randomInt(0, 1_000_000).toString().padStart(6, '0'),
      expiresAt: this.now() + this.pairingTtlMs,
      used: false,
    }
    this.requests.set(request.requestId, request)
    return { ...request }
  }

  confirm(requestId: string, verificationCode: string): IssuedCredential {
    const request = this.requests.get(requestId)
    if (request === undefined) throw new Error('pairing request not found')
    if (request.used) throw new Error('pairing request has already been used')
    if (request.expiresAt <= this.now()) throw new Error('pairing request has expired')
    if (!/^\d{6}$/.test(verificationCode) || verificationCode !== request.verificationCode) {
      throw new Error('pairing verification code is incorrect')
    }
    const existing = this.devices.get(request.nodeId)
    if (existing !== undefined && !existing.revoked) throw new Error('device is already paired')
    request.used = true
    return this.issue(request.nodeId, request.publicKey, 1)
  }

  authenticate(nodeId: string, credential: string): boolean {
    const record = this.devices.get(nodeId)
    if (record === undefined || record.revoked) return false
    return sameDigest(record.credentialDigest, credentialDigest(credential))
  }

  rotate(nodeId: string, currentCredential: string): IssuedCredential {
    const record = this.requireAuthenticated(nodeId, currentCredential)
    return this.issue(record.nodeId, record.publicKey, record.generation + 1)
  }

  revoke(nodeId: string): boolean {
    const record = this.devices.get(nodeId)
    if (record === undefined || record.revoked) return false
    record.revoked = true
    return true
  }

  private requireAuthenticated(nodeId: string, credential: string): CredentialRecord {
    const record = this.devices.get(nodeId)
    if (record === undefined || record.revoked || !sameDigest(record.credentialDigest, credentialDigest(credential))) {
      throw new Error('device credential is invalid or revoked')
    }
    return record
  }

  private issue(nodeId: string, publicKey: string, generation: number): IssuedCredential {
    const credential = randomBytes(32).toString('base64url')
    const issuedAt = this.now()
    this.devices.set(nodeId, {
      nodeId,
      publicKey,
      credentialDigest: credentialDigest(credential),
      generation,
      issuedAt,
      revoked: false,
    })
    return { nodeId, publicKey, credential, generation, issuedAt }
  }
}
