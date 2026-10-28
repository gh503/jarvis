import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { payloadFiles, sha256 } from '../scripts/packaging.ts'

// Opt in after npm run package. The default test suite never launches a server.
const archiveInput = process.env.JARVIS_PACKAGE_ARCHIVE

test('native artifact verifies and starts/stops using only its bundled Node', { skip: !archiveInput, timeout: 120_000 }, async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const filename = `jarvis-${process.env.JARVIS_RELEASE_VERSION ?? pkg.version}-${process.platform}-${process.arch}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`
  const archive = archiveInput === 'auto' ? resolve('dist', filename) : resolve(archiveInput!)
  const expectedDigest = (await readFile(`${archive}.sha256`, 'utf8')).split(/\s+/)[0]
  assert.equal(await sha256(archive), expectedDigest)
  const tempRoot = await realpath(tmpdir())
  const temporary = await mkdtemp(join(tempRoot, 'Jarvis artifact 中文 '))
  const extracted = join(temporary, 'extracted app 空间')
  const data = join(temporary, 'private data 数据')
  await mkdir(extracted); await mkdir(data, { mode: 0o700 })
  let launch: ((args: string[]) => ReturnType<typeof spawnSync>) | undefined
  try {
    if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:ARCHIVE -DestinationPath $env:DEST -ErrorAction Stop'], { env: { ...process.env, ARCHIVE: archive, DEST: extracted } })
    else execFileSync('tar', ['-xzf', archive, '-C', extracted])
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
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const port = address.port
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^JARVIS_|^NODE_|^PATH$/i.test(key)))
    Object.assign(env, { PATH: '', JARVIS_DATA_DIR: data, JARVIS_HOST: '127.0.0.1', JARVIS_PORT: String(port), JARVIS_AUTH_TOKEN: 'artifact-test-token-at-least-24-characters', JARVIS_OLLAMA_URL: 'http://127.0.0.1:1', JARVIS_DAILY_SPEAK_BUDGET: '0' })
    const binary = join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
    const identity = JSON.parse(execFileSync(binary, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], { env, encoding: 'utf8' }))
    assert.equal(identity.version, manifest.runtime.version)
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    launch = args => process.platform === 'win32'
      ? spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(bundle, 'Jarvis.ps1'), ...args], { env, cwd: temporary, encoding: 'utf8', timeout: 55_000 })
      : spawnSync(join(bundle, 'jarvis'), args, { env, cwd: temporary, encoding: 'utf8', timeout: 55_000 })
    const started = launch(['--no-open'])
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}\n${await readFile(join(data, 'launcher.log'), 'utf8').catch(() => '')}`)
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${env.JARVIS_AUTH_TOKEN}` }, signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { version: string }).version, manifest.version)
    const stopped = launch(['--stop'])
    assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`)
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }))
  } finally {
    launch?.(['--stop'])
    assert.ok(temporary.startsWith(join(tempRoot, 'Jarvis artifact 中文 ')) && temporary !== tempRoot && temporary.includes(sep))
    await rm(temporary, { recursive: true, force: true })
  }
})
