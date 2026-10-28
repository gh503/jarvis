#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, copyFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Build only on the target host. The compiler is a build dependency, never a runtime dependency. */
export async function buildNativeHelper(root = fileURLToPath(new URL('../', import.meta.url))): Promise<{ binary: string; licensesDir: string }> {
  root = resolve(root)
  const source = join(root, 'native', 'scoped-fs')
  const manifest = join(source, 'Cargo.toml')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:RUSTFLAGS|RUSTDOCFLAGS|RUSTC(?:_|$)|RUSTDOC$|RUSTUP_TOOLCHAIN$|CARGO_ENCODED_|CARGO_TARGET_|CARGO_BUILD_)/i.test(key)))
  if (process.platform === 'win32') env.RUSTFLAGS = '-C target-feature=+crt-static'
  execFileSync('cargo', ['build', '--locked', '--release', '--manifest-path', manifest], { cwd: source, env, stdio: 'inherit' })
  const host = /^host: (.+)$/m.exec(execFileSync('rustc', ['-vV'], { cwd: source, env, encoding: 'utf8' }))?.[1]
  if (!host) throw new Error('Cannot determine native Rust target')
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--filter-platform', host, '--format-version', '1', '--manifest-path', manifest], { cwd: source, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as {
    target_directory: string; resolve: { nodes: Array<{ id: string }> }; packages: Array<{ id: string; name: string; version: string; source: string | null; manifest_path: string; license: string | null; license_file: string | null }>
  }
  const out = join(root, 'native', 'dist')
  await mkdir(out, { recursive: true })
  const name = process.platform === 'win32' ? 'jarvis-scoped-fs.exe' : 'jarvis-scoped-fs'
  const binary = join(out, name)
  await copyFile(join(metadata.target_directory, 'release', name), binary)
  const licenses = await mkdtemp(join(out, 'licenses-'))
  const inventory: Array<{ name: string; version: string; license: string | null; files: string[] }> = []
  const resolved = new Set(metadata.resolve.nodes.map(node => node.id))
  for (const pkg of metadata.packages.filter(pkg => pkg.source !== null && resolved.has(pkg.id))) {
    const directory = dirname(pkg.manifest_path)
    const names = (await readdir(directory)).filter(name => /^(?:license|copying|notice)(?:[._-]|$)/i.test(name))
    if (pkg.license_file && !names.includes(pkg.license_file)) names.push(pkg.license_file)
    const destination = join(licenses, `${pkg.name}-${pkg.version}`)
    await mkdir(destination, { recursive: true })
    const files: string[] = []
    for (const name of names) {
      // Cargo metadata is trusted build input; flatten license filenames in the inventory.
      const target = name.replace(/[\\/]/g, '_')
      try { await copyFile(join(directory, name), join(destination, target)); files.push(target) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error }
    }
    if (!files.length) throw new Error(`Missing dependency license: ${pkg.name}@${pkg.version}`)
    inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license, files })
  }
  const version = execFileSync('rustc', ['--version'], { cwd: source, env, encoding: 'utf8' }).trim()
  const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { cwd: source, env, encoding: 'utf8' }).trim()
  const rustLicenses = join(licenses, 'rust')
  await mkdir(rustLicenses, { recursive: true })
  // rust-std redistribution includes its third-party notices, not only Rust's own license.
  await copyFile(join(sysroot, 'share', 'doc', 'rust', 'COPYRIGHT-library.html'), join(rustLicenses, 'COPYRIGHT-library.html'))
  const bundledNotices = join(sysroot, 'share', 'doc', 'rust', 'licenses')
  const copyNotices = async (sourceDir: string, targetDir: string): Promise<void> => {
    await mkdir(targetDir, { recursive: true })
    for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
      if (entry.isDirectory()) await copyNotices(join(sourceDir, entry.name), join(targetDir, entry.name))
      else if (entry.isFile()) await copyFile(join(sourceDir, entry.name), join(targetDir, entry.name))
      else throw new Error('Unexpected special file in Rust license inventory')
    }
  }
  await copyNotices(bundledNotices, join(rustLicenses, 'licenses'))
  await copyFile(join(sysroot, 'share', 'doc', 'rust', 'COPYRIGHT.html'), join(rustLicenses, 'COPYRIGHT.html'))
  await copyFile(join(bundledNotices, 'MIT.txt'), join(rustLicenses, 'LICENSE-MIT'))
  await copyFile(join(bundledNotices, 'Apache-2.0.txt'), join(rustLicenses, 'LICENSE-APACHE'))
  await writeFile(join(out, 'licenses.json'), JSON.stringify({ rust: version, dependencies: inventory }, null, 2) + '\n')
  await copyFile(join(out, 'licenses.json'), join(licenses, 'inventory.json'))
  return { binary, licensesDir: licenses }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildNativeHelper().then(binary => console.log(binary)).catch(error => { console.error(error); process.exitCode = 1 })
}
