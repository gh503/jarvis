#!/usr/bin/env node
/** Manual, real-release acceptance. Requires Node 24 and authenticated gh; no npm dependencies. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const releases = [
  { version: '2.0.75', sha: '94e75fe784863384d712a5be386ee021e8e56c0e' },
  { version: '2.0.76', sha: 'a18401842dbe6975432eb9fbfebddee137a78fa5' },
] as const
const repository = 'gh503/jarvis'
const targets = [['linux', 'x64'], ['win32', 'x64'], ['darwin', 'arm64']] as const
async function hash(file: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  return digest.digest('hex')
}
// Reject traversal, aliases and control characters before either system extractor runs.
export function validateMember(name: string, root: string): void {
  assert.ok(!/[\\:\x00-\x1f\x7f]/.test(name) && name.length < 4096, 'Unsafe archive member')
  const parts = name.replace(/\/$/, '').split('/')
  assert.equal(parts[0], root)
  assert.ok(parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)), 'Unsafe archive component')
}

export function processFailureMetadata(error: unknown): { status?: number; signal?: string; code?: string } {
  const result: { status?: number; signal?: string; code?: string } = {}
  if (!error || typeof error !== 'object') return result
  try {
    const own = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(error, key)
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
    }
    const status = own('status'), signal = own('signal'), code = own('code')
    if (typeof status === 'number' && Number.isInteger(status) && status >= 0 && status <= 255) result.status = status
    if (signal === 'SIGTERM' || signal === 'SIGKILL') result.signal = signal
    if (typeof code === 'string' && ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOBUFS'].includes(code)) result.code = code
  } catch { /* Uninspectable metadata must not expose the original error. */ }
  return result
}

