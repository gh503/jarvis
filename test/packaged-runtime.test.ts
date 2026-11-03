import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { payloadFiles, sha256 } from '../scripts/packaging.ts'
import { verifyBundle } from '../scripts/update-native.ts'

// Opt in after npm run package. The default test suite never launches a server.
const archiveInput = process.env.JARVIS_PACKAGE_ARCHIVE

// Windows extraction and scanning thousands of files can exceed two minutes on
// shared runners. Keep each subprocess bounded independently of this total budget.
test('native artifact verifies and starts/stops using only its bundled Node', { skip: !archiveInput, timeout: 300_000 }, async () => {
  const begun = performance.now()
  let stage = 'archive checksum'
  let stageStarted = begun
  const nextStage = (next: string) => {
    const now = performance.now()
    console.log(`[artifact] ${stage}: ${Math.round(now - stageStarted)}ms; total ${Math.round(now - begun)}ms; starting ${next}`)
    stage = next
    stageStarted = now
  }
  console.log(`[artifact] starting ${stage} (${process.platform}/${process.arch})`)
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const filename = `jarvis-${process.env.JARVIS_RELEASE_VERSION ?? pkg.version}-${process.platform}-${process.arch}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`
  const archive = archiveInput === 'auto' ? resolve('dist', filename) : resolve(archiveInput!)
  const expectedDigest = (await readFile(`${archive}.sha256`, 'utf8')).split(/\s+/)[0]
  assert.equal(await sha256(archive), expectedDigest)
  const tempRoot = process.platform === 'win32' ? realpathSync.native(tmpdir()) : await realpath(tmpdir())
  const temporary = await mkdtemp(join(tempRoot, 'Jarvis artifact 中文 '))
  const extracted = join(temporary, 'extracted app 空间')
  const data = join(temporary, 'private data 数据')
  await mkdir(extracted)
  // Let the shipped runtime create and secure its own fresh data root.
  let launch: ((args: string[]) => ReturnType<typeof spawnSync>) | undefined
  try {
    nextStage('archive extraction')
    if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:ARCHIVE -DestinationPath $env:DEST -ErrorAction Stop'], { env: { ...process.env, ARCHIVE: archive, DEST: extracted }, timeout: 150_000 })
    else execFileSync('tar', ['-xzf', archive, '-C', extracted], { timeout: 150_000 })
    nextStage('payload enumeration and SHA256 verification')
    const roots = await readdir(extracted)
    assert.equal(roots.length, 1)
    const bundle = join(extracted, roots[0]!)
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'))
    const files = await payloadFiles(bundle)
    assert.deepEqual(files.filter(file => file !== 'manifest.json'), manifest.files.map((file: {path: string}) => file.path))
    for (const file of manifest.files) {
      assert.ok(!file.path.split('/').includes('..'))
      assert.equal(await sha256(join(bundle, file.path)), file.sha256, file.path)
    }
    assert.equal(manifest.platform, process.platform)
    assert.equal(manifest.arch, process.arch)
    console.log(`[artifact] verified ${manifest.files.length} payload files`)
    nextStage('bounded updater bundle verification')
    // The archive checksum was verified against its external sidecar before extraction.
    // Exercise the production verifier against the actual shipped layout on every OS.
    const manifestDigest = await sha256(join(bundle, 'manifest.json'))
    if (process.env.JARVIS_RELEASE_VERSION || (manifest.dirty === false && manifest.sourceTag === `v${manifest.version}` && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version))) {
      const verified = await verifyBundle(bundle, manifestDigest)
      assert.equal(verified.version, manifest.version)
      assert.equal(verified.sourceSha, manifest.sourceSha)
    } else {
      // Native CI also builds untagged development artifacts, which cannot be update releases.
      await assert.rejects(verifyBundle(bundle, manifestDigest), /Incompatible release identity/)
      console.log('[artifact] development identity correctly rejected for release updates; no release verification asserted')
    }
    nextStage('runtime identity and port allocation')
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const port = address.port
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^JARVIS_|^NODE_|^PATH$/i.test(key)))
    Object.assign(env, { PATH: '', JARVIS_DATA_DIR: data, JARVIS_HOST: '127.0.0.1', JARVIS_PORT: String(port), JARVIS_AUTH_TOKEN: 'artifact-test-token-at-least-24-characters', JARVIS_OLLAMA_URL: 'http://127.0.0.1:1', JARVIS_DAILY_SPEAK_BUDGET: '0' })
    const binary = join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
    const identity = JSON.parse(execFileSync(binary, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], { env, encoding: 'utf8', timeout: 15_000 }))
    assert.equal(identity.version, manifest.runtime.version)
    nextStage('bundled native management module imports with empty PATH')
    const managementModules = ['install-native.ts', 'update-native.ts', 'native-state-snapshot.ts', 'native-config-snapshot.ts', 'native-recovery-set.ts', 'native-integration-snapshot.ts', 'native-install-diagnose.ts', 'native-install-transaction.ts', 'native-install-transaction-store.ts', 'native-install-prepared-write-gate.ts', 'native-install-transaction-ack.ts', 'native-install-transaction-ack-store.ts', 'native-install-transaction-inspect.ts', 'native-install-transaction-completion.ts', 'native-install-transaction-completion-store.ts', 'native-install-preparation-retire.ts', 'retire-native-install-preparation.ts']
    const importScript = `for (const url of ${JSON.stringify(managementModules.map(name => pathToFileURL(join(bundle, 'scripts', name)).href))}) await import(url)`
    const managementImports = spawnSync(binary, ['--experimental-transform-types', '--input-type=module', '-e', importScript], { env, cwd: temporary, encoding: 'utf8', timeout: 30_000 })
    assert.ifError(managementImports.error)
    assert.equal(managementImports.status, 0, managementImports.stderr)
    nextStage('bundled preparation retirement help and invalid arguments with empty PATH')
    const retirementCli = join(bundle, 'scripts', 'retire-native-install-preparation.ts')
    assert.ok((await lstat(retirementCli)).isFile())
    const retirementOptions = { env, cwd: temporary, encoding: 'utf8' as const, timeout: 60_000, maxBuffer: 64 * 1024 }
    const retirementHelp = spawnSync(binary, ['--experimental-transform-types', retirementCli, '--help'], retirementOptions)
    assert.ifError(retirementHelp.error)
    assert.equal(retirementHelp.status, 0, retirementHelp.stderr)
    assert.equal(JSON.parse(retirementHelp.stdout).status, 'help')
    assert.match(JSON.parse(retirementHelp.stdout).usage, /retire-preparation --expected-transaction-id UUID/)
    const retirementInvalid = spawnSync(binary, ['--experimental-transform-types', retirementCli, 'retire-preparation'], retirementOptions)
    assert.ifError(retirementInvalid.error)
    assert.equal(retirementInvalid.status, 2)
    assert.equal(retirementInvalid.stdout, '')
    assert.match(retirementInvalid.stderr, /\{"schemaVersion":1,"status":"invalid-arguments"\}/)
    await assert.rejects(lstat(data), { code: 'ENOENT' })
    nextStage('bundled native install diagnosis with empty PATH')
    const diagnosisCli = join(bundle, 'scripts', 'diagnose-native-install.ts')
    assert.ok((await lstat(diagnosisCli)).isFile())
    assert.ok(['x64', 'arm64'].includes(process.arch))
    // Linux exercises the Darwin layout as a simulation, not native macOS coverage.
    const diagnosisPlatform = process.platform === 'win32' ? 'win32' : 'darwin'
    const diagnosisHome = join(temporary, 'diagnosis home 中文')
    const diagnosisAppData = join(temporary, 'diagnosis roaming')
    const diagnosisLocalAppData = join(temporary, 'diagnosis local')
    await mkdir(diagnosisHome, { mode: 0o755 })
    if (diagnosisPlatform === 'win32') {
      await mkdir(diagnosisAppData, { mode: 0o755 })
      await mkdir(diagnosisLocalAppData, { mode: 0o755 })
    }
    const sentinel = join(diagnosisHome, 'unrelated.txt')
    const sentinelBytes = 'unrelated home fixture must survive diagnosis'
    await writeFile(sentinel, sentinelBytes, { mode: 0o600 })
    // Keep this packaged CLI check independent of source-tree integration APIs.
    const diagnosisState = diagnosisPlatform === 'win32'
      ? join(diagnosisLocalAppData, 'Jarvis')
      : join(diagnosisHome, 'Library', 'Application Support', 'Jarvis')
    const controlDirectory = join(diagnosisState, 'native-install-control')
    const diagnosisArgs = ['diagnose', '--platform', diagnosisPlatform, '--arch', process.arch,
      '--root', bundle,
      ...(diagnosisPlatform === 'win32' ? ['--app-data', diagnosisAppData, '--local-app-data', diagnosisLocalAppData] : [])]
    const diagnosisOptions = { env, cwd: temporary, encoding: 'utf8' as const, timeout: 60_000 }
    const invalidDiagnosis = spawnSync(binary, ['--experimental-transform-types', diagnosisCli, ...diagnosisArgs], diagnosisOptions)
    assert.ifError(invalidDiagnosis.error)
    assert.equal(invalidDiagnosis.status, 2, invalidDiagnosis.stderr)
    assert.equal(invalidDiagnosis.stdout, '')
    assert.match(invalidDiagnosis.stderr, /Usage: diagnose-native-install\.ts diagnose/)
    await assert.rejects(lstat(diagnosisState), { code: 'ENOENT' })
    assert.equal(await readFile(sentinel, 'utf8'), sentinelBytes)
    const diagnosis = spawnSync(binary, ['--experimental-transform-types', diagnosisCli, ...diagnosisArgs, '--home', diagnosisHome], diagnosisOptions)
    assert.ifError(diagnosis.error)
    assert.equal(diagnosis.status, 0, diagnosis.stderr)
    // No intent makes no claim that the installation is clean or healthy.
    assert.deepEqual(JSON.parse(diagnosis.stdout), {
      status: 'no-intent',
      scope: { ownership: false, execution: false, automaticCleanup: false, atomicity: false },
    })
    assert.ok((await lstat(join(controlDirectory, 'launcher.lock.sqlite'))).isFile())
    await assert.rejects(lstat(join(controlDirectory, 'install-intent.json')), { code: 'ENOENT' })
    await assert.rejects(lstat(join(diagnosisState, 'native-install.json')), { code: 'ENOENT' })
    assert.equal(await readFile(sentinel, 'utf8'), sentinelBytes)
    nextStage('bundled transaction inspection with empty PATH')
    const inspectionCli = join(bundle, 'scripts', 'inspect-native-install-transaction.ts')
    assert.ok((await lstat(inspectionCli)).isFile())
    const inspection = spawnSync(binary, ['--experimental-transform-types', inspectionCli, 'inspect', ...diagnosisArgs.slice(1), '--home', diagnosisHome], diagnosisOptions)
    assert.ifError(inspection.error)
    assert.equal(inspection.status, 0, inspection.stderr)
    assert.deepEqual(JSON.parse(inspection.stdout), {
      status: 'no-transaction', declaration: 'not-inspected', issues: [{ reason: 'preparation-missing' }],
      scope: { ownership: false, execution: false, automaticCleanup: false, replay: false, atomicity: false, completed: false },
      limitations: { sourcePolicy: 'legacy-integration', sourceWindowsAcl: false, controlPolicy: 'private-install-control', cooperatingWritersOnly: true, observationsAtomic: false, acknowledgementAuthenticity: false },
    })
    assert.ok(!inspection.stdout.includes(temporary))
    await assert.rejects(lstat(join(controlDirectory, 'prepared-transaction.json')), { code: 'ENOENT' })
    await assert.rejects(lstat(join(diagnosisState, 'native-install.json')), { code: 'ENOENT' })
    assert.equal(await readFile(sentinel, 'utf8'), sentinelBytes)
    nextStage('bundled data snapshot create/verify/restore with empty PATH')
    {
      // Synthetic state stays disjoint from both application data and diagnosis.
      const snapshotRoot = join(temporary, 'snapshot fixture 中文')
      const source = join(snapshotRoot, 'source')
      const snapshot = join(snapshotRoot, 'snapshot')
      const destination = join(snapshotRoot, 'restored')
      const outside = join(temporary, 'snapshot unrelated.txt')
      const outsideBytes = Buffer.from('unrelated snapshot fixture must survive')
      const configBytes = Buffer.from('{"fixture":"packaged snapshot 中文"}\n')
      await writeFile(outside, outsideBytes, { mode: 0o600 })
      const options = { env, cwd: temporary, encoding: 'utf8' as const, timeout: 60_000, maxBuffer: 64 * 1024 }
      // Use the shipped permission API so Windows fixtures inherit private ACLs.
      const setupScript = `import {ensurePrivateDataDirectory} from ${JSON.stringify(pathToFileURL(join(bundle, 'src/private-directory.ts')).href)};await ensurePrivateDataDirectory(${JSON.stringify(snapshotRoot)});await ensurePrivateDataDirectory(${JSON.stringify(source)});`
      const setup = spawnSync(binary, ['--experimental-transform-types', '--input-type=module', '-e', setupScript], options)
      assert.ifError(setup.error)
      assert.equal(setup.status, 0, setup.stderr)
      await writeFile(join(source, 'sample.txt'), configBytes, { mode: 0o600 })
      const snapshotCli = join(bundle, 'scripts', 'snapshot-native.ts')
      const runSnapshot = (args: string[]) => {
        const result = spawnSync(binary, ['--experimental-transform-types', snapshotCli, ...args], options)
        assert.ifError(result.error)
        assert.equal(result.status, 0, result.stderr)
        return JSON.parse(result.stdout)
      }
      const receipt = runSnapshot(['create', '--data', source, '--destination', snapshot])
      assert.deepEqual(Object.keys(receipt).sort(), ['manifestSha256', 'snapshot'])
      assert.equal(receipt.snapshot, snapshot)
      assert.match(receipt.manifestSha256, /^[a-f0-9]{64}$/)
      const snapshotArgs = ['--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256]
      assert.deepEqual(runSnapshot(['verify', ...snapshotArgs]), { verified: true, ...receipt })
      assert.deepEqual(runSnapshot(['restore', ...snapshotArgs, '--destination', destination]), {
        destination, manifestSha256: receipt.manifestSha256,
      })
      assert.deepEqual(await readFile(join(destination, 'sample.txt')), configBytes)
      assert.deepEqual(await readFile(join(source, 'sample.txt')), configBytes)
      assert.deepEqual(await readFile(outside), outsideBytes)
      assert.equal(await readFile(sentinel, 'utf8'), sentinelBytes)
      await assert.rejects(lstat(data), { code: 'ENOENT' })
    }
    nextStage('bundled config snapshot create/verify/restore with empty PATH')
    {
      const snapshotRoot = join(temporary, 'config snapshot fixture 中文')
      const configParent = join(snapshotRoot, 'private config')
      const sourceData = join(snapshotRoot, 'data')
      const configFile = join(configParent, 'original.env')
      const snapshot = join(snapshotRoot, 'snapshot')
      const destination = join(snapshotRoot, 'restored')
      const configBytes = Buffer.from(`# Packaged config fixture 中文\nJARVIS_DATA_DIR="${sourceData}"\nJARVIS_PORT='32123'\n`)
      const options = { env, cwd: temporary, encoding: 'utf8' as const, timeout: 60_000, maxBuffer: 64 * 1024 }
      // Fresh private parents give Windows configuration files inherited private ACLs.
      const setupScript = `import {ensurePrivateDataDirectory} from ${JSON.stringify(pathToFileURL(join(bundle, 'src/private-directory.ts')).href)};for (const directory of ${JSON.stringify([snapshotRoot, configParent, sourceData])}) await ensurePrivateDataDirectory(directory);`
      const setup = spawnSync(binary, ['--experimental-transform-types', '--input-type=module', '-e', setupScript], options)
      assert.ifError(setup.error)
      assert.equal(setup.status, 0, setup.stderr)
      await writeFile(configFile, configBytes, { mode: 0o600 })
      const snapshotCli = join(bundle, 'scripts', 'snapshot-native-config.ts')
      const runSnapshot = (args: string[]) => {
        const result = spawnSync(binary, ['--experimental-transform-types', snapshotCli, ...args], options)
        assert.ifError(result.error)
        assert.equal(result.status, 0, result.stderr)
        return JSON.parse(result.stdout)
      }
      const receipt = runSnapshot(['create', '--config', configFile, '--data', sourceData, '--destination', snapshot])
      assert.deepEqual(Object.keys(receipt).sort(), ['manifestSha256', 'snapshot'])
      assert.equal(receipt.snapshot, snapshot)
      assert.match(receipt.manifestSha256, /^[a-f0-9]{64}$/)
      const snapshotArgs = ['--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256]
      assert.deepEqual(runSnapshot(['verify', ...snapshotArgs]), { verified: true, ...receipt })
      assert.deepEqual(runSnapshot(['restore', ...snapshotArgs, '--destination', destination]), {
        destination, manifestSha256: receipt.manifestSha256,
      })
      // Restore is a config-only copy retaining the original data binding, not activation.
      assert.deepEqual(await readdir(destination), ['config.env'])
      assert.deepEqual(await readFile(join(destination, 'config.env')), configBytes)
      assert.deepEqual(await readFile(configFile), configBytes)
      await assert.rejects(lstat(join(sourceData, 'runtime-instance.json')), { code: 'ENOENT' })
      await assert.rejects(lstat(data), { code: 'ENOENT' })
    }
    nextStage('bundled integration snapshot create/verify/restore-copy with empty PATH')
    {
      const snapshotRoot = join(temporary, 'integration snapshot fixture 中文')
      // Linux is a Darwin layout simulation; other runners use their native layout.
      const platform = process.platform === 'linux' ? 'darwin' : process.platform
      const integration = { platform, arch: process.arch, root: bundle, home: join(snapshotRoot, 'home'),
        ...(platform === 'win32' ? { appData: join(snapshotRoot, 'roaming'), localAppData: join(snapshotRoot, 'local') } : {}) }
      const snapshot = join(snapshotRoot, 'snapshot'), destination = join(snapshotRoot, 'recovery')
      const options = { env, cwd: temporary, encoding: 'utf8' as const, timeout: 60_000, maxBuffer: 64 * 1024 }
      // Inert synthetic artifacts exercise capture, not OS installation or activation.
      // Bundled APIs supply the fixed layout, receipt validation, and private Windows ACLs.
      const setupScript = `
        import {mkdir, writeFile} from 'node:fs/promises';
        import {dirname} from 'node:path';
        import {createHash} from 'node:crypto';
        import {describeNativeIntegration, parseNativeIntegrationReceipt} from ${JSON.stringify(pathToFileURL(join(bundle, 'scripts/install-native.ts')).href)};
        import {WINDOWS_AUMID} from ${JSON.stringify(pathToFileURL(join(bundle, 'src/windows-notification.ts')).href)};
        import {ensurePrivateDataDirectory} from ${JSON.stringify(pathToFileURL(join(bundle, 'src/private-directory.ts')).href)};
        const integration = ${JSON.stringify(integration)};
        await ensurePrivateDataDirectory(${JSON.stringify(snapshotRoot)});
        const {receiptPath, artifactPaths} = describeNativeIntegration(integration);
        const paths = artifactPaths.slice(0, -1), files = [];
        for (const path of paths) {
          await mkdir(dirname(path), {recursive:true, mode:0o700});
          const bytes = Buffer.from('inert packaged integration fixture 中文: ' + path);
          await writeFile(path, bytes, {mode:0o600});
          files.push({path, sha256:createHash('sha256').update(bytes).digest('hex')});
        }
        await ensurePrivateDataDirectory(dirname(receiptPath));
        const receipt = Buffer.from(JSON.stringify({schemaVersion:1, platform:integration.platform,
          root:integration.root, autostart:false,
          ...(integration.platform === 'win32' ? {notificationAumid:WINDOWS_AUMID} : {}), files}, null, 2) + '\\n');
        parseNativeIntegrationReceipt(receipt, integration);
        await writeFile(receiptPath, receipt, {mode:0o600});
        console.log(JSON.stringify([receiptPath, ...paths]));`
      const setup = spawnSync(binary, ['--experimental-transform-types', '--input-type=module', '-e', setupScript], options)
      assert.ifError(setup.error)
      assert.equal(setup.status, 0, setup.stderr)
      const paths: string[] = JSON.parse(setup.stdout)
      const before = await Promise.all(paths.map(async path => ({ bytes: await readFile(path), stat: await lstat(path, { bigint: true }) })))
      const context = ['--platform', platform, '--arch', process.arch, '--home', integration.home, '--root', bundle,
        ...(platform === 'win32' ? ['--app-data', integration.appData!, '--local-app-data', integration.localAppData!] : [])]
      const runSnapshot = (args: string[]) => {
        const result = spawnSync(binary, ['--experimental-transform-types', join(bundle, 'scripts/snapshot-native-integration.ts'), ...args, ...context], options)
        assert.ifError(result.error)
        assert.equal(result.status, 0, result.stderr)
        return JSON.parse(result.stdout)
      }
      const receipt = runSnapshot(['create', '--destination', snapshot])
      assert.deepEqual(Object.keys(receipt).sort(), ['manifestSha256', 'snapshot'])
      assert.equal(receipt.snapshot, snapshot)
      assert.match(receipt.manifestSha256, /^[a-f0-9]{64}$/)
      const snapshotArgs = ['--snapshot', snapshot, '--manifest-sha256', receipt.manifestSha256]
      assert.deepEqual(runSnapshot(['verify', ...snapshotArgs]), { verified: true, ...receipt })
      assert.deepEqual(runSnapshot(['restore-copy', ...snapshotArgs, '--destination', destination]), { destination, manifestSha256: receipt.manifestSha256 })
      assert.equal(await sha256(join(destination, 'manifest.json')), receipt.manifestSha256)
      assert.deepEqual(await readFile(join(destination, 'receipt.bin')), before[0]!.bytes)
      for (let index = 1; index < before.length; index++) assert.deepEqual(await readFile(join(destination, 'payload', `${index - 1}.bin`)), before[index]!.bytes)
      assert.deepEqual((await readdir(destination)).sort(), ['manifest.json', 'payload', 'receipt.bin'])
      for (const file of ['manifest.json', 'receipt.bin', ...(await readdir(join(snapshot, 'payload'))).map(name => join('payload', name))]) {
        assert.deepEqual(await readFile(join(destination, file)), await readFile(join(snapshot, file)))
        if (process.platform !== 'win32') assert.equal((await lstat(join(destination, file))).mode & 0o777, 0o600)
      }
      // Operational locking is allowed; original receipt/artifact bytes and metadata stay intact.
      for (const [index, path] of paths.entries()) {
        assert.deepEqual(await readFile(path), before[index]!.bytes)
        const after = await lstat(path, { bigint: true })
        for (const key of ['dev', 'ino', 'mode', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[index]!.stat[key])
      }
      assert.equal(await readFile(sentinel, 'utf8'), sentinelBytes)
      await assert.rejects(lstat(data), { code: 'ENOENT' })
    }
    nextStage('bundled recovery set create/verify with empty PATH')
    {
      const recoveryRoot = join(temporary, 'recovery fixture 中文')
      const configParent = join(recoveryRoot, 'private config'), sourceData = join(recoveryRoot, 'data')
      const configFile = join(configParent, 'original.env'), destination = join(recoveryRoot, 'recovery set')
      const configBytes = Buffer.from(`# Packaged recovery fixture 中文\nJARVIS_DATA_DIR="${sourceData}"\n`)
      const sample = join(sourceData, 'sample.txt'), sampleBytes = Buffer.from('packaged recovery data 中文\n')
      const options = { env, cwd: temporary, encoding: 'utf8' as const, timeout: 60_000, maxBuffer: 64 * 1024 }
      // Bundled permission setup also supplies private inherited Windows ACLs.
      const setupScript = `import {ensurePrivateDataDirectory} from ${JSON.stringify(pathToFileURL(join(bundle, 'src/private-directory.ts')).href)};for (const directory of ${JSON.stringify([recoveryRoot, configParent, sourceData])}) await ensurePrivateDataDirectory(directory);`
      const setup = spawnSync(binary, ['--experimental-transform-types', '--input-type=module', '-e', setupScript], options)
      assert.ifError(setup.error)
      assert.equal(setup.status, 0, setup.stderr)
      await writeFile(configFile, configBytes, { mode: 0o600 })
      await writeFile(sample, sampleBytes, { mode: 0o600 })
      const runRecovery = (args: string[]) => {
        const result = spawnSync(binary, ['--experimental-transform-types', join(bundle, 'scripts/recovery-native.ts'), ...args], options)
        assert.ifError(result.error)
        return result
      }
      const created = runRecovery(['create', '--bundle', bundle, '--bundle-manifest-sha256', manifestDigest,
        '--config', configFile, '--data', sourceData, '--destination', destination])
      // Preserve the archive's real identity: never turn development bytes into a release fixture.
      if (manifest.dirty === false && manifest.sourceTag === `v${manifest.version}` && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) {
        assert.equal(created.status, 0, created.stderr)
        const receipt = JSON.parse(created.stdout)
        assert.deepEqual(Object.keys(receipt).sort(), ['manifestSha256', 'recoverySet'])
        assert.equal(receipt.recoverySet, destination)
        assert.match(receipt.manifestSha256, /^[a-f0-9]{64}$/)
        assert.equal(await sha256(join(destination, 'recovery-manifest.json')), receipt.manifestSha256)
        const captured = JSON.parse(await readFile(join(destination, 'recovery-manifest.json'), 'utf8'))
        assert.deepEqual(captured.baseline, { root: bundle, manifestSha256: manifestDigest, version: manifest.version,
          sourceSha: manifest.sourceSha, platform: manifest.platform, arch: manifest.arch, runtime: manifest.runtime.version })
        assert.equal(captured.sourceConfigFile, configFile)
        assert.equal(captured.sourceDataDir, sourceData)
        assert.equal(captured.scope.activation, 'none')
        assert.equal(captured.scope.baselineBundle, 'not-copied-must-remain-available')
        // Keep the original baseline available and unchanged for actual CLI verification.
        const verified = runRecovery(['verify', '--recovery-set', destination, '--manifest-sha256', receipt.manifestSha256])
        assert.equal(verified.status, 0, verified.stderr)
        assert.deepEqual(JSON.parse(verified.stdout), { verified: true, ...receipt })
        console.log('[artifact] tagged baseline recovery create/verify passed; capture only, no activation')
      } else {
        assert.equal(created.status, 1, created.stderr)
        assert.equal(created.stdout, '')
        assert.match(created.stderr, /Native recovery failed: Incompatible release identity/)
        await assert.rejects(lstat(destination), { code: 'ENOENT' })
        console.log('[artifact] development baseline rejected for recovery; no successful create/verify coverage asserted')
      }
      assert.deepEqual(await readFile(configFile), configBytes)
      assert.deepEqual(await readFile(sample), sampleBytes)
      assert.equal(await sha256(join(bundle, 'manifest.json')), manifestDigest)
      await assert.rejects(lstat(join(sourceData, 'runtime-instance.json')), { code: 'ENOENT' })
      await assert.rejects(lstat(data), { code: 'ENOENT' })
    }
    nextStage('bundled updater rejects ineligible candidate with empty PATH')
    {
      const transaction = join(temporary, 'rejected update transaction 中文')
      // Equal-version rejection precedes overlap checks; this does not test successful staging.
      const result = spawnSync(binary, ['--experimental-transform-types', join(bundle, 'scripts/update-native.ts'),
        'stage', transaction, bundle, manifestDigest, bundle, manifestDigest],
      { env, cwd: temporary, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 })
      assert.ifError(result.error)
      assert.equal(result.signal, null)
      assert.equal(result.status, 1, result.stderr)
      assert.equal(result.stdout, '')
      const released = manifest.dirty === false && manifest.sourceTag === `v${manifest.version}` && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)
      assert.match(result.stderr, released ? /Candidate must have a strictly newer stable semver/ : /Incompatible release identity/)
      await assert.rejects(lstat(transaction), { code: 'ENOENT' })
      await assert.rejects(lstat(data), { code: 'ENOENT' })
      assert.equal(await sha256(join(bundle, 'manifest.json')), manifestDigest)
      assert.equal(await readFile(sentinel, 'utf8'), sentinelBytes)
      console.log(`[artifact] updater rejected ${released ? 'equal-version candidate' : 'development identity'} without a transaction`)
    }
    nextStage('bundled native helper with empty PATH')
    const helperRoot = join(temporary, 'approved files')
    await mkdir(helperRoot)
    await writeFile(join(helperRoot, 'hello.txt'), 'native scoped fixture')
    const helperScript = `import assert from 'node:assert/strict';import {NativeFilesystem} from ${JSON.stringify(pathToFileURL(join(bundle, 'src/local-tools/native-filesystem.ts')).href)};const {filesystem,roots}=await NativeFilesystem.start([${JSON.stringify(helperRoot)}]);try{assert.equal((await filesystem.read(roots[0],['hello.txt'])).toString(),'native scoped fixture');const result=await filesystem.list(roots[0],[]);assert.ok(result.entries.some(x=>x.name==='hello.txt'));}finally{await filesystem.disposeAsync()}`
    const helperResult = spawnSync(binary, ['--experimental-transform-types', '--input-type=module', '-e', helperScript], { env, cwd: temporary, encoding: 'utf8', timeout: 20_000 })
    assert.ifError(helperResult.error)
    assert.equal(helperResult.status, 0, helperResult.stderr)
    nextStage('bundled explicit read authorization with empty PATH')
    const readData = join(temporary, 'readonly private data')
    const fileScript = `import assert from 'node:assert/strict';import {ensurePrivateDataDirectory} from ${JSON.stringify(pathToFileURL(join(bundle, 'src/private-directory.ts')).href)};await ensurePrivateDataDirectory(${JSON.stringify(readData)});import {LocalToolSettings} from ${JSON.stringify(pathToFileURL(join(bundle, 'src/local-tools/settings.ts')).href)};import {FileTools} from ${JSON.stringify(pathToFileURL(join(bundle, 'src/local-tools/files.ts')).href)};const settings=new LocalToolSettings(${JSON.stringify(join(readData, 'readonly-test.json'))},${JSON.stringify(join(readData, 'readonly-output'))});await settings.load();await settings.update({expectedRevision:settings.snapshot().revision,readRoots:[${JSON.stringify(helperRoot)}]});const tools=new FileTools({settings}).definitions();const read=tools.find(x=>x.name==='file_read');assert.ok(read);if(process.platform!=='linux')assert.ok(!tools.some(x=>x.name==='file_write'));const result=await read.execute({path:${JSON.stringify(join(helperRoot, 'hello.txt'))}},{sessionId:'packaged',turnId:'packaged',callId:'packaged',signal:new AbortController().signal});assert.ok(!result.isError,result.content);assert.equal(JSON.parse(result.content).content,'native scoped fixture');`
    const fileResult = spawnSync(binary, ['--experimental-transform-types', '--input-type=module', '-e', fileScript], {env,cwd:temporary,encoding:'utf8',timeout:30_000})
    assert.ifError(fileResult.error)
    assert.equal(fileResult.status,0,fileResult.stderr)
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    let invocation = 0
    launch = args => {
      // PowerShell descendants may retain inherited capture-pipe handles after the
      // wrapper exits. Files preserve diagnostics without waiting for pipe EOF.
      const output = join(temporary, `launcher-${++invocation}.log`)
      const fd = openSync(output, 'wx', 0o600)
      try {
        const options = { env, cwd: temporary, encoding: 'utf8' as const, timeout: 55_000, stdio: ['ignore', fd, fd] as ['ignore', number, number] }
        const result = process.platform === 'win32'
          ? spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(bundle, 'Jarvis.ps1'), ...args], options)
          : spawnSync(join(bundle, 'jarvis'), args, options)
        return { ...result, stdout: readFileSync(output, 'utf8'), stderr: '' }
      } finally { closeSync(fd) }
    }
    nextStage('launcher startup (55s subprocess limit)')
    const started = launch(['--no-open'])
    assert.ifError(started.error)
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}\n${await readFile(join(data, 'launcher.log'), 'utf8').catch(() => '')}`)
    nextStage('authenticated health and version')
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${env.JARVIS_AUTH_TOKEN}` }, signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { version: string }).version, manifest.version)
    nextStage('launcher shutdown (55s subprocess limit)')
    const stopped = launch(['--stop'])
    assert.ifError(stopped.error)
    assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`)
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }))
  } finally {
    nextStage('cleanup shutdown and temporary files')
    launch?.(['--stop'])
    assert.ok(temporary.startsWith(join(tempRoot, 'Jarvis artifact 中文 ')) && temporary !== tempRoot && temporary.includes(sep))
    await rm(temporary, { recursive: true, force: true })
    nextStage('finished')
  }
})
