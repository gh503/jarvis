import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, renameSync, rmSync, symlinkSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { LocalToolSettings } from '../src/local-tools/settings.ts'
import { NativeFilesystem, nativeFilesystemExecutable } from '../src/local-tools/native-filesystem.ts'
import { nativeFileDefinitions } from '../src/local-tools/native-file-tools.ts'
import { FileTools } from '../src/local-tools/files.ts'

const nativePlatform: NodeJS.Platform = process.platform === 'win32' ? 'win32' : 'darwin'

async function fixture(t: TestContext) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'jarvis-native-files-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'read'), sibling = join(base, 'read-other'), privateDir = join(base, 'private'), output = join(base, 'output'), write = join(base, 'write')
  for (const dir of [root, sibling, privateDir, output, write]) mkdirSync(dir)
  const settings = new LocalToolSettings(join(privateDir, 'settings.json'), output)
  await settings.load()
  await settings.update({ expectedRevision: 0, readRoots: [root], ...(process.platform === 'linux' ? { writeRoots: [write] } : {}) })
  const definitions = () => nativeFileDefinitions({ settings }, nativePlatform)
  const defs = definitions()
  const run = (name: string, args: Record<string, unknown>, signal = t.signal) => defs.find(d => d.name === name)!.execute(args, { signal, sessionId: 's', turnId: 't', callId: 'c' })
  return { base, root, sibling, privateDir, output, write, settings, definitions, defs, run }
}
function requireHelper(t: TestContext): boolean {
  if (existsSync(nativeFilesystemExecutable())) return true
  assert.notEqual(process.env.JARVIS_NATIVE_HELPER_REQUIRED, '1', 'Native acceptance requires a built helper')
  t.skip('Build native helper before native acceptance'); return false
}

test('native file definitions preserve readonly schemas, read result and explicit authority', async t => {
  if (!requireHelper(t)) return
  const f = await fixture(t)
  const file = join(f.root, 'hello.txt'), content = 'hello λ\nsecond\nthird'
  writeFileSync(file, content)
  assert.deepEqual(f.defs.map(d => d.name), ['file_list', 'file_search', 'file_read'])
  for (const d of f.defs) { assert.equal(d.permission, 'allow'); assert.equal(d.effect, 'read'); assert.equal(d.destination, 'local') }
  assert.deepEqual(f.defs.map(d => d.definitionHash), f.definitions().map(d => d.definitionHash))
  const result = await f.run('file_read', { path: file, offset: 2, limit: 1 })
  assert.equal(result.isError, undefined, result.content)
  assert.deepEqual(JSON.parse(result.content), { path: file, content: 'second', offset: 2, endLine: 2, totalLines: 3, size: Buffer.byteLength(content), version: createHash('sha256').update(content).digest('hex') })
  for (const dir of [f.sibling, f.write, f.output, f.privateDir]) {
    writeFileSync(join(dir, 'ordinary.txt'), 'hidden value')
    assert.equal((await f.run('file_read', { path: join(dir, 'ordinary.txt') })).isError, true)
  }
  assert.equal((await f.run('file_read', { path: f.root + '/sub/../hello.txt' })).isError, true)
  assert.equal((await f.run('file_read', { path: file, offset: '1' })).isError, true)
  const listing = JSON.parse((await f.run('file_list', { path: f.root })).content)
  assert.deepEqual(listing.results, [{ path: file, type: 'file' }])
  assert.deepEqual(nativeFileDefinitions({ settings: f.settings }, 'freebsd'), [])
  assert.deepEqual(nativeFileDefinitions({ settings: f.settings }, 'linux'), [])
})

test('FileTools dispatch exposes only native readonly definitions', async t => {
  if (!requireHelper(t)) return
  const f = await fixture(t)
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { ...original, value: nativePlatform })
    const tools = new FileTools({ settings: f.settings })
    assert.equal(tools.capabilities().readSupported, true)
    assert.equal(tools.capabilities().writeSupported, false)
    assert.deepEqual(tools.definitions().map(d => d.name), ['file_list', 'file_search', 'file_read'])
    writeFileSync(join(f.root, 'file.txt'), 'native dispatch')
    const result = await tools.definitions().find(d => d.name === 'file_read')!.execute({ path: join(f.root, 'file.txt') }, { signal: t.signal, sessionId: 's', turnId: 't', callId: 'c' })
    assert.equal(JSON.parse(result.content).content, 'native dispatch')
  } finally { Object.defineProperty(process, 'platform', original) }
})

