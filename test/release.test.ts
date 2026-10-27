import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
// The standalone release entrypoint deliberately runs without TypeScript or npm install.
// @ts-ignore -- JavaScript entrypoint has no declaration file.
import { parseVersion, compareVersions, selectReleaseVersion, getReleasePlan, shouldMarkLatest, release } from '../scripts/release.mjs';

const script = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url));

test('stable versions exclude prereleases, moving tags and malformed numbers', () => {
  for (const version of ['2.0', 'v2.0.0', '02.0.0', '2.0.0-beta.1', '2.0.0+build', '9007199254740992.0.0']) {
    assert.equal(parseVersion(version), null);
  }
  assert.deepEqual(parseVersion('2.0.0'), [2, 0, 0]);
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.throws(() => compareVersions('invalid', '2.0.0'));
});

test('first release uses package base, including with old or no stable tags', () => {
  for (const tags of [[], ['v0.1.0'], ['latest', 'v3.0.0-beta.1', 'v02.0.0']]) {
    assert.deepEqual(selectReleaseVersion('2.0.0', tags), {
      version: '2.0.0', tag: 'v2.0.0', reuseTag: false,
    });
  }
  assert.throws(() => selectReleaseVersion('2.0.0-rc.1', []));
});

test('later releases increment the numerically highest stable patch', () => {
  assert.equal(selectReleaseVersion('2.0.0', ['v2.0.0']).tag, 'v2.0.1');
  assert.equal(selectReleaseVersion('2.0.0', ['v2.9.99', 'v2.10.2', 'v3.0.0-rc.1']).tag, 'v2.10.3');
  assert.equal(selectReleaseVersion('3.0.0', ['v2.10.2']).tag, 'v3.0.0');
});

test('reruns reuse highest eligible HEAD tag even after newer releases elsewhere', () => {
  assert.deepEqual(selectReleaseVersion('2.0.0', ['v2.0.0', 'v2.0.1', 'v2.0.2'], ['v2.0.0', 'v2.0.1']), {
    version: '2.0.1', tag: 'v2.0.1', reuseTag: true,
  });
  assert.equal(selectReleaseVersion('2.0.0', ['v0.1.0'], ['v0.1.0']).tag, 'v2.0.0');
});

test('recovering old releases cannot replace the newest release', () => {
  assert.equal(shouldMarkLatest('2.0.0', ['v2.0.0', 'v2.0.1']), false);
  assert.equal(shouldMarkLatest('2.0.1', ['v2.0.0', 'v2.0.1']), true);
});

test('repository plan and CLI dry-run preserve tags and use committed package version', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'jarvis-release-test-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', shell: false }).trim();
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Release Test');
    git('config', 'user.email', 'release@example.invalid');
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '2.0.0' }));
    git('add', 'package.json');
    git('commit', '--quiet', '-m', 'base');
    git('tag', 'v0.1.0');
    const sha = git('rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '99.0.0' }));
    const options = { cwd, sha, repository: 'owner/repo' };
    assert.equal(getReleasePlan(options).tag, 'v2.0.0');
    assert.throws(() => getReleasePlan({ ...options, sha: '0'.repeat(40) }), /HEAD/);
    const before = git('show-ref', '--tags');
    const output = execFileSync(process.execPath, [script, '--dry-run'], {
      cwd, encoding: 'utf8', shell: false,
      env: { ...process.env, GH_TOKEN: '', GITHUB_SHA: sha, GITHUB_REPOSITORY: 'owner/repo' },
    });
    assert.deepEqual(JSON.parse(output), {
      dryRun: true, repository: 'owner/repo', sha, packageVersion: '2.0.0',
      version: '2.0.0', tag: 'v2.0.0', reuseTag: false,
    });
    assert.equal(git('show-ref', '--tags'), before);
    const savedEnv = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_SHA: process.env.GITHUB_SHA, GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY };
    Object.assign(process.env, { GH_TOKEN: 'test-only', GITHUB_SHA: sha, GITHUB_REPOSITORY: 'owner/repo' });
    try {
      const calls: string[][] = [];
      const stale = release({ cwd, execute: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        assert.deepEqual([command, ...args], ['git', 'ls-remote', 'origin', 'refs/heads/main']);
        return `${'0'.repeat(40)}\trefs/heads/main`;
      } });
      assert.equal(stale.skipped, 'stale-main-commit');
      assert.equal(calls.length, 1);
      git('tag', '-a', 'v2.0.0', '-m', 'release');
      const execute = (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (command === 'git' && args[0] === 'ls-remote') return `${sha}\trefs/tags/v2.0.0^{}`;
        if (command === 'git' && args[0] === 'tag') return 'v2.0.0\nv2.0.1';
        if (command === 'gh' && args[0] === 'api') return JSON.stringify([[{ tag_name: 'v2.0.0', draft: true }]]);
        if (command === 'gh' && args[0] === 'release') return '';
        throw new Error(`Unexpected command ${command} ${args.join(' ')}`);
      };
      release({ cwd, execute });
      assert.deepEqual(calls.at(-1), ['gh', 'release', 'edit', 'v2.0.0', '--repo', 'owner/repo', '--draft=false', '--prerelease=false', '--latest=false']);
      assert.throws(() => release({ cwd, execute: (command: string, args: string[]) => {
        if (command === 'gh' && args[0] === 'api') throw new Error('API unavailable');
        return execute(command, args);
      } }), /API unavailable/);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.equal(getReleasePlan(options).reuseTag, true);
    git('tag', 'v2.0.1');
    assert.equal(getReleasePlan(options).tag, 'v2.0.1');
  } finally {
    // cwd is the exact directory returned by mkdtempSync above.
    rmSync(cwd, { recursive: true, force: true });
  }
});
