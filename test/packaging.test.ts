import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { copyPublicFiles, createArchive, isPublicFile, launchers, nativeTarget, payloadFiles, provenance, sha256, writeLaunchers, writeManifest } from '../scripts/packaging.ts'

async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis packaging 中文 '))
  try { await run(dir) } finally {
    assert.ok(dir.startsWith(join(tmpdir(), 'jarvis packaging 中文 ')))
    await rm(dir, { recursive: true, force: true })
  }
}

test('public allowlist excludes private state, environment files and unrelated scripts', () => {
  for (const path of ['.env', 'src/.env', 'web/.env.local', 'src/private/key.ts', 'data/state.json', 'node_modules/ws/index.js', 'scripts/__pycache__/worker.pyc', 'scripts/package-app.ts', 'docs/customer-notes.md', 'src/secrets/token.ts', 'web/key.pem']) assert.equal(isPublicFile(path), false, path)
  for (const path of ['src/main.ts', 'src/local-tools/scoped-filesystem.ts', 'web/index.html', 'web/icons/jarvis.svg', 'scripts/app.ts', 'scripts/runtime-lifecycle.ts', 'LICENSE', 'package-lock.json']) assert.equal(isPublicFile(path), true, path)
})

test('public copy ignores untracked secrets and rejects tracked symlinks', async () => temporary(async dir => {
  const root = join(dir, 'source'); const stage = join(dir, 'stage')
  await mkdir(root); await mkdir(stage)
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const file of ['package.json', 'package-lock.json', 'LICENSE', 'src/main.ts', 'scripts/app.ts', 'web/index.html']) {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), 'public')
  }
  execFileSync('git', ['add', '.'], { cwd: root })
  await writeFile(join(root, 'src', 'private-notes.ts'), 'secret')
  await writeFile(join(root, 'web', '.env'), 'secret')
  await copyPublicFiles(root, stage)
  assert.equal((await payloadFiles(stage)).includes('src/private-notes.ts'), false)
  if (process.platform !== 'win32') {
    await symlink(join(root, 'src', 'private-notes.ts'), join(root, 'src', 'linked.ts'))
    execFileSync('git', ['add', 'src/linked.ts'], { cwd: root })
    await assert.rejects(copyPublicFiles(root, stage), /symlink/)
  }
}))

test('native runtime requirements reject unsupported targets', () => {
  for (const platform of ['linux', 'darwin', 'win32']) assert.equal(nativeTarget(platform, 'arm64', 'v24.14.0'), platform)
  assert.throws(() => nativeTarget('linux', 'x64', 'v22.0.0'), /Node 24/)
  assert.throws(() => nativeTarget('freebsd', 'x64', 'v24.0.0'), /platform/)
  assert.throws(() => nativeTarget('win32', 'ia32', 'v24.0.0'), /architecture/)
})

test('release provenance uses explicit version and validates exact tag and source', async () => temporary(async dir => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture')
  const sha = git('rev-parse', 'HEAD')
  git('tag', 'v3.4.5')
  assert.deepEqual(provenance(dir, '2.0.0', { JARVIS_RELEASE_VERSION: '3.4.5', JARVIS_RELEASE_TAG: 'v3.4.5', JARVIS_SOURCE_SHA: sha }), { version: '3.4.5', sourceSha: sha, sourceTag: 'v3.4.5', dirty: false })
  assert.throws(() => provenance(dir, '2.0.0', { JARVIS_SOURCE_SHA: 'bad' }), /HEAD/)
  assert.throws(() => provenance(dir, '2.0.0', { JARVIS_RELEASE_VERSION: '../bad' }), /VERSION/)
  assert.throws(() => provenance(dir, '2.0.0', { JARVIS_RELEASE_TAG: 'v3.4.5' }), /version/)
  await writeFile(join(dir, 'tracked'), 'private')
  git('add', 'tracked')
  assert.throws(() => provenance(dir, '2.0.0', { JARVIS_SOURCE_SHA: sha }), /clean/)
}))

test('manifest hashes every payload including runtime licenses', async () => temporary(async dir => {
  await mkdir(join(dir, 'runtime'))
  await writeFile(join(dir, 'runtime', 'LICENSE'), 'license text')
  await writeFile(join(dir, 'payload.txt'), 'payload')
  await writeManifest(dir, { version: '2.0.0' })
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.files.map((f: {path: string}) => f.path), ['payload.txt', 'runtime/LICENSE'])
  for (const file of manifest.files) assert.equal(file.sha256, await sha256(join(dir, file.path)))
  await writeFile(join(dir, 'payload.txt'), 'tampered')
  assert.notEqual(manifest.files[0].sha256, await sha256(join(dir, 'payload.txt')))
}))

test('native launcher executes from Unicode paths and preserves arguments without starting server', async () => temporary(async dir => {
  const platform = nativeTarget(process.platform, process.arch, process.version)
  await mkdir(join(dir, 'runtime')); await mkdir(join(dir, 'scripts'))
  await copyFile(process.execPath, join(dir, 'runtime', platform === 'win32' ? 'node.exe' : 'node'))
  if (platform !== 'win32') await chmod(join(dir, 'runtime', 'node'), 0o755)
  await writeFile(join(dir, 'scripts', 'app.ts'), 'console.log(JSON.stringify(process.argv.slice(2)))\nprocess.exitCode = 7\n')
  await writeLaunchers(dir, platform)
  const args = ['hello world', '中文参数', '--no-open']
  const result = platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'Jarvis.ps1'), ...args], { encoding: 'utf8' })
    : spawnSync(join(dir, 'jarvis'), args, { encoding: 'utf8', cwd: tmpdir() })
  assert.equal(result.status, 7, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), args)
  assert.match(launchers('win32')['Jarvis.cmd']!, /DisableDelayedExpansion/)
}))

test('fresh native archive replacement removes obsolete entries', async () => temporary(async dir => {
  const platform = nativeTarget(process.platform, process.arch, process.version)
  const stage = join(dir, 'bundle')
  await mkdir(stage)
  await writeFile(join(stage, 'old.txt'), 'old')
  const archive = join(dir, platform === 'win32' ? 'first.zip' : 'first.tar.gz')
  createArchive(platform, dir, 'bundle', archive)
  await rm(join(stage, 'old.txt'))
  await writeFile(join(stage, 'new.txt'), 'new')
  const fresh = join(dir, platform === 'win32' ? 'fresh.zip' : 'fresh.tar.gz')
  createArchive(platform, dir, 'bundle', fresh)
  const extracted = join(dir, 'extracted'); await mkdir(extracted)
  if (platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:ARCHIVE -DestinationPath $env:DEST -ErrorAction Stop'], { env: { ...process.env, ARCHIVE: fresh, DEST: extracted } })
  else execFileSync('tar', ['-xzf', fresh, '-C', extracted])
  assert.deepEqual(await payloadFiles(extracted), ['bundle/new.txt'])
}))
