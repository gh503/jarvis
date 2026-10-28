#!/usr/bin/env node
/** Explicit local-directory staging. Never downloads, extracts, migrates, or switches integrations. */
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, readdir, readFile, mkdir, writeFile, rename, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireLifecycleLock, requestRuntime } from '../src/runtime-lifecycle.ts'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
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
/** A user-supplied manifest digest is the trust anchor, not a digest read from the bundle. */
export async function verifyBundle(root: string, expected: string, platform = process.platform as string, arch = process.arch as string): Promise<Identity> {
  if (!sha256.test(expected)) throw new Error('Expected explicit lowercase manifest SHA256')
  if (!isAbsolute(root)) throw new Error('Bundle path must be absolute')
  await safePath(root)
  root = await realpath(root)
  if (!(await lstat(root)).isDirectory()) throw new Error('Expected extracted bundle directory; archives are unsupported')
  const bytes = await readFile(join(root, 'manifest.json'))
  if (hash(bytes) !== expected) throw new Error('Manifest checksum mismatch')
  const m = JSON.parse(bytes.toString('utf8'))
  if (m.schemaVersion !== 1 || !stable.test(m.version) || !/^[a-f0-9]{40}$/.test(m.sourceSha) || m.sourceTag !== `v${m.version}` || m.dirty !== false || m.platform !== platform || m.arch !== arch || !['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch) || m.runtime?.platform !== platform || m.runtime?.arch !== arch || !/^v24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(m.runtime?.version) || !Array.isArray(m.files)) throw new Error('Incompatible release identity (stable clean release, exact platform/arch, Node 24 required)')
  const expectedFiles = new Map<string, { bytes: number; sha256: string }>()
  const folded = new Set<string>()
  for (const file of m.files) {
    if (typeof file.path !== 'string' || /[\\:\x00-\x1f]/.test(file.path) || file.path.split('/').some((p: string) => !p || p === '.' || p === '..' || /[. ]$/.test(p)) || isAbsolute(file.path) || file.path === 'manifest.json' || file.path === '.env' || folded.has(file.path.toLowerCase()) || !sha256.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Unsafe or duplicate manifest entry')
    expectedFiles.set(file.path, file); folded.add(file.path.toLowerCase())
  }
  const seen = new Set<string>()
  async function walk(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory)) {
      const name = prefix + entry, file = join(directory, entry), info = await lstat(file)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (info.isFile() && info.nlink !== 1)) throw new Error(`Unsafe filesystem entry: ${name}`)
      if (info.isDirectory()) { await walk(file, name + '/'); continue }
      if (name === 'manifest.json') continue
      const record = expectedFiles.get(name)
      if (!record || info.size !== record.bytes || hash(await readFile(file)) !== record.sha256) throw new Error(`Payload checksum mismatch or unlisted file: ${name}`)
      seen.add(name)
    }
  }
  await walk(root)
  if (seen.size !== expectedFiles.size) throw new Error('Missing manifest payload')
  for (const name of [`runtime/${platform === 'win32' ? 'node.exe' : 'node'}`, 'src/main.ts', 'scripts/app.ts', 'scripts/install-native.ts']) if (!seen.has(name)) throw new Error(`Missing required payload: ${name}`)
  // Recheck the manifest after walking; no claim of protection against a concurrent malicious writer.
  if (hash(await readFile(join(root, 'manifest.json'))) !== expected) throw new Error('Manifest changed during verification')
  return { root, manifestSha256: expected, version: m.version, sourceSha: m.sourceSha, platform, arch, runtime: m.runtime.version }
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
  const temporary = join(transaction, `journal-${randomBytes(8).toString('hex')}.tmp`)
  await writeFile(temporary, JSON.stringify(journal, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  await rename(temporary, join(transaction, 'journal.json'))
}
export async function stage(transaction: string, baselineRoot: string, baselineHash: string, candidateRoot: string, candidateHash: string): Promise<Journal> {
  const baseline = await verifyBundle(baselineRoot, baselineHash), candidate = await verifyBundle(candidateRoot, candidateHash)
  if (!newer(candidate.version, baseline.version)) throw new Error('Candidate must have a strictly newer stable semver')
  if (!isAbsolute(transaction)) throw new Error('Transaction path must be absolute')
  await safePath(transaction)
  transaction = resolve(transaction)
  if (overlaps(baseline.root, candidate.root) || overlaps(transaction, baseline.root) || overlaps(transaction, candidate.root)) throw new Error('Baseline, candidate and transaction must be separate directories')
  await mkdir(transaction, { mode: 0o700 }) // exclusive ownership; never reuse somebody else's transaction
  const journal: Journal = { schemaVersion: 1, baseline, candidate, status: 'staged', note: 'No activation or production data changes. Run health explicitly before manual handoff.' }
  await save(transaction, journal)
  return journal
}
async function load(transaction: string): Promise<Journal> {
  await safePath(transaction)
  await safePath(join(transaction, 'journal.json'))
  const j = JSON.parse(await readFile(join(transaction, 'journal.json'), 'utf8')) as Journal
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
    j.status = 'checking'; j.note = 'Candidate health may be running in health-data; production untouched.'; await save(transaction, j)
    try { await probe(j.candidate, data); j.status = 'healthy'; j.note = 'Isolated readiness passed and candidate stopped. No migration compatibility or activation has been asserted.' }
    catch (error) { j.status = 'failed'; j.note = `Health failed; production untouched: ${String(error)}`; await save(transaction, j); throw error }
    await save(transaction, j); return j
  } finally { release() }
}
async function probeCandidate(identity: Identity, data: string): Promise<void> {
  const server = createServer()
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((ok, fail) => server.close(error => error ? fail(error) : ok()))
  // Port reservation has a race: a collision must fail readiness, never reuse another instance.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, HOME: data, USERPROFILE: data, APPDATA: data, LOCALAPPDATA: data, TMPDIR: data, TMP: data, TEMP: data, JARVIS_DATA_DIR: data, JARVIS_HOST: '127.0.0.1', JARVIS_PORT: String(port), JARVIS_AUTH_TOKEN: randomBytes(32).toString('hex'), JARVIS_WEB_DIR: join(identity.root, 'web'), JARVIS_APP: '1', JARVIS_PYTHON: join(data, 'disabled-python'), JARVIS_WHISPER_BIN: join(data, 'disabled-whisper'), JARVIS_PIPER_BIN: join(data, 'disabled-piper'), JARVIS_OLLAMA_URL: 'http://127.0.0.1:1' }
  const child = spawn(join(identity.root, 'runtime', identity.platform === 'win32' ? 'node.exe' : 'node'), ['--experimental-transform-types', join(identity.root, 'src/main.ts')], { cwd: data, env, stdio: 'ignore' })
  let failure: Error | undefined, exited = false
  const done = new Promise<void>(ok => { child.once('error', error => { failure = error; exited = true; ok() }); child.once('exit', () => { exited = true; ok() }) })
  try {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      if (exited) throw failure ?? new Error('Candidate exited before readiness')
      const status = await requestRuntime(data)
      if (status?.state === 'ready') {
        if (status.url !== `http://127.0.0.1:${port}/`) throw new Error('Candidate health URL mismatch')
        const stopped = await requestRuntime(data, 'shutdown')
        if (stopped?.instanceId !== status.instanceId || stopped.state !== 'stopping') throw new Error('Candidate did not acknowledge shutdown')
        let timer: NodeJS.Timeout | undefined
        await Promise.race([done, new Promise<void>(ok => { timer = setTimeout(ok, 5000) })]); clearTimeout(timer)
        if (!exited) throw new Error('Candidate did not exit after authenticated shutdown')
        const releaseRuntime = await acquireLifecycleLock(data, 'runtime'); releaseRuntime()
        return
      }
      await new Promise(ok => setTimeout(ok, 100))
    }
    throw new Error('Candidate readiness timed out')
  } finally {
    // Only this invocation's ChildProcess handle is signalled; never a PID from disk.
    if (!exited) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([done, new Promise<void>(ok => { timer = setTimeout(ok, 5000) })]); clearTimeout(timer)
      if (!exited) { child.kill('SIGKILL'); await done }
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
