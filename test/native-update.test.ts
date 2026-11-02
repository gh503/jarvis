import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp, copyFile, readdir, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { health, rollback, stage, verifyBundle } from '../scripts/update-native.ts'
import { acquireRuntimeLifecycle } from '../src/runtime-lifecycle.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
async function fixture(run: (root: string, old: string, next: string, oldHash: string, nextHash: string) => Promise<void>) {
  const temporaryRoot = await realpath(tmpdir())
  const root = await mkdtemp(join(temporaryRoot, 'jarvis-update-test-'))
  await ensurePrivateDataDirectory(root)
  const bundle = async (name: string, version: string) => {
    const path = join(root, name); await mkdir(path)
    const files = []
    for (const file of [`runtime/${process.platform === 'win32' ? 'node.exe' : 'node'}`, 'src/main.ts', 'scripts/app.ts', 'scripts/install-native.ts']) {
      await mkdir(dirname(join(path, file)), { recursive: true }); await writeFile(join(path, file), 'fixture')
      files.push({ path: file, bytes: 7, sha256: digest('fixture') })
    }
    const text = JSON.stringify({ schemaVersion: 1, version, sourceTag: `v${version}`, sourceSha: 'a'.repeat(40), dirty: false, platform: process.platform, arch: process.arch, runtime: { version: process.version, platform: process.platform, arch: process.arch }, files })
    await writeFile(join(path, 'manifest.json'), text)
    return { path, hash: digest(text) }
  }
  try { const old = await bundle('old', '1.0.0'), next = await bundle('new', '1.0.1'); await run(root, old.path, next.path, old.hash, next.hash) }
  finally { // root is exclusively created by mkdtemp above; no production paths enter cleanup.
    assert.equal(dirname(root), temporaryRoot); await rm(root, { recursive: true, force: true })
  }
}
async function refreshManifest(root: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  manifest.files = []
  async function inventory(directory: string, prefix = ''): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), relative = prefix + name
      if (relative === 'manifest.json') continue
      if ((await stat(path)).isDirectory()) await inventory(path, relative + '/')
      else { const bytes = await readFile(path); manifest.files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) }) }
    }
  }
  await inventory(root)
  const text = JSON.stringify(manifest); await writeFile(join(root, 'manifest.json'), text)
  return digest(text)
}

