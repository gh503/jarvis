import { type BigIntStats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describeNativeIntegration, readNativeIntegrationSlot, type InstallOptions } from './install-native.ts'
import { encodeNativeInstallIntent } from './native-install-intent.ts'
import { readNativeInstallIntent } from './native-install-intent-store.ts'
import { verifyNativeInstallAncestors, withNativeInstallLock } from './native-install-lock.ts'
import { reconcileNativeInstallIntent, type NativeInstallObservation, type NativeInstallReconcileReport } from './native-install-reconcile.ts'

export type NativeInstallDiagnosis = NativeInstallReconcileReport | {
  readonly status: 'no-intent'
  readonly scope: NativeInstallReconcileReport['scope']
}
const sameIdentity = (a: BigIntStats, b: BigIntStats) =>
  (['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const).every(key => a[key] === b[key])
async function identity(path: string): Promise<BigIntStats | undefined> {
  try { return await lstat(path, { bigint: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
interface Captured { observation: NativeInstallObservation; identity?: BigIntStats }
async function capture(integration: InstallOptions, path: string): Promise<Captured> {
  try {
    const slot = await readNativeIntegrationSlot(integration, path)
    return slot ? { observation: { path, state: 'file', bytes: slot.bytes, mode: slot.mode }, identity: slot.identity }
      : { observation: { path, state: 'absent' } }
  } catch {
    // Includes environmental IO failures: none can masquerade as absence or consistency.
    // Do not inspect metadata separately after an unsafe ancestor/type failure.
    return { observation: { path, state: 'unsafe' } }
  }
}
function stable(before: Captured, after: Captured): NativeInstallObservation {
  const a = before.observation, b = after.observation
  if (a.state === 'absent' && b.state === 'absent') return a
  if (a.state === 'file' && b.state === 'file' && before.identity && after.identity &&
      sameIdentity(before.identity, after.identity) && a.mode === b.mode && a.bytes.equals(b.bytes)) return a
  return { path: a.path, state: 'unsafe' }
}

/** Diagnose fixed integration locations under the cooperating installation lock.
 * Lock acquisition can create operational control/SQLite files and perform platform
 * ACL checks; integration files are never changed or executed. Missing intent makes
 * no claim about artifacts, including orphan files. With intent, every fixed slot is
 * bounded-read and rechecked even if the receipt is missing or unsafe. Reports expose
 * no captured bytes. Other writers must remain quiescent: these checks are not an
 * atomic filesystem snapshot and cannot defeat an adversarial same-account writer.
 */
export async function diagnoseNativeInstallIntent({ integration }: { integration: InstallOptions }): Promise<NativeInstallDiagnosis> {
  const options = { ...integration }
  const { receiptPath, artifactPaths } = describeNativeIntegration(options)
  const controlDirectory = join(dirname(receiptPath), 'native-install-control')
  const intentPath = join(controlDirectory, 'install-intent.json')
  return withNativeInstallLock({ controlDirectory }, async () => {
    await verifyNativeInstallAncestors(controlDirectory)
    const initialIdentity = await identity(intentPath)
    const intent = await readNativeInstallIntent({ integration: options })
    const paths = [receiptPath, ...artifactPaths]
    const captured: Captured[] = []
    if (intent) for (const path of paths) captured.push(await capture(options, path))
    const observations: NativeInstallObservation[] = []
    if (intent) for (const [index, path] of paths.entries()) observations.push(stable(captured[index]!, await capture(options, path)))
    const finalIntent = await readNativeInstallIntent({ integration: options })
    await verifyNativeInstallAncestors(controlDirectory)
    const finalIdentity = await identity(intentPath)
    if (initialIdentity ? !finalIdentity || !sameIdentity(initialIdentity, finalIdentity) : finalIdentity !== undefined) throw new Error('Native install intent changed during diagnosis')
    if (intent ? !finalIntent || !encodeNativeInstallIntent(intent, options).equals(encodeNativeInstallIntent(finalIntent, options)) : finalIntent !== undefined) throw new Error('Native install intent changed during diagnosis')
    if (!intent) return Object.freeze({ status: 'no-intent' as const, scope: Object.freeze({ ownership: false as const, execution: false as const, automaticCleanup: false as const, atomicity: false as const }) })
    return reconcileNativeInstallIntent({ integration: options, intent, observations: { receipt: observations[0]!, artifacts: observations.slice(1) } })
  })
}
