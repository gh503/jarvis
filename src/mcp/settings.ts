import { chmod, mkdir, open, readFile, rename, unlink, stat } from 'node:fs/promises'
import { dirname, resolve, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withPrivateFileLock } from '../local-tools/private-storage.ts'

export type Permission = 'ask' | 'allow' | 'deny'
export type ToolPolicy = { enabled?: boolean; permission?: Permission; usage?: 'local' | 'shared'; effect?: 'read' | 'write' }
export interface ServerConfig {
  id: string; name?: string; enabled: boolean; transport: 'stdio' | 'streamable-http'
  command?: string; args?: string[]; cwd?: string; env?: Record<string, string>
  url?: string; headers?: Record<string, string>; destination: 'local' | 'remote'
  tools: Record<string, ToolPolicy>
  preset?: { id: string; version: number; mode: 'read' | 'write'; credentials: Record<string, string>; validatedFingerprint?: string; verifiedAt?: string; lastErrorCode?: string }
}
export type ServerInput = Partial<Omit<ServerConfig, 'id' | 'transport'>> & Pick<ServerConfig, 'id' | 'transport'> & { expectedRevision?: number }
export interface Settings { revision: number; servers: ServerConfig[] }
export class RevisionConflict extends Error { readonly status = 409; constructor() { super('MCP settings revision conflict; reload before editing') } }
export function validateUrl(value: string): URL {
  const url = new URL(value)
  if (url.username || url.password || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid MCP URL')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote MCP requires HTTPS')
  return url
}
function dictionary(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected string dictionary')
  const entries = Object.entries(value)
  if (entries.length > 100 || entries.some(([k,v]) => !k || typeof v !== 'string' || k.length > 256 || v.length > 8192)) throw new Error('Invalid secret dictionary')
  return Object.fromEntries(entries)
}
export function normalize(input: ServerInput, previous?: ServerConfig): ServerConfig {
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(input.id)) throw new Error('Invalid MCP server id')
  if (!['stdio', 'streamable-http'].includes(input.transport)) throw new Error('Invalid MCP transport')
  const merged = { ...previous, ...input }
  if (merged.enabled !== undefined && typeof merged.enabled !== 'boolean') throw new Error('Invalid enabled flag')
  if (merged.destination !== undefined && !['local', 'remote'].includes(merged.destination)) throw new Error('Invalid destination')
  const config: ServerConfig = { id: input.id, enabled: merged.enabled ?? false, transport: input.transport, destination: merged.destination ?? 'remote', tools: {} }
  if (merged.name !== undefined) { if (typeof merged.name !== 'string' || merged.name.length > 120) throw new Error('Invalid name'); config.name = merged.name }
  if (input.transport === 'stdio') {
    if (typeof merged.command !== 'string' || !merged.command.trim() || merged.command.length > 4096) throw new Error('Command required')
    config.command = merged.command
    if (merged.args !== undefined) { if (!Array.isArray(merged.args) || merged.args.length > 100 || merged.args.some(x => typeof x !== 'string' || x.length > 8192)) throw new Error('Invalid arguments'); config.args = [...merged.args] }
    if (merged.cwd !== undefined) { if (typeof merged.cwd !== 'string' || !isAbsolute(merged.cwd)) throw new Error('cwd must be absolute'); config.cwd = merged.cwd }
    if (merged.env !== undefined) config.env = dictionary(merged.env)
  } else {
    if (typeof merged.url !== 'string' || merged.url.length > 8192) throw new Error('URL required')
    config.url = validateUrl(merged.url).href
    if (merged.headers !== undefined) { config.headers = dictionary(merged.headers); new Headers(config.headers) }
  }
  if (merged.tools !== undefined) {
    if (!merged.tools || typeof merged.tools !== 'object' || Array.isArray(merged.tools) || Object.keys(merged.tools).length > 256) throw new Error('Invalid tool policy')
    for (const [name, policy] of Object.entries(merged.tools)) {
      if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(name) || !policy || typeof policy !== 'object') throw new Error('Invalid tool policy')
      if (policy.enabled !== undefined && typeof policy.enabled !== 'boolean' || policy.permission !== undefined && !['ask','allow','deny'].includes(policy.permission) || policy.usage !== undefined && !['local','shared'].includes(policy.usage) || policy.effect !== undefined && !['read','write'].includes(policy.effect)) throw new Error('Invalid tool policy')
      config.tools[name] = { enabled: policy.enabled, permission: policy.permission, usage: policy.usage, effect: policy.effect }
    }
  }
  if (merged.preset !== undefined) {
    const p = merged.preset
    const keys = ['id', 'version', 'mode', 'credentials', 'validatedFingerprint', 'verifiedAt', 'lastErrorCode']
    if (!p || typeof p !== 'object' || Object.keys(p).some(k => !keys.includes(k)) || !/^[a-zA-Z0-9_-]{1,41}$/.test(p.id) || input.id !== `preset-${p.id}` || !Number.isSafeInteger(p.version) || p.version < 1 || !['read', 'write'].includes(p.mode)) throw new Error('Invalid preset metadata')
    if (p.validatedFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(p.validatedFingerprint)) throw new Error('Invalid preset fingerprint')
    if (p.verifiedAt !== undefined && (typeof p.verifiedAt !== 'string' || !Number.isFinite(Date.parse(p.verifiedAt)))) throw new Error('Invalid verification date')
    if (p.lastErrorCode !== undefined && !['AUTH_REQUIRED', 'RATE_LIMITED', 'UNREACHABLE', 'INVALID_SERVER', 'TIMEOUT'].includes(p.lastErrorCode)) throw new Error('Invalid preset error')
    config.preset = { ...p, credentials: dictionary(p.credentials) }
  }
  return config
}
export function publicConfig(config: ServerConfig) {
  // Command arguments, working directory and URL query/path can also contain credentials.
  return { id: config.id, name: config.name, enabled: config.enabled, transport: config.transport, destination: config.destination, tools: structuredClone(config.tools),
    command: config.command ? '[configured]' : undefined, argsCount: config.args?.length ?? 0, hasCwd: !!config.cwd,
    preset: config.preset ? { id: config.preset.id, mode: config.preset.mode, verifiedAt: config.preset.verifiedAt, configured: true } : undefined,
    url: config.url ? (config.preset ? '[configured]' : new URL(config.url).origin) : undefined, hasEnv: !!Object.keys(config.env ?? {}).length, hasHeaders: !!Object.keys(config.headers ?? {}).length }
}
export class McpSettings {
  readonly file: string
  constructor(file: string) { this.file = resolve(file) }
  async load(): Promise<Settings> {
    try {
      if ((await stat(this.file)).size > 1_000_000) throw new Error('MCP settings too large')
      const data = JSON.parse(await readFile(this.file, 'utf8'))
      if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.servers) || data.servers.length > 32) throw new Error('Invalid MCP settings')
      const servers = data.servers.map((s: ServerInput) => normalize(s))
      if (new Set(servers.map((s: ServerConfig) => s.id)).size !== servers.length) throw new Error('Duplicate MCP server id')
      await chmod(this.file, 0o600)
      return { revision: data.revision, servers }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, servers: [] }; throw error }
  }
  async change(expected: number | undefined, apply: (data: Settings) => void): Promise<Settings> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    // SQLite serializes read/CAS/rename across native processes and releases on crash.
    return withPrivateFileLock(this.file, async () => {
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      const data = await this.load()
      if (expected !== undefined && expected !== data.revision) throw new RevisionConflict()
      apply(data)
      data.revision++
      const serialized = JSON.stringify(data, null, 2) + '\n'
      if (Buffer.byteLength(serialized) > 1_000_000) throw new Error('MCP settings too large')
      const out = await open(temp, 'wx', 0o600)
      try { await out.writeFile(serialized); await out.sync() } finally { await out.close() }
      await rename(temp, this.file)
      return data
    } finally {
      await unlink(temp).catch(() => {})
    }
    })
  }
}
