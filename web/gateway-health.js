export const GATEWAY_HEALTH_TIMEOUT_MS = 5_000

export async function fetchGatewayHealth(fetchValue = fetch, options = {}) {
  const timeoutMs = options.timeoutMs ?? GATEWAY_HEALTH_TIMEOUT_MS
  const setTimeoutValue = options.setTimeout ?? setTimeout
  const clearTimeoutValue = options.clearTimeout ?? clearTimeout
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('gateway health timeout is invalid')
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeoutValue(() => {
      controller.abort()
      reject(new Error('gateway health request timed out'))
    }, timeoutMs)
  })
  const request = (async () => {
    const response = await fetchValue('../v1/health', {
      cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal,
    })
    const health = await response.json()
    if (!response.ok || health?.service !== 'jarvis-gateway' || health.status !== 'ok'
      || (health.scope !== 'loopback-only' && health.scope !== 'private-network')) {
      throw new Error('invalid gateway response')
    }
    return health
  })()
  try {
    return await Promise.race([request, deadline])
  } finally {
    clearTimeoutValue(timer)
  }
}
