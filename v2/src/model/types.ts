export type ChatRole = 'system' | 'user' | 'assistant'

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
  model: string
  baseUrl: string
  hasKey: boolean
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
