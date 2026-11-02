#!/usr/bin/env node
/** Local-directory staging and isolated authenticated health checks. Never downloads, extracts, migrates, or activates. */
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, open, opendir, mkdir, realpath } from 'node:fs/promises'
import { constants, type BigIntStats } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireLifecycleLock, requestRuntime } from '../src/runtime-lifecycle.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'
import { readUpdateJournal, writeUpdateJournal } from './native-update-journal.ts'

const sha256 = /^[a-f0-9]{64}$/
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export interface Identity { root: string; manifestSha256: string; version: string; sourceSha: string; platform: string; arch: string; runtime: string }
export interface Journal { schemaVersion: 1; baseline: Identity; candidate: Identity; status: 'staged' | 'checking' | 'healthy' | 'failed' | 'rolled-back'; note: string }
export async function safePath(path: string): Promise<void> {
  let current = resolve(path)
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink rejected: ${current}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}
class BundleVerificationError extends Error {}
const manifestLimit = 16 * 1024 * 1024
const payloadLimit = 16 * 1024 ** 3
const totalPayloadLimit = 64 * 1024 ** 3
const entryLimit = 100_000
const depthLimit = 64
/** A user-supplied manifest digest is the trust anchor, not a digest read from the bundle. */
export async function verifyBundle(root: string, expected: string, platform = process.platform as string, arch = process.arch as string): Promise<Identity> {
  const deadline = performance.now() + 5 * 60_000
  const fail = (message: string): never => { throw new BundleVerificationError(message) }
  const checkDeadline = () => { if (performance.now() > deadline) fail('Bundle verification deadline exceeded') }
  async function checked<T>(operation: Promise<T>): Promise<T> { const value = await operation; checkDeadline(); return value }
  const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs
  const regular = (info: BigIntStats) => { if (!info.isFile() || info.nlink !== 1n) fail('Unsafe filesystem entry') }
  // One reusable buffer bounds payload memory regardless of declared or actual size.
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  async function readVerified(path: string, limit: number, size?: number, collect = false) {
    checkDeadline()
    const before = await checked(lstat(path, { bigint: true }))
    regular(before)
    if (before.size > BigInt(limit)) fail('Bundle file exceeds size limit')
    if (size !== undefined && before.size !== BigInt(size)) fail('Payload checksum mismatch or unlisted file')
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      checkDeadline()
      const opened = await checked(handle.stat({ bigint: true }))
      regular(opened)
      if (!same(before, opened)) fail('Bundle file changed during verification')
      const bytes = collect ? Buffer.alloc(Number(opened.size)) : undefined
      const digest = createHash('sha256')
      let position = 0
      while (position < Number(opened.size)) {
        const length = Math.min(chunk.length, Number(opened.size) - position)
        const { bytesRead } = await checked(handle.read(chunk, 0, length, position))
        if (!bytesRead) fail('Bundle file changed during verification')
        digest.update(chunk.subarray(0, bytesRead))
        if (bytes) chunk.copy(bytes, position, 0, bytesRead)
        position += bytesRead
      }
      if ((await checked(handle.read(chunk, 0, 1, position))).bytesRead !== 0) fail('Bundle file changed during verification')
      const after = await checked(handle.stat({ bigint: true }))
      const named = await checked(lstat(path, { bigint: true }))
      regular(after); regular(named)
      if (!same(opened, after) || !same(opened, named)) fail('Bundle file changed during verification')
      return { digest: digest.digest('hex'), bytes, info: opened }
    } finally { await handle.close() }
  }
  try {
    if (!sha256.test(expected)) fail('Expected explicit lowercase manifest SHA256')
    if (!isAbsolute(root)) fail('Bundle path must be absolute')
    await checked(safePath(root))
    root = await checked(realpath(root))
    if (!(await checked(lstat(root))).isDirectory()) fail('Expected extracted bundle directory; archives are unsupported')
    const manifest = await readVerified(join(root, 'manifest.json'), manifestLimit, undefined, true)
    if (manifest.digest !== expected) fail('Manifest checksum mismatch')
    let m
    try { m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.bytes)) }
    catch { fail('Invalid manifest JSON or UTF-8') }
    if (!m || m.schemaVersion !== 1 || !stable.test(m.version) || !/^[a-f0-9]{40}$/.test(m.sourceSha) || m.sourceTag !== `v${m.version}` || m.dirty !== false || m.platform !== platform || m.arch !== arch || !['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch) || m.runtime?.platform !== platform || m.runtime?.arch !== arch || !/^v24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(m.runtime?.version) || !Array.isArray(m.files)) fail('Incompatible release identity (stable clean release, exact platform/arch, Node 24 required)')
    if (m.files.length > entryLimit) fail('Bundle entry limit exceeded')
    const expectedFiles = new Map<string, { bytes: number; sha256: string }>()
    const folded = new Set<string>()
    const expectedDirectories = new Set<string>()
    let total = 0
    for (const file of m.files) {
      checkDeadline()
      if (!file || typeof file.path !== 'string' || /[\\:\x00-\x1f\ufffd\ud800-\udfff]/u.test(file.path) || Buffer.byteLength(file.path, 'utf8') > 4096 || file.path.split('/').length > depthLimit || file.path.split('/').some((p: string) => !p || p === '.' || p === '..' || /[. ]$/.test(p) || Buffer.byteLength(p, 'utf8') > 255) || isAbsolute(file.path) || file.path === 'manifest.json' || file.path === '.env' || folded.has(file.path.toLowerCase()) || typeof file.sha256 !== 'string' || !sha256.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) fail('Unsafe or duplicate manifest entry')
      total += file.bytes
      if (file.bytes > payloadLimit || total > totalPayloadLimit) fail('Declared payload exceeds size limit')
      expectedFiles.set(file.path, file); folded.add(file.path.toLowerCase())
      let parent = file.path.lastIndexOf('/')
      while (parent !== -1) {
        expectedDirectories.add(file.path.slice(0, parent))
        if (expectedDirectories.size + m.files.length + 1 > entryLimit) fail('Bundle entry limit exceeded')
        parent = file.path.lastIndexOf('/', parent - 1)
      }
    }
    const seen = new Set<string>()
    let entries = 0
    async function walk(directory: string, prefix = '', depth = 0): Promise<void> {
      checkDeadline()
      if (depth > depthLimit) fail('Bundle depth limit exceeded')
      const before = await checked(lstat(directory, { bigint: true }))
      if (!before.isDirectory()) fail('Unsafe filesystem entry')
      const iterator = await opendir(directory)
      try {
        checkDeadline()
        while (true) {
          const entry = await checked(iterator.read())
          if (!entry) break
          if (++entries > entryLimit) fail('Bundle entry limit exceeded')
          const name = prefix + entry.name, file = join(directory, entry.name)
          if (/[\ufffd\ud800-\udfff]/u.test(entry.name) || Buffer.byteLength(entry.name, 'utf8') > 255 || Buffer.byteLength(name, 'utf8') > 4096) fail('Unsafe filesystem entry')
          const info = await checked(lstat(file, { bigint: true }))
          if (info.isDirectory()) {
            if (!expectedDirectories.has(name)) fail('Unlisted bundle directory')
            await walk(file, name + '/', depth + 1); continue
          }
          regular(info)
          if (name === 'manifest.json') continue
          const record = expectedFiles.get(name)
          if (!record || info.size !== BigInt(record.bytes)) fail('Payload checksum mismatch or unlisted file')
          const payload = await readVerified(file, payloadLimit, record!.bytes)
          if (!same(info, payload.info)) fail('Bundle file changed during verification')
          if (payload.digest !== record!.sha256) fail('Payload checksum mismatch or unlisted file')
          seen.add(name)
        }
      } finally { await iterator.close() }
      if (!same(before, await checked(lstat(directory, { bigint: true })))) fail('Bundle directory changed during verification')
    }
    await walk(root)
    if (seen.size !== expectedFiles.size) fail('Missing manifest payload')
    for (const name of [`runtime/${platform === 'win32' ? 'node.exe' : 'node'}`, 'src/main.ts', 'scripts/app.ts', 'scripts/install-native.ts']) if (!seen.has(name)) fail('Missing required payload')
    // Detect replacement as well as mutation; this is not a filesystem snapshot or a lock against writers.
    const finalManifest = await readVerified(join(root, 'manifest.json'), manifestLimit)
    if (finalManifest.digest !== expected || !same(manifest.info, finalManifest.info)) fail('Manifest changed during verification')
    checkDeadline()
    return { root, manifestSha256: expected, version: m.version, sourceSha: m.sourceSha, platform, arch, runtime: m.runtime.version }
  } catch (error) {
    if (error instanceof BundleVerificationError) throw error
    throw new BundleVerificationError('Bundle verification failed')
  }
}

