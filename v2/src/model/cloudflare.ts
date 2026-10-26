import type { ModelHealth, ModelInfo } from './types.ts'

interface CloudflareModel {
  id?: string
  name?: string
  task?: { id?: string; name?: string }
}

/** True for https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1. */
export function isCloudflareBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.hostname.toLowerCase() === 'api.cloudflare.com' && /\/accounts\/[^/]+\/ai\/v1(?:\/|$)/.test(url.pathname)
  } catch {
    return false
  }
}

export function cloudflareModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  const match = url.pathname.match(/^(.*\/accounts\/[^/]+)\/ai\/v1(?:\/|$)/)
  if (!match) throw new Error('Cloudflare Base URL 需形如 https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1')
  return `${url.origin}${match[1]}/ai/models/search?per_page=100`
}

/**
 * Workers AI does not expose an OpenAI `/models` endpoint. Its account model
 * search is the equivalent discovery API, and is what makes the model selector
 * work without a hand-maintained list.
 */
export async function listCloudflareModels(baseUrl: string, apiKey: string, timeoutMs = 8000): Promise<ModelHealth> {
  try {
    const response = await fetch(cloudflareModelsUrl(baseUrl), {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const raw = await response.text()
    if (response.status === 401 || response.status === 403) {
      return { ok: false, models: [], error: `HTTP ${response.status}: 检查 Cloudflare API Token 的 Workers AI 权限` }
    }
    if (!response.ok) return { ok: false, models: [], error: `Cloudflare 模型列表失败：HTTP ${response.status} ${raw.slice(0, 200)}` }
    let payload: { result?: CloudflareModel[] | { models?: CloudflareModel[] }; errors?: Array<{ message?: string }> } = {}
    try {
      payload = JSON.parse(raw) as typeof payload
    } catch {
      return { ok: false, models: [], error: 'Cloudflare 模型列表返回了非 JSON 内容' }
    }
    const result = payload.result
    const entries = Array.isArray(result) ? result : Array.isArray(result?.models) ? result.models : []
    const models: ModelInfo[] = entries
      .filter(item => {
        const task = String(item.task?.name ?? item.task?.id ?? '').toLowerCase()
        if (task) return !/embedding/i.test(task) && /text|chat/.test(task)
        const name = String(item.name ?? item.id ?? '').toLowerCase()
        return Boolean(name) && !/(embedding|whisper|tts|melotts|aura|flux|stable-diffusion|image)/.test(name)
      })
      .map(item => {
        const candidate = [item.name, item.id].map(value => String(value ?? '')).find(value => value.startsWith('@cf/'))
        return { name: candidate ?? '' }
      })
      .filter(item => item.name.startsWith('@cf/'))
    if (!models.length) {
      const detail = payload.errors?.map(item => item.message).filter(Boolean).join('；')
      return { ok: false, models: [], error: detail || 'Cloudflare 没有返回可用的文本模型；检查 API Token 权限' }
    }
    return { ok: true, models }
  } catch (error) {
    return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) }
  }
}
