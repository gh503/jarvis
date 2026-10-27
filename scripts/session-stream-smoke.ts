#!/usr/bin/env node
/** Synthetic session race regression. Serves actual web/ assets on an ephemeral
 * loopback HTTP+WS server. Never accesses live :3081 or real session storage.
 * Run: node --experimental-transform-types scripts/session-stream-smoke.ts
 * Requires Chrome CDP :9224 (override JARVIS_CDP_URL). */
import { createServer, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { WebSocketServer } from 'ws'
import assert from 'node:assert/strict'

const CDP = process.env.JARVIS_CDP_URL || 'http://127.0.0.1:9224'
const web = resolve(import.meta.dirname, '../web')
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
const checked: string[] = []
class Cdp {
  socket: WebSocket
  seq = 0
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  errors: string[] = []
  frames: string[] = []
  requestUrls = new Map<string, string>()
  finished: string[] = []
  constructor(socket: WebSocket) {
    this.socket = socket
    socket.onmessage = e => {
      const m = JSON.parse(String(e.data))
      if (m.id) {
        const p = this.pending.get(m.id); if (!p) return
        clearTimeout(p.timer); this.pending.delete(m.id)
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
      } else if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      else if (m.method === 'Network.webSocketFrameReceived') this.frames.push(m.params.response.payloadData)
      else if (m.method === 'Network.requestWillBeSent') this.requestUrls.set(m.params.requestId, m.params.request.url)
      else if (m.method === 'Network.loadingFinished') this.finished.push(this.requestUrls.get(m.params.requestId) || '')
    }
  }
  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout ${method}`)) }, 12000)
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  close() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('closing')) }; this.pending.clear(); this.socket.close() }
}
async function until(label: string, fn: () => Promise<boolean> | boolean) {
  const end = Date.now() + 12000
  while (Date.now() < end) { if (await fn()) return; await pause(30) }
  throw new Error(`Timed out: ${label}`)
}
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const TA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const now = '2026-01-01T00:00:00.000Z'
const sessions = [A, B].map((id, i) => ({ id, title: i ? 'Fixture B' : 'Fixture A', archived: false, createdAt: now, updatedAt: now, messageCount: 2 }))
let active: { sessionId: string; turnId: string } | null = { sessionId: A, turnId: TA }
const message = (id: number, sessionId: string, turnId: string, role: string, content: string, status = 'complete') => ({ id, sessionId, turnId, role, content, status, createdAt: now })
const messages = new Map([
  [A, [message(1, A, TA, 'user', 'A question'), message(2, A, TA, 'assistant', 'A partial', 'streaming')]],
  [B, [message(3, B, TB, 'user', 'B question'), message(4, B, TB, 'assistant', 'B answer')]],
])
const status = { modelReady: true, model: 'synthetic', provider: 'local', voice: { asr: false, tts: false } }
const snapshot = (id: string) => ({ session: sessions.find(s => s.id === id), messages: { items: messages.get(id), hasMore: false }, activeTurn: active })
let holdA = false
const held: { response: ServerResponse; body: string }[] = []
const unexpected: string[] = []
const counts = new Map<string, number>()
function json(res: ServerResponse, body: unknown) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://fixture')
    const path = url.pathname
    if (path.startsWith('/api/')) {
      if (req.method !== 'GET') { unexpected.push(`${req.method} ${path}`); res.writeHead(405); res.end(); return }
      counts.set(path, (counts.get(path) || 0) + 1)
      if (path === '/api/bootstrap') return json(res, { sessions: { items: sessions }, defaultSessionId: A, activeTurn: active, memory: [], reminders: [], actions: [], status, attention: { state: 'idle' } })
      if (path === '/api/sessions') return json(res, { items: sessions, total: 2, hasMore: false })
      if (path.startsWith('/api/sessions/')) {
        const id = path.split('/').pop()!
        if (id === A && holdA) { held.push({ response: res, body: JSON.stringify(snapshot(id)) }); return }
        return json(res, snapshot(id))
      }
      if (path === '/api/tuning') return json(res, { values: {}, defaults: {}, groups: [], presets: [] })
      if (path === '/api/model') return json(res, { settings: { profiles: [], scenarios: [], defaultScenario: 'chat' } })
      if (path === '/api/models') return json(res, status)
      if (path === '/api/health') return json(res, { ok: true, status })
      if (path === '/api/providers/catalog') return json(res, { providers: [] })
      if (path === '/api/memory' || path === '/api/reminders') return json(res, { items: [] })
      unexpected.push(`GET ${path}`); return json(res, {})
    }
    const file = resolve(web, '.' + (path === '/' ? '/index.html' : path))
    if (!file.startsWith(web + '/')) { res.writeHead(403); res.end(); return }
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' } as Record<string, string>)[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch { res.writeHead(404); res.end() }
})
const wss = new WebSocketServer({ server, path: '/ws' })
let connections = 0
wss.on('connection', socket => {
  connections++
  socket.send(JSON.stringify({ kind: 'hello', status, attention: { state: 'idle' }, activeTurn: active }))
  socket.on('message', raw => {
    const m = JSON.parse(String(raw))
    if (m.kind === 'ping') socket.send(JSON.stringify({ kind: 'pong' }))
    else unexpected.push(`WS ${m.kind}`)
  })
})
function emit(type: string, data: Record<string, unknown>) {
  for (const socket of wss.clients) socket.send(JSON.stringify({ kind: 'event', event: { type, data } }))
}
let cdp: Cdp | undefined
let targetId = ''
try {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  assert.notEqual(port, 3081)
  const origin = `http://127.0.0.1:${port}`
  const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json() as any
  targetId = target.id
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('CDP unavailable')) })
  cdp = new Cdp(socket)
  const browser = cdp
  await browser.send('Page.enable'); await browser.send('Runtime.enable'); await browser.send('Network.enable')
  const rendered = () => browser.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('jarvis_onboarded','1')" })
  await browser.send('Page.navigate', { url: origin })
  const text = () => browser.eval("document.querySelector('#transcript')?.innerText || ''")
  const selected = (title: string) => browser.eval(`document.querySelector('#session-title')?.textContent === ${JSON.stringify(title)}`)
  const open = async (id: string) => {
    await browser.eval("if (!document.querySelector('#history-dialog').open) document.querySelector('#history-open').click()")
    const button = `[...document.querySelectorAll('.history-session')].find(el => el.querySelector('strong')?.textContent === ${JSON.stringify(sessions.find(s => s.id === id)!.title)})`
    await until('history buttons', () => browser.eval(`Boolean(${button})`))
    await browser.eval(`${button}.click()`)
  }
  await until('initial A snapshot and WS hello', async () => connections > 0 && await selected('Fixture A') && (await text()).includes('A partial'))
  // 1. A keeps streaming while B is selected; returning restores server partial.
  await open(B); await until('B selected', () => selected('Fixture B'))
  messages.get(A)![1].content = 'A partial extended'
  emit('assistant.delta', { sessionId: A, turnId: TA, text: ' extended', full: 'A partial extended' })
  emit('voice.transcribed', { sessionId: A, turnId: TA, text: 'A hidden voice' })
  await until('A voice frame delivered', () => browser.frames.some(frame => frame.includes('A hidden voice')))
  await rendered()
  assert(!(await text()).includes('A partial') && !(await text()).includes('A hidden voice'))
  await open(A); await until('restored partial', async () => (await text()).includes('A partial extended'))
  checked.push('A stream and voice do not contaminate B; return restores partial A')
  // 2. Deliberately release an older A HTTP response after B has loaded.
  await open(B); await until('B before stale test', () => selected('Fixture B'))
  holdA = true
  await open(A); await until('A response held', () => held.length > 0)
  await open(B); await until('later B snapshot rendered', () => selected('Fixture B'))
  holdA = false
  const aFinished = () => browser.finished.filter(url => url.includes(`/api/sessions/${A}`)).length
  const beforeAResponse = aFinished()
  for (const item of held.splice(0)) { item.response.writeHead(200, { 'content-type': 'application/json' }); item.response.end(item.body) }
  await until('stale A response delivered', () => aFinished() > beforeAResponse)
  await rendered()
  assert(await selected('Fixture B')); assert((await text()).includes('B answer')); assert(!(await text()).includes('A partial'))
  checked.push('delayed A snapshot cannot overwrite later-selected B')
  // 3. Reconnect restores the selected session plus active engine identity.
  await open(A); await until('A before reconnect', () => selected('Fixture A'))
  messages.get(A)![1].content = 'A reconnect recovered'
  const beforeConnections = connections
  for (const client of wss.clients) client.close(1012, 'synthetic restart')
  await until('reconnected snapshot', async () => connections > beforeConnections && (await text()).includes('A reconnect recovered'))
  assert(await browser.eval("document.querySelector('#send-btn').disabled && !document.querySelector('#stop-btn').hidden"))
  checked.push('reconnect restores A partial and active turn busy state')
  // Late terminal from A after B begins must not unlock or pollute B.
  active = { sessionId: B, turnId: TB }
  messages.get(B)![1].status = 'streaming'
  await open(B); await until('active B snapshot', () => selected('Fixture B'))
  emit('voice.transcribed', { sessionId: A, turnId: TA, text: 'LATE A VOICE' })
  emit('assistant.delta', { sessionId: A, turnId: TA, full: 'LATE A DELTA' })
  emit('assistant.done', { sessionId: A, turnId: TA, text: 'LATE A DONE', audioUrl: '/late-a.wav' })
  emit('assistant.delta', { sessionId: B, turnId: TB, full: 'B current sentinel' })
  await until('B sentinel', async () => (await text()).includes('B current sentinel'))
  assert(!(await text()).includes('LATE A')); assert(await browser.eval("document.querySelector('#send-btn').disabled"))
  checked.push('late A voice/delta/terminal cannot contaminate or unlock active B')
  // Identical text belongs to distinct UUID turns, and each echo deduplicates itself.
  active = null
  messages.set(B, [message(10, B, TB, 'user', 'same text'), message(11, B, TA, 'user', 'same text')])
  emit('turn.end', { sessionId: B, turnId: TB })
  await until('distinct same text messages', () => browser.eval("document.querySelectorAll('#transcript .message.user[data-message-id]').length === 2"))
  assert.deepEqual(await browser.eval("[...document.querySelectorAll('#transcript .message.user')].map(el => el.dataset.turnId)"), [TB, TA])
  checked.push('same text with distinct turn UUIDs renders two persisted messages')
  await until('idle before other tab start', () => browser.eval("!document.querySelector('#send-btn').disabled"))
  active = { sessionId: A, turnId: TA }
  emit('turn.start', { sessionId: A, turnId: TA })
  await until('other tab starts before voice transcript', () => browser.eval("document.querySelector('#send-btn').disabled && !document.querySelector('#stop-btn').hidden"))
  assert(await selected('Fixture B')); assert(!(await text()).includes('A reconnect recovered'))
  checked.push('other-tab turn.start immediately locks B before any user/voice event')
  assert.deepEqual(browser.errors, [], 'browser runtime errors')
  assert.deepEqual(unexpected, [], 'unexpected mock requests indicate incomplete fixture')
  console.log(JSON.stringify({ ok: true, origin, checked, connections, browserErrors: browser.errors }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ ok: false, checked, error: String(error), browserErrors: cdp?.errors, unexpected }, null, 2)); process.exitCode = 1
} finally {
  for (const item of held) item.response.destroy()
  cdp?.close()
  if (targetId) await fetch(`${CDP}/json/close/${targetId}`).catch(() => {})
  for (const socket of wss.clients) socket.terminate()
  await new Promise<void>(r => wss.close(() => r()))
  server.closeAllConnections()
  await new Promise<void>(r => server.close(() => r()))
}
