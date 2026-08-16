import { createHash, generateKeyPairSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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

export interface PairingStateSnapshot {
  version: 1
  requests: Array<PairingRequest & { used: boolean }>
  devices: Array<{
    nodeId: string
    publicKey: string
    credentialDigest: string
    generation: number
    issuedAt: number
    revoked: boolean
  }>
}

export interface PairingStateStore {
  load(): PairingStateSnapshot | undefined
  save(snapshot: PairingStateSnapshot): void
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

  save(snapshot: PairingStateSnapshot): void {
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
    private readonly store?: PairingStateStore,
  ) {
    if (!Number.isInteger(pairingTtlMs) || pairingTtlMs < 1_000) {
      throw new RangeError('pairingTtlMs must be at least one second')
    }
    this.restore(this.store?.load())
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
    this.persist()
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

  isActive(nodeId: string): boolean {
    const record = this.devices.get(nodeId)
    return record !== undefined && !record.revoked
  }

  rotate(nodeId: string, currentCredential: string): IssuedCredential {
    const record = this.requireAuthenticated(nodeId, currentCredential)
    return this.issue(record.nodeId, record.publicKey, record.generation + 1)
  }

  revoke(nodeId: string): boolean {
    const record = this.devices.get(nodeId)
    if (record === undefined || record.revoked) return false
    record.revoked = true
    this.persist()
    return true
  }

  private persist(): void {
    this.store?.save({
      version: 1,
      requests: [...this.requests.values()].map(request => ({ ...request })),
      devices: [...this.devices.values()].map(device => ({
        nodeId: device.nodeId,
        publicKey: device.publicKey,
        credentialDigest: device.credentialDigest.toString('base64url'),
        generation: device.generation,
        issuedAt: device.issuedAt,
        revoked: device.revoked,
      })),
    })
  }

  private restore(snapshot: PairingStateSnapshot | undefined): void {
    if (snapshot === undefined) return
    if (snapshot.version !== 1 || !Array.isArray(snapshot.requests) || !Array.isArray(snapshot.devices)) {
      throw new Error('pairing state has an unsupported format')
    }
    for (const request of snapshot.requests) {
      if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(request.requestId)
        || typeof request.verificationCode !== 'string' || !/^\d{6}$/.test(request.verificationCode)
        || typeof request.expiresAt !== 'number' || !Number.isFinite(request.expiresAt)
        || typeof request.used !== 'boolean') throw new Error('pairing state contains an invalid request')
      const restored: PendingPairing = {
        requestId: request.requestId,
        nodeId: validateIdentifier(request.nodeId, 'nodeId'),
        publicKey: validatePublicKey(request.publicKey),
        displayName: validateText(request.displayName, 'displayName'),
        platform: request.platform,
        verificationCode: request.verificationCode,
        expiresAt: request.expiresAt,
        used: request.used,
      }
      if (restored.platform !== 'macos') throw new Error('pairing state contains an unsupported platform')
      if (this.requests.has(restored.requestId)) throw new Error('pairing state contains duplicate requests')
      this.requests.set(restored.requestId, restored)
    }
    for (const device of snapshot.devices) {
      if (typeof device.credentialDigest !== 'string' || typeof device.generation !== 'number'
        || !Number.isInteger(device.generation) || device.generation < 1
        || typeof device.issuedAt !== 'number' || !Number.isFinite(device.issuedAt)
        || typeof device.revoked !== 'boolean') throw new Error('pairing state contains an invalid device')
      const digest = Buffer.from(device.credentialDigest, 'base64url')
      const restored: CredentialRecord = {
        nodeId: validateIdentifier(device.nodeId, 'nodeId'),
        publicKey: validatePublicKey(device.publicKey),
        credentialDigest: digest,
        generation: device.generation,
        issuedAt: device.issuedAt,
        revoked: device.revoked,
      }
      if (digest.length !== 32 || this.devices.has(restored.nodeId)) throw new Error('pairing state contains duplicate or invalid devices')
      this.devices.set(restored.nodeId, restored)
    }
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
    this.persist()
    return { nodeId, publicKey, credential, generation, issuedAt }
  }
}
