import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from '../tools.ts'
import type { LocalToolSettings } from './settings.ts'
import { NativeFilesystem, nativeFilesystemExecutable } from './native-filesystem.ts'

const MAX = 1024 * 1024
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const secret = /^(?:\.git|node_modules|\.ssh|\.gnupg|\.aws|\.azure|\.config|\.kube|\.jarvis-.*|\.env(?:\..*)?|\.(?:npmrc|netrc|pypirc|docker|vault.*|git-credentials|bash_history|zsh_history)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx)|.*(?:credentials|secrets?|tokens?|password|model[-_]config).*)$/i
function decode(bytes: Buffer): string {
  if (bytes.includes(0)) throw new Error('Binary data is not supported')
  if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(bytes.toString('utf8'))) throw new Error('Private key material is forbidden')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('File is not valid UTF-8') }
}

/** Native read capabilities are constructed only from explicitly configured readRoots.
 * The platform argument is trusted application/test wiring, never a tool argument. */
export function nativeFileDefinitions(deps: { settings: LocalToolSettings; storageFile?: string; externalConfigFile?: string }, platform: NodeJS.Platform = process.platform): ToolDefinition[] {
  if ((platform !== 'darwin' && platform !== 'win32') || !existsSync(nativeFilesystemExecutable())) return []
  const windows = platform === 'win32'
  const comparison = (value: string) => windows ? value.toLowerCase() : value
  const within = (root: string, target: string) => comparison(target) === comparison(root) || comparison(target).startsWith(comparison(root.endsWith(path.sep) ? root : root + path.sep))
  const components = (value: string) => value.slice(path.parse(value).root.length).split(path.sep).filter(Boolean)
  const validPart = (part: string) => !!part && part !== '.' && part !== '..' && !/[\\/\0]/.test(part) && (!windows || (!/[<>:"|?*~\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)))
  const absolute = (value: unknown) => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || (windows && (!/^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\')))) throw new Error('Expected an absolute ordinary path')
    // Reject traversal before normalization, including traversal that stays in a root.
    if (value.slice(path.parse(value).root.length).split(windows ? /[\\/]/ : '/').some(p => p && !validPart(p))) throw new Error('Unsafe path component')
    return path.resolve(value)
  }
  const inspect = (configured: string) => {
    const root = absolute(configured)
    let current = path.parse(root).root
    for (const part of components(root)) {
      current = path.join(current, part)
      const st = lstatSync(current, { bigint: true })
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Root components must be real directories')
    }
    if (comparison(realpathSync(root)) !== comparison(root)) throw new Error('Root is not canonical')
    const st = lstatSync(root, { bigint: true })
    return { root, identity: `${st.dev}:${st.ino}` }
  }
  const snapshot = deps.settings.snapshot(), settingsKey = JSON.stringify(snapshot)
  const externalConfigFile = Object.hasOwn(deps, 'externalConfigFile') ? deps.externalConfigFile : process.env.JARVIS_CONFIG_FILE
  const privateDirs = [path.dirname(deps.settings.file), path.dirname(deps.storageFile ?? path.join(path.dirname(deps.settings.file), 'local-files.json')), snapshot.outputDir, ...(externalConfigFile === undefined ? [] : [path.dirname(externalConfigFile)])].map(p => path.resolve(p))
  // Private storage permits symlink ancestors. Exclude both lexical and actual
  // directories, binding the latter so relocation cannot open a disclosure gap.
  const inspectPrivate = (configured: string) => {
    const root = realpathSync(configured), stat = lstatSync(root, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private directory is unsafe')
    return { root, identity: `${stat.dev}:${stat.ino}` }
  }
  const privateInitial = privateDirs.map(dir => { try { return inspectPrivate(dir) } catch { return null } })
  const privateExclusions = [...privateDirs, ...privateInitial.flatMap(dir => dir ? [dir.root] : [])]
  // macOS volumes may ignore case and Unicode normalization. Conservatively
  // fold private-path exclusions even though read-root authority stays exact.
  const privateWithin = (root: string, target: string) => {
    const fold = (value: string) => value.normalize('NFD').toLowerCase()
    return fold(target) === fold(root) || fold(target).startsWith(fold(root.endsWith(path.sep) ? root : root + path.sep))
  }
  const protectedPath = (target: string) => components(target).some(p => secret.test(p)) || privateExclusions.some(root => privateWithin(root, target)) || ['/proc', '/sys', '/dev'].some(root => within(root, target))
  const rootErrors: string[] = []
  const initial = snapshot.readRoots.map((configured, index) => {
    try { return inspect(configured) } catch (error) {
      // Surface validation categories without disclosing raw filesystem paths.
      rootErrors[index] = error instanceof Error && ['Expected an absolute ordinary path', 'Unsafe path component', 'Root components must be real directories', 'Root is not canonical'].includes(error.message) ? error.message : 'Directory metadata is unavailable'
      return null
    }
  })
  const assertCurrent = () => {
    if (process.env.JARVIS_CONFIG_FILE !== externalConfigFile) throw new Error('External config selection changed; refresh tool definitions')
    if (externalConfigFile !== undefined && (!path.isAbsolute(externalConfigFile) || externalConfigFile.includes('\0'))) throw new Error('External config path is unsafe')
    if (JSON.stringify(deps.settings.snapshot()) !== settingsKey) throw new Error('File settings changed; refresh tool definitions')
    for (let i = 0; i < privateInitial.length; i++) {
      const expected = privateInitial[i]
      if (!expected) throw new Error('Private directory is unavailable or unsafe')
      const now = inspectPrivate(privateDirs[i]!)
      if (now.root !== expected.root || now.identity !== expected.identity) throw new Error('Private directory changed; refresh tool definitions')
    }
    for (let i = 0; i < initial.length; i++) {
      const expected = initial[i]
      if (!expected) throw new Error(`Configured read root is unavailable or unsafe: ${rootErrors[i]}`)
      const now = inspect(snapshot.readRoots[i]!)
      if (now.root !== expected.root || now.identity !== expected.identity) throw new Error('Read root changed; refresh tool definitions')
    }
  }
  const authorize = (input: unknown) => {
    const target = absolute(input)
    if (protectedPath(target)) throw new Error('Protected path is forbidden')
    const root = initial.filter((r): r is NonNullable<typeof r> => r !== null && within(r.root, target)).sort((a, b) => b.root.length - a.root.length)[0]
    if (!root) throw new Error('Path is outside permitted read roots')
    const parts = path.relative(root.root, target).split(path.sep).filter(Boolean)
    if (!parts.every(validPart)) throw new Error('Unsafe relative path')
    return { target, root, parts }
  }
  const str = { type: 'string' }, integer = { type: 'integer', minimum: 1 }
  const specifications = [
    { name: 'file_list', description: 'List permitted files; symlinks and secret paths are excluded.', properties: { path: str, recursive: { type: 'boolean' }, includeHidden: { type: 'boolean' } }, required: ['path'] },
    { name: 'file_search', description: 'Search literal names or UTF-8 contents. Bounded to depth 8, 2000 files, 8 MiB and 10 seconds.', properties: { path: str, query: str, mode: { type: 'string', enum: ['name', 'contents'] }, includeHidden: { type: 'boolean' } }, required: ['path', 'query'] },
    { name: 'file_read', description: 'Read UTF-8 text up to 1 MiB. offset and limit are 1-based line offset and line count; returns SHA256 version.', properties: { path: str, offset: integer, limit: { ...integer, maximum: 10000 } }, required: ['path'] },
  ]
  return specifications.map(spec => {
    const parameters = { type: 'object', properties: spec.properties, required: spec.required, additionalProperties: false }
    return {
      name: spec.name, description: spec.description, parameters,
      definitionHash: hash(JSON.stringify({ backend: 'native-files-v1', platform, settings: snapshot, externalConfigFile, roots: initial, privateDirs, privateInitial, name: spec.name, parameters })),
      usage: 'local', permission: 'allow', effect: 'read', destination: 'local',
      async execute(args, context) {
        let fs: NativeFilesystem | undefined, token: string | undefined
        const controller = new AbortController(), abort = () => controller.abort(context.signal.reason)
        context.signal.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(() => controller.abort(new Error('File operation exceeded 10 seconds')), 10000)
        const check = () => { context.signal.throwIfAborted(); controller.signal.throwIfAborted(); assertCurrent() }
        // Check both sides of every asynchronous boundary, including failed requests.
        const checked = async <T>(operation: () => Promise<T>): Promise<T> => { check(); try { return await operation() } finally { check() } }
        let result: unknown, failure: unknown
        try {
          check()
          if (!existsSync(nativeFilesystemExecutable())) throw new Error('Native filesystem helper is unavailable')
          if (Object.keys(args).some(k => !Object.hasOwn(spec.properties, k))) throw new Error('Unknown argument')
          for (const key of ['recursive', 'includeHidden']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error('Expected boolean option')
          if (spec.name === 'file_search' && (typeof args.query !== 'string' || !args.query || (args.mode !== undefined && args.mode !== 'name' && args.mode !== 'contents'))) throw new Error('A non-empty literal query and valid search mode are required')
          const selected = authorize(args.path)
          // Assign before the post-await check so teardown still owns a newly started helper.
          await checked(async () => {
            const started = await NativeFilesystem.start([selected.root.root], { signal: controller.signal })
            fs = started.filesystem; token = started.roots[0]!
            const identity = started.identities[0]
            if (!identity || `${identity.device}:${identity.inode}` !== selected.root.identity) throw new Error('Read root changed during registration')
          })
          const read = (parts: string[], max = MAX) => checked(() => fs!.read(token!, parts, max))
          if (spec.name === 'file_read') {
            const offset = args.offset ?? 1, limit = args.limit ?? 200
            if (!Number.isSafeInteger(offset) || (offset as number) < 1 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 10000) throw new Error('Invalid line range')
            const bytes = await read(selected.parts), lines = decode(bytes).split('\n')
            result = { path: selected.target, version: hash(bytes), size: bytes.length, totalLines: lines.length, offset, endLine: Math.min(lines.length, (offset as number) + (limit as number) - 1), content: lines.slice((offset as number) - 1, (offset as number) - 1 + (limit as number)).join('\n') }
          } else {
            const results: unknown[] = []; let files = 0, bytes = 0, truncated = false
            const search = spec.name === 'file_search'
            const visit = async (dir: string, parts: string[], depth: number): Promise<void> => {
              check()
              if (files >= 2000 || bytes >= 8 * MAX || results.length >= 2000) { truncated = true; return }
              const listing = await checked(() => fs!.list(token!, parts, Math.min(1000, 2000 - files)))
              truncated ||= listing.truncated
              for (const entry of listing.entries) {
                check()
                if (files >= 2000 || bytes >= 8 * MAX || results.length >= 2000) { truncated = true; break }
                files++ // Count rejected entries too: directory names cannot evade the scan budget.
                const child = path.join(dir, entry.name), childParts = [...parts, entry.name]
                if (!validPart(entry.name) || protectedPath(child) || (!args.includeHidden && entry.name.startsWith('.')) || entry.kind === 'other') continue
                if (entry.kind === 'directory') {
                  if (!search) results.push({ path: child, type: 'directory' })
                  if (search || args.recursive) { if (depth < 8) await visit(child, childParts, depth + 1); else truncated = true }
                } else if (!search) results.push({ path: child, type: 'file' })
                else if (args.mode !== 'contents') { if (entry.name.includes(args.query as string)) results.push({ path: child }) }
                else {
                  if (entry.size > MAX || entry.size > 8 * MAX - bytes) { truncated = true; continue }
                  const allowance = Math.min(MAX, 8 * MAX - bytes)
                  let received = false
                  try {
                    const data = await read(childParts, allowance); bytes += data.length; received = true
                    const lines = decode(data).split('\n')
                    for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(args.query as string)) {
                      results.push({ path: child, line: i + 1, text: lines[i]!.slice(0, 500) })
                      if (results.length >= 2000) { truncated = true; break }
                    }
                  } catch {
                    // A failed helper read may have consumed its entire allowance
                    // before a race was detected; charge it conservatively.
                    if (!received) bytes += allowance
                    check() /* Skip unreadable, linked, binary and secret-content files. */
                  }
                }
              }
            }
            await visit(selected.target, selected.parts, 0)
            result = { results, truncated, filesScanned: files, bytesScanned: bytes }
          }
          check()
        } catch (error) { failure = error }
        finally {
          // Cleanup must run even when checks fail; retain failures until all handles close.
          const cleanup = async (operation: () => Promise<void>) => {
            try { check() } catch (error) { failure ??= error }
            try { await operation() } catch (error) { failure ??= error }
            try { check() } catch (error) { failure ??= error }
          }
          if (fs) {
            if (token) await cleanup(() => fs!.closeRoot(token!))
            await cleanup(() => fs!.disposeAsync())
          }
          clearTimeout(timer); context.signal.removeEventListener('abort', abort)
        }
        if (failure) return { content: failure instanceof Error ? failure.message : String(failure), isError: true }
        return { content: JSON.stringify(result) }
      },
    }
  })
}
