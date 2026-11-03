import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import type { InstallOptions } from './install-native.ts'
import { decodeNativeInstallTransaction, encodeNativeInstallTransaction, type NativeInstallTransaction } from './native-install-transaction.ts'
import { encodeNativeInstallTransactionAck, observeNativeInstallArtifactIdentity, validateNativeInstallArtifactIdentity, type NativeInstallArtifactIdentity, type NativeInstallTransactionAck } from './native-install-transaction-ack.ts'

export const NATIVE_INSTALL_TRANSACTION_COMPLETION_MAX_BYTES = 16 * 1024
const SCOPE = Object.freeze({ ownership: false, execution: false, automaticCleanup: false, replay: false, atomicity: false, observationAuthenticity: false, windowsAcl: false } as const)
export interface NativeInstallTransactionCompletion {
  readonly schemaVersion: 1
  readonly kind: 'native-install-transaction-completion'
  readonly stage: 'declared-completion'
  readonly transactionId: string
  readonly transactionSha256: string
  /** Canonical acknowledgement digests in included transaction slot order. */
  readonly ackSha256: readonly string[]
  readonly receipt: { readonly sha256: string; readonly bytes: number; readonly identity: NativeInstallArtifactIdentity }
  readonly scope: typeof SCOPE
}
function fail(): never { throw new Error('Unsafe native install transaction completion') }
function keys(value: unknown, required: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !required.includes(key))) fail()
}
function denseArray(value: unknown, length: number): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length !== length || Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) fail()
  for (let index = 0; index < length; index++) if (!Object.hasOwn(value, index)) fail()
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function context(transaction: NativeInstallTransaction, integration: InstallOptions, acks: readonly NativeInstallTransactionAck[]) {
  const bytes = encodeNativeInstallTransaction(transaction, integration)
  const canonical = decodeNativeInstallTransaction(bytes, integration)
  const slots = canonical.artifacts.flatMap((artifact, index) => artifact.state === 'present' ? [index] : [])
  denseArray(acks, slots.length)
  const ackSha256 = Object.freeze(Array.from(acks, (ack, index) => {
    const encoded = encodeNativeInstallTransactionAck(ack, canonical, integration)
    if (ack.artifactIndex !== slots[index]) fail()
    return hash(encoded)
  }))
  return { transaction: canonical, sha256: hash(bytes), ackSha256 }
}
function validate(value: unknown, bound: ReturnType<typeof context>): NativeInstallTransactionCompletion {
  keys(value, ['schemaVersion', 'kind', 'stage', 'transactionId', 'transactionSha256', 'ackSha256', 'receipt', 'scope'])
  if (value.schemaVersion !== 1 || value.kind !== 'native-install-transaction-completion' || value.stage !== 'declared-completion' || value.transactionId !== bound.transaction.transactionId || value.transactionSha256 !== bound.sha256) fail()
  denseArray(value.ackSha256, bound.ackSha256.length)
  if (value.ackSha256.some((digest, index) => digest !== bound.ackSha256[index])) fail()
  keys(value.receipt, ['sha256', 'bytes', 'identity'])
  if (value.receipt.sha256 !== bound.transaction.receipt.sha256 || value.receipt.bytes !== bound.transaction.receipt.bytes) fail()
  const identity = validateNativeInstallArtifactIdentity(value.receipt.identity, bound.transaction.receipt.bytes)
  keys(value.scope, Object.keys(SCOPE))
  const scope = value.scope
  if (Object.entries(SCOPE).some(([key, field]) => scope[key] !== field)) fail()
  return Object.freeze({ schemaVersion: 1, kind: 'native-install-transaction-completion', stage: 'declared-completion', transactionId: bound.transaction.transactionId, transactionSha256: bound.sha256, ackSha256: bound.ackSha256, receipt: Object.freeze({ sha256: bound.transaction.receipt.sha256, bytes: bound.transaction.receipt.bytes, identity }), scope: SCOPE })
}
function serialize(value: NativeInstallTransactionCompletion): Buffer {
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  if (bytes.length > NATIVE_INSTALL_TRANSACTION_COMPLETION_MAX_BYTES) fail()
  return bytes
}
/** Pure declared completion from caller observations. Verifies exact receipt bytes
 * then discards them. No filesystem access, persistence, installation, commit,
 * execution, cleanup, replay, recovery or authentication authority. */
export function createNativeInstallTransactionCompletion(options: {
  transaction: NativeInstallTransaction
  integration: InstallOptions
  acks: readonly NativeInstallTransactionAck[]
  observation: { bytes: Buffer; identity: BigIntStats | NativeInstallArtifactIdentity }
}): NativeInstallTransactionCompletion {
  const bound = context(options.transaction, options.integration, options.acks)
  keys(options.observation, ['bytes', 'identity'])
  const { bytes, identity } = options.observation
  if (!Buffer.isBuffer(bytes) || !bytes.equals(Buffer.from(bound.transaction.receipt.base64, 'base64'))) fail()
  const result = validate({ schemaVersion: 1, kind: 'native-install-transaction-completion', stage: 'declared-completion', transactionId: bound.transaction.transactionId, transactionSha256: bound.sha256, ackSha256: bound.ackSha256, receipt: { sha256: hash(bytes), bytes: bytes.length, identity: observeNativeInstallArtifactIdentity(identity, bytes.length) }, scope: SCOPE }, bound)
  serialize(result)
  return result
}
/** Validate all bindings and emit canonical compact JSON plus LF. */
export function encodeNativeInstallTransactionCompletion(completion: NativeInstallTransactionCompletion, transaction: NativeInstallTransaction, integration: InstallOptions, acks: readonly NativeInstallTransactionAck[]): Buffer {
  return serialize(validate(completion, context(transaction, integration, acks)))
}
/** Strict data decoder. A valid claimed identity does not authenticate observation. */
export function decodeNativeInstallTransactionCompletion(bytes: Buffer, transaction: NativeInstallTransaction, integration: InstallOptions, acks: readonly NativeInstallTransactionAck[]): NativeInstallTransactionCompletion {
  if (!Buffer.isBuffer(bytes) || bytes.length > NATIVE_INSTALL_TRANSACTION_COMPLETION_MAX_BYTES) fail()
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail() }
  const result = validate(value, context(transaction, integration, acks))
  if (!bytes.equals(serialize(result))) fail()
  return result
}
