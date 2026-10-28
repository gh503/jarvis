import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[a-f0-9]{40}$/;
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
const api = path => JSON.parse(run('gh', ['api', path]));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const repo = () => {
  const value = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(value ?? '')) throw new Error('Invalid repository');
  return value;
};
function remoteSha(tag) {
  if (!stableTag.test(tag)) throw new Error('Expected exact stable vX.Y.Z tag');
  const refs = new Map(run('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).split('\n').filter(Boolean).map(line => {
    const [sha, ref] = line.split(/\s+/); return [ref, sha];
  }));
  const sha = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  if (!shaPattern.test(sha ?? '')) throw new Error('Remote release tag missing');
  return sha;
}
export function selectPublishedRelease(releases, tag, sha, resolveTag) {
  const candidates = releases.filter(r => !r.draft && !r.prerelease && stableTag.test(r.tag_name) && (!tag || r.tag_name === tag));
  const matching = candidates.filter(r => resolveTag(r.tag_name) === sha);
  if (matching.length !== 1) throw new Error(`Expected one published stable release for exact source; found ${matching.length}`);
  return matching[0];
}
export function resolveRelease() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const tag = manual ? event.inputs?.tag : undefined;
  if (manual && !stableTag.test(tag ?? '')) throw new Error('Manual preview requires exact stable tag');
  if (!manual && (event.workflow_run?.conclusion !== 'success' || event.workflow_run?.head_branch !== 'main'
    || event.workflow_run?.head_repository?.full_name !== repo() || !['push', 'workflow_dispatch'].includes(event.workflow_run?.event))) throw new Error('Untrusted or unsuccessful CI run');
  const sha = manual ? remoteSha(tag) : event.workflow_run.head_sha;
  if (!shaPattern.test(sha ?? '')) throw new Error('Invalid source SHA');
  const releases = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${repo()}/releases?per_page=100`])).flat();
  const release = selectPublishedRelease(releases, tag, sha, remoteSha);
  appendFileSync(process.env.GITHUB_OUTPUT, `tag=${release.tag_name}\nversion=${release.tag_name.slice(1)}\nsha=${sha}\n`);
}
export function assetStem(version, platform, arch, sha) {
  if (!stableTag.test(`v${version}`) || !shaPattern.test(sha) || !['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Invalid asset provenance');
  return `jarvis-${version}-${platform}-${arch}-${sha}-unsigned`;
}
export function prepareAssets() {
  const { JARVIS_RELEASE_VERSION: version, JARVIS_SOURCE_SHA: sha, JARVIS_RELEASE_TAG: tag } = process.env;
  if (tag !== `v${version}` || remoteSha(tag) !== sha) throw new Error('Release moved before asset preparation');
  const extension = process.platform === 'win32' ? '.zip' : '.tar.gz';
  const source = join('dist', `jarvis-${version}-${process.platform}-${process.arch}${extension}`);
  const name = assetStem(version, process.platform, process.arch, sha) + extension;
  const bytes = readFileSync(source);
  const hash = digest(bytes);
  if (readFileSync(`${source}.sha256`, 'utf8').split(/\s+/)[0] !== hash) throw new Error('Archive checksum mismatch');
  mkdirSync('release-assets', { recursive: true });
  copyFileSync(source, join('release-assets', name));
  writeFileSync(join('release-assets', `${name}.sha256`), `${hash}  ${name}\n`);
  writeFileSync(join('release-assets', `${name}.provenance.json`), JSON.stringify({ schemaVersion: 1, version, sourceSha: sha, sourceTag: tag, platform: process.platform, arch: process.arch, signing: 'unsigned', archive: name, sha256: hash }, null, 2) + '\n');
}
export function validateAssetSet(directory, tag, sha) {
  const names = readdirSync(directory).sort();
  const manifests = names.filter(name => name.endsWith('.provenance.json'));
  if (manifests.length !== 3 || names.length !== 9) throw new Error('Expected exactly three complete native asset sets');
  const platforms = new Set();
  for (const file of manifests) {
    const p = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    const archive = assetStem(tag.slice(1), p.platform, p.arch, sha) + (p.platform === 'win32' ? '.zip' : '.tar.gz');
    if (p.schemaVersion !== 1 || p.version !== tag.slice(1) || p.sourceTag !== tag || p.sourceSha !== sha || p.signing !== 'unsigned' || p.archive !== archive || file !== `${archive}.provenance.json` || platforms.has(p.platform)) throw new Error('Asset provenance mismatch');
    platforms.add(p.platform);
    if (digest(readFileSync(join(directory, archive))) !== p.sha256 || readFileSync(join(directory, `${archive}.sha256`), 'utf8') !== `${p.sha256}  ${archive}\n`) throw new Error('Asset checksum mismatch');
  }
  return names;
}
export function publishAssets() {
  if (process.env.GITHUB_EVENT_NAME !== 'workflow_run' || process.env.JARVIS_NATIVE_RELEASE_PUBLISH !== 'true') throw new Error('Publication is disabled');
  const { JARVIS_RELEASE_TAG: tag, JARVIS_SOURCE_SHA: sha } = process.env;
  if (remoteSha(tag) !== sha) throw new Error('Remote tag changed');
  const release = api(`repos/${repo()}/releases/tags/${tag}`);
  if (release.draft || release.prerelease) throw new Error('Expected published stable release');
  const names = validateAssetSet('release-assets', tag, sha);
  const existing = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${repo()}/releases/${release.id}/assets?per_page=100`])).flat();
  // Preflight every conflict before uploading anything. GitHub's upload endpoint never overwrites.
  for (const name of names) {
    const asset = existing.find(a => a.name === name);
    if (!asset) continue;
    const bytes = execFileSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${repo()}/releases/assets/${asset.id}`], { maxBuffer: 512 * 1024 * 1024 });
    if (digest(bytes) !== digest(readFileSync(join('release-assets', name)))) throw new Error(`Existing release asset differs: ${name}`);
  }
  for (const name of names.filter(name => !existing.some(a => a.name === name))) {
    run('gh', ['release', 'upload', tag, join('release-assets', basename(name)), '--repo', repo()]);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const commands = { resolve: resolveRelease, prepare: prepareAssets, publish: publishAssets };
  const command = commands[process.argv[2]];
  if (!command) throw new Error('Usage: native-release.mjs resolve|prepare|publish');
  command();
}
