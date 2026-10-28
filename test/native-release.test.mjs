import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetStem, selectPublishedRelease, validateAssetSet } from '../scripts/native-release.mjs';

const sha = 'a'.repeat(40);
test('resolves the published release for exact CI SHA, not latest or package version', () => {
  const releases = [{ tag_name: 'v2.0.19' }, { tag_name: 'v2.0.18' }, { tag_name: 'v2.0.17', draft: true }];
  const resolve = tag => tag === 'v2.0.19' ? 'b'.repeat(40) : sha;
  assert.equal(selectPublishedRelease(releases, undefined, sha, resolve).tag_name, 'v2.0.18');
  assert.throws(() => selectPublishedRelease(releases, 'v2.0.19', sha, resolve), /found 0/);
  assert.throws(() => selectPublishedRelease([...releases, { tag_name: 'v2.0.16' }], undefined, sha, resolve), /found 2/);
  assert.throws(() => assetStem('2.0.0', 'linux', 'x64', 'short'), /Invalid/);
});

test('publication requires all three platforms and rejects tampered asset bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-assets-'));
  try {
    const tag = 'v2.0.18';
    let last;
    for (const platform of ['linux', 'darwin', 'win32']) {
      const archive = assetStem(tag.slice(1), platform, 'x64', sha) + (platform === 'win32' ? '.zip' : '.tar.gz');
      const bytes = Buffer.from(platform);
      const hash = createHash('sha256').update(bytes).digest('hex');
      writeFileSync(join(root, archive), bytes);
      writeFileSync(join(root, `${archive}.sha256`), `${hash}  ${archive}\n`);
      writeFileSync(join(root, `${archive}.provenance.json`), JSON.stringify({ schemaVersion: 1, version: tag.slice(1), sourceTag: tag, sourceSha: sha, platform, arch: 'x64', signing: 'unsigned', archive, sha256: hash }));
      last = archive;
      if (platform !== 'win32') assert.throws(() => validateAssetSet(root, tag, sha), /three complete/);
    }
    assert.equal(validateAssetSet(root, tag, sha).length, 9);
    assert.throws(() => validateAssetSet(root, tag, 'b'.repeat(40)), /provenance/);
    writeFileSync(join(root, last), 'tampered');
    assert.throws(() => validateAssetSet(root, tag, sha), /checksum/);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'jarvis-assets-')));
    rmSync(root, { recursive: true, force: true });
  }
});
