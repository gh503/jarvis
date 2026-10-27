import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createQWeatherServer } from '../src/mcp/providers/qweather.ts'

const apiHost = 'h2a9cf3mhs.xy.qweatherapi.com'
const apiKey = 'synthetic-test-key'
const current = { metadata: { tag: 'test', attributions: ['https://developer.qweather.com/attribution.html'] }, temperature: { value: 31.71, unit: '°C' }, condition: { text: '少云', code: '102' }, humidity: 0.69, wind: { speed: { value: 4.74, unit: 'm/s' } } }
const city = { code: '200', location: [{ name: '北京', lat: '39.91755', lon: '116.41876' }], refer: { sources: ['QWeather'], license: ['QWeather Developers License'] } }
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
function parsed(value: unknown): any {
  const result = value as CallToolResult
  const content = result.content[0]
  assert.equal(content.type, 'text')
  return JSON.parse((content as { text: string }).text)
}
async function fixture(fetcher: typeof fetch) {
  const server = createQWeatherServer({ apiKey, apiHost, fetch: fetcher })
  const client = new Client({ name: 'qweather-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, close: async () => { await client.close(); await server.close() } }
}

test('account host and header credentials are validated without echoing input', () => {
  for (const host of ['https://a.qweatherapi.com', 'a.qweatherapi.com/path', 'a.qweatherapi.com:443', 'a.qweatherapi.com.evil.test', 'a.qweatherapi.com@evil.test', 'qweatherapi.com', '-a.qweatherapi.com', 'a-.qweatherapi.com', 'a..qweatherapi.com', 'a_b.qweatherapi.com', 'a.qweatherapi.com\n', `${'a'.repeat(64)}.qweatherapi.com`, '127.0.0.1']) {
    assert.throws(() => createQWeatherServer({ apiKey, apiHost: host }), { message: 'Invalid QWeather API host configuration.' })
  }
  for (const key of ['', 'x\ny', 'x\ry', 'x'.repeat(8193)]) {
    assert.throws(() => createQWeatherServer({ apiKey: key, apiHost }), { message: 'Invalid QWeather API key configuration.' })
  }
  for (const host of [apiHost, 'abc-123.qweatherapi.com', 'A.B.qweatherapi.com']) assert.ok(createQWeatherServer({ apiKey, apiHost: host }))
})

test('SDK initialize/listTools are local; calls use exact official paths and preserve records', async () => {
  const calls: { url: URL; init?: RequestInit }[] = []
  const daily = { metadata: current.metadata, days: [{ forecastStartTime: '2026-10-27T00:00Z', temperatureMax: { value: 29.94, unit: '°C' }, daytime: { condition: current.condition, humidity: 0.52 }, nighttime: { humidity: 0.56 } }] }
  const f = await fixture(async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init })
    return json(url.pathname.includes('/geo/') ? city : url.pathname.includes('/daily/') ? daily : current)
  })
  try {
    const list = await f.client.listTools()
    assert.equal(calls.length, 0)
    assert.deepEqual(list.tools.map(tool => tool.name), ['weather_city_lookup', 'weather_current', 'weather_daily'])
    assert.ok(list.tools.every(tool => tool.annotations?.readOnlyHint))
    const lookup = parsed(await f.client.callTool({ name: 'weather_city_lookup', arguments: { query: '北京 & test' } }))
    assert.deepEqual(lookup.data, city)
    assert.equal(calls[0].url.searchParams.get('location'), '北京 & test')
    assert.equal(calls[0].url.pathname, '/geo/v2/city/lookup')
    const weather = parsed(await f.client.callTool({ name: 'weather_current', arguments: { latitude: 39.92, longitude: 116.41 } }))
    assert.equal(calls[1].url.pathname, '/weather/v1/current/39.92/116.41')
    assert.deepEqual(weather.data, current)
    assert.deepEqual(weather.requestedCoordinates, { latitude: 39.92, longitude: 116.41 })
    assert.equal(weather.source, 'QWeather')
    assert.ok(Number.isFinite(Date.parse(weather.fetchedAt)))
    assert.deepEqual(parsed(await f.client.callTool({ name: 'weather_daily', arguments: { latitude: -30.1234, longitude: -120.5678, days: 7 } })).data, daily)
    assert.equal(calls[2].url.pathname, '/weather/v1/daily/-30.12/-120.57')
    assert.equal(calls[2].url.searchParams.get('days'), '7')
    await f.client.callTool({ name: 'weather_daily', arguments: { latitude: 0, longitude: 180 } })
    assert.equal(calls[3].url.searchParams.get('days'), '3')
    for (const { url, init } of calls) {
      assert.equal(url.protocol, 'https:'); assert.equal(url.host, apiHost)
      assert.equal(url.searchParams.has('key'), false)
      assert.equal(new Headers(init?.headers).get('X-QW-Api-Key'), apiKey)
      assert.equal(init?.redirect, 'error'); assert.equal(init?.method, 'GET')
      assert.ok(init?.signal)
    }
  } finally { await f.close() }
})

