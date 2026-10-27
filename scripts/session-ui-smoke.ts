#!/usr/bin/env node
/**
 * Destructive session smoke test against an ALREADY RUNNING isolated server.
 * Node 24: JARVIS_URL=http://127.0.0.1:<isolated-port> node scripts/session-ui-smoke.ts
 * Chrome must expose CDP on 9223 (override with JARVIS_CDP_URL).
 * Never starts a server. Refuses missing URLs, non-loopback hosts and live :3081.
 * Clears ALL sessions on the supplied test server. Uses /time, never an LLM.
 * Only real API/UI interactions; does not simulate streaming events.
 */
const TIMEOUT = 12_000
const CDP = (process.env.JARVIS_CDP_URL || 'http://127.0.0.1:9223').replace(/\/+$/, '')
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const checked: string[] = []
const failures: string[] = []
const snapshots: unknown[] = []
let app = ''

type Session = { id: string; title: string; archived: boolean; messageCount: number }
type Snapshot = { session: Session; messages: { items: { id: number; role: string; content: string }[] } }
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

// Same native WebSocket/CDP approach as ui-smoke.ts, with bounded requests.
class Cdp {
  socket: WebSocket
  nextId = 1
  pending = new Map<number, Pending>()
  errors: string[] = []
  constructor(socket: WebSocket) {
    this.socket = socket
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data))
      if (message.id) {
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        clearTimeout(waiter.timer)
        this.pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error.message))
        else waiter.resolve(message.result)
      } else if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params.exceptionDetails
        this.errors.push(detail.exception?.description || detail.text)
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.errors.push(message.params.args.map((arg: any) => arg.value ?? arg.description ?? '').join(' '))
      } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        this.errors.push(message.params.entry.text)
      } else if (message.method === 'Page.javascriptDialogOpening') {
        this.errors.push(`Unexpected JavaScript dialog: ${message.params.message}`)
        void this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
      }
    }
    socket.onclose = () => this.rejectPending('CDP socket closed')
  }
  rejectPending(reason: string) {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(reason)) }
    this.pending.clear()
  }
  static async open(url: string) {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP websocket timeout')) }, TIMEOUT)
      socket.onopen = () => { clearTimeout(timer); resolve() }
      socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP websocket error')) }
    })
    return new Cdp(socket)
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate<T = any>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  close() { this.rejectPending('CDP closed'); this.socket.close() }
}

