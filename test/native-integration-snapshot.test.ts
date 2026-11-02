import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import childProcess, { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import fsPromises, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile, symlink, link } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { describeNativeIntegration, type InstallOptions } from '../scripts/install-native.ts'
import { createIntegrationSnapshot, restoreIntegrationSnapshot, verifyIntegrationSnapshot } from '../scripts/native-integration-snapshot.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'
import { sanitizeDiagnostic, type Diagnostic } from './fixtures/native-snapshot-diagnostic.ts'
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function fixture(platform: 'darwin' | 'win32', autostart: boolean, run: (value: { integration: InstallOptions; destination: string; receiptPath: string; artifactPaths: string[]; temp: string }) => Promise<void>) {
  const base = await realpath(tmpdir()), temp = await mkdtemp(join(base, 'integration-snapshot-'))
  const integration: InstallOptions = { platform, root: join(temp, 'package'), home: join(temp, 'home'), appData: join(temp, 'roaming'), localAppData: join(temp, 'local'), arch: process.arch, runPowerShell: () => { throw new Error('Must never activate') } }
  try {
    const layout = describeNativeIntegration(integration)
    const files: Array<{ path: string; sha256: string }> = []
    for (const path of autostart ? layout.artifactPaths : layout.artifactPaths.slice(0, -1)) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const bytes = platform === 'win32' ? Buffer.alloc(100 * 1024, 255) : Buffer.from([0, 255, 13, 10, files.length])
      await writeFile(path, bytes, { mode: 0o700 })
      files.push({ path, sha256: hash(bytes) })
    }
    await mkdir(dirname(layout.receiptPath), { recursive: true, mode: 0o700 })
    const receipt = { schemaVersion: 1, platform, root: integration.root, autostart, configFile: join(temp, 'config', 'secret.env'), dataDir: join(temp, 'data'), ...(platform === 'win32' ? { notificationAumid: WINDOWS_AUMID } : {}), files }
    await writeFile(layout.receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    await run({ integration, destination: join(temp, 'snapshot'), ...layout, temp })
  } finally {
    assert.equal(dirname(temp), base)
    assert.ok(temp.startsWith(join(base, 'integration-snapshot-')))
    await rm(temp, { recursive: true, force: true })
  }
}
for (const platform of ['darwin', 'win32'] as const) for (const autostart of [false, true]) test(`persistent ${platform} capture and offline verification, autostart=${autostart}`, async () => fixture(platform, autostart, async ({ integration, destination, receiptPath, artifactPaths, temp }) => {
  await mkdir(join(temp, 'config'))
  await writeFile(join(temp, 'config', 'secret.env'), 'SECRET_MUST_NOT_COPY', { mode: 0o600 })
  const environment = { ...process.env }, before = await lstat(receiptPath, { bigint: true })
  const result = await createIntegrationSnapshot({ integration, destination })
  assert.equal(result.manifest.artifacts.length, platform === 'darwin' ? 3 : 2)
  if (platform === 'win32') assert.equal(result.manifest.artifacts[0]!.bytes, 100 * 1024)
  assert.deepEqual(await readdir(destination), ['manifest.json', 'payload', 'receipt.bin'])
  assert.equal(result.manifest.binding.configFile, join(temp, 'config', 'secret.env'))
  assert.ok(!(await readFile(join(destination, 'receipt.bin'))).includes('SECRET_MUST_NOT_COPY'))
  const after = await lstat(receiptPath, { bigint: true })
  for (const key of ['ino', 'mode', 'mtimeNs', 'ctimeNs'] as const) assert.equal(before[key], after[key])
  assert.deepEqual({ ...process.env }, environment)
  for (const path of [receiptPath, ...(autostart ? artifactPaths : artifactPaths.slice(0, -1))]) await unlink(path)
  assert.deepEqual(await verifyIntegrationSnapshot({ snapshot: destination, manifestSha256: result.manifestSha256, integration }), result)
  await assert.rejects(verifyIntegrationSnapshot({ snapshot: destination, manifestSha256: result.manifestSha256, integration: { ...integration, home: join(temp, 'wrong'), appData: join(temp, 'wrong-roaming'), localAppData: join(temp, 'wrong-local') } }), /binding|path|receipt/)
}))
test('capture contends on the shared process lock before reading sources or creating destinations', { timeout: 120_000 }, async () => fixture('darwin', true, async ({ integration, destination, receiptPath, artifactPaths, temp }) => {
  const captured = await createIntegrationSnapshot({ integration, destination })
  const controlDirectory = join(dirname(receiptPath), 'native-install-control')
  const moduleUrl = new URL('../scripts/native-install-lock.ts', import.meta.url).href
  const child = spawn(process.execPath, ['--expose-gc', '--experimental-transform-types', '--input-type=module', '-e', `
    import { withNativeInstallLock } from ${JSON.stringify(moduleUrl)};
    await withNativeInstallLock({ controlDirectory: process.env.TEST_CONTROL }, async () => {
      await new Promise((resolve, reject) => {
        process.stdin.once('end', resolve);
        process.stdin.once('error', reject);
        process.stdin.on('data', () => { global.gc(); process.stdout.write('ALIVE\\n'); });
        process.stdout.write('READY\\n');
      });
    });
  `], { env: { ...process.env, NODE_NO_WARNINGS: '1', TEST_CONTROL: controlDirectory }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const exited = once(child, 'exit')
  function message(expected: string, request?: string) {
    return new Promise<void>((resolve, reject) => {
      let output = ''
      const cleanup = () => { child.stdout.off('data', onData); child.off('exit', onExit); child.off('error', onError) }
      const onData = (data: Buffer) => { output += data; if (output.includes(expected)) { cleanup(); resolve() } }
      const onExit = () => { cleanup(); reject(new Error(`Lock holder exited: ${stderr}`)) }
      const onError = (error: Error) => { cleanup(); reject(error) }
      child.stdout.on('data', onData); child.once('exit', onExit); child.once('error', onError)
      if (request) child.stdin.write(request)
    })
  }
  try {
    await message('READY')
    await message('ALIVE', 'GC and acknowledge\n')
    const original = fsPromises.lstat
    let sourceReads = 0
    fsPromises.lstat = (async (...args: Parameters<typeof original>) => {
      if ([receiptPath, ...artifactPaths].includes(String(args[0]))) sourceReads++
      return original(...args)
    }) as typeof original
    syncBuiltinESMExports()
    const contended = join(temp, 'contended')
    try { await assert.rejects(createIntegrationSnapshot({ integration, destination: contended }), /Another launcher is still working/) }
    finally { fsPromises.lstat = original; syncBuiltinESMExports() }
    assert.equal(sourceReads, 0)
    await assert.rejects(lstat(contended), { code: 'ENOENT' })
    await message('ALIVE', 'GC and acknowledge\n')
    assert.deepEqual(await verifyIntegrationSnapshot({ snapshot: destination, manifestSha256: captured.manifestSha256, integration }), captured)
    const recovery = await restoreIntegrationSnapshot({ snapshot: destination, manifestSha256: captured.manifestSha256, integration, destination: join(temp, 'recovery-while-locked') })
    assert.equal(recovery.manifestSha256, captured.manifestSha256)
    child.stdin.end()
    assert.deepEqual(await exited, [0, null])
    const retry = await createIntegrationSnapshot({ integration, destination: join(temp, 'retry') })
    assert.equal(retry.manifestSha256, captured.manifestSha256)
    assert.deepEqual(retry.manifest, captured.manifest)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
}))
test('invalid capture options and destination syntax do not create control files', async () => fixture('darwin', true, async ({ integration, destination, receiptPath }) => {
  const controlDirectory = join(dirname(receiptPath), 'native-install-control')
  await assert.rejects(createIntegrationSnapshot({ integration: { ...integration, root: 'relative' }, destination }))
  await assert.rejects(createIntegrationSnapshot({ integration, destination: 'relative' }), /canonical absolute/)
  await assert.rejects(lstat(controlDirectory), { code: 'ENOENT' })
  await assert.rejects(lstat(destination), { code: 'ENOENT' })
}))
test('missing owned artifacts persist as absence without a payload file', async () => fixture('darwin', true, async ({ integration, destination, artifactPaths }) => {
  await unlink(artifactPaths[0]!)
  const result = await createIntegrationSnapshot({ integration, destination })
  assert.deepEqual(result.manifest.artifacts[0], { path: artifactPaths[0], mode: null, bytes: null, sha256: null })
  assert.deepEqual(await readdir(join(destination, 'payload')), ['1.bin', '2.bin'])
}))
test('unowned startup and missing receipt fail before destination creation', async () => fixture('win32', false, async ({ integration, destination, artifactPaths, receiptPath }) => {
  await mkdir(dirname(artifactPaths[1]!), { recursive: true, mode: 0o700 })
  await writeFile(artifactPaths[1]!, 'unowned', { mode: 0o600 })
  await assert.rejects(createIntegrationSnapshot({ integration, destination }), /Unowned/)
  await assert.rejects(lstat(destination), { code: 'ENOENT' })
  await unlink(receiptPath)
  await assert.rejects(createIntegrationSnapshot({ integration, destination }), /receipt is required/)
}))
test('protected source overlap and existing destinations are rejected', async () => fixture('darwin', false, async ({ integration, destination, receiptPath, artifactPaths, temp }) => {
  for (const path of [join(dirname(receiptPath), 'snapshot'), join(dirname(receiptPath), 'native-install-control', 'snapshot'), join(dirname(artifactPaths[0]!), 'snapshot'), join(integration.root, 'snapshot'), join(temp, 'config', 'snapshot'), join(temp, 'data', 'snapshot')]) await assert.rejects(createIntegrationSnapshot({ integration, destination: path }), /overlaps/)
  await mkdir(destination)
  await assert.rejects(createIntegrationSnapshot({ integration, destination }), { code: 'EEXIST' })
}))
for (const tamper of ['payload', 'receipt', 'manifest', 'root-extra', 'payload-extra', 'missing', 'mode', 'hardlink', 'symlink'] as const) test(`verification rejects ${tamper} tampering`, { skip: process.platform === 'win32' && ['mode', 'symlink'].includes(tamper) }, async () => fixture('darwin', true, async ({ integration, destination, temp }) => {
  const result = await createIntegrationSnapshot({ integration, destination })
  const payload = join(destination, 'payload', '0.bin')
  if (tamper === 'payload') await writeFile(payload, 'altered')
  if (tamper === 'receipt') await writeFile(join(destination, 'receipt.bin'), '{}\n')
  if (tamper === 'manifest') await writeFile(join(destination, 'manifest.json'), '{}\n')
  if (tamper === 'root-extra') await writeFile(join(destination, 'extra'), '', { mode: 0o600 })
  if (tamper === 'payload-extra') await mkdir(join(destination, 'payload', 'extra'))
  if (tamper === 'missing') await unlink(payload)
  if (tamper === 'mode') await chmod(payload, 0o644)
  if (tamper === 'hardlink') await link(payload, join(temp, 'linked'))
  if (tamper === 'symlink') { await unlink(payload); await symlink(join(destination, 'receipt.bin'), payload) }
  await assert.rejects(verifyIntegrationSnapshot({ snapshot: destination, manifestSha256: result.manifestSha256, integration }))
}))
test('trusted edited manifest still cannot contradict receipt or invent original paths', async () => fixture('darwin', true, async ({ integration, destination }) => {
  const result = await createIntegrationSnapshot({ integration, destination })
  for (const edit of [(m: typeof result.manifest) => { m.artifacts[0]!.path = '/arbitrary' }, (m: typeof result.manifest) => { m.binding.root = '/other' }, (m: typeof result.manifest) => { m.artifacts[0]!.sha256 = '0'.repeat(64) }]) {
    const changed = structuredClone(result.manifest); edit(changed)
    const bytes = Buffer.from(JSON.stringify(changed) + '\n')
    await writeFile(join(destination, 'manifest.json'), bytes)
    await assert.rejects(verifyIntegrationSnapshot({ snapshot: destination, manifestSha256: hash(bytes), integration }))
  }
}))
test('verification never repairs shared directory permissions', { skip: process.platform === 'win32' }, async () => fixture('darwin', false, async ({ integration, destination }) => {
  const result = await createIntegrationSnapshot({ integration, destination })
  await chmod(destination, 0o755)
  await assert.rejects(verifyIntegrationSnapshot({ snapshot: destination, manifestSha256: result.manifestSha256, integration }), /private/)
  assert.equal((await lstat(destination)).mode & 0o777, 0o755)
}))
test('capture detects original mutation during final snapshot verification', async () => fixture('darwin', true, async ({ integration, destination, artifactPaths }) => {
  const original = fsPromises.open
  let changed = false
  fsPromises.open = (async (...args: Parameters<typeof original>) => {
    if (!changed && args[0] === join(destination, 'manifest.json') && typeof args[1] === 'number' && (args[1] & 3) === 0) {
      changed = true
      await unlink(artifactPaths[0]!)
    }
    return original(...args)
  }) as typeof original
  syncBuiltinESMExports()
  try { await assert.rejects(createIntegrationSnapshot({ integration, destination }), /changed during capture/); assert.ok(changed) }
  finally { fsPromises.open = original; syncBuiltinESMExports() }
}))
test('copy corruption fails before publishing the manifest and releases the capture lock', async () => fixture('darwin', true, async ({ integration, destination, temp }) => {
  const baseline = await createIntegrationSnapshot({ integration, destination: join(temp, 'baseline') })
  const original = fsPromises.open
  let changed = false
  fsPromises.open = (async (...args: Parameters<typeof original>) => {
    if (!changed && args[0] === join(destination, 'receipt.bin') && typeof args[1] === 'number' && (args[1] & 3) === 0) {
      changed = true
      await writeFile(join(destination, 'receipt.bin'), 'corrupt')
    }
    return original(...args)
  }) as typeof original
  syncBuiltinESMExports()
  try {
    await assert.rejects(createIntegrationSnapshot({ integration, destination }), /changed during read|Copied receipt/)
    assert.ok(changed)
    await assert.rejects(lstat(join(destination, 'manifest.json')), { code: 'ENOENT' })
  } finally { fsPromises.open = original; syncBuiltinESMExports() }
  const retry = await createIntegrationSnapshot({ integration, destination: join(temp, 'retry-after-failure') })
  assert.equal(retry.manifestSha256, baseline.manifestSha256)
  assert.deepEqual(retry.manifest, baseline.manifest)
}))
test('Windows permission process failures are sanitized at the public snapshot boundary', async () => fixture('win32', true, async ({ integration, destination }) => {
  const captured = await createIntegrationSnapshot({ integration, destination })
  const originalLstat = fsPromises.lstat, originalExecFile = childProcess.execFile
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const systemRoot = process.env.SystemRoot
  const cases: Array<{ fields: Record<string, unknown>; diagnostic: Diagnostic; unreadable?: 'accessor' | 'proxy' }> = [
    { fields: {}, diagnostic: { ok: false, kind: 'unknown' }, unreadable: 'accessor' },
    { fields: {}, diagnostic: { ok: false, kind: 'unknown' }, unreadable: 'proxy' },
    { fields: { code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' }, diagnostic: { ok: false, kind: 'timeout', code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' } },
    { fields: { code: null, killed: true, signal: 'SIGTERM' }, diagnostic: { ok: false, kind: 'terminated', killed: true, signal: 'SIGTERM' } },
    { fields: { code: 'SIGKILL', killed: true, signal: 'SIGKILL' }, diagnostic: { ok: false, kind: 'terminated', code: 'SIGKILL', killed: true, signal: 'SIGKILL' } },
    ...[0, 71, 255].map(code => ({ fields: { code, killed: false, signal: null }, diagnostic: { ok: false as const, kind: 'process-exit' as const, code, killed: false } })),
    { fields: { code: 'EACCES' }, diagnostic: { ok: false, kind: 'filesystem', code: 'EACCES' } },
    ...[-1, 256, 1.5, 'RAW_SECRET'.repeat(1000), { secret: 'RAW_SECRET' }].map(code => ({ fields: { code, killed: 'RAW_SECRET', signal: 'RAW_SECRET' }, diagnostic: { ok: false as const, kind: 'unknown' as const } })),
  ]
  try {
    process.env.SystemRoot = dirname(destination)
    // Enter the Windows-only check after real filesystem/path preflight. This
    // exercises the private helper on every host without exporting a test seam.
    fsPromises.lstat = (async (...args: Parameters<typeof originalLstat>) => {
      const result = await originalLstat(...args)
      if (args[0] === join(destination, 'payload') && typeof args[1] === 'object' && args[1]?.bigint) Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      return result
    }) as typeof originalLstat
    for (const { fields, diagnostic, unreadable } of cases) {
      let calls = 0, accessorReads = 0, encodedCommand = ''
      const raw = Object.assign(new Error('RAW_SECRET -EncodedCommand ' + 'X'.repeat(20_000)), fields, { cmd: 'RAW_SECRET', stdout: 'RAW_SECRET', stderr: 'RAW_SECRET', cause: new Error('RAW_SECRET') })
      childProcess.execFile = ((file: string, args: string[], options: childProcess.ExecFileOptions, callback: (error: Error, stdout: string, stderr: string) => void) => {
        calls++
        assert.equal(file, join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
        assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
        encodedCommand = args.at(-1)!
        const script = Buffer.from(encodedCommand, 'base64').toString('utf16le')
        assert.ok(script.includes('[IO.Directory]::GetAccessControl($p)'))
        assert.ok(script.includes('[IO.File]::GetAccessControl($p)'))
        assert.ok(script.includes('if ($c -eq $p) { $leafAttributes=$a }'))
        assert.ok(!script.includes('Get-Acl') && !script.includes('Import-Module'))
        assert.equal(options.timeout, 10_000)
        assert.equal(options.maxBuffer, 16 * 1024)
        assert.equal(options.windowsHide, true)
        assert.equal(options.shell, false)
        assert.deepEqual(JSON.parse(options.env!.JARVIS_INTEGRATION_PATHS!), [destination, join(destination, 'payload'), join(destination, 'manifest.json'), join(destination, 'receipt.bin')])
        raw.message += encodedCommand
        if (unreadable === 'accessor') Object.defineProperty(raw, 'code', { get() { accessorReads++; throw new Error('RAW_SECRET accessor failure') } })
        const rejection = unreadable === 'proxy' ? new Proxy(raw, { getOwnPropertyDescriptor() { throw new Error('RAW_SECRET descriptor failure') } }) : raw
        callback(rejection, 'RAW_SECRET stdout', 'RAW_SECRET stderr')
      }) as unknown as typeof originalExecFile
      syncBuiltinESMExports()
      await assert.rejects(verifyIntegrationSnapshot({ snapshot: destination, manifestSha256: captured.manifestSha256, integration }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.notEqual(error, raw)
        assert.equal(error.message, 'Native integration snapshot permission verification failed')
        assert.ok(error.message.length <= 512)
        assert.deepEqual(sanitizeDiagnostic(error), { ...diagnostic, kind: diagnostic.kind === 'unknown' ? 'validation' : diagnostic.kind, stage: 'integration-permission-check' })
        assert.deepEqual(Object.getOwnPropertyNames(error).sort(), ['message', 'stack', ...['code', 'killed', 'signal'].filter(key => Object.hasOwn(diagnostic, key))].sort())
        for (const text of [String(error), error.stack!, JSON.stringify(error)]) {
          assert.ok(!text.includes('RAW_SECRET'))
          assert.ok(!text.includes('-EncodedCommand'))
          assert.ok(!text.includes(encodedCommand))
        }
        assert.ok(error.stack!.includes('windowsPrivate'))
        return true
      })
      assert.equal(calls, 1, 'permission checks must not retry')
      assert.equal(accessorReads, 0, 'error metadata accessors must not execute')
      Object.defineProperty(process, 'platform', platform)
    }
  } finally {
    Object.defineProperty(process, 'platform', platform)
    if (systemRoot === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = systemRoot
    fsPromises.lstat = originalLstat
    childProcess.execFile = originalExecFile
    syncBuiltinESMExports()
  }
}))
test('native Windows verification accepts readonly private ACLs and rejects shared ACLs without repair', { skip: process.platform !== 'win32' }, async () => fixture('win32', true, async ({ integration, destination }) => {
  const result = await createIntegrationSnapshot({ integration, destination })
  const paths = [destination, join(destination, 'payload'), join(destination, 'manifest.json'), join(destination, 'receipt.bin'), join(destination, 'payload', '0.bin'), join(destination, 'payload', '1.bin')]
  const run = (action: string, selectedPaths = paths) => execFileSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(String.raw`$ErrorActionPreference='Stop'
$env:PSModulePath="$PSHOME\Modules"
Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($p in (ConvertFrom-Json $env:JARVIS_TEST_PATHS)) {
 $acl=Get-Acl -LiteralPath $p
 if ($env:JARVIS_TEST_ACTION -eq 'read') { Write-Output $acl.Sddl; continue }
 if ($env:JARVIS_TEST_ACTION -eq 'private') {
  $acl.SetAccessRuleProtection($true,$false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $rights=if ((Get-Item -LiteralPath $p).PSIsContainer) { 'ReadAndExecute' } else { 'Read' }
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user,$rights,'Allow'))
 }
 if ($env:JARVIS_TEST_ACTION -eq 'shared') { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow')) }
 if ($env:JARVIS_TEST_ACTION -eq 'restore') { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user,'FullControl','Allow')) }
 Set-Acl -LiteralPath $p -AclObject $acl
}`, 'utf16le').toString('base64')], { env: { ...process.env, JARVIS_TEST_PATHS: JSON.stringify(selectedPaths), JARVIS_TEST_ACTION: action }, encoding: 'utf8', timeout: 10_000, windowsHide: true })
  try {
    run('private')
    const before = run('read')
    await verifyIntegrationSnapshot({ snapshot: destination, manifestSha256: result.manifestSha256, integration })
    assert.equal(run('read'), before)
    // Isolate each kind: a shared directory must not mask an unchecked file ACL.
    for (const path of paths.toReversed()) {
      run('shared', [path])
      const shared = run('read')
      await assert.rejects(verifyIntegrationSnapshot({ snapshot: destination, manifestSha256: result.manifestSha256, integration }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'Native integration snapshot permission verification failed')
        const diagnostic = sanitizeDiagnostic(error)
        assert.equal(diagnostic.stage, 'integration-permission-check')
        assert.equal(diagnostic.kind, 'process-exit', 'termination or unrelated I/O must not satisfy ACL policy refusal')
        assert.equal(diagnostic.code, 71)
        return true
      })
      assert.equal(run('read'), shared)
      run('private', [path])
      assert.equal(run('read'), before)
    }
    await verifyIntegrationSnapshot({ snapshot: destination, manifestSha256: result.manifestSha256, integration })
    assert.equal(run('read'), before)
  } finally { run('restore') }
}))
test('private snapshots remain bounded when manifests are oversized', async () => fixture('win32', false, async ({ integration, destination }) => {
  const result = await createIntegrationSnapshot({ integration, destination })
  await writeFile(join(destination, 'manifest.json'), Buffer.alloc(16 * 1024 + 1))
  await assert.rejects(verifyIntegrationSnapshot({ snapshot: destination, manifestSha256: result.manifestSha256, integration }), /size limit/)
}))

for (const platform of ['darwin', 'win32'] as const) test(`restore ${platform} exports exact private recovery data without original sources`, async () => fixture(platform, true, async ({ integration, destination, receiptPath, artifactPaths, temp }) => {
  await unlink(artifactPaths.at(-1)!)
  if (process.platform !== 'win32') await chmod(artifactPaths[0]!, 0o1700)
  const captured = await createIntegrationSnapshot({ integration, destination })
  for (const path of [receiptPath, ...artifactPaths.slice(0, -1)]) await unlink(path)
  const recoveryParent = join(temp, 'exports')
  await mkdir(recoveryParent, { mode: 0o755 })
  const recovery = join(recoveryParent, 'recovery')
  const result = await restoreIntegrationSnapshot({ snapshot: destination, manifestSha256: captured.manifestSha256, integration, destination: recovery })
  assert.deepEqual(result, { destination: recovery, manifestSha256: captured.manifestSha256, manifest: captured.manifest })
  assert.equal(result.manifest.artifacts.at(-1)!.bytes, null)
  if (process.platform !== 'win32') assert.equal(result.manifest.artifacts[0]!.mode, 0o1700)
  const names = ['manifest.json', 'receipt.bin', ...captured.manifest.artifacts.flatMap((item, index) => item.bytes === null ? [] : [join('payload', `${index}.bin`)])]
  for (const name of names) {
    assert.deepEqual(await readFile(join(recovery, name)), await readFile(join(destination, name)))
    if (process.platform !== 'win32') assert.equal((await lstat(join(recovery, name))).mode & 0o7777, 0o600)
  }
  for (const path of [recovery, join(recovery, 'payload')]) if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o7777, 0o700)
  await assert.rejects(lstat(join(recovery, 'payload', `${artifactPaths.length - 1}.bin`)), { code: 'ENOENT' })
  await verifyIntegrationSnapshot({ snapshot: recovery, manifestSha256: captured.manifestSha256, integration })
  for (const path of [receiptPath, ...artifactPaths]) await assert.rejects(lstat(path), { code: 'ENOENT' })
}))
test('restore rejects existing and overlapping destinations without changing originals', async () => fixture('darwin', true, async ({ integration, destination, receiptPath, artifactPaths, temp }) => {
  const captured = await createIntegrationSnapshot({ integration, destination })
  const paths = [receiptPath, ...artifactPaths], before = await Promise.all(paths.map(path => readFile(path)))
  for (const target of [destination, join(destination, 'copy'), temp, join(dirname(receiptPath), 'copy'), join(dirname(artifactPaths[0]!), 'copy'), join(integration.root, 'copy'), join(temp, 'config', 'copy'), join(temp, 'data', 'copy')]) {
    await assert.rejects(restoreIntegrationSnapshot({ snapshot: destination, manifestSha256: captured.manifestSha256, integration, destination: target }), /overlaps/)
  }
  const existing = join(temp, 'existing')
  await mkdir(existing, { mode: 0o755 })
  await writeFile(join(existing, 'keep'), 'untouched')
  await assert.rejects(restoreIntegrationSnapshot({ snapshot: destination, manifestSha256: captured.manifestSha256, integration, destination: existing }), { code: 'EEXIST' })
  assert.equal(await readFile(join(existing, 'keep'), 'utf8'), 'untouched')
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before)
}))
test('restore rejects aliased protected ancestors before creating destination', { skip: process.platform === 'win32' }, async () => fixture('darwin', true, async ({ integration, destination, temp }) => {
  const captured = await createIntegrationSnapshot({ integration, destination })
  const target = join(temp, 'outside'), recovery = join(target, 'copy')
  await mkdir(target)
  await symlink(target, join(temp, 'config'))
  await assert.rejects(restoreIntegrationSnapshot({ snapshot: destination, manifestSha256: captured.manifestSha256, integration, destination: recovery }), /boundary|Noncanonical/)
  await assert.rejects(lstat(recovery), { code: 'ENOENT' })
}))
for (const tamper of ['digest', 'payload', 'options'] as const) test(`restore ${tamper} preflight leaves destination absent`, async () => fixture('win32', true, async ({ integration, destination, temp }) => {
  const captured = await createIntegrationSnapshot({ integration, destination }), recovery = join(temp, 'recovery')
  if (tamper === 'payload') await writeFile(join(destination, 'payload', '0.bin'), 'bad')
  await assert.rejects(restoreIntegrationSnapshot({ snapshot: destination, manifestSha256: tamper === 'digest' ? '0'.repeat(64) : captured.manifestSha256, integration: tamper === 'options' ? { ...integration, appData: join(temp, 'wrong-roaming'), localAppData: join(temp, 'wrong-local') } : integration, destination: recovery }))
  await assert.rejects(lstat(recovery), { code: 'ENOENT' })
}))
test('restore retains private partial destination on exclusive write failure', async () => fixture('darwin', true, async ({ integration, destination, temp }) => {
  const captured = await createIntegrationSnapshot({ integration, destination }), recovery = join(temp, 'recovery')
  const original = fsPromises.open
  fsPromises.open = (async (...args: Parameters<typeof original>) => {
    if (args[0] === join(recovery, 'payload', '0.bin')) throw new Error('injected write failure')
    return original(...args)
  }) as typeof original
  syncBuiltinESMExports()
  try { await assert.rejects(restoreIntegrationSnapshot({ snapshot: destination, manifestSha256: captured.manifestSha256, integration, destination: recovery }), /injected write failure/) }
  finally { fsPromises.open = original; syncBuiltinESMExports() }
  assert.deepEqual(await readdir(recovery), ['payload', 'receipt.bin'])
  if (process.platform !== 'win32') {
    assert.equal((await lstat(recovery)).mode & 0o7777, 0o700)
    assert.equal((await lstat(join(recovery, 'receipt.bin'))).mode & 0o7777, 0o600)
  }
}))
test('native Windows restore rejects aliased destination leaves before creation', { skip: process.platform !== 'win32' }, async () => fixture('win32', true, async ({ integration, destination, temp }) => {
  const captured = await createIntegrationSnapshot({ integration, destination })
  await assert.rejects(lstat(integration.root), { code: 'ENOENT' })
  const before = await readdir(temp)
  for (const target of [integration.root + '.', integration.root + ' ', join(temp, 'copy:stream'), ...['CON', 'NUL.txt', 'COM1', 'COM¹.txt', 'LPT³'].map(name => join(temp, name))]) {
    await assert.rejects(restoreIntegrationSnapshot({ snapshot: destination, manifestSha256: captured.manifestSha256, integration, destination: target }), /Windows path without aliases/)
    await assert.rejects(createIntegrationSnapshot({ integration, destination: target }), /Windows path without aliases/)
  }
  await assert.rejects(lstat(integration.root), { code: 'ENOENT' })
  assert.deepEqual(await readdir(temp), before)
}))
for (const mutation of ['before-read', 'after-copy', 'identity'] as const) test(`restore detects source mutation ${mutation}`, async () => fixture('darwin', true, async ({ integration, destination, temp }) => {
  const captured = await createIntegrationSnapshot({ integration, destination }), recovery = join(temp, 'recovery')
  const original = fsPromises.open
  let changed = false
  fsPromises.open = (async (...args: Parameters<typeof original>) => {
    const trigger = mutation === 'before-read' ? join(recovery, 'receipt.bin') : join(recovery, 'manifest.json')
    if (!changed && args[0] === trigger) {
      changed = true
      const path = join(destination, 'payload', '0.bin')
      await writeFile(path, mutation === 'identity' ? await readFile(path) : Buffer.from('changed'))
    }
    return original(...args)
  }) as typeof original
  syncBuiltinESMExports()
  try { await assert.rejects(restoreIntegrationSnapshot({ snapshot: destination, manifestSha256: captured.manifestSha256, integration, destination: recovery }), /checksum|changed during recovery/); assert.ok(changed) }
  finally { fsPromises.open = original; syncBuiltinESMExports() }
  assert.ok((await lstat(recovery)).isDirectory())
  if (mutation === 'before-read') await assert.rejects(lstat(join(recovery, 'payload', '0.bin')), { code: 'ENOENT' })
}))