test('runtime rejects unknown tools, invalid coordinates/days and additional arguments before fetch', async () => {
  let calls = 0
  const f = await fixture(async () => { calls++; return json(current) })
  try {
    for (const [name, args] of [
      ['weather_delete', {}], ['weather_current', { latitude: 91, longitude: 0 }],
      ['weather_current', { latitude: 0, longitude: -181 }], ['weather_current', { latitude: '30', longitude: 120 }],
      ['weather_current', { latitude: 0, longitude: 0, url: 'https://evil.test' }],
      ['weather_daily', { latitude: 0, longitude: 0, days: 1.5 }], ['weather_daily', { latitude: 0, longitude: 0, days: 0 }],
      ['weather_daily', { latitude: 0, longitude: 0, days: 11 }], ['weather_daily', { latitude: 0, longitude: 0, days: null }], ['weather_city_lookup', { query: '' }],
      ['weather_city_lookup', { query: 'x'.repeat(201) }], ['weather_city_lookup', { query: 'x', host: 'evil.test' }],
    ] as [string, Record<string, unknown>][]) assert.equal((await f.client.callTool({ name, arguments: args })).isError, true)
    assert.equal(calls, 0)
  } finally { await f.close() }
})

test('HTTP/provider failures and fetch exceptions never expose bodies, URLs or secrets', async () => {
  for (const response of [
    () => new Response(`secret ${apiKey}`, { status: 401 }),
    () => new Response(apiKey, { status: 429 }),
    () => new Response(apiKey, { status: 302, headers: { location: 'https://evil.test' } }),
    () => json({ code: '401', message: apiKey }),
    () => json({ error: { detail: apiKey } }),
    () => { throw new Error(`https://${apiHost}/?key=${apiKey}`) },
    () => new Response(apiKey),
  ]) {
    const f = await fixture(async () => response())
    try {
      const value = await f.client.callTool({ name: 'weather_current', arguments: { latitude: 0, longitude: 0 } })
      assert.equal(value.isError, true)
      assert.ok(!JSON.stringify(value).includes(apiKey)); assert.ok(!JSON.stringify(value).includes(apiHost))
      assert.equal(typeof parsed(value).error, 'string')
    } finally { await f.close() }
  }
})

test('output truncation is valid bounded JSON and retains attribution and whole records', async () => {
  const days = Array.from({ length: 10 }, (_, index) => ({ forecastStartTime: `day${index}`, extra: '天'.repeat(1400), temperatureMax: { value: index, unit: '°C' } }))
  const f = await fixture(async () => json({ metadata: current.metadata, days }))
  try {
    const value = await f.client.callTool({ name: 'weather_daily', arguments: { latitude: 0, longitude: 0, days: 10 } })
    const content = (value as CallToolResult).content[0] as { text: string }
    assert.ok(Buffer.byteLength(content.text) <= 16_000)
    const data = parsed(value)
    assert.deepEqual(data.data.metadata, current.metadata)
    assert.ok(data.data.days.length > 0 && data.data.days.length < 10)
    assert.deepEqual(data.data.days, days.slice(0, data.data.days.length))
    assert.equal(data.truncation.omittedRecords, 10 - data.data.days.length)
  } finally { await f.close() }
})