// A real portable Node child using the shipped authenticated IPC and manifest version reader.
async function childCandidate(root: string, mode: 'healthy' | 'wrong-version' | 'nonzero' | 'signal' | 'redirect' | 'oversized' | 'invalid-json' | 'wrong-source' | 'wrong-manifest' | 'missing-build'): Promise<string> {
  const source = dirname(dirname(fileURLToPath(import.meta.url)))
  for (const name of ['runtime-lifecycle.ts', 'private-directory.ts', 'version.ts']) await copyFile(join(source, 'src', name), join(root, 'src', name))
  await copyFile(process.execPath, join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'))
  await readFile(join(root, 'src/main.ts'))
  await writeFile(join(root, 'src/main.ts'), `
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireRuntimeLifecycle } from './runtime-lifecycle.ts'
import { runtimeVersion, runtimeBuildIdentity } from './version.ts'
const mode = ${JSON.stringify(mode)}
const data = process.env.JARVIS_DATA_DIR
assert.equal(process.cwd(), data)
assert.notEqual(data, process.env.HOME)
assert.notEqual(data, process.env.TMPDIR)
assert.equal(process.env.JARVIS_OLLAMA_URL, 'http://127.0.0.1:1')
assert.match(process.env.JARVIS_AUTH_TOKEN, /^[a-f0-9]{64}$/)
const lifecycle = await acquireRuntimeLifecycle(data)
const server = createServer((req, res) => {
  if (req.url !== '/api/health' || req.headers.authorization !== 'Bearer ' + process.env.JARVIS_AUTH_TOKEN) { res.writeHead(401); res.end(); return }
  if (mode === 'redirect') { res.writeHead(302, { location: '/redirect-target' }); res.end(); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  if (mode === 'oversized') { res.end(' '.repeat(64 * 1024 + 1)); return }
  if (mode === 'invalid-json') { res.end('secret-diagnostic-' + process.env.JARVIS_AUTH_TOKEN); return }
  const build = runtimeBuildIdentity()
  if (mode === 'wrong-source') build.sourceSha = 'b'.repeat(40)
  if (mode === 'wrong-manifest') build.manifestSha256 = 'b'.repeat(64)
  res.end(JSON.stringify({ ok: true, version: mode === 'wrong-version' ? '9.9.9' : runtimeVersion(), build: mode === 'missing-build' ? undefined : build }))
})
await new Promise(resolve => server.listen(Number(process.env.JARVIS_PORT), '127.0.0.1', resolve))
lifecycle.onShutdown(async () => {
  await writeFile(join(data, 'authenticated-shutdown'), 'acknowledged')
  await new Promise(resolve => server.close(resolve))
  await lifecycle.close()
  if (mode === 'signal') process.kill(process.pid, 'SIGTERM')
  process.exitCode = mode === 'nonzero' ? 23 : 0
})
lifecycle.setReady('http://127.0.0.1:' + process.env.JARVIS_PORT + '/')
`)
  return refreshManifest(root)
}
for (const mode of ['healthy', 'wrong-version', 'nonzero', 'signal', 'redirect', 'oversized', 'invalid-json', 'wrong-source', 'wrong-manifest', 'missing-build'] as const) {
  test(`real portable candidate health: ${mode}`, { timeout: 30_000 }, async () => fixture(async (root, old, next, oldHash) => {
    const nextHash = await childCandidate(next, mode)
    const transaction = join(root, 'child-transaction')
    await stage(transaction, old, oldHash, next, nextHash)
    if (mode === 'healthy') assert.equal((await health(transaction)).status, 'healthy')
    else {
      const expected = { 'wrong-version': /HTTP health version mismatch/, redirect: /fetch failed/, nonzero: /shutdown failed/, signal: /shutdown failed/, oversized: /body exceeds limit/, 'invalid-json': /health JSON invalid/, 'wrong-source': /build identity mismatch/, 'wrong-manifest': /build identity mismatch/, 'missing-build': /build identity mismatch/ }
      await assert.rejects(health(transaction), expected[mode])
      const journal = await readFile(join(transaction, 'journal.json'), 'utf8')
      assert.equal(JSON.parse(journal).status, 'failed')
      assert.doesNotMatch(journal, /secret-diagnostic/)
    }
    if (['healthy', 'nonzero', 'signal'].includes(mode)) assert.equal(await readFile(join(transaction, 'health-data/authenticated-shutdown'), 'utf8'), 'acknowledged')
    assert.equal((await rollback(transaction)).status, 'rolled-back')
    assert.equal((await verifyBundle(next, nextHash)).version, '1.0.1')
    assert.equal((await verifyBundle(old, oldHash)).version, '1.0.0')
  }))
}

test('real packaged candidate starts with separate home and data and shuts down', { timeout: 120_000 }, async () => fixture(async (root, old, next, oldHash) => {
  const source = dirname(dirname(fileURLToPath(import.meta.url)))
  // Real application and runtime, copied into a fully hashed portable layout. No symlink to the checkout.
  for (const directory of ['src', 'web', 'node_modules']) await cp(join(source, directory), join(next, directory), { recursive: true, dereference: true })
  await copyFile(join(source, 'package.json'), join(next, 'package.json'))
  await copyFile(process.execPath, join(next, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'))
  const nextHash = await refreshManifest(next)
  // POSIX IPC must work even when the transaction exceeds sockaddr_un's path budget.
  const deep = process.platform === 'win32' ? root : join(root, 'deep-transaction-parent-'.repeat(5))
  if (deep !== root) await mkdir(deep)
  const transaction = join(deep, 'real-transaction')
  await stage(transaction, old, oldHash, next, nextHash)
  assert.equal((await health(transaction)).status, 'healthy')
  assert.equal((await rollback(transaction)).status, 'rolled-back')
  assert.ok((await stat(join(transaction, 'health-home'))).isDirectory())
  assert.ok((await stat(join(transaction, 'health-data'))).isDirectory())
}))
test('staging pins exact baseline/candidate and failed health rolls back without modifying bundles', async () => fixture(async (root, old, next, oldHash, nextHash) => {
  const transaction = join(root, 'transaction')
  const original = await readFile(join(old, 'manifest.json'))
  const staged = await stage(transaction, old, oldHash, next, nextHash)
  assert.equal(staged.status, 'staged')
  await assert.rejects(health(transaction, async (_, data) => { assert.equal(data, join(transaction, 'health-data')); throw new Error('injected readiness failure') }), /readiness failure/)
  assert.equal(JSON.parse(await readFile(join(transaction, 'journal.json'), 'utf8')).status, 'failed')
  assert.equal((await rollback(transaction)).status, 'rolled-back')
  assert.deepEqual(await readFile(join(old, 'manifest.json')), original)
  assert.equal((await verifyBundle(next, nextHash)).version, '1.0.1')
}))
test('healthy stage does not activate and cannot rerun or reuse its transaction', async () => fixture(async (root, old, next, oldHash, nextHash) => {
  const transaction = join(root, 'transaction')
  await stage(transaction, old, oldHash, next, nextHash)
  assert.equal((await health(transaction, async () => {})).status, 'healthy')
  await assert.rejects(health(transaction, async () => {}), /newly staged/)
  await assert.rejects(stage(transaction, old, oldHash, next, nextHash), /EEXIST/)
  assert.equal((await rollback(transaction)).status, 'rolled-back')
}))
test('tampered payload and manifest trust anchors fail closed', async () => fixture(async (_root, _old, next, _oldHash, nextHash) => {
  await assert.rejects(verifyBundle(next, '0'.repeat(64)), /Manifest checksum/)
  await writeFile(join(next, 'src/main.ts'), 'changed')
  await assert.rejects(verifyBundle(next, nextHash), /Payload checksum/)
}))
test('unlisted files including dotenv are rejected before execution', async () => fixture(async (_root, _old, next, _oldHash, nextHash) => {
  await writeFile(join(next, '.env'), 'JARVIS_DATA_DIR=/production')
  await assert.rejects(verifyBundle(next, nextHash), /unlisted/)
}))
test('symlinked payload is rejected', async () => fixture(async (_root, _old, next, _oldHash, nextHash) => {
  await symlink(join(next, 'src'), join(next, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(verifyBundle(next, nextHash), /Unsafe filesystem/)
}))
test('downgrades and overlapping transaction paths are rejected', async () => fixture(async (root, old, next, oldHash, nextHash) => {
  await assert.rejects(stage(join(root, 'tx'), next, nextHash, old, oldHash), /strictly newer/)
  await assert.rejects(stage(join(next, 'transaction'), old, oldHash, next, nextHash), /separate directories/)
}))
test('rollback refuses a live isolated owner and preserves its baseline', async () => fixture(async (root, old, next, oldHash, nextHash) => {
  const transaction = join(root, 'transaction'); await stage(transaction, old, oldHash, next, nextHash)
  const data = join(transaction, 'health-data'); await mkdir(data, { mode: 0o700 })
  const lifecycle = await acquireRuntimeLifecycle(data)
  lifecycle.onShutdown(() => {}); lifecycle.setReady('http://127.0.0.1:12345/')
  try { await assert.rejects(rollback(transaction), /still exists/); assert.equal((await verifyBundle(old, oldHash)).version, '1.0.0') }
  finally { await lifecycle.close() }
  assert.equal((await rollback(transaction)).status, 'rolled-back')
}))
test('tampering after staging prevents health callback', async () => fixture(async (root, old, next, oldHash, nextHash) => {
  const transaction = join(root, 'transaction'); await stage(transaction, old, oldHash, next, nextHash)
  await writeFile(join(next, 'src/main.ts'), 'changed')
  let called = false
  await assert.rejects(health(transaction, async () => { called = true }), /Payload checksum/)
  assert.equal(called, false)
}))
