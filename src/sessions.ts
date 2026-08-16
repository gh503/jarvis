import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_ACCESS_TTL_MS = 15 * 60_000
export const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60_000

const DEFAULT_MAX_SESSIONS = 256
const DEFAULT_MAX_SESSIONS_PER_DEVICE = 8
const DEFAULT_MAX_REFRESH_ROTATIONS = 128
const REVOKED_RETENTION_MS = 7 * 24 * 60 * 60_000

export type SessionRevokeReason = 'owner' | 'device' | 'refresh-reuse' | 'refresh-expired' | 'rotation-limit'

export interface SessionPrincipal {
  sessionId: string
  familyId: string
  nodeId: string
}

export interface SessionTokens extends SessionPrincipal {
  accessToken: string
  refreshToken: string
  accessExpiresAt: number
  refreshExpiresAt: number
}

export interface SessionView extends SessionPrincipal {
  issuedAt: number
  refreshedAt: number
  accessExpiresAt: number
  refreshExpiresAt: number
  rotation: number
  revokedAt: number | null
  revokeReason: SessionRevokeReason | null
}

export interface SessionStateSnapshot {
  version: 1
  sessions: Array<SessionView & {
    accessDigest: string
    refreshDigest: string
    usedRefreshDigests: string[]
  }>
}

export interface SessionStateStore {
  load(): SessionStateSnapshot | undefined
  save(snapshot: SessionStateSnapshot): void
}

export interface SessionAuthorityOptions {
  now?: () => number
  accessTtlMs?: number
  refreshTtlMs?: number
  maxSessions?: number
  maxSessionsPerDevice?: number
  maxRefreshRotations?: number
  store?: SessionStateStore
}

interface SessionRecord extends SessionView {
  accessDigest: Buffer
  refreshDigest: Buffer
  usedRefreshDigests: Buffer[]
}

export class SessionAuthenticationError extends Error {
  constructor(readonly code: 'invalid' | 'expired' | 'reuse') {
    super(code === 'reuse' ? 'refresh token reuse detected' : `session token is ${code}`)
  }
}

export class FileSessionStateStore implements SessionStateStore {
  constructor(readonly path: string) {}

  load(): SessionStateSnapshot | undefined {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as SessionStateSnapshot
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw new Error('session state could not be read')
    }
  }

  save(snapshot: SessionStateSnapshot): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    renameSync(temporary, this.path)
    chmodSync(this.path, 0o600)
  }
}

function positiveInteger(value: number, field: string, minimum = 1): number {
  if (!Number.isInteger(value) || value < minimum) throw new RangeError(`${field} must be an integer of at least ${minimum}`)
  return value
}

function validateIdentifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new TypeError(`${field} contains unsupported characters`)
  }
  return value
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

function validToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token)
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function decodeDigest(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('session state contains an invalid token digest')
  }
  const digest = Buffer.from(value, 'base64url')
  if (digest.length !== 32 || digest.toString('base64url') !== value) {
    throw new Error('session state contains an invalid token digest')
  }
  return digest
}

function view(record: SessionRecord): SessionView {
  return {
    sessionId: record.sessionId,
    familyId: record.familyId,
    nodeId: record.nodeId,
    issuedAt: record.issuedAt,
    refreshedAt: record.refreshedAt,
    accessExpiresAt: record.accessExpiresAt,
    refreshExpiresAt: record.refreshExpiresAt,
    rotation: record.rotation,
    revokedAt: record.revokedAt,
    revokeReason: record.revokeReason,
  }
}

export class SessionAuthority {
  private readonly now: () => number
  private readonly accessTtlMs: number
  private readonly refreshTtlMs: number
  private readonly maxSessions: number
  private readonly maxSessionsPerDevice: number
  private readonly maxRefreshRotations: number
  private readonly store: SessionStateStore | undefined
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(options: SessionAuthorityOptions = {}) {
    this.now = options.now ?? Date.now
    this.accessTtlMs = positiveInteger(options.accessTtlMs ?? DEFAULT_ACCESS_TTL_MS, 'accessTtlMs', 1_000)
    this.refreshTtlMs = positiveInteger(options.refreshTtlMs ?? DEFAULT_REFRESH_TTL_MS, 'refreshTtlMs', this.accessTtlMs + 1)
    this.maxSessions = positiveInteger(options.maxSessions ?? DEFAULT_MAX_SESSIONS, 'maxSessions')
    this.maxSessionsPerDevice = positiveInteger(options.maxSessionsPerDevice ?? DEFAULT_MAX_SESSIONS_PER_DEVICE, 'maxSessionsPerDevice')
    this.maxRefreshRotations = positiveInteger(options.maxRefreshRotations ?? DEFAULT_MAX_REFRESH_ROTATIONS, 'maxRefreshRotations')
    this.store = options.store
    this.restore(this.store?.load())
  }

