import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { test } from 'node:test'
import { sha256 } from '../scripts/packaging.ts'

const archiveInput = process.env.JARVIS_PACKAGE_ARCHIVE

// Separate from the startup artifact test: Windows ACL/COM operations are costly.
// Share an elapsed-time budget across extraction and all children, reserving 100s
// of the test deadline for integrity checks and cleanup. Individual phase caps stay
// unchanged. Keep the CLI a direct child so an observer cannot orphan it.
test('bundled transaction lifecycle with empty PATH (Linux verifies target refusal only)', { skip: !archiveInput, timeout: 1_200_000 }, async t => {
  const subprocessDeadline = performance.now() + 1_100_000
  const phaseTimeout = (cap: number) => {
    const remaining = Math.floor(subprocessDeadline - performance.now())
    assert.ok(remaining > 0, 'bundled lifecycle: cumulative subprocess budget exhausted')
    return Math.min(cap, remaining)
  }
  if (process.platform === 'linux') t.diagnostic('Native installer CLI success coverage skipped on Linux; requires Windows and macOS packaged runs.')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const filename = `jarvis-${process.env.JARVIS_RELEASE_VERSION ?? pkg.version}-${process.platform}-${process.arch}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`
  const archive = archiveInput === 'auto' ? resolve('dist', filename) : resolve(archiveInput!)
  const archiveDigest = (await readFile(`${archive}.sha256`, 'utf8')).split(/\s+/)[0]
  assert.equal(await sha256(archive), archiveDigest)
  const tempRoot = process.platform === 'win32' ? realpathSync.native(tmpdir()) : await realpath(tmpdir())
  const temporary = await mkdtemp(join(tempRoot, 'Jarvis transaction 中文 '))
  await chmod(temporary, 0o700)
  let completed = false
  try {
    const extracted = join(temporary, 'extracted app 空间')
    await mkdir(extracted, { mode: 0o700 })
    if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:ARCHIVE -DestinationPath $env:DEST -ErrorAction Stop'], { env: { ...process.env, ARCHIVE: archive, DEST: extracted }, timeout: phaseTimeout(150_000) })
    else execFileSync('tar', ['-xzf', archive, '-C', extracted], { timeout: phaseTimeout(150_000) })
    const roots = await readdir(extracted)
    assert.equal(roots.length, 1)
    const bundle = process.platform === 'win32' ? realpathSync.native(join(extracted, roots[0]!)) : await realpath(join(extracted, roots[0]!))
    const manifestPath = join(bundle, 'manifest.json')
    const manifestBytes = await readFile(manifestPath)
    const manifest = JSON.parse(manifestBytes.toString())
    assert.equal(manifest.platform, process.platform)
    assert.equal(manifest.arch, process.arch)
    const binary = join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
    const home = join(temporary, 'home'), appData = join(temporary, 'roaming'), localAppData = join(temporary, 'local')
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^JARVIS_|^NODE_|^PATH$|^HOME$|^USERPROFILE$|^APPDATA$|^LOCALAPPDATA$|^TMP$|^TEMP$|^TMPDIR$/i.test(key)))
    Object.assign(env, { PATH: '', HOME: join(temporary, 'ambient home'), USERPROFILE: join(temporary, 'ambient home'), APPDATA: join(temporary, 'ambient roaming'), LOCALAPPDATA: join(temporary, 'ambient local'), TMP: temporary, TEMP: temporary, TMPDIR: temporary, NODE_NO_WARNINGS: '1' })
    const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(bundle, name)).href)
    const script = `
      import assert from 'node:assert/strict';
      import {lstat, readFile, readdir, writeFile} from 'node:fs/promises';
      import {dirname, join, relative, isAbsolute} from 'node:path';
      import {createHash} from 'node:crypto';
      import {nativeIntegration, describeNativeIntegration} from ${moduleUrl('scripts/install-native.ts')};
      import {readNativeInstallTransaction} from ${moduleUrl('scripts/native-install-transaction-store.ts')};
      import {inspectNativeInstallTransaction} from ${moduleUrl('scripts/native-install-transaction-inspect.ts')};
      import {uninstallCompletedNativeInstallTransaction} from ${moduleUrl('scripts/native-install-completed-uninstall.ts')};
      import {ensurePrivateDataDirectory} from ${moduleUrl('src/private-directory.ts')};
      const temporary = ${JSON.stringify(temporary)};
      const integration = ${JSON.stringify({ platform: process.platform === 'linux' ? 'darwin' : process.platform, arch: process.arch, root: bundle, home, appData, localAppData })};
      const action = process.argv[1];
      const steps = {installs:0, cliInstalls:0, inspections:0, uninstalls:0, refusals:0};
      const hash = bytes => createHash('sha256').update(bytes).digest('hex');
      const absent = path => assert.rejects(lstat(path), {code:'ENOENT'});
      const contained = path => { const r = relative(temporary, path); assert.ok(r && !r.startsWith('..') && !isAbsolute(r)); };
      try {
        assert.equal(process.env.PATH, '');
        for (const path of [integration.home, integration.appData, integration.localAppData]) await ensurePrivateDataDirectory(path);
        const layout = describeNativeIntegration(integration);
        const control = join(dirname(layout.receiptPath), 'native-install-control');
        const stateFile = join(temporary, 'lifecycle-evidence.json');
        for (const path of [...layout.artifactPaths, layout.receiptPath, control]) contained(path);
        let state = await readFile(stateFile, 'utf8').then(JSON.parse).catch(error => { if(error.code === 'ENOENT') return {ids:[], archives:[]}; throw error; });
        const archivesIntact = async () => {
          for (const archive of state.archives) {
            contained(archive.path);
            assert.deepEqual((await readdir(archive.path)).sort(), Object.keys(archive.files).sort());
            for (const [name, digest] of Object.entries(archive.files)) assert.equal(hash(await readFile(join(archive.path, name))), digest);
          }
        };
        await archivesIntact();
        if (action === 'refuse') {
          // A Linux archive cannot satisfy the real producer's Darwin manifest validation.
          // Keep the archive and extracted manifest intact; this is not native coverage.
          await assert.rejects(nativeIntegration(integration, ['--install-transaction']), /Incompatible portable package manifest/);
          for (const path of [...layout.artifactPaths, layout.receiptPath]) await absent(path);
          assert.equal(await readNativeInstallTransaction({integration}), undefined);
          assert.deepEqual((await readdir(control)).filter(name => /^prepared-|^install-intent\\.json$/i.test(name)), []);
          steps.refusals++;
        } else if (action === 'install' || action === 'inspect-cli') {
          // No runPowerShell override: native Windows exercises the shipped COM implementation.
          if (action === 'install') {
            const installed = await nativeIntegration(integration, ['--install-transaction']);
            assert.deepEqual(installed, [...layout.artifactPaths.slice(0,-1), layout.receiptPath]);
          } else steps.cliInstalls++;
          steps.installs++;
          const transaction = await readNativeInstallTransaction({integration});
          assert.ok(transaction);
          // Startup creates the default data tree before acquiring lifecycle locks.
          // This checks startup residue, without claiming to monitor arbitrary launches.
          await absent(join(dirname(layout.receiptPath), 'data'));
          assert.equal(transaction.binding.root, integration.root);
          assert.equal(transaction.binding.autostart, false);
          assert.match(transaction.transactionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
          assert.ok(!state.ids.includes(transaction.transactionId));
          assert.equal((await inspectNativeInstallTransaction({integration})).declaration, 'matching');
          steps.inspections++;
          await absent(layout.artifactPaths.at(-1));
          state.ids.push(transaction.transactionId);
        } else {
          assert.equal(action, 'uninstall');
          const transaction = await readNativeInstallTransaction({integration});
          assert.ok(transaction);
          assert.equal(transaction.transactionId, state.ids.at(-1));
          const removed = await uninstallCompletedNativeInstallTransaction({integration, transactionId:transaction.transactionId});
          steps.uninstalls++;
          assert.deepEqual(removed.removedPaths, [...layout.artifactPaths.slice(0,-1), layout.receiptPath]);
          for (const path of [...layout.artifactPaths, layout.receiptPath]) await absent(path);
          assert.equal(await readNativeInstallTransaction({integration}), undefined);
          assert.deepEqual((await readdir(control)).filter(name => /^prepared-|^install-intent\\.json$/i.test(name)), []);
          contained(removed.archiveDirectory);
          const files = {};
          for (const name of await readdir(removed.archiveDirectory)) files[name] = hash(await readFile(join(removed.archiveDirectory,name)));
          assert.ok(files['prepared-transaction.json'] && files['prepared-completion.json'] && files['manifest.json']);
          const archived = JSON.parse(await readFile(join(removed.archiveDirectory,'prepared-transaction.json'),'utf8'));
          assert.equal(archived.transactionId, transaction.transactionId);
          state.archives.push({path:removed.archiveDirectory, files});
        }
        await archivesIntact();
        await writeFile(stateFile, JSON.stringify(state), {mode:0o600});
        console.log(JSON.stringify({status:action === 'refuse' ? 'target-refused' : 'ok', steps, ...(action === 'inspect-cli' ? {transactionId:state.ids.at(-1)} : {})}));
      } catch {
        console.log(JSON.stringify({status:'failed', steps}));
        process.exitCode = 1;
      }
    `
    const actions = process.platform === 'linux' ? ['refuse'] : ['install', 'uninstall', 'install-cli', 'inspect-cli', 'uninstall']
    let cliOutput: string | undefined
    for (const [index, action] of actions.entries()) {
      const started = performance.now()
      const isCli = action === 'install-cli'
      // Earlier observers establish the fixture roots. Only the actual CLI uses
      // them as account directories; observers retain separate ambient roots.
      const childEnv = isCli ? { ...env, HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData } : env
      const args = isCli
        ? ['--experimental-transform-types', join(bundle, 'scripts', 'install-native.ts'), '--install-transaction']
        : ['--experimental-transform-types', '--input-type=module', '-e', script, action]
      const result = spawnSync(binary, args, { env: childEnv, cwd: temporary, encoding: 'utf8', timeout: phaseTimeout(isCli ? 180_000 : 240_000), killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 16 * 1024 })
      // Emit only allowlisted phase metadata, including on failure; never child paths/output.
      console.log(JSON.stringify({ phase: action, sequence: index + 1, elapsedMs: Math.round(performance.now() - started), childSucceeded: !result.error && result.signal === null && result.status === 0 }))
      assert.ok(!result.error, `bundled ${action}: subprocess failed or exceeded deadline`)
      assert.equal(result.signal, null)
      assert.equal(result.status, 0, `bundled ${action}: unsuccessful child`)
      assert.ok(result.stderr === '', `bundled ${action}: unexpected stderr`)
      if (isCli) {
        cliOutput = result.stdout
        continue
      }
      let report
      try { report = JSON.parse(result.stdout) } catch { assert.fail(`bundled ${action}: invalid observer report`) }
      assert.ok(report !== null && typeof report === 'object', `bundled ${action}: invalid observer report`)
      if (action === 'inspect-cli') {
        assert.ok(typeof report.transactionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(report.transactionId), 'bundled inspect-cli: invalid transaction identifier')
      }
      const expectedReport = { status: action === 'refuse' ? 'target-refused' : 'ok', steps: { installs: Number(action === 'install' || action === 'inspect-cli'), cliInstalls: Number(action === 'inspect-cli'), inspections: Number(action === 'install' || action === 'inspect-cli'), uninstalls: Number(action === 'uninstall'), refusals: Number(action === 'refuse') }, ...(action === 'inspect-cli' ? { transactionId: report.transactionId } : {}) }
      assert.ok(isDeepStrictEqual(report, expectedReport), `bundled ${action}: unexpected observer report`)
      assert.ok(!result.stdout.includes(temporary))
      if (action === 'inspect-cli') {
        const expected = [
          `Install transaction: ${report.transactionId}. Retain this identifier for explicit completed-generation uninstall.`,
          'Installed per-user shortcuts. Keep this package folder in place. Login startup: disabled. No application was started.',
          ...(process.platform === 'darwin' ? ['This wrapper is unsigned and not notarized. macOS may block it or the downloaded runtime; no Gatekeeper or quarantine settings were changed.'] : [])
        ].join('\n') + '\n'
        // A boolean assertion keeps unexpected CLI output (including paths) private.
        assert.ok(cliOutput === expected, 'bundled install-cli: unexpected stdout')
      }
      console.log(JSON.stringify({ status: report.status, steps: report.steps }))
    }
    assert.deepEqual(await readFile(manifestPath), manifestBytes)
    assert.equal(await sha256(archive), archiveDigest)
    completed = true
  } finally {
    // A killed observer does not prove its descendants exited. On any failure,
    // retain the isolated tree rather than racing a late writer or erasing evidence.
    if (completed) {
      assert.equal(dirname(temporary), tempRoot)
      assert.equal(process.platform === 'win32' ? realpathSync.native(temporary) : await realpath(temporary), temporary)
      assert.ok(temporary.startsWith(join(tempRoot, 'Jarvis transaction 中文 ')))
      await rm(temporary, { recursive: true, force: true })
    } else console.log(JSON.stringify({ status: 'failed', isolatedEvidenceRetained: true }))
  }
})
