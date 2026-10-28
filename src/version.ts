import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

/** Read installed metadata relative to the application, never cwd or runtime env. */
export function runtimeVersion(root = resolve(import.meta.dirname, '..')): string {
  let text: string
  try {
    text = readFileSync(join(root, 'manifest.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (typeof pkg.version !== 'string' || !semver.test(pkg.version)) throw new Error('Invalid package version')
    return pkg.version
  }
  const manifest = JSON.parse(text)
  if (manifest.schemaVersion !== 1 || typeof manifest.version !== 'string' || !semver.test(manifest.version)
    || typeof manifest.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.sourceSha)
    || (manifest.sourceTag !== null && manifest.sourceTag !== `v${manifest.version}`)) {
    throw new Error('Invalid packaged version metadata')
  }
  return manifest.version
}
