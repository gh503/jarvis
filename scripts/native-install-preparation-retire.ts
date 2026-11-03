import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { describeNativeIntegration, readNativeIntegrationSlot, type InstallOptions } from './install-native.ts'
import { verifyNativeInstallAncestors, verifyNativeInstallPrivatePath, withNativeInstallLock } from './native-install-lock.ts'
import { readNativeInstallTransactionSnapshot } from './native-install-transaction-store.ts'

const refused = () => new Error('Native install preparation retirement refused; retained evidence requires review')
const fields = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const
const sameFile = (a: BigIntStats, b: BigIntStats, moved = false) => fields.every(key => (moved && key === 'ctimeNs') || a[key] === b[key])
const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.isDirectory() && b.isDirectory() && ['dev', 'ino', 'mode', 'uid', 'gid'].every(key => a[key as keyof BigIntStats] === b[key as keyof BigIntStats])
async function absent(path: string): Promise<void> {
  try { await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  throw refused()
}
async function pin(directory: string) {
  await verifyNativeInstallAncestors(directory)
  if (!await verifyNativeInstallPrivatePath(directory, true)) throw refused()
  const entries: { path: string; stat: BigIntStats }[] = []
  for (let path = directory; ; path = dirname(path)) {
    entries.push({ path, stat: await lstat(path, { bigint: true }) })
    if (path === dirname(path)) break
  }
  return async () => {
    await verifyNativeInstallAncestors(directory)
    if (!await verifyNativeInstallPrivatePath(directory, true)) throw refused()
    for (const entry of entries) if (!sameDirectory(entry.stat, await lstat(entry.path, { bigint: true }))) throw refused()
  }
}
async function exactNames(directory: string, expected: string[], reservedOnly = false) {
  const names = (await readdir(directory)).filter(name => !reservedOnly || name.toLowerCase().startsWith('prepared-') || name.toLowerCase() === 'install-intent.json').sort()
  if (JSON.stringify(names) !== JSON.stringify([...expected].sort())) throw refused()
}

/** Explicit retirement of one exact prepared-only transaction under the fixed shared
 * installation lock. The original package root is a syntax/exact-binding input;
 * its package and configuration are never loaded and need no longer exist.
 *
 * A private prepared-retiring-UUID barrier is created before any source move. Its
 * bounded manifest is file-synced. Every precommit failure retains all evidence;
 * there is no rollback or automatic deletion. The final barrier-to-generation
 * rename is the commit: no safety checks requiring rollback follow it. A late
 * error (including lock release or lost response) has an uncertain outcome.
 *
 * Portable rename has no no-replace primitive here: destination absence and
 * namespace revalidation protect cooperating writers only. External writers must
 * remain stopped. There is no directory fsync or power-loss guarantee, ownership
 * grant, installer completion, replay, or recovery authority. Integration absence
 * reads retain the existing legacy policy (not Windows ACL privacy verification).
 */
export async function retireNativeInstallPreparation({ integration, transactionId }: { integration: InstallOptions; transactionId: string }): Promise<{ transactionId: string; archiveDirectory: string }> {
  const options = { ...integration }
  if (typeof transactionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(transactionId)) throw refused()
  const layout = describeNativeIntegration(options)
  const control = join(dirname(layout.receiptPath), 'native-install-control')
  return withNativeInstallLock({ controlDirectory: control }, async () => {
    const verifyControl = await pin(control)
    const source = join(control, 'prepared-transaction.json')
    const barrierName = `prepared-retiring-${transactionId}`
    const barrier = join(control, barrierName)
    const absence = async () => {
      for (const path of [...layout.artifactPaths, layout.receiptPath]) if (await readNativeIntegrationSlot(options, path)) throw refused()
      await absent(join(control, 'install-intent.json'))
    }
    await exactNames(control, ['prepared-transaction.json'], true)
    const original = await readNativeInstallTransactionSnapshot(options)
    if (!original || original.transaction.transactionId !== transactionId) throw refused()
    await absence()
    await verifyControl()
    // mkdir is exclusive: even an empty preexisting barrier refuses retirement.
    await mkdir(barrier, { mode: 0o700 })
    const verifyBarrier = await pin(barrier)
    const archive = await mkdtemp(join(control, `retired-${transactionId}-`))
    const verifyArchive = await pin(archive)
    const generation = join(archive, 'generation')
    const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'native-install-preparation-retirement', transactionId, sha256: createHash('sha256').update(original.bytes).digest('hex'), identity: Object.fromEntries(fields.map(key => [key, original.stat[key].toString()])), archiveBasename: basename(archive) }) + '\n')
    if (manifestBytes.length > 4096) throw refused()
    const manifestPath = join(barrier, 'manifest.json')
    const manifest = await open(manifestPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    let manifestStat: BigIntStats
    let failure: unknown
    let failed = false
    try {
      await manifest.writeFile(manifestBytes)
      await manifest.sync()
      manifestStat = await manifest.stat({ bigint: true })
    } catch (error) { failed = true; failure = error; throw error }
    finally {
      try { await manifest.close() } catch (error) {
        if (failed) throw new AggregateError([failure, error], 'Retirement manifest write and close failed', { cause: failure })
        throw error
      }
    }
    const verifyManifest = async () => {
      if (!await verifyNativeInstallPrivatePath(manifestPath, false)) throw refused()
      const file = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const before = await file.stat({ bigint: true })
        if (!sameFile(manifestStat, before) || !before.isFile() || before.nlink !== 1n || before.size !== BigInt(manifestBytes.length)) throw refused()
        const buffer = Buffer.alloc(manifestBytes.length + 1)
        let length = 0
        while (length < buffer.length) {
          const read = await file.read(buffer, length, buffer.length - length, length)
          if (!read.bytesRead) break
          length += read.bytesRead
        }
        if (!buffer.subarray(0, length).equals(manifestBytes) || !sameFile(before, await file.stat({ bigint: true })) || !sameFile(before, await lstat(manifestPath, { bigint: true }))) throw refused()
      } finally { await file.close() }
    }
    const boundaries = async () => { await verifyControl(); await verifyBarrier(); await verifyArchive(); await absent(generation); await exactNames(archive, []) }
    await boundaries()
    await verifyManifest()
    await exactNames(barrier, ['manifest.json'])
    await exactNames(control, ['prepared-transaction.json', barrierName], true)
    await absence()
    const current = await readNativeInstallTransactionSnapshot(options)
    if (!current || !sameFile(original.stat, current.stat) || !current.bytes.equals(original.bytes)) throw refused()
    await boundaries()
    // Check the actual pathname stat against the bounded read immediately before move.
    if (!sameFile(current.stat, await lstat(source, { bigint: true }))) throw refused()
    await rename(source, join(barrier, 'prepared-transaction.json'))
    const moved = await readNativeInstallTransactionSnapshot(options, original.stat, barrier)
    if (!moved || !sameFile(original.stat, moved.stat, true) || !moved.bytes.equals(original.bytes)) throw refused()
    await absent(source)
    await exactNames(control, [barrierName], true)
    await exactNames(barrier, ['manifest.json', 'prepared-transaction.json'])
    await absence()
    await verifyManifest()
    await boundaries()
    if (!sameFile(moved.stat, await lstat(join(barrier, 'prepared-transaction.json'), { bigint: true }))) throw refused()
    await exactNames(control, [barrierName], true)
    await absent(source)
    await exactNames(barrier, ['manifest.json', 'prepared-transaction.json'])
    await rename(barrier, generation)
    return { transactionId, archiveDirectory: generation }
  })
}
