import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describeNativeIntegration, type InstallOptions } from './install-native.ts'
import { decodeNativeInstallTransaction, encodeNativeInstallTransaction, NATIVE_INSTALL_TRANSACTION_MAX_BYTES, type NativeInstallTransaction } from './native-install-transaction.ts'
import { assertNativeInstallLockHeld, runWithNativeInstallLockHeld, verifyNativeInstallPrivatePath, verifyNativeInstallAncestors, withNativeInstallLock, type NativeInstallLock } from './native-install-lock.ts'

const unsafe = () => new Error('Unsafe native install transaction store')
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink
const sameFile = (a: BigIntStats, b: BigIntStats) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
function checkFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(NATIVE_INSTALL_TRANSACTION_MAX_BYTES)) throw unsafe()
  if (process.platform !== 'win32' && (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o7777n) !== 0o600n)) throw unsafe()
}
async function statOrMissing(path: string): Promise<BigIntStats | undefined> {
  try { return await lstat(path, { bigint: true }) } catch (error) { if (missing(error)) return undefined; throw error }
}
// Directory child activity legitimately changes nlink (including file creation
// on APFS), size and timestamps. Pin the directory and its security metadata,
// while retaining full metadata checks for the transaction file itself.
const sameDirectory = (a: BigIntStats, b: BigIntStats) => a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid
type Boundary = readonly { path: string; stat: BigIntStats | undefined }[]
async function boundary(directory: string): Promise<Boundary> {
  await verifyNativeInstallAncestors(directory)
  const result: { path: string; stat: BigIntStats | undefined }[] = []
  for (let path = directory; ; path = dirname(path)) {
    result.push({ path, stat: await statOrMissing(path) })
    if (path === dirname(path)) break
  }
  if (await verifyNativeInstallPrivatePath(directory, true) !== (result[0]!.stat !== undefined)) throw unsafe()
  await verifyBoundary(directory, result)
  return result
}
async function verifyBoundary(directory: string, before: Boundary): Promise<void> {
  await verifyNativeInstallAncestors(directory)
  for (const entry of before) {
    const after = await statOrMissing(entry.path)
    if (entry.stat ? !after || !sameDirectory(entry.stat, after) : after !== undefined) throw unsafe()
  }
  if (await verifyNativeInstallPrivatePath(directory, true) !== (before[0]!.stat !== undefined)) throw unsafe()
}
function location(integration: InstallOptions) {
  const directory = join(dirname(describeNativeIntegration(integration).receiptPath), 'native-install-control')
  return { directory, path: join(directory, 'prepared-transaction.json') }
}
/** Internal bounded snapshot reader shared with preparation retirement. An alternate
 * directory must be an immediate fixed-control prepared-retiring-UUID child, requires
 * the original identity, and passes the same read-only private boundary checks. */
export async function readNativeInstallTransactionSnapshot(integration: InstallOptions, expectedIdentity?: BigIntStats, directory = location(integration).directory) {
  const control = location(integration).directory
  if (directory !== control && (!expectedIdentity || dirname(directory) !== control || !/^prepared-retiring-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(directory.slice(control.length + 1)))) throw unsafe()
  const path = join(directory, 'prepared-transaction.json')
  const ancestors = await boundary(directory)
  const before = await statOrMissing(path)
  if (!before) {
    await verifyBoundary(directory, ancestors)
    if (expectedIdentity || await statOrMissing(path)) throw unsafe()
    return undefined
  }
  checkFile(before)
  if (!await verifyNativeInstallPrivatePath(path, false)) throw unsafe()
  // NONBLOCK prevents a raced-in FIFO from blocking before descriptor validation.
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  let failure: unknown
  let failed = false
  try {
    const initial = await file.stat({ bigint: true })
    checkFile(initial)
    if (!sameFile(before, initial) || (expectedIdentity && !sameIdentity(expectedIdentity, initial))) throw unsafe()
    const bytes = Buffer.alloc(NATIVE_INSTALL_TRANSACTION_MAX_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > NATIVE_INSTALL_TRANSACTION_MAX_BYTES || BigInt(length) !== initial.size) throw unsafe()
    const eof = await file.read(Buffer.alloc(1), 0, 1, length)
    if (eof.bytesRead !== 0) throw unsafe()
    const after = await file.stat({ bigint: true })
    checkFile(after)
    if (!sameFile(initial, after)) throw unsafe()
    if (!await verifyNativeInstallPrivatePath(path, false)) throw unsafe()
    const named = await statOrMissing(path)
    if (!named || !sameFile(after, named)) throw unsafe()
    await verifyBoundary(directory, ancestors)
    const final = await file.stat({ bigint: true })
    const finalNamed = await statOrMissing(path)
    if (!sameFile(after, final) || !finalNamed || !sameFile(final, finalNamed)) throw unsafe()
    const content = bytes.subarray(0, length)
    return { transaction: decodeNativeInstallTransaction(content, integration), bytes: content, stat: after }
  } catch (error) { failed = true; failure = error; throw error }
  finally {
    try { await file.close() } catch (error) {
      if (failed) throw new AggregateError([failure, error], 'Native install transaction read and close failed', { cause: failure })
      throw error
    }
  }
}

