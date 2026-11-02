import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runtimeBuildIdentity, runtimeVersion } from '../src/version.ts'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

test('runtime version comes from installed manifest or source package, never environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-version-'))
  const previous = process.env.JARVIS_RELEASE_VERSION
  try {
    process.env.JARVIS_RELEASE_VERSION = '99.0.0'
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '2.0.0' }))
    assert.equal(runtimeVersion(root), '2.0.0')
    assert.equal(runtimeBuildIdentity(root), undefined)
    assert.equal(JSON.stringify({ build: runtimeBuildIdentity(root) }), '{}')
    const manifest = { schemaVersion: 1, version: '2.0.18', sourceSha: 'a'.repeat(40), sourceTag: 'v2.0.18' }
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    assert.equal(runtimeVersion(root), '2.0.18')
    for (const bad of [{ ...manifest, version: 'bogus' }, { ...manifest, sourceSha: 'bad' }, { ...manifest, sourceTag: 'v2.0.0' }, { ...manifest, schemaVersion: 2 }]) {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify(bad))
      assert.throws(() => runtimeVersion(root), /Invalid packaged/)
      assert.throws(() => runtimeBuildIdentity(root), /Invalid packaged/)
    }
    writeFileSync(join(root, 'manifest.json'), '{')
    assert.throws(() => runtimeVersion(root), SyntaxError)
    assert.throws(() => runtimeBuildIdentity(root), SyntaxError)
  } finally {
    if (previous === undefined) delete process.env.JARVIS_RELEASE_VERSION
    else process.env.JARVIS_RELEASE_VERSION = previous
    assert.ok(root.startsWith(join(tmpdir(), 'jarvis-version-')))
    rmSync(root, { recursive: true, force: true })
  }
})

test('installed build identity hashes exact raw bytes and refreshes same-version metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-version-'))
  try {
    const manifest = { schemaVersion: 1, version: '2.0.18', sourceSha: 'a'.repeat(40), sourceTag: null }
    const compact = JSON.stringify(manifest)
    const formatted = `${JSON.stringify(manifest, null, 2)}\n`
    const changedSource = JSON.stringify({ ...manifest, sourceSha: 'b'.repeat(40) })
    const identities = [compact, formatted, changedSource].map(text => {
      writeFileSync(join(root, 'manifest.json'), text)
      const identity = runtimeBuildIdentity(root)!
      assert.deepEqual(identity, {
        version: manifest.version,
        sourceSha: JSON.parse(text).sourceSha,
        manifestSha256: createHash('sha256').update(Buffer.from(text)).digest('hex'),
      })
      assert.equal(runtimeVersion(root), manifest.version)
      return identity
    })
    assert.notEqual(identities[0]!.manifestSha256, identities[1]!.manifestSha256)
    assert.notEqual(identities[0]!.manifestSha256, identities[2]!.manifestSha256)
    assert.notEqual(identities[0]!.sourceSha, identities[2]!.sourceSha)

    // Large ordinary manifests work; oversized metadata fails before parsing.
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ ...manifest, padding: 'x'.repeat(1024 * 1024) }))
    assert.equal(runtimeBuildIdentity(root)!.version, manifest.version)
    truncateSync(join(root, 'manifest.json'), 16 * 1024 * 1024 + 1)
    assert.throws(() => runtimeBuildIdentity(root), /at most 16 MiB/)
    assert.throws(() => runtimeVersion(root), /at most 16 MiB/)

    writeFileSync(join(root, 'manifest.json'), Buffer.concat([
      Buffer.from(JSON.stringify(manifest).slice(0, -1) + ',"extra":"'), Buffer.from([0xff]), Buffer.from('"}'),
    ]))
    assert.throws(() => runtimeBuildIdentity(root), /encoded data|encoding/i)
    assert.throws(() => runtimeVersion(root), /encoded data|encoding/i)

    for (const text of ['null', '[]', '{}', '42']) {
      writeFileSync(join(root, 'manifest.json'), text)
      assert.throws(() => runtimeBuildIdentity(root), /Invalid packaged/)
      assert.throws(() => runtimeVersion(root), /Invalid packaged/)
    }
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'jarvis-version-')))
    rmSync(root, { recursive: true, force: true })
  }
})

test('default runtime metadata ignores cwd and release environment overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-version-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '99.0.0' }))
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, version: '99.0.0', sourceSha: 'f'.repeat(40), sourceTag: null }))
    const moduleUrl = new URL('../src/version.ts', import.meta.url).href
    const script = `import { runtimeVersion, runtimeBuildIdentity } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify({ version: runtimeVersion(), build: runtimeBuildIdentity() }))`
    const child = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script], {
      cwd: root,
      env: { ...process.env, JARVIS_RELEASE_VERSION: '99.0.0', JARVIS_SOURCE_SHA: 'f'.repeat(40), JARVIS_APP_DIR: root },
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(JSON.parse(child.stdout), JSON.parse(JSON.stringify({ version: runtimeVersion(), build: runtimeBuildIdentity() })))
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'jarvis-version-')))
    rmSync(root, { recursive: true, force: true })
  }
})
