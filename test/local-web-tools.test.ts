import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { SafeFetcher, WebTools, htmlText, publicAddress, publicUrl, type WebResponse, type WebTransport } from '../src/local-tools/web.ts'

const resolver = async () => [{ address: '93.184.216.34', family: 4 }]
const context = () => ({ signal: new AbortController().signal, sessionId: 's', turnId: 't', callId: 'c' })
function response(text = 'hello', headers: WebResponse['headers'] = { 'content-type': 'text/plain' }, status = 200): WebResponse {
  return { status, headers, body: (async function* () { yield Buffer.from(text) })() }
}

test('web tools require opt-in and hash the configuration revision', async () => {
  let revision = 1, webEnabled = false, calls = 0
  const tools = new WebTools({ settings: { snapshot: () => ({ revision, webEnabled }) }, resolver,
    transport: async () => { calls++; return response() } })
  assert.deepEqual(tools.definitions(), [])
  webEnabled = true
  const old = tools.definitions()
  assert.deepEqual(old.map(t => t.name), ['web_search', 'web_fetch'])
  for (const t of old) assert.deepEqual([t.destination, t.usage, t.permission, t.effect], ['remote', 'shared', 'allow', 'read'])
  revision++
  assert.notEqual(old[1].definitionHash, tools.definitions()[1].definitionHash)
  assert.equal((await old[1].execute({ url: 'https://example.com' }, context())).isError, true)
  assert.equal(calls, 0)
})

test('static SSRF and normalized numeric hosts fail before connection', async () => {
  let calls = 0
  const fetcher = new SafeFetcher({ resolver, transport: async () => { calls++; return response() } })
  for (const url of ['http://127.0.0.1', 'http://2130706433', 'http://0177.0.0.1', 'http://0x7f000001',
    'http://169.254.169.254', 'http://168.63.129.16', 'http://10.0.0.1', 'http://192.168.0.1', 'http://100.64.0.1', 'http://224.1.1.1',
    'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://[::ffff:8.8.8.8]', 'http://[fc00::1]',
    'http://[fe80::1%25eth0]', 'http://[2001:db8::1]', 'file:///etc/passwd', 'https://u:p@example.com',
    'http://localhost', 'http://host.internal', `https://example.com/${'a'.repeat(2048)}`]) {
    await assert.rejects(fetcher.fetch(url), Error, url)
  }
  assert.equal(calls, 0)
  assert.equal(publicAddress('2606:4700:4700::1111'), true)
  assert.equal(publicAddress('8.8.8.8'), true)
  assert.equal(publicAddress('198.18.0.1'), false)
  assert.equal(publicAddress('2002:0808:0808::1'), false)
  assert.equal(publicUrl('https://example.com/#fragment').href, 'https://example.com/')
})

test('all DNS answers must be public, and each redirect is validated and pinned', async () => {
  let calls = 0
  const blocked = new SafeFetcher({ resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }],
    transport: async () => { calls++; return response() } })
  await assert.rejects(blocked.fetch('https://example.com'), /Non-public DNS/)
  assert.equal(calls, 0)
  const hosts: string[] = [], pins: string[] = []
  const fetcher = new SafeFetcher({ resolver: async hostname => { hosts.push(hostname); return [{ address: hosts.length === 1 ? '8.8.8.8' : '1.1.1.1', family: 4 }] },
    transport: async (url, options) => {
      pins.push(options.address.address)
      assert.equal(options.headers.Authorization, undefined)
      assert.equal(options.headers.Cookie, undefined)
      return url.hostname === 'example.com' ? response('', { location: 'https://other.example/path' }, 302) : response('final')
    } })
  const result = await fetcher.fetch('https://example.com')
  assert.deepEqual(hosts, ['example.com', 'other.example'])
  assert.deepEqual(pins, ['8.8.8.8', '1.1.1.1'])
  assert.equal(result.citationUrl, 'https://other.example/path')
  assert.equal(result.text, 'final')
  const redirect = new SafeFetcher({ resolver, transport: async () => { calls++; return response('', { location: 'http://127.0.0.1' }, 302) } })
  await assert.rejects(redirect.fetch('https://example.com'), /Non-public/)
  assert.equal(calls, 1)
})

test('redirects stop after three and binary types never become text', async () => {
  let calls = 0
  const loop = new SafeFetcher({ resolver, transport: async () => { calls++; return response('', { location: '/again' }, 302) } })
  await assert.rejects(loop.fetch('https://example.com'), /Redirect limit/)
  assert.equal(calls, 4)
  await assert.rejects(new SafeFetcher({ resolver, transport: async () => response('binary', { 'content-type': 'image/png' }) }).fetch('https://example.com'), /content type/)
})

