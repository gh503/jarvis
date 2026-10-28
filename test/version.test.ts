import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runtimeVersion } from '../src/version.ts'

test('runtime version comes from installed manifest or source package, never environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-version-'))
  const previous = process.env.JARVIS_RELEASE_VERSION
  try {
    process.env.JARVIS_RELEASE_VERSION = '99.0.0'
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '2.0.0' }))
    assert.equal(runtimeVersion(root), '2.0.0')
    const manifest = { schemaVersion: 1, version: '2.0.18', sourceSha: 'a'.repeat(40), sourceTag: 'v2.0.18' }
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    assert.equal(runtimeVersion(root), '2.0.18')
    for (const bad of [{ ...manifest, version: 'bogus' }, { ...manifest, sourceSha: 'bad' }, { ...manifest, sourceTag: 'v2.0.0' }, { ...manifest, schemaVersion: 2 }]) {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify(bad))
      assert.throws(() => runtimeVersion(root), /Invalid packaged/)
    }
    writeFileSync(join(root, 'manifest.json'), '{')
    assert.throws(() => runtimeVersion(root), SyntaxError)
  } finally {
    if (previous === undefined) delete process.env.JARVIS_RELEASE_VERSION
    else process.env.JARVIS_RELEASE_VERSION = previous
    assert.ok(root.startsWith(join(tmpdir(), 'jarvis-version-')))
    rmSync(root, { recursive: true, force: true })
  }
})