  issue(nodeIdValue: string): SessionTokens {
    const nodeId = validateIdentifier(nodeIdValue, 'nodeId')
    this.prune()
    const activeForDevice = [...this.sessions.values()].filter(record => record.nodeId === nodeId && !this.inactive(record))
    if (this.sessions.size >= this.maxSessions) throw new Error('session capacity has been reached')
    if (activeForDevice.length >= this.maxSessionsPerDevice) throw new Error('device session capacity has been reached')
    const now = this.now()
    const accessToken = opaqueToken()
    const refreshToken = opaqueToken()
    const record: SessionRecord = {
      sessionId: randomBytes(16).toString('base64url'),
      familyId: randomBytes(16).toString('base64url'),
      nodeId,
      accessDigest: tokenDigest(accessToken),
      refreshDigest: tokenDigest(refreshToken),
      usedRefreshDigests: [],
      issuedAt: now,
      refreshedAt: now,
      accessExpiresAt: now + this.accessTtlMs,
      refreshExpiresAt: now + this.refreshTtlMs,
      rotation: 0,
      revokedAt: null,
      revokeReason: null,
    }
    this.sessions.set(record.sessionId, record)
    this.persist()
    return { ...this.principal(record), accessToken, refreshToken, accessExpiresAt: record.accessExpiresAt, refreshExpiresAt: record.refreshExpiresAt }
  }

  authenticate(accessToken: string): SessionPrincipal | undefined {
    if (!validToken(accessToken)) return undefined
    const digest = tokenDigest(accessToken)
    const record = [...this.sessions.values()].find(candidate => sameDigest(candidate.accessDigest, digest))
    if (record === undefined || record.revokedAt !== null || record.accessExpiresAt <= this.now()) return undefined
    return this.principal(record)
  }

  identifyRefresh(refreshTokenValue: string): SessionPrincipal | undefined {
    if (!validToken(refreshTokenValue)) return undefined
    const digest = tokenDigest(refreshTokenValue)
    const record = [...this.sessions.values()].find(candidate => sameDigest(candidate.refreshDigest, digest))
    if (record === undefined || record.revokedAt !== null || record.refreshExpiresAt <= this.now()
      || record.rotation >= this.maxRefreshRotations) return undefined
    return this.principal(record)
  }

  refresh(refreshTokenValue: string): SessionTokens {
    if (!validToken(refreshTokenValue)) throw new SessionAuthenticationError('invalid')
    const digest = tokenDigest(refreshTokenValue)
    for (const record of this.sessions.values()) {
      if (record.usedRefreshDigests.some(used => sameDigest(used, digest))) {
        this.revoke(record, 'refresh-reuse')
        this.persist()
        throw new SessionAuthenticationError('reuse')
      }
    }
    const record = [...this.sessions.values()].find(candidate => sameDigest(candidate.refreshDigest, digest))
    if (record === undefined || record.revokedAt !== null) throw new SessionAuthenticationError('invalid')
    const now = this.now()
    if (record.refreshExpiresAt <= now) {
      this.revoke(record, 'refresh-expired')
      this.persist()
      throw new SessionAuthenticationError('expired')
    }
    if (record.rotation >= this.maxRefreshRotations) {
      this.revoke(record, 'rotation-limit')
      this.persist()
      throw new SessionAuthenticationError('invalid')
    }
    const accessToken = opaqueToken()
    const refreshToken = opaqueToken()
    record.usedRefreshDigests.push(record.refreshDigest)
    record.accessDigest = tokenDigest(accessToken)
    record.refreshDigest = tokenDigest(refreshToken)
    record.refreshedAt = now
    record.accessExpiresAt = now + this.accessTtlMs
    record.rotation += 1
    this.persist()
    return { ...this.principal(record), accessToken, refreshToken, accessExpiresAt: record.accessExpiresAt, refreshExpiresAt: record.refreshExpiresAt }
  }

  list(): readonly SessionView[] {
    return [...this.sessions.values()].map(view).sort((left, right) => right.issuedAt - left.issuedAt)
  }

  get(sessionId: string): SessionView | undefined {
    const record = this.sessions.get(sessionId)
    return record === undefined ? undefined : view(record)
  }

  revokeSession(sessionId: string): boolean {
    const record = this.sessions.get(sessionId)
    if (record === undefined || record.revokedAt !== null) return false
    this.revoke(record, 'owner')
    this.persist()
    return true
  }

  revokeDevice(nodeId: string): number {
    let revoked = 0
    for (const record of this.sessions.values()) {
      if (record.nodeId === nodeId && record.revokedAt === null) {
        this.revoke(record, 'device')
        revoked += 1
      }
    }
    if (revoked > 0) this.persist()
    return revoked
  }

  private principal(record: SessionRecord): SessionPrincipal {
    return { sessionId: record.sessionId, familyId: record.familyId, nodeId: record.nodeId }
  }

