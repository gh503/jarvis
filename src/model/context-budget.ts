import type { ChatMessage, ChatOptions } from './types.ts'

export const DEFAULT_CONTEXT_WINDOW = 4096

export function contextWindow(value?: number): number {
  if (value === undefined) return DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(value) || value < 2048 || value > 2_000_000) {
    throw new Error('contextWindow must be an integer between 2048 and 2000000')
  }
  return value
}

export function contextLimitsFor(window: number | undefined, options: ChatOptions = {}, model?: string): { contextWindow: number; maxOutputTokens: number } {
  let capacity = contextWindow(window)
  // A different model has no known capacity; the configured capacity is a ceiling.
  if (options.model && options.model !== model) capacity = Math.min(capacity, DEFAULT_CONTEXT_WINDOW)
  if (options.numCtx !== undefined) {
    if (!Number.isInteger(options.numCtx) || options.numCtx < 1) throw new Error('numCtx must be a positive integer')
    capacity = Math.min(capacity, options.numCtx)
  }
  if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens < 1)) {
    throw new Error('maxTokens must be a positive integer')
  }
  return { contextWindow: capacity, maxOutputTokens: Math.max(1, Math.min(options.maxTokens ?? Math.floor(capacity / 4), Math.floor(capacity / 2))) }
}

/** Deliberately conservative, tokenizer-independent UTF-8 estimate. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 2)
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 8
  for (const message of messages) {
    if (message.images?.length) throw new Error('Context token estimation supports text messages only')
    total += 12 + estimateTextTokens(message.role) + estimateTextTokens(message.content)
  }
  return total
}

/** Recognize context exhaustion, never generic HTTP 400 or quota exhaustion. */
export function isContextOverflow(error: unknown): boolean {
  if (!error) return false
  if (typeof error === 'object') {
    const value = error as { code?: unknown; type?: unknown; message?: unknown; error?: unknown }
    if ([value.code, value.type].some(code => typeof code === 'string' && /^(context_window_exceeded|context_length_exceeded|maximum_context_length_exceeded|prompt_too_long|input_too_long)$/i.test(code))) return true
    if (value.error && value.error !== error && isContextOverflow(value.error)) return true
    if (typeof value.message === 'string') return isContextOverflow(value.message)
    return false
  }
  if (typeof error !== 'string') return false
  try { const parsed: unknown = JSON.parse(error); if (typeof parsed === 'object' && isContextOverflow(parsed)) return true } catch { /* plain provider message */ }
  return /context[_ ](?:window|length)[_ ]exceeded|maximum context length|context (?:window|length).*(?:exceed|too (?:long|large)|limit)|(?:exceed|beyond).*(?:context window|context length)|(?:prompt|input) (?:is )?too long|input length.*exceeds.*context|too many tokens.*(?:context|maximum)/i.test(error)
}

export function requireCompleteOutput(options: ChatOptions, reason?: string): void {
  if (options.requireComplete && (reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens')) {
    throw Object.assign(new Error('Summary truncated: model output token limit reached'), { code: 'MODEL_OUTPUT_TRUNCATED' })
  }
}
