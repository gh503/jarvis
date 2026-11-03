import { assertNativeInstallPreparedWriteAllowed } from './native-install-prepared-write-gate.ts'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describeNativeIntegration, type InstallOptions } from './install-native.ts'
import { decodeNativeInstallTransaction, encodeNativeInstallTransaction, type NativeInstallTransaction } from './native-install-transaction.ts'
import { decodeNativeInstallTransactionCompletion, encodeNativeInstallTransactionCompletion, NATIVE_INSTALL_TRANSACTION_COMPLETION_MAX_BYTES, type NativeInstallTransactionCompletion } from './native-install-transaction-completion.ts'
import { decodeNativeInstallTransactionAck, encodeNativeInstallTransactionAck, type NativeInstallTransactionAck } from './native-install-transaction-ack.ts'
import { readNativeInstallTransactionAck } from './native-install-transaction-ack-store.ts'
import { readNativeInstallTransaction } from './native-install-transaction-store.ts'
import { assertNativeInstallLockHeld, runWithNativeInstallLockHeld, verifyNativeInstallPrivatePath, verifyNativeInstallAncestors, withNativeInstallLock, type NativeInstallLock } from './native-install-lock.ts'

const unsafe = () => new Error('Unsafe native install transaction completion store')
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink
const sameFile = (a: BigIntStats, b: BigIntStats) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
function checkFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(NATIVE_INSTALL_TRANSACTION_COMPLETION_MAX_BYTES)) throw unsafe()
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
  acks: readonly NativeInstallTransactionAck[]
  ackBytes: readonly Buffer[]
  directory: string
  path: string
}
function context(integration: InstallOptions, transaction: NativeInstallTransaction, acks: readonly NativeInstallTransactionAck[]): Context {
  const options = { ...integration }
  const transactionBytes = encodeNativeInstallTransaction(transaction, options)
  const snapshot = decodeNativeInstallTransaction(transactionBytes, options)
  const slots = snapshot.artifacts.flatMap((artifact, index) => artifact.state === 'present' ? [index] : [])
  if (!Array.isArray(acks) || acks.length !== slots.length || Reflect.ownKeys(acks).some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= slots.length))) throw unsafe()
  const ackBytes = slots.map((slot, index) => {
    if (!Object.hasOwn(acks, index) || acks[index]?.artifactIndex !== slot) throw unsafe()
    return encodeNativeInstallTransactionAck(acks[index]!, snapshot, options)
  })
  const snapshots = ackBytes.map(bytes => decodeNativeInstallTransactionAck(bytes, snapshot, options))
  const directory = join(dirname(describeNativeIntegration(options).receiptPath), 'native-install-control')
  return { integration: options, transaction: snapshot, transactionBytes, acks: snapshots, ackBytes, directory, path: join(directory, 'prepared-completion.json') }
}
async function requirePrepared(bound: Context): Promise<void> {
  const stored = await readNativeInstallTransaction({ integration: bound.integration })
  if (!stored || !encodeNativeInstallTransaction(stored, bound.integration).equals(bound.transactionBytes)) throw new Error('Missing or mismatched prepared native install transaction')
}
async function requireBindings(bound: Context): Promise<void> {
  await requirePrepared(bound)
  for (const [index, ack] of bound.acks.entries()) {
    const stored = await readNativeInstallTransactionAck({ integration: bound.integration, transaction: bound.transaction, artifactIndex: ack.artifactIndex })
    if (!stored || !encodeNativeInstallTransactionAck(stored, bound.transaction, bound.integration).equals(bound.ackBytes[index]!)) throw new Error('Missing or mismatched prepared native install acknowledgement')
  }
  await requirePrepared(bound)
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
    const bytes = Buffer.alloc(NATIVE_INSTALL_TRANSACTION_COMPLETION_MAX_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > NATIVE_INSTALL_TRANSACTION_COMPLETION_MAX_BYTES || BigInt(length) !== initial.size) throw unsafe()
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
    const completion = decodeNativeInstallTransactionCompletion(content, transaction, integration, bound.acks)
    return { completion, bytes: content, stat: after }
  } catch (error) { failed = true; failure = error; throw error }
  finally {
    try { await file.close() } catch (error) {
      if (failed) throw new AggregateError([failure, error], 'Native install completion read and close failed', { cause: failure })
      throw error
    }
  }
}

type ReadOptions = { integration: InstallOptions; transaction: NativeInstallTransaction; acks: readonly NativeInstallTransactionAck[] }
type WriteOptions = ReadOptions & { completion: NativeInstallTransactionCompletion }

/** Read-only inspection bound to the exact prepared transaction. Missing completion is
 * undefined; missing/mismatched preparation or any acknowledgement refuses. No directory or SQLite writes.
 * Stored claims do not authenticate artifact observation or grant ownership.
 * Same-user mutation after checks or between separate binding reads cannot be
 * excluded by path checks; the cooperating-writer lock is not a security boundary. */
export async function readNativeInstallTransactionCompletion({ integration, transaction, acks }: ReadOptions): Promise<NativeInstallTransactionCompletion | undefined> {
  const bound = context(integration, transaction, acks)
  await requireBindings(bound)
  const stored = await readStored(bound)
  await requireBindings(bound)
  return stored?.completion
}

/** Exclusive publication under the shared installation lock. Failed writes are
 * retained and retries never overwrite. Only the file is synced: no directory
 * sync or power-loss durability, installation, cleanup or recovery is promised. */
export async function writeNativeInstallTransactionCompletion({ integration, transaction, acks, completion }: WriteOptions): Promise<NativeInstallTransactionCompletion> {
  const bound = context(integration, transaction, acks)
  const bytes = encodeNativeInstallTransactionCompletion(completion, bound.transaction, bound.integration, bound.acks)
  await requireBindings(bound)
  const preflight = await boundary(bound.directory)
  if (await statOrMissing(bound.path)) throw Object.assign(new Error('Native install completion already exists'), { code: 'EEXIST' })
  await verifyBoundary(bound.directory, preflight)
  return withNativeInstallLock({ controlDirectory: bound.directory }, lock =>
    runWithNativeInstallLockHeld(lock, bound.directory, () => writeExclusive(bound, bytes, lock)))
}

/** Call-time snapshots; registered work drains before the supplied scope closes. */
export function writeNativeInstallTransactionCompletionUnderLock({ integration, transaction, acks, completion, lock }: WriteOptions & { lock: NativeInstallLock }): Promise<NativeInstallTransactionCompletion> {
  const bound = context(integration, transaction, acks)
  assertNativeInstallLockHeld(lock, bound.directory)
  const bytes = encodeNativeInstallTransactionCompletion(completion, bound.transaction, bound.integration, bound.acks)
  return runWithNativeInstallLockHeld(lock, bound.directory, () => writeExclusive(bound, bytes, lock))
}

async function writeExclusive(bound: Context, bytes: Buffer, lock: NativeInstallLock): Promise<NativeInstallTransactionCompletion> {
  const { directory, path } = bound
  await requireBindings(bound)
  const ancestors = await boundary(directory)
  await assertNativeInstallPreparedWriteAllowed(bound.integration, lock)
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
    await requireBindings(bound)
    await assertNativeInstallPreparedWriteAllowed(bound.integration, lock)
    return stored.completion
  } catch (error) { failed = true; failure = error; throw error }
  finally {
    try { await file.close() } catch (error) {
      if (failed) throw new AggregateError([failure, error], 'Native install completion write and close failed', { cause: failure })
      throw error
    }
  }
}
