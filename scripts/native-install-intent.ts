import { createHash } from 'node:crypto'
import { describeNativeIntegration, parseNativeIntegrationReceipt, type InstallOptions, type Platform } from './install-native.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'

export const NATIVE_INSTALL_INTENT_MAX_BYTES = 16 * 1024
export interface NativeInstallBinding {
  readonly root: string
  readonly autostart: boolean
  readonly configFile?: string
  readonly dataDir?: string
}
export interface NativeInstallDigest { readonly sha256: string; readonly bytes: number }
export interface NativeInstallArtifactExpected extends NativeInstallDigest { readonly mode: number }
export interface NativeInstallIntent {
  readonly schemaVersion: 1
  readonly kind: 'native-install-intent'
  readonly platform: Platform
  readonly receiptPath: string
  readonly binding: NativeInstallBinding
  readonly artifacts: readonly { readonly path: string; readonly included: boolean; readonly expected: NativeInstallArtifactExpected | null }[]
  readonly receipt: NativeInstallDigest | null
  readonly scope: { readonly ownership: false; readonly execution: false; readonly automaticCleanup: false }
}
function fail(): never { throw new Error('Unsafe native install intent') }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function keys(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail()
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function expected(value: unknown, artifact: boolean): NativeInstallDigest | NativeInstallArtifactExpected {
  keys(value, artifact ? ['sha256', 'bytes', 'mode'] : ['sha256', 'bytes'])
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < (artifact ? 0 : 1) || (value.bytes as number) > (artifact ? 1024 * 1024 : 64 * 1024)) fail()
  const digest = { sha256: value.sha256, bytes: value.bytes as number }
  if (!artifact) return Object.freeze(digest)
  // Mode is descriptive metadata, not permission or ownership authority.
  if (!Number.isSafeInteger(value.mode) || (value.mode as number) < 0 || (value.mode as number) > 0o7777) fail()
  return Object.freeze({ ...digest, mode: value.mode as number })
}
function validate(value: unknown, integration: InstallOptions): NativeInstallIntent {
  keys(value, ['schemaVersion', 'kind', 'platform', 'receiptPath', 'binding', 'artifacts', 'receipt', 'scope'])
  const layout = describeNativeIntegration(integration)
  if (value.schemaVersion !== 1 || value.kind !== 'native-install-intent' || value.platform !== integration.platform || value.receiptPath !== layout.receiptPath) fail()
  keys(value.binding, ['root', 'autostart'], ['configFile', 'dataDir'])
  const binding = Object.freeze({ root: value.binding.root, autostart: value.binding.autostart, ...(Object.hasOwn(value.binding, 'configFile') ? { configFile: value.binding.configFile } : {}), ...(Object.hasOwn(value.binding, 'dataDir') ? { dataDir: value.binding.dataDir } : {}) }) as NativeInstallBinding
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== layout.artifactPaths.length) fail()
  const artifacts = Object.freeze(value.artifacts.map((entry: unknown, index: number) => {
    keys(entry, ['path', 'included', 'expected'])
    const included = index < layout.artifactPaths.length - 1 || binding.autostart === true
    if (entry.path !== layout.artifactPaths[index] || entry.included !== included || (!included && entry.expected !== null)) fail()
    return Object.freeze({ path: layout.artifactPaths[index]!, included, expected: entry.expected === null ? null : expected(entry.expected, true) as NativeInstallArtifactExpected })
  }))
  // Delegate binding and platform-specific receipt rules to the existing parser.
  // Unknown hashes are placeholders solely for validation, never persisted as expectations.
  parseNativeIntegrationReceipt(Buffer.from(JSON.stringify({ schemaVersion: 1, platform: integration.platform, ...binding, ...(integration.platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: artifacts.filter(entry => entry.included).map(entry => ({ path: entry.path, sha256: entry.expected?.sha256 ?? '0'.repeat(64) })) }, null, 2) + '\n'), integration)
  const receipt = value.receipt === null ? null : expected(value.receipt, false)
  if (receipt !== null && artifacts.some(entry => entry.included && entry.expected === null)) fail()
  keys(value.scope, ['ownership', 'execution', 'automaticCleanup'])
  if (value.scope.ownership !== false || value.scope.execution !== false || value.scope.automaticCleanup !== false) fail()
  return Object.freeze({ schemaVersion: 1, kind: 'native-install-intent', platform: integration.platform, receiptPath: layout.receiptPath, binding, artifacts, receipt, scope: Object.freeze({ ownership: false, execution: false, automaticCleanup: false }) })
}
function serialize(intent: NativeInstallIntent): Buffer {
  const bytes = Buffer.from(JSON.stringify(intent) + '\n')
  if (bytes.length > NATIVE_INSTALL_INTENT_MAX_BYTES) fail()
  return bytes
}

