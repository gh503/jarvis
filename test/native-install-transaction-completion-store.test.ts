import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { describeNativeIntegration, renderNativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { createNativeInstallTransaction, encodeNativeInstallTransaction } from '../scripts/native-install-transaction.ts'
import { writeNativeInstallTransaction } from '../scripts/native-install-transaction-store.ts'
import { withNativeInstallLock, type NativeInstallLock } from '../scripts/native-install-lock.ts'
import { createNativeInstallTransactionAck, encodeNativeInstallTransactionAck } from '../scripts/native-install-transaction-ack.ts'
import { writeNativeInstallTransactionAck } from '../scripts/native-install-transaction-ack-store.ts'
import { createNativeInstallTransactionCompletion, encodeNativeInstallTransactionCompletion, NATIVE_INSTALL_TRANSACTION_COMPLETION_MAX_BYTES } from '../scripts/native-install-transaction-completion.ts'
import { readNativeInstallTransactionCompletion, writeNativeInstallTransactionCompletion, writeNativeInstallTransactionCompletionUnderLock } from '../scripts/native-install-transaction-completion-store.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'
import { isPublicFile } from '../scripts/packaging.ts'

async function fixture(t: test.TestContext, platform: 'darwin' | 'win32' = 'darwin') {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'transaction-store-'))
  t.after(async () => { assert.ok(root.startsWith(join(await fs.realpath(tmpdir()), 'transaction-store-'))); await fs.rm(root, { recursive: true, force: true }) })
  const integration: InstallOptions = { platform, root: join(root, 'new-package'), home: join(root, 'home'), appData: join(root, 'roaming'), localAppData: join(root, 'local'), arch: process.arch }
  const layout = describeNativeIntegration(integration)
  const directory = join(dirname(layout.receiptPath), 'native-install-control')
  const transactionPath = join(directory, 'prepared-transaction.json')
  const path = join(directory, 'prepared-completion.json')
  const binding = { root: integration.root, autostart: false, configFile: join(root, 'source.env'), dataDir: join(root, 'data') }
  const plan = renderNativeIntegration(integration, false, binding.configFile)
  const artifacts = plan.platform === 'darwin' ? plan.artifacts : plan.shortcuts.map(item => ({ path: item.path, bytes: Buffer.from([0, 255, 5, 10]), mode: 0o600 }))
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, platform, ...binding, ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files: artifacts.map(item => ({ path: item.path, sha256: createHash('sha256').update(item.bytes).digest('hex') })) }, null, 2) + '\n')
  const transaction = createNativeInstallTransaction({ integration, artifacts, receipt, transactionId: randomUUID() })
  const acks = artifacts.map((artifact, artifactIndex) => createNativeInstallTransactionAck({ integration, transaction, artifactIndex, observation: { bytes: artifact.bytes, identity: { dev: '0', ino: String(123 + artifactIndex), mode: String(0o100600), nlink: '1', uid: '1000', gid: '1000', rdev: '0', size: String(artifact.bytes.length), mtimeNs: '0', ctimeNs: '0', birthtimeNs: '0' } } }))
  const completion = createNativeInstallTransactionCompletion({ integration, transaction, acks, observation: { bytes: receipt, identity: { ...acks[0]!.identity, size: String(receipt.length) } } })
  return { root, integration, transaction, acks, completion, directory, path, transactionPath, ...layout }

}
async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
  await writeNativeInstallTransaction(f)
  for (const ack of f.acks) await writeNativeInstallTransactionAck({ ...f, ack })
}
async function snapshot(path: string): Promise<unknown> {
  const stat = await fs.lstat(path, { bigint: true })
  const metadata = { ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid, nlink: stat.nlink, size: stat.size, mtime: stat.mtimeNs, ctime: stat.ctimeNs }
  return stat.isDirectory() ? { metadata, children: await Promise.all((await fs.readdir(path)).sort().map(async name => [name, await snapshot(join(path, name))])) } : { metadata, bytes: await fs.readFile(path) }
}
for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: missing preparation refuses without writes; exclusive roundtrip and inert reads`, async t => {
    const f = await fixture(t, platform), before = await snapshot(f.root)
    await assert.rejects(readNativeInstallTransactionCompletion(f), /Missing or mismatched/)
    await assert.rejects(writeNativeInstallTransactionCompletion(f), /Missing or mismatched/)
    assert.deepEqual(await snapshot(f.root), before)
    await prepare(f)
    const prepared = await snapshot(f.root)
    assert.equal(await readNativeInstallTransactionCompletion(f), undefined)
    assert.deepEqual(await snapshot(f.root), prepared)
    const mismatch = { ...f, transaction: { ...f.transaction, transactionId: randomUUID() } }
    await assert.rejects(readNativeInstallTransactionCompletion(mismatch))
    assert.deepEqual(await snapshot(f.root), prepared)
    assert.deepEqual(await writeNativeInstallTransactionCompletion(f), f.completion)
    assert.deepEqual(await fs.readFile(f.path), encodeNativeInstallTransactionCompletion(f.completion, f.transaction, f.integration, f.acks))
    const published = await snapshot(f.root)
    assert.deepEqual(await readNativeInstallTransactionCompletion(f), f.completion)
    await assert.rejects(writeNativeInstallTransactionCompletion(f), { code: 'EEXIST' })
    assert.deepEqual(await snapshot(f.root), published)
    await fs.writeFile(f.transactionPath, encodeNativeInstallTransaction(mismatch.transaction, f.integration))
    await assert.rejects(readNativeInstallTransactionCompletion(f), /Missing or mismatched/)
    await assert.rejects(writeNativeInstallTransactionCompletion(f), /Missing or mismatched/)
    for (const path of [f.receiptPath, ...f.artifactPaths]) await assert.rejects(fs.lstat(path), { code: 'ENOENT' })
  })
}
for (const kind of ['invalid', 'noncanonical', 'oversized', 'directory', 'symlink', 'hardlink', 'fifo', 'mode'] as const) test(`unsafe completion ${kind} refuses without overwrite`, { skip: process.platform === 'win32' && ['fifo', 'symlink', 'mode'].includes(kind) }, async t => {
  const f = await fixture(t)
  await prepare(f)
  const bytes = encodeNativeInstallTransactionCompletion(f.completion, f.transaction, f.integration, f.acks)
  if (kind === 'directory') await fs.mkdir(f.path, { mode: 0o700 })
  else if (kind === 'fifo') execFileSync('mkfifo', ['-m', '600', f.path])
  else if (kind === 'symlink' || kind === 'hardlink') {
    const target = join(f.root, 'target')
    await fs.writeFile(target, bytes, { mode: 0o600 })
    if (kind === 'symlink') await fs.symlink(target, f.path)
    else await fs.link(target, f.path)
  } else {
    await fs.writeFile(f.path, kind === 'invalid' ? '{' : kind === 'noncanonical' ? JSON.stringify(f.completion, null, 2) + '\n' : kind === 'mode' ? bytes : Buffer.alloc(NATIVE_INSTALL_TRANSACTION_COMPLETION_MAX_BYTES + 1), { mode: 0o600 })
    if (kind === 'mode') await fs.chmod(f.path, 0o644)
  }
  const before = await fs.lstat(f.path, { bigint: true })
  await assert.rejects(readNativeInstallTransactionCompletion(f))
  await assert.rejects(writeNativeInstallTransactionCompletion(f), { code: 'EEXIST' })
  const after = await fs.lstat(f.path, { bigint: true })
  for (const key of ['ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[key])
})
for (const composed of [false, true]) test(`call-time snapshots, composed=${composed}`, async t => {
  const f = await fixture(t)
  await prepare(f)
  f.transaction = structuredClone(f.transaction); f.completion = structuredClone(f.completion); f.acks = structuredClone(f.acks)
  const expected = structuredClone(f.completion), integration = { ...f.integration }, transaction = structuredClone(f.transaction), acks = structuredClone(f.acks)
  const mutate = () => { Object.assign(f.completion.receipt.identity, { ino: '999' }); Object.assign(f.acks[0]!.identity, { ino: '999' }); Object.assign(f.transaction, { transactionId: randomUUID() }); f.integration.home = join(f.root, 'other') }
  if (composed) await withNativeInstallLock({ controlDirectory: f.directory }, async lock => {
    const pending = writeNativeInstallTransactionCompletionUnderLock({ ...f, lock }); mutate(); assert.deepEqual(await pending, expected)
  })
  else { const pending = writeNativeInstallTransactionCompletion(f); mutate(); assert.deepEqual(await pending, expected) }
  assert.deepEqual(await readNativeInstallTransactionCompletion({ integration, transaction, acks }), expected)
})
test('forged, wrong and expired lock refuse without completion writes', async t => {
  const f = await fixture(t), other = await fixture(t)
  await prepare(f)
  assert.throws(() => writeNativeInstallTransactionCompletionUnderLock({ ...f, lock: {} as NativeInstallLock }), /capability/)
  let saved!: NativeInstallLock
  await withNativeInstallLock({ controlDirectory: other.directory }, async lock => {
    assert.throws(() => writeNativeInstallTransactionCompletionUnderLock({ ...f, lock }), /capability/)
  })
  await withNativeInstallLock({ controlDirectory: f.directory }, async lock => { saved = lock })
  assert.throws(() => writeNativeInstallTransactionCompletionUnderLock({ ...f, lock: saved }), /capability/)
  await assert.rejects(fs.lstat(f.path), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(f.transactionPath), encodeNativeInstallTransaction(f.transaction, f.integration))
})
for (const failure of ['partial', 'sync', 'readback', 'transaction'] as const) test(`${failure} publication failure retains exclusive completion`, async t => {
  const f = await fixture(t), original = fs.open
  await prepare(f)
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[0] === f.path && ((args[1] as number) & constants.O_CREAT) !== 0) {
      if (failure === 'partial') handle.writeFile = async () => { await handle.write(Buffer.from('{')); throw new Error('injected partial') }
      else {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          if (failure === 'sync') throw new Error('injected sync')
          await sync()
          if (failure === 'readback') await handle.write(Buffer.from('!'), 0, 1, 0)
          else await fs.writeFile(f.transactionPath, encodeNativeInstallTransaction({ ...f.transaction, transactionId: randomUUID() }, f.integration))
        }
      }
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try { await assert.rejects(writeNativeInstallTransactionCompletion(f), /injected|Unsafe|Missing or mismatched/) }
  finally { fs.open = original; syncBuiltinESMExports() }
  assert.ok((await fs.lstat(f.path)).isFile())
  if (failure === 'sync') assert.deepEqual(await readNativeInstallTransactionCompletion(f), f.completion)
  else await assert.rejects(readNativeInstallTransactionCompletion(f))
  await assert.rejects(writeNativeInstallTransactionCompletion(f))
})
test('transaction mutation during completion read refuses', async t => {
  const f = await fixture(t), original = fs.open
  await prepare(f); await writeNativeInstallTransactionCompletion(f)
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[0] === f.path) await fs.writeFile(f.transactionPath, encodeNativeInstallTransaction({ ...f.transaction, transactionId: randomUUID() }, f.integration))
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try { await assert.rejects(readNativeInstallTransactionCompletion(f), /Missing or mismatched/) }
  finally { fs.open = original; syncBuiltinESMExports() }
})
test('unawaited publication drains and closing scope refuses new work', async t => {
  const f = await fixture(t), original = fs.open
  await prepare(f)
  let unblock!: () => void, entered!: () => void, saved!: NativeInstallLock, completed = false
  const gate = new Promise<void>(resolve => { unblock = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === f.path && ((args[1] as number) & constants.O_CREAT) !== 0) { entered(); await gate }
    return original(...args)
  }) as typeof fs.open
  syncBuiltinESMExports()
  const pending = withNativeInstallLock({ controlDirectory: f.directory }, async lock => {
    saved = lock; void writeNativeInstallTransactionCompletionUnderLock({ ...f, lock })
  }).then(() => { completed = true })
  try {
    await started
    assert.equal(completed, false)
    assert.throws(() => writeNativeInstallTransactionCompletionUnderLock({ ...f, lock: saved }), /scope is closing/)
    await assert.rejects(withNativeInstallLock({ controlDirectory: f.directory }, async () => {}), /Another launcher/)
  } finally { unblock(); try { await pending } finally { fs.open = original; syncBuiltinESMExports() } }
  assert.equal(completed, true)
  assert.deepEqual(await readNativeInstallTransactionCompletion(f), f.completion)
})
test('invalid acknowledgement arrays refuse without directory creation; packaging includes runtime only', async t => {
  const f = await fixture(t), before = await snapshot(f.root)
  for (const acks of [[], [...f.acks].reverse(), [f.acks[0]!, f.acks[0]!], new Array(f.acks.length)]) {
    await assert.rejects(readNativeInstallTransactionCompletion({ ...f, acks }))
  }
  assert.deepEqual(await snapshot(f.root), before)
  assert.equal(isPublicFile('scripts/native-install-transaction-completion-store.ts'), true)
  assert.equal(isPublicFile('test/native-install-transaction-completion-store.test.ts'), false)
})
for (const change of ['sibling', 'child', 'parent-mode', 'parent-inode'] as const) test(`reader handles ${change} during descriptor read`, { skip: process.platform === 'win32' && change.startsWith('parent-') }, async t => {
  const f = await fixture(t)
  await prepare(f); await writeNativeInstallTransactionCompletion(f)
  const parent = dirname(f.directory), original = fs.open
  const before = await fs.lstat(parent, { bigint: true })
  let changed = false
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[0] === f.path) {
      const read = handle.read.bind(handle)
      handle.read = (async (...readArgs: unknown[]) => {
        const result = await (read as (...args: unknown[]) => Promise<unknown>)(...readArgs)
        if (!changed) {
          changed = true
          if (change === 'sibling' || change === 'child') {
            await fs.mkdir(join(change === 'sibling' ? parent : f.directory, 'unrelated-child'), { mode: 0o700 })
          } else if (change === 'parent-mode') {
            // Both modes pass ancestor policy; the snapshot must still detect change.
            await fs.chmod(parent, (before.mode & 0o777n) === 0o700n ? 0o750 : 0o700)
          } else {
            const moved = join(dirname(parent), 'moved-parent')
            assert.ok(parent.startsWith(f.root + '/'))
            assert.equal(dirname(moved), dirname(parent))
            await fs.rename(parent, moved)
            await fs.mkdir(parent, { mode: Number(before.mode & 0o777n) })
            // Keep the control directory and source file identities unchanged:
            // only the containing parent's inode has been replaced.
            const movedControl = join(moved, 'native-install-control')
            assert.equal(dirname(f.directory), parent)
            assert.equal(dirname(movedControl), moved)
            await fs.rename(movedControl, f.directory)
          }
        }
        return result
      }) as typeof handle.read
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try {
    if (change === 'sibling' || change === 'child') assert.deepEqual(await readNativeInstallTransactionCompletion(f), f.completion)
    else await assert.rejects(readNativeInstallTransactionCompletion(f), /Unsafe/)
    assert.ok(changed)
  } finally { fs.open = original; syncBuiltinESMExports() }
})
for (const race of ['replace', 'hardlink', 'grow', 'ancestor'] as const) test(`reader rejects ${race} during descriptor read`, { skip: process.platform === 'win32' && ['replace', 'ancestor'].includes(race) }, async t => {
  const f = await fixture(t)
  await prepare(f); await writeNativeInstallTransactionCompletion(f)
  const original = fs.open
  let changed = false
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[0] === f.path) {
      const read = handle.read.bind(handle)
      handle.read = (async (...readArgs: unknown[]) => {
        const result = await (read as (...args: unknown[]) => Promise<unknown>)(...readArgs)
        if (!changed) {
          changed = true
          if (race === 'replace') {
            const target = join(f.root, 'replacement')
            await fs.writeFile(target, encodeNativeInstallTransactionCompletion(f.completion, f.transaction, f.integration, f.acks), { mode: 0o600 })
            // Both absolute paths are fixture-owned, checked before replacement.
            assert.equal(dirname(f.path), f.directory)
            await fs.rename(target, f.path)
          } else if (race === 'hardlink') await fs.link(f.path, join(f.root, 'extra-link'))
          else if (race === 'grow') await fs.appendFile(f.path, 'x')
          else {
            const moved = join(dirname(f.directory), 'moved-control')
            assert.equal(dirname(moved), dirname(f.directory))
            await fs.rename(f.directory, moved)
            await fs.mkdir(f.directory, { mode: 0o700 })
            await fs.writeFile(f.path, encodeNativeInstallTransactionCompletion(f.completion, f.transaction, f.integration, f.acks), { mode: 0o600 })
          }
        }
        return result
      }) as typeof handle.read
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try { await assert.rejects(readNativeInstallTransactionCompletion(f), /Unsafe/); assert.ok(changed) } finally { fs.open = original; syncBuiltinESMExports() }
})

for (const platform of ['darwin', 'win32'] as const) for (const published of [false, true]) for (const change of ['missing', 'mismatch'] as const) test(`${platform}: every acknowledgement binding ${change}, published=${published}`, async t => {
  const f = await fixture(t, platform)
  await prepare(f)
  if (published) await writeNativeInstallTransactionCompletion(f)
  for (const ack of f.acks) {
    const path = join(f.directory, `prepared-artifact-${ack.artifactIndex}.json`)
    const bytes = encodeNativeInstallTransactionAck(ack, f.transaction, f.integration)
    if (change === 'missing') { assert.equal(dirname(path), f.directory); await fs.unlink(path) }
    else await fs.writeFile(path, encodeNativeInstallTransactionAck({ ...ack, identity: { ...ack.identity, ino: '9999' } }, f.transaction, f.integration))
    const before = await snapshot(f.root)
    await assert.rejects(readNativeInstallTransactionCompletion(f), /Missing or mismatched/)
    await assert.rejects(writeNativeInstallTransactionCompletion(f), /Missing or mismatched/)
    assert.deepEqual(await snapshot(f.root), before)
    await fs.writeFile(path, bytes, { mode: 0o600 })
  }
})
for (const operation of ['read', 'write'] as const) for (const doubleFailure of [false, true]) test(`${operation} close failure propagates and retains completion, double=${doubleFailure}`, async t => {
  const f = await fixture(t), original = fs.open
  await prepare(f)
  if (operation === 'read') await writeNativeInstallTransactionCompletion(f)
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[0] === f.path && (operation === 'read' || ((args[1] as number) & constants.O_CREAT) !== 0)) {
      const close = handle.close.bind(handle)
      handle.close = async () => { await close(); throw new Error('injected close') }
      if (doubleFailure) {
        if (operation === 'write') handle.sync = async () => { throw new Error('injected sync') }
        else handle.read = (async () => { throw new Error('injected read') }) as typeof handle.read
      }
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try {
    await assert.rejects(operation === 'read' ? readNativeInstallTransactionCompletion(f) : writeNativeInstallTransactionCompletion(f), error => {
      if (doubleFailure) { assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2) }
      else assert.match(String(error), /injected close/)
      return true
    })
  } finally { fs.open = original; syncBuiltinESMExports() }
  assert.deepEqual(await readNativeInstallTransactionCompletion(f), f.completion)
  await assert.rejects(writeNativeInstallTransactionCompletion(f), { code: 'EEXIST' })
})
for (const operation of ['read', 'write'] as const) test(`acknowledgement changes during completion ${operation} refuse`, async t => {
  const f = await fixture(t), original = fs.open
  await prepare(f)
  if (operation === 'read') await writeNativeInstallTransactionCompletion(f)
  let changed = false
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args)
    if (args[0] === f.path && !changed) {
      changed = true
      const ack = f.acks.at(-1)!
      await fs.writeFile(join(f.directory, `prepared-artifact-${ack.artifactIndex}.json`), encodeNativeInstallTransactionAck({ ...ack, identity: { ...ack.identity, ino: '9999' } }, f.transaction, f.integration))
    }
    return handle
  }) as typeof fs.open
  syncBuiltinESMExports()
  try { await assert.rejects(operation === 'read' ? readNativeInstallTransactionCompletion(f) : writeNativeInstallTransactionCompletion(f), /Missing or mismatched/) }
  finally { fs.open = original; syncBuiltinESMExports() }
  assert.equal(changed, true)
  assert.ok((await fs.lstat(f.path)).isFile())
})
test('read snapshots all caller inputs before first await', async t => {
  const f = await fixture(t)
  await prepare(f); await writeNativeInstallTransactionCompletion(f)
  f.transaction = structuredClone(f.transaction); f.acks = structuredClone(f.acks)
  const pending = readNativeInstallTransactionCompletion(f)
  Object.assign(f.acks[0]!.identity, { ino: '999' })
  Object.assign(f.transaction, { transactionId: randomUUID() })
  f.integration.home = join(f.root, 'other')
  assert.deepEqual(await pending, f.completion)
})