async function request(url: string, options: RequestInit = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) })
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url}: HTTP ${response.status}`)
  return response
}
async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await request(new URL(path, app).href, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return response.json() as Promise<T>
}
function assert(condition: unknown, label: string) {
  if (!condition) throw new Error(label)
  checked.push(label)
}
async function until(label: string, predicate: () => Promise<boolean>) {
  const deadline = Date.now() + TIMEOUT
  while (Date.now() < deadline) {
    if (await predicate()) return
    await pause(100)
  }
  throw new Error(`Timed out: ${label}`)
}

async function main() {
  const explicit = process.env.JARVIS_URL
  if (!explicit) throw new Error('JARVIS_URL must explicitly identify an isolated test server; there is no default')
  const url = new URL(explicit)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !url.port || url.port === '3081' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Refusing target: use an explicit http loopback origin with an isolated port (never live :3081)')
  }
  app = url.href
  const target = await (await request(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json() as { id: string; webSocketDebuggerUrl: string }
  let cdp: Cdp | undefined
  try {
    if (!target.id || !target.webSocketDebuggerUrl) throw new Error('Chrome did not return a debuggable target')
    cdp = await Cdp.open(target.webSocketDebuggerUrl)
    const browser = cdp
    const evaluate = <T = any>(expression: string) => browser.evaluate<T>(expression)
    const wait = (label: string, expression: string) => until(label, () => evaluate<boolean>(expression))
    const click = (selector: string) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled || !el.getClientRects().length) throw new Error('Unavailable control: ' + ${JSON.stringify(selector)}); el.click() })()`)
    const fill = (selector: string, value: string, event = 'input') => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })) })()`)
    const rows = '[...document.querySelectorAll("#history-list .history-row")]'
    const row = (title: string) => `${rows}.find(el => el.querySelector('strong')?.textContent === ${JSON.stringify(title)})`
    const history = async (query: string, archived = false) => {
      if (!await evaluate("document.querySelector('#history-dialog').open")) await click('#history-open')
      await fill('#history-search', query)
      await fill('#history-filter', String(archived), 'change')
      // Wait past the search debounce, then require a completed list response.
      await pause(350)
      await wait('history loaded', "!document.querySelector('#history-status').textContent.includes('加载') && document.querySelector('#history-retry').hidden")
    }
    const open = async (session: Session) => {
      await history(session.title, session.archived)
      await wait('matching history row', `Boolean(${row(session.title)})`)
      await evaluate(`${row(session.title)}.querySelector('.history-session').click()`)
      await wait('selected session snapshot', `localStorage.getItem('jarvis_selected_session') === ${JSON.stringify(session.id)} && document.querySelector('#session-title').textContent === ${JSON.stringify(session.title)}`)
    }
    const action = async (title: string, label: string) => {
      await evaluate(`(() => { const el = ${row(title)}; const button = [...(el?.querySelectorAll('.history-row-actions button') || [])].find(button => button.textContent === ${JSON.stringify(label)}); if (!button || button.disabled) throw new Error('Missing history action'); button.click() })()`)
    }
    const confirm = async () => { await wait('native confirmation opens', "document.querySelector('#history-confirm').open"); assert(await evaluate("document.querySelector('#history-confirm') instanceof HTMLDialogElement"), 'confirmation uses native dialog') }
    const snapshotMatches = async (session: Session) => {
      const saved = await api<Snapshot>(`/api/sessions/${session.id}`)
      await wait('persisted message IDs rendered', `JSON.stringify([...document.querySelectorAll('#transcript [data-message-id]')].map(el => Number(el.dataset.messageId))) === ${JSON.stringify(JSON.stringify(saved.messages.items.map(m => m.id)))}`)
      const rendered = await evaluate<string[]>("[...document.querySelectorAll('#transcript [data-message-id] .bubble')].map(el => el.textContent)")
      assert(saved.messages.items.length >= 2 && saved.messages.items.every((message, index) => rendered[index]?.includes(message.content)), 'selected persisted message content matches API')
      snapshots.push({ sessionId: session.id, messageIds: saved.messages.items.map(m => m.id), renderedMessages: rendered.length })
    }

    await browser.send('Page.enable')
    await browser.send('Runtime.enable')
    await browser.send('Log.enable')
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('jarvis_onboarded','1')" })
    const prefix = `session-smoke-${Date.now()}`
    const a = (await api('/api/sessions', 'POST', { title: `${prefix}-A` })).session as Session
    const b = (await api('/api/sessions', 'POST', { title: `${prefix}-B` })).session as Session
    for (const session of [a, b]) {
      await api('/api/chat', 'POST', { text: '/time', sessionId: session.id, turnId: crypto.randomUUID() })
      const saved = await api<Snapshot>(`/api/sessions/${session.id}`)
      assert(saved.messages.items.some(m => m.role === 'assistant' && m.content.trim()), 'API /time seeds a persisted assistant reply')
    }
    await browser.send('Page.navigate', { url: app })
    await wait('session UI boot', "Boolean(document.querySelector('#history-open') && document.querySelector('#session-title')?.textContent !== '加载对话…' && !document.querySelector('#send-btn').disabled)")
    await open(a)
    await snapshotMatches(a)
    await browser.send('Page.reload', { ignoreCache: true })
    await wait('refresh restores selected session', `document.querySelector('#session-title')?.textContent === ${JSON.stringify(a.title)} && localStorage.getItem('jarvis_selected_session') === ${JSON.stringify(a.id)}`)
    await snapshotMatches(a)
    checked.push('refresh restores selected session and persisted messages')

    await fill('#input', `${prefix} draft A`)
    await open(b)
    assert(await evaluate("document.querySelector('#input').value === ''"), 'switching does not leak another session draft')
    await fill('#input', `${prefix} draft B`)
    await open(a)
    assert(await evaluate(`document.querySelector('#input').value === ${JSON.stringify(`${prefix} draft A`)}`), 'draft A survives switching')
    await open(b)
    assert(await evaluate(`document.querySelector('#input').value === ${JSON.stringify(`${prefix} draft B`)}`), 'draft B survives switching')
    await click('#session-new')
    await wait('UI creates and selects session', `Boolean(localStorage.getItem('jarvis_selected_session')) && !${JSON.stringify([a.id, b.id])}.includes(localStorage.getItem('jarvis_selected_session')) && !document.querySelector('#send-btn').disabled`)
    const createdId = await evaluate<string>("localStorage.getItem('jarvis_selected_session')")
    assert((await api<Snapshot>(`/api/sessions/${createdId}`)).messages.items.length === 0, 'UI-created session is persisted and empty')

    await history(`${prefix}-A`)
    assert(await evaluate(`${rows}.length === 1 && Boolean(${row(a.title)})`), 'history title search narrows results')
    await history('/time')
    assert(await evaluate(`Boolean(${row(a.title)}) && Boolean(${row(b.title)})`), 'history searches persisted message content')
    await history(a.title)
    await action(a.title, '重命名')
    await confirm()
    const renamed = `${prefix}-renamed-` + '很长的标题'.repeat(12)
    await fill('#history-confirm-input', renamed)
    await click('#history-confirm-submit')
    await until('rename persisted', async () => (await api<Snapshot>(`/api/sessions/${a.id}`)).session.title === renamed)
    a.title = renamed
    await history(a.title)
    await open(a)
    await history(a.title)
    await action(a.title, '归档')
    await until('archive persisted', async () => (await api<Snapshot>(`/api/sessions/${a.id}`)).session.archived)
    a.archived = true
    await history(a.title)
    assert(await evaluate(`${rows}.length === 0`), 'archived session disappears from active history')
    await open(a)
    await wait('archived composer disabled', "document.querySelector('#send-btn').disabled")
    checked.push('archived session opens read-only')
    await history(a.title, true)
    await action(a.title, '取消归档')
    await until('unarchive persisted', async () => !(await api<Snapshot>(`/api/sessions/${a.id}`)).session.archived)
    a.archived = false
    await open(a)
    await wait('unarchived composer enabled', "!document.querySelector('#send-btn').disabled")
    checked.push('unarchive restores sending')

    for (const width of [320, 1440]) for (const theme of ['dark', 'light']) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 320 })
      await evaluate(`window.JarvisTheme.set(${JSON.stringify(theme)})`)
      await pause(300)
      assert(await evaluate(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`), `${theme} theme applied at ${width}px`)
      for (const surface of ['transcript', 'history', 'confirmation']) {
        if (surface === 'history') await history(a.title)
        if (surface === 'confirmation') { await action(a.title, '重命名'); await confirm() }
        const layout = await evaluate(`(() => {
          const selector = ${JSON.stringify(surface === 'transcript' ? '#transcript' : surface === 'history' ? '#history-dialog' : '#history-confirm')};
          const el = document.querySelector(selector); const r = el.getBoundingClientRect();
          return { width: innerWidth, pageOverflow: document.documentElement.scrollWidth - innerWidth, overflow: el.scrollWidth - el.clientWidth, left: r.left, right: r.right };
        })()`)
        snapshots.push({ theme, width, surface, ...layout })
        assert(layout.pageOverflow <= 1 && layout.overflow <= 1 && layout.left >= -1 && layout.right <= width + 1, `${surface} has no horizontal overflow: ${theme} ${width}px`)
      }
      await click('#history-confirm-cancel')
      await click('#history-close')
    }

    await history(b.title)
    await action(b.title, '删除')
    await confirm()
    await click('#history-confirm-cancel')
    assert((await api<Snapshot>(`/api/sessions/${b.id}`)).session.id === b.id, 'cancel delete preserves session')
    await history(b.title)
    await action(b.title, '删除')
    await confirm()
    await click('#history-confirm-submit')
    await until('delete persisted', async () => !(await api<{ items: Session[] }>('/api/sessions?limit=100')).items.some(s => s.id === b.id))
    checked.push('confirmed delete removes session')
    await history('')
    await click('#history-clear')
    await confirm()
    await click('#history-confirm-cancel')
    assert((await api<Snapshot>(`/api/sessions/${a.id}`)).session.id === a.id, 'cancel clear preserves sessions')
    await click('#history-clear')
    await confirm()
    await fill('#history-confirm-input', 'wrong')
    await click('#history-confirm-submit')
    assert(await evaluate("document.querySelector('#history-confirm').open && Boolean(document.querySelector('#history-confirm-error').textContent)"), 'clear requires exact confirmation phrase')
    assert((await api<Snapshot>(`/api/sessions/${a.id}`)).session.id === a.id, 'invalid clear confirmation preserves sessions')
    await fill('#history-confirm-input', 'DELETE ALL SESSIONS')
    await click('#history-confirm-submit')
    await until('clear removes all fixture sessions', async () => {
      const list = await api<{ items: Session[] }>('/api/sessions?limit=100')
      return !list.items.some(s => [a.id, b.id, createdId].includes(s.id)) && list.items.every(s => s.messageCount === 0)
    })
    await wait('clear selects usable empty session', `!${JSON.stringify([a.id, b.id, createdId])}.includes(localStorage.getItem('jarvis_selected_session')) && !document.querySelector('#send-btn').disabled`)
    checked.push('confirmed clear removes fixtures and restores usable empty session')
  } finally {
    if (cdp) { failures.push(...cdp.errors.map(error => `browser error: ${error}`)); cdp.close() }
    if (target.id) await request(`${CDP}/json/close/${target.id}`).catch(error => failures.push(`target cleanup: ${String(error)}`))
  }
}

void main().catch(error => { failures.push(error instanceof Error ? error.message : String(error)) }).finally(() => {
  console.log(JSON.stringify({ ok: failures.length === 0, url: app || process.env.JARVIS_URL || null, checked, snapshots, failures, streaming: 'not simulated; core CRUD and real persisted /time snapshots only' }, null, 2))
  if (failures.length) process.exitCode = 1
})
