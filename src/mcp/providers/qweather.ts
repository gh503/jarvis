import { pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

// Local MCP adapter for the official HTTP API, not an official QWeather MCP server.
// https://dev.qweather.com/docs/api/weather/weather-current/
// https://dev.qweather.com/docs/api/weather/weather-daily-forecast/
// https://dev.qweather.com/docs/api/geoapi/city-lookup/
const MAX_BODY = 1024 * 1024
const MAX_JSON = 100 * 1024
const MAX_OUTPUT = 16_000
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+qweatherapi\.com$/i
const coordinates = {
  latitude: { type: 'number', minimum: -90, maximum: 90 },
  longitude: { type: 'number', minimum: -180, maximum: 180 },
}
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
const tools: Tool[] = [
  { name: 'weather_city_lookup', description: 'Find cities by name. Preserve returned lat/lon and resolve ambiguous names before requesting weather.', annotations,
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['query'], additionalProperties: false } },
  { name: 'weather_current', description: 'Current QWeather weather for latitude and longitude. Values and units are preserved; humidity is a fraction. Display metadata.attributions with data.', annotations,
    inputSchema: { type: 'object', properties: coordinates, required: ['latitude', 'longitude'], additionalProperties: false } },
  { name: 'weather_daily', description: 'Daily QWeather forecast (1–10 days, default 3). Preserve units, forecast times, and metadata.attributions.', annotations,
    inputSchema: { type: 'object', properties: { ...coordinates, days: { type: 'integer', minimum: 1, maximum: 10, default: 3 } }, required: ['latitude', 'longitude'], additionalProperties: false } },
]
type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
class SafeError extends Error {}
// Bound awaiting even when an injected transport ignores AbortSignal. Both
// fulfillment and rejection remain observed after cancellation.
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(new Error('Request aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
function providerError(code: unknown): SafeError {
  const value = String(code)
  if (['401', '403'].includes(value)) return new SafeError('QWeather authentication or permission failed.')
  if (['402', '429'].includes(value)) return new SafeError('QWeather quota or rate limit exceeded.')
  return new SafeError('QWeather provider request failed.')
}
function result(value: ObjectValue, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }
}
function boundedResult(data: ObjectValue, context: ObjectValue, kind: string): CallToolResult {
  const envelope = { source: 'QWeather', fetchedAt: new Date().toISOString(), ...context, data }
  if (Buffer.byteLength(JSON.stringify(envelope)) <= MAX_OUTPUT) return result(envelope)
  // Never slice serialized JSON or split a forecast/city record. Retain attribution
  // and explicitly identify every omission. Unexpected fields remain intact normally.
  const listKey = kind === 'weather_daily' ? 'days' : kind === 'weather_city_lookup' ? 'location' : undefined
  const selected: ObjectValue = listKey
    ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== listKey))
    : Object.fromEntries(Object.entries(data).filter(([key]) => ['metadata', 'temperature', 'condition', 'humidity'].includes(key)))
  const omittedFields = listKey ? [] : Object.keys(data).filter(key => !(key in selected))
  const records = listKey && Array.isArray(data[listKey]) ? data[listKey] as unknown[] : []
  const kept: unknown[] = []
  if (listKey) selected[listKey] = kept
  const truncated = { ...envelope, data: selected, truncation: { reason: 'output_limit', omittedFields, omittedRecords: records.length } }
  if (Buffer.byteLength(JSON.stringify(truncated)) > MAX_OUTPUT) throw new SafeError('QWeather response essentials exceed output limit; no data returned.')
  for (const record of records) {
    kept.push(record)
    truncated.truncation.omittedRecords--
    if (Buffer.byteLength(JSON.stringify(truncated)) > MAX_OUTPUT) {
      kept.pop(); truncated.truncation.omittedRecords++; break
    }
  }
  return result(truncated)
}

