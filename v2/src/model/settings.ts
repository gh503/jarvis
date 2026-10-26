import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type ProviderKind = 'ollama' | 'openai'

export interface ModelProfile {
  id: string
  label: string
  kind: ProviderKind
  baseUrl: string
  model: string
  apiKey: string
  visionModel: string
  embedModel: string
  keepAlive: string
}

export interface ModelSettings {
  active: string
  profiles: ModelProfile[]
}

export interface PublicModelProfile extends Omit<ModelProfile, 'apiKey'> {
  hasKey: boolean
}

export interface PublicModelSettings {
  active: string
  profiles: PublicModelProfile[]
}

export interface ModelDefaults {
  local: { baseUrl: string; model: string; visionModel: string; embedModel: string; keepAlive: string }
}

function profile(value: Partial<ModelProfile>, fallback?: ModelProfile): ModelProfile {
  const id = String(value.id ?? fallback?.id ?? 'local')
  const kind = value.kind === 'openai' || value.kind === 'ollama' ? value.kind : fallback?.kind ?? 'ollama'
  return {
    id,
    label: String(value.label ?? fallback?.label ?? (id === 'remote' ? '远端模型' : '本地 Ollama')).slice(0, 64),
    kind,
    baseUrl: String(value.baseUrl ?? fallback?.baseUrl ?? '').trim(),
    model: String(value.model ?? fallback?.model ?? '').trim(),
    apiKey: String(value.apiKey ?? fallback?.apiKey ?? ''),
    visionModel: String(value.visionModel ?? fallback?.visionModel ?? '').trim(),
    embedModel: String(value.embedModel ?? fallback?.embedModel ?? '').trim(),
    keepAlive: String(value.keepAlive ?? fallback?.keepAlive ?? '24h').trim(),
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
}

export function validateProfile(value: ModelProfile): ModelProfile {
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
      baseUrl: this.defaults.local.baseUrl,
      model: this.defaults.local.model,
      apiKey: '',
      visionModel: this.defaults.local.visionModel,
      embedModel: this.defaults.local.embedModel,
      keepAlive: this.defaults.local.keepAlive,
    }
    const remote: ModelProfile = {
      id: 'remote',
      label: '远端 OpenAI 兼容',
      kind: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: '',
      visionModel: '',
      embedModel: '',
      keepAlive: '',
    }
    return { active: 'local', profiles: [local, remote] }
  }

  async load(): Promise<ModelSettings> {
    if (this.loaded) return this.loaded
    let saved: Partial<ModelSettings> = {}
    try {
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
    this.loaded = { active, profiles }
    return this.loaded
  }

  async save(settings: ModelSettings): Promise<void> {
    for (const item of settings.profiles) validateProfile(item)
    if (!settings.profiles.some(item => item.id === settings.active)) throw new Error('当前模型配置不存在')
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
    if (!existing) throw new Error('只能编辑 local / remote 两个内置配置')
    // An empty key from the UI means "keep the saved secret", not "erase it".
    const merged = profile(
      { ...input, apiKey: input.apiKey?.trim() ? input.apiKey.trim() : existing.apiKey },
      existing,
    )
    validateProfile(merged)
    const profiles = settings.profiles.map(item => (item.id === merged.id ? merged : item))
    const next = { active: activate ? merged.id : settings.active, profiles }
    await this.save(next)
    return next
  }

  async activate(id: string): Promise<{ settings: ModelSettings; profile: ModelProfile }> {
    const settings = await this.load()
    const profileItem = settings.profiles.find(item => item.id === id)
    if (!profileItem) throw new Error('没有这个模型配置')
    if (profileItem.kind === 'openai' && !profileItem.apiKey) throw new Error('远端配置还没有 API Key')
    const next = { ...settings, active: id }
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
        baseUrl: item.baseUrl,
        model: item.model,
        visionModel: item.visionModel,
        embedModel: item.embedModel,
        keepAlive: item.keepAlive,
        hasKey: Boolean(item.apiKey),
      })),
    }
  }
}
