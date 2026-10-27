import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { JarvisConfig } from './config.ts'

export type TuningValue = number | string | boolean
export type TuningType = 'range' | 'number' | 'boolean' | 'select' | 'text'
export type TuningApply = 'live' | 'next-turn' | 'restart' | 'ui'

export interface TuningOption {
  value: string
  label: string
}

export interface TuningParam {
  key: string
  label: string
  description: string
  type: TuningType
  default: TuningValue
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: TuningOption[]
  apply: TuningApply
  advanced?: boolean
}

export interface TuningGroup {
  id: string
  label: string
  description: string
  params: TuningParam[]
}

export interface TuningPreset {
  id: string
  label: string
  description: string
  values: Record<string, TuningValue>
}

export interface TuningUpdateResult {
  values: Record<string, TuningValue>
  changed: string[]
  restartRequired: boolean
}

function p(
  key: string,
  label: string,
  description: string,
  type: TuningType,
  def: TuningValue,
  apply: TuningApply,
  extra: Partial<TuningParam> = {},
): TuningParam {
  return { key, label, description, type, default: def, apply, ...extra }
}

export function buildTuningGroups(config: JarvisConfig): TuningGroup[] {
  return [
    {
      id: 'appearance',
      label: '界面与动效',
      description: '这些参数直接改变 Jarvis 的光球、粒子、背景和排版；拖动即可实时预览。',
      params: [
        p('ui.orbGlow', '光球辉光', '核心光球的发光半径与外溢强度。', 'range', 0.9, 'ui', { min: 0.2, max: 2, step: 0.05, unit: '×' }),
        p('ui.orbSpeed', '呼吸速度', '光球呼吸、扫描环和状态脉冲的速度。', 'range', 1, 'ui', { min: 0.2, max: 2, step: 0.05, unit: '×' }),
        p('ui.particles', '环境粒子', '全屏粒子场的粒子数量；0 为关闭。', 'range', 18, 'ui', { min: 0, max: 60, step: 1, unit: '个' }),
        p('ui.ambient', '背景氛围', '背景渐变光晕的强度。', 'range', 0.55, 'ui', { min: 0, max: 1, step: 0.05, unit: '×' }),
        p('ui.blur', '玻璃模糊', '面板和 Studio 的毛玻璃模糊半径。', 'range', 14, 'ui', { min: 0, max: 30, step: 1, unit: 'px' }),
        p('ui.accentHue', '强调色相', '青色强调色的色相角；168 是目前的默认青绿。', 'range', 168, 'ui', { min: 120, max: 230, step: 1, unit: '°' }),
        p('ui.textScale', '文字比例', '界面文字的整体缩放。', 'range', 1, 'ui', { min: 0.85, max: 1.15, step: 0.01, unit: '×' }),
        p('ui.motion', '动效等级', 'full 完整动效；subtle 减少位移；off 关闭非必要动画。', 'select', 'full', 'ui', {
          options: [{ value: 'full', label: '完整' }, { value: 'subtle', label: '克制' }, { value: 'off', label: '关闭' }],
        }),
        p('ui.density', '信息密度', 'comfortable 更宽松；compact 在同样屏幕显示更多。', 'select', 'comfortable', 'ui', {
          options: [{ value: 'comfortable', label: '舒适' }, { value: 'compact', label: '紧凑' }],
        }),
        p('ui.graphLabels', '记忆图标签', '在记忆星座图上常驻显示标签。', 'boolean', true, 'ui'),
      ],
    },
    {
      id: 'conversation',
      label: '对话与模型',
      description: '下一轮对话立即生效。温度越高越发散；上下文越多越慢、越占显存。',
      params: [
        p('conversation.temperature', '采样温度', 'LLM 回答的随机性。0 最稳定，1 以上更发散。', 'range', 0.45, 'next-turn', { min: 0, max: 2, step: 0.05 }),
        p('conversation.maxContextMessages', '携带历史消息', '每轮带给模型的历史消息条数。', 'range', 10, 'next-turn', { min: 0, max: 30, step: 1, unit: '条' }),
        p('conversation.maxHistory', '历史保留上限', '进程内保留的对话消息上限。', 'number', 16, 'next-turn', { min: 2, max: 40, step: 1, unit: '条' }),
        p('conversation.recallLimit', '记忆召回条数', '每轮注入上下文的记忆条数。', 'range', 6, 'next-turn', { min: 1, max: 12, step: 1, unit: '条' }),
        p('conversation.contextChars', '记忆上下文字符', '记忆块的最大字符数，防止挤占模型上下文。', 'range', 3000, 'next-turn', { min: 500, max: 8000, step: 100, unit: '字' }),
        p('conversation.speechChunkChars', '语音切句长度', '没有标点时，首句最多合成多少个字符。越小首句越快。', 'range', 20, 'next-turn', { min: 6, max: 80, step: 1, unit: '字' }),
        p('conversation.followupMs', '追问窗口', '回答结束后保持可追问的时间。', 'range', 8000, 'next-turn', { min: 1000, max: 30000, step: 500, unit: 'ms' }),
        p('conversation.streamTimeoutMs', '模型超时', '单轮模型流式请求的硬超时。', 'range', 120000, 'next-turn', { min: 10000, max: 300000, step: 5000, unit: 'ms', advanced: true }),
      ],
    },
    {
      id: 'memory',
      label: '记忆召回',
      description: '控制向量相似度、词法重叠和候选记忆是否进入上下文。',
      params: [
        p('memory.minVectorSimilarity', '向量相似度门槛', '低于此余弦相似度的纯向量候选会被丢弃。', 'range', 0.32, 'next-turn', { min: 0.1, max: 0.8, step: 0.01 }),
        p('memory.lexicalOverlap', '词法重叠门槛', '短查询没有向量命中时，字符重叠达到多少才保留。', 'range', 0.34, 'next-turn', { min: 0.1, max: 0.8, step: 0.01 }),
        p('memory.includeProposed', '允许候选记忆', '把尚未确认的 proposed 记忆也纳入召回。开发调试用。', 'boolean', false, 'next-turn', { advanced: true }),
        p('memory.markUsed', '更新使用计数', '召回后写入 last_used_at / use_count，影响记忆强度。', 'boolean', true, 'next-turn', { advanced: true }),
      ],
    },
    {
      id: 'audio',
      label: '声音与语音',
      description: '修改后会重启 Piper worker，下一次合成生效；不会影响正在播放的音频。',
      params: [
        p('voice.lengthScale', '时长缩放', 'Piper 的 length_scale：小于 1 更快，大于 1 更慢。', 'range', 1, 'live', { min: 0.5, max: 2, step: 0.05, unit: '×' }),
        p('voice.noiseScale', '音色噪声', 'Piper 的 noise_scale，影响韵律变化。', 'range', 0.667, 'live', { min: 0.3, max: 1.2, step: 0.01 }),
        p('voice.noiseW', '音素噪声', 'Piper 的 noise_w，影响音素时长变化。', 'range', 0.8, 'live', { min: 0.3, max: 1.2, step: 0.01 }),
        p('voice.maxChars', '单次合成上限', '单句送入 Piper 的最大字符数。', 'number', 4000, 'live', { min: 200, max: 4000, step: 100, unit: '字' }),
      ],
    },
    {
      id: 'runtime',
      label: '打扰与感知',
      description: '这些值直接写入运行时配置，提醒、静默和屏幕捕获会立即读取。',
      params: [
        p('proactive.dailySpeakBudget', '每日主动播报上限', '每天最多主动开口几次；0 表示不主动出声。', 'number', config.dailySpeakBudget, 'live', { min: 0, max: 20, step: 1, unit: '次' }),
        p('proactive.quietStart', '静默开始', 'HH:MM；到点后主动提醒只进面板。', 'text', config.quiet.start, 'live'),
        p('proactive.quietEnd', '静默结束', 'HH:MM。', 'text', config.quiet.end, 'live'),
        p('screens.timeoutMs', '屏幕门户超时', '等待系统截屏授权的毫秒数。', 'range', config.screenTimeoutMs, 'live', { min: 3000, max: 120000, step: 1000, unit: 'ms' }),
        p('screens.blocklist', '屏幕黑名单', '逗号分隔的标题关键词；命中时不读取屏幕。', 'text', config.screenBlocklist.join(','), 'live', { advanced: true }),
        p('attention.workDefaultScreen', '默认理解为屏幕', '“看看这个”没有明确指向时，是否默认按屏幕处理。', 'boolean', true, 'next-turn'),
      ],
    },
  ]
}