export function createQWeatherServer(options: { apiKey: string; apiHost: string; fetch?: typeof fetch }): Server {
  if (typeof options.apiKey !== 'string' || options.apiKey.length < 1 || options.apiKey.length > 8192 || /[\r\n]/.test(options.apiKey)) {
    throw new SafeError('Invalid QWeather API key configuration.')
  }
  if (typeof options.apiHost !== 'string' || options.apiHost.length > 253 || !HOST.test(options.apiHost)) {
    throw new SafeError('Invalid QWeather API host configuration.')
  }
  const fetcher = options.fetch ?? globalThis.fetch
  const server = new Server({ name: 'jarvis-qweather-adapter', version: '1.0.0' }, { capabilities: { tools: {} },
    instructions: 'Local adapter for the official QWeather API. Initialize/listTools do not verify credentials. An explicit weather_city_lookup query can test authentication. Always display provider attribution; never assume missing fields or convert humidity fractions silently.' })
  server.onerror = () => {} // SDK errors must never echo credentials or request URLs.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const controller = new AbortController()
    let timedOut = false
    const cancel = () => controller.abort()
    extra.signal.addEventListener('abort', cancel, { once: true })
    if (extra.signal.aborted) cancel()
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 10_000)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const name = request.params.name
      const args = request.params.arguments ?? {}
      let path: string
      let context: ObjectValue
      // Runtime allowlist/validation is independent of advisory MCP annotations.
      if (name === 'weather_city_lookup') {
        if (Object.keys(args).some(key => key !== 'query') || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200 || /[\x00-\x1f\x7f]/.test(args.query)) throw new SafeError('Invalid city query.')
        path = `/geo/v2/city/lookup?${new URLSearchParams({ location: args.query })}`
        context = { query: args.query }
      } else if (name === 'weather_current' || name === 'weather_daily') {
        const { latitude, longitude } = args
        const allowed = name === 'weather_daily' ? ['latitude', 'longitude', 'days'] : ['latitude', 'longitude']
        if (Object.keys(args).some(key => !allowed.includes(key)) || typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new SafeError('Invalid weather coordinates.')
        const days = args.days === undefined ? 3 : args.days
        if (name === 'weather_daily' && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 10)) throw new SafeError('Invalid forecast days (expected integer 1–10).')
        // API supports at most two decimals. Report both original and sent coordinates.
        const sent = { latitude: Number(latitude.toFixed(2)), longitude: Number(longitude.toFixed(2)) }
        path = `/weather/v1/${name === 'weather_current' ? 'current' : 'daily'}/${sent.latitude}/${sent.longitude}${name === 'weather_daily' ? `?days=${days}` : ''}`
        context = { requestedCoordinates: { latitude, longitude }, resolvedCoordinates: sent, ...(name === 'weather_daily' ? { requestedDays: days } : {}) }
      } else throw new SafeError('Unknown weather tool.')
      controller.signal.throwIfAborted()
      const pendingResponse = fetcher(`https://${options.apiHost}${path}`, { method: 'GET', headers: { 'X-QW-Api-Key': options.apiKey, Accept: 'application/json' }, redirect: 'error', signal: controller.signal })
      // Dispose a response that arrives after the caller has already timed out.
      void pendingResponse.then(response => {
        if (controller.signal.aborted) void response.body?.cancel().catch(() => {})
      }, () => {}).catch(() => {})
      const response = await abortable(pendingResponse, controller.signal)
      if (!response.ok || response.redirected) { controller.abort(); void response.body?.cancel().catch(() => {}); throw providerError(response.status) }
      if (Number(response.headers.get('content-length')) > MAX_BODY) { controller.abort(); void response.body?.cancel().catch(() => {}); throw new SafeError('QWeather response exceeds body limit.') }
      if (!response.body) throw new SafeError('QWeather returned an invalid response.')
      reader = response.body.getReader()
      // A fetch stub or stream need not implement AbortSignal itself.
      const abortRead = () => { void reader?.cancel().catch(() => {}) }
      controller.signal.addEventListener('abort', abortRead, { once: true })
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          controller.signal.throwIfAborted()
          const chunk = await abortable(reader.read(), controller.signal)
          controller.signal.throwIfAborted()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > MAX_BODY) { controller.abort(); throw new SafeError('QWeather response exceeds body limit.') }
          chunks.push(chunk.value)
        }
      } finally { controller.signal.removeEventListener('abort', abortRead) }
      if (bytes > MAX_JSON) throw new SafeError('QWeather response exceeds JSON input limit; no data returned.')
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!object(data)) throw new SafeError('QWeather returned an invalid response.')
      if ('error' in data || ('code' in data && String(data.code) !== '200')) throw providerError(data.code)
      if (name === 'weather_city_lookup') {
        if (!Array.isArray(data.location) || !object(data.refer)) throw new SafeError('QWeather returned an invalid city response.')
      } else {
        if (!object(data.metadata) || !Array.isArray(data.metadata.attributions) || (name === 'weather_daily' ? !Array.isArray(data.days) : !object(data.temperature) || !object(data.condition))) throw new SafeError('QWeather returned an invalid weather response.')
      }
      return boundedResult(data, context, name)
    } catch (error) {
      const message = error instanceof SafeError ? error.message : timedOut ? 'QWeather request timed out.' : extra.signal.aborted ? 'QWeather request cancelled.' : 'QWeather request failed.'
      return result({ source: 'QWeather', error: message }, true)
    } finally {
      clearTimeout(timer)
      extra.signal.removeEventListener('abort', cancel)
      void reader?.cancel().catch(() => {})
      controller.abort()
    }
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = createQWeatherServer({ apiKey: process.env.QWEATHER_API_KEY ?? '', apiHost: process.env.QWEATHER_API_HOST ?? '' })
    await server.connect(new StdioServerTransport())
  } catch {
    process.stderr.write('QWeather adapter failed to start. Check API key and account API host configuration.\n')
    process.exitCode = 1
  }
}
