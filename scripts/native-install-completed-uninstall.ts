import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { describeNativeIntegration, parseNativeIntegrationReceipt, readNativeIntegrationSlot, type InstallOptions } from './install-native.ts'
import { verifyNativeInstallAncestors, verifyNativeInstallPrivatePath, verifyNativeInstallPrivatePaths, withNativeInstallLock } from './native-install-lock.ts'
import { readNativeInstallTransactionSnapshot } from './native-install-transaction-store.ts'
import { readNativeInstallTransactionAckSnapshot } from './native-install-transaction-ack-store.ts'
import { readNativeInstallTransactionCompletionSnapshot } from './native-install-transaction-completion-store.ts'

const refused = () => new Error('Completed native install uninstall refused; retained evidence requires review')
const fields = ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const
const sameFile = (a: BigIntStats, b: BigIntStats, moved = false) => fields.every(key => (moved && key === 'ctimeNs') || a[key] === b[key])
const identity = (stat: BigIntStats) => Object.fromEntries(fields.map(key => [key, stat[key].toString()]))
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.isDirectory() && b.isDirectory() && ['dev', 'ino', 'mode', 'uid', 'gid'].every(key => a[key as keyof BigIntStats] === b[key as keyof BigIntStats])
async function absent(path: string) {
  try { await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  throw refused()
}
async function exactNames(directory: string, expected: string[], reservedOnly = false) {
  const names = (await readdir(directory)).filter(name => !reservedOnly || name.toLowerCase().startsWith('prepared-') || name.toLowerCase() === 'install-intent.json').sort()
  if (JSON.stringify(names) !== JSON.stringify([...expected].sort())) throw refused()
}
async function pin(directory: string, privateDirectory = true) {
  await verifyNativeInstallAncestors(directory)
  if (privateDirectory && !await verifyNativeInstallPrivatePath(directory, true)) throw refused()
  const entries: { path: string; stat: BigIntStats }[] = []
  for (let path = directory; ; path = dirname(path)) {
    const stat = await lstat(path, { bigint: true })
    if (!stat.isDirectory()) throw refused()
    entries.push({ path, stat })
    if (path === dirname(path)) break
  }
  return async (removed = new Set<string>(), skipPrivate = false) => {
    const existing = entries.find(entry => !removed.has(entry.path))!
    await verifyNativeInstallAncestors(existing.path)
    for (const entry of entries) {
      if (removed.has(entry.path)) await absent(entry.path)
      else if (!sameDirectory(entry.stat, await lstat(entry.path, { bigint: true }))) throw refused()
    }
    if (privateDirectory && !skipPrivate && !await verifyNativeInstallPrivatePath(directory, true)) throw refused()
  }
}
type Evidence = { bytes: Buffer; stat: BigIntStats }

/** Explicit caller-authorized removal of one fully observed completed generation.
 * Uses only fixed integration slots, under one existing shared SQLite lock. Records
 * are claims, not authentication. All failures after exclusive barrier creation
 * retain evidence; this API never resumes or rolls back. The last rename commits;
 * a late error has an uncertain outcome. Cooperating writers/process crashes only:
 * no hostile same-user race exclusion, directory fsync or power-loss guarantee. */
export async function uninstallCompletedNativeInstallTransaction({ integration, transactionId }: { integration: InstallOptions; transactionId: string }): Promise<{ transactionId: string; removedPaths: string[]; archiveDirectory: string }> {
  const options = { ...integration }
  if (typeof transactionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(transactionId)) throw refused()
  const layout = describeNativeIntegration(options)
  const control = join(dirname(layout.receiptPath), 'native-install-control')
  return withNativeInstallLock({ controlDirectory: control }, async () => {
    const verifyControl = await pin(control)
    const original = await readNativeInstallTransactionSnapshot(options)
    if (!original || original.transaction.transactionId !== transactionId) throw refused()
    const transaction = original.transaction
    const slots = transaction.artifacts.flatMap((artifact, index) => artifact.state === 'present' ? [index] : [])
    const ackSnapshots = []
    for (const artifactIndex of slots) {
      const snapshot = await readNativeInstallTransactionAckSnapshot({ integration: options, transaction, artifactIndex })
      if (!snapshot) throw refused()
      ackSnapshots.push(snapshot)
    }
    const acks = ackSnapshots.map(snapshot => snapshot.ack)
    const completion = await readNativeInstallTransactionCompletionSnapshot({ integration: options, transaction, acks })
    if (!completion) throw refused()
    const barrierName = `prepared-uninstalling-${transactionId}`
    const barrier = join(control, barrierName)
    const records: { name: string; original: Evidence; movedStat?: BigIntStats; moved: boolean; read: (moved: boolean) => Promise<Evidence | undefined> }[] = [
      { name: 'prepared-completion.json', original: completion, moved: false, read: moved => readNativeInstallTransactionCompletionSnapshot({ integration: options, transaction, acks }, completion.stat, moved ? barrier : undefined) },
      ...ackSnapshots.map(snapshot => ({ name: `prepared-artifact-${snapshot.ack.artifactIndex}.json`, original: snapshot, moved: false, read: (moved: boolean) => readNativeInstallTransactionAckSnapshot({ integration: options, transaction, artifactIndex: snapshot.ack.artifactIndex }, snapshot.stat, moved ? barrier : undefined) })),
      { name: 'prepared-transaction.json', original, moved: false, read: moved => readNativeInstallTransactionSnapshot(options, original.stat, moved ? barrier : undefined) },
    ]
    await exactNames(control, records.map(record => record.name), true)
    const receipt = await readNativeIntegrationSlot(options, layout.receiptPath)
    if (!receipt || !receipt.bytes.equals(Buffer.from(transaction.receipt.base64, 'base64')) || fields.some(key => receipt.identity[key].toString() !== completion.completion.receipt.identity[key])) throw refused()
    const parsed = parseNativeIntegrationReceipt(receipt.bytes, options)
    if (parsed.root !== options.root || parsed.autostart !== false) throw refused()
    const artifacts: { path: string; bytes: Buffer; mode: number; identity: BigIntStats }[] = []
    for (const [index, path] of layout.artifactPaths.entries()) {
      const snapshot = await readNativeIntegrationSlot(options, path)
      const expected = transaction.artifacts[index]!
      if (expected.state === 'absent') { if (snapshot) throw refused(); continue }
      const ack = acks.find(value => value.artifactIndex === index)!
      if (!snapshot || snapshot.bytes.length !== expected.expected.bytes || hash(snapshot.bytes) !== expected.expected.sha256 || fields.some(key => snapshot.identity[key].toString() !== ack.identity[key])) throw refused()
      artifacts.push({ path, ...snapshot })
    }
    const removedDirectories = new Set<string>()
    const directoryPins: Awaited<ReturnType<typeof pin>>[] = []
    for (const directory of new Set([...artifacts.map(artifact => dirname(artifact.path)), dirname(layout.receiptPath)])) directoryPins.push(await pin(directory, false))
    const wrappers = options.platform === 'darwin' ? [dirname(layout.artifactPaths[1]!), dirname(dirname(layout.artifactPaths[1]!)), dirname(dirname(dirname(layout.artifactPaths[1]!)))] : []
    const removedPaths: string[] = []
    const verifySlots = async () => {
      for (const path of layout.artifactPaths) if (removedPaths.includes(path) || !artifacts.some(artifact => artifact.path === path)) await absent(path)
      if (removedPaths.includes(layout.receiptPath)) await absent(layout.receiptPath)
      else {
        const current = await readNativeIntegrationSlot(options, layout.receiptPath)
        if (!current || !sameFile(receipt.identity, current.identity) || !receipt.bytes.equals(current.bytes)) throw refused()
      }
    }
    await verifyControl()
    await mkdir(barrier, { mode: 0o700 })
    const verifyBarrier = await pin(barrier)
    const archive = await mkdtemp(join(control, `retired-${transactionId}-`))
    const verifyArchive = await pin(archive)
    const generation = join(archive, 'generation')
    const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'native-install-completed-uninstall', transactionId, archiveBasename: basename(archive), destination: 'generation', records: records.map(record => ({ name: record.name, sha256: hash(record.original.bytes), identity: identity(record.original.stat) })), slots: [...artifacts, { path: layout.receiptPath, ...receipt }].map(slot => ({ path: slot.path, sha256: hash(slot.bytes), identity: identity(slot.identity) })) }) + '\n')
    if (manifestBytes.length > 32 * 1024) throw refused()
    const manifestPath = join(barrier, 'manifest.json')
    const manifest = await open(manifestPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    let manifestStat: BigIntStats
    let manifestFailure: unknown
    let manifestFailed = false
    try { await manifest.writeFile(manifestBytes); await manifest.sync(); manifestStat = await manifest.stat({ bigint: true }) }
    catch (error) { manifestFailed = true; manifestFailure = error; throw error }
    finally {
      try { await manifest.close() } catch (error) {
        if (manifestFailed) throw new AggregateError([manifestFailure, error], 'Uninstall manifest write and close failed', { cause: manifestFailure })
        throw error
      }
    }
    const verifyManifest = async () => {
      if (!await verifyNativeInstallPrivatePath(manifestPath, false)) throw refused()
      const file = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const before = await file.stat({ bigint: true })
        if (!sameFile(manifestStat, before) || !before.isFile() || before.nlink !== 1n || before.size !== BigInt(manifestBytes.length)) throw refused()
        const bytes = Buffer.alloc(manifestBytes.length + 1)
        let length = 0
        while (length < bytes.length) { const result = await file.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead }
        if (!bytes.subarray(0, length).equals(manifestBytes) || !sameFile(before, await file.stat({ bigint: true })) || !sameFile(before, await lstat(manifestPath, { bigint: true }))) throw refused()
      } finally { await file.close() }
    }
    const evidence = async () => {
      // Keep ancestry/identity checks in order; batch only the private checks
      // within this read-only pin phase, before any manifest or store reads.
      await verifyControl(undefined, true); await verifyBarrier(undefined, true); await verifyArchive(undefined, true)
      if (!await verifyNativeInstallPrivatePaths([control, barrier, archive].map(path => ({ path, directory: true })))) throw refused()
      for (const verify of directoryPins) await verify(removedDirectories)
      await absent(generation); await exactNames(archive, [])
      await exactNames(control, [barrierName, ...records.filter(record => !record.moved).map(record => record.name)], true)
      await exactNames(barrier, ['manifest.json', ...records.filter(record => record.moved).map(record => record.name)])
      await verifyManifest()
      for (const record of records) {
        const current = await record.read(record.moved)
        if (!current || !sameFile(record.movedStat ?? record.original.stat, current.stat) || !record.original.bytes.equals(current.bytes)) throw refused()
        if (record.moved) await absent(join(control, record.name))
      }
      await verifySlots()
    }
    for (const artifact of artifacts) {
      await evidence()
      const current = await readNativeIntegrationSlot(options, artifact.path)
      if (!current || !sameFile(artifact.identity, current.identity) || !artifact.bytes.equals(current.bytes)) throw refused()
      if (!sameFile(current.identity, await lstat(artifact.path, { bigint: true }))) throw refused()
      await unlink(artifact.path)
      removedPaths.push(artifact.path)
      await absent(artifact.path)
    }
    // Only the fixed wrapper directories, bottom-up. Nonempty directories survive.
    for (const directory of wrappers) {
      await evidence()
      for (const verify of directoryPins) await verify(removedDirectories)
      try { await rmdir(directory); removedDirectories.add(directory) } catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    }
    await evidence()
    if (!sameFile(receipt.identity, await lstat(layout.receiptPath, { bigint: true }))) throw refused()
    await unlink(layout.receiptPath)
    removedPaths.push(layout.receiptPath)
    await absent(layout.receiptPath)
    for (const record of records) {
      await evidence()
      const source = join(control, record.name)
      const destination = join(barrier, record.name)
      await absent(destination)
      if (!sameFile(record.original.stat, await lstat(source, { bigint: true }))) throw refused()
      await rename(source, destination)
      record.moved = true
      const moved = await record.read(true)
      if (!moved || !sameFile(record.original.stat, moved.stat, true) || !record.original.bytes.equals(moved.bytes)) throw refused()
      record.movedStat = moved.stat
      await evidence()
    }
    await evidence()
    // Commit is the last safety action. Never roll back or clean up on a late error.
    await rename(barrier, generation)
    return { transactionId, removedPaths, archiveDirectory: generation }
  })
}
