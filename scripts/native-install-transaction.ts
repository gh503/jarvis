import { createHash } from 'node:crypto'
import { describeNativeIntegration, parseNativeIntegrationReceipt, type InstallOptions, type NativeIntegrationRenderPlan } from './install-native.ts'
import type { NativeInstallArtifactExpected, NativeInstallBinding, NativeInstallDigest } from './native-install-intent.ts'

export const NATIVE_INSTALL_TRANSACTION_MAX_BYTES = 128 * 1024
const RECEIPT_MAX_BYTES = 64 * 1024
const ARTIFACT_MAX_BYTES = 1024 * 1024
const SCOPE = Object.freeze({ ownership: false, execution: false, automaticCleanup: false, replay: false, atomicity: false, requestedMode: 'descriptive-only' } as const)
type PreparedArtifact = Extract<NativeIntegrationRenderPlan, { platform: 'darwin' }>['artifacts'][number]
export interface NativeInstallTransaction {
  readonly schemaVersion: 1
  readonly kind: 'native-install-transaction'
  readonly transactionId: string
  readonly operation: 'fresh-install'
  readonly stage: 'prepared'
  readonly platform: InstallOptions['platform']
  readonly receiptPath: string
  readonly binding: NativeInstallBinding
  /** Requirements only: this record does not observe or establish absence. */
  readonly predecessor: readonly { readonly path: string; readonly state: 'absent' }[]
  readonly artifacts: readonly (
    | { readonly path: string; readonly state: 'present'; readonly expected: NativeInstallArtifactExpected }
    | { readonly path: string; readonly state: 'absent'; readonly expected: null }
  )[]
  readonly receipt: NativeInstallDigest & { readonly base64: string }
  readonly scope: typeof SCOPE
}
function fail(): never { throw new Error('Unsafe native install transaction') }
function keys(value: unknown, required: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key))) fail()
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function receiptBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4 * Math.ceil(RECEIPT_MAX_BYTES / 3)) fail()
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > RECEIPT_MAX_BYTES || bytes.toString('base64') !== value) fail()
  return bytes
}
function validate(value: unknown, integration: InstallOptions): NativeInstallTransaction {
  keys(value, ['schemaVersion', 'kind', 'transactionId', 'operation', 'stage', 'platform', 'receiptPath', 'binding', 'predecessor', 'artifacts', 'receipt', 'scope'])
  const layout = describeNativeIntegration(integration)
  // Caller supplies a freshly generated randomUUID(); syntax cannot prove randomness or uniqueness.
  if (value.schemaVersion !== 1 || value.kind !== 'native-install-transaction' || typeof value.transactionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.transactionId) || value.operation !== 'fresh-install' || value.stage !== 'prepared' || value.platform !== integration.platform || value.receiptPath !== layout.receiptPath) fail()
  keys(value.receipt, ['sha256', 'bytes', 'base64'])
  const bytes = receiptBytes(value.receipt.base64)
  const parsed = parseNativeIntegrationReceipt(bytes, integration)
  if (parsed.autostart !== false || parsed.root !== integration.root || value.receipt.sha256 !== hash(bytes) || value.receipt.bytes !== bytes.length) fail()
  const binding = Object.freeze({ root: parsed.root, autostart: false, ...(parsed.configFile === undefined ? {} : { configFile: parsed.configFile, dataDir: parsed.dataDir! }) })
  keys(value.binding, Object.keys(binding))
  const suppliedBinding = value.binding
  if (Object.entries(binding).some(([key, field]) => suppliedBinding[key] !== field)) fail()
  const predecessorPaths = [...layout.artifactPaths, layout.receiptPath]
  if (!Array.isArray(value.predecessor) || value.predecessor.length !== predecessorPaths.length) fail()
  const predecessor = Object.freeze(Array.from(value.predecessor, (entry: unknown, index: number) => {
    keys(entry, ['path', 'state'])
    if (entry.path !== predecessorPaths[index] || entry.state !== 'absent') fail()
    return Object.freeze({ path: predecessorPaths[index]!, state: 'absent' as const })
  }))
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== layout.artifactPaths.length) fail()
  const artifacts = Object.freeze(Array.from(value.artifacts, (entry: unknown, index: number) => {
    keys(entry, ['path', 'state', 'expected'])
    const path = layout.artifactPaths[index]!
    if (entry.path !== path) fail()
    if (index === layout.artifactPaths.length - 1) {
      if (entry.state !== 'absent' || entry.expected !== null) fail()
      return Object.freeze({ path, state: 'absent' as const, expected: null })
    }
    keys(entry.expected, ['sha256', 'bytes', 'mode'])
    const expected = entry.expected
    if (entry.state !== 'present' || parsed.files[index]?.path !== path || expected.sha256 !== parsed.files[index]?.sha256 || !Number.isSafeInteger(expected.bytes) || (expected.bytes as number) < 0 || (expected.bytes as number) > ARTIFACT_MAX_BYTES || !Number.isSafeInteger(expected.mode) || (expected.mode as number) < 0 || (expected.mode as number) > 0o7777) fail()
    return Object.freeze({ path, state: 'present' as const, expected: Object.freeze({ sha256: expected.sha256 as string, bytes: expected.bytes as number, mode: expected.mode as number }) })
  }))
  keys(value.scope, Object.keys(SCOPE))
  const suppliedScope = value.scope
  if (Object.entries(SCOPE).some(([key, field]) => suppliedScope[key] !== field)) fail()
  return Object.freeze({ schemaVersion: 1, kind: 'native-install-transaction', transactionId: value.transactionId, operation: 'fresh-install', stage: 'prepared', platform: integration.platform, receiptPath: layout.receiptPath, binding, predecessor, artifacts, receipt: Object.freeze({ sha256: hash(bytes), bytes: bytes.length, base64: bytes.toString('base64') }), scope: SCOPE })
}
function serialize(transaction: NativeInstallTransaction): Buffer {
  const bytes = Buffer.from(JSON.stringify(transaction) + '\n')
  if (bytes.length > NATIVE_INSTALL_TRANSACTION_MAX_BYTES) fail()
  return bytes
}
/** Pure prepared plan. No filesystem observation, ownership, publication, execution,
 * cleanup, replay, or atomicity authority. Modes describe requested creation modes,
 * not effective permissions or Windows ACLs. Windows callers must supply actual
 * prepared shortcut bytes. Artifact payloads are verified then discarded. */
