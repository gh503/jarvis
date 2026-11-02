import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetStem, selectPublishedRelease, validateAssetSet, resolveRelease } from '../scripts/native-release.mjs';

const sha = 'a'.repeat(40);
test('resolves the published release for exact CI SHA, not latest or package version', () => {
  const releases = [{ tag_name: 'v2.0.19' }, { tag_name: 'v2.0.18' }, { tag_name: 'v2.0.17', draft: true }];
  const resolve = tag => tag === 'v2.0.19' ? 'b'.repeat(40) : sha;
  assert.equal(selectPublishedRelease(releases, undefined, sha, resolve).tag_name, 'v2.0.18');
  assert.throws(() => selectPublishedRelease(releases, 'v2.0.19', sha, resolve), /found 0/);
  assert.throws(() => selectPublishedRelease([...releases, { tag_name: 'v2.0.16' }], undefined, sha, resolve), /found 2/);
  assert.throws(() => assetStem('2.0.0', 'linux', 'x64', 'short'), /Invalid/);
});

test('only confirmed unpublished stale automatic sources may skip native publication', () => {
  const other = 'b'.repeat(40);
  assert.equal(selectPublishedRelease([], undefined, sha, () => sha, other), undefined);
  for (const main of [undefined, '', 'invalid', sha]) assert.throws(() => selectPublishedRelease([], undefined, sha, () => sha, main), /found 0/);
  assert.throws(() => selectPublishedRelease([], 'v2.0.1', sha, () => sha, other), /found 0/);
  const release = { tag_name: 'v2.0.1' };
  assert.equal(selectPublishedRelease([release], undefined, sha, () => sha, other), release);
  assert.throws(() => selectPublishedRelease([release, { tag_name: 'v2.0.2' }], undefined, sha, () => sha, other), /found 2/);
  assert.throws(() => selectPublishedRelease([release], undefined, sha, () => { throw new Error('remote failure'); }, other), /remote failure/);
});

test('resolver emits no build outputs for stale unpublished source but preserves exact release outputs', t => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-resolve-'));
  const keys = ['GITHUB_EVENT_PATH', 'GITHUB_EVENT_NAME', 'GITHUB_REPOSITORY', 'GITHUB_OUTPUT'];
  const previous = keys.map(key => process.env[key]);
  try {
    Object.assign(process.env, { GITHUB_EVENT_PATH: join(root, 'event.json'), GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: 'fixture/repo', GITHUB_OUTPUT: join(root, 'output') });
    writeFileSync(process.env.GITHUB_EVENT_PATH, JSON.stringify({ workflow_run: { conclusion: 'success', head_branch: 'main', head_repository: { full_name: 'fixture/repo' }, event: 'push', head_sha: sha } }));
    let releases = [], main = 'b'.repeat(40), calls = 0;
    const mainQueries = [];
    t.mock.method(childProcess, 'execFileSync', (command, args) => {
      calls++;
      if (command === 'gh') {
        assert.deepEqual(args, ['api', '--paginate', '--slurp', 'repos/fixture/repo/releases?per_page=100']);
        return JSON.stringify([releases]);
      }
      assert.equal(command, 'git');
      if (args.at(-1) === 'refs/heads/main') { mainQueries.push(main); return `${main}\trefs/heads/main`; }
      assert.deepEqual(args, ['ls-remote', 'origin', 'refs/tags/v2.0.1', 'refs/tags/v2.0.1^{}']);
      return `${sha}\trefs/tags/v2.0.1`;
    });
    syncBuiltinESMExports();
    for (const mode of ['stale', 'current', 'published', 'missing-main']) {
      writeFileSync(process.env.GITHUB_OUTPUT, '');
      main = mode === 'current' ? sha : mode === 'missing-main' ? '' : 'b'.repeat(40);
      releases = mode === 'published' ? [{ tag_name: 'v2.0.1' }] : [];
      if (mode === 'current') assert.throws(() => resolveRelease(), /found 0/);
      else if (mode === 'missing-main') assert.throws(() => resolveRelease(), /Remote main identity unavailable/);
      else resolveRelease();
      assert.equal(readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), mode === 'published' ? `tag=v2.0.1\nversion=2.0.1\nsha=${sha}\n` : '');
    }
    const trusted = { conclusion: 'success', head_branch: 'main', head_repository: { full_name: 'fixture/repo' }, event: 'push', head_sha: sha };
    for (const patch of [{ conclusion: 'failure' }, { head_branch: 'feature' }, { head_repository: { full_name: 'fork/repo' } }, { event: 'pull_request' }, { head_sha: 'invalid' }]) {
      writeFileSync(process.env.GITHUB_EVENT_PATH, JSON.stringify({ workflow_run: { ...trusted, ...patch } }));
      writeFileSync(process.env.GITHUB_OUTPUT, '');
      const before = calls;
      assert.throws(() => resolveRelease(), /Untrusted or unsuccessful CI run|Invalid source SHA/);
      assert.equal(calls, before, 'reject before remote queries');
      assert.equal(readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), '');
    }
    process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    writeFileSync(process.env.GITHUB_EVENT_PATH, JSON.stringify({ inputs: { tag: 'v2.0.1' } }));
    const beforeMainQueries = mainQueries.length;
    releases = [];
    assert.throws(() => resolveRelease(), /found 0/);
    assert.equal(readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), '');
    releases = [{ tag_name: 'v2.0.1' }];
    resolveRelease();
    assert.equal(readFileSync(process.env.GITHUB_OUTPUT, 'utf8'), `tag=v2.0.1\nversion=2.0.1\nsha=${sha}\n`);
    assert.equal(mainQueries.length, beforeMainQueries, 'manual exact tag never consults main or skips as stale');
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    assert.ok(root.startsWith(join(tmpdir(), 'jarvis-resolve-')));
    rmSync(root, { recursive: true, force: true });
  }
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
