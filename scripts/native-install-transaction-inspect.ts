import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import { describeNativeIntegration, readNativeIntegrationSlot, type InstallOptions } from './install-native.ts'
import { withNativeInstallLock } from './native-install-lock.ts'
import { encodeNativeInstallTransaction } from './native-install-transaction.ts'
import { readNativeInstallTransaction } from './native-install-transaction-store.ts'
import { encodeNativeInstallTransactionAck, type NativeInstallArtifactIdentity, type NativeInstallTransactionAck } from './native-install-transaction-ack.ts'
import { readNativeInstallTransactionAck } from './native-install-transaction-ack-store.ts'

const FIELDS = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const
const SCOPE = Object.freeze({ ownership: false, execution: false, automaticCleanup: false, replay: false, atomicity: false, completed: false } as const)
const LIMITATIONS = Object.freeze({ sourcePolicy: 'legacy-integration', sourceWindowsAcl: false, controlPolicy: 'private-install-control', cooperatingWritersOnly: true, observationsAtomic: false, acknowledgementAuthenticity: false } as const)
type Status = 'no-transaction' | 'blocked' | 'conflict' | 'receipt-absent' | 'receipt-present'
type Reason = 'preparation-missing' | 'unsafe-or-unavailable' | 'ack-missing' | 'artifact-missing' | 'artifact-mismatch' | 'excluded-artifact-present' | 'receipt-mismatch' | 'observation-changed' | 'store-changed' | 'all-artifacts-match'
interface Issue { readonly reason: Reason; readonly artifactIndex?: number }
export interface NativeInstallTransactionInspection {
  readonly status: Status
  readonly issues: readonly Issue[]
  readonly scope: typeof SCOPE
  readonly limitations: typeof LIMITATIONS
}
function report(status: Status, issues: readonly Issue[]): NativeInstallTransactionInspection {
  return Object.freeze({ status, issues: Object.freeze(issues.map(issue => Object.freeze({ ...issue }))), scope: SCOPE, limitations: LIMITATIONS })
}
const equalIdentity = (a: BigIntStats, b: BigIntStats) => FIELDS.every(key => a[key] === b[key])
const matchesAck = (a: BigIntStats, b: NativeInstallArtifactIdentity) => FIELDS.every(key => a[key].toString() === b[key])
type Slot = Awaited<ReturnType<typeof readNativeIntegrationSlot>>
type Observation = { slot: Slot; unsafe: boolean }

/** Read-only assessment, never permission to publish, adopt, clean up or recover.
 * Call-time options are copied before awaiting the shared install lock. Only its
 * operational directories/SQLite files may be created. Unlocked store readers
 * are deliberately used inside that lock (no nested acquisition).
 * Source reads retain the legacy integration permission policy: Windows mode
 * bits do not prove ACL privacy. Control records use the stronger existing
 * private-control checks. Neither authenticates ack authors or stops external
 * writers; repeated observations are not an atomic filesystem snapshot.
 */
export async function inspectNativeInstallTransaction({ integration }: { integration: InstallOptions }): Promise<NativeInstallTransactionInspection> {
  const options = { ...integration }
  try {
    const layout = describeNativeIntegration(options)
    const controlDirectory = join(dirname(layout.receiptPath), 'native-install-control')
    return await withNativeInstallLock({ controlDirectory }, async () => {
      const transaction = await readNativeInstallTransaction({ integration: options })
      if (!transaction) {
        if (await readNativeInstallTransaction({ integration: options })) return report('blocked', [{ reason: 'store-changed' }])
        // No slot observation or absence inference is made without preparation.
        return report('no-transaction', [{ reason: 'preparation-missing' }])
      }
      const transactionBytes = encodeNativeInstallTransaction(transaction, options)
      const issues: Issue[] = []
      let blocked = false, conflict = false
      const add = (reason: Reason, artifactIndex?: number, mismatch = false) => {
        issues.push({ reason, ...(artifactIndex === undefined ? {} : { artifactIndex }) })
        if (mismatch) conflict = true; else blocked = true
      }
      const acks: (NativeInstallTransactionAck | undefined)[] = []
      // Fixed index order keeps reports deterministic and avoids concurrent
      // private-control ACL subprocess checks on native Windows.
      for (const [artifactIndex, artifact] of transaction.artifacts.entries()) {
        if (artifact.state === 'absent') { acks.push(undefined); continue }
        try {
          const ack = await readNativeInstallTransactionAck({ integration: options, transaction, artifactIndex })
          if (!ack) add('ack-missing', artifactIndex)
          acks.push(ack)
        } catch { add('unsafe-or-unavailable', artifactIndex); acks.push(undefined) }
      }
      const paths = [...layout.artifactPaths, layout.receiptPath]
      const observe = async (): Promise<Observation[]> => {
        const observations: Observation[] = []
        for (const path of paths) {
          try { observations.push({ slot: await readNativeIntegrationSlot(options, path), unsafe: false }) }
          catch { observations.push({ slot: undefined, unsafe: true }) }
        }
        return observations
      }
      const before = await observe()
      for (const [index, artifact] of transaction.artifacts.entries()) {
        const observation = before[index]!
        if (observation.unsafe) { add('unsafe-or-unavailable', index); continue }
        const slot = observation.slot
        if (artifact.state === 'absent') {
          if (slot) add('excluded-artifact-present', index, true)
        } else if (!slot) add('artifact-missing', index)
        else if (slot.bytes.length !== artifact.expected.bytes || createHash('sha256').update(slot.bytes).digest('hex') !== artifact.expected.sha256 || (acks[index] && !matchesAck(slot.identity, acks[index]!.identity))) add('artifact-mismatch', index, true)
      }
      const receipt = before.at(-1)!
      if (receipt.unsafe) add('unsafe-or-unavailable')
      else if (receipt.slot && !receipt.slot.bytes.equals(Buffer.from(transaction.receipt.base64, 'base64'))) add('receipt-mismatch', undefined, true)
      const after = await observe()
      for (const [index, first] of before.entries()) {
        const second = after[index]!
        const artifactIndex = index < transaction.artifacts.length ? index : undefined
        if (second.unsafe) add('unsafe-or-unavailable', artifactIndex)
        else if (!first.unsafe && (first.slot ? !second.slot || !equalIdentity(first.slot.identity, second.slot.identity) || !first.slot.bytes.equals(second.slot.bytes) : second.slot !== undefined)) add('observation-changed', artifactIndex)
      }
      // Recheck every included ack, including previously missing/unsafe records.
      for (const [artifactIndex, artifact] of transaction.artifacts.entries()) {
        if (artifact.state === 'absent') continue
        try {
          const current = await readNativeInstallTransactionAck({ integration: options, transaction, artifactIndex })
          const first = acks[artifactIndex]
          if (first ? !current || !encodeNativeInstallTransactionAck(first, transaction, options).equals(encodeNativeInstallTransactionAck(current, transaction, options)) : current !== undefined) add('store-changed', artifactIndex)
        } catch { add('unsafe-or-unavailable', artifactIndex) }
      }
      const current = await readNativeInstallTransaction({ integration: options })
      if (!current || !encodeNativeInstallTransaction(current, options).equals(transactionBytes)) add('store-changed')
      if (blocked) return report('blocked', issues)
      if (conflict) return report('conflict', issues)
      return report(receipt.slot ? 'receipt-present' : 'receipt-absent', [{ reason: 'all-artifacts-match' }])
    })
  } catch { return report('blocked', [{ reason: 'unsafe-or-unavailable' }]) }
}
