import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Only canonical, stable versions participate in automatic releases. */
export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error('Expected stable semantic versions');
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function stableVersions(tags) {
  return tags.filter((tag) => tag.startsWith('v') && parseVersion(tag.slice(1)))
    .map((tag) => tag.slice(1)).sort(compareVersions);
}

/** Reuse an eligible HEAD tag before allocating a new version, even on old reruns. */
export function selectReleaseVersion(packageVersion, tags, headTags = []) {
  if (!parseVersion(packageVersion)) throw new Error('Package version must be stable semver');
  const existing = stableVersions(headTags).filter((v) => compareVersions(v, packageVersion) >= 0).at(-1);
  if (existing) return { version: existing, tag: `v${existing}`, reuseTag: true };
  const latest = stableVersions(tags).at(-1);
  let version = packageVersion;
  if (latest && compareVersions(latest, packageVersion) >= 0) {
    const parts = parseVersion(latest);
    if (!Number.isSafeInteger(parts[2] + 1)) throw new Error('Patch version overflow');
    parts[2] += 1;
    version = parts.join('.');
  }
  return { version, tag: `v${version}`, reuseTag: false };
}

export function shouldMarkLatest(version, tags) {
  const latest = stableVersions(tags).at(-1);
  return !latest || compareVersions(latest, version) <= 0;
}

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', shell: false }).trim();
}

export function getReleasePlan({ cwd = process.cwd(), sha = process.env.GITHUB_SHA, repository = process.env.GITHUB_REPOSITORY } = {}) {
  const git = (...args) => run('git', args, cwd);
  const commit = git('rev-parse', 'HEAD');
  if (sha && (!/^[a-f0-9]{40}$/.test(sha) || sha !== commit)) {
    throw new Error('GITHUB_SHA must match the exact checked-out HEAD');
  }
  if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Invalid GITHUB_REPOSITORY');
  }
  const { version: packageVersion } = JSON.parse(git('show', `${commit}:package.json`));
  const tags = git('tag', '--list').split('\n').filter(Boolean);
  // --points-at handles both lightweight and annotated tags.
  const headTags = git('tag', '--points-at', commit).split('\n').filter(Boolean);
  return { repository: repository ?? null, sha: commit, packageVersion,
    ...selectReleaseVersion(packageVersion, tags, headTags) };
}

export function release({ cwd = process.cwd(), dryRun = false, execute = run } = {}) {
  const plan = getReleasePlan({ cwd });
  console.log(JSON.stringify({ dryRun, ...plan }, null, 2));
  if (dryRun) return plan;
  if (!plan.repository || !process.env.GH_TOKEN || !process.env.GITHUB_SHA) {
    throw new Error('GITHUB_REPOSITORY, GITHUB_SHA and GH_TOKEN are required to publish');
  }
  const git = (...args) => execute('git', args, cwd);
  const gh = (...args) => execute('gh', args, cwd);
  if (!plan.reuseTag) {
    const main = git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0];
    if (main !== plan.sha) {
      console.log(JSON.stringify({ skipped: 'stale-main-commit', ...plan }));
      return { ...plan, skipped: 'stale-main-commit' };
    }
    git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'tag', '-a', plan.tag, plan.sha, '-m', `Jarvis ${plan.tag}`);
    // Never force-push: a concurrent manual tag must fail instead of being replaced.
    git('push', 'origin', `refs/tags/${plan.tag}`);
  }
  const remote = git('ls-remote', 'origin', `refs/tags/${plan.tag}`, `refs/tags/${plan.tag}^{}`);
  const refs = new Map(remote.split('\n').filter(Boolean).map((line) => {
    const [object, ref] = line.split(/\s+/);
    return [ref, object];
  }));
  if ((refs.get(`refs/tags/${plan.tag}^{}`) ?? refs.get(`refs/tags/${plan.tag}`)) !== plan.sha) {
    throw new Error('Remote release tag does not point to the expected commit');
  }
  // A failed API call is an error, never evidence that a release does not exist.
  const pages = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${plan.repository}/releases?per_page=100`));
  const existing = pages.flat().find((entry) => entry.tag_name === plan.tag);
  const latestFlag = `--latest=${shouldMarkLatest(plan.version, git('tag', '--list').split('\n'))}`;
  if (existing) {
    if (existing.draft || existing.prerelease) {
      gh('release', 'edit', plan.tag, '--repo', plan.repository, '--draft=false', '--prerelease=false', latestFlag);
    }
    return plan;
  }
  gh('release', 'create', plan.tag, '--repo', plan.repository, '--verify-tag', '--generate-notes',
    '--title', `Jarvis ${plan.tag}`, '--target', plan.sha, latestFlag);
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--dry-run')) throw new Error('Usage: node scripts/release.mjs [--dry-run]');
    release({ dryRun: args.includes('--dry-run') });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
