import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import type { InstallOptions } from './install-native.ts'
import { decodeNativeInstallTransaction, encodeNativeInstallTransaction, type NativeInstallTransaction } from './native-install-transaction.ts'

export const NATIVE_INSTALL_TRANSACTION_ACK_MAX_BYTES = 16 * 1024
/** Decimal digits, excluding the optional timestamp minus sign. */
export const NATIVE_INSTALL_TRANSACTION_ACK_IDENTITY_MAX_DIGITS = 40
const FIELDS = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const
export type NativeInstallArtifactIdentity = Readonly<Record<typeof FIELDS[number], string>>
const INTEGER_LIMIT = 10n ** BigInt(NATIVE_INSTALL_TRANSACTION_ACK_IDENTITY_MAX_DIGITS)
const SCOPE = Object.freeze({ ownership: false, execution: false, automaticCleanup: false, replay: false, atomicity: false, observationAuthenticity: false, windowsAcl: false } as const)
export interface NativeInstallTransactionAck {
  readonly schemaVersion: 1
  readonly kind: 'native-install-transaction-ack'
  readonly transactionId: string
  readonly transactionSha256: string
  readonly artifactIndex: number
  readonly path: string
  readonly expected: { readonly sha256: string; readonly bytes: number }
  readonly identity: NativeInstallArtifactIdentity
  readonly scope: typeof SCOPE
}
function fail(): never { throw new Error('Unsafe native install transaction acknowledgement') }
function keys(value: unknown, required: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !required.includes(key))) fail()
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function context(transaction: NativeInstallTransaction, integration: InstallOptions) {
  const bytes = encodeNativeInstallTransaction(transaction, integration)
  return { transaction: decodeNativeInstallTransaction(bytes, integration), sha256: hash(bytes) }
}
/** Shared strict decimal identity validator for data-only observation codecs. */
export function validateNativeInstallArtifactIdentity(value: unknown, size: number): NativeInstallArtifactIdentity {
  keys(value, FIELDS)
  const entries = FIELDS.map(key => {
    const field = value[key], timestamp = key.endsWith('Ns')
    if (typeof field !== 'string' || field.length > NATIVE_INSTALL_TRANSACTION_ACK_IDENTITY_MAX_DIGITS + (timestamp && field.startsWith('-') ? 1 : 0) || !(timestamp ? /^(?:0|-?[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/).test(field)) fail()
    return [key, field] as const
  })
  const result = Object.fromEntries(entries) as Record<typeof FIELDS[number], string>
  // Observed mode includes file type. Requested creation permissions can differ
  // due to umask, and neither mode establishes Windows ACL properties.
  const mode = BigInt(result.mode)
  if (mode > 0o177777n || (mode & 0o170000n) !== 0o100000n || result.nlink !== '1' || result.size !== String(size)) fail()
  return Object.freeze(result)
}
/** Convert caller-supplied stats, retaining the same bounds and identity validation. */
export function observeNativeInstallArtifactIdentity(value: BigIntStats | NativeInstallArtifactIdentity, size: number): NativeInstallArtifactIdentity {
  if (value && typeof (value as BigIntStats).isFile === 'function') {
    const stats = value as BigIntStats
    if (!stats.isFile()) fail()
    const entries = FIELDS.map(key => {
      const field = stats[key]
      // Bound before decimal conversion, including caller-supplied bigint values.
      if (typeof field !== 'bigint' || field <= -INTEGER_LIMIT || field >= INTEGER_LIMIT) fail()
      return [key, field.toString()] as const
    })
    return validateNativeInstallArtifactIdentity(Object.fromEntries(entries), size)
  }
  return validateNativeInstallArtifactIdentity(value, size)
}
function validate(value: unknown, bound: ReturnType<typeof context>): NativeInstallTransactionAck {
  keys(value, ['schemaVersion', 'kind', 'transactionId', 'transactionSha256', 'artifactIndex', 'path', 'expected', 'identity', 'scope'])
  if (value.schemaVersion !== 1 || value.kind !== 'native-install-transaction-ack' || value.transactionId !== bound.transaction.transactionId || value.transactionSha256 !== bound.sha256 || !Number.isSafeInteger(value.artifactIndex) || (value.artifactIndex as number) < 0) fail()
  const artifact = bound.transaction.artifacts[value.artifactIndex as number]
  if (!artifact || artifact.state !== 'present' || value.path !== artifact.path) fail()
  keys(value.expected, ['sha256', 'bytes'])
  if (value.expected.sha256 !== artifact.expected.sha256 || value.expected.bytes !== artifact.expected.bytes) fail()
  keys(value.scope, Object.keys(SCOPE))
  const scope = value.scope
  if (Object.entries(SCOPE).some(([key, field]) => scope[key] !== field)) fail()
  return Object.freeze({ schemaVersion: 1, kind: 'native-install-transaction-ack', transactionId: bound.transaction.transactionId, transactionSha256: bound.sha256, artifactIndex: value.artifactIndex as number, path: artifact.path, expected: Object.freeze({ sha256: artifact.expected.sha256, bytes: artifact.expected.bytes }), identity: validateNativeInstallArtifactIdentity(value.identity, artifact.expected.bytes), scope: SCOPE })
}
function serialize(value: NativeInstallTransactionAck): Buffer {
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  if (bytes.length > NATIVE_INSTALL_TRANSACTION_ACK_MAX_BYTES) fail()
  return bytes
}
/** Pure caller observation of one included artifact, never receipt or startup.
 * Verifies and discards payload bytes. No filesystem access or persistence, and
 * no proof of authentic observation, ownership, execution, cleanup, replay,
 * atomicity or recovery. IDs and digests confer no authority. */
export function createNativeInstallTransactionAck(options: {
  transaction: NativeInstallTransaction
  integration: InstallOptions
  artifactIndex: number
  observation: { bytes: Buffer; identity: BigIntStats | NativeInstallArtifactIdentity }
}): NativeInstallTransactionAck {
  const bound = context(options.transaction, options.integration)
  if (!Number.isSafeInteger(options.artifactIndex) || options.artifactIndex < 0) fail()
  const artifact = bound.transaction.artifacts[options.artifactIndex]
  if (!artifact || artifact.state !== 'present') fail()
  keys(options.observation, ['bytes', 'identity'])
  const { bytes, identity: observed } = options.observation
  if (!Buffer.isBuffer(bytes) || bytes.length !== artifact.expected.bytes || hash(bytes) !== artifact.expected.sha256) fail()
  const result = validate({ schemaVersion: 1, kind: 'native-install-transaction-ack', transactionId: bound.transaction.transactionId, transactionSha256: bound.sha256, artifactIndex: options.artifactIndex, path: artifact.path, expected: { sha256: artifact.expected.sha256, bytes: artifact.expected.bytes }, identity: observeNativeInstallArtifactIdentity(observed, bytes.length), scope: SCOPE }, bound)
  serialize(result)
  return result
}
/** Validate binding and emit canonical compact JSON plus LF. */
export function encodeNativeInstallTransactionAck(ack: NativeInstallTransactionAck, transaction: NativeInstallTransaction, integration: InstallOptions): Buffer {
  return serialize(validate(ack, context(transaction, integration)))
}
/** Strict canonical data decoder; it cannot authenticate the claimed observation. */
export function decodeNativeInstallTransactionAck(bytes: Buffer, transaction: NativeInstallTransaction, integration: InstallOptions): NativeInstallTransactionAck {
  if (!Buffer.isBuffer(bytes) || bytes.length > NATIVE_INSTALL_TRANSACTION_ACK_MAX_BYTES) fail()
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail() }
  const result = validate(value, context(transaction, integration))
  if (!bytes.equals(serialize(result))) fail()
  return result
}