export async function main(): Promise<void> {
  const reportPath = resolve('native-update-acceptance-report.json')
  const started = Date.now(), deadline = started + 600_000
  let step = 'setup'
  const operations: { index: number; step: string; elapsedMs: number; completed: boolean; failure?: ReturnType<typeof processFailureMetadata> }[] = []
  const report: Record<string, unknown> = { repository, platform: process.platform, arch: process.arch, releases, passed: false, operations }
  const run = (binary: string, args: string[], env: NodeJS.ProcessEnv = process.env, cwd?: string) => {
    assert.ok(Date.now() < deadline, 'Acceptance deadline exceeded')
    const operation: (typeof operations)[number] = { index: operations.length + 1, step, elapsedMs: 0, completed: false }
    operations.push(operation)
    const begun = performance.now()
    try {
      const output = execFileSync(binary, args, { env, cwd, encoding: 'utf8', timeout: Math.min(90_000, deadline - Date.now()), maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      operation.completed = true
      return output
    } catch (error) {
      operation.failure = processFailureMetadata(error)
      throw error
    } finally {
      // Never expose command arguments, raw error text, or subprocess output.
      operation.elapsedMs = Math.round(performance.now() - begun)
    }
  }
  const progress = (value: string) => { step = value; console.error(`[acceptance] ${step}`) }
  try {
    assert.equal(process.versions.node.split('.')[0], '24')
    assert.equal(process.argv.length, 2, 'This acceptance has fixed releases and accepts no arguments')
    assert.ok(targets.some(([platform, arch]) => platform === process.platform && arch === process.arch), 'Unsupported native target')
    const temporary = await mkdtemp(join(realpathSync.native(tmpdir()), 'jarvis-release-pair-'))
    await chmod(temporary, 0o700)
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
    if (process.platform === 'win32') assert.ok(systemRoot && /^[A-Za-z]:\\/.test(systemRoot))
    const powershell = join(systemRoot ?? '/', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const tar = '/usr/bin/tar'
    const bundles: { root: string; manifestSha256: string; version: string; sourceSha: string; platform: string; arch: string; runtime: string }[] = []
    for (const release of releases) {
      progress(`download and authenticate v${release.version}`)
      const tag = `v${release.version}`
      const metadata = JSON.parse(run('gh', ['api', `repos/${repository}/releases/tags/${tag}`]))
      assert.equal(metadata.tag_name, tag); assert.equal(metadata.target_commitish, release.sha)
      assert.equal(metadata.draft, false); assert.equal(metadata.prerelease, false)
      const ref = JSON.parse(run('gh', ['api', `repos/${repository}/git/ref/tags/${tag}`]))
      const sourceSha = ref.object.type === 'tag' ? JSON.parse(run('gh', ['api', `repos/${repository}/git/tags/${ref.object.sha}`])).object.sha : ref.object.sha
      assert.equal(sourceSha, release.sha)
      const stem = `jarvis-${release.version}-${process.platform}-${process.arch}`
      const archiveName = `${stem}-${release.sha}-unsigned${process.platform === 'win32' ? '.zip' : '.tar.gz'}`
      const names = [archiveName, `${archiveName}.sha256`, `${archiveName}.provenance.json`]
      const expectedNames = targets.flatMap(([platform, arch]) => {
        const name = `jarvis-${release.version}-${platform}-${arch}-${release.sha}-unsigned${platform === 'win32' ? '.zip' : '.tar.gz'}`
        return [name, `${name}.sha256`, `${name}.provenance.json`]
      })
      assert.deepEqual(metadata.assets.map((asset: { name: string }) => asset.name).sort(), expectedNames.sort())
      const downloads = join(temporary, release.version), extracted = join(downloads, 'extracted')
      await mkdir(downloads, { mode: 0o700 }); await mkdir(extracted, { mode: 0o700 })
      run('gh', ['release', 'download', tag, '--repo', repository, '--dir', downloads, ...names.flatMap(name => ['--pattern', name])])
      for (const name of names) {
        const asset = metadata.assets.find((asset: { name: string }) => asset.name === name)
        assert.equal(asset.digest, `sha256:${await hash(join(downloads, name))}`)
      }
      const archive = join(downloads, archiveName), archiveHash = await hash(archive)
      assert.equal(await readFile(`${archive}.sha256`, 'utf8'), `${archiveHash}  ${archiveName}\n`)
      assert.deepEqual(JSON.parse(await readFile(`${archive}.provenance.json`, 'utf8')), {
        schemaVersion: 1, version: release.version, sourceSha: release.sha, sourceTag: tag,
        platform: process.platform, arch: process.arch, signing: 'unsigned', archive: archiveName, sha256: archiveHash,
      })
      progress(`inspect and extract v${release.version}`)
      if (process.platform === 'win32') {
        const env = { SystemRoot: systemRoot, WINDIR: systemRoot, ARCHIVE: archive, DEST: extracted }
        progress(`inspect ZIP members v${release.version}`)
        const entries = JSON.parse(run(powershell, ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:ARCHIVE); try { @($z.Entries | ForEach-Object { @{name=$_.FullName; mode=(($_.ExternalAttributes -shr 16) -band 61440)} }) | ConvertTo-Json -Compress } finally { $z.Dispose() }"], env))
        for (const entry of entries) { validateMember(entry.name, stem); assert.ok([0, 32768, 16384].includes(entry.mode), 'Nonregular ZIP member') }
        progress(`extract ZIP v${release.version}`)
        run(powershell, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:ARCHIVE, $env:DEST)"], env)
      } else {
        for (const name of run(tar, ['-tzf', archive]).split('\n')) validateMember(name, stem)
        for (const line of run(tar, ['-tvzf', archive]).split('\n')) assert.ok(['-', 'd'].includes(line[0]!), 'Nonregular tar member')
        run(tar, ['-xzf', archive, '-C', extracted])
      }
      progress(`validate extracted layout v${release.version}`)
      assert.deepEqual(await readdir(extracted), [stem])
      const root = await realpath(join(extracted, stem)), manifestSha256 = await hash(join(root, 'manifest.json'))
      const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
      assert.equal(manifest.version, release.version); assert.equal(manifest.sourceSha, release.sha)
      assert.equal(manifest.sourceTag, tag); assert.equal(manifest.dirty, false)
      assert.equal(manifest.platform, process.platform); assert.equal(manifest.arch, process.arch)
      bundles.push({ root, manifestSha256, version: release.version, sourceSha: release.sha, platform: process.platform, arch: process.arch, runtime: manifest.runtime.version })
    }
    const baseline = bundles[0]!, candidate = bundles[1]!
    const binary = join(baseline.root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
    const home = join(temporary, 'home'), scratch = join(temporary, 'tmp'), fixtures = join(temporary, 'fixtures')
    for (const directory of [home, scratch]) await mkdir(directory, { mode: 0o700 })
    const env = { PATH: '', HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch, SystemRoot: systemRoot, WINDIR: systemRoot }
    const evaluate = (source: string) => JSON.parse(run(binary, ['--experimental-transform-types', '--input-type=module', '-e', source], env, temporary))
    const moduleURL = (name: string) => JSON.stringify(pathToFileURL(join(baseline.root, name)).href)
    evaluate(`import {ensurePrivateDataDirectory} from ${moduleURL('src/private-directory.ts')}; await ensurePrivateDataDirectory(${JSON.stringify(fixtures)}); console.log('null')`)
    const sentinel = join(fixtures, 'unrelated.txt'), sentinelBytes = 'unrelated fixture must survive health and rollback\n'
    await writeFile(sentinel, sentinelBytes, { mode: 0o600 })
    const transaction = join(fixtures, 'transaction')
    const cli = (args: string[]) => JSON.parse(run(binary, ['--experimental-transform-types', join(baseline.root, 'scripts/update-native.ts'), ...args], env, temporary))
    const verifyPayloads = () => { for (const bundle of bundles) assert.deepEqual(cli(['verify', bundle.root, bundle.manifestSha256]), bundle) }
    const assertJournal = async (journal: unknown, status: string, note: string) => {
      const expected = { schemaVersion: 1, baseline, candidate, status, note }
      assert.deepEqual(journal, expected)
      assert.deepEqual(evaluate(`import {readUpdateJournal} from ${moduleURL('scripts/native-update-journal.ts')}; console.log(JSON.stringify(readUpdateJournal(${JSON.stringify(transaction)})))`), expected)
      assert.equal(await readFile(sentinel, 'utf8'), sentinelBytes)
    }
    const assertStopped = () => assert.equal(evaluate(`import {requestRuntime} from ${moduleURL('src/runtime-lifecycle.ts')}; console.log(JSON.stringify(await requestRuntime(${JSON.stringify(join(transaction, 'health-data'))})))`), null)
    progress('verify all baseline and candidate payloads'); verifyPayloads()
    progress('stage with baseline bundled Node and CLI')
    await assertJournal(cli(['stage', transaction, baseline.root, baseline.manifestSha256, candidate.root, candidate.manifestSha256]), 'staged', 'No activation or production data changes. Run health explicitly before manual handoff.')
    progress('health, independent stopped check, and all payload hashes')
    await assertJournal(cli(['health', transaction]), 'healthy', 'Isolated readiness passed and candidate stopped. No migration compatibility or activation has been asserted.')
    assertStopped(); verifyPayloads()
    const healthData = join(transaction, 'health-data')
    const dataHashes = async (directory: string, prefix = ''): Promise<Record<string, string>> => {
      const result: Record<string, string> = {}
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = prefix + entry.name, file = join(directory, entry.name)
        if (!prefix && /^(runtime|launcher)\.lock\.sqlite(?:-journal|-wal|-shm)?$/.test(name)) continue
        if (entry.isDirectory()) Object.assign(result, await dataHashes(file, name + '/'))
        else { assert.ok(entry.isFile(), 'Unexpected health data entry'); result[name] = await hash(file) }
      }
      return result
    }
    const preservedData = await dataHashes(healthData)
    progress('rollback, independent stopped check, and all payload hashes')
    await assertJournal(cli(['rollback', transaction]), 'rolled-back', 'Stage abandoned. Baseline, candidate, isolated health data and integrations preserved; no production restore required.')
    assertStopped(); verifyPayloads()
    assert.deepEqual(await dataHashes(healthData), preservedData)
    for (const name of ['health-data', 'health-home', 'health-temp']) assert.ok((await lstat(join(transaction, name))).isDirectory())
    Object.assign(report, { passed: true, bundles, statuses: ['staged', 'healthy', 'rolled-back'], stoppedAfterHealth: true, stoppedAfterRollback: true, payloadsUnchanged: true, healthDataPreserved: true, sentinelUnchanged: true })
  } finally {
    // Never serialize errors, subprocess buffers, environment, or runtime descriptors.
    Object.assign(report, { lastStep: step, elapsedMs: Date.now() - started })
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify(report, null, 2))
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Native release acceptance failed; see the report lastStep (subprocess output withheld).'); process.exitCode = 1 })
}
