import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { nativeIntegration, parseArgs, POWERSHELL_LINK, shellQuote, validatePackage, windowsQuote, xml } from '../scripts/install-native.ts'
import type { InstallOptions, Platform } from '../scripts/install-native.ts'
import { WINDOWS_AUMID } from '../src/windows-notification.ts'

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
  await mkdir(join(data, '..'), { recursive: true }); await writeFile(data, 'private')
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
    writeFileSync(env.JARVIS_LINK_PATH!, JSON.stringify(env))
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
  await writeFile(receiptPath, JSON.stringify(receipt))
  await assert.rejects(nativeIntegration(options, ['--uninstall']), /Unsafe/)
}))

test('symlink integration ancestors are refused', { skip: process.platform === 'win32' }, async () => fixture('darwin', async options => {
  await mkdir(options.home)
  await symlink(options.root, join(options.home, 'Applications'))
  await assert.rejects(nativeIntegration(options, ['--install']), /symlink/)
}))