test('streaming body and JSON input limits abort and cancel instead of buffering indefinitely', async () => {
  for (const size of [110_000, 1_100_000]) {
    let cancelled = false
    let signal: AbortSignal | null | undefined
    const f = await fixture(async (_url, init) => {
      signal = init?.signal
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`{"padding":"${'x'.repeat(size)}"}`)); if (size < 1_000_000) controller.close() },
        cancel() { cancelled = true },
      }))
    })
    try {
      const value = await f.client.callTool({ name: 'weather_current', arguments: { latitude: 0, longitude: 0 } })
      assert.equal(value.isError, true); assert.match(parsed(value).error, /limit/)
      assert.equal(signal?.aborted, true)
      if (size > 1_000_000) assert.equal(cancelled, true)
    } finally { await f.close() }
  }
})

test('MCP request cancellation reaches the HTTP body stream', async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let cancelled!: () => void
  const stopped = new Promise<void>(resolve => { cancelled = resolve })
  let signal: AbortSignal | null | undefined
  const f = await fixture(async (_url, init) => {
    signal = init?.signal
    return new Response(new ReadableStream({ start() { started() }, cancel() { cancelled() } }))
  })
  try {
    const abort = new AbortController()
    const call = f.client.callTool({ name: 'weather_current', arguments: { latitude: 0, longitude: 0 } }, undefined, { signal: abort.signal })
    await ready
    abort.abort()
    await assert.rejects(call)
    await stopped
    assert.equal(signal?.aborted, true)
  } finally { await f.close() }
})

test('ten second deadline also terminates a stalled response body', { timeout: 15_000 }, async () => {
  let cancelled = false
  const f = await fixture(async () => new Response(new ReadableStream({ cancel() { cancelled = true } })))
  try {
    const value = await f.client.callTool({ name: 'weather_current', arguments: { latitude: 0, longitude: 0 } })
    assert.equal(value.isError, true)
    assert.match(parsed(value).error, /timed out/)
    assert.equal(cancelled, true)
  } finally { await f.close() }
})

test('deadline bounds fetch and reader implementations that ignore abort and cancellation', { timeout: 15_000 }, async () => {
  await Promise.all(['fetch', 'reader'].map(async kind => {
    let signal: AbortSignal | null | undefined
    let cancelled = false
    let lateResponse!: (response: Response) => void
    const f = await fixture(async (_url, init) => {
      signal = init?.signal
      if (kind === 'fetch') return new Promise<Response>(resolve => { lateResponse = resolve })
      return {
        ok: true, redirected: false, headers: new Headers(),
        body: { getReader: () => ({
          read: () => new Promise(() => {}),
          cancel: () => { cancelled = true; return new Promise(() => {}) },
        }) },
      } as unknown as Response
    })
    try {
      const value = await f.client.callTool({ name: 'weather_current', arguments: { latitude: 0, longitude: 0 } })
      assert.equal(value.isError, true)
      assert.match(parsed(value).error, /timed out/)
      assert.equal(signal?.aborted, true)
      if (kind === 'fetch') {
        lateResponse(new Response(new ReadableStream({ cancel() { cancelled = true } })))
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      assert.equal(cancelled, true)
    } finally { await f.close() }
  }))
})

test('stdio startup failures use a fixed message without credential echo', () => {
  const child = spawnSync(process.execPath, ['--experimental-transform-types', resolve('src/mcp/providers/qweather.ts')], {
    cwd: resolve('.'), env: { QWEATHER_API_KEY: 'do-not-echo\nsecret', QWEATHER_API_HOST: apiHost }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(child.status, 1)
  assert.equal(child.stdout, '')
  assert.match(child.stderr, /QWeather adapter failed to start/)
  assert.ok(!child.stderr.includes('do-not-echo')); assert.ok(!child.stderr.includes(apiHost))
})
