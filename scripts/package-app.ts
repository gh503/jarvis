#!/usr/bin/env node
/** Native portable archives. Run with Node 24 on each target OS/architecture. */
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { copyPublicFiles, createArchive, licenseInventory, nativeTarget, payloadFiles, provenance, sha256, writeLaunchers, writeManifest } from './packaging.ts'

export async function packageApp(root: string, args = process.argv.slice(2)): Promise<string> {
  const platform = nativeTarget(process.platform, process.arch, process.version)
  for (const arg of args) {
    if (arg !== `--target=${platform}`) throw new Error(`Unsupported argument ${arg}; package on the native target OS (current: ${platform})`)
  }
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const source = provenance(root, pkg.version)
  const name = `jarvis-${source.version}-${platform}-${process.arch}`
  const out = join(root, 'dist')
  await mkdir(out, { recursive: true })
  const temporary = await mkdtemp(join(out, '.package-'))
  // All cleanup targets are direct descendants of this freshly allocated directory.
  const stage = join(temporary, name)
  const extension = platform === 'win32' ? '.zip' : '.tar.gz'
  const archive = join(out, name + extension)
  try {
    await mkdir(stage)
    await copyPublicFiles(root, stage)
    // npm is invoked via its JS entry point, avoiding cmd.exe quoting and npm.cmd.
    const npm = process.env.npm_execpath
    if (!npm || !/npm-cli\.js$/.test(npm)) throw new Error('Run packaging with npm run package (npm_execpath must identify npm-cli.js)')
    const emptyConfig = join(temporary, 'empty.npmrc')
    const emptyGlobalConfig = join(temporary, 'global.npmrc')
    await writeFile(emptyConfig, '')
    await writeFile(emptyGlobalConfig, '')
    const installEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key) && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)))
    execFileSync(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false', '--registry=https://registry.npmjs.org/', `--userconfig=${emptyConfig}`, `--globalconfig=${emptyGlobalConfig}`], {
      cwd: stage, stdio: 'inherit', env: { ...installEnv, NODE_ENV: 'production' },
    })
    // Compress-Archive omits hidden files. Drop dependency development dotfiles on
    // every OS before hashing so the manifest describes exactly the extracted payload.
    const modules = join(stage, 'node_modules')
    for (const path of await payloadFiles(modules)) {
      if (path.split('/').some(part => part.startsWith('.'))) {
        const target = resolve(modules, path)
        if (!target.startsWith(resolve(modules) + (platform === 'win32' ? '\\' : '/'))) throw new Error('Unsafe dependency cleanup path')
        await rm(target)
      }
    }
    const runtime = join(stage, 'runtime')
    await mkdir(runtime)
    const binary = join(runtime, platform === 'win32' ? 'node.exe' : 'node')
    await copyFile(process.execPath, binary)
    if (platform !== 'win32') await chmod(binary, 0o755)
    // This includes the runtime's bundled third-party notices, not just the MIT header.
    const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`
    const response = await fetch(licenseUrl, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`Node license download failed: ${response.status}`)
    const license = await response.text()
    if (!license.includes('Node.js') || !license.includes('MIT')) throw new Error('Unexpected Node license content')
    await writeFile(join(runtime, 'LICENSE'), license)
    await writeLaunchers(stage, platform)
    await writeFile(join(stage, 'PORTABLE.txt'), [
      `Jarvis ${source.version} — ${platform}/${process.arch}`,
      platform === 'win32' ? 'Run Jarvis.cmd or Jarvis.ps1.' : platform === 'darwin' ? 'Run ./jarvis or open Jarvis.command.' : 'Run ./jarvis in a terminal.',
      'A browser is required. Optional Python, models and operating-system tools are installed separately.',
      'Application data is stored in your user data directory. See docs/getting-started.md.',
      'This is an unsigned portable archive, not a signed installer.',
      'manifest.json hashes every other payload file; the archive SHA256 sidecar also covers the manifest.',
      '',
    ].join('\n'))
    const licenses = await licenseInventory(stage)
    for (const dependency of licenses.dependencies) {
      if (dependency.files.length === 0) throw new Error(`Missing license file for ${dependency.name}@${dependency.version}`)
    }
    await writeFile(join(stage, 'THIRD-PARTY-LICENSES.json'), JSON.stringify(licenses, null, 2) + '\n')
    // Verify the copied executable and production imports without importing the server or launcher.
    const verification = JSON.parse(execFileSync(binary, ['--input-type=module', '-e',
      "import 'ws'; import 'ajv'; import '@modelcontextprotocol/sdk/types.js'; import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.close(); console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch}))"],
    { cwd: stage, encoding: 'utf8', env: installEnv }))
    if (verification.version !== process.version || verification.platform !== platform || verification.arch !== process.arch) throw new Error('Packaged runtime identity mismatch')
    await writeManifest(stage, { ...source, packageVersion: pkg.version, platform, arch: process.arch, runtime: { ...verification, licenseUrl }, licenses, verification: 'runtime identity, production dependency imports, in-memory SQLite; no server launched' })
    const freshArchive = join(temporary, name + extension)
    createArchive(platform, temporary, name, freshArchive)
    const digest = await sha256(freshArchive)
    // rename replaces a prior complete archive; there is no in-place ZIP update.
    await rename(freshArchive, archive)
    await writeFile(`${archive}.sha256`, `${digest}  ${name}${extension}\n`)
    console.log(`Packaged ${archive} (${((await stat(archive)).size / 1024 / 1024).toFixed(1)} MiB)`)
    return archive
  } finally {
    if (dirname(temporary) !== out || !temporary.startsWith(join(out, '.package-'))) throw new Error('Unsafe staging cleanup path')
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  packageApp(dirname(dirname(fileURLToPath(import.meta.url)))).catch(error => {
    console.error('Packaging failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
