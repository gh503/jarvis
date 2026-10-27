import { createHash } from 'node:crypto'
import { presetVerified, presetToolPolicy, PresetError, safeProbeError } from './presets.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema, ListToolsResultSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { validateToolValue } from '../tool-schema.ts'
import { McpSettings, normalize, publicConfig, RevisionConflict, validateUrl } from './settings.ts'
import type { ServerConfig, ServerInput, Settings, Permission } from './settings.ts'

export interface McpTool {
  name: string; description: string; parameters: Record<string, unknown>; definitionHash: string
  serverId: string; rawName: string; usage: 'local' | 'shared'; permission: Permission
  destination: 'local' | 'remote'; effect: 'read' | 'write'
  execute(args: Record<string, unknown>, context: { signal?: AbortSignal }): Promise<{ content: string; isError?: boolean }>
}
type State = { config: ServerConfig; status: 'disabled' | 'connecting' | 'connected' | 'disconnected'; client?: Client; tools: McpTool[]; epoch: number; attempts: number; timer?: NodeJS.Timeout; abort: AbortController; pending?: Promise<void>; discovering?: boolean; errorCode?: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function toolName(id: string, raw: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(raw)) throw new Error('Invalid MCP tool name')
  const base = `mcp__${id}__${raw.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  return base.length <= 64 && !/[.-]/.test(raw) ? base : `${base.slice(0, 47)}_${hash([id,raw]).slice(0,16)}`
}
function safeJson(value: unknown): string {
  return JSON.stringify(value, (key, item) => /^(data|blob|base64)$/i.test(key) ? '[binary omitted]' : item) ?? ''
}
function resultText(result: unknown): string {
  const data = result as { content?: Array<{ type?: string; text?: string; resource?: { text?: string } }>; contents?: Array<{ text?: string }>; structuredContent?: unknown }
  const texts: string[] = []
  for (const item of data.content ?? []) { if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text); else if (item.type === 'resource' && typeof item.resource?.text === 'string') texts.push(item.resource.text) }
  for (const item of data.contents ?? []) if (typeof item.text === 'string') texts.push(item.text)
  if (data.structuredContent !== undefined) texts.push(safeJson(data.structuredContent))
  return texts.join('\n')
}
/** Redact exact private values and common transport encodings before publishing remote text. */
export function scrubPresetText(config: ServerConfig, text: string): string {
  if (!config.preset) return text
  const values = [...Object.values(config.preset.credentials), ...Object.values(config.headers ?? {}), ...Object.values(config.env ?? {})].filter(Boolean)
  for (const [key, value] of Object.entries(config.headers ?? {})) if (/^(authorization|proxy-authorization)$/i.test(key)) {
    const payload = /^(?:Basic|Bearer)\s+(.+)$/i.exec(value)?.[1]
    if (payload) values.push(payload, payload.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
  }
  const secrets = new Set(values.flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'), JSON.stringify(value).slice(1, -1)]))
  for (const value of [...secrets].sort((a,b) => b.length - a.length)) text = text.split(value).join('[redacted]')
  return text
}
/** All redirects are rejected (zero is a bounded redirect count). Never forward credentials to another host. */
export const guardedFetch: typeof fetch = async (input, init) => {
  validateUrl(input instanceof Request ? input.url : String(input))
  const response = await fetch(input, { ...init, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('MCP redirects are disabled') }
  return response
}
export class McpManager {
  private readonly store: McpSettings
  private data: Settings = { revision: 0, servers: [] }
  private states = new Map<string, State>()
  private closed = false
  private probes = new Set<AbortController>()
  private serial: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: { file: string; onChanged?: () => void; logger?: { warn?: (...args: any[]) => void; info?: (...args: any[]) => void } }) { this.store = new McpSettings(options.file) }
  private changed() { try { this.options.onChanged?.() } catch { /* Observer cannot disrupt transport cleanup. */ } }
  async initialize(): Promise<void> {
    try {
      this.data = await this.store.load()
      if (this.data.servers.some(s => s.enabled && s.id.startsWith('preset-') && !presetVerified(s))) {
        this.data = await this.store.change(this.data.revision, data => { for (const s of data.servers) if (s.enabled && s.id.startsWith('preset-') && !presetVerified(s)) s.enabled = false })
      }
      await this.sync()
    } catch { this.options.logger?.warn?.('MCP settings could not be loaded'); }
  }
  snapshot() { return { revision: this.data.revision, servers: this.data.servers.map(config => { const state = this.states.get(config.id); return { ...publicConfig(config), status: state?.status ?? 'disabled', errorCode: state?.errorCode, toolCount: state?.tools.filter(t => t.permission !== 'deny').length ?? 0, discoveredTools: (config.preset ? [] : state?.tools ?? []).map(({ execute, ...tool }) => ({ ...tool, parameters: structuredClone(tool.parameters) })) } }) } }
  definitions(): McpTool[] { return [...this.states.values()].filter(s => s.config.enabled).flatMap(s => s.tools.map(t => ({ ...t, parameters: structuredClone(t.parameters) }))) }
  private queue<T>(fn: () => Promise<T>): Promise<T> { const next = this.serial.then(fn, fn); this.serial = next.catch(() => {}); return next }
  /** Internal facade access; never serialize this private snapshot to clients. */
  presetSettings(): Settings { return structuredClone(this.data) }
  async save(input: ServerInput, options?: { managed: true }) {
    if ((input.id.startsWith('preset-') || input.preset !== undefined) && options?.managed !== true) throw new Error('Preset configuration is managed')
    if (options?.managed && (!input.preset || input.id !== `preset-${input.preset.id}`)) throw new Error('Invalid managed preset')
    return this.queue(async () => {
      this.data = await this.store.change(input.expectedRevision, data => {
        const index = data.servers.findIndex(s => s.id === input.id)
        if (index >= 0 && input.expectedRevision === undefined) throw new RevisionConflict()
        const config = normalize(input, data.servers[index])
        if (config.id.startsWith('preset-') && config.enabled && !presetVerified(config)) throw new Error('Preset verification required')
        if (index >= 0) data.servers[index] = config
        else { if (data.servers.length >= 32) throw new Error('MCP server limit exceeded'); data.servers.push(config) }
      })
      await this.sync(); return this.snapshot()
    })
  }
  async remove(id: string, expectedRevision: number, options?: { managed: true }): Promise<void> {
    if (id.startsWith('preset-') && options?.managed !== true) throw new Error('Preset configuration is managed')
    await this.queue(async () => {
      if (!Number.isSafeInteger(expectedRevision)) throw new RevisionConflict()
      this.data = await this.store.change(expectedRevision, data => { data.servers = data.servers.filter(s => s.id !== id) })
      await this.sync()
    })
  }
  async erase(): Promise<void> {
    for (const probe of this.probes) probe.abort()
    await this.queue(async () => {
      this.data = await this.store.change(undefined, data => { data.servers = [] })
      const clients = [...this.states.values()].map(s => s.client)
      await this.sync()
      await Promise.allSettled(clients.map(c => c?.close()))
    })
  }
  private async sync() {
    const stopping: Promise<void>[] = []
    for (const [id, state] of this.states) {
      const config = this.data.servers.find(s => s.id === id)
      if (!config || hash(config) !== hash(state.config)) { stopping.push(this.stop(state)); this.states.delete(id) }
    }
    await Promise.allSettled(stopping)
    for (const config of this.data.servers) if (!this.states.has(config.id)) {
      const state: State = { config, status: 'disabled', tools: [], epoch: 0, attempts: 0, abort: new AbortController() }
      this.states.set(config.id, state)
      if (config.enabled && !this.closed) this.launch(state)
    }
    this.changed()
  }
  private async stop(state: State) {
    state.epoch++; state.abort.abort(); clearTimeout(state.timer); state.timer = undefined; state.status = 'disconnected'
    const client = state.client; state.client = undefined
    if (client) await client.close().catch(() => {})
    await state.pending
  }
  private launch(state: State) {
    if (this.closed || !state.config.enabled || state.pending || this.states.get(state.config.id) !== state) return
    const pending = this.connect(state).finally(() => { if (state.pending === pending) state.pending = undefined })
    state.pending = pending
  }
  async reconnect(id: string): Promise<void> {
    await this.queue(async () => {
      const state = this.states.get(id)
      if (!state || !state.config.enabled || this.closed) throw new Error('MCP server is disabled or missing')
      await this.stop(state); await state.pending; state.attempts = 0; this.launch(state); await state.pending
    })
  }
  private retry(state: State) {
    if (this.closed || !state.config.enabled || this.states.get(state.config.id) !== state || state.attempts >= 5 || state.timer) return
    const delay = Math.min(30_000, 1000 * 2 ** state.attempts++)
    state.timer = setTimeout(() => { state.timer = undefined; this.launch(state) }, delay); state.timer.unref()
  }
  private createTransport(config: ServerConfig) {
    let transport
      if (config.transport === 'stdio') {
        const env: Record<string, string | undefined> = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(k => [k, undefined]))
        for (const key of ['PATH','HOME','LANG','TMPDIR']) if (process.env[key] && !process.env[key]!.startsWith('()')) env[key] = process.env[key]
        Object.assign(env, config.env)
        transport = new StdioClientTransport({ command: config.command!, args: config.args, cwd: config.cwd, env: env as Record<string,string>, stderr: 'ignore', maxBufferSize: 2_000_000 })
      } else transport = new StreamableHTTPClientTransport(validateUrl(config.url!), { requestInit: { headers: config.headers, redirect: 'manual' }, fetch: guardedFetch, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 2 } })
    return transport
  }
  /** Initialize and list tools only; never registers the candidate in runtime state. */
  async probe(config: ServerConfig): Promise<{ toolCount: number }> {
    const client = new Client({ name: 'jarvis-mcp-probe', version: '1.0.0' }, { capabilities: {} })
    client.onerror = () => {}
    if (this.closed) throw new PresetError('UNREACHABLE')
    const controller = new AbortController()
    this.probes.add(controller)
    const timer = setTimeout(() => controller.abort(), 15_000)
    const signal = controller.signal
    const abort = () => { void client.close().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    const state: State = { config, status: 'disabled', tools: [], epoch: 0, attempts: 0, abort: controller }
    try {
      await client.connect(this.createTransport(config), { signal, timeout: 15_000 })
      try { await this.discover(state, client, 0, signal, true) } catch (error) {
        const code = safeProbeError(error)
        throw new PresetError(code === 'UNREACHABLE' ? 'INVALID_SERVER' : code)
      }
      const toolCount = state.tools.filter(t => t.permission !== 'deny').length
      if (!toolCount) throw new PresetError('INVALID_SERVER')
      return { toolCount }
    } catch (error) { throw new PresetError(signal.aborted ? 'TIMEOUT' : safeProbeError(error)) }
    finally { this.probes.delete(controller); clearTimeout(timer); signal.removeEventListener('abort', abort); await client.close().catch(() => {}) }
  }
  private async connect(state: State) {
    const epoch = ++state.epoch; state.abort = new AbortController(); state.status = 'connecting'; this.changed()
    const client = new Client({ name: 'jarvis-mcp', version: '1.0.0' }, { capabilities: {} })
    state.client = client
    const signal = AbortSignal.any([state.abort.signal, AbortSignal.timeout(30_000)])
    const alive = () => !this.closed && state.epoch === epoch && !signal.aborted
    client.onclose = () => {
      if (state.epoch !== epoch || this.closed) return
      state.status = 'disconnected'; state.abort.abort(); this.changed(); this.retry(state)
    }
    client.onerror = () => { /* No raw server errors or secrets in logs/UI. */ }
    const onAbort = () => { void client.close().catch(() => {}) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const transport = this.createTransport(state.config)
      await client.connect(transport, { signal, timeout: 30_000 })
      await this.discover(state, client, epoch, signal)
      if (!alive()) throw new Error('Connection superseded')
      state.status = 'connected'; state.errorCode = undefined; this.changed()
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (state.discovering || state.status !== 'connected') return
        state.discovering = true
        try { await this.discover(state, client, epoch, AbortSignal.any([state.abort.signal, AbortSignal.timeout(30_000)])); this.changed() } catch {
          // The published generation and its validators remain intact until discovery succeeds.
        } finally { state.discovering = false }
      })
    } catch (error) {
      if (state.epoch === epoch) { state.errorCode = safeProbeError(error); state.status = 'disconnected'; state.abort.abort(); this.changed(); this.retry(state) }
      await client.close().catch(() => {})
    } finally { signal.removeEventListener('abort', onAbort) }
  }
  private async discover(state: State, client: Client, epoch: number, signal: AbortSignal, probe = false) {
    const tools: McpTool[] = []; const names = new Set<string>(); let total = 0
    if (client.getServerCapabilities()?.tools) {
      let cursor: string | undefined
      const cursors = new Set<string>()
      for (let page = 0; page < 10; page++) {
        // SDK listTools replaces its output-validator cache on each page. Keep generation-local validators instead.
        const result = await client.request({ method: 'tools/list', params: cursor ? { cursor } : {} }, ListToolsResultSchema, { signal, timeout: 30_000 })
        for (const raw of result.tools) {
          const size = JSON.stringify(raw).length; total += size
          if (size > 32_000 || total > 256_000 || names.size >= 128) throw new Error('MCP catalogue too large')
          const name = toolName(state.config.id, raw.name)
          if (names.has(name) || ['resources_list','resources_read'].includes(raw.name)) throw new Error('MCP tool name collision')
          names.add(name)
          if (probe) {
            for (const schema of [raw.inputSchema, raw.outputSchema]) if (schema !== undefined) {
              const checked = await validateToolValue(schema as Record<string, unknown>, {}, { signal })
              if (!checked.valid && checked.error !== 'Tool value does not match schema') throw new PresetError('INVALID_SERVER')
            }
          }
          if (state.config.tools[raw.name]?.enabled === false) continue
          tools.push(this.definition(state, client, epoch, raw.name, raw.description ?? '', raw.inputSchema as Record<string,unknown>, 'tool', raw.outputSchema))
        }
        cursor = result.nextCursor
        if (!cursor) break
        if (cursors.has(cursor) || page === 9) throw new Error('MCP pagination limit')
        cursors.add(cursor)
      }
    }
    if (!probe && client.getServerCapabilities()?.resources) {
      for (const kind of ['resources_list', 'resources_read'] as const) if (state.config.tools[kind]?.enabled !== false) tools.push(this.definition(state, client, epoch, kind, kind === 'resources_list' ? 'List resources from this MCP server (bounded to 100 resources).' : 'Read one explicit resource URI from this MCP server.', kind === 'resources_list' ? { type: 'object', properties: {}, additionalProperties: false } : { type: 'object', properties: { uri: { type: 'string', minLength: 1, maxLength: 8192 } }, required: ['uri'], additionalProperties: false }, kind))
    }
    if (signal.aborted || state.epoch !== epoch || this.closed || !probe && this.states.get(state.config.id) !== state) throw new Error('Stale discovery')
    const otherNames = new Set([...this.states.values()].filter(s => s !== state).flatMap(s => s.tools.map(t => t.name)))
    if (tools.some(t => otherNames.has(t.name))) throw new Error('MCP namespace collision')
    state.tools = tools
  }
  private definition(state: State, client: Client, epoch: number, rawName: string, description: string, parameters: Record<string,unknown>, kind: 'tool' | 'resources_list' | 'resources_read', outputSchema?: Record<string, unknown>): McpTool {
    const scrub = (text: string) => scrubPresetText(state.config, text)
    for (const value of [rawName, JSON.stringify(parameters), JSON.stringify(outputSchema)]) if (value && scrub(value) !== value) throw new PresetError('INVALID_SERVER')
    const policy = state.config.preset ? presetToolPolicy(state.config, rawName) : state.config.tools[rawName] ?? {}
    const base = { name: toolName(state.config.id, rawName), description: scrub(description).slice(0,4000), parameters, serverId: state.config.id, rawName, usage: policy.usage ?? 'local', permission: policy.permission ?? 'ask', destination: state.config.preset ? 'remote' : state.config.destination, effect: policy.effect ?? 'write' } as const
    const definitionHash = hash({ ...base, outputSchema, revision: this.data.revision, epoch })
    return { ...base, definitionHash, execute: async (args, context) => {
      if (this.closed || state.epoch !== epoch || state.status !== 'connected' || this.states.get(state.config.id) !== state || !state.tools.some(t => t.definitionHash === definitionHash)) throw new Error('MCP tool unavailable or definition changed')
      if (policy.permission === 'deny') throw new Error('MCP tool denied')
      const signal = AbortSignal.any([state.abort.signal, AbortSignal.timeout(60_000), ...(context.signal ? [context.signal] : [])])
      signal.throwIfAborted()
      const options = { signal, timeout: 60_000, maxTotalTimeout: 60_000 }
      try {
      if (kind === 'tool') {
        const result = await client.request({ method: 'tools/call', params: { name: rawName, arguments: args } }, CallToolResultSchema, options)
        if (outputSchema !== undefined && result.isError !== true) {
          if (result.structuredContent === undefined) throw new Error('MCP output schema requires structured content')
          const checked = await validateToolValue(outputSchema, result.structuredContent, { signal, maxValueBytes: 1_000_000 })
          if (!checked.valid) throw new Error('MCP output schema validation failed')
        }
        return { content: scrub(resultText(result)).slice(0, 16_000), isError: result.isError === true }
      }
      if (kind === 'resources_read') {
        if (typeof args.uri !== 'string' || !args.uri || args.uri.length > 8192) throw new Error('Explicit resource URI required')
        return { content: scrub(resultText(await client.readResource({ uri: args.uri }, options))).slice(0, 16_000) }
      }
      const resources: unknown[] = []; let cursor: string | undefined; const seen = new Set<string>()
      for (let page = 0; page < 5; page++) {
        const result = await client.listResources(cursor ? { cursor } : {}, options)
        resources.push(...result.resources.slice(0, 100 - resources.length))
        cursor = result.nextCursor
        if (!cursor || resources.length >= 100 || seen.has(cursor)) break
        seen.add(cursor)
      }
      return { content: scrub(safeJson({ resources, truncated: !!cursor })).slice(0,16_000) }
      } catch (error) { if (state.config.preset) throw new PresetError(safeProbeError(error)); throw error }
    } }
  }
  async close(): Promise<void> {
    this.closed = true
    for (const probe of this.probes) probe.abort()
    const clients = [...this.states.values()].map(s => s.client)
    await Promise.allSettled([...this.states.values()].map(state => this.stop(state)))
    await Promise.allSettled(clients.map(c => c?.close()))
    await Promise.allSettled([...this.states.values()].map(s => s.pending))
    this.changed()
  }
}
