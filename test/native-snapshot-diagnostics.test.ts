import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeDiagnostic } from './fixtures/native-snapshot-diagnostic.ts'

const secret = 'SECRET-DIAGNOSTIC-PAYLOAD'
const privateText = `${secret} /home/private/account C:\\Users\\private\\token https://private.invalid/?token=${secret}`
const unknown = { ok: false, kind: 'unknown' }
const privacy = (stage: string) => `Cannot establish private Windows data permissions [${stage}]: use a dedicated current-account-owned local directory without links or explicit shared ACLs`

test('diagnostics discard secret messages, stacks, paths, streams and arbitrary codes', () => {
  for (const code of [privateText, 'ERR_SECRET', 'SIGINT', '', -1, 256, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER, 71n, { toString() { throw new Error(secret) } }]) {
    const error = Object.assign(new Error(privateText), { code, stack: privateText, path: privateText, stdout: privateText, stderr: privateText, env: { SECRET: secret }, cause: new Error(privateText) })
    assert.deepEqual(sanitizeDiagnostic(error), unknown)
    assert.doesNotMatch(JSON.stringify(sanitizeDiagnostic(error)), /SECRET|private|https|stack|stdout|stderr/)
  }
  for (const error of [null, undefined, false, 42, secret, Symbol(secret), () => secret]) assert.deepEqual(sanitizeDiagnostic(error), unknown)
})

test('diagnostics retain only bounded native exit and filesystem codes', () => {
  for (const code of [0, 1, 71, 255]) assert.deepEqual(sanitizeDiagnostic(Object.assign(new Error(privateText), { code })), { ok: false, kind: 'process-exit', code })
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EMFILE', 'ENFILE', 'EIO', 'EBUSY', 'EROFS', 'ENAMETOOLONG', 'ELOOP']) {
    assert.deepEqual(sanitizeDiagnostic({ code, message: privateText }), { ok: false, kind: 'filesystem', code })
  }
  assert.deepEqual(sanitizeDiagnostic({ code: 71, killed: false, signal: privateText }), { ok: false, kind: 'process-exit', code: 71, killed: false })
  assert.deepEqual(sanitizeDiagnostic({ killed: privateText, signal: 'SIGINT' }), unknown)
})

test('diagnostics recognize actual execFile timeout shapes without message inference', () => {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    assert.deepEqual(sanitizeDiagnostic(Object.assign(new Error(privateText), { killed: true, code: signal })), { ok: false, kind: 'terminated', code: signal, killed: true })
    assert.deepEqual(sanitizeDiagnostic({ killed: true, code: null, signal }), { ok: false, kind: 'terminated', killed: true, signal })
  }
  assert.deepEqual(sanitizeDiagnostic({ code: 'ETIMEDOUT' }), { ok: false, kind: 'timeout', code: 'ETIMEDOUT' })
  assert.deepEqual(sanitizeDiagnostic({ message: 'timeout SIGTERM ' + privateText }), unknown)
  assert.deepEqual(sanitizeDiagnostic({ code: 'SIGTERM' }), { ok: false, kind: 'unknown', code: 'SIGTERM' })
})

test('diagnostics accept only complete known privacy messages and fixed validation messages', () => {
  for (const stage of ['native-module', 'path-boundary', 'descendant-preflight', 'root-preflight', 'create-root', 'apply-acl', 'verify-acl', 'descendant-owner', 'root-owner', 'descendant-enumeration', 'descendant-boundary', 'descendant-acl-read', 'descendant-owner-read', 'descendant-acl-policy', 'descendant-missing-recheck', 'descendant-access-denied', 'descendant-sharing-violation', 'descendant-missing-root-recheck', 'native-process']) {
    assert.deepEqual(sanitizeDiagnostic(new Error(privacy(stage))), { ok: false, kind: 'validation', stage })
    const result = sanitizeDiagnostic({ message: privacy(stage), code: 'SIGTERM', killed: true, signal: 'SIGTERM' })
    assert.deepEqual(result, { ok: false, kind: 'terminated', code: 'SIGTERM', killed: true, signal: 'SIGTERM', stage })
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512)
  }
  for (const message of [privacy(secret), privacy('unknown'), `[apply-acl] ${privateText}`, privateText + privacy('apply-acl'), privacy('apply-acl') + privateText, privacy('apply-acl') + '\n', 'x'.repeat(10000), 'Invalid diagnostic parameters ' + secret]) assert.deepEqual(sanitizeDiagnostic({ message }), unknown)
  assert.deepEqual(sanitizeDiagnostic(new Error('Invalid diagnostic parameters')), { ok: false, kind: 'validation' })
})

test('diagnostics never invoke hostile getters, coercions, prototypes or proxy traps', () => {
  let invoked = 0
  const hostile = () => { invoked++; throw new Error(privateText) }
  for (const field of ['code', 'killed', 'signal', 'message']) {
    assert.deepEqual(sanitizeDiagnostic(Object.defineProperty({ code: 71 }, field, { get: hostile })), unknown)
  }
  const error = Object.create(Object.defineProperty({}, 'code', { get: hostile }))
  for (const field of ['stack', 'stdout', 'stderr', 'cause', 'toJSON', 'toString']) Object.defineProperty(error, field, { get: hostile })
  assert.deepEqual(sanitizeDiagnostic(error), unknown)
  assert.deepEqual(sanitizeDiagnostic(new Proxy({}, { get: hostile, getOwnPropertyDescriptor: hostile, getPrototypeOf: hostile })), unknown)
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  assert.deepEqual(sanitizeDiagnostic(revoked.proxy), unknown)
  assert.equal(invoked, 0)
})