function newer(a: string, b: string): boolean {
  const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i]! > bb[i]!
  return false
}
function overlaps(a: string, b: string): boolean {
  const inside = (x: string, y: string) => { const r = relative(x, y); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }
  return inside(a, b) || inside(b, a)
}
async function save(transaction: string, journal: Journal): Promise<void> {
  writeUpdateJournal(transaction, journal)
}
export async function stage(transaction: string, baselineRoot: string, baselineHash: string, candidateRoot: string, candidateHash: string): Promise<Journal> {
  const baseline = await verifyBundle(baselineRoot, baselineHash), candidate = await verifyBundle(candidateRoot, candidateHash)
  if (!newer(candidate.version, baseline.version)) throw new Error('Candidate must have a strictly newer stable semver')
  if (!isAbsolute(transaction)) throw new Error('Transaction path must be absolute')
  await safePath(transaction)
  transaction = resolve(transaction)
  if (overlaps(baseline.root, candidate.root) || overlaps(transaction, baseline.root) || overlaps(transaction, candidate.root)) throw new Error('Baseline, candidate and transaction must be separate directories')
  await mkdir(transaction, { mode: 0o700 }) // exclusive ownership; never reuse somebody else's transaction
  await ensurePrivateDataDirectory(transaction) // establish Windows owner/ACL before writing journal descendants
  const journal: Journal = { schemaVersion: 1, baseline, candidate, status: 'staged', note: 'No activation or production data changes. Run health explicitly before manual handoff.' }
  await save(transaction, journal)
  return journal
}
async function load(transaction: string): Promise<Journal> {
  await safePath(transaction)
  await safePath(join(transaction, 'journal.json'))
  const j = readUpdateJournal(transaction) as Journal
  if (j.schemaVersion !== 1 || !['staged', 'checking', 'healthy', 'failed', 'rolled-back'].includes(j.status)) throw new Error('Invalid transaction journal')
  for (const identity of [j.baseline, j.candidate]) {
    const actual = await verifyBundle(identity.root, identity.manifestSha256)
    if (JSON.stringify(actual) !== JSON.stringify(identity)) throw new Error('Transaction release identity changed')
    if (overlaps(resolve(transaction), actual.root)) throw new Error('Unsafe transaction location')
  }
  if (overlaps(j.baseline.root, j.candidate.root) || !newer(j.candidate.version, j.baseline.version)) throw new Error('Invalid transaction version ordering')
  return j
}
/** Injected only for tests; production runs the candidate directly, with no shell or inherited app config. */
export async function health(transaction: string, probe = probeCandidate): Promise<Journal> {
  if (!isAbsolute(transaction)) throw new Error('Transaction path must be absolute')
  await safePath(transaction)
  if (!(await lstat(transaction)).isDirectory()) throw new Error('Expected existing transaction directory')
  const release = await acquireLifecycleLock(transaction, 'launcher')
  try {
    const j = await load(transaction)
    if (j.status !== 'staged') throw new Error('Health requires a newly staged transaction; interrupted attempts require rollback and restaging')
    const data = join(transaction, 'health-data')
    await mkdir(data, { mode: 0o700 })
    await ensurePrivateDataDirectory(data)
    j.status = 'checking'; j.note = 'Candidate health may be running in health-data; production untouched.'; await save(transaction, j)
    try { await probe(j.candidate, data); j.status = 'healthy'; j.note = 'Isolated readiness passed and candidate stopped. No migration compatibility or activation has been asserted.' }
    catch (error) { j.status = 'failed'; j.note = `Health failed; production untouched: ${String(error)}`; await save(transaction, j); throw error }
    await save(transaction, j); return j
  } finally { release() }
}
async function probeCandidate(identity: Identity, data: string): Promise<void> {
  // Data must not equal home, temp, or Windows account roots: private-directory rejects those.
  const home = join(dirname(data), 'health-home'), temporary = join(dirname(data), 'health-temp')
  await mkdir(home, { mode: 0o700 }); await mkdir(temporary, { mode: 0o700 })
  const server = createServer()
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok()))
  // Port reservation has a race: a collision must fail readiness, never reuse another instance.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary, JARVIS_DATA_DIR: data, JARVIS_HOST: '127.0.0.1', JARVIS_PORT: String(port), JARVIS_AUTH_TOKEN: randomBytes(32).toString('hex'), JARVIS_WEB_DIR: join(identity.root, 'web'), JARVIS_APP: '1', JARVIS_PYTHON: join(data, 'disabled-python'), JARVIS_WHISPER_BIN: join(data, 'disabled-whisper'), JARVIS_PIPER_BIN: join(data, 'disabled-piper'), JARVIS_OLLAMA_URL: 'http://127.0.0.1:1' }
  const child = spawn(join(identity.root, 'runtime', identity.platform === 'win32' ? 'node.exe' : 'node'), ['--experimental-transform-types', join(identity.root, 'src/main.ts')], { cwd: data, env, stdio: ['ignore', 'ignore', 'pipe'] })
  let failure: Error | undefined, exited = false, closed = false, exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null, diagnostic = ''
  // Keep bounded stderr only in memory; expose allowlisted error codes, never child text/secrets.
  child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-8192) })
  child.on('error', error => { failure = error })
  child.once('exit', (code, signal) => { exitCode = code; exitSignal = signal; exited = true })
  // exit alone does not mean inherited stdio has closed. Never leave an unbounded cleanup wait.
  const done = new Promise<void>(ok => { child.once('close', (code, signal) => { exitCode = code; exitSignal = signal; closed = true; ok() }) })
  async function waitForClose(): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([done, new Promise<void>(ok => { timer = setTimeout(ok, 5000) })]) }
    finally { clearTimeout(timer) }
  }
  try {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (failure || exited || closed) {
        const codes = [...new Set(diagnostic.match(/\b(?:EACCES|EPERM|EADDRINUSE|ENAMETOOLONG|ENOENT|EINVAL|ERR_[A-Z_]+)\b/g) ?? [])].slice(0, 8)
        throw failure ?? new Error(`Candidate exited before readiness (code=${exitCode}, signal=${exitSignal}; error codes: ${codes.join(', ') || 'none'})`)
      }
      const status = await requestRuntime(data)
      if (status?.state === 'ready') {
        const expectedURL = `http://127.0.0.1:${port}/`
        if (status.url !== expectedURL) throw new Error('Candidate health URL mismatch')
        const response = await fetch(new URL('api/health', expectedURL), {
          headers: { Authorization: `Bearer ${env.JARVIS_AUTH_TOKEN}` },
          redirect: 'error', signal: AbortSignal.timeout(5000),
        })
        if (response.status !== 200) { await response.body?.cancel(); throw new Error('Candidate HTTP health failed') }
        const reader = response.body?.getReader()
        if (!reader) throw new Error('Candidate HTTP health body missing')
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 64 * 1024) throw new Error('Candidate HTTP health body exceeds limit')
            chunks.push(value)
          }
        } finally { await reader.cancel(); reader.releaseLock() }
        let result: { ok?: unknown; version?: unknown; build?: { version?: unknown; sourceSha?: unknown; manifestSha256?: unknown } } | null
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { throw new Error('Candidate HTTP health JSON invalid') }
        if (result?.ok !== true || result.version !== identity.version) throw new Error('Candidate HTTP health version mismatch')
        if (result.build?.version !== identity.version || result.build.sourceSha !== identity.sourceSha || result.build.manifestSha256 !== identity.manifestSha256) throw new Error('Candidate HTTP health build identity mismatch')
        if (failure || exited || closed) throw failure ?? new Error('Candidate exited before authenticated shutdown')
        const stopped = await requestRuntime(data, 'shutdown')
        if (stopped?.instanceId !== status.instanceId || stopped.state !== 'stopping') throw new Error('Candidate did not acknowledge shutdown')
        await waitForClose()
        if (failure) throw failure
        if (!closed) throw new Error('Candidate did not close after authenticated shutdown')
        if (exitCode !== 0 || exitSignal !== null) throw new Error(`Candidate shutdown failed (code=${exitCode}, signal=${exitSignal})`)
        const releaseRuntime = await acquireLifecycleLock(data, 'runtime'); releaseRuntime()
        return
      }
      await new Promise(ok => setTimeout(ok, 100))
    }
    throw new Error('Candidate readiness timed out')
  } finally {
    // Only this invocation's ChildProcess handle is signalled; never a PID from disk.
    if (!closed) {
      if (!exited) child.kill('SIGKILL')
      await waitForClose()
      if (!closed) {
        child.stderr.destroy()
        child.unref()
        throw new Error('Candidate process cleanup timed out')
      }
    }
  }
}
export async function rollback(transaction: string): Promise<Journal> {
  if (!isAbsolute(transaction)) throw new Error('Transaction path must be absolute')
  await safePath(transaction)
  if (!(await lstat(transaction)).isDirectory()) throw new Error('Expected existing transaction directory')
  const release = await acquireLifecycleLock(transaction, 'launcher')
  try {
    const j = await load(transaction)
    const data = join(transaction, 'health-data')
    await safePath(data)
    // No authenticated build identity exists after interruption. Refuse to stop an ambiguous owner.
    try {
      await lstat(data)
      if (await requestRuntime(data)) throw new Error('Health runtime still exists; stop it explicitly before rollback')
      const releaseRuntime = await acquireLifecycleLock(data, 'runtime'); releaseRuntime()
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    j.status = 'rolled-back'; j.note = 'Stage abandoned. Baseline, candidate, isolated health data and integrations preserved; no production restore required.'
    await save(transaction, j); return j
  } finally { release() }
}
export async function main(args: string[]): Promise<void> {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Updater requires Node 24')
  const [command, ...values] = args
  let result: unknown
  if (command === 'verify' && values.length === 2) result = await verifyBundle(values[0]!, values[1]!)
  else if (command === 'stage' && values.length === 5) result = await stage(values[0]!, values[1]!, values[2]!, values[3]!, values[4]!)
  else if (command === 'health' && values.length === 1) result = await health(values[0]!)
  else if (command === 'rollback' && values.length === 1) result = await rollback(values[0]!)
  else throw new Error('Usage: update-native.ts verify ABS_BUNDLE MANIFEST_SHA256 | stage ABS_TRANSACTION ABS_OLD OLD_MANIFEST_SHA256 ABS_NEW NEW_MANIFEST_SHA256 | health ABS_TRANSACTION | rollback ABS_TRANSACTION')
  console.log(JSON.stringify(result, null, 2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(String(error)); process.exitCode = 1 })
