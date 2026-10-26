export type ChatRole = 'system' | 'user' | 'assistant'
export type LlmProtocol = 'chat-completions' | 'responses' | 'anthropic'
export type ModelProtocol = LlmProtocol | 'ollama'

export interface ChatMessage {
  role: ChatRole
  content: string
  images?: string[]
}

export interface ChatOptions {
  model?: string
  temperature?: number
  numCtx?: number
  maxTokens?: number
  signal?: AbortSignal
  timeoutMs?: number
  keepAlive?: string
  /** Failover chain for this request (scenario override); profile ids in order. */
  profileIds?: string[]
}

export interface ModelInfo {
  name: string
  size?: number
  modified_at?: string
}

export interface ModelHealth {
  ok: boolean
  models: ModelInfo[]
  error?: string
}

export interface ModelStatus {
  id: string
  label: string
  kind: 'ollama' | 'openai'
  protocol: ModelProtocol
  model: string
  baseUrl: string
  hasKey: boolean
  /** Providers currently parked by failover (id -> cooldown state). */
  cooldowns?: Record<string, { until: number; kind: string; reason: string }>
}

export interface ModelClient {
  readonly model: string
  readonly visionModel: string
  readonly embedModel: string
  health(timeoutMs?: number): Promise<ModelHealth>
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string>
  chatOnce(messages: ChatMessage[], options?: ChatOptions): Promise<string>
  vision(image: Buffer, prompt: string, options?: ChatOptions): Promise<string>
  embed(text: string): Promise<Float32Array | null>
  warmup?(): Promise<{ chatMs: number; embedMs: number }>
  status?(): ModelStatus
}
