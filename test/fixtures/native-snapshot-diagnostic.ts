// TEST ONLY: preserve useful native failure categories without publishing error text.
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { types } from 'node:util'
import type { InstallOptions } from '../../scripts/install-native.ts'
import { installPermissionPhaseProbe, type PermissionPhases } from './native-snapshot-phases.ts'

const filesystemCodes = ['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EMFILE', 'ENFILE', 'EIO', 'EBUSY', 'EROFS', 'ENAMETOOLONG', 'ELOOP'] as const
const privacyStage = /^Cannot establish private Windows data permissions \[(native-module|path-boundary|descendant-preflight|root-preflight|create-root|apply-acl|verify-acl|descendant-owner|root-owner|descendant-enumeration|descendant-boundary|descendant-acl-read|descendant-owner-read|descendant-acl-policy|descendant-missing-recheck|descendant-access-denied|descendant-sharing-violation|descendant-missing-root-recheck|native-process)\]: use a dedicated current-account-owned local directory without links or explicit shared ACLs$/
const validationMessages = new Set(['Invalid diagnostic parameters', 'Invalid diagnostic receipt', 'Expected canonical absolute path', 'Expected native Windows path without aliases', 'Unsafe path boundary', 'Noncanonical native path', 'Snapshot permissions must remain private', 'Original integration receipt is required', 'Snapshot destination overlaps protected source', 'Original integration changed during capture'])
export interface Diagnostic {
  ok: false
  kind: 'timeout' | 'terminated' | 'process-exit' | 'filesystem' | 'validation' | 'unknown'
  code?: string | number
  killed?: boolean
  signal?: 'SIGTERM' | 'SIGKILL'
  stage?: string
}

/** Never traverse causes, invoke accessors/coercions, or serialize an error itself. */
export function sanitizeDiagnostic(error: unknown): Diagnostic {
  const unknown: Diagnostic = { ok: false, kind: 'unknown' }
  if (typeof error !== 'object' || error === null || types.isProxy(error)) return unknown
  try {
    const fields = ['code', 'killed', 'signal', 'message'] as const
    const values: Record<string, unknown> = Object.create(null)
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(error, field)
      if (descriptor && !Object.hasOwn(descriptor, 'value')) return unknown
      values[field] = descriptor?.value
    }
    const { code, killed, signal, message } = values
    const result: Diagnostic = { ok: false, kind: 'unknown' }
    if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 255) {
      result.kind = 'process-exit'
      result.code = code
    } else if (typeof code === 'string' && filesystemCodes.some(value => value === code)) {
      result.kind = 'filesystem'
      result.code = code
    } else if (code === 'ETIMEDOUT' || code === 'SIGTERM' || code === 'SIGKILL') result.code = code
    if (typeof killed === 'boolean') result.killed = killed
    if (signal === 'SIGTERM' || signal === 'SIGKILL') result.signal = signal
    // execFile deadlines can carry SIGTERM, but the same shape permits an explicit
    // kill: retain the termination evidence without claiming a definite timeout.
    if (code === 'ETIMEDOUT') result.kind = 'timeout'
    else if (killed === true && (code === 'SIGTERM' || code === 'SIGKILL' || result.signal)) result.kind = 'terminated'
    if (typeof message === 'string' && message.length <= 512) {
      const match = privacyStage.exec(message)
      const stage = match?.[0] === message ? match[1] : undefined
      if (message === 'Native integration snapshot permission verification failed') {
        result.stage = 'integration-permission-check'
        if (result.kind === 'unknown') result.kind = 'validation'
      }
      else if (stage) { result.stage = stage; if (result.kind === 'unknown') result.kind = 'validation' }
      else if (result.kind === 'unknown' && validationMessages.has(message)) result.kind = 'validation'
    }
    return result
  } catch { return unknown }
}

function parameters(raw: string | undefined): { integration: InstallOptions; destination: string } {
  const invalid = () => { throw new Error('Invalid diagnostic parameters') }
  if (!raw || raw.length > 32 * 1024 || Buffer.byteLength(raw) > 32 * 1024) return invalid()
  let value: unknown
  try { value = JSON.parse(raw) } catch { return invalid() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  if (input.platform !== 'darwin' && input.platform !== 'win32') return invalid()
  if (input.arch !== 'arm64' && input.arch !== 'x64') return invalid()
  const paths = ['home', 'root', 'destination', ...(input.platform === 'win32' ? ['appData', 'localAppData'] : [])]
  const keys = ['platform', 'arch', ...paths]
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))) return invalid()
  for (const key of paths) {
    const path = input[key]
    if (typeof path !== 'string' || !path || Buffer.byteLength(path) > 4096 || !isAbsolute(path) || /[\x00-\x1f\x7f-\x9f]/.test(path)) return invalid()
  }
  return { integration: { platform: input.platform, arch: input.arch, home: input.home as string, root: input.root as string,
    ...(input.platform === 'win32' ? { appData: input.appData as string, localAppData: input.localAppData as string } : {}) }, destination: input.destination as string }
}

async function main(): Promise<void> {
  let result: (Diagnostic & { permissionPhases?: PermissionPhases }) | { ok: true }
  let probe: ReturnType<typeof installPermissionPhaseProbe> | undefined
  try {
    if (process.argv.length !== 2) throw new Error('Invalid diagnostic parameters')
    const options = parameters(process.env.JARVIS_TEST_SNAPSHOT_PARAMETERS)
    if (process.env.JARVIS_TEST_SNAPSHOT_PHASES === '1') probe = installPermissionPhaseProbe()
    const { createIntegrationSnapshot } = await import('../../scripts/native-integration-snapshot.ts')
    const receipt = await createIntegrationSnapshot(options)
    if (!/^[a-f0-9]{64}$/.test(receipt.manifestSha256)) throw new Error('Invalid diagnostic receipt')
    result = { ok: true }
  } catch (error) {
    result = sanitizeDiagnostic(error)
    if (result.stage === 'integration-permission-check' && probe?.latest()) result.permissionPhases = probe.latest()
    process.exitCode = 1
  } finally { probe?.restore() }
  process.stdout.write(JSON.stringify(result) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
