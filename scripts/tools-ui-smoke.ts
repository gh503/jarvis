#!/usr/bin/env node
/**
 * Real DOM + real API smoke on a parent-managed isolated service (Node 24).
 * JARVIS_URL=http://127.0.0.1:<isolated-port> node scripts/tools-ui-smoke.ts
 * JARVIS_CDP_URL defaults to http://127.0.0.1:9224. Never starts a server.
 * Requires an empty MCP configuration. Creates/deletes one DISABLED stdio fixture.
 * No model generation, external requests, command execution, or fake API responses.
 * Approval lifecycle events below are explicitly synthetic DOM component tests;
 * runtime approval execution and response history belong to the parent's fixture tests.
 */
import { writeFile } from 'node:fs/promises'
const TIMEOUT = 15_000
const checked: string[] = [], failures: string[] = [], screenshots: string[] = [], snapshots: unknown[] = []
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let app = '', cdpOrigin = ''
const secret = `synthetic-secret-${crypto.randomUUID()}`
const scrub = (text: string) => text.replaceAll(secret, '[synthetic secret redacted]')
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
function loopback(value: string, target = false) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.port === '3081' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`Refusing ${target ? 'app' : 'CDP'} target: require explicit HTTP loopback origin and port, never :3081`)
  return url.origin
}
class Cdp {
  socket: WebSocket
  nextId = 1
  pending = new Map<number, Pending>()
  errors: string[] = []
  logs: any[] = []
  conflicts: any[] = []
  expectedConflict = false
  constructor(socket: WebSocket) {
    this.socket = socket
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)), p = message.params
      if (message.id) {
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        clearTimeout(waiter.timer); this.pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result)
      } else if (message.method === 'Runtime.exceptionThrown') this.errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text)
      else if (message.method === 'Runtime.consoleAPICalled' && p.type === 'error') this.errors.push(p.args.map((a: any) => a.value ?? a.description ?? '').join(' '))
      else if (message.method === 'Log.entryAdded' && p.entry.level === 'error') this.logs.push(p.entry)
      else if (message.method === 'Network.responseReceived' && p.response.status >= 400) {
        if (p.response.status === 409 && this.expectedConflict && p.response.url === `${app}/api/mcp/servers`) this.conflicts.push({ requestId:p.requestId, status:409 })
        else this.errors.push(`Unexpected HTTP ${p.response.status}: ${new URL(p.response.url).pathname}`)
      } else if (message.method === 'Fetch.requestPaused') {
        const url = new URL(p.request.url)
        const allowed = url.origin === app
        if (!allowed) this.errors.push('Blocked request outside isolated app origin')
        void this.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId:p.requestId, ...(!allowed ? { errorReason:'BlockedByClient' } : {}) }).catch(error => this.errors.push(String(error)))
      } else if (message.method === 'Page.javascriptDialogOpening') {
        this.errors.push('Unexpected JavaScript dialog')
        void this.send('Page.handleJavaScriptDialog', { accept:false }).catch(() => {})
      }
    }
    socket.onclose = () => this.rejectPending('CDP socket closed')
  }
  rejectPending(reason: string) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)) }; this.pending.clear() }
  static async open(url: string) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.port === '3081') throw new Error('Refusing nonlocal CDP websocket')
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP websocket timeout')) }, TIMEOUT)
      socket.onopen = () => { clearTimeout(timer); resolve() }; socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP websocket error')) }
    })
    return new Cdp(socket)
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, TIMEOUT)
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate<T = any>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  close() { this.rejectPending('CDP closed'); this.socket.close() }
}
async function request(url: string, options: RequestInit = {}) {
  const response = await fetch(url, { ...options, redirect:'error', signal:AbortSignal.timeout(TIMEOUT) })
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${new URL(url).pathname}: unexpected HTTP ${response.status}`)
  return response
}
async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
  return (await request(`${app}${path}`, { method, headers:{ 'content-type':'application/json' }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) })).json()
}
function assert(condition: unknown, label: string) { if (!condition) throw new Error(label); checked.push(label) }
async function until(label: string, predicate: () => Promise<boolean>) {
  const deadline = Date.now() + TIMEOUT
  while (Date.now() < deadline) { if (await predicate()) return; await pause(100) }
  throw new Error(`Timed out: ${label}`)
}
async function main() {
  if (!process.env.JARVIS_URL) throw new Error('JARVIS_URL must explicitly identify an isolated service; no default')
  app = loopback(process.env.JARVIS_URL, true)
  cdpOrigin = loopback(process.env.JARVIS_CDP_URL || 'http://127.0.0.1:9224')
  const initial = await api('/api/mcp')
  assert(Array.isArray(initial.servers) && initial.servers.length === 0, 'MCP configuration empty before synthetic fixtures')
  const target = await (await request(`${cdpOrigin}/json/new?about:blank`, { method:'PUT' })).json() as { id:string; webSocketDebuggerUrl:string }
  let browser: Cdp | undefined
  try {
    browser = await Cdp.open(target.webSocketDebuggerUrl)
    const b = browser, q = JSON.stringify, evaluate = (expression: string) => b.evaluate(expression)
    const wait = (label: string, expression: string) => until(label, () => evaluate(expression))
    const clickExpr = (expression: string) => evaluate(`(() => { const el = ${expression}; if (!el || el.disabled || !el.getClientRects().length) throw new Error('Unavailable control'); el.click() })()`)
    const click = (selector: string) => clickExpr(`document.querySelector(${q(selector)})`)
    const action = (scope: string, text: string) => clickExpr(`[...document.querySelector(${q(scope)}).querySelectorAll('button')].find(el => el.textContent === ${q(text)})`)
    const field = (label: string) => `[...document.querySelectorAll('.tools-form .tools-field')].find(el => el.querySelector('span')?.textContent === ${q(label)}).querySelector('input,textarea,select')`
    const fill = (label: string, value: string) => evaluate(`(() => { const el = ${field(label)}; el.value = ${q(value)}; el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles:true })) })()`)
    const save = async () => { await action('.tools-form', '保存'); await wait('MCP save completes', "document.querySelector('.tools-editor').hidden && document.querySelector('.tools-notice').textContent.includes('新增连接默认停用')") }
    const id = `ui-smoke-${Date.now()}`
    const server = async () => (await api('/api/mcp')).servers.find((s: any) => s.id === id)
    const edit = async () => { await action('#tools-dialog .tools-body', '编辑'); await wait('MCP editor', 'Boolean(document.querySelector(".tools-form"))') }
    const event = (type: string, data: unknown) => evaluate(`window.dispatchEvent(new CustomEvent('jarvis:ws-event', { detail:${q({ type, data })} }))`)
    await b.send('Page.enable'); await b.send('Runtime.enable'); await b.send('Log.enable'); await b.send('Network.enable')
    await b.send('Network.setBypassServiceWorker', { bypass:true })
    await b.send('Fetch.enable', { patterns:[{ urlPattern:'*', requestStage:'Request' }] })
    await b.send('Emulation.setDeviceMetricsOverride', { width:1440, height:960, deviceScaleFactor:1, mobile:false })
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source:"localStorage.setItem('jarvis_onboarded','1')" })
    await b.send('Page.navigate', { url:app })
    await wait('app ready', "Boolean(document.querySelector('#settings-btn') && document.querySelector('#tools-dialog') && document.querySelector('#session-title')?.textContent !== '加载对话…')")
    await click('#settings-btn'); await wait('settings model controls', "Boolean(document.querySelector('#model-supports-tools'))")
    await evaluate("document.querySelector('#model-supports-tools').closest('details').open = true")
    const before = await evaluate("document.querySelector('#model-supports-tools').checked")
    await click('#model-supports-tools')
    assert(await evaluate(`document.querySelector('#model-supports-tools').checked === ${!before}`), 'settings native supportsTools checkbox toggles')
    await click('#model-supports-tools')
    assert(await evaluate(`document.querySelector('#model-supports-tools').checked === ${before}`), 'supportsTools checkbox restored without model invocation (persistence not tested)')
    await click('#settings-tab-system'); await click('#tools-open')
    await wait('tools loaded', "document.querySelector('#tools-dialog').open && document.querySelector('.tools-notice').textContent.includes('新增连接默认停用')")
    assert(await evaluate("document.querySelector('#tools-dialog') instanceof HTMLDialogElement"), 'settings tools button opens native dialog using real API')
    await action('#tools-dialog', '添加连接')
    assert(await evaluate("!document.querySelector('.tools-form .tools-check input').checked"), 'new connection defaults to disabled')
    await fill('连接 ID', id); await fill('命令', 'node'); await fill('命令参数（每行一个，不需要引号）', '-e\nprocess.exit(0)')
    await fill('环境变量 JSON（敏感值，仅用于保存）', JSON.stringify({ SMOKE_SECRET:secret }))
    assert(await evaluate("document.querySelector('.tools-policy').textContent.includes('尚未发现工具') && document.querySelector('.tools-policy').textContent.includes('每次询问')"), 'undiscovered tool policy honestly displays safe defaults')
    await save()
    let current = await server()
    assert(current && current.enabled === false && current.transport === 'stdio' && current.argsCount === 2 && current.hasEnv === true, 'real API persists disabled stdio fixture and redacted metadata')
    assert(!JSON.stringify(current).includes(secret) && !JSON.stringify(current).includes('process.exit'), 'API does not echo synthetic secret or command arguments')
    await edit()
    assert(await evaluate(`${field('命令')}.value === '' && ${field('命令参数（每行一个，不需要引号）')}.value === '' && ${field('环境变量 JSON（敏感值，仅用于保存）')}.value === '' && !document.querySelector('#tools-dialog').textContent.includes(${q(secret)})`), 'edit fields do not echo saved connection details or secret')
    await fill('资料去向', 'local'); await save(); current = await server()
    assert(current.destination === 'local' && current.argsCount === 2 && current.hasEnv === true, 'blank edit preserves redacted args and environment presence (secret value verified by runtime tests)')
    await edit(); await fill('命令', 'node-synthetic-unsaved')
    await action('#tools-dialog', '关闭'); await click('#tools-open')
    await wait('retained draft refresh', "document.querySelector('.tools-notice').textContent.includes('草稿已保留')")
    assert(await evaluate(`${field('命令')}.value === 'node-synthetic-unsaved'`), 'close and reopen retains unsaved command draft')
    const revision = (await api('/api/mcp')).revision
    await api('/api/mcp/servers', 'POST', { id, expectedRevision:revision, enabled:false, transport:'stdio', destination:'remote', tools:{} })
    b.expectedConflict = true
    await action('.tools-form', '保存')
    await wait('409 preserves draft', "document.querySelector('.tools-notice').textContent.includes('配置已在别处更改') && !document.querySelector('.tools-form').hasAttribute('aria-busy')")
    await until('one real 409 response', async () => b.conflicts.length === 1); b.expectedConflict = false
    assert(await evaluate(`${field('命令')}.value === 'node-synthetic-unsaved' && !${field('命令')}.disabled`), 'real stale revision 409 keeps editable draft')
    assert((await server()).destination === 'remote', 'stale save does not overwrite concurrent API mutation')
    await action('.tools-notice', '放弃草稿并载入最新'); await wait('discard confirmation', "Boolean(document.querySelector('.tools-confirm[open]'))")
    await action('.tools-confirm[open]', '放弃草稿并载入'); await wait('latest config loaded', "document.querySelector('.tools-editor').hidden")
    for (const width of [320, 1440]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:width === 320 })
      await evaluate("window.JarvisTheme.set('dark')"); await edit(); await pause(150)
      const layout = await evaluate("(() => { const el = document.querySelector('#tools-dialog'), r = el.getBoundingClientRect(); return { pageOverflow:document.documentElement.scrollWidth-innerWidth, overflow:el.scrollWidth-el.clientWidth, left:r.left, right:r.right, width:innerWidth, dark:document.documentElement.dataset.theme === 'dark' } })()")
      snapshots.push({ surface:'tools editor', ...layout })
      assert(layout.dark && layout.pageOverflow <= 1 && layout.overflow <= 1 && layout.left >= -1 && layout.right <= width + 1, `dark MCP editor fits ${width}px without horizontal overflow`)
      const image = await b.send('Page.captureScreenshot', { format:'png' })
      const path = `/tmp/jarvis-tools-ui-smoke-${width}-dark.png`
      await writeFile(path, Buffer.from(image.data, 'base64')); screenshots.push(path)
      await action('.tools-form', '取消编辑')
    }
    await edit(); await action('.tools-form', '删除连接'); await wait('delete confirmation', "Boolean(document.querySelector('.tools-confirm[open]'))")
    await action('.tools-confirm[open]', '取消')
    assert(Boolean(await server()), 'cancel delete preserves disabled connection')
    await action('.tools-form', '删除连接'); await wait('delete confirmation', "Boolean(document.querySelector('.tools-confirm[open]'))")
    await action('.tools-confirm[open]', '删除连接'); await wait('delete completes', "document.querySelector('.tools-editor').hidden")
    assert((await api('/api/mcp')).servers.length === 0, 'confirmed UI deletion returns real MCP configuration to empty')
    await action('#tools-dialog', '关闭')
    const identity = { sessionId:'synthetic-dom-session', turnId:'synthetic-dom-turn', callId:'synthetic-dom-call' }
    const approval = { ...identity, id:'synthetic-dom-approval', name:'SYNTHETIC DOM ONLY <img src=x>', args:{ synthetic:true }, expiresAt:Date.now() + 60_000 }
    await event('tool.approval', approval)
    await wait('synthetic approval dialog', "Boolean(document.querySelector('.tools-approval-dialog[open]'))")
    assert(await evaluate("document.querySelector('.tools-approval-dialog') instanceof HTMLDialogElement && !document.querySelector('.tools-approval-dialog img') && document.querySelector('.tools-approval-dialog').textContent.includes('SYNTHETIC DOM ONLY <img src=x>')"), 'SYNTHETIC DOM event: approval native dialog renders literal tool name')
    await action('.tools-approval-dialog', '稍后处理')
    assert(await evaluate("!document.querySelector('.tools-approval-dialog').open"), 'SYNTHETIC DOM event: defer closes dialog without submitting approval')
    await event('turn.end', identity); await event('tool.approval', approval)
    assert(await evaluate("!document.querySelector('.tools-approval-dialog').open"), 'SYNTHETIC DOM event: ended turn rejects late approval replay')
    await pause(200)
    assert(b.conflicts.length === 1, 'exactly one intentional MCP HTTP 409')
  } finally {
    if (browser) {
      const expected = new Set(browser.conflicts.map(r => r.requestId))
      for (const log of browser.logs) if (!(expected.has(log.networkRequestId) && /\b409\b/.test(log.text))) browser.errors.push(log.text)
      failures.push(...browser.errors.map(error => `browser error: ${scrub(error)}`)); browser.close()
    }
    await request(`${cdpOrigin}/json/close/${target.id}`).catch(() => failures.push('CDP target cleanup failed'))
  }
}
void main().catch(error => failures.push(scrub(error instanceof Error ? error.message : String(error)))).finally(() => {
  console.log(JSON.stringify({ ok:failures.length === 0, url:app || null, checked, snapshots, screenshots, failures, coverage:{ real:'MCP CRUD, redaction metadata, stale revision, native settings checkbox and dialog, responsive dark layout', synthetic:'approval DOM lifecycle only; no approval API submission or fake responses', excluded:'model capability persistence, model generation, real runtime approval execution and conversation tool history; parent tests cover these' }, fixtures:'disabled synthetic only; parent owns isolated service and failure cleanup' }, null, 2))
  if (failures.length) process.exitCode = 1
})