  private inactive(record: SessionRecord): boolean {
    return record.revokedAt !== null || record.refreshExpiresAt <= this.now()
  }

  private revoke(record: SessionRecord, reason: SessionRevokeReason): void {
    if (record.revokedAt !== null) return
    record.revokedAt = this.now()
    record.revokeReason = reason
  }

  private prune(): void {
    const cutoff = this.now() - REVOKED_RETENTION_MS
    let changed = false
    for (const [sessionId, record] of this.sessions) {
      if ((record.revokedAt !== null && record.revokedAt <= cutoff) || record.refreshExpiresAt <= cutoff) {
        this.sessions.delete(sessionId)
        changed = true
      }
    }
    if (this.sessions.size >= this.maxSessions) {
      const inactive = [...this.sessions.values()]
        .filter(record => this.inactive(record))
        .sort((left, right) => (left.revokedAt ?? left.refreshExpiresAt) - (right.revokedAt ?? right.refreshExpiresAt))
      for (const record of inactive) {
        if (this.sessions.size < this.maxSessions) break
        this.sessions.delete(record.sessionId)
        changed = true
      }
    }
    if (changed) this.persist()
  }

  private persist(): void {
    this.store?.save({
      version: 1,
      sessions: [...this.sessions.values()].map(record => ({
        ...view(record),
        accessDigest: record.accessDigest.toString('base64url'),
        refreshDigest: record.refreshDigest.toString('base64url'),
        usedRefreshDigests: record.usedRefreshDigests.map(digest => digest.toString('base64url')),
      })),
    })
  }

  private restore(snapshot: SessionStateSnapshot | undefined): void {
    if (snapshot === undefined) return
    if (snapshot.version !== 1 || !Array.isArray(snapshot.sessions) || snapshot.sessions.length > this.maxSessions) {
      throw new Error('session state has an unsupported format')
    }
    const tokenDigests = new Set<string>()
    const familyIds = new Set<string>()
    for (const item of snapshot.sessions) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)
        || typeof item.sessionId !== 'string'
        || !/^[A-Za-z0-9_-]{22}$/.test(item.sessionId)
        || typeof item.familyId !== 'string'
        || !/^[A-Za-z0-9_-]{22}$/.test(item.familyId)
        || typeof item.nodeId !== 'string'
        || !Number.isFinite(item.issuedAt)
        || !Number.isFinite(item.refreshedAt)
        || !Number.isFinite(item.accessExpiresAt)
        || !Number.isFinite(item.refreshExpiresAt)
        || item.refreshedAt < item.issuedAt
        || item.accessExpiresAt <= item.refreshedAt
        || item.refreshExpiresAt <= item.issuedAt
        || !Number.isInteger(item.rotation)
        || item.rotation < 0
        || item.rotation > this.maxRefreshRotations
        || !Array.isArray(item.usedRefreshDigests)
        || item.usedRefreshDigests.length !== item.rotation
        || (item.revokedAt !== null && !Number.isFinite(item.revokedAt))
        || (item.revokedAt !== null && item.revokedAt < item.issuedAt)
        || (item.revokeReason !== null && typeof item.revokeReason !== 'string')
        || (item.revokeReason !== null && !['owner', 'device', 'refresh-reuse', 'refresh-expired', 'rotation-limit'].includes(item.revokeReason))) {
        throw new Error('session state contains an invalid session')
      }
      if ((item.revokedAt === null) !== (item.revokeReason === null)) throw new Error('session state contains an invalid revocation')
      if (familyIds.has(item.familyId)) throw new Error('session state contains duplicate session families')
      familyIds.add(item.familyId)
      const digests = [item.accessDigest, item.refreshDigest, ...item.usedRefreshDigests]
      for (const digest of digests) {
        decodeDigest(digest)
        if (tokenDigests.has(digest)) throw new Error('session state contains duplicate token digests')
        tokenDigests.add(digest)
      }
      const record: SessionRecord = {
        ...item,
        nodeId: validateIdentifier(item.nodeId, 'nodeId'),
        accessDigest: decodeDigest(item.accessDigest),
        refreshDigest: decodeDigest(item.refreshDigest),
        usedRefreshDigests: item.usedRefreshDigests.map(decodeDigest),
      }
      if (this.sessions.has(record.sessionId)) throw new Error('session state contains duplicate sessions')
      this.sessions.set(record.sessionId, record)
    }
    const activeByDevice = new Map<string, number>()
    for (const record of this.sessions.values()) {
      if (this.inactive(record)) continue
      const count = (activeByDevice.get(record.nodeId) ?? 0) + 1
      if (count > this.maxSessionsPerDevice) throw new Error('session state exceeds the per-device session limit')
      activeByDevice.set(record.nodeId, count)
    }
  }
}
