/**
 * Work scenarios: a scenario picks a provider chain, an optional model
 * override, a temperature and an extra system-prompt fragment. Scenarios can
 * be pinned manually or auto-detected from the user's text.
 */

export interface ScenarioConfig {
  id: string
  label: string
  /** Ordered provider chain; empty means "use the global priority". */
  profileIds: string[]
  /** Optional model override (must exist on the chosen provider). */
  model: string
  temperature: number | null
  /** Extra system-prompt guidance injected for this scenario. */
  systemExtra: string
  /** Extra auto-detect keywords/regex fragments on top of the built-ins. */
  patterns: string[]
  enabled: boolean
}

export const SCENARIO_CHAT = 'chat'

export function builtinScenarios(): ScenarioConfig[] {
  return [
    {
      id: SCENARIO_CHAT,
      label: '日常对话',
      profileIds: [],
      model: '',
      temperature: null,
      systemExtra: '',
      patterns: [],
      enabled: true,
    },
    {
      id: 'coding',
      label: '编程开发',
      profileIds: [],
      model: '',
      temperature: 0.2,
      systemExtra: '当前是编程场景：给出可运行的代码（用围栏代码块并标注语言），先讲关键思路再给代码，指出边界条件与潜在坑；不确定的 API 不要编造。',
      patterns: ['代码', '编程', '函数', '报错', 'bug', 'debug', '编译', '重构', '正则', 'SQL', '接口', '脚本'],
      enabled: true,
    },
    {
      id: 'writing',
      label: '写作翻译',
      profileIds: [],
      model: '',
      temperature: 0.7,
      systemExtra: '当前是写作/翻译场景：注重语气、结构与措辞；翻译时保持原意并符合目标语言习惯；先给成品，再简要说明取舍。',
      patterns: ['写一', '润色', '翻译', '改写', '邮件', '文案', '总结成', '起草'],
      enabled: true,
    },
    {
      id: 'reasoning',
      label: '深度分析',
      profileIds: [],
      model: '',
      temperature: 0.3,
      systemExtra: '当前是分析推理场景：先拆解问题、列出假设，逐步推理后再下结论；给出置信度和替代解释。',
      patterns: ['分析', '推理', '论证', '评估', '对比', '权衡', '为什么', '因果'],
      enabled: true,
    },
  ]
}

const CODE_SIGNAL = /```|\b(function|class|const|import|export|async|await|def |return|SELECT|INSERT INTO)\b|\.(?:ts|tsx|js|py|go|rs|java|cpp?|sh|sql)\b|\b(?:Traceback|TypeError|SyntaxError|NullPointerException)\b/i

/** Auto-detect the scenario from user text. Deterministic and conservative. */
export function detectScenario(text: string, scenarios: ScenarioConfig[]): string {
  const enabled = new Map(scenarios.filter(item => item.enabled).map(item => [item.id, item]))
  const coding = enabled.get('coding')
  if (coding && (CODE_SIGNAL.test(text) || matchesCustom(text, coding.patterns))) return 'coding'
  for (const id of ['writing', 'reasoning']) {
    const scenario = enabled.get(id)
    if (scenario && matchesCustom(text, scenario.patterns)) return id
  }
  return SCENARIO_CHAT
}

function matchesCustom(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase()
  return patterns.some(pattern => {
    const needle = pattern.trim().toLowerCase()
    return needle.length > 0 && lower.includes(needle)
  })
}

export function normalizeScenario(value: unknown, fallback: ScenarioConfig): ScenarioConfig {
  const raw = (value ?? {}) as Partial<ScenarioConfig>
  return {
    id: fallback.id,
    label: String(raw.label ?? fallback.label).slice(0, 32) || fallback.label,
    profileIds: Array.isArray(raw.profileIds) ? raw.profileIds.map(String).filter(Boolean).slice(0, 16) : [...fallback.profileIds],
    model: String(raw.model ?? fallback.model ?? '').trim().slice(0, 200),
    temperature: typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)
      ? Math.min(2, Math.max(0, raw.temperature))
      : fallback.temperature,
    systemExtra: String(raw.systemExtra ?? fallback.systemExtra ?? '').slice(0, 2000),
    patterns: Array.isArray(raw.patterns) ? raw.patterns.map(String).map(item => item.slice(0, 64)).filter(Boolean).slice(0, 32) : [...fallback.patterns],
    enabled: raw.enabled === undefined ? fallback.enabled : Boolean(raw.enabled),
  }
}
