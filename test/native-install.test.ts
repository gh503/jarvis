import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import fsPromises, { chmod, link, lstat, mkdtemp, mkdir, open, readFile, realpath, rename, rm, truncate, unlink, writeFile, symlink } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { nativeIntegration, parseArgs, POWERSHELL_LINK, shellQuote, validatePackage, windowsQuote, xml } from '../scripts/install-native.ts'
import type { InstallOptions, Platform } from '../scripts/install-native.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'
import { ensurePrivateDataDirectory } from '../src/private-directory.ts'

async function fixture(platform: Platform, run: (options: InstallOptions) => Promise<void>, realRuntime = false) {
  const temporaryRoot = await realpath(tmpdir())
  const temp = await mkdtemp(join(temporaryRoot, 'jarvis native 中文 '))
  const root = join(temp, "package ' & $ folder")
  try {
    await mkdir(join(root, 'runtime'), { recursive: true })
    await mkdir(join(root, 'scripts'))
    await mkdir(join(root, 'src'))
    const paths = [`runtime/${platform === 'win32' ? 'node.exe' : 'node'}`, 'scripts/app.ts', 'scripts/install-native.ts', 'src/main.ts']
    const files = []
    for (const path of paths) {
      const content = realRuntime && path.startsWith('runtime/') ? await readFile(process.execPath) : Buffer.from(realRuntime && path === 'scripts/app.ts' ? "import { writeFileSync } from 'node:fs'; writeFileSync('shortcut-sentinel.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));" : 'fixture')
      await writeFile(join(root, path), content)
      files.push({ path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
    }
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, platform, arch: process.arch, runtime: { version: 'v24.14.0', platform, arch: process.arch }, files }))
    await run({ platform, root, home: join(temp, 'home'), appData: join(temp, 'roaming'), localAppData: join(temp, 'local'), arch: process.arch })
  } finally {
    assert.equal(temp.startsWith(join(temporaryRoot, 'jarvis native 中文 ')), true)
    await rm(temp, { recursive: true, force: true })
  }
}

test('native CLI requires explicit action and opt-in startup', () => {
  for (const args of [[], ['--autostart'], ['--install', '--uninstall'], ['--uninstall', '--autostart'], ['--install', '--install'], ['--install', '--force']]) assert.throws(() => parseArgs(args), /Usage/)
  assert.deepEqual(parseArgs(['--install']), { action: 'install', autostart: false })
  assert.deepEqual(parseArgs(['--install', '--autostart']), { action: 'install', autostart: true })
})

test('native CLI accepts config only once for install with an absolute path', () => {
  const file = join(tmpdir(), 'private config.env')
  assert.deepEqual(parseArgs(['--config', file, '--install', '--autostart']), { action: 'install', autostart: true, configFile: file })
  for (const args of [['--install', '--config'], ['--install', '--config', 'relative.env'], ['--install', '--config', file, '--config', file], ['--uninstall', '--config', file], ['--install', `--config=${file}`]]) assert.throws(() => parseArgs(args), /Usage/)
})