/** Read-only inspection: no lock acquisition, directory creation, ACL repair or
 * SQLite access. Presence grants no ownership, execution, cleanup, replay or recovery authority,
 * and is never evidence of installation completion. */
export async function readNativeInstallTransaction({ integration }: { integration: InstallOptions }): Promise<NativeInstallTransaction | undefined> {
  return (await readNativeInstallTransactionSnapshot({ ...integration }))?.transaction
}

/** Append-once plan publication under the shared installation lock. An existing
 * name always refuses publication. Failed writes/syncs retain the file, even if
 * its bytes happen to be valid JSON; failure is never acknowledged as success.
 * Only the file is synced; no directory fsync or power-loss durability is promised.
 * No overwrite, cleanup, execution or ownership authority is provided here. */
export async function writeNativeInstallTransaction({ integration, transaction }: { integration: InstallOptions; transaction: NativeInstallTransaction }): Promise<NativeInstallTransaction> {
  const options = { ...integration }
  const bytes = encodeNativeInstallTransaction(transaction, options)
  const { directory, path } = location(options)
  const preflight = await boundary(directory)
  if (await statOrMissing(path)) throw Object.assign(new Error('Native install transaction already exists'), { code: 'EEXIST' })
  await verifyBoundary(directory, preflight)
  return withNativeInstallLock({ controlDirectory: directory }, lock =>
    runWithNativeInstallLockHeld(lock, directory, () => writeExclusive(options, bytes, directory, path)))
}

/** Compose publication into an existing lock scope at the fixed receipt-derived
 * location. Registered work finishes before that scope releases its lock. */
export function writeNativeInstallTransactionUnderLock({ integration, transaction, lock }: { integration: InstallOptions; transaction: NativeInstallTransaction; lock: NativeInstallLock }): Promise<NativeInstallTransaction> {
  const options = { ...integration }
  const { directory, path } = location(options)
  assertNativeInstallLockHeld(lock, directory)
  const bytes = encodeNativeInstallTransaction(transaction, options)
  return runWithNativeInstallLockHeld(lock, directory, () => writeExclusive(options, bytes, directory, path))
}

async function writeExclusive(options: InstallOptions, bytes: Buffer, directory: string, path: string): Promise<NativeInstallTransaction> {
  const ancestors = await boundary(directory)
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  let failure: unknown
  let failed = false
  try {
    const created = await file.stat({ bigint: true })
    checkFile(created)
    await verifyBoundary(directory, ancestors)
    if (!await verifyNativeInstallPrivatePath(path, false)) throw unsafe()
    const named = await statOrMissing(path)
    if (!named || !sameFile(created, named)) throw unsafe()
    await file.writeFile(bytes)
    await file.sync()
    const written = await file.stat({ bigint: true })
    checkFile(written)
    if (!sameIdentity(created, written) || written.size !== BigInt(bytes.length)) throw unsafe()
    const stored = await readNativeInstallTransactionSnapshot(options, created)
    if (!stored || !stored.bytes.equals(bytes) || !sameFile(written, stored.stat)) throw unsafe()
    await verifyBoundary(directory, ancestors)
    return stored.transaction
  } catch (error) { failed = true; failure = error; throw error }
  finally {
    try { await file.close() } catch (error) {
      if (failed) throw new AggregateError([failure, error], 'Native install transaction write and close failed', { cause: failure })
      throw error
    }
  }
}
