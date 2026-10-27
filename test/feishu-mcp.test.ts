import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createFeishuServer } from '../src/mcp/providers/feishu.ts'

const appId = 'cli_synthetic_test'
const appSecret = 'synthetic-app-secret-do-not-echo'
const access = 'synthetic-tenant-token-do-not-echo'
const authPath = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
const json = (data: unknown) => new Response(JSON.stringify(data))
const auth = (expire = 7200) => json({ code: 0, tenant_access_token: access, expire })
const doc = () => json({ code: 0, data: { content: '文档正文' } })
const call = (client: Client) => client.callTool({ name: 'feishu_document_read', arguments: { documentId: 'Doc_123-abc' } })
function parsed(value: unknown): any {
  const result = value as CallToolResult
  assert.equal(result.isError, undefined)
  assert.equal(result.content[0].type, 'text')
  return JSON.parse((result.content[0] as { text: string }).text)
}
function safeError(value: unknown) {
  const result = value as CallToolResult
  assert.equal(result.isError, true)
  const text = JSON.stringify(result)
  for (const secret of [appId, appSecret, access, 'evil.test', 'PRIVATE_BODY']) assert.ok(!text.includes(secret), text)
}
async function fixture(fetcher: typeof fetch) {
  const server = createFeishuServer({ appId, appSecret, fetch: fetcher })
  const client = new Client({ name: 'feishu-test', version: '1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  await client.connect(ct)
  return { client, close: async () => { await client.close(); await server.close() } }
}
async function bounded<T>(promise: Promise<T>, ms = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('operation did not settle within test bound')), ms) })]) }
  finally { clearTimeout(timer) }
}

test('Feishu credentials reject CRLF, NUL, empty and oversized values without echo', () => {
  for (const id of ['', 'a\r', 'a\n', 'a\0', 'https://evil.test', 'a'.repeat(129)]) {
    assert.throws(() => createFeishuServer({ appId: id, appSecret }), { message: 'Invalid Feishu application credentials' })
  }
  for (const secret of ['', 'secret\r', 'secret\n', 'secret\0', 's'.repeat(8193)]) {
    assert.throws(() => createFeishuServer({ appId, appSecret: secret }), { message: 'Invalid Feishu application credentials' })
  }
})

test('SDK discovery is local; top-level auth is POST and cached; docs and wiki use fixed official GET URLs', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const f = await fixture(async (input, init) => {
    const url = String(input); calls.push({ url, init })
    return url === authPath ? auth() : url.includes('/wiki/') ? json({ code: 0, data: { node: { title: '知识库', obj_token: 'Doc_target', obj_type: 'docx' } } }) : doc()
  })
  try {
    const tools = await f.client.listTools()
    assert.equal(calls.length, 0)
    assert.deepEqual(tools.tools.map(t => t.name), ['feishu_document_read', 'feishu_wiki_node'])
    assert.ok(tools.tools.every(t => t.annotations?.readOnlyHint && t.inputSchema.additionalProperties === false))
    assert.equal(parsed(await call(f.client)).content, '文档正文')
    assert.equal(parsed(await call(f.client)).truncated, false)
    const node = parsed(await f.client.callTool({ name: 'feishu_wiki_node', arguments: { token: 'Wiki_123' } }))
    assert.equal(node.objectType, 'docx'); assert.equal(node.objectToken, 'Doc_target'); assert.equal(node.canReadDocument, true)
    assert.equal(calls.length, 4)
    assert.equal(calls[0].url, authPath); assert.equal(calls[0].init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { app_id: appId, app_secret: appSecret })
    assert.equal(new Headers(calls[0].init?.headers).get('Content-Type'), 'application/json')
    assert.equal(calls[1].url, 'https://open.feishu.cn/open-apis/docx/v1/documents/Doc_123-abc/raw_content')
    assert.equal(calls[3].url, 'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=Wiki_123&obj_type=wiki')
    for (const request of calls.slice(1)) {
      assert.equal(request.init?.method ?? 'GET', 'GET')
      assert.equal(new Headers(request.init?.headers).get('Authorization'), `Bearer ${access}`)
      assert.equal(request.init?.body, undefined)
    }
    for (const request of calls) { assert.equal(request.init?.redirect, 'manual'); assert.ok(request.init?.signal); assert.ok(!request.url.includes(appSecret)); assert.ok(!request.url.includes(access)) }
  } finally { await f.close() }
})

