/**
 * Provider failure classification and cooldown policy for automatic failover.
 *
 * Only failures that mean "this provider cannot serve us right now" trigger a
 * switch: quota/billing exhaustion, auth rejection, rate limits, network and
 * 5xx. A 4xx that is our fault (bad request) must never fail over silently.
 */

export type FailureKind = 'quota' | 'rate-limit' | 'auth' | 'network' | 'server' | 'client' | 'other'

export interface CooldownEntry {
  until: number
  kind: string
  reason: string
}

export function classifyModelError(error: unknown): FailureKind {
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()

  if (/(insufficient|balance|余额|额度|quota|billing|payment|credit|free_tier|exceed.*(quota|limit)|达到.*上限)/.test(message)) return 'quota'
  if (status === 402) return 'quota'
  if (status === 429 || /rate.?limit|too many requests|请求过于频繁/.test(message)) return 'rate-limit'
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid api key|api key.*invalid|认证|鉴权/.test(message)) return 'auth'
  if (status !== undefined && status >= 500) return 'server'
  if (/(fetch failed|econn|enotfound|etimedout|eai_again|socket hang up|network|超时|timeout|aborted|无法连接|连接被拒绝)/.test(message)) return 'network'
  if (status !== undefined && status >= 400 && status < 500) return 'client'
  return 'other'
}

/** How long a failed provider stays out of the chain. */
export function cooldownMs(kind: FailureKind): number {
  switch (kind) {
    // Quota is usually a daily/monthly allowance; retrying in minutes is
    // pointless, but a short-ish cooldown lets a refreshed free tier recover.
    case 'quota': return 30 * 60_000
    case 'rate-limit': return 60_000
    // Auth failures need a human; keep the provider parked for a day.
    case 'auth': return 24 * 3600_000
    case 'network': return 2 * 60_000
    case 'server': return 5 * 60_000
    default: return 60_000
  }
}

export function shouldFailover(kind: FailureKind): boolean {
  return kind === 'quota' || kind === 'rate-limit' || kind === 'auth' || kind === 'network' || kind === 'server'
}

export function cooldownActive(entry: CooldownEntry | undefined, now = Date.now()): boolean {
  return Boolean(entry && entry.until > now)
}