/** Pure immutable plan only. Hashes are not authentication, publication evidence, or authority to replay/clean up. */
export function createNativeInstallIntent(options: {
  integration: InstallOptions
  binding: NativeInstallBinding
  /** Only fixed artifact paths may be keys. Missing or null entries are pending. */
  expectedArtifacts?: Readonly<Record<string, NativeInstallArtifactExpected | null>>
  expectedReceipt?: Buffer
}): NativeInstallIntent {
  const { integration, binding, expectedArtifacts, expectedReceipt } = options
  const layout = describeNativeIntegration(integration)
  if (expectedArtifacts !== undefined && (!object(expectedArtifacts) || Object.keys(expectedArtifacts).some(path => !layout.artifactPaths.includes(path)))) fail()
  const intent = validate({ schemaVersion: 1, kind: 'native-install-intent', platform: integration.platform, receiptPath: layout.receiptPath, binding, artifacts: layout.artifactPaths.map((path, index) => ({ path, included: index < layout.artifactPaths.length - 1 || binding.autostart === true, expected: expectedArtifacts !== undefined && Object.hasOwn(expectedArtifacts, path) ? expectedArtifacts[path] : null })), receipt: null, scope: { ownership: false, execution: false, automaticCleanup: false } }, integration)
  let receipt: NativeInstallDigest | null = null
  if (expectedReceipt !== undefined) {
    const parsed = parseNativeIntegrationReceipt(expectedReceipt, integration)
    if (parsed.root !== intent.binding.root || parsed.autostart !== intent.binding.autostart || parsed.configFile !== intent.binding.configFile || parsed.dataDir !== intent.binding.dataDir) fail()
    for (const entry of intent.artifacts.filter(entry => entry.included)) {
      if (entry.expected === null || parsed.files.find(file => file.path === entry.path)?.sha256 !== entry.expected.sha256) fail()
    }
    receipt = { sha256: hash(expectedReceipt), bytes: expectedReceipt.length }
  }
  const result = validate({ ...intent, receipt }, integration)
  serialize(result)
  return result
}

/** Validate and encode exactly one compact JSON object followed by LF. */
export function encodeNativeInstallIntent(intent: NativeInstallIntent, integration: InstallOptions): Buffer {
  return serialize(validate(intent, integration))
}

/**
 * Bounded fatal UTF-8 decoding; canonical comparison rejects duplicates, reordered keys and lossy encodings.
 * Receipt digest/length remain unverified expectations without the actual receipt bytes.
 * Decoding never establishes committed state, ownership, or permission to execute/clean up.
 */
export function decodeNativeInstallIntent(bytes: Buffer, integration: InstallOptions): NativeInstallIntent {
  if (!Buffer.isBuffer(bytes) || bytes.length > NATIVE_INSTALL_INTENT_MAX_BYTES) fail()
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail() }
  const intent = validate(value, integration)
  if (!bytes.equals(serialize(intent))) fail()
  return intent
}