function allParams(groups: TuningGroup[]): TuningParam[] {
  return groups.flatMap(group => group.params)
}

export function defaultTuning(groups: TuningGroup[]): Record<string, TuningValue> {
  return Object.fromEntries(allParams(groups).map(param => [param.key, param.default]))
}

export const TUNING_PRESETS: TuningPreset[] = [
  {
    id: 'balanced',
    label: '平衡',
    description: '恢复默认的视觉、对话和记忆参数。',
    values: {},
  },
  {
    id: 'cinematic',
    label: '沉浸',
    description: '更强光晕、更多粒子、更慢呼吸；适合演示和大屏。',
    values: {
      'ui.orbGlow': 1.45, 'ui.orbSpeed': 0.72, 'ui.particles': 42, 'ui.ambient': 0.82,
      'ui.blur': 24, 'ui.motion': 'full', 'ui.density': 'comfortable',
    },
  },
  {
    id: 'focus',
    label: '专注',
    description: '压低视觉噪声、紧凑排版，适合长时间工作。',
    values: {
      'ui.orbGlow': 0.55, 'ui.orbSpeed': 1.2, 'ui.particles': 4, 'ui.ambient': 0.22,
      'ui.blur': 8, 'ui.motion': 'subtle', 'ui.density': 'compact',
    },
  },
  {
    id: 'lowpower',
    label: '省电',
    description: '关闭粒子、降低动效和背景，适合 4 核笔记本。',
    values: {
      'ui.orbGlow': 0.5, 'ui.orbSpeed': 1.4, 'ui.particles': 0, 'ui.ambient': 0.12,
      'ui.blur': 4, 'ui.motion': 'subtle',
    },
  },
]

