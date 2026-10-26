/**
 * Work scenarios, modeled after how mature products scope assistant behavior:
 * ChatGPT (auto routing, deep research, canvas writing), Claude Code (agentic
 * coding: locate → plan → runnable code → tests → error-driven iteration),
 * and office copilots (meeting minutes, email, weekly reports).
 *
 * A scenario picks a provider chain, an optional model override, a
 * temperature, an optional maxTokens cap and a system-prompt fragment.
 * Scenarios can be pinned manually or auto-detected from the user's text.
 * Users can also define custom scenarios (like ChatGPT GPTs).
 */

export interface ScenarioConfig {
  id: string
  label: string
  /** Ordered provider chain; empty means "use the global priority". */
  profileIds: string[]
  /** Optional model override (must exist on the chosen provider). */
  model: string
  temperature: number | null
  /** Optional output cap for this scenario. */
  maxTokens: number | null
  /** Extra system-prompt guidance injected for this scenario. */
  systemExtra: string
  /** Auto-detect keywords on top of the built-in signals. */
  patterns: string[]
  enabled: boolean
  /** User-defined scenarios can be deleted; built-ins cannot. */
  custom: boolean
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
      maxTokens: null,
      systemExtra: '',
      patterns: [],
      enabled: true,
      custom: false,
    },
    {
      id: 'coding',
      label: '编程开发',
      profileIds: [],
      model: '',
      temperature: 0.2,
      maxTokens: null,
      systemExtra: [
        '当前是编程场景，按 Claude Code 的方式工作：',
        '1. 先用一两句确认问题和关键思路，不要急着堆代码；',
        '2. 代码放在带语言标注的围栏代码块里，保证可以直接运行；',
        '3. 指出边界条件、错误处理和潜在坑；给出最小验证方法（命令或测试）；',
        '4. 调试时先分析报错堆栈的根因，再给修复；不编造不存在的 API；',
        '5. 改动大时先给文件级计划，再逐块实现。',
      ].join('\n'),
      patterns: ['代码', '编程', '函数', '报错', 'bug', 'debug', '编译', '重构', '正则', 'sql', '接口', '脚本', '部署', '报错', '堆栈'],
      enabled: true,
      custom: false,
    },
    {
      id: 'translate',
      label: '翻译',
      profileIds: [],
      model: '',
      temperature: 0.3,
      maxTokens: null,
      systemExtra: '当前是翻译场景：只输出译文，不加解释；保持原意、术语一致、符合目标语言母语习惯；专有名词保留原文并在首次出现时括号注明；语气与原文一致（正式/口语/商务）。',
      patterns: ['翻译', '译成', '译成', '怎么说', '英文', '日文', '韩文', '法文', '德文'],
      enabled: true,
      custom: false,
    },
    {
      id: 'writing',
      label: '写作润色',
      profileIds: [],
      model: '',
      temperature: 0.7,
      maxTokens: null,
      systemExtra: '当前是写作场景（Canvas 式）：先直接给出一版完整成稿，再用「可继续优化：」列出 2-3 个可选修改方向；保持用户要求的体裁、语气和篇幅；润色时只改该改的，保留作者风格。',
      patterns: ['写一', '润色', '改写', '文案', '起草', '作文', '公众号', '小红书', '标题', 'slogan'],
      enabled: true,
      custom: false,
    },
    {
      id: 'email',
      label: '邮件文书',
      profileIds: [],
      model: '',
      temperature: 0.4,
      maxTokens: null,
      systemExtra: '当前是邮件/商务文书场景：给出完整可用的成稿，包含称呼、正文分段、结尾敬语；语气默认专业克制；如需用户补充信息（收件人、事由），先问一句再给草稿。',
      patterns: ['邮件', '回信', 'email', '邀请函', '通知函', '商务函', '辞职信', '请假'],
      enabled: true,
      custom: false,
    },
    {
      id: 'meeting',
      label: '会议纪要',
      profileIds: [],
      model: '',
      temperature: 0.3,
      maxTokens: null,
      systemExtra: '当前是会议纪要场景：把口语化内容整理成结构化纪要，固定四节：「议题」「结论」「行动项（负责人/截止时间，缺失标 待定）」「遗留问题」；人名地名保持原文，不要编造没说的内容。',
      patterns: ['纪要', '会议记录', '会议总结', '例会', '评审会', '行动项', '待办事项'],
      enabled: true,
      custom: false,
    },
    {
      id: 'report',
      label: '日报周报',
      profileIds: [],
      model: '',
      temperature: 0.4,
      maxTokens: null,
      systemExtra: '当前是工作汇报场景：按「本期完成 / 进行中 / 风险与阻塞 / 下期计划」输出；每条一句话、可验证、避免空话；根据用户给的碎片信息归并同类项。',
      patterns: ['日报', '周报', '月报', '述职', '汇报', '工作总结', '进展'],
      enabled: true,
      custom: false,
    },
    {
      id: 'research',
      label: '深度研究',
      profileIds: [],
      model: '',
      temperature: 0.3,
      maxTokens: null,
      systemExtra: '当前是深度研究/分析场景（Deep Research 式）：先把问题拆成 2-4 个子问题，逐一分析，最后给结论；明确标注哪些是事实、哪些是推断、哪些你不确定；给出替代解释和反方观点。',
      patterns: ['分析', '调研', '研究', '评估', '对比', '权衡', '竞品', '行业', '为什么', '因果', '综述'],
      enabled: true,
      custom: false,
    },
    {
      id: 'brainstorm',
      label: '头脑风暴',
      profileIds: [],
      model: '',
      temperature: 0.9,
      maxTokens: null,
      systemExtra: '当前是头脑风暴场景：先发散给 8-10 个不相同的点子（覆盖常规、跨界、反向），再收敛推荐 2-3 个并说明理由；鼓励意外组合，不要自我审查掉大胆想法。',
      patterns: ['头脑风暴', '点子', '创意', '起名', '取名', 'brainstorm', '想法'],
      enabled: true,
      custom: false,
    },
    {
      id: 'study',
      label: '学习讲解',
      profileIds: [],
      model: '',
      temperature: 0.5,
      maxTokens: null,
      systemExtra: '当前是学习讲解场景：用费曼式讲法——先一句话概括，再用生活类比解释，然后给正式定义和一个最小例子；结尾出一个自测小题确认理解；术语首次出现时给中文解释。',
      patterns: ['讲解', '解释', '教我', '什么是', '原理', '入门', '教程', '怎么理解', '科普'],
      enabled: true,
      custom: false,
    },
  ]
}

