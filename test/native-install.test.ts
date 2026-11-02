import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import fsPromises, { chmod, link, lstat, mkdtemp, mkdir, open, readFile, realpath, rename, rm, truncate, unlink, writeFile, symlink } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { createNativeInstallIntent } from '../scripts/native-install-intent.ts'
import { writeNativeInstallIntent } from '../scripts/native-install-intent-store.ts'
import { test } from 'node:test'
import { describeNativeIntegration, inspectNativeIntegration, nativeIntegration, parseArgs, POWERSHELL_LINK, renderNativeIntegration, shellQuote, validatePackage, windowsQuote, xml } from '../scripts/install-native.ts'
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

test('pure renderer preserves legacy bytes and quoting for nonexistent Unicode paths', { skip: process.platform === 'win32' }, () => {
  const options = { platform: 'darwin' as const, root: "/missing/中文 ' & $", home: '/missing/home' }
  const config = '/external/配置 "<&>.env'
  const plan = renderNativeIntegration(options, true, config)
  assert.equal(plan.platform, 'darwin')
  if (plan.platform !== 'darwin') return
  assert.deepEqual(plan.artifacts.map(({ path, mode }) => ({ path, mode })), [
    { path: '/missing/home/Applications/Jarvis.app/Contents/Info.plist', mode: 0o600 },
    { path: '/missing/home/Applications/Jarvis.app/Contents/MacOS/Jarvis', mode: 0o700 },
    { path: '/missing/home/Library/LaunchAgents/org.jarvis.portable.plist', mode: 0o600 },
  ])
  const header = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>'
  assert.deepEqual(plan.artifacts.map(artifact => artifact.bytes), [
    Buffer.from(header + '<key>CFBundleIdentifier</key><string>org.jarvis.portable</string><key>CFBundleName</key><string>Jarvis</string><key>CFBundleExecutable</key><string>Jarvis</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/></dict></plist>\n'),
    Buffer.from(String.raw`#!/bin/sh
set -eu
cd '/missing/中文 '\'' & $'
exec '/missing/中文 '\'' & $/runtime/node' '--experimental-transform-types' '/missing/中文 '\'' & $/scripts/app.ts' '--config' '/external/配置 "<&>.env'
`),
    Buffer.from(header + '<key>Label</key><string>org.jarvis.portable</string><key>ProgramArguments</key><array><string>/missing/中文 &apos; &amp; $/runtime/node</string><string>--experimental-transform-types</string><string>/missing/中文 &apos; &amp; $/scripts/app.ts</string><string>--config</string><string>/external/配置 &quot;&lt;&amp;&gt;.env</string><string>--no-open</string></array><key>WorkingDirectory</key><string>/missing/中文 &apos; &amp; $</string><key>RunAtLoad</key><true/></dict></plist>\n'),
  ])
  assert.deepEqual(renderNativeIntegration(options, false, config), { platform: 'darwin', artifacts: plan.artifacts.slice(0, 2) })
  const windows = { ...options, platform: 'win32' as const, appData: '/missing/roaming', localAppData: '/missing/local' }
  const expected = { path: '/missing/roaming/Microsoft/Windows/Start Menu/Programs/Jarvis.lnk', target: "/missing/中文 ' & $/runtime/node.exe", args: String.raw`"--experimental-transform-types" "/missing/中文 ' & $/scripts/app.ts" "--config" "/external/配置 \"<&>.env"`, cwd: options.root }
  assert.deepEqual(renderNativeIntegration(windows, false, config), { platform: 'win32', shortcuts: [expected] })
  assert.deepEqual(renderNativeIntegration(windows, true, config), { platform: 'win32', shortcuts: [expected, { ...expected, path: '/missing/roaming/Microsoft/Windows/Start Menu/Programs/Startup/Jarvis.lnk', args: expected.args + ' "--no-open"' }] })
  plan.artifacts[0]!.bytes.fill(0)
  assert.notDeepEqual(renderNativeIntegration(options, true, config), plan, 'each render owns its bytes')
})