test('document text is capped at 4000 characters and non-docx wiki nodes are not readable', async () => {
  const f = await fixture(async input => String(input) === authPath ? auth() : String(input).includes('/wiki/') ? json({ code: 0, data: { node: { title: 't'.repeat(1200), obj_token: 'sheet', obj_type: 'sheet' } } }) : json({ code: 0, data: { content: '中'.repeat(4500) } }))
  try {
    const value = parsed(await call(f.client))
    assert.equal(value.content, '中'.repeat(4000)); assert.equal(value.truncated, true)
    const node = parsed(await f.client.callTool({ name: 'feishu_wiki_node', arguments: { token: 'Wiki' } }))
    assert.equal(node.canReadDocument, false); assert.equal(node.title.length, 1000)
  } finally { await f.close() }
})

test('argument injection and unknown tools are rejected before any fetch', async () => {
  let count = 0
  const f = await fixture(async () => { count++; return auth() })
  try {
    for (const id of ['', '../secret', 'https://evil.test', 'x?token=y', 'x#y', 'x/y', 'x%2fy', 'x\r\nAuthorization:bad', 'x'.repeat(257), 3, null]) {
      for (const [name, field] of [['feishu_document_read', 'documentId'], ['feishu_wiki_node', 'token']]) safeError(await f.client.callTool({ name, arguments: { [field]: id } }))
    }
    for (const [name, args] of [['feishu_delete', { documentId: 'valid' }], ['feishu_document_read', {}], ['feishu_document_read', { documentId: 'valid', url: 'https://evil.test' }], ['feishu_wiki_node', { token: 'valid', appSecret: 'override' }]] as [string, Record<string, unknown>][]) safeError(await f.client.callTool({ name, arguments: args }))
    assert.equal(count, 0)
  } finally { await f.close() }
})

test('HTTP, malformed JSON, provider errors and exceptions never expose secrets', async () => {
  const failures = [
    () => new Response(`${appSecret} PRIVATE_BODY`, { status: 401 }),
    () => new Response(access, { status: 403 }),
    () => new Response(appSecret, { status: 429 }),
    () => new Response(appSecret, { status: 302, headers: { location: 'https://evil.test' } }),
    () => new Response(appSecret),
    () => json({ code: 999, msg: `${appSecret} ${access}` }),
    () => json(null), () => json([]), () => json({ code: 0, data: {} }),
    () => { throw new Error(`https://evil.test/${appSecret}/${access}`) },
  ]
  for (const failure of failures) for (const stage of ['auth', 'document']) {
    const f = await fixture(async input => stage === 'document' && String(input) === authPath ? auth() : failure())
    try { safeError(await call(f.client)) } finally { await f.close() }
  }
})

test('malformed token envelopes and header injection are rejected', async () => {
  for (const data of [
    { code: 0, data: { tenant_access_token: access, expire: 7200 } },
    ...['', 'a\r', 'a\n', 'a\0', 'a'.repeat(8193)].map(tenant_access_token => ({ code: 0, tenant_access_token, expire: 7200 })),
    ...[0, -1, 7201, '7200', null].map(expire => ({ code: 0, tenant_access_token: access, expire })),
  ]) {
    let count = 0
    const f = await fixture(async () => { count++; return json(data) })
    try { safeError(await call(f.client)); assert.equal(count, 1) } finally { await f.close() }
  }
})

test('tokens with at most sixty seconds remaining are never reused', async () => {
  for (const expire of [1, 59, 60]) {
    let count = 0
    const f = await fixture(async input => { if (String(input) === authPath) { count++; return auth(expire) }; return doc() })
    try { await call(f.client); await call(f.client); assert.equal(count, 2) } finally { await f.close() }
  }
})

test('concurrent calls share a single token refresh', async () => {
  let count = 0
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  let started!: () => void
  const ready = new Promise<void>(r => { started = r })
  const f = await fixture(async input => { if (String(input) === authPath) { count++; started(); await gate; return auth() }; return doc() })
  try {
    const calls = [call(f.client), call(f.client), call(f.client)]
    await bounded(ready); release()
    for (const result of await Promise.all(calls)) assert.equal(parsed(result).content, '文档正文')
    assert.equal(count, 1)
  } finally { release(); await f.close() }
})