test('canonical private directories under symlink ancestors remain protected and identity-bound', async t => {
  if (!requireHelper(t)) return
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'jarvis-native-alias-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const actual = join(base, 'actual'), alias = join(base, 'alias'), output = join(base, 'output')
  mkdirSync(actual); mkdirSync(join(actual, 'private')); mkdirSync(output)
  symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(actual, 'private', 'notes.json'), 'PRIVATE_SENTINEL')
  writeFileSync(join(actual, 'public.txt'), 'public')
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { ...original, value: nativePlatform })
    const settings = new LocalToolSettings(join(alias, 'private', 'settings.json'), output)
    await settings.load()
    await settings.update({ expectedRevision: 0, readRoots: [actual] })
    const defs = nativeFileDefinitions({ settings }, nativePlatform)
    const run = (name: string, args: Record<string, unknown>) => defs.find(d => d.name === name)!.execute(args, { signal: t.signal, sessionId: 's', turnId: 't', callId: 'c' })
    const denied = await run('file_read', { path: join(actual, 'private', 'notes.json') })
    assert.equal(denied.isError, true); assert.ok(!denied.content.includes('PRIVATE_SENTINEL'))
    const search = await run('file_search', { path: actual, query: 'PRIVATE_SENTINEL', mode: 'contents', includeHidden: true })
    assert.equal(search.isError, undefined); assert.deepEqual(JSON.parse(search.content).results, [])
    const listing = await run('file_list', { path: actual, recursive: true, includeHidden: true })
    assert.deepEqual(JSON.parse(listing.content).results, [{ path: join(actual, 'public.txt'), type: 'file' }])
    const dispose = NativeFilesystem.prototype.disposeAsync
    t.mock.method(NativeFilesystem.prototype, 'disposeAsync', async function (this: NativeFilesystem) {
      await dispose.call(this)
      renameSync(join(actual, 'private'), join(actual, 'relocated'))
      mkdirSync(join(actual, 'private'))
    })
    const changed = await run('file_read', { path: join(actual, 'public.txt') })
    assert.equal(changed.isError, true); assert.match(changed.content, /Private directory changed/)
    assert.notEqual(defs[0]!.definitionHash, nativeFileDefinitions({ settings }, nativePlatform)[0]!.definitionHash)
  } finally { Object.defineProperty(process, 'platform', original) }
})

