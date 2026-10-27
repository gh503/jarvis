import { contextWindow } from './context-budget.ts'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { LlmProtocol } from './types.ts'
import { dirname, join } from 'node:path'
import { builtinScenarios, normalizeCustomScenario, normalizeScenario, SCENARIO_CHAT, type ScenarioConfig } from './scenarios.ts'

export type ProviderKind = 'ollama' | 'openai'

export interface ModelProfile {
  id: string
  label: string
  kind: ProviderKind
  protocol: LlmProtocol
  baseUrl: string
  model: string
  apiKey: string
  visionModel: string
  embedModel: string
  keepAlive: string
  supportsTools?: boolean
  contextWindow?: number
}

export interface ModelSettings {
  active: string
  profiles: ModelProfile[]
  /** Global failover chain: ordered profile ids, most preferred first. */
  priority: string[]
  /** Work scenarios (chat/coding/writing/reasoning), each with its own chain. */
  scenarios: ScenarioConfig[]
  scenarioAuto: boolean
  defaultScenario: string
  /** Persisted provider cooldowns from failover (profile id -> state). */
  cooldowns: Record<string, { until: number; kind: string; reason: string }>
}

export interface PublicModelProfile extends Omit<ModelProfile, 'apiKey'> {
  hasKey: boolean
}

export interface PublicModelSettings {
  active: string
  profiles: PublicModelProfile[]
  priority: string[]
  scenarios: ScenarioConfig[]
  scenarioAuto: boolean
  defaultScenario: string
  cooldowns: Record<string, { until: number; kind: string; reason: string }>
}

export interface ModelDefaults {
  local: { baseUrl: string; model: string; visionModel: string; embedModel: string; keepAlive: string }
}

