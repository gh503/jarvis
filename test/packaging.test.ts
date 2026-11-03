import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'
import { copyPublicFiles, createArchive, isPublicFile, launchers, nativeTarget, payloadFiles, provenance, sha256, writeLaunchers, writeManifest } from '../scripts/packaging.ts'

async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis packaging 中文 '))
  try { await run(dir) } finally {
    assert.ok(dir.startsWith(join(tmpdir(), 'jarvis packaging 中文 ')))
    await rm(dir, { recursive: true, force: true })
  }
}

test('public allowlist excludes private state, environment files and unrelated scripts', () => {
  for (const path of ['.env', 'src/.env', 'web/.env.local', 'src/private/key.ts', 'data/state.json', 'node_modules/ws/index.js', 'scripts/__pycache__/worker.pyc', 'scripts/package-app.ts', 'scripts/native-private-experiment.ts', 'docs/native-private-notes.md', 'docs/customer-notes.md', 'src/secrets/token.ts', 'web/key.pem']) assert.equal(isPublicFile(path), false, path)
  for (const path of ['src/main.ts', 'src/local-tools/scoped-filesystem.ts', 'web/index.html', 'web/icons/jarvis.svg', 'scripts/app.ts', 'scripts/runtime-lifecycle.ts', 'scripts/backup-archive.ts', 'scripts/install-native.ts', 'docs/native-install.md', 'LICENSE', 'package-lock.json']) assert.equal(isPublicFile(path), true, path)
})

function relativeImports(source: string): string[] {
  const file = ts.createSourceFile('payload.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const imports = new Set<string>()
  const collect = (node: ts.Node) => {
    let specifier: ts.Node | undefined
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0]
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal
    else if (ts.isExternalModuleReference(node)) specifier = node.expression
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) imports.add(specifier.text)
    ts.forEachChild(node, collect)
  }
  collect(file)
  return [...imports]
}

test('payload import collector handles static, type, export and dynamic imports without matching comments', () => {
  assert.deepEqual(relativeImports(`
    import './side-effect.ts'
    import type { Type } from './types.ts'
    export { value } from './export.ts'
    export type * from './export-types.ts'
    const lazy = import('./dynamic.ts')
    const template = import(\`./template.ts\`)
    type Other = import('./import-type.ts').Other
    import legacy = require('./legacy.ts')
    import { readFile } from 'node:fs/promises'
    import external from 'external-package'
    // import './comment.ts'
    const text = "import('./string.ts')"
  `), ['./side-effect.ts', './types.ts', './export.ts', './export-types.ts', './dynamic.ts', './template.ts', './import-type.ts', './legacy.ts'])
})

test('packaged runtime entrypoints and their transitive local imports are tracked public files', async () => {
  const root = resolve(import.meta.dirname, '..')
  const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))
  // Explicit entrypoints also catch a CLI accidentally removed from the allowlist.
  // Scan every other packaged TS file too, including APIs and src entrypoints
  // launched as subprocesses rather than imported by app.ts.
  const pending = [
    'scripts/app.ts', 'scripts/install-native.ts', 'scripts/update-native.ts',
    'scripts/snapshot-native.ts', 'scripts/snapshot-native-config.ts',
    'scripts/recovery-native.ts', 'scripts/snapshot-native-integration.ts',
    'scripts/diagnose-native-install.ts', 'scripts/retire-native-install-preparation.ts', 'scripts/uninstall-native-install-transaction.ts', 'scripts/backup.ts', 'scripts/restore.ts',
    ...[...tracked].filter(path => path.endsWith('.ts') && isPublicFile(path)),
  ]
  const visited = new Set<string>()
  while (pending.length) {
    const path = pending.pop()!
    if (visited.has(path)) continue
    visited.add(path)
    assert.ok(tracked.has(path), `Missing tracked payload file: ${path}`)
    assert.ok(isPublicFile(path), `Payload file excluded by allowlist: ${path}`)
    const source = await readFile(join(root, path), 'utf8')
    for (const specifier of relativeImports(source)) {
      const dependency = posix.normalize(posix.join(posix.dirname(path), specifier))
      assert.ok(tracked.has(dependency), `${path} imports missing or untracked file ${dependency}`)
      assert.ok(isPublicFile(dependency), `${path} imports excluded payload file ${dependency}`)
      if (dependency.endsWith('.ts')) pending.push(dependency)
    }
  }
})

test('native operational documentation is tracked and included in the public payload', async () => {
  const root = resolve(import.meta.dirname, '..')
  const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))
  for (const name of [
    'native-install.md', 'native-update.md', 'native-state-snapshot.md',
    'native-config-snapshot.md', 'stopped-data-scope.md', 'native-recovery-set.md',
    'native-integration-snapshot.md', 'native-install-intent.md', 'native-release-pipeline.md',
  ]) {
    const path = `docs/${name}`
    assert.ok(tracked.has(path), `Missing tracked documentation: ${path}`)
    assert.ok(isPublicFile(path), `Excluded native documentation: ${path}`)
    await readFile(join(root, path), 'utf8')
  }
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
