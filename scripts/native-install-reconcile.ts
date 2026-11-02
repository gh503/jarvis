import { createHash } from 'node:crypto'
import { parseNativeIntegrationReceipt, type InstallOptions } from './install-native.ts'
import { decodeNativeInstallIntent, encodeNativeInstallIntent, type NativeInstallIntent } from './native-install-intent.ts'

export type NativeInstallObservation =
  | { readonly path: string; readonly state: 'absent' }
  | { readonly path: string; readonly state: 'unsafe' }
  | { readonly path: string; readonly state: 'file'; readonly bytes: Buffer; readonly mode?: number }
export interface NativeInstallObservations {
  readonly artifacts: readonly NativeInstallObservation[]
  readonly receipt: NativeInstallObservation
}
export type NativeInstallReconcileStatus = 'unpublished' | 'consistent' | 'incomplete' | 'conflict' | 'indeterminate'
export interface NativeInstallReconcileEntry {
  readonly path: string
  readonly status: 'absent' | 'missing' | 'matching' | 'unverified' | 'conflict'
  readonly reason?: 'unsafe' | 'excluded-present' | 'bytes-mismatch' | 'mode-mismatch' | 'unknown-expectation' | 'invalid-receipt' | 'binding-mismatch' | 'files-mismatch'
}
export interface NativeInstallReconcileReport {
  readonly status: NativeInstallReconcileStatus
  readonly artifacts: readonly NativeInstallReconcileEntry[]
  readonly receipt: NativeInstallReconcileEntry
  readonly scope: { readonly ownership: false; readonly execution: false; readonly automaticCleanup: false; readonly atomicity: false }
}
function invalid(): never { throw new Error('Invalid native install observations') }
// Reject accessors and extra (including symbol/non-enumerable) fields, without invoking them.
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (required.some(key => !Object.hasOwn(descriptors, key)) || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)) || !Object.hasOwn(descriptors[key]!, 'value'))) invalid()
}
function observation(value: unknown, path: string, limit: number): NativeInstallObservation {
  shape(value, ['path', 'state'], ['bytes', 'mode'])
  if (value.path !== path || !['absent', 'file', 'unsafe'].includes(value.state as string)) invalid()
  if (value.state !== 'file') {
    if (Object.hasOwn(value, 'bytes') || Object.hasOwn(value, 'mode')) invalid()
    return { path, state: value.state as 'absent' | 'unsafe' }
  }
  if (!Object.hasOwn(value, 'bytes') || !Buffer.isBuffer(value.bytes) || value.bytes.length > limit) invalid()
  if (Object.hasOwn(value, 'mode') && (!Number.isSafeInteger(value.mode) || (value.mode as number) < 0 || (value.mode as number) > 0o7777)) invalid()
  return { path, state: 'file', bytes: value.bytes, ...(Object.hasOwn(value, 'mode') ? { mode: value.mode as number } : {}) }
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const entry = (path: string, status: NativeInstallReconcileEntry['status'], reason?: NativeInstallReconcileEntry['reason']): NativeInstallReconcileEntry => Object.freeze({ path, status, ...(reason === undefined ? {} : { reason }) })

/**
 * Classify bounded, externally captured bytes only. Throws for malformed observations/intent;
 * unsafe states and content mismatches are conflicts. No filesystem reads or process execution.
 * Matching content is descriptive: it establishes neither ownership nor an atomic snapshot,
 * and a consistent report does not prove publication or a committed installation.
 */
export function reconcileNativeInstallIntent(options: {
  integration: InstallOptions
  intent: NativeInstallIntent
  observations: NativeInstallObservations
}): NativeInstallReconcileReport {
  const { integration } = options
  const intent = decodeNativeInstallIntent(encodeNativeInstallIntent(options.intent, integration), integration)
  const supplied = options.observations
  shape(supplied, ['artifacts', 'receipt'])
  if (!Array.isArray(supplied.artifacts) || supplied.artifacts.length !== intent.artifacts.length || supplied.artifacts.length > 3) invalid()
  // Validate every slot before any observation hashing or receipt parsing.
  if (Reflect.ownKeys(supplied.artifacts).length !== supplied.artifacts.length + 1) invalid()
  const captured = intent.artifacts.map((artifact, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(supplied.artifacts, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid()
    return observation(descriptor.value, artifact.path, 1024 * 1024)
  })
  const receipt = observation(supplied.receipt, intent.receiptPath, 64 * 1024)
  const artifacts = Object.freeze(intent.artifacts.map((artifact, index) => {
    const observed = captured[index]!
    if (observed.state === 'unsafe') return entry(artifact.path, 'conflict', 'unsafe')
    if (observed.state === 'absent') return entry(artifact.path, artifact.included ? 'missing' : 'absent')
    if (!artifact.included) return entry(artifact.path, 'conflict', 'excluded-present')
    if (artifact.expected === null) return entry(artifact.path, 'unverified', 'unknown-expectation')
    if (observed.bytes.length !== artifact.expected.bytes || hash(observed.bytes) !== artifact.expected.sha256) return entry(artifact.path, 'conflict', 'bytes-mismatch')
    if (observed.mode !== artifact.expected.mode) return entry(artifact.path, 'conflict', 'mode-mismatch')
    return entry(artifact.path, 'matching')
  }))
  const classifyReceipt = (): NativeInstallReconcileEntry => {
    const path = intent.receiptPath
    if (receipt.state === 'unsafe') return entry(path, 'conflict', 'unsafe')
    if (receipt.state === 'absent') return entry(path, 'missing')
    let parsed: ReturnType<typeof parseNativeIntegrationReceipt>
    try { parsed = parseNativeIntegrationReceipt(receipt.bytes, integration) } catch { return entry(path, 'conflict', 'invalid-receipt') }
    if (parsed.root !== intent.binding.root || parsed.autostart !== intent.binding.autostart || parsed.configFile !== intent.binding.configFile || parsed.dataDir !== intent.binding.dataDir) return entry(path, 'conflict', 'binding-mismatch')
    if (intent.artifacts.some(artifact => artifact.included && artifact.expected !== null && parsed.files.find(file => file.path === artifact.path)?.sha256 !== artifact.expected.sha256)) return entry(path, 'conflict', 'files-mismatch')
    // A receipt cannot establish an unknown expectation, but contradictory captured bytes conflict.
    if (intent.artifacts.some((artifact, index) => {
      const observed = captured[index]!
      return artifact.included && observed.state === 'file' && parsed.files.find(file => file.path === artifact.path)?.sha256 !== hash(observed.bytes)
    })) return entry(path, 'conflict', 'files-mismatch')
    if (intent.receipt === null) return entry(path, 'unverified', 'unknown-expectation')
    if (receipt.bytes.length !== intent.receipt.bytes || hash(receipt.bytes) !== intent.receipt.sha256) return entry(path, 'conflict', 'bytes-mismatch')
    return entry(path, 'matching')
  }
  const receiptReport = classifyReceipt()
  const entries = [...artifacts, receiptReport]
  const status: NativeInstallReconcileStatus = entries.some(value => value.status === 'conflict') ? 'conflict'
    : entries.some(value => value.status === 'unverified') ? 'indeterminate'
      : captured.every(value => value.state === 'absent') && receipt.state === 'absent' ? 'unpublished'
        : entries.some(value => value.status === 'missing') ? 'incomplete' : 'consistent'
  return Object.freeze({ status, artifacts, receipt: receiptReport, scope: Object.freeze({ ownership: false, execution: false, automaticCleanup: false, atomicity: false }) })
}