test('Windows render descriptors preserve drive paths and trailing backslash quoting', () => {
  // The pure renderer does not read this synthetic path; path joins follow the host.
  const root = String.raw`C:\Portable Apps\中文`, home = String.raw`C:\Users\fixture`
  const options = { platform: 'win32' as const, root, home, appData: String.raw`C:\Users\fixture\AppData\Roaming`, localAppData: String.raw`C:\Users\fixture\AppData\Local` }
  const config = 'D:\\配置 folder\\'
  const plan = renderNativeIntegration(options, true, config)
  assert.equal(plan.platform, 'win32')
  if (plan.platform !== 'win32') return
  const expectedArgs = '"--experimental-transform-types" "' + join(root, 'scripts', 'app.ts') + '" "--config" "D:\\配置 folder\\\\"'
  assert.deepEqual(plan.shortcuts, [
    { path: join(options.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Jarvis.lnk'), target: join(root, 'runtime', 'node.exe'), args: expectedArgs, cwd: root },
    { path: join(options.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Jarvis.lnk'), target: join(root, 'runtime', 'node.exe'), args: expectedArgs + ' "--no-open"', cwd: root },
  ])
  assert.deepEqual(renderNativeIntegration(options, false, config), { platform: 'win32', shortcuts: plan.shortcuts.slice(0, 1) })
  assert.ok(plan.shortcuts.every(shortcut => !('bytes' in shortcut) && !('sha256' in shortcut)))
})

for (const platform of ['darwin', 'win32'] as const) for (const autostart of [false, true]) for (const configured of [false, true]) test(`${platform} installer consumes render plan (${autostart}, config ${configured})`, async () => fixture(platform, async options => {
  const privateDir = join(dirname(options.root), 'external 配置')
  await ensurePrivateDataDirectory(privateDir)
  const config = configured ? join(privateDir, "config ' & $.env") : undefined
  if (config) await writeFile(config, `JARVIS_DATA_DIR="${join(privateDir, 'data')}"\nJARVIS_AUTH_TOKEN=never-render-secret\n`, { mode: 0o600 })
  const plan = renderNativeIntegration(options, autostart, config)
  assert.deepEqual(renderNativeIntegration(options, autostart, config), plan)
  const calls: { target: string; args: string; cwd: string }[] = []
  options.runPowerShell = (script, env) => {
    assert.equal(script, POWERSHELL_LINK)
    assert.equal(existsSync(env.JARVIS_LINK_PATH!), false)
    for (const path of describeNativeIntegration(options).artifactPaths) assert.equal(existsSync(path), false, 'all COM generation precedes final publication')
    calls.push({ target: env.JARVIS_LINK_TARGET!, args: env.JARVIS_LINK_ARGS!, cwd: env.JARVIS_LINK_CWD! })
    writeFileSync(env.JARVIS_LINK_PATH!, Buffer.from([0, 255, calls.length]), { mode: 0o600 })
  }
  const created = await nativeIntegration(options, ['--install', ...(autostart ? ['--autostart'] : []), ...(config ? ['--config', config] : [])])
  const planned = plan.platform === 'darwin' ? plan.artifacts : plan.shortcuts
  assert.deepEqual(created.slice(0, -1), planned.map(artifact => artifact.path))
  if (plan.platform === 'darwin') {
    for (const artifact of plan.artifacts) {
      assert.deepEqual(await readFile(artifact.path), artifact.bytes)
      if (process.platform !== 'win32') assert.equal((await lstat(artifact.path)).mode & 0o777, artifact.mode & ~process.umask())
    }
  } else {
    assert.deepEqual(calls, plan.shortcuts.map(({ target, args, cwd }) => ({ target, args, cwd })))
    for (const [index, shortcut] of plan.shortcuts.entries()) assert.deepEqual(await readFile(shortcut.path), Buffer.from([0, 255, index + 1]))
  }
  const receipt = JSON.parse(await readFile(created.at(-1)!, 'utf8'))
  assert.deepEqual(receipt.files.map((entry: { path: string }) => entry.path), planned.map(artifact => artifact.path))
  for (const entry of receipt.files) assert.equal(entry.sha256, createHash('sha256').update(await readFile(entry.path)).digest('hex'))
  if (!autostart) assert.equal(existsSync(describeNativeIntegration(options).artifactPaths.at(-1)!), false)
  for (const path of created) assert.ok(!(await readFile(path)).includes('never-render-secret'))
}))

for (const platform of ['darwin', 'win32'] as const) for (const autostart of [false, true]) test(`${platform} inspection preserves exact bytes, modes and startup absence (${autostart})`, async () => fixture(platform, async options => {
  options.runPowerShell = (_script, env) => writeFileSync(env.JARVIS_LINK_PATH!, Buffer.from([0, 255, 13, 10]), { mode: 0o600 })
  const created = await nativeIntegration(options, ['--install', ...(autostart ? ['--autostart'] : [])])
  const before = await Promise.all(created.map(path => lstat(path, { bigint: true })))
  const environment = { ...process.env }
  const originalOptions = { ...options }
  options.runPowerShell = () => { throw new Error('inspection must not invoke COM') }
  const snapshot = await inspectNativeIntegration(options)
  assert.ok(snapshot)
  assert.equal(snapshot.platform, platform)
  assert.equal(snapshot.receiptPath, created.at(-1))
  assert.deepEqual(snapshot.receipt, await readFile(snapshot.receiptPath))
  assert.equal(snapshot.receiptMode, (await lstat(snapshot.receiptPath)).mode & 0o7777)
  assert.deepEqual(snapshot.binding, { root: options.root, autostart })
  assert.equal(snapshot.artifacts.length, platform === 'darwin' ? 3 : 2)
  for (const artifact of snapshot.artifacts) {
    if (!existsSync(artifact.path)) assert.deepEqual(artifact, { path: artifact.path, bytes: undefined, mode: undefined })
    else {
      assert.deepEqual(artifact.bytes, await readFile(artifact.path))
      assert.equal(artifact.mode, (await lstat(artifact.path)).mode & 0o7777)
      artifact.bytes!.fill(0)
    }
  }
  snapshot.receipt.fill(0)
  assert.ok((await inspectNativeIntegration(options))!.receipt.equals(await readFile(snapshot.receiptPath)))
  for (const [index, path] of created.entries()) {
    const after = await lstat(path, { bigint: true })
    for (const key of ['ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[index]![key])
  }
  assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(environment), 'inspection must preserve the environment')
  assert.deepEqual({ ...options, runPowerShell: originalOptions.runPowerShell }, originalOptions)
}))

for (const platform of ['darwin', 'win32'] as const) for (const kind of ['matching', 'different', 'partial', 'hardlink'] as const) test(`${platform} retained ${kind} intent blocks install and uninstall without changing integration`, async () => fixture(platform, async options => {
  options.runPowerShell = (_script, env) => writeFileSync(env.JARVIS_LINK_PATH!, 'fixture-link', { mode: 0o600 })
  const created = await nativeIntegration(options, ['--install'])
  const intent = createNativeInstallIntent({ integration: options, binding: { root: kind === 'different' ? join(options.root, 'other') : options.root, autostart: false } })
  await writeNativeInstallIntent({ integration: options, intent })
  const intentPath = join(dirname(describeNativeIntegration(options).receiptPath), 'native-install-control', 'install-intent.json')
  if (kind === 'partial') await writeFile(intentPath, '{')
  if (kind === 'hardlink') await link(intentPath, join(options.root, 'retained-intent-alias'))
  const paths = [...created, intentPath]
  const before = await Promise.all(paths.map(async path => ({ bytes: await readFile(path), stat: await lstat(path, { bigint: true }) })))
  options.runPowerShell = () => { throw new Error('must not invoke COM') }
  for (const action of ['--install', '--uninstall']) {
    await assert.rejects(nativeIntegration(options, [action]), kind === 'matching' || kind === 'different' ? /Existing native install intent requires review/ : () => true)
    for (const [index, path] of paths.entries()) {
      assert.deepEqual(await readFile(path), before[index]!.bytes)
      const after = await lstat(path, { bigint: true })
      for (const key of ['ino', 'mode', 'size', 'nlink', 'mtimeNs', 'ctimeNs'] as const) assert.equal(after[key], before[index]!.stat[key])
    }
  }
}))

for (const platform of ['darwin', 'win32'] as const) test(`${platform} unpublished intent refuses before package and config observations`, async () => fixture(platform, async options => {
  const intent = createNativeInstallIntent({ integration: options, binding: { root: options.root, autostart: false } })
  await writeNativeInstallIntent({ integration: options, intent })
  const layout = describeNativeIntegration(options)
  const intentPath = join(dirname(layout.receiptPath), 'native-install-control', 'install-intent.json')
  const before = await readFile(intentPath)
  let invoked = false
  options.runPowerShell = () => { invoked = true; throw new Error('must not invoke COM') }
  // Neither path exists: an intent must be rejected before either is inspected.
  const unavailable = { ...options, root: join(options.root, 'missing-package') }
  await assert.rejects(nativeIntegration(unavailable, ['--install', '--config', join(options.root, 'missing.env')]), /Existing native install intent requires review/)
  await assert.rejects(nativeIntegration(unavailable, ['--uninstall']), /Existing native install intent requires review/)
  assert.equal(invoked, false)
  assert.deepEqual(await readFile(intentPath), before)
  for (const path of [layout.receiptPath, ...layout.artifactPaths]) await assert.rejects(lstat(path), { code: 'ENOENT' })
}))

for (const platform of ['darwin', 'win32'] as const) test(`${platform} absent intent allows install uninstall reinstall`, async () => fixture(platform, async options => {
  options.runPowerShell = (_script, env) => writeFileSync(env.JARVIS_LINK_PATH!, 'fixture-link', { mode: 0o600 })
  const first = await nativeIntegration(options, ['--install'])
  await nativeIntegration(options, ['--uninstall'])
  for (const path of first) assert.equal(existsSync(path), false)
  assert.deepEqual(await nativeIntegration(options, ['--install']), first)
}))

test('inspection preserves read-only receipt and special permission bits', { skip: process.platform === 'win32' }, async () => fixture('darwin', async options => {
  const created = await nativeIntegration(options, ['--install'])
  await chmod(created.at(-1)!, 0o400)
  await chmod(created[1]!, 0o4700)
  const snapshot = await inspectNativeIntegration(options)
  assert.equal(snapshot!.receiptMode, 0o400)
  assert.equal(snapshot!.artifacts[1]!.mode, 0o4700)
}))

test('inspection accepts missing receipt without probing unowned artifact locations', async () => fixture('darwin', async options => {
  await mkdir(options.home, { mode: 0o755 })
  await writeFile(join(options.home, 'Applications'), 'unowned ancestor')
  assert.equal(await inspectNativeIntegration(options), undefined)
}))

test('inspection preserves missing mandatory artifacts and removed package/config bindings', async () => fixture('darwin', async options => {
  const privateDir = join(options.root, 'private')
  await ensurePrivateDataDirectory(privateDir)
  const configFile = join(privateDir, 'config.env'), dataDir = join(privateDir, 'data')
  await writeFile(configFile, `JARVIS_DATA_DIR="${dataDir}"\nJARVIS_AUTH_TOKEN=not-returned\n`, { mode: 0o600 })
  const created = await nativeIntegration(options, ['--install', '--config', configFile])
  await unlink(created[0]!)
  await rename(options.root, options.root + '-removed')
  const snapshot = await inspectNativeIntegration({ ...options, root: options.root + '-unrelated' })
  assert.ok(snapshot)
  assert.deepEqual(snapshot.binding, { root: options.root, autostart: false, configFile, dataDir })
  assert.deepEqual(snapshot.artifacts[0], { path: created[0], bytes: undefined, mode: undefined })
  assert.ok(!snapshot.receipt.includes('not-returned'))
}))

for (const platform of ['darwin', 'win32'] as const) test(`${platform} inspection rejects unowned startup while uninstall leaves it alone`, async () => fixture(platform, async options => {
  options.runPowerShell = (_script, env) => writeFileSync(env.JARVIS_LINK_PATH!, 'shortcut', { mode: 0o600 })
  await nativeIntegration(options, ['--install'])
  const startup = (await inspectNativeIntegration(options))!.artifacts.at(-1)!.path
  await mkdir(join(startup, '..'), { recursive: true, mode: 0o755 })
  await writeFile(startup, 'unowned', { mode: 0o600 })
  await assert.rejects(inspectNativeIntegration(options), /Unowned/)
  await nativeIntegration(options, ['--uninstall'])
  assert.equal(await readFile(startup, 'utf8'), 'unowned')
}))

for (const scenario of ['artifact replacement', 'receipt replacement', 'missing reappearance', 'optional appearance', 'artifact disappearance'] as const) test(`inspection detects ${scenario} between reads`, async t => fixture('darwin', async options => {
  const created = await nativeIntegration(options, ['--install'])
  const first = created[0]!, state = created.at(-1)!
  const startup = (await inspectNativeIntegration(options))!.artifacts.at(-1)!.path
  const saved = await readFile(first)
  if (scenario === 'missing reappearance') await unlink(first)
  const originalOpen = fsPromises.open
  let injected = false
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await originalOpen(...args)
    // Last listed artifact closes after its initial bounded read; inventory and
    // final revalidation follow. Mutation here is deterministic and uses no timer.
    if (args[0] === created[1] && !injected) {
      const close = handle.close.bind(handle)
      t.mock.method(handle, 'close', async () => {
        await close()
        injected = true
        if (scenario === 'missing reappearance') await writeFile(first, saved, { mode: 0o600 })
        else if (scenario === 'optional appearance') {
          // Introduce after the initial absent inventory read instead, below.
        } else if (scenario === 'artifact disappearance') await unlink(first)
        else {
          const target = scenario === 'receipt replacement' ? state : first
          const bytes = await readFile(target)
          await rename(target, join(options.root, 'saved-integration'))
          await writeFile(target, bytes, { mode: 0o600 })
        }
      })
    } else if (args[0] === first && injected && scenario === 'optional appearance') {
      await mkdir(join(startup, '..'), { recursive: true, mode: 0o755 })
      await writeFile(startup, 'new startup', { mode: 0o600 })
    }
    return handle
  })
  syncBuiltinESMExports()
  try { await assert.rejects(inspectNativeIntegration(options), /changed/); assert.ok(injected) }
  finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('inspection rejects noncanonical option paths before reads', async () => fixture('darwin', async options => {
  for (const key of ['root', 'home', 'appData', 'localAppData'] as const) {
    await assert.rejects(inspectNativeIntegration({ ...options, [key]: options[key] + '/.' }), /option path/)
  }
}))

for (const platform of ['darwin', 'win32'] as const) test(`${platform} option validation precedes configuration reads and mutations`, async () => fixture(platform, async options => {
  options.runPowerShell = () => { throw new Error('invalid options must not invoke COM') }
  const missingConfig = join(options.root, 'missing-config.env')
  for (const key of ['root', 'home', 'appData', 'localAppData'] as const) {
    const base = options[key]!
    const invalid: unknown[] = ['relative', '', null, 42, base + sep + '.', base + sep + '..' + sep + 'other', base + '\0', base + '\r', base + '\n', base + '\t', base + '\x01', base + '\x1f', base + '\x7f', base + '\ud800', base + '\udfff', base + '\ud800x\udfff', base + '中'.repeat(1400)]
    if (key === 'root' || key === 'home' || platform === 'win32') invalid.push(undefined)
    for (const value of invalid) {
      const bad = { ...options, [key]: value } as InstallOptions
      assert.throws(() => describeNativeIntegration(bad), /option path/)
      for (const args of [['--install'], ['--install', '--config', missingConfig], ['--uninstall']]) {
        await assert.rejects(nativeIntegration(bad, args), /option path/)
      }
    }
  }
  const unsupported = { ...options, platform: 'linux' } as unknown as InstallOptions
  assert.throws(() => describeNativeIntegration(unsupported), /Unsupported integration platform/)
  for (const args of [['--install', '--config', missingConfig], ['--uninstall']]) await assert.rejects(nativeIntegration(unsupported, args), /Unsupported integration platform/)
  for (const path of [options.home, options.appData!, options.localAppData!]) assert.equal(existsSync(path), false)
  assert.equal(await readFile(join(options.root, 'scripts', 'app.ts'), 'utf8'), 'fixture')
}))

test('pure option validation permits missing roots and well-formed Unicode with conditional app-data fields', async () => fixture('darwin', async options => {
  const optional = { ...options, appData: undefined, localAppData: undefined, root: join(options.root, 'missing-😀') }
  assert.doesNotThrow(() => describeNativeIntegration(optional))
  assert.deepEqual(await nativeIntegration(optional, ['--uninstall']), [])
  const boundary = options.root + 'a'.repeat(4096 - Buffer.byteLength(options.root))
  assert.doesNotThrow(() => describeNativeIntegration({ ...optional, root: boundary }))
  assert.throws(() => describeNativeIntegration({ ...optional, root: boundary + 'a' }), /option path/)
}))

test('mock Windows options retain host path semantics', { skip: process.platform === 'win32' }, async () => fixture('win32', async options => {
  assert.doesNotThrow(() => describeNativeIntegration({ ...options, root: join(options.root, 'NUL', 'COM¹', 'with:colon', 'trailing.') }))
}))

test('native Windows rejects path aliases before creating missing destination directories', { skip: process.platform !== 'win32' }, async () => fixture('win32', async options => {
  options.runPowerShell = () => { throw new Error('invalid options must not invoke COM') }
  for (const key of ['root', 'home', 'appData', 'localAppData'] as const) {
    const missing = join(options.root, `missing-${key}`)
    const aliases = [missing + '.', missing + ' ', missing + ':stream', missing.replaceAll('\\', '/'), '\\\\server\\share\\missing', '\\\\?\\' + missing,
      ...['CON', 'prn.txt', 'AUX', 'nul', 'COM1', 'LPT9.log', 'COM¹', 'COM².txt', 'COM³', 'LPT¹', 'LPT².txt', 'LPT³'].map(name => join(missing, name, 'child'))]
    for (const path of aliases) {
      const bad = { ...options, [key]: path }
      assert.throws(() => describeNativeIntegration(bad), /option path/)
      for (const args of [['--install'], ['--install', '--config', join(options.root, 'missing-config.env')], ['--uninstall']]) await assert.rejects(nativeIntegration(bad, args), /option path/)
      assert.equal(existsSync(missing), false)
    }
  }
  for (const path of [options.home, options.appData!, options.localAppData!]) assert.equal(existsSync(path), false)
  assert.equal(await readFile(join(options.root, 'scripts', 'app.ts'), 'utf8'), 'fixture')
}))

for (const platform of ['darwin', 'win32'] as const) test(`${platform} uninstall allows a different nonexistent package root`, async () => fixture(platform, async options => {
  options.runPowerShell = (_script, env) => writeFileSync(env.JARVIS_LINK_PATH!, 'shortcut', { mode: 0o600 })
  const created = await nativeIntegration(options, ['--install'])
  await rename(options.root, options.root + '-moved')
  await nativeIntegration({ ...options, root: options.root + '-unrelated' }, ['--uninstall'])
  for (const path of created) assert.equal(existsSync(path), false)
}))

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
  const layout = describeNativeIntegration(options)
  for (const path of [layout.receiptPath, ...layout.artifactPaths]) assert.equal(existsSync(path), false)
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

for (const platform of ['darwin', 'win32'] as const) test(`${platform} invalid prepared receipt refuses before final artifact creation`, async t => fixture(platform, async options => {
  const { receiptPath, artifactPaths } = describeNativeIntegration(options)
  options.runPowerShell = (_script, env) => writeFileSync(env.JARVIS_LINK_PATH!, 'prepared shortcut', { mode: 0o600 })
  const originalStringify = JSON.stringify, originalOpen = fsPromises.open
  let injected = false
  const finalWrites: string[] = []
  t.mock.method(JSON, 'stringify', ((value: unknown, replacer: never, space: number) => {
    if (!injected && value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 1 && (value as { root?: unknown }).root === options.root && Object.hasOwn(value, 'autostart') && space === 2) {
      injected = true
      return originalStringify({ ...value, files: [] }, replacer, space)
    }
    return originalStringify(value, replacer, space)
  }) as typeof JSON.stringify)
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
    if (args[1] === 'wx' && [receiptPath, ...artifactPaths].includes(String(args[0]))) finalWrites.push(String(args[0]))
    return originalOpen(...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(nativeIntegration(options, ['--install', '--autostart']), /Unsafe integration receipt/)
    assert.equal(injected, true)
    assert.deepEqual(finalWrites, [], 'validation must precede publication, not merely roll it back')
    for (const path of [receiptPath, ...artifactPaths]) assert.equal(existsSync(path), false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

for (const scenario of ['second output', 'receipt', 'replacement', 'modification', 'unlink failure', 'partial write', 'partial receipt'] as const) test(`install rollback protects ownership after ${scenario}`, async t => fixture('darwin', async options => {
  const first = join(options.home, 'Applications', 'Jarvis.app', 'Contents', 'Info.plist')
  const second = join(options.home, 'Applications', 'Jarvis.app', 'Contents', 'MacOS', 'Jarvis')
  const state = join(options.home, 'Library', 'Application Support', 'Jarvis', 'native-install.json')
  const originalOpen = fsPromises.open, originalUnlink = fsPromises.unlink
  const failure = new Error('injected publication failure')
  const cleanupFailure = new Error('injected unlink failure')
  let replacementIdentity: Awaited<ReturnType<typeof lstat>> | undefined
  const attempted: string[] = []
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
    const [path, flags] = args
    if (flags === 'wx' && path === (scenario === 'receipt' || scenario === 'partial receipt' || scenario === 'unlink failure' ? state : second)) {
      assert.ok(existsSync(first), 'first artifact must actually have been published')
      if (scenario === 'replacement') {
        const bytes = await readFile(first)
        await rename(first, join(options.root, 'saved-first'))
        await writeFile(first, bytes, { mode: 0o600 })
        replacementIdentity = await lstat(first)
      }
      if (scenario === 'modification') await writeFile(first, 'foreign modification')
      if (scenario === 'partial write' || scenario === 'partial receipt') {
        const handle = await originalOpen(...args)
        t.mock.method(handle, 'writeFile', async () => {
          await handle.write('uncertain partial')
          throw failure
        })
        return handle
      }
      throw failure
    }
    return originalOpen(...args)
  })
  t.mock.method(fsPromises, 'unlink', async (path: Parameters<typeof unlink>[0]) => {
    attempted.push(String(path))
    if (scenario === 'unlink failure' && path === second) throw cleanupFailure
    return originalUnlink(path)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(nativeIntegration(options, ['--install']), (error: unknown) => {
      if (['replacement', 'modification', 'unlink failure', 'partial write', 'partial receipt'].includes(scenario)) {
        assert.ok(error instanceof AggregateError)
        assert.equal(error.cause, failure)
        assert.equal(error.errors[0], failure)
        assert.match(error.message, /injected publication failure/)
        assert.ok(error.message.includes(JSON.stringify(scenario === 'partial receipt' ? state : scenario === 'partial write' || scenario === 'unlink failure' ? second : first)))
        assert.ok(error.message.length < 5000)
      } else assert.equal(error, failure)
      return true
    })
    assert.equal(existsSync(state), scenario === 'partial receipt')
    if (scenario === 'partial receipt') {
      assert.equal(await readFile(state, 'utf8'), 'uncertain partial')
      assert.ok(!attempted.includes(state))
    }
    if (scenario === 'replacement') assert.equal((await lstat(first)).ino, replacementIdentity!.ino)
    else if (scenario === 'modification') assert.equal(await readFile(first, 'utf8'), 'foreign modification')
    else assert.equal(existsSync(first), false)
    if (scenario === 'unlink failure') {
      assert.deepEqual(attempted, [second, first], 'rollback continues after the first unlink failure')
      assert.ok(existsSync(second))
    } else if (scenario === 'partial write') {
      assert.equal(await readFile(second, 'utf8'), 'uncertain partial')
      assert.ok(!attempted.includes(second), 'unknown partial bytes must never be unlinked')
      if (process.platform !== 'win32') assert.equal((await lstat(second)).mode & 0o077, 0)
    } else assert.equal(existsSync(second), false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

for (const scenario of ['second shortcut', 'partial shortcut publication'] as const) test(`Windows rollback handles ${scenario} failure`, async t => fixture('win32', async options => {
  const menu = join(options.appData!, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const first = join(menu, 'Jarvis.lnk'), second = join(menu, 'Startup', 'Jarvis.lnk')
  let calls = 0
  const failure = new Error('injected shortcut failure')
  options.runPowerShell = (_script, env) => {
    if (++calls === 2 && scenario === 'second shortcut') throw failure
    writeFileSync(env.JARVIS_LINK_PATH!, 'shortcut', { mode: 0o644 })
  }
  const originalOpen = fsPromises.open
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await originalOpen(...args)
    if (args[0] === second && args[1] === 'wx' && scenario === 'partial shortcut publication') {
      t.mock.method(handle, 'writeFile', async () => {
        await handle.write('uncertain copy')
        throw failure
      })
    }
    return handle
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(nativeIntegration(options, ['--install', '--autostart']), (error: unknown) => {
      if (scenario === 'partial shortcut publication') {
        assert.ok(error instanceof AggregateError)
        assert.equal(error.cause, failure)
        assert.ok(error.message.includes(JSON.stringify(second)))
      } else assert.equal(error, failure)
      return true
    })
    assert.equal(calls, 2)
    assert.equal(existsSync(first), false)
    assert.equal(existsSync(join(options.localAppData!, 'Jarvis', 'native-install.json')), false)
    if (scenario === 'partial shortcut publication') assert.equal(await readFile(second, 'utf8'), 'uncertain copy')
    else assert.equal(existsSync(second), false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

for (const stage of ['generation', 'read'] as const) test(`second Windows shortcut ${stage} failure precedes all final publication`, async t => fixture('win32', async options => {
  const { artifactPaths, receiptPath } = describeNativeIntegration(options)
  const temporaryLinks: string[] = []
  const uncertain = Buffer.from([0, 255, 13, 10, 42])
  const failure = new Error(`injected second shortcut ${stage} failure`)
  options.runPowerShell = (_script, env) => {
    for (const path of [...artifactPaths, receiptPath]) assert.equal(existsSync(path), false, 'no final link may exist even transiently during generation')
    temporaryLinks.push(env.JARVIS_LINK_PATH!)
    if (temporaryLinks.length === 2) {
      assert.equal(existsSync(dirname(temporaryLinks[0]!)), false, 'previous verified staging is already cleaned')
      writeFileSync(env.JARVIS_LINK_PATH!, uncertain, { mode: 0o600 })
      if (stage === 'generation') throw failure
    } else writeFileSync(env.JARVIS_LINK_PATH!, 'verified first shortcut', { mode: 0o600 })
  }
  const originalOpen = fsPromises.open
  const finalOpens: string[] = []
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
    if (args[1] === 'wx' && [...artifactPaths, receiptPath].includes(String(args[0]))) finalOpens.push(String(args[0]))
    if (stage === 'read' && temporaryLinks.length === 2 && args[0] === temporaryLinks[1]) throw failure
    return originalOpen(...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(nativeIntegration(options, ['--install', '--autostart']), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.cause, failure)
      assert.equal(error.errors[0], failure)
      assert.equal(error.errors.length, 2)
      assert.match(error.message, /Retained unverified installation artifact/)
      assert.ok(error.message.includes(JSON.stringify(temporaryLinks[1])))
      return true
    })
    assert.equal(temporaryLinks.length, 2)
    assert.deepEqual(finalOpens, [], 'rollback alone must not satisfy the no-publication guarantee')
    for (const path of [...artifactPaths, receiptPath, temporaryLinks[0]!, dirname(temporaryLinks[0]!)]) assert.equal(existsSync(path), false)
    assert.deepEqual(await readFile(temporaryLinks[1]!), uncertain, 'unverified second staging bytes remain untouched')
    assert.ok((await lstat(dirname(temporaryLinks[1]!))).isDirectory())
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('changed Windows staging during cleanup blocks all final publication', async t => fixture('win32', async options => {
  const { artifactPaths, receiptPath } = describeNativeIntegration(options)
  let temporaryLink = '', reads = 0, calls = 0
  const changed = Buffer.from('changed after verified generation')
  options.runPowerShell = (_script, env) => {
    calls++
    temporaryLink = env.JARVIS_LINK_PATH!
    writeFileSync(temporaryLink, 'original shortcut', { mode: 0o600 })
  }
  const originalOpen = fsPromises.open
  const finalOpens: string[] = []
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
    if (args[1] === 'wx' && [...artifactPaths, receiptPath].includes(String(args[0]))) finalOpens.push(String(args[0]))
    // The second bounded read belongs to owned cleanup. Change the file after
    // its initial lstat, so either that read or the ownership check must refuse.
    if (temporaryLink && args[0] === temporaryLink && ++reads === 2) await writeFile(temporaryLink, changed)
    return originalOpen(...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(nativeIntegration(options, ['--install', '--autostart']))
    assert.equal(reads, 2, 'exercise cleanup after successful generation read')
    assert.equal(calls, 1, 'do not generate another shortcut after unsafe cleanup')
    assert.deepEqual(finalOpens, [])
    for (const path of [...artifactPaths, receiptPath]) assert.equal(existsSync(path), false)
    assert.deepEqual(await readFile(temporaryLink), changed)
    assert.ok((await lstat(dirname(temporaryLink))).isDirectory())
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

for (const stage of ['sync', 'close'] as const) test(`descriptor ${stage} failure preserves original error and safe cleanup`, async t => fixture('darwin', async options => {
  const first = join(options.home, 'Applications', 'Jarvis.app', 'Contents', 'Info.plist')
  const originalOpen = fsPromises.open
  const failure = new Error(`injected ${stage} failure`)
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await originalOpen(...args)
    if (args[0] === first && args[1] === 'wx') {
      if (stage === 'sync') t.mock.method(handle, 'sync', async () => { throw failure })
      else {
        const close = handle.close.bind(handle)
        t.mock.method(handle, 'close', async () => { await close(); throw failure })
      }
    }
    return handle
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(nativeIntegration(options, ['--install']), (error: unknown) => {
      if (stage === 'sync') {
        assert.ok(error instanceof AggregateError)
        assert.equal(error.cause, failure)
        assert.equal(error.errors[0], failure)
        assert.ok(error.message.includes(JSON.stringify(first)))
      } else assert.equal(error, failure)
      return true
    })
    assert.equal(existsSync(first), stage === 'sync')
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('shortcut staging cleanup failure does not mask COM failure', async t => fixture('win32', async options => {
  const failure = new Error('injected COM failure'), cleanup = new Error('injected staging cleanup failure')
  options.runPowerShell = () => { throw failure }
  t.mock.method(fsPromises, 'rmdir', async () => { throw cleanup })
  syncBuiltinESMExports()
  try {
    await assert.rejects(nativeIntegration(options, ['--install']), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.cause, failure)
      assert.deepEqual(error.errors, [failure, cleanup])
      assert.match(error.message, /injected COM failure/)
      return true
    })
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test('tampered runtime and unsafe manifest prevent integration writes', async () => fixture('darwin', async options => {
  await writeFile(join(options.root, 'runtime', 'node'), 'changed')
  await assert.rejects(nativeIntegration(options, ['--install']), /checksum/)
  const layout = describeNativeIntegration(options)
  for (const output of [layout.receiptPath, ...layout.artifactPaths]) assert.equal(existsSync(output), false)
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
      await assert.rejects(inspectNativeIntegration(options), /^Error: Unsafe integration receipt$/)
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
    opens = 0
    await assert.rejects(inspectNativeIntegration(options), /size/)
    assert.equal(opens, target === 'receipt' ? 0 : 3)
    for (const file of created) assert.ok(existsSync(file))
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

for (const target of ['receipt', 'artifact'] as const) test(`uninstall rejects linked ${target} without deleting other artifacts`, { skip: process.platform === 'win32' }, async () => fixture('darwin', async options => {
  const created = await nativeIntegration(options, ['--install', '--autostart'])
  const path = target === 'receipt' ? created.at(-1)! : created.at(-2)!
  const other = join(options.root, 'linked-sentinel')
  await link(path, other)
  await assert.rejects(nativeIntegration(options, ['--uninstall']), /links/)
  await assert.rejects(inspectNativeIntegration(options), /links/)
  for (const file of created) assert.ok(existsSync(file))
  await unlink(other)
  await rename(path, other)
  await symlink(other, path)
  await assert.rejects(nativeIntegration(options, ['--uninstall']), /symlink/)
  await assert.rejects(inspectNativeIntegration(options), /symlink/)
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
  await assert.rejects(inspectNativeIntegration(options), /changed/)
  for (const file of created) assert.ok(existsSync(file))
  await writeFile(last, original)
  for (const [path, mode] of [[last, 0o666], [state, 0o644], [join(options.home, 'Applications'), 0o777]] as const) {
    const previous = (await lstat(path)).mode & 0o777
    await chmod(path, mode)
    await assert.rejects(nativeIntegration(options, ['--uninstall']), /permissions/)
    await assert.rejects(inspectNativeIntegration(options), /permissions/)
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
  await mkdir(options.home, { mode: 0o755 })
  await symlink(options.root, join(options.home, 'Applications'))
  await assert.rejects(nativeIntegration(options, ['--install']), /symlink/)
}))
