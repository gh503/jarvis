import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describeNativeIntegration, type InstallOptions } from './install-native.ts'
import { decodeNativeInstallTransaction, encodeNativeInstallTransaction, type NativeInstallTransaction } from './native-install-transaction.ts'
import { decodeNativeInstallTransactionAck, encodeNativeInstallTransactionAck, NATIVE_INSTALL_TRANSACTION_ACK_MAX_BYTES, type NativeInstallTransactionAck } from './native-install-transaction-ack.ts'
import { readNativeInstallTransaction } from './native-install-transaction-store.ts'
import { assertNativeInstallLockHeld, runWithNativeInstallLockHeld, verifyNativeInstallPrivatePath, verifyNativeInstallAncestors, withNativeInstallLock, type NativeInstallLock } from './native-install-lock.ts'

const unsafe = () => new Error('Unsafe native install transaction acknowledgement store')
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink
const sameFile = (a: BigIntStats, b: BigIntStats) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
function checkFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(NATIVE_INSTALL_TRANSACTION_ACK_MAX_BYTES)) throw unsafe()
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
interface Context {
  integration: InstallOptions
  transaction: NativeInstallTransaction
  transactionBytes: Buffer
  artifactIndex: number
  directory: string
  path: string
}
function context(integration: InstallOptions, transaction: NativeInstallTransaction, artifactIndex: number): Context {
  const options = { ...integration }
  const transactionBytes = encodeNativeInstallTransaction(transaction, options)
  const snapshot = decodeNativeInstallTransaction(transactionBytes, options)
  if (!Number.isSafeInteger(artifactIndex) || artifactIndex < 0 || snapshot.artifacts[artifactIndex]?.state !== 'present') throw unsafe()
  const directory = join(dirname(describeNativeIntegration(options).receiptPath), 'native-install-control')
  return { integration: options, transaction: snapshot, transactionBytes, artifactIndex, directory, path: join(directory, `prepared-artifact-${artifactIndex}.json`) }
}
async function requirePrepared(bound: Context): Promise<void> {
  const stored = await readNativeInstallTransaction({ integration: bound.integration })
  if (!stored || !encodeNativeInstallTransaction(stored, bound.integration).equals(bound.transactionBytes)) throw new Error('Missing or mismatched prepared native install transaction')
}
async function readStored(bound: Context, expectedIdentity?: BigIntStats) {
  const { integration, transaction, directory, path } = bound
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
    const bytes = Buffer.alloc(NATIVE_INSTALL_TRANSACTION_ACK_MAX_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > NATIVE_INSTALL_TRANSACTION_ACK_MAX_BYTES || BigInt(length) !== initial.size) throw unsafe()
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
    const ack = decodeNativeInstallTransactionAck(content, transaction, integration)
    if (ack.artifactIndex !== bound.artifactIndex) throw unsafe()
    return { ack, bytes: content, stat: after }
  } catch (error) { failed = true; failure = error; throw error }
  finally {
    try { await file.close() } catch (error) {
      if (failed) throw new AggregateError([failure, error], 'Native install acknowledgement read and close failed', { cause: failure })
      throw error
    }
  }
}

type ReadOptions = { integration: InstallOptions; transaction: NativeInstallTransaction; artifactIndex: number }
type WriteOptions = { integration: InstallOptions; transaction: NativeInstallTransaction; ack: NativeInstallTransactionAck }

/** Read-only inspection bound to the exact prepared transaction. Missing ack is
 * undefined; missing/mismatched preparation refuses. No directory or SQLite writes.
 * Stored claims do not authenticate artifact observation or grant ownership. */
export async function readNativeInstallTransactionAck({ integration, transaction, artifactIndex }: ReadOptions): Promise<NativeInstallTransactionAck | undefined> {
  const bound = context(integration, transaction, artifactIndex)
  await requirePrepared(bound)
  const stored = await readStored(bound)
  await requirePrepared(bound)
  return stored?.ack
}

/** Exclusive publication under the shared installation lock. Failed writes are
 * retained and retries never overwrite. Only the file is synced: no directory
 * sync or power-loss durability, installation, cleanup or recovery is promised. */
export async function writeNativeInstallTransactionAck({ integration, transaction, ack }: WriteOptions): Promise<NativeInstallTransactionAck> {
  const bound = context(integration, transaction, ack.artifactIndex)
  const bytes = encodeNativeInstallTransactionAck(ack, bound.transaction, bound.integration)
  await requirePrepared(bound)
  const preflight = await boundary(bound.directory)
  if (await statOrMissing(bound.path)) throw Object.assign(new Error('Native install acknowledgement already exists'), { code: 'EEXIST' })
  await verifyBoundary(bound.directory, preflight)
  return withNativeInstallLock({ controlDirectory: bound.directory }, lock =>
    runWithNativeInstallLockHeld(lock, bound.directory, () => writeExclusive(bound, bytes)))
}

/** Call-time snapshots; registered work drains before the supplied scope closes. */
export function writeNativeInstallTransactionAckUnderLock({ integration, transaction, ack, lock }: WriteOptions & { lock: NativeInstallLock }): Promise<NativeInstallTransactionAck> {
  const bound = context(integration, transaction, ack.artifactIndex)
  assertNativeInstallLockHeld(lock, bound.directory)
  const bytes = encodeNativeInstallTransactionAck(ack, bound.transaction, bound.integration)
  return runWithNativeInstallLockHeld(lock, bound.directory, () => writeExclusive(bound, bytes))
}

async function writeExclusive(bound: Context, bytes: Buffer): Promise<NativeInstallTransactionAck> {
  const { directory, path } = bound
  await requirePrepared(bound)
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
    const stored = await readStored(bound, created)
    if (!stored || !stored.bytes.equals(bytes) || !sameFile(written, stored.stat)) throw unsafe()
    await verifyBoundary(directory, ancestors)
    await requirePrepared(bound)
    return stored.ack
  } catch (error) { failed = true; failure = error; throw error }
  finally {
    try { await file.close() } catch (error) {
      if (failed) throw new AggregateError([failure, error], 'Native install acknowledgement write and close failed', { cause: failure })
      throw error
    }
  }
}
