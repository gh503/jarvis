import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describeNativeIntegration, type InstallOptions } from './install-native.ts'
import { assertNativeInstallLockHeld, type NativeInstallLock } from './native-install-lock.ts'

/** Presence-only publication barrier at the fixed receipt-derived control boundary.
 * Known slots include excluded artifacts: the individual stores enforce bindings.
 * Never open, decode, or follow an unknown entry. The cooperating-writer lock does
 * not exclude same-user mutation between this check and the next operation. */
export async function assertNativeInstallPreparedWriteAllowed(integration: InstallOptions, lock: NativeInstallLock): Promise<void> {
  const layout = describeNativeIntegration(integration)
  const directory = join(dirname(layout.receiptPath), 'native-install-control')
  assertNativeInstallLockHeld(lock, directory)
  const allowed = new Set(['prepared-transaction.json', 'prepared-completion.json',
    ...layout.artifactPaths.map((_, index) => `prepared-artifact-${index}.json`)])
  try {
    for (const name of await readdir(directory)) {
      const lower = name.toLowerCase()
      if (lower === 'install-intent.json' || (lower.startsWith('prepared-') && !allowed.has(name))) throw new Error()
    }
  } catch { throw new Error('Native install preparation publication blocked by retained or unsafe control entries') }
}
