import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FileSessionStateStore, SessionAuthenticationError, SessionAuthority } from '../dist/sessions.js'

function sessionError(code) {
  return error => error instanceof SessionAuthenticationError && error.code === code
}

test('expires access, rotates refresh tokens, and revokes the family on reuse', () => {
  let now = 1_000
  const authority = new SessionAuthority({
    now: () => now,
    accessTtlMs: 1_000,
    refreshTtlMs: 10_000,
  })
  const first = authority.issue('node-1')
  assert.deepEqual(authority.authenticate(first.accessToken), {
    sessionId: first.sessionId, familyId: first.familyId, nodeId: 'node-1',
  })

  now = first.accessExpiresAt
  assert.equal(authority.authenticate(first.accessToken), undefined)
  const second = authority.refresh(first.refreshToken)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(second.familyId, first.familyId)
  assert.notEqual(second.accessToken, first.accessToken)
  assert.notEqual(second.refreshToken, first.refreshToken)
  assert.equal(authority.authenticate(first.accessToken), undefined)
  assert.equal(authority.authenticate(second.accessToken)?.nodeId, 'node-1')

  assert.throws(() => authority.refresh(first.refreshToken), sessionError('reuse'))
  assert.equal(authority.authenticate(second.accessToken), undefined)
  assert.equal(authority.list()[0].revokeReason, 'refresh-reuse')
})

test('fails closed for expired refresh tokens and supports owner and device sign-out', () => {
  let now = 5_000
  const authority = new SessionAuthority({
    now: () => now,
    accessTtlMs: 1_000,
    refreshTtlMs: 3_000,
  })
  const expired = authority.issue('node-expired')
  now = expired.refreshExpiresAt
  assert.throws(() => authority.refresh(expired.refreshToken), sessionError('expired'))
  assert.equal(authority.list().find(session => session.sessionId === expired.sessionId).revokeReason, 'refresh-expired')

  const first = authority.issue('node-1')
  const second = authority.issue('node-1')
  const other = authority.issue('node-2')
  assert.equal(authority.revokeSession(first.sessionId), true)
  assert.equal(authority.revokeSession(first.sessionId), false)
  assert.equal(authority.authenticate(first.accessToken), undefined)
  assert.equal(authority.revokeDevice('node-1'), 1)
  assert.equal(authority.authenticate(second.accessToken), undefined)
  assert.equal(authority.authenticate(other.accessToken)?.nodeId, 'node-2')
})

test('enforces bounded sessions and refresh rotations', () => {
  const authority = new SessionAuthority({
    accessTtlMs: 1_000,
    refreshTtlMs: 10_000,
    maxSessions: 2,
    maxSessionsPerDevice: 1,
    maxRefreshRotations: 1,
  })
  const first = authority.issue('node-1')
  assert.throws(() => authority.issue('node-1'), /device session capacity/)
  authority.issue('node-2')
  assert.throws(() => authority.issue('node-3'), /session capacity/)
  assert.equal(authority.revokeDevice('node-2'), 1)
  authority.issue('node-3')
  assert.equal(authority.list().length, 2)
  const rotated = authority.refresh(first.refreshToken)
  assert.throws(() => authority.refresh(rotated.refreshToken), sessionError('invalid'))
  assert.equal(authority.list().find(session => session.sessionId === first.sessionId).revokeReason, 'rotation-limit')
})

test('persists only token digests and detects refresh reuse after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-sessions-'))
  try {
    const path = join(directory, 'session-state.json')
    const store = new FileSessionStateStore(path)
    const firstAuthority = new SessionAuthority({ store })
    const first = firstAuthority.issue('node-1')
    const second = firstAuthority.refresh(first.refreshToken)
    const stored = await readFile(path, 'utf8')
    assert.doesNotMatch(stored, new RegExp(first.accessToken))
    assert.doesNotMatch(stored, new RegExp(first.refreshToken))
    assert.doesNotMatch(stored, new RegExp(second.accessToken))
    assert.doesNotMatch(stored, new RegExp(second.refreshToken))
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)

    const restarted = new SessionAuthority({ store })
    assert.equal(restarted.authenticate(second.accessToken)?.nodeId, 'node-1')
    assert.throws(() => restarted.refresh(first.refreshToken), sessionError('reuse'))

    const restoredAgain = new SessionAuthority({ store })
    assert.equal(restoredAgain.authenticate(second.accessToken), undefined)
    assert.equal(restoredAgain.list()[0].revokeReason, 'refresh-reuse')
    assert.doesNotMatch(JSON.stringify(restoredAgain.list()), /Digest|Token/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects malformed, duplicate-family, and over-limit persisted session state', () => {
  let snapshot
  const source = new SessionAuthority({
    maxSessionsPerDevice: 2,
    store: { load: () => undefined, save: value => { snapshot = structuredClone(value) } },
  })
  source.issue('node-1')
  source.issue('node-1')

  const malformed = structuredClone(snapshot)
  malformed.sessions[0].accessExpiresAt = malformed.sessions[0].refreshedAt
  assert.throws(
    () => new SessionAuthority({ store: { load: () => malformed, save: () => {} } }),
    /invalid session/,
  )

  const duplicateFamily = structuredClone(snapshot)
  duplicateFamily.sessions[1].familyId = duplicateFamily.sessions[0].familyId
  assert.throws(
    () => new SessionAuthority({ maxSessionsPerDevice: 2, store: { load: () => duplicateFamily, save: () => {} } }),
    /duplicate session families/,
  )

  assert.throws(
    () => new SessionAuthority({ maxSessionsPerDevice: 1, store: { load: () => snapshot, save: () => {} } }),
    /per-device session limit/,
  )
  assert.throws(
    () => new SessionAuthority({ store: { load: () => ({ version: 1, sessions: [null] }), save: () => {} } }),
    /invalid session/,
  )
})