test('native helper excludes secret names, links, invalid text and private key contents', async t => {
  if (!requireHelper(t)) return
  const f = await fixture(t)
  for (const name of ['.env', '.npmrc', '.netrc', 'credentials.json', 'access-token.txt', 'id_ed25519', 'x.pem']) writeFileSync(join(f.root, name), 'needle')
  for (const name of ['.git', 'node_modules', '.aws']) { mkdirSync(join(f.root, name)); writeFileSync(join(f.root, name, 'ordinary.txt'), 'needle') }
  writeFileSync(join(f.root, 'ordinary.txt'), 'needle')
  writeFileSync(join(f.root, 'binary.txt'), Buffer.from([0, 110]))
  writeFileSync(join(f.root, 'invalid.txt'), Buffer.from([255]))
  writeFileSync(join(f.root, 'material.txt'), 'needle\n-----BEGIN OPENSSH PRIVATE KEY-----\nneedle')
  writeFileSync(join(f.root, 'oversized.txt'), Buffer.alloc(1024 * 1024 + 1, 65))
  writeFileSync(join(f.sibling, 'outside.txt'), 'needle outside')
  symlinkSync(f.sibling, join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  linkSync(join(f.sibling, 'outside.txt'), join(f.root, 'hard.txt'))
  for (const name of ['.env', '.npmrc', '.netrc', 'credentials.json', '.git/ordinary.txt', 'node_modules/ordinary.txt', 'binary.txt', 'invalid.txt', 'material.txt', 'oversized.txt', 'alias/outside.txt', 'hard.txt']) {
    assert.equal((await f.run('file_read', { path: join(f.root, name) })).isError, true, name)
  }
  const listing = JSON.parse((await f.run('file_list', { path: f.root, recursive: true, includeHidden: true })).content)
  assert.ok(!listing.results.some((r: { path: string }) => /\.env|\.npmrc|\.netrc|credentials|token|id_ed|\.pem|\.git|node_modules|\.aws|alias/.test(r.path)))
  const search = JSON.parse((await f.run('file_search', { path: f.root, query: 'needle', mode: 'contents', includeHidden: true })).content)
  assert.deepEqual(search.results, [{ path: join(f.root, 'ordinary.txt'), line: 1, text: 'needle' }])
})

test('definitions reject root replacement and symlink parents with changed hashes', async t => {
  if (!requireHelper(t)) return
  const f = await fixture(t)
  writeFileSync(join(f.root, 'file.txt'), 'before')
  const oldHash = f.defs[0]!.definitionHash
  renameSync(f.root, join(f.base, 'old-read')); mkdirSync(f.root)
  writeFileSync(join(f.root, 'file.txt'), 'replacement')
  assert.match((await f.run('file_read', { path: join(f.root, 'file.txt') })).content, /root changed/i)
  assert.notEqual(f.definitions()[0]!.definitionHash, oldHash)
  rmSync(f.root, { recursive: true }); symlinkSync(join(f.base, 'old-read'), f.root, process.platform === 'win32' ? 'junction' : 'dir')
  const defs = f.definitions()
  const result = await defs.find(d => d.name === 'file_read')!.execute({ path: join(f.root, 'file.txt') }, { signal: t.signal, sessionId: 's', turnId: 't', callId: 'c' })
  assert.equal(result.isError, true)
})

test('actual helper root handle rejects ABA registration before any read', async t => {
  if (!requireHelper(t)) return
  const f = await fixture(t), moved = join(f.base, 'moved'), replacement = join(f.base, 'replacement')
  mkdirSync(replacement); writeFileSync(join(f.root, 'file.txt'), 'trusted'); writeFileSync(join(replacement, 'file.txt'), 'attacker')
  const start = NativeFilesystem.start, read = NativeFilesystem.prototype.read
  let reads = 0, disposed = false
  t.mock.method(NativeFilesystem.prototype, 'read', async function (this: NativeFilesystem, ...args: Parameters<typeof read>) { reads++; return read.apply(this, args) })
  t.mock.method(NativeFilesystem, 'start', async (roots: string[], options: Parameters<typeof start>[1]) => {
    renameSync(f.root, moved); renameSync(replacement, f.root)
    const opened = await start.call(NativeFilesystem, roots, options)
    const dispose = opened.filesystem.disposeAsync.bind(opened.filesystem)
    t.mock.method(opened.filesystem, 'disposeAsync', async () => { await dispose(); disposed = true })
    if (process.platform === 'win32') {
      // Windows intentionally denies directory relocation while the helper pins it.
      // Verify the OS barrier; the post-init pathname identity check also rejects
      // this unreverted substitution, while POSIX exercises a completed ABA.
      assert.throws(() => renameSync(f.root, replacement))
    } else {
      renameSync(f.root, replacement); renameSync(moved, f.root)
    }
    return opened
  })
  const result = await f.run('file_read', { path: join(f.root, 'file.txt') })
  assert.equal(result.isError, true); assert.match(result.content, process.platform === 'win32' ? /Read root changed/ : /registration/); assert.equal(reads, 0); assert.equal(disposed, true)
})

test('settings revision and cancellation during native reads suppress content and dispose', async t => {
  if (!requireHelper(t)) return
  const f = await fixture(t); writeFileSync(join(f.root, 'file.txt'), 'do not release')
  const read = NativeFilesystem.prototype.read
  t.mock.method(NativeFilesystem.prototype, 'read', async function (this: NativeFilesystem, ...args: Parameters<typeof read>) {
    const data = await read.apply(this, args)
    await f.settings.update({ expectedRevision: f.settings.snapshot().revision, readRoots: [] })
    return data
  })
  const result = await f.run('file_read', { path: join(f.root, 'file.txt') })
  assert.equal(result.isError, true); assert.match(result.content, /settings changed/); assert.ok(!result.content.includes('do not release'))
  t.mock.restoreAll()
  const controller = new AbortController(); controller.abort()
  assert.equal((await f.run('file_list', { path: f.root }, controller.signal)).isError, true)
})

test('cancellation during actual helper read prevents content release and disposes', async t => {
  if (!requireHelper(t)) return
  const f = await fixture(t); writeFileSync(join(f.root, 'file.txt'), 'do not release')
  const controller = new AbortController(), read = NativeFilesystem.prototype.read, dispose = NativeFilesystem.prototype.disposeAsync
  let disposed = false
  t.mock.method(NativeFilesystem.prototype, 'read', async function (this: NativeFilesystem, ...args: Parameters<typeof read>) {
    const data = await read.apply(this, args); controller.abort(); return data
  })
  t.mock.method(NativeFilesystem.prototype, 'disposeAsync', async function (this: NativeFilesystem) { await dispose.call(this); disposed = true })
  const result = await f.run('file_read', { path: join(f.root, 'file.txt') }, controller.signal)
  assert.equal(result.isError, true); assert.ok(!result.content.includes('do not release')); assert.equal(disposed, true)
})

test('settings change during teardown cannot release successful content', async t => {
  if (!requireHelper(t)) return
  const f = await fixture(t); writeFileSync(join(f.root, 'file.txt'), 'do not release')
  const dispose = NativeFilesystem.prototype.disposeAsync
  t.mock.method(NativeFilesystem.prototype, 'disposeAsync', async function (this: NativeFilesystem) {
    await dispose.call(this)
    await f.settings.update({ expectedRevision: f.settings.snapshot().revision, readRoots: [] })
  })
  const result = await f.run('file_read', { path: join(f.root, 'file.txt') })
  assert.equal(result.isError, true); assert.match(result.content, /settings changed/)
})

test('native search bounds directory enumeration, matches, depth and bytes', async t => {
  if (!requireHelper(t)) return
  const f = await fixture(t)
  for (let i = 0; i < 1005; i++) writeFileSync(join(f.root, `entry-${i}.txt`), 'needle')
  const names = JSON.parse((await f.run('file_search', { path: f.root, query: 'entry-' })).content)
  assert.equal(names.truncated, true); assert.equal(names.filesScanned, 1000); assert.equal(names.results.length, 1000)
  const deep = join(f.sibling, 'deep'); mkdirSync(deep)
  await f.settings.update({ expectedRevision: f.settings.snapshot().revision, readRoots: [deep] })
  const run = (args: Record<string, unknown>) => f.definitions().find(d => d.name === 'file_search')!.execute(args, { signal: t.signal, sessionId: 's', turnId: 't', callId: 'c' })
  let dir = deep
  for (let i = 0; i < 10; i++) { dir = join(dir, 'nested'); mkdirSync(dir) }
  writeFileSync(join(dir, 'needle.txt'), 'needle')
  const depth = JSON.parse((await run({ path: deep, query: 'needle' })).content)
  assert.equal(depth.truncated, true); assert.deepEqual(depth.results, [])
  writeFileSync(join(deep, 'many.txt'), 'needle\n'.repeat(2100))
  const matches = JSON.parse((await run({ path: deep, query: 'needle', mode: 'contents' })).content)
  assert.equal(matches.truncated, true); assert.equal(matches.results.length, 2000)
  for (let i = 0; i < 10; i++) writeFileSync(join(deep, `large-${i}.txt`), 'x'.repeat(1024 * 1024))
  const bytes = JSON.parse((await run({ path: deep, query: 'absent', mode: 'contents' })).content)
  assert.equal(bytes.truncated, true); assert.ok(bytes.bytesScanned <= 8 * 1024 * 1024)
})
