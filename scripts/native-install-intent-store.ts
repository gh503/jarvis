import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describeNativeIntegration, type InstallOptions } from './install-native.ts'
import { decodeNativeInstallIntent, encodeNativeInstallIntent, NATIVE_INSTALL_INTENT_MAX_BYTES, type NativeInstallIntent } from './native-install-intent.ts'
import { verifyNativeInstallPrivatePath, verifyNativeInstallAncestors, withNativeInstallLock } from './native-install-lock.ts'

const unsafe = () => new Error('Unsafe native install intent store')
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink
const sameFile = (a: BigIntStats, b: BigIntStats) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
function checkFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(NATIVE_INSTALL_INTENT_MAX_BYTES)) throw unsafe()
  if (process.platform !== 'win32' && (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o7777n) !== 0o600n)) throw unsafe()
}
async function statOrMissing(path: string): Promise<BigIntStats | undefined> {
  try { return await lstat(path, { bigint: true }) } catch (error) { if (missing(error)) return undefined; throw error }
}
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
    if (entry.stat ? !after || !sameIdentity(entry.stat, after) : after !== undefined) throw unsafe()
  }
  if (await verifyNativeInstallPrivatePath(directory, true) !== (before[0]!.stat !== undefined)) throw unsafe()
}
function location(integration: InstallOptions) {
  const directory = join(dirname(describeNativeIntegration(integration).receiptPath), 'native-install-control')
  return { directory, path: join(directory, 'install-intent.json') }
}
async function readStored(integration: InstallOptions, expectedIdentity?: BigIntStats) {
  const { directory, path } = location(integration)
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
    const bytes = Buffer.alloc(NATIVE_INSTALL_INTENT_MAX_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > NATIVE_INSTALL_INTENT_MAX_BYTES || BigInt(length) !== initial.size) throw unsafe()
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
    return { intent: decodeNativeInstallIntent(content, integration), bytes: content, stat: after }
  } catch (error) { failed = true; failure = error; throw error }
  finally {
    try { await file.close() } catch (error) {
      if (failed) throw new AggregateError([failure, error], 'Native install intent read and close failed', { cause: failure })
      throw error
    }
  }
}

/** Read-only inspection: no lock acquisition, directory creation, ACL repair or
 * SQLite access. Presence is a plan, never evidence of installation completion. */
export async function readNativeInstallIntent({ integration }: { integration: InstallOptions }): Promise<NativeInstallIntent | undefined> {
  return (await readStored({ ...integration }))?.intent
}

/** Append-once plan publication under the shared installation lock. An existing
 * name always refuses publication. Failed writes/syncs retain the file, even if
 * its bytes happen to be valid JSON; failure is never acknowledged as success.
 * No overwrite, cleanup, execution or ownership authority is provided here. */
export async function writeNativeInstallIntent({ integration, intent }: { integration: InstallOptions; intent: NativeInstallIntent }): Promise<NativeInstallIntent> {
  const options = { ...integration }
  const bytes = encodeNativeInstallIntent(intent, options)
  const { directory, path } = location(options)
  const preflight = await boundary(directory)
  if (await statOrMissing(path)) throw Object.assign(new Error('Native install intent already exists'), { code: 'EEXIST' })
  await verifyBoundary(directory, preflight)
  return withNativeInstallLock({ controlDirectory: directory }, async () => {
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
      const stored = await readStored(options, created)
      if (!stored || !stored.bytes.equals(bytes) || !sameFile(written, stored.stat)) throw unsafe()
      await verifyBoundary(directory, ancestors)
      return stored.intent
    } catch (error) { failed = true; failure = error; throw error }
    finally {
      try { await file.close() } catch (error) {
        if (failed) throw new AggregateError([failure, error], 'Native install intent write and close failed', { cause: failure })
        throw error
      }
    }
  })
}
