import type { DeviceIdentity } from './pairing.js'

const MAX_RESPONSE_BYTES = 32 * 1024

export interface DeviceIdentityStore {
  loadOrCreate(nodeId: string): Promise<DeviceIdentity>
}

export interface DeviceCredentialStore {
  write(nodeId: string, credential: string): Promise<void>
}

export interface PairNodeInput {
  nodeId: string
  displayName: string
}

export interface NodePairingChallenge {
  requestId: string
  nodeId: string
  displayName: string
  verificationCode: string
  fingerprint: string
  expiresAt: number
}

export interface PairedNode {
  nodeId: string
  publicKey: string
  fingerprint: string
  generation: number
  issuedAt: number
}

interface PendingChallenge extends NodePairingChallenge {
  publicKey: string
}

function validateIdentifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new TypeError(`${field} contains unsupported characters`)
  }
  return value
}

function validateDisplayName(value: string): string {
  if (value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('displayName must be 1 to 128 characters without control characters')
  }
  return value
}

function validateOwnerToken(value: string): string {
  if (value.length < 16 || value.length > 4096 || /[\r\n]/.test(value)) {
    throw new TypeError('ownerToken must be 16 to 4096 characters without line breaks')
  }
  return value
}

function loopbackOrigin(value: string): string {
  const url = new URL(value)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.hostname !== '127.0.0.1'
    || url.username !== ''
    || url.password !== ''
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search !== ''
    || url.hash !== '') {
    throw new Error('pairing gateway must be an HTTP(S) 127.0.0.1 origin')
  }
  return url.origin
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validatePublicKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{40,256}$/.test(value)) {
    throw new Error('gateway returned an invalid public key')
  }
  return value
}

function parseChallenge(value: unknown, input: PairNodeInput, identity: DeviceIdentity): PendingChallenge {
  if (!record(value)
    || typeof value.requestId !== 'string'
    || !/^[A-Za-z0-9_-]{16,64}$/.test(value.requestId)
    || value.nodeId !== input.nodeId
    || value.displayName !== input.displayName
    || value.platform !== 'macos'
    || value.publicKey !== identity.publicKey
    || typeof value.verificationCode !== 'string'
    || !/^\d{6}$/.test(value.verificationCode)
    || typeof value.expiresAt !== 'number'
    || !Number.isFinite(value.expiresAt)) {
    throw new Error('gateway returned an invalid pairing challenge')
  }
  return {
    requestId: value.requestId,
    nodeId: input.nodeId,
    displayName: input.displayName,
    publicKey: identity.publicKey,
    verificationCode: value.verificationCode,
    fingerprint: identity.fingerprint,
    expiresAt: value.expiresAt,
  }
}

function parseIssuedCredential(value: unknown, challenge: PendingChallenge): {
  credential: string
  pairedNode: PairedNode
} {
  if (!record(value)
    || value.nodeId !== challenge.nodeId
    || validatePublicKey(value.publicKey) !== challenge.publicKey
    || typeof value.credential !== 'string'
    || value.credential.length < 16
    || value.credential.length > 127
    || /[\r\n]/.test(value.credential)
    || typeof value.generation !== 'number'
    || !Number.isInteger(value.generation)
    || value.generation < 1
    || typeof value.issuedAt !== 'number'
    || !Number.isFinite(value.issuedAt)) {
    throw new Error('gateway returned an invalid device credential')
  }
  return {
    credential: value.credential,
    pairedNode: {
      nodeId: challenge.nodeId,
      publicKey: challenge.publicKey,
      fingerprint: challenge.fingerprint,
      generation: value.generation,
      issuedAt: value.issuedAt,
    },
  }
}

export class NodePairingCoordinator {
  private readonly origin: string
  private readonly ownerToken: string
  private readonly pending = new Map<string, PendingChallenge>()

  constructor(
    gatewayUrl: string,
    ownerToken: string,
    private readonly identities: DeviceIdentityStore,
    private readonly credentials: DeviceCredentialStore,
    private readonly fetchValue: typeof fetch = fetch,
  ) {
    this.origin = loopbackOrigin(gatewayUrl)
    this.ownerToken = validateOwnerToken(ownerToken)
  }

  async begin(input: PairNodeInput): Promise<NodePairingChallenge> {
    const validatedInput = {
      nodeId: validateIdentifier(input.nodeId, 'nodeId'),
      displayName: validateDisplayName(input.displayName),
    }
    const identity = await this.identities.loadOrCreate(validatedInput.nodeId)
    const challenge = parseChallenge(await this.request('/v1/pairing/requests', {
      method: 'POST',
      body: JSON.stringify({
        ...validatedInput,
        publicKey: identity.publicKey,
        platform: 'macos',
      }),
    }), validatedInput, identity)
    this.pending.set(challenge.requestId, challenge)
    const { publicKey: _publicKey, ...publicChallenge } = challenge
    return publicChallenge
  }

  async confirm(requestId: string, verificationCode: string): Promise<PairedNode> {
    const challenge = this.pending.get(requestId)
    if (challenge === undefined) throw new Error('pairing challenge is not active in this process')
    if (verificationCode !== challenge.verificationCode) {
      throw new Error('verification code did not match; pairing was not confirmed')
    }
    const issued = parseIssuedCredential(await this.request('/v1/pairing/requests/confirm', {
      method: 'POST',
      body: JSON.stringify({ requestId, verificationCode }),
    }), challenge)
    this.pending.delete(requestId)
    try {
      await this.credentials.write(challenge.nodeId, issued.credential)
    } catch {
      try {
        await this.revoke(challenge.nodeId)
      } catch {
        throw new Error('device credential storage failed and automatic revocation failed')
      }
      throw new Error('device credential storage failed; the paired device was revoked')
    }
    return issued.pairedNode
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchValue(new URL(path, this.origin), {
      ...init,
      headers: {
        authorization: `Bearer ${this.ownerToken}`,
        'content-type': 'application/json',
      },
    })
    const body = await response.text()
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('gateway response is too large')
    if (!response.ok) throw new Error(`gateway pairing request failed with status ${response.status}`)
    try {
      return JSON.parse(body)
    } catch {
      throw new Error('gateway returned invalid JSON')
    }
  }

  private async revoke(nodeId: string): Promise<void> {
    const response = await this.fetchValue(new URL(`/v1/devices/${encodeURIComponent(nodeId)}`, this.origin), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.ownerToken}` },
    })
    if (response.status !== 204) throw new Error('automatic device revocation failed')
  }
}
