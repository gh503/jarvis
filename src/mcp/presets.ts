import { createHash } from 'node:crypto'
import { mcpCatalog, buildPresetConfig } from './catalog.ts'
import { normalize, RevisionConflict } from './settings.ts'
import type { ServerConfig, ToolPolicy } from './settings.ts'
import type { McpManager } from './manager.ts'

export interface PresetField { key: string; label: string; secret: boolean; required: boolean; placeholder?: string; help?: string }
export interface PresetDefinition {
  id: string; name: string; category: string; description: string; available: boolean; fields: PresetField[]
  help: { setup: string[]; usage: string[]; limitations: string[]; credentialsUrl: string; docsUrl: string; revokeUrl?: string }
  readOnly: boolean; version?: number; toolPolicy?: { permittedReadTools?: string[] }
}
export type PresetErrorCode = 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'UNREACHABLE' | 'INVALID_SERVER' | 'TIMEOUT' | 'INVALID_INPUT' | 'NOT_FOUND' | 'UNAVAILABLE'
export class PresetError extends Error { readonly status: number; constructor(readonly code: PresetErrorCode) { super(code); this.status = code === 'NOT_FOUND' ? 404 : code === 'UNAVAILABLE' ? 503 : 400 } }
const definition = (id: string): PresetDefinition => { const p = mcpCatalog.find(p => p.id === id); if (!p) throw new PresetError('NOT_FOUND'); if (!p.available) throw new PresetError('UNAVAILABLE'); return p }
function stable(value: unknown): unknown { return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,stable(v)])) : value }
export function presetConfig(id: string, credentials: Record<string,string>, mode: 'read' | 'write'): ServerConfig {
  const p = definition(id)
  if (!['read','write'].includes(mode) || p.readOnly && mode === 'write' || Object.keys(credentials).some(k => !p.fields.some(f => f.key === k)) || p.fields.some(f => f.required && !credentials[f.key]?.trim())) throw new PresetError('INVALID_SERVER')
  try { return normalize({ ...buildPresetConfig(id, credentials, mode), id: `preset-${id}`, enabled: false, destination: 'remote', tools: {}, preset: { id, version: p.version ?? 1, mode, credentials } }) } catch { throw new PresetError('INVALID_SERVER') }
}
export function presetFingerprint(config: ServerConfig): string {
  if (!config.preset) throw new PresetError('INVALID_SERVER')
  const generated = presetConfig(config.preset.id, config.preset.credentials, config.preset.mode)
  const entry = definition(config.preset.id)
  return createHash('sha256').update(JSON.stringify(stable({ config: generated, toolPolicy: entry.toolPolicy, readOnly: entry.readOnly }))).digest('hex')
}
export function presetVerified(config: ServerConfig): boolean {
  try {
    if (!config.preset || config.preset.version !== (definition(config.preset.id).version ?? 1)) return false
    const expected = presetConfig(config.preset.id, config.preset.credentials, config.preset.mode)
    const actual = { ...config, enabled: false, preset: expected.preset }
    return JSON.stringify(stable(actual)) === JSON.stringify(stable(expected)) && config.preset.validatedFingerprint === presetFingerprint(config)
  } catch { return false }
}
export function presetToolPolicy(config: ServerConfig, rawName: string): ToolPolicy {
  const preset = config.preset!
  const entry = mcpCatalog.find(p => p.id === preset.id)
  const allowed = entry?.toolPolicy?.permittedReadTools ?? (entry?.readOnly ? [] : undefined)
  if (preset.mode === 'read' && allowed?.includes(rawName)) return { usage: 'local', effect: 'read', permission: 'allow' }
  return { usage: 'local', effect: 'write', permission: allowed ? 'deny' : 'ask' }
}
export function safeProbeError(error: unknown): PresetErrorCode {
  if (error instanceof PresetError) return error.code
  const e = error as { status?: number; statusCode?: number; code?: number | string; name?: string }
  const code = e?.status ?? e?.statusCode ?? e?.code
  if (code === 401 || code === 403) return 'AUTH_REQUIRED'
  if (code === 429) return 'RATE_LIMITED'
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || code === 'ETIMEDOUT') return 'TIMEOUT'
  return 'UNREACHABLE'
}
export class McpPresets {
  private probing = new Set<string>()
  constructor(private readonly options: { manager: McpManager; probe?: (config: ServerConfig) => Promise<{ toolCount: number }> }) {}
  snapshot() {
    const data = this.options.manager.presetSettings()
    const runtime = this.options.manager.snapshot()
    return { revision: data.revision, services: mcpCatalog.map(p => {
      const config = data.servers.find(s => s.id === `preset-${p.id}`); const meta = config?.preset
      const state = runtime.servers.find(s => s.id === config?.id)
      const verified = !!config && presetVerified(config)
      const status = !meta ? 'unconfigured' : this.probing.has(p.id) ? 'connecting' : meta.lastErrorCode ? 'failed' : !verified ? 'needs-verification' : !config.enabled ? 'disabled' : state?.status === 'connected' ? 'connected' : state?.status === 'connecting' ? 'connecting' : 'failed'
      return { ...p, connection: { status, enabled: !!config?.enabled, configuredFields: p.fields.filter(f => !!meta?.credentials[f.key]).map(f => f.key), verifiedAt: meta?.verifiedAt, verificationLevel: meta?.verifiedAt ? 'connection' : undefined, errorCode: meta?.lastErrorCode ?? state?.errorCode, toolCount: state?.toolCount ?? 0, mode: meta?.mode ?? 'read' } }
    }) }
  }
  private current(id: string, expectedRevision: number) {
    definition(id)
    const data = this.options.manager.presetSettings()
    if (!Number.isSafeInteger(expectedRevision) || data.revision !== expectedRevision) throw new RevisionConflict()
    return data.servers.find(s => s.id === `preset-${id}`)
  }
  async save(id: string, input: { expectedRevision: number; credentials?: Record<string,string>; mode?: 'read' | 'write' }) {
    const old = this.current(id, input.expectedRevision)
    if (Object.keys(input).some(k => !['expectedRevision','credentials','mode'].includes(k))) throw new PresetError('INVALID_SERVER')
    if (input.credentials !== undefined && (!input.credentials || typeof input.credentials !== 'object' || Array.isArray(input.credentials) || Object.values(input.credentials).some(v => typeof v !== 'string'))) throw new PresetError('INVALID_SERVER')
    const config = presetConfig(id, { ...old?.preset?.credentials, ...input.credentials }, input.mode ?? old?.preset?.mode ?? 'read')
    await this.options.manager.save({ ...config, expectedRevision: input.expectedRevision }, { managed: true })
    return this.snapshot()
  }
  async validate(id: string, expectedRevision: number) {
    const config = this.current(id, expectedRevision)
    if (!config?.preset) throw new PresetError('INVALID_SERVER')
    const candidate = presetConfig(id, config.preset.credentials, config.preset.mode)
    this.probing.add(id)
    let errorCode: PresetErrorCode | undefined
    try {
      const result = await (this.options.probe ?? (c => this.options.manager.probe(c)))(candidate)
      if (!Number.isSafeInteger(result.toolCount) || result.toolCount < 1) throw new PresetError('INVALID_SERVER')
    } catch (error) { errorCode = safeProbeError(error) } finally { this.probing.delete(id) }
    candidate.preset = { ...candidate.preset!, ...(errorCode ? { lastErrorCode: errorCode } : { validatedFingerprint: presetFingerprint(candidate), verifiedAt: new Date().toISOString() }) }
    await this.options.manager.save({ ...candidate, expectedRevision }, { managed: true })
    return this.snapshot()
  }
  async toggle(id: string, enabled: boolean, expectedRevision: number) {
    if (typeof enabled !== 'boolean') throw new PresetError('INVALID_SERVER')
    const config = this.current(id, expectedRevision)
    if (!config?.preset || enabled && !presetVerified(config)) throw new PresetError('INVALID_SERVER')
    await this.options.manager.save({ ...config, enabled, expectedRevision }, { managed: true })
    return this.snapshot()
  }
  enable(id: string, revision: number) { return this.toggle(id, true, revision) }
  disable(id: string, revision: number) { return this.toggle(id, false, revision) }
  configure(id: string, input: Parameters<McpPresets['save']>[1]) { return this.save(id, input) }
  verify(id: string, revision: number) { return this.validate(id, revision) }
  async remove(id: string, revision: number) { this.current(id, revision); await this.options.manager.remove(`preset-${id}`, revision, { managed: true }); return this.snapshot() }
  disconnect(id: string, revision: number) { return this.remove(id, revision) }
}