const CODE_SIGNAL = /```|\b(function|class|const|import|export|async|await|def |return|SELECT|INSERT INTO)\b|\.(?:ts|tsx|js|py|go|rs|java|cpp?|sh|sql)\b|\b(?:Traceback|TypeError|SyntaxError|NullPointerException)\b/i

/**
 * Auto-detect the scenario from user text. Deterministic and conservative:
 * technical signals first, then office/document genres, then open-ended ones;
 * anything unclear stays in chat.
 */
export function detectScenario(text: string, scenarios: ScenarioConfig[]): string {
  const enabled = new Map(scenarios.filter(item => item.enabled).map(item => [item.id, item]))
  const coding = enabled.get('coding')
  if (coding && (CODE_SIGNAL.test(text) || matchesCustom(text, coding.patterns))) return 'coding'
  for (const id of ['meeting', 'email', 'report', 'translate', 'writing', 'research', 'brainstorm', 'study']) {
    const scenario = enabled.get(id)
    if (scenario && matchesCustom(text, scenario.patterns)) return id
  }
  // Custom scenarios participate in detection through their own patterns.
  for (const scenario of scenarios) {
    if (scenario.custom && scenario.enabled && matchesCustom(text, scenario.patterns)) return scenario.id
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

export function isBuiltinScenario(id: string): boolean {
  return builtinScenarios().some(item => item.id === id)
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
    maxTokens: typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens) && raw.maxTokens > 0
      ? Math.min(128_000, Math.round(raw.maxTokens))
      : fallback.maxTokens,
    systemExtra: String(raw.systemExtra ?? fallback.systemExtra ?? '').slice(0, 4000),
    patterns: Array.isArray(raw.patterns) ? raw.patterns.map(String).map(item => item.slice(0, 64)).filter(Boolean).slice(0, 32) : [...fallback.patterns],
    enabled: raw.enabled === undefined ? fallback.enabled : Boolean(raw.enabled),
    custom: fallback.custom,
  }
}

/** Normalize a user-defined scenario (id from input, label required). */
export function normalizeCustomScenario(value: unknown): ScenarioConfig {
  const raw = (value ?? {}) as Partial<ScenarioConfig>
  const id = String(raw.id ?? '').trim().toLowerCase()
  if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new Error('场景 id 需为 1-32 位小写字母/数字/连字符')
  if (isBuiltinScenario(id)) throw new Error('内置场景不能直接覆盖')
  const label = String(raw.label ?? '').trim().slice(0, 32)
  if (!label) throw new Error('自定义场景需要名称')
  return normalizeScenario({ ...raw, id }, {
    id,
    label,
    profileIds: [],
    model: '',
    temperature: null,
    maxTokens: null,
    systemExtra: '',
    patterns: [],
    enabled: true,
    custom: true,
  })
}