function clamp(value: number, min?: number, max?: number): number {
  let out = value
  if (typeof min === 'number') out = Math.max(min, out)
  if (typeof max === 'number') out = Math.min(max, out)
  return out
}

export class TuningStore {
  private readonly groups: TuningGroup[]
  private readonly defaults: Record<string, TuningValue>
  private values: Record<string, TuningValue>
  private loaded = false

  constructor(
    private readonly file: string,
    private readonly config: JarvisConfig,
  ) {
    this.groups = buildTuningGroups(config)
    this.defaults = defaultTuning(this.groups)
    this.values = { ...this.defaults }
  }

  schema(): TuningGroup[] {
    return this.groups
  }

  current(): Record<string, TuningValue> {
    return { ...this.values }
  }

  get(key: string): TuningValue {
    return this.values[key] ?? this.defaults[key] ?? ''
  }

  number(key: string): number {
    const value = Number(this.get(key))
    return Number.isFinite(value) ? value : Number(this.defaults[key] ?? 0)
  }

  boolean(key: string): boolean {
    return Boolean(this.get(key))
  }

  text(key: string): string {
    return String(this.get(key) ?? '')
  }

  defaultsSnapshot(): Record<string, TuningValue> {
    return { ...this.defaults }
  }

  async load(): Promise<Record<string, TuningValue>> {
    if (this.loaded) return this.current()
    this.loaded = true
    try {
      await chmod(this.file, 0o600).catch(() => undefined)
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { values?: Record<string, unknown> }
      if (raw.values && typeof raw.values === 'object') {
        for (const param of allParams(this.groups)) {
          if (!Object.hasOwn(raw.values, param.key)) continue
          let value = this.coerce(param, raw.values[param.key])
          if (typeof value === 'string') {
            try { value = this.validateText(param, value) } catch { value = param.default }
          }
          this.values[param.key] = value
        }
      }
    } catch {
      // First run or an unreadable file: defaults are safe.
    }
    this.applyConfig()
    return this.current()
  }

