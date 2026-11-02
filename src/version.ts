import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { join, resolve } from 'node:path'

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const appRoot = resolve(import.meta.dirname, '..')
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024

export interface RuntimeBuildIdentity {
  version: string
  sourceSha: string
  manifestSha256: string
}

function installedMetadata(root: string): { version: string; sourceSha: string; bytes: Buffer } | undefined {
  let fd: number
  try {
    fd = openSync(join(root, 'manifest.json'), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let bytes: Buffer
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error('Invalid packaged version metadata: manifest must be a file at most 16 MiB')
    // One extra byte detects growth without allowing an unbounded read.
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length !== stat.size) throw new Error('Invalid packaged version metadata: manifest changed while reading')
    bytes = buffer.subarray(0, length)
  } finally {
    closeSync(fd)
  }
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.version !== 'string' || !semver.test(manifest.version)
    || typeof manifest.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.sourceSha)
    || (manifest.sourceTag !== null && manifest.sourceTag !== `v${manifest.version}`)) {
    throw new Error('Invalid packaged version metadata')
  }
  return { version: manifest.version, sourceSha: manifest.sourceSha, bytes }
}

/** Read installed metadata relative to the application, never cwd or runtime env. */
export function runtimeVersion(root = appRoot): string {
  const installed = installedMetadata(root)
  if (installed) return installed.version
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (typeof pkg.version !== 'string' || !semver.test(pkg.version)) throw new Error('Invalid package version')
  return pkg.version
}

/** Installed metadata identity, not payload verification or a signed attestation. */
export function runtimeBuildIdentity(root = appRoot): RuntimeBuildIdentity | undefined {
  const installed = installedMetadata(root)
  if (!installed) return undefined
  return {
    version: installed.version,
    sourceSha: installed.sourceSha,
    manifestSha256: createHash('sha256').update(installed.bytes).digest('hex'),
  }
}