test('HTML extraction removes active and hidden markup, decodes entities, and bounds text', async () => {
  const html = '<head><title>hidden title</title></head><p>Hello &amp; &#x1f600;</p><!-- secret --><script>bad()</script><style>bad</style>'
    + '<div HIDDEN="false"><span>secret</span></div><div aria-hidden="true">private</div><p style="display: none">invisible</p><p>public</p>'
  assert.equal(htmlText(html), 'Hello & 😀 public')
  const result = await new SafeFetcher({ resolver, transport: async () => response(html + 'x'.repeat(17000), { 'content-type': 'text/html; charset=utf-8' }) }).fetch('https://example.com')
  assert.equal(result.text.length, 16000)
  assert.equal(result.truncated, true)
  assert.equal(result.untrusted, true)
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)))
})

test('compressed streams are decoded and decompressed bodies capped at 2MB', async () => {
  const compressed = (text: string): WebTransport => async () => ({ status: 200, headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
    body: (async function* () { yield gzipSync(text) })() })
  assert.equal((await new SafeFetcher({ resolver, transport: compressed('compressed hello') }).fetch('https://example.com')).text, 'compressed hello')
  await assert.rejects(new SafeFetcher({ resolver, transport: compressed('x'.repeat(2 * 1024 * 1024 + 1)) }).fetch('https://example.com'), /2MB/)
})

test('abort and timeout cover DNS, connection, and stalled bodies', async () => {
  const controller = new AbortController()
  let calls = 0
  const fetcher = new SafeFetcher({ resolver: () => new Promise(() => {}), transport: async () => { calls++; return response() } })
  const pending = fetcher.fetch('https://example.com', { signal: controller.signal })
  controller.abort(new Error('cancelled'))
  await assert.rejects(pending, /cancelled/)
  assert.equal(calls, 0)
  await assert.rejects(new SafeFetcher({ resolver, timeoutMs: 10, transport: () => new Promise(() => {}) }).fetch('https://example.com'), /timed out/)
  let closed = false
  await assert.rejects(new SafeFetcher({ resolver, timeoutMs: 10, transport: async () => ({ status: 200, headers: { 'content-type': 'text/plain' },
    body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }, close: () => { closed = true } }) }).fetch('https://example.com'), /timed out/)
  assert.equal(closed, true)
})

test('configuration changes during resolution prevent connection and during body prevent release', async () => {
  let revision = 1, calls = 0
  const settings = { snapshot: () => ({ revision, webEnabled: true }) }
  const before = new WebTools({ settings, resolver: async () => { revision++; return resolver() }, transport: async () => { calls++; return response() } })
  assert.equal((await before.definitions()[1].execute({ url: 'https://example.com' }, context())).isError, true)
  assert.equal(calls, 0)
  const during = new WebTools({ settings, resolver, transport: async () => ({ status: 200, headers: { 'content-type': 'text/plain' },
    body: (async function* () { yield Buffer.from('secret result'); revision++ })() }) })
  const result = await during.definitions()[1].execute({ url: 'https://example.com' }, context())
  assert.equal(result.isError, true)
  assert.doesNotMatch(result.content, /secret result/)
})

test('DuckDuckGo fixture yields cited decoded links and snippets, with honest failures', async () => {
  const settings = { snapshot: () => ({ revision: 1, webEnabled: true }) }
  const html = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle">A &amp; B</a><a class="result__snippet">Useful <b>snippet</b></a>'
  const tools = new WebTools({ settings, resolver, transport: async url => {
    assert.equal(url.hostname, 'html.duckduckgo.com')
    assert.equal(url.searchParams.get('q'), 'public query')
    return response(html, { 'content-type': 'text/html' })
  } })
  const result = await tools.definitions()[0].execute({ queries: ['public query'] }, context())
  assert.equal(result.isError, undefined)
  const parsed = JSON.parse(result.content)
  assert.equal(parsed.untrusted, true)
  assert.deepEqual(parsed.data.queries[0].results[0], { title: 'A & B', url: 'https://example.com/article', citationUrl: 'https://example.com/article', snippet: 'Useful snippet' })
  for (const queries of [[], ['a', 'b', 'c', 'd'], [4]]) assert.equal((await tools.definitions()[0].execute({ queries }, context())).isError, true)
  const failure = new WebTools({ settings, resolver, transport: async () => response('<p>Bot challenge</p>', { 'content-type': 'text/html' }) })
  assert.equal((await failure.definitions()[0].execute({ queries: ['hello'] }, context())).isError, true)
})

test('search returns at most eight results across queries', async () => {
  const html = Array.from({ length: 10 }, (_, i) => `<a class="result__a" href="https://example.com/${i}">Title ${i}</a>`).join('')
  const tools = new WebTools({ settings: { snapshot: () => ({ revision: 1, webEnabled: true }) }, resolver,
    transport: async () => response(html, { 'content-type': 'text/html' }) })
  const result = JSON.parse((await tools.definitions()[0].execute({ queries: ['a', 'b', 'c'] }, context())).content)
  assert.equal(result.data.queries.reduce((sum: number, q: { results: unknown[] }) => sum + q.results.length, 0), 8)
})