test('401 and 403 invalidate a cached token', async () => {
  for (const status of [401, 403]) {
    let tokens = 0, docs = 0
    const f = await fixture(async input => { if (String(input) === authPath) { tokens++; return auth() }; return ++docs === 1 ? new Response(access, { status }) : doc() })
    try { safeError(await call(f.client)); assert.equal(parsed(await call(f.client)).content, '文档正文'); assert.equal(tokens, 2) } finally { await f.close() }
  }
})

test('ten-second deadline bounds fetch even if injected fetch ignores abort', async t => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 10000); return realTimeout(20) })
  let signal: AbortSignal | null | undefined
  const f = await fixture(async (_input, init) => { signal = init?.signal; return await new Promise<Response>(() => {}) })
  try { safeError(await bounded(call(f.client))); assert.equal(signal?.aborted, true) } finally { await f.close() }
})

test('deadline cancels a stalled body even when the stream ignores fetch signal', async t => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', () => realTimeout(20))
  let cancelled = false
  const f = await fixture(async () => new Response(new ReadableStream({ cancel() { cancelled = true } })))
  try { safeError(await bounded(call(f.client))); assert.equal(cancelled, true) } finally { await f.close() }
})

test('MCP cancellation reaches document stream and cancels its reader', async () => {
  let started!: () => void, stopped!: () => void
  const ready = new Promise<void>(r => { started = r }), cancelled = new Promise<void>(r => { stopped = r })
  let signal: AbortSignal | null | undefined
  const f = await fixture(async (input, init) => {
    if (String(input) === authPath) return auth()
    signal = init?.signal
    return new Response(new ReadableStream({ start() { started() }, cancel() { stopped() } }))
  })
  try {
    const abort = new AbortController()
    const pending = f.client.callTool({ name: 'feishu_document_read', arguments: { documentId: 'Doc' } }, undefined, { signal: abort.signal })
    await bounded(ready); abort.abort(); await assert.rejects(pending)
    await bounded(cancelled); assert.equal(signal?.aborted, true)
  } finally { await f.close() }
})

test('cancelled callers do not cancel the shared token refresh for other callers', async () => {
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { started = r })
  let tokens = 0, docs = 0
  let authSignal: AbortSignal | null | undefined
  const f = await fixture(async (input, init) => {
    if (String(input) === authPath) { tokens++; authSignal = init?.signal; started(); await gate; return auth() }
    docs++; return doc()
  })
  try {
    const abort = new AbortController()
    const first = f.client.callTool({ name: 'feishu_document_read', arguments: { documentId: 'Doc' } }, undefined, { signal: abort.signal })
    await bounded(ready)
    const second = call(f.client)
    abort.abort(); await assert.rejects(first)
    assert.equal(authSignal?.aborted, false)
    release(); assert.equal(parsed(await bounded(second)).content, '文档正文')
    assert.equal(tokens, 1); assert.equal(docs, 1)
  } finally { release(); await f.close() }
})

test('late fetch responses are cancelled after deadline and cancellation cannot stall cleanup', async t => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', () => realTimeout(20))
  let release!: (response: Response) => void
  let cancelled = false
  const f = await fixture(async () => await new Promise<Response>(r => { release = r }))
  try {
    safeError(await bounded(call(f.client)))
    release(new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise<void>(() => {}) } })))
    await new Promise<void>(r => setImmediate(r))
    assert.equal(cancelled, true)
  } finally { await f.close() }
})

test('a stalled stream cancel hook cannot prevent timeout response', async t => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', () => realTimeout(20))
  let cancelled = false
  const f = await fixture(async () => new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise<void>(() => {}) } })))
  try { safeError(await bounded(call(f.client))); assert.equal(cancelled, true) } finally { await f.close() }
})

test('oversized bodies cancel the stream and return a safe error', async () => {
  let cancelled = false
  const f = await fixture(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1)) }, cancel() { cancelled = true } })))
  try { safeError(await call(f.client)); assert.equal(cancelled, true) } finally { await f.close() }
})

test('stdio startup never writes credentials to stdout or stderr', () => {
  const child = spawnSync(process.execPath, ['--experimental-transform-types', resolve('src/mcp/providers/feishu.ts')], {
    cwd: resolve('.'), env: { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: `${appSecret}\n` }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(child.status, 1); assert.equal(child.stdout, '')
  assert.match(child.stderr, /Feishu adapter could not start/)
  for (const secret of [appId, appSecret, access]) assert.ok(!child.stderr.includes(secret))
})