export function createNativeInstallTransaction(options: {
  integration: InstallOptions
  /** Fresh random lowercase UUIDv4, supplied by the caller. */
  transactionId: string
  artifacts: readonly Readonly<PreparedArtifact>[]
  receipt: Buffer
}): NativeInstallTransaction {
  const { integration, transactionId, artifacts, receipt } = options
  const layout = describeNativeIntegration(integration)
  if (!Buffer.isBuffer(receipt) || receipt.length > RECEIPT_MAX_BYTES) fail()
  const parsed = parseNativeIntegrationReceipt(receipt, integration)
  if (!Array.isArray(artifacts) || artifacts.length !== layout.artifactPaths.length - 1) fail()
  const expected = Array.from(artifacts, (entry, index) => {
    keys(entry, ['path', 'bytes', 'mode'])
    if (entry.path !== layout.artifactPaths[index] || !Buffer.isBuffer(entry.bytes) || entry.bytes.length > ARTIFACT_MAX_BYTES) fail()
    return { path: entry.path, state: 'present', expected: { sha256: hash(entry.bytes), bytes: entry.bytes.length, mode: entry.mode } }
  })
  const result = validate({ schemaVersion: 1, kind: 'native-install-transaction', transactionId, operation: 'fresh-install', stage: 'prepared', platform: integration.platform, receiptPath: layout.receiptPath, binding: { root: parsed.root, autostart: parsed.autostart, ...(parsed.configFile === undefined ? {} : { configFile: parsed.configFile, dataDir: parsed.dataDir }) }, predecessor: [...layout.artifactPaths, layout.receiptPath].map(path => ({ path, state: 'absent' })), artifacts: [...expected, { path: layout.artifactPaths.at(-1), state: 'absent', expected: null }], receipt: { sha256: hash(receipt), bytes: receipt.length, base64: receipt.toString('base64') }, scope: SCOPE }, integration)
  serialize(result)
  return result
}
/** Strict validation and canonical compact JSON plus LF. */
export function encodeNativeInstallTransaction(transaction: NativeInstallTransaction, integration: InstallOptions): Buffer {
  return serialize(validate(transaction, integration))
}
/** Decode data only. Embedded receipt hashes are checked against expectations;
 * discarded artifact payloads cannot be reverified here. Digests are not authentication. */
export function decodeNativeInstallTransaction(bytes: Buffer, integration: InstallOptions): NativeInstallTransaction {
  if (!Buffer.isBuffer(bytes) || bytes.length > NATIVE_INSTALL_TRANSACTION_MAX_BYTES) fail()
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail() }
  const result = validate(value, integration)
  if (!bytes.equals(serialize(result))) fail()
  return result
}