for (const platform of ['darwin', 'win32'] as const) test(`${platform} config binding reaches manual and startup launchers without secrets`, async () => fixture(platform, async options => {
  const privateDir = join(options.root, '..', 'private')
  // Canonicalize the parent: the loader rejects dot segments and symlink aliases.
  await ensurePrivateDataDirectory(privateDir)
  const file = join(await realpath(privateDir), "config ' & $ 中文.env")
  const dataDir = join(await realpath(privateDir), 'selected data')
  const secret = 'never-snapshot-this-token'
  const source = `JARVIS_DATA_DIR="${dataDir}"\nJARVIS_AUTH_TOKEN=${secret}\n`
  await writeFile(file, source, { mode: 0o600 })
  const calls: NodeJS.ProcessEnv[] = []
  options.runPowerShell = (script, env) => {
    assert.equal(script, POWERSHELL_LINK)
    assert.ok(!script.includes(file))
    calls.push(env)
    writeFileSync(env.JARVIS_LINK_PATH!, JSON.stringify(env), { mode: 0o644 })
  }
  const created = await nativeIntegration(options, ['--install', '--config', file, '--autostart'])
  const receipt = JSON.parse(await readFile(created.at(-1)!, 'utf8'))
  assert.equal(receipt.configFile, file)
  assert.equal(receipt.dataDir, dataDir)
  for (const path of created) assert.ok(!(await readFile(path, 'utf8')).includes(secret))
  if (platform === 'darwin') {
    const script = await readFile(created[1]!, 'utf8')
    assert.ok(script.includes(`${shellQuote('--config')} ${shellQuote(file)}`))
    const agent = await readFile(created[2]!, 'utf8')
    assert.ok(agent.includes(`<string>--config</string><string>${xml(file)}</string>`))
  } else {
    assert.equal(calls.length, 2)
    for (const call of calls) assert.ok(call.JARVIS_LINK_ARGS!.includes(`${windowsQuote('--config')} ${windowsQuote(file)}`))
  }
  // Editing configuration does not invalidate ownership of installed wrappers.
  await writeFile(file, source.replace(secret, 'updated-token'))
  await nativeIntegration(options, ['--uninstall'])
  assert.equal(await readFile(file, 'utf8'), source.replace(secret, 'updated-token'))
}))

test('invalid external configuration causes no integration mutations', async () => fixture('darwin', async options => {
  const dir = join(options.root, 'private')
  await ensurePrivateDataDirectory(dir)
  const file = join(dir, 'invalid.env')
  await writeFile(file, 'JARVIS_DATA_DIR=relative\n', { mode: 0o600 })
  await assert.rejects(nativeIntegration(options, ['--install', '--config', file]), /JARVIS_CONFIG_FILE/)
  assert.equal(existsSync(options.home), false)
  assert.equal(await readFile(file, 'utf8'), 'JARVIS_DATA_DIR=relative\n')
}))

