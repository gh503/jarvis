import type { ProfileStore } from '../profile.ts'
import type { Logger } from '../logger.ts'
import type { ModelClient } from '../model/ollama.ts'
import type { MemoryStore } from './store.ts'
import type { MemoryImportance, MemoryKind, MemorySensitivity } from './types.ts'

interface Candidate {
  kind?: string
  content?: string
  gist?: string
  importance?: Partial<MemoryImportance>
  sensitivity?: string
}

interface ExtractPayload {
  memories?: Candidate[]
}

const KINDS = new Set<MemoryKind>(['semantic', 'episodic', 'procedural', 'prospective'])
const SENSITIVITIES = new Set<MemorySensitivity>(['standard', 'sensitive'])

export function shouldExtract(userText: string, assistantText: string): boolean {
  const trimmed = userText.trim()
  void assistantText
  if (trimmed.length < 8) return false
  // Explicit remembering is already handled synchronously and must not create
  // a second, inferred duplicate.
  if (/^(\/remember|记住|帮我记住|忘掉|忘记|删除记忆|\/forget|\/memory|查看记忆|列出记忆)/i.test(trimmed)) return false
  return /(答应|承诺|决定|以后|下次|截止|deadline|喜欢|不喜欢|习惯|我住在|我搬到|对.*过敏|重要|我的[^，。]{0,12}(是|叫|在))/.test(trimmed)
}

const GENERIC_PREFIX = /^(用户|助手|Jarvis|他|她|这个|那个|任务|事情|内容|信息)/i
const GENERIC_FRAGMENT = /(任务的截止日期|准备工作的安排|一次性任务|聊天内容)/

/**
 * Inferred candidates are only useful when they are specific and grounded in
 * what the user actually said. A small local model otherwise invents generic
 * “用户需要完成任务” rows that pollute recall.
 */
export function isUsefulCandidate(content: string, userText: string): boolean {
  const clean = content.trim()
  if (clean.length < 6) return false
  if (GENERIC_PREFIX.test(clean) || GENERIC_FRAGMENT.test(clean)) return false
  const chars = [...userText].filter(char => !/\s|[，。！？,.!?：:；;、]/.test(char))
  if (chars.length === 0) return false
  const overlap = chars.filter(char => clean.includes(char)).length
  return overlap / chars.length >= 0.4
}

export function parseExtraction(text: string): Candidate[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as ExtractPayload
    return Array.isArray(parsed.memories) ? parsed.memories.slice(0, 3) : []
  } catch {
    return []
  }
}

export class MemoryExtractor {
  constructor(
    private readonly model: ModelClient,
    private readonly store: MemoryStore,
    private readonly logger?: Logger,
    private readonly profile?: ProfileStore,
  ) {}

  async maybeExtract(userText: string, assistantText: string, sourceRef: string): Promise<number> {
    if (this.profile && !this.profile.snapshot().settings.learningEnabled) return 0
    if (!shouldExtract(userText, assistantText)) return 0
    const prompt = [
      '你是一个记忆抽取器。只从“用户说的话”里抽取值得长期记住的事实、偏好、决定、承诺或截止日期。',
      '不要从助手的话里抽取事实；不要猜测；不要把寒暄、临时任务、一次性查询写进记忆。',
      '最多 3 条。每条必须是一个完整、可独立理解的陈述。',
      '输出严格 JSON，不要 Markdown：',
      '{"memories":[{"kind":"semantic|episodic|procedural|prospective","content":"...","gist":"...","importance":{"goal":0.5,"novelty":0.5,"social":0.5,"repetition":0.5,"explicit":0.5,"deadline":0.5},"sensitivity":"standard|sensitive"}]}',
      '',
      `用户说：${userText.slice(0, 4000)}`,
    ].join('\n')

    try {
      const mutationEpoch = this.store.mutationEpoch?.()
      const extractionClient = this.profile ? (this.model.localClient?.() ?? this.model) : this.model
      if (this.profile && extractionClient.isLocal !== true) return 0
      const output = await extractionClient.chatOnce(
        [{ role: 'user', content: prompt }],
        { temperature: 0.1, timeoutMs: 45_000 },
      )
      // Off/on toggles and corrections invalidate the entire in-flight inference.
      if (mutationEpoch !== this.store.mutationEpoch?.()) return 0
      if (this.profile && !this.profile.snapshot().settings.learningEnabled) return 0
      const candidates = parseExtraction(output)
      const known = new Set(
        this.store
          .list({ includeSensitive: true, includeInactive: true, limit: 200 })
          .map(item => item.content.replace(/\s+/g, '').replace(/[。！？.!?]/g, '').toLowerCase()),
      )
      let added = 0
      for (const candidate of candidates) {
        const content = String(candidate.content ?? '').trim()
        if (content.length < 4 || content.length > 2000) continue
        if (!isUsefulCandidate(content, userText)) continue
        const normalized = content.replace(/\s+/g, '').replace(/[。！？.!?]/g, '').toLowerCase()
        if (known.has(normalized)) continue
        known.add(normalized)
        const kind = KINDS.has(candidate.kind as MemoryKind) ? (candidate.kind as MemoryKind) : 'semantic'
        const sensitivity = SENSITIVITIES.has(candidate.sensitivity as MemorySensitivity)
          ? (candidate.sensitivity as MemorySensitivity)
          : 'standard'
        const item = await this.store.add({
          kind,
          content,
          gist: candidate.gist,
          sourceKind: 'inferred',
          sourceRef,
          trust: 'low',
          confidence: 0.55,
          importance: candidate.importance,
          // Protect raw self assertions before add() can request embeddings.
          sensitivity: this.profile ? 'sensitive' : sensitivity,
          status: 'proposed',
        })
        // Require literal first-person evidence, not a model's attribution of
        // quoted, third-party, screen or hypothetical text to the user.
        const evidence = userText.trim().replace(/\s+/g, '').replace(/[。！？.!?]/g, '').toLowerCase()
        if (/^我(?:喜欢|爱好|住在|搬到|的|从事|是|希望|习惯)/u.test(userText.trim())
          && !/[“”"「」]|(?:假如|假设|如果|例如|比如|屏幕|截图|OCR)/iu.test(userText)
          && evidence.includes(normalized)) {
          // Reference this exact proposal; never create a second memory.
          this.profile?.observeMemory(item)
        }
        added += 1
      }
      if (added > 0) this.logger?.info('background memory extraction added proposals', { added })
      return added
    } catch (error) {
      this.logger?.warn('background memory extraction failed', { error: String(error) })
      return 0
    }
  }
}