  /**
   * Coerce an incoming value, rejecting input we cannot honour instead of
   * silently substituting the default. Silent fallbacks make the UI report
   * "saved" while nothing changed, which is exactly the bug class users hit
   * when a select value or a number is mistyped.
   *
   * Out-of-range numbers are still clamped: a slider that overshoots should
   * land on the limit, not error out.
   */
  private coerce(param: TuningParam, value: unknown): TuningValue {
    if (param.type === 'boolean') {
      if (value === true || value === 'true' || value === 1 || value === '1') return true
      if (value === false || value === 'false' || value === 0 || value === '0') return false
      throw new Error(`${param.label} 只能是 true/false`)
    }
    if (param.type === 'number' || param.type === 'range') {
      const numeric = typeof value === 'number' ? value : Number(String(value ?? '').trim())
      if (!Number.isFinite(numeric)) throw new Error(`${param.label} 必须是数字`)
      return clamp(numeric, param.min, param.max)
    }
    if (param.type === 'select') {
      const allowed = param.options?.map(option => option.value) ?? []
      const text = String(value ?? '')
      if (!allowed.includes(text)) {
        throw new Error(`${param.label} 只能是 ${allowed.join(' / ')} 之一`)
      }
      return text
    }
    const text = String(value ?? '').trim().slice(0, 500)
    if (!text) throw new Error(`${param.label} 不能为空`)
    return text
  }

  private validateText(param: TuningParam, value: string): string {
    if (param.key.startsWith('proactive.quiet')) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`${param.label} 必须是 HH:MM`)
    }
    return value
  }

  async update(input: Record<string, unknown>): Promise<TuningUpdateResult> {
    await this.load()
    const changed: string[] = []
    const next = { ...this.values }
    for (const [key, raw] of Object.entries(input)) {
      const param = allParams(this.groups).find(item => item.key === key)
      if (!param) throw new Error(`未知参数：${key}`)
      let value = this.coerce(param, raw)
      if (typeof value === 'string') value = this.validateText(param, value)
      if (next[key] !== value) {
        next[key] = value
        changed.push(key)
      }
    }
    this.values = next
    this.applyConfig()
    await this.save()
    return {
      values: this.current(),
      changed,
      restartRequired: changed.some(key => allParams(this.groups).find(param => param.key === key)?.apply === 'restart'),
    }
  }

  async reset(groupId?: string): Promise<TuningUpdateResult> {
    await this.load()
    const params = allParams(this.groups).filter(param => !groupId || this.groups.find(group => group.id === groupId)?.params.includes(param))
    if (groupId && params.length === 0) throw new Error('没有这个参数组')
    const changed: string[] = []
    for (const param of params) {
      if (this.values[param.key] !== this.defaults[param.key]) {
        this.values[param.key] = this.defaults[param.key]
        changed.push(param.key)
      }
    }
    this.applyConfig()
    await this.save()
    return { values: this.current(), changed, restartRequired: false }
  }

  async preset(id: string): Promise<{ values: Record<string, TuningValue>; preset: TuningPreset; changed: string[] }> {
    const preset = TUNING_PRESETS.find(item => item.id === id)
    if (!preset) throw new Error('没有这个预设')
    await this.load()
    const before = this.current()
    if (id === 'balanced') {
      this.values = { ...this.defaults }
    } else {
      for (const [key, value] of Object.entries(preset.values)) {
        const param = allParams(this.groups).find(item => item.key === key)
        if (param) this.values[key] = this.coerce(param, value)
      }
    }
    this.applyConfig()
    await this.save()
    const changed = Object.keys(this.values).filter(key => this.values[key] !== before[key])
    return { values: this.current(), preset, changed }
  }

  private applyConfig(): void {
    this.config.dailySpeakBudget = Math.round(this.number('proactive.dailySpeakBudget'))
    this.config.quiet.start = this.text('proactive.quietStart')
    this.config.quiet.end = this.text('proactive.quietEnd')
    this.config.screenTimeoutMs = Math.round(this.number('screens.timeoutMs'))
    this.config.screenBlocklist = this.text('screens.blocklist').split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), values: this.values }, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.file)
    await chmod(this.file, 0o600).catch(() => undefined)
  }

  snapshot(): {
    groups: TuningGroup[]
    values: Record<string, TuningValue>
    defaults: Record<string, TuningValue>
    presets: TuningPreset[]
  } {
    return { groups: this.groups, values: this.current(), defaults: this.defaultsSnapshot(), presets: TUNING_PRESETS }
  }
}