test('quoting preserves shell and Windows argument boundaries and safe XML', () => {
  assert.equal(windowsQuote('C:\\a b\\'), '"C:\\a b\\\\"')
  assert.equal(windowsQuote('a"b'), '"a\\"b"')
  assert.equal(xml('<&"\'中文>'), '&lt;&amp;&quot;&apos;中文&gt;')
  assert.throws(() => xml('\u0001'), /control/)
  if (process.platform !== 'win32') {
    const value = "中文 ' $HOME `id` & spaces"
    assert.equal(execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' }), value)
  }
})

test('macOS install is inert, absolute, opt-in and uninstall preserves package/data', async () => fixture('darwin', async options => {
  const data = join(options.home, 'Library', 'Application Support', 'Jarvis', 'memory.db')
  await mkdir(join(data, '..'), { recursive: true, mode: 0o755 }); await writeFile(data, 'private')
  const created = await nativeIntegration(options, ['--install'])
  assert.equal(created.length, 3)
  const app = join(options.home, 'Applications', 'Jarvis.app')
  const script = await readFile(join(app, 'Contents', 'MacOS', 'Jarvis'), 'utf8')
  assert.ok(script.includes(shellQuote(join(options.root, 'runtime', 'node'))))
  assert.ok(script.includes(shellQuote(join(options.root, 'scripts', 'app.ts'))))
  assert.ok(!existsSync(join(options.home, 'Library', 'LaunchAgents', 'org.jarvis.portable.plist')))
  await assert.rejects(nativeIntegration(options, ['--install']), /already exists/)
  await nativeIntegration(options, ['--uninstall'])
  assert.equal(existsSync(app), false)
  assert.equal(await readFile(data, 'utf8'), 'private')
  assert.equal(await readFile(join(options.root, 'runtime', 'node'), 'utf8'), 'fixture')
  await nativeIntegration(options, ['--install', '--autostart'])
  const agent = join(options.home, 'Library', 'LaunchAgents', 'org.jarvis.portable.plist')
  const content = await readFile(agent, 'utf8')
  assert.ok(content.includes(xml(options.root)))
  assert.ok(content.includes('<string>--no-open</string>'))
  assert.ok(!content.includes('KeepAlive'))
  if (process.platform === 'darwin') execFileSync('/usr/bin/plutil', ['-lint', agent, join(app, 'Contents', 'Info.plist')])
  await nativeIntegration(options, ['--uninstall'])
  assert.deepEqual(await nativeIntegration(options, ['--uninstall']), [])
}))

test('Windows links use fixed PowerShell with data env and startup opt-in', async () => fixture('win32', async options => {
  const calls: NodeJS.ProcessEnv[] = []
  options.runPowerShell = (script, env) => {
    assert.equal(script, POWERSHELL_LINK)
    assert.ok(!script.includes(options.root))
    assert.equal(existsSync(env.JARVIS_LINK_PATH!), false, 'COM requires a nonexistent shortcut path')
    calls.push(env)
    writeFileSync(env.JARVIS_LINK_PATH!, JSON.stringify(env), { mode: 0o644 })
  }
  await nativeIntegration(options, ['--install'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.JARVIS_LINK_TARGET, join(options.root, 'runtime', 'node.exe'))
  assert.equal(calls[0]!.JARVIS_LINK_ARGS, ['--experimental-transform-types', join(options.root, 'scripts', 'app.ts')].map(windowsQuote).join(' '))
  await nativeIntegration(options, ['--uninstall'])
  calls.length = 0
  await nativeIntegration(options, ['--install', '--autostart'])
  assert.equal(calls.length, 2)
  assert.ok(calls[1]!.JARVIS_LINK_ARGS!.endsWith('"--no-open"'))
  await nativeIntegration(options, ['--uninstall'])
}))

test('Windows native COM generates inspectable temporary shortcuts only', { skip: process.platform !== 'win32' }, async () => fixture('win32', async options => {
  await nativeIntegration(options, ['--install', '--autostart'])
  const path = join(options.appData!, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Jarvis.lnk')
  // Reuse only the COM type declarations; inspection never invokes the production writer.
  const declarations = POWERSHELL_LINK.split("Add-Type -TypeDefinition @'\n")[1]!.split("\n'@")[0]!
  const inspect = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${declarations}
public static class InspectShortcut {
  public static string[] Read(string path) {
    object instance = new JarvisShellLink();
    try {
      ((System.Runtime.InteropServices.ComTypes.IPersistFile)instance).Load(path, 0);
      var link = (JarvisShellLinkW)instance;
      var target = new System.Text.StringBuilder(32768);
      var args = new System.Text.StringBuilder(32768);
      var cwd = new System.Text.StringBuilder(32768);
      link.GetPath(target, target.Capacity, System.IntPtr.Zero, 4);
      link.GetArguments(args, args.Capacity);
      link.GetWorkingDirectory(cwd, cwd.Capacity);
      return new string[] { target.ToString(), args.ToString(), cwd.ToString(), JarvisIdentity.Read(instance) };
    } finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(instance); }
  }
}
'@
$values = [InspectShortcut]::Read($env:JARVIS_TEST_LINK)
@{target=$values[0]; args=$values[1]; cwd=$values[2]; aumid=$values[3]} | ConvertTo-Json -Compress
# Independently activate the .lnk through Windows ShellExecute. The target script
# only writes a sentinel and exits: no Jarvis imports, browser or server.
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $env:JARVIS_TEST_LINK
$start.UseShellExecute = $true
$process = [System.Diagnostics.Process]::Start($start)
if ($null -ne $process) { if (!$process.WaitForExit(15000)) { throw 'Fixture shortcut activation timeout' }; if ($process.ExitCode -ne 0) { throw 'Fixture shortcut failed' } }
`
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(inspect, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, JARVIS_TEST_LINK: path, PSModulePath: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') }, timeout: 30000 }))
  assert.equal(result.target, join(options.root, 'runtime', 'node.exe'))
  assert.equal(result.cwd, options.root)
  assert.equal(result.aumid, WINDOWS_AUMID)
  assert.equal(result.args, ['--experimental-transform-types', join(options.root, 'scripts', 'app.ts'), '--no-open'].map(windowsQuote).join(' '))
  const sentinel = join(options.root, 'shortcut-sentinel.json')
  const deadline = Date.now() + 15000
  while (!existsSync(sentinel) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(JSON.parse(await readFile(sentinel, 'utf8')), { args: ['--no-open'], cwd: options.root })
  await nativeIntegration(options, ['--uninstall'])
}, true))

test('failed shortcut creation rolls back owned files', async () => fixture('win32', async options => {
  options.runPowerShell = () => { throw new Error('COM failed') }
  await assert.rejects(nativeIntegration(options, ['--install']), /COM failed/)
  assert.equal(existsSync(join(options.appData!, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Jarvis.lnk')), false)
}))

test('tampered runtime and unsafe manifest prevent integration writes', async () => fixture('darwin', async options => {
  await writeFile(join(options.root, 'runtime', 'node'), 'changed')
  await assert.rejects(nativeIntegration(options, ['--install']), /checksum/)
  assert.equal(existsSync(options.home), false)
  const path = join(options.root, 'manifest.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.files[0].path = '../outside'
  await writeFile(path, JSON.stringify(manifest))
  await assert.rejects(validatePackage(options.root, 'darwin', process.arch), /Unsafe/)
}))

test('uninstall refuses modified artifacts and forged deletion receipts', async () => fixture('darwin', async options => {
  await nativeIntegration(options, ['--install'])
  const script = join(options.home, 'Applications', 'Jarvis.app', 'Contents', 'MacOS', 'Jarvis')
  await writeFile(script, 'user modification')
  await assert.rejects(nativeIntegration(options, ['--uninstall']), /changed/)
  assert.equal(await readFile(script, 'utf8'), 'user modification')
  const receiptPath = join(options.home, 'Library', 'Application Support', 'Jarvis', 'native-install.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  receipt.files[0].path = join(options.root, 'runtime', 'node')
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  await assert.rejects(nativeIntegration(options, ['--uninstall']), /Unsafe/)
}))

test('new integrations remain removable under a group-writable creation mask', { skip: process.platform === 'win32' }, async () => {
  const previous = process.umask(0o002)
  try {
    for (const platform of ['darwin', 'win32'] as const) await fixture(platform, async options => {
      options.runPowerShell = (_script, env) => writeFileSync(env.JARVIS_LINK_PATH!, 'shortcut', { mode: 0o644 })
      const created = await nativeIntegration(options, ['--install', '--autostart'])
      await nativeIntegration(options, ['--uninstall'])
      for (const path of created) assert.equal(existsSync(path), false)
    })
  } finally { process.umask(previous) }
})

test('strict receipt validation rejects malformed shapes and missing bindings without deleting', async () => {
  for (const platform of ['darwin', 'win32'] as const) await fixture(platform, async options => {
    options.runPowerShell = (_script, env) => writeFileSync(env.JARVIS_LINK_PATH!, 'shortcut', { mode: 0o644 })
    const created = await nativeIntegration(options, ['--install', '--autostart'])
    const state = created.at(-1)!
    const original = JSON.parse(await readFile(state, 'utf8'))
    const mutations = [
      () => null, () => [], () => 'secret', () => ({ ...original, surprise: true }),
      () => ({ ...original, root: undefined }), () => ({ ...original, root: join(options.root, '..') + '/./package' }),
      () => ({ ...original, autostart: undefined }), () => ({ ...original, autostart: false }),
      () => ({ ...original, files: original.files.slice(1) }),
      () => ({ ...original, files: original.files.map(() => original.files[0]) }),
      () => ({ ...original, files: [null, ...original.files.slice(1)] }),
      () => ({ ...original, files: [{ ...original.files[0], extra: 1 }, ...original.files.slice(1)] }),
      () => ({ ...original, files: [{ ...original.files[0], sha256: 'A'.repeat(64) }, ...original.files.slice(1)] }),
      () => ({ ...original, configFile: options.root }),
      () => ({ ...original, dataDir: options.root }),
      () => ({ ...original, configFile: options.root, dataDir: 'relative' }),
      () => ({ ...original, configFile: options.root + '\0', dataDir: options.root }),
      () => ({ ...original, notificationAumid: 'forged' }),
      ...(platform === 'win32' ? [() => ({ ...original, notificationAumid: undefined })] : []),
    ]
    for (const mutation of mutations) {
      await writeFile(state, JSON.stringify(mutation(), null, 2) + '\n')
      await assert.rejects(nativeIntegration(options, ['--uninstall']), /^Error: Unsafe integration receipt$/)
      for (const path of created) assert.ok(existsSync(path))
    }
    await writeFile(state, '{"secret-not-for-errors":')
    await assert.rejects(nativeIntegration(options, ['--uninstall']), /^Error: Unsafe integration receipt$/)
    const validBytes = Buffer.from(JSON.stringify(original, null, 2) + '\n')
    await writeFile(state, validBytes.toString().replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,'))
    await assert.rejects(nativeIntegration(options, ['--uninstall']), /^Error: Unsafe integration receipt$/)
    const rootOffset = validBytes.indexOf(Buffer.from('"root": "')) + Buffer.byteLength('"root": "')
    assert.ok(rootOffset > 0)
    const invalidUtf8 = Buffer.concat([validBytes.subarray(0, rootOffset + 1), Buffer.from([0xff]), validBytes.subarray(rootOffset + 1)])
    assert.doesNotThrow(() => JSON.parse(invalidUtf8.toString('utf8')), 'lossy UTF-8 decoding would accept this JSON')
    await writeFile(state, invalidUtf8)
    await assert.rejects(nativeIntegration(options, ['--uninstall']), /^Error: Unsafe integration receipt$/)
    for (const path of created) assert.ok(existsSync(path))
    await writeFile(state, validBytes)
    await nativeIntegration(options, ['--uninstall'])
  })
})

for (const target of ['receipt', 'artifact'] as const) test(`uninstall bounds sparse ${target} before reading bytes`, async t => fixture('darwin', async options => {
  const created = await nativeIntegration(options, ['--install', '--autostart'])
  const path = target === 'receipt' ? created.at(-1)! : created.at(-2)!
  await truncate(path, 16 * 1024 * 1024)
  let opens = 0
  const original = fsPromises.open
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => { opens++; return original(...args) })
  syncBuiltinESMExports()
  try {
    await assert.rejects(nativeIntegration(options, ['--uninstall']), /size/)
    assert.equal(opens, target === 'receipt' ? 0 : 3, 'oversized file is rejected before opening or allocating its payload')
    for (const file of created) assert.ok(existsSync(file))
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

for (const target of ['receipt', 'artifact'] as const) test(`uninstall rejects linked ${target} without deleting other artifacts`, { skip: process.platform === 'win32' }, async () => fixture('darwin', async options => {
  const created = await nativeIntegration(options, ['--install', '--autostart'])
  const path = target === 'receipt' ? created.at(-1)! : created.at(-2)!
  const other = join(options.root, 'linked-sentinel')
  await link(path, other)
  await assert.rejects(nativeIntegration(options, ['--uninstall']), /links/)
  for (const file of created) assert.ok(existsSync(file))
  await unlink(other)
  await rename(path, other)
  await symlink(other, path)
  await assert.rejects(nativeIntegration(options, ['--uninstall']), /symlink/)
  assert.ok(existsSync(other))
  for (const file of created) assert.ok(existsSync(file))
}))

test('uninstall rejects directories and FIFOs before opening payloads', { skip: process.platform === 'win32' }, async () => fixture('darwin', async options => {
  const created = await nativeIntegration(options, ['--install', '--autostart'])
  const target = created.at(-2)!
  await rename(target, join(options.root, 'saved-artifact'))
  await mkdir(target, { mode: 0o755 })
  await assert.rejects(nativeIntegration(options, ['--uninstall']), /type/)
  // The exact integration path was just created as an empty directory.
  await fsPromises.rmdir(target)
  execFileSync('mkfifo', ['-m', '600', target])
  await assert.rejects(nativeIntegration(options, ['--uninstall']), /type/)
  for (const path of created) assert.ok(existsSync(path))
}))

test('uninstall preflight rejects last changed artifact and unsafe permissions without repair', { skip: process.platform === 'win32' }, async () => fixture('darwin', async options => {
  const created = await nativeIntegration(options, ['--install', '--autostart'])
  const last = created.at(-2)!, state = created.at(-1)!
  const original = await readFile(last)
  await writeFile(last, 'changed')
  await assert.rejects(nativeIntegration(options, ['--uninstall']), /changed/)
  for (const file of created) assert.ok(existsSync(file))
  await writeFile(last, original)
  for (const [path, mode] of [[last, 0o666], [state, 0o644], [join(options.home, 'Applications'), 0o777]] as const) {
    const previous = (await lstat(path)).mode & 0o777
    await chmod(path, mode)
    await assert.rejects(nativeIntegration(options, ['--uninstall']), /permissions/)
    assert.equal((await lstat(path)).mode & 0o777, mode)
    for (const file of created) assert.ok(existsSync(file))
    await chmod(path, previous)
  }
}))

test('uninstall revalidates identities after preflight even for same-byte replacements', async t => fixture('darwin', async options => {
  const created = await nativeIntegration(options, ['--install', '--autostart'])
  const originalOpen = fsPromises.open
  let opens = 0
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
    if (++opens === 5) {
      const bytes = await readFile(created[0]!)
      await rename(created[0]!, join(options.root, 'old-artifact'))
      await writeFile(created[0]!, bytes, { mode: 0o600 })
    }
    return originalOpen(...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(nativeIntegration(options, ['--uninstall']), /changed/)
    for (const path of created) assert.ok(existsSync(path))
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

for (const target of ['artifact', 'receipt'] as const) test(`uninstall detects ${target} mutation after an earlier unlink`, async t => fixture('darwin', async options => {
  const created = await nativeIntegration(options, ['--install', '--autostart'])
  const originalUnlink = fsPromises.unlink
  let calls = 0
  t.mock.method(fsPromises, 'unlink', async (path: Parameters<typeof unlink>[0]) => {
    await originalUnlink(path)
    if (++calls === 1) {
      const changed = target === 'artifact' ? created[1]! : created.at(-1)!
      const bytes = await readFile(changed)
      await rename(changed, join(options.root, 'old-file'))
      await writeFile(changed, bytes, { mode: 0o600 })
    }
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(nativeIntegration(options, ['--uninstall']), /changed/)
    assert.equal(existsSync(created[0]!), false, 'deletions are not transactional')
    assert.ok(existsSync(created.at(-1)!))
    if (target === 'artifact') for (const path of created.slice(1)) assert.ok(existsSync(path))
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('uninstall accepts missing artifacts and removed package; unsafe absent-state ancestors still fail', async () => fixture('darwin', async options => {
  const created = await nativeIntegration(options, ['--install'])
  await unlink(created[0]!)
  await rename(options.root, options.root + '-moved')
  assert.equal((await nativeIntegration(options, ['--uninstall'])).length, 2)
  assert.deepEqual(await nativeIntegration(options, ['--uninstall']), [])
  await writeFile(join(options.home, 'Applications', 'Jarvis.app'), 'not a directory')
  await assert.rejects(nativeIntegration(options, ['--uninstall']), /ancestor|ENOTDIR/)
}))

test('symlink integration ancestors are refused', { skip: process.platform === 'win32' }, async () => fixture('darwin', async options => {
  await mkdir(options.home)
  await symlink(options.root, join(options.home, 'Applications'))
  await assert.rejects(nativeIntegration(options, ['--install']), /symlink/)
}))