function profile(value: Partial<ModelProfile>, fallback?: ModelProfile): ModelProfile {
  if (value.supportsTools !== undefined && typeof value.supportsTools !== 'boolean') throw new Error('supportsTools must be a boolean')
  const id = String(value.id ?? fallback?.id ?? 'local')
  const kind = value.kind === 'openai' || value.kind === 'ollama' ? value.kind : fallback?.kind ?? 'ollama'
  const protocol: LlmProtocol = value.protocol === 'responses' || value.protocol === 'anthropic' || value.protocol === 'chat-completions'
    ? value.protocol
    : fallback?.protocol ?? 'chat-completions'
  return {
    id,
    label: String(value.label ?? fallback?.label ?? (id === 'remote' ? '远端模型' : '本地 Ollama')).slice(0, 64),
    kind,
    protocol,
    baseUrl: String(value.baseUrl ?? fallback?.baseUrl ?? '').trim(),
    model: String(value.model ?? fallback?.model ?? '').trim(),
    apiKey: String(value.apiKey ?? fallback?.apiKey ?? ''),
    visionModel: String(value.visionModel ?? fallback?.visionModel ?? '').trim(),
    embedModel: String(value.embedModel ?? fallback?.embedModel ?? '').trim(),
    supportsTools: (value.supportsTools ?? fallback?.supportsTools) === true,
    contextWindow: contextWindow(value.contextWindow ?? fallback?.contextWindow),
    keepAlive: String(value.keepAlive ?? fallback?.keepAlive ?? '24h').trim(),
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
}

export function validateProfile(value: ModelProfile): ModelProfile {
  if (value.supportsTools !== undefined && typeof value.supportsTools !== 'boolean') throw new Error('supportsTools must be a boolean')
  contextWindow(value.contextWindow)
  if (!/^[a-z0-9-]{1,32}$/.test(value.id)) throw new Error('模型配置 id 不合法')
  if (!value.model || value.model.length > 200) throw new Error('模型名称不能为空')
  let url: URL
  try {
    url = new URL(value.baseUrl)
  } catch {
    throw new Error('Base URL 不是合法链接')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Base URL 只支持 http/https')
  if (url.username || url.password) throw new Error('Base URL 不能包含用户名或密码')
  if (url.search || url.hash) throw new Error('Base URL 不要带查询参数或锚点，避免密钥出现在地址里')
  if (url.hostname === '169.254.169.254' || url.hostname.toLowerCase() === 'metadata.google.internal') {
    throw new Error('不允许把模型地址指向云主机元数据服务')
  }
  if (value.kind === 'openai' && url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('远端模型必须使用 HTTPS；只有本机 localhost 可以使用 HTTP')
  }
  if (value.apiKey.includes('\n') || value.apiKey.includes('\r') || value.apiKey.length > 4096) {
    throw new Error('API Key 不合法')
  }
  return { ...value, baseUrl: value.baseUrl.replace(/\/+$/, '') }
}

export class ModelSettingsStore {
  private loaded: ModelSettings | null = null

  constructor(
    private readonly file: string,
    private readonly defaults: ModelDefaults,
  ) {}

  private defaultSettings(): ModelSettings {
    const local: ModelProfile = {
      id: 'local',
      label: '本地 Ollama',
      kind: 'ollama',
      protocol: 'chat-completions',
      baseUrl: this.defaults.local.baseUrl,
      model: this.defaults.local.model,
      apiKey: '',
      visionModel: this.defaults.local.visionModel,
      embedModel: this.defaults.local.embedModel,
      keepAlive: this.defaults.local.keepAlive,
    }
    const remote: ModelProfile = {
      id: 'remote',
      label: '远端模型',
      kind: 'openai',
      protocol: 'chat-completions',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: '',
      visionModel: '',
      embedModel: '',
      keepAlive: '',
    }
    return {
      active: 'local',
      profiles: [local, remote],
      priority: ['remote', 'local'],
      scenarios: builtinScenarios(),
      scenarioAuto: true,
      defaultScenario: SCENARIO_CHAT,
      cooldowns: {},
    }
  }

  /**
   * Erase every saved provider (including remote API keys) and fall back to
   * the built-in local profile. Used by the "erase all data" action.
   */
  async resetToDefaults(): Promise<ModelSettings> {
    await rm(this.file, { force: true })
    const defaults = this.defaultSettings()
    // Local first: a wipe must not leave the assistant pointed at a remote
    // provider that no longer has a key.
    defaults.priority = ['local', ...defaults.priority.filter(id => id !== 'local')]
    this.loaded = defaults
    return this.loaded
  }

  async load(): Promise<ModelSettings> {
    if (this.loaded) return this.loaded
    let saved: Partial<ModelSettings> = {}
    try {
      await chmod(this.file, 0o600).catch(() => undefined)
      saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<ModelSettings>
    } catch {
      // First run, or an unreadable file: start from safe defaults.
    }
    const base = this.defaultSettings()
    const incoming = Array.isArray(saved.profiles) ? saved.profiles : []
    const profiles = base.profiles.map(fallback => {
      const found = incoming.find(item => item && item.id === fallback.id)
      return profile(found ?? {}, fallback)
    })
    const active = profiles.some(item => item.id === saved.active) ? String(saved.active) : 'local'
    // Extra remote profiles saved by a newer version are kept, not dropped.
    for (const item of incoming) {
      if (item && typeof item.id === 'string' && /^[a-z0-9-]{1,32}$/.test(item.id) && !profiles.some(kept => kept.id === item.id)) {
        profiles.push(profile(item as Partial<ModelProfile>, base.profiles[1]))
      }
    }
    const known = new Set(profiles.map(item => item.id))
    const priorityRaw = Array.isArray(saved.priority) ? saved.priority.map(String).filter(id => known.has(id)) : []
    // Migration default: the previously active provider first, other remotes
    // next, local last as the always-available fallback.
    const fallbackOrder = [active, ...profiles.map(item => item.id).filter(id => id !== active && id !== 'local'), ...(known.has('local') ? ['local'] : [])]
    const priority = [...priorityRaw, ...fallbackOrder.filter(id => !priorityRaw.includes(id))]
    const builtins = builtinScenarios()
    const savedScenarios = Array.isArray(saved.scenarios) ? saved.scenarios : []
    // Old catalogs fold into their successor instead of lingering as customs.
    const legacyScenarioIds: Record<string, string> = { reasoning: 'research' }
    const scenarios = builtins.map(builtin => {
      const direct = savedScenarios.find(item => item && item.id === builtin.id)
      if (direct) return normalizeScenario(direct, builtin)
      const legacy = savedScenarios.find(item => item && item.id && legacyScenarioIds[String(item.id)] === builtin.id)
      if (!legacy) return normalizeScenario(undefined, builtin)
      // Folding a renamed scenario keeps the new catalog's richer defaults and
      // only carries over the user's extras (patterns union, not replace).
      const legacyPatterns = Array.isArray((legacy as { patterns?: unknown }).patterns) ? (legacy as { patterns: unknown[] }).patterns : []
      return normalizeScenario({ ...(legacy as object), patterns: [...legacyPatterns, ...builtin.patterns] }, builtin)
    })
    for (const item of savedScenarios) {
      const id = item && typeof item === 'object' ? String((item as { id?: unknown }).id ?? '') : ''
      if (!id || id in legacyScenarioIds || scenarios.some(existing => existing.id === id)) continue
      try {
        scenarios.push(normalizeCustomScenario({ ...(item as object), id }))
      } catch {
        // A malformed custom scenario is dropped, not fatal.
      }
    }
    const defaultScenario = scenarios.some(item => item.id === saved.defaultScenario) ? String(saved.defaultScenario) : SCENARIO_CHAT
    const cooldowns: ModelSettings['cooldowns'] = {}
    if (saved.cooldowns && typeof saved.cooldowns === 'object') {
      for (const [id, value] of Object.entries(saved.cooldowns)) {
        const entry = value as { until?: unknown; kind?: unknown; reason?: unknown }
        if (known.has(id) && typeof entry.until === 'number' && Number.isFinite(entry.until)) {
          cooldowns[id] = { until: entry.until, kind: String(entry.kind ?? 'other'), reason: String(entry.reason ?? '').slice(0, 200) }
        }
      }
    }
    this.loaded = {
      active,
      profiles,
      priority,
      scenarios,
      scenarioAuto: saved.scenarioAuto === undefined ? true : Boolean(saved.scenarioAuto),
      defaultScenario,
      cooldowns,
    }
    return this.loaded
  }

  async save(settings: ModelSettings): Promise<void> {
    for (const item of settings.profiles) validateProfile(item)
    if (!settings.profiles.some(item => item.id === settings.active)) throw new Error('当前模型配置不存在')
    const ids = new Set(settings.profiles.map(item => item.id))
    if (ids.size !== settings.profiles.length) throw new Error('模型配置 id 重复')
    for (const id of settings.priority) if (!ids.has(id)) throw new Error(`优先级列表里有不存在的配置：${id}`)
    const scenarioIds = new Set(settings.scenarios.map(item => item.id))
    if (scenarioIds.size !== settings.scenarios.length) throw new Error('场景 id 重复')
    for (const scenario of settings.scenarios) {
      if (!/^[a-z0-9-]{1,32}$/.test(scenario.id)) throw new Error(`场景 id 不合法：${scenario.id}`)
      for (const id of scenario.profileIds) if (!ids.has(id)) throw new Error(`场景 ${scenario.label} 引用了不存在的配置：${id}`)
    }
    if (!settings.scenarios.some(item => item.id === settings.defaultScenario)) throw new Error('默认场景不存在')
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.file)
    await chmod(this.file, 0o600).catch(() => undefined)
    this.loaded = settings
  }

  async upsert(input: Partial<ModelProfile> & { id: string }, activate = false): Promise<ModelSettings> {
    const settings = await this.load()
    const existing = settings.profiles.find(item => item.id === input.id)
    if (!existing) throw new Error('没有这个模型配置；新增供应商请用 addProfile')
    // An empty key from the UI means "keep the saved secret", not "erase it".
    const merged = profile(
      { ...input, apiKey: input.apiKey?.trim() ? input.apiKey.trim() : existing.apiKey },
      existing,
    )
    validateProfile(merged)
    const profiles = settings.profiles.map(item => (item.id === merged.id ? merged : item))
    const next: ModelSettings = { ...settings, active: activate ? merged.id : settings.active, profiles }
    await this.save(next)
    return next
  }

  async activate(id: string): Promise<{ settings: ModelSettings; profile: ModelProfile }> {
    const settings = await this.load()
    const profileItem = settings.profiles.find(item => item.id === id)
    if (!profileItem) throw new Error('没有这个模型配置')
    if (profileItem.kind === 'openai' && !profileItem.apiKey) {
      let loopback = false
      try { loopback = isLoopbackHost(new URL(profileItem.baseUrl).hostname) } catch { /* validateProfile reports it */ }
      if (!loopback) throw new Error('远端配置还没有 API Key')
    }
    // Activating a provider means "use this one now": promote it to the head of
    // the failover chain as well. Without this the chain keeps its old order,
    // so a UI that says "local is active" can still serve from a remote
    // provider that sits earlier in the priority list.
    const priority = [id, ...settings.priority.filter(item => item !== id)]
    const next = { ...settings, active: id, priority }
    await this.save(next)
    return { settings: next, profile: profileItem }
  }

  publicView(settings: ModelSettings): PublicModelSettings {
    return {
      active: settings.active,
      profiles: settings.profiles.map(item => ({
        id: item.id,
        label: item.label,
        kind: item.kind,
        protocol: item.protocol,
        baseUrl: item.baseUrl,
        model: item.model,
        visionModel: item.visionModel,
        embedModel: item.embedModel,
        keepAlive: item.keepAlive,
        contextWindow: contextWindow(item.contextWindow),
        supportsTools: item.supportsTools === true,
        hasKey: Boolean(item.apiKey),
      })),
      priority: [...settings.priority],
      scenarios: settings.scenarios.map(item => ({ ...item, profileIds: [...item.profileIds], patterns: [...item.patterns] })),
      scenarioAuto: settings.scenarioAuto,
      defaultScenario: settings.defaultScenario,
      cooldowns: Object.fromEntries(Object.entries(settings.cooldowns).map(([id, value]) => [id, { ...value }])),
    }
  }

  /** Add a new remote provider profile. */
  async addProfile(input: Partial<ModelProfile>): Promise<ModelSettings> {
    const settings = await this.load()
    const id = String(input.id ?? '').trim().toLowerCase()
    if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new Error('供应商 id 需为 1-32 位小写字母/数字/连字符')
    if (settings.profiles.some(item => item.id === id)) throw new Error('这个 id 已存在')
    const created = profile({ ...input, contextWindow: input.contextWindow ?? 4096, supportsTools: input.supportsTools ?? false, id, kind: 'openai' }, settings.profiles.find(item => item.id === 'remote') ?? settings.profiles[0])
    created.kind = 'openai'
    validateProfile(created)
    const next: ModelSettings = {
      ...settings,
      profiles: [...settings.profiles, created],
      priority: [...settings.priority.filter(item => item !== 'local'), id, 'local'].filter(item => item === id || settings.profiles.some(p => p.id === item) || item === 'local'),
    }
    await this.save(next)
    return next
  }

  /** Remove a non-local profile that is neither active nor referenced. */
  async removeProfile(id: string): Promise<ModelSettings> {
    const settings = await this.load()
    if (id === 'local') throw new Error('本地配置不能删除')
    if (settings.active === id) throw new Error('不能删除当前使用的配置，先切换到其他供应商')
    if (!settings.profiles.some(item => item.id === id)) throw new Error('没有这个模型配置')
    const next: ModelSettings = {
      ...settings,
      profiles: settings.profiles.filter(item => item.id !== id),
      priority: settings.priority.filter(item => item !== id),
      scenarios: settings.scenarios.map(item => ({ ...item, profileIds: item.profileIds.filter(entry => entry !== id) })),
      cooldowns: Object.fromEntries(Object.entries(settings.cooldowns).filter(([key]) => key !== id)),
    }
    await this.save(next)
    return next
  }

  async setPriority(priority: string[]): Promise<ModelSettings> {
    const settings = await this.load()
    const known = new Set(settings.profiles.map(item => item.id))
    for (const id of priority) if (!known.has(String(id))) throw new Error(`优先级列表里有不存在的配置：${id}`)
    const clean = priority.map(String)
    for (const id of known) if (!clean.includes(id)) clean.push(id)
    const next = { ...settings, priority: clean }
    await this.save(next)
    return next
  }

  async setScenarios(input: { scenarios?: unknown[]; scenarioAuto?: boolean; defaultScenario?: string }): Promise<ModelSettings> {
    const settings = await this.load()
    const incoming = Array.isArray(input.scenarios) ? input.scenarios : []
    const scenarios = settings.scenarios.map(current => {
      if (current.custom) return null // customs are rebuilt from the payload below
      const found = incoming.find(item => item && (item as { id?: unknown }).id === current.id)
      return normalizeScenario(found, current)
    }).filter((item): item is ScenarioConfig => item !== null)
    for (const item of incoming) {
      const id = item && typeof item === 'object' ? String((item as { id?: unknown }).id ?? '') : ''
      if (!id || scenarios.some(existing => existing.id === id)) continue
      scenarios.push(normalizeCustomScenario({ ...(item as object), id }))
    }
    const defaultScenario = scenarios.some(item => item.id === input.defaultScenario) ? String(input.defaultScenario) : settings.defaultScenario
    const next: ModelSettings = {
      ...settings,
      scenarios,
      scenarioAuto: input.scenarioAuto === undefined ? settings.scenarioAuto : Boolean(input.scenarioAuto),
      defaultScenario,
    }
    await this.save(next)
    return next
  }

  async setCooldown(id: string, entry: { until: number; kind: string; reason: string } | null): Promise<void> {
    const settings = await this.load()
    const cooldowns = { ...settings.cooldowns }
    if (entry) cooldowns[id] = entry
    else delete cooldowns[id]
    this.loaded = { ...settings, cooldowns }
    await this.save(this.loaded)
  }
}
