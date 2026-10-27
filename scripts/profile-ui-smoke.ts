#!/usr/bin/env node
/**
 * Synthetic profile smoke against a parent-managed isolated server; never starts one.
 * Node 24: JARVIS_URL=http://127.0.0.1:<isolated-port> node scripts/profile-ui-smoke.ts
 * Chrome CDP defaults to http://127.0.0.1:9224; override JARVIS_CDP_URL.
 * Refuses live :3081, non-loopback origins, and nonempty profiles. No model calls.
 * Leaves synthetic fixtures for inspection; parent owns isolated data cleanup.
 */
const TIMEOUT = 12_000
const CDP = (process.env.JARVIS_CDP_URL || 'http://127.0.0.1:9224').replace(/\/+$/, '')
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const checked: string[] = [], failures: string[] = [], snapshots: unknown[] = []
let app = ''
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
type Entry = { id: string; memoryId: string; revision: number; field: string; value: any; content: string; subjectId: string; category: string; status: string; usage: string; scope: string }
type Snapshot = { entries: Entry[]; people: { id: string; name: string; relationship: string }[]; settings: { learningEnabled: boolean; useEnabled: boolean }; derived: { entryId: string; age?: number; zodiac?: string; sunSign?: string }[] }
class Cdp {
  socket: WebSocket
  nextId = 1
  pending = new Map<number, Pending>()
  errors: string[] = []
  logs: any[] = []
  responses: any[] = []
  expectedConflict = false
  conflicts: any[] = []
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
      else if (message.method === 'Network.responseReceived') {
        const response = { requestId: p.requestId, url: p.response.url, status: p.response.status }
        this.responses.push(response)
        if (response.status === 409 && this.expectedConflict && response.url === new URL('/api/profile/entries', app).href) this.conflicts.push(response)
        else if (response.status >= 400) this.errors.push(`Unexpected HTTP ${response.status}: ${response.url}`)
      } else if (message.method === 'Page.javascriptDialogOpening') {
        this.errors.push(`Unexpected JavaScript dialog: ${p.message}`)
        void this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
      }
    }
    socket.onclose = () => this.rejectPending('CDP socket closed')
  }
  rejectPending(reason: string) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)) }; this.pending.clear() }
  static async open(url: string) {
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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
  close() { this.rejectPending('CDP closed'); this.socket.close() }
}
async function request(url: string, options: RequestInit = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) })
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url}: unexpected HTTP ${response.status}: ${await response.text()}`)
  return response
}
async function api<T = any>(path = '', method = 'GET', body?: unknown): Promise<T> {
  return (await request(new URL(`/api/profile${path}`, app).href, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json() as Promise<T>
}
function assert(condition: unknown, label: string) { if (!condition) throw new Error(label); checked.push(label) }
async function until(label: string, predicate: () => Promise<boolean>) {
  const deadline = Date.now() + TIMEOUT
  while (Date.now() < deadline) { if (await predicate()) return; await pause(100) }
  throw new Error(`Timed out: ${label}`)
}
async function main() {
  if (!process.env.JARVIS_URL) throw new Error('JARVIS_URL must explicitly identify an isolated server; no default')
  const url = new URL(process.env.JARVIS_URL)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.port === '3081' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Refusing target: require explicit http loopback origin and isolated port, never live :3081')
  app = url.href
  const initial = await api<Snapshot>()
  assert(initial.entries.length === 0 && initial.people.length === 0, 'isolated profile is empty before synthetic fixtures')
  const target = await (await request(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json() as { id: string; webSocketDebuggerUrl: string }
  let cdp: Cdp | undefined
  try {
    cdp = await Cdp.open(target.webSocketDebuggerUrl)
    const browser = cdp, evaluate = <T = any>(expression: string) => browser.evaluate<T>(expression)
    const q = JSON.stringify
    const wait = (label: string, expression: string) => until(label, () => evaluate<boolean>(expression))
    const clickExpr = (expression: string) => evaluate(`(() => { const el = ${expression}; if (!el || el.disabled || !el.getClientRects().length) throw new Error('Unavailable control'); el.click() })()`)
    const click = (selector: string) => clickExpr(`document.querySelector(${q(selector)})`)
    const action = (scope: string, text: string) => clickExpr(`[...(${scope}).querySelectorAll('button')].find(el => el.textContent === ${q(text)})`)
    const root = "document.querySelector('#profile-dialog')", form = "document.querySelector('.profile-form')", confirm = "document.querySelector('.profile-confirm[open]')"
    const fill = (name: string, value: string) => evaluate(`(() => { const el = document.querySelector('.profile-form [name="${name}"]'); if (!el || el.disabled) throw new Error('Missing field ${name}'); el.value = ${q(value)}; el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles:true })) })()`)
    const saved = () => wait('save completes', "document.querySelector('.profile-editor').hidden && !document.querySelector('#profile-dialog').hasAttribute('aria-busy') && document.querySelector('.profile-status').textContent.includes('你可以修改')")
    const save = async () => { await action(form, '保存'); await saved() }
    const section = (title: string) => `[...document.querySelectorAll('.profile-section')].find(el => el.querySelector('h3')?.textContent === ${q(title)})`
    const card = (value: string) => `[...document.querySelectorAll('.profile-card')].find(el => el.querySelector('.profile-value')?.textContent === ${q(value)})`
    const entry = async (field: string, subjectId = 'self') => { const found = (await api<Snapshot>()).entries.find(e => e.field === field && e.subjectId === subjectId); if (!found) throw new Error(`Missing persisted ${field}`); return found }
    const add = async (field: string, value: string) => { await action(section('个人信息'), '添加'); await wait('entry form', "Boolean(document.querySelector('.profile-form [name=field]'))"); await fill('field', field); await fill('value', value); await save() }
    const edit = async (value: string) => { await action(card(value), '编辑'); await wait('edit form', "Boolean(document.querySelector('.profile-form'))") }
    const open = async () => { await click('#profile-open'); await wait('profile loaded', "document.querySelector('#profile-dialog').open && document.querySelector('.profile-status').textContent.includes('你可以修改')") }
    const prefix = `profile-smoke-${Date.now()}`
    const injection = `${prefix}<img src=x onerror="window.__profileInjected=1">`
    await browser.send('Page.enable'); await browser.send('Runtime.enable'); await browser.send('Log.enable'); await browser.send('Network.enable')
    await browser.send('Emulation.setDeviceMetricsOverride', { width:1440, height:960, deviceScaleFactor:1, mobile:false })
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source:"localStorage.setItem('jarvis_onboarded','1')" })
    await browser.send('Page.navigate', { url:app })
    await wait('profile module and app ready', "Boolean(document.querySelector('#profile-open') && document.querySelector('#profile-dialog') instanceof HTMLDialogElement && document.querySelector('#session-title')?.textContent !== '加载对话…' && document.querySelector('#send-btn') && !document.querySelector('#send-btn').disabled)")
    await open()
    assert(await evaluate(`${root} instanceof HTMLDialogElement`), 'profile uses native dialog')
    await add('gender', '合成测试性别')
    await add('city', `${prefix}合成城市甲`)
    const cityBefore = await entry('city')
    await edit(`${prefix}合成城市甲`); await fill('value', injection); await save()
    const city = await entry('city')
    assert(city.id === cityBefore.id && city.memoryId === cityBefore.memoryId && city.revision > cityBefore.revision && city.value === injection && city.content.includes(injection) && !city.content.includes('合成城市甲'), 'UI edit updates same canonical entry and API content')
    assert(await evaluate(`Boolean(${card(injection)}) && !document.querySelector('#profile-dialog img') && !window.__profileInjected`), 'HTML-like value renders literally without injection')
    await action(section('个人信息'), '添加'); await wait('birthday form', "Boolean(document.querySelector('.profile-form'))")
    await fill('field', 'birthday'); await fill('calendar', 'solar'); await fill('year', '2000'); await fill('month', '6'); await fill('day', '15'); await save()
    const birthday = await entry('birthday'), derived = (await api<Snapshot>()).derived.find(d => d.entryId === birthday.id)
    assert(birthday.value.calendar === 'solar' && birthday.value.year === 2000 && !!derived && typeof derived.age === 'number' && !!derived.zodiac && !!derived.sunSign, 'solar birthday persists and derives age, zodiac and sun sign')
    assert(await evaluate(`document.querySelector('.profile-derived').textContent.includes(${q(String(derived!.age))}) && document.querySelector('.profile-derived').textContent.includes(${q(derived!.zodiac)}) && document.querySelector('.profile-derived').textContent.includes(${q(derived!.sunSign)}) && document.querySelector('.profile-derived').textContent.includes('只读')`), 'derived birthday values are displayed read-only')
    await action(section('家人与重要的人'), '添加人物'); await wait('person form', "Boolean(document.querySelector('.profile-form [name=name]'))")
    await fill('name', `${prefix}合成家人`); await fill('relationship', '合成家人'); await save()
    const person = (await api<Snapshot>()).people.find(p => p.name === `${prefix}合成家人`)!
    assert(!!person, 'UI creates family person')
    const personBox = `[...document.querySelectorAll('.profile-person')].find(el => el.querySelector('h4').textContent === ${q(person.name)})`
    await action(personBox, '添加资料'); await wait('family form', "Boolean(document.querySelector('.profile-form [name=field]'))")
    await fill('field', 'birthday'); await fill('calendar', 'lunar'); await fill('month', '8'); await fill('day', '15'); await save()
    const lunar = await entry('birthday', person.id)
    assert(lunar.value.calendar === 'lunar' && lunar.value.month === 8 && lunar.value.day === 15 && lunar.usage === 'local', 'family lunar birthday persists with local-only default')
    assert(await evaluate(`${personBox}.textContent.includes('农历 8月15日')`), 'family lunar birthday displayed under correct person')
    await action(card(injection), '查看来源'); await wait('source result', "document.querySelector('.profile-source[open] .profile-source-text')?.textContent.includes('原始来源暂不可用')")
    assert(!(await api(`/entries/${city.id}/source`)).available, 'manual entry source honestly reports unavailable')
    await action("document.querySelector('.profile-source[open]')", '关闭')
    const proposal = (await api('/entries', 'POST', { category:'understanding', field:'understanding', value:`${prefix}待纠正理解`, status:'proposed', usage:'local' })).entry as Entry
    await action(root, '关闭'); await open()
    await action(card(String(proposal.value)), '纠正 / 确认'); await wait('correction form', "Boolean(document.querySelector('.profile-form'))")
    await fill('value', `${prefix}直接纠正后的理解`); await fill('status', 'confirmed'); await save()
    const corrected = (await api<Snapshot>()).entries.find(e => e.id === proposal.id)!
    assert(corrected.status === 'confirmed' && corrected.value === `${prefix}直接纠正后的理解` && corrected.content === corrected.value, 'direct understanding correction confirms canonical text')
    const beforeSettings = (await api<Snapshot>()).settings
    assert(beforeSettings.learningEnabled, 'isolated fixture begins with learning enabled')
    await click('.profile-switch input')
    await until('single toggle pauses learning', async () => !(await api<Snapshot>()).settings.learningEnabled)
    await wait('settings refresh', "!document.querySelector('#profile-dialog').hasAttribute('aria-busy') && !document.querySelector('.profile-switch input').checked")
    assert((await api<Snapshot>()).settings.useEnabled === beforeSettings.useEnabled, 'one pause toggle preserves independent answer-use setting')
    await edit(String(corrected.value)); await fill('status', 'inactive'); await save()
    assert((await api<Snapshot>()).entries.find(e => e.id === corrected.id)?.status === 'inactive' && await evaluate(`${card(String(corrected.value))}.classList.contains('profile-inactive')`), 'inactive status persists and displays')
    await edit(injection); const draft = `${prefix}未保存草稿`; await fill('value', draft)
    await action(root, '关闭'); await wait('dirty close confirmation', "Boolean(document.querySelector('.profile-confirm[open]'))")
    await action(confirm, '保留草稿并关闭'); await wait('profile closes', "!document.querySelector('#profile-dialog').open")
    await click('#profile-open'); await wait('draft reopened', `document.querySelector('.profile-form [name=value]')?.value === ${q(draft)}`)
    assert(await evaluate("document.querySelector('.profile-status').textContent.includes('已保留')"), 'dirty close/reopen preserves unsaved draft')
    const external = `${prefix}外部更新`
    await api('/entries', 'POST', { id:city.id, expectedRevision:city.revision, category:city.category, field:city.field, value:external, usage:city.usage, status:city.status, scope:city.scope })
    browser.expectedConflict = true
    await action(form, '保存')
    await wait('stale revision message', "document.querySelector('.profile-status').textContent.includes('已在别处更新') && !document.querySelector('#profile-dialog').hasAttribute('aria-busy')")
    await until('one intentional conflict response', async () => browser.conflicts.length === 1)
    browser.expectedConflict = false
    assert(await evaluate(`document.querySelector('.profile-form [name=value]').value === ${q(draft)} && !document.querySelector('.profile-form [name=value]').disabled`), 'stale 409 preserves editable draft')
    assert((await entry('city')).value === external, 'stale draft does not overwrite external canonical update')
    await action("document.querySelector('.profile-status')", '重新载入'); await wait('reload confirmation', "Boolean(document.querySelector('.profile-confirm[open]'))")
    await action(confirm, '放弃修改并载入'); await saved()
    for (const width of [320, 1440]) for (const theme of ['dark', 'light']) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height:900, deviceScaleFactor:1, mobile:width === 320 })
      await evaluate(`window.JarvisTheme.set(${q(theme)})`); await pause(150)
      assert(await evaluate(`document.documentElement.dataset.theme === ${q(theme)}`), `${theme} applied at ${width}px`)
      const layout = async (surface: string, selector: string) => {
        const result = await evaluate(`(() => { const el = document.querySelector(${q(selector)}), r = el.getBoundingClientRect(); return { pageOverflow:document.documentElement.scrollWidth-innerWidth, overflow:el.scrollWidth-el.clientWidth, left:r.left, right:r.right, width:innerWidth } })()`)
        snapshots.push({ surface, theme, width, ...result })
        assert(result.pageOverflow <= 1 && result.overflow <= 1 && result.left >= -1 && result.right <= result.width + 1, `${surface} no horizontal overflow: ${theme} ${width}px`)
      }
      await action(root, '关闭'); await layout('header', '.topbar'); await open(); await layout('profile', '#profile-dialog')
      await edit(external); await layout('editor', '.profile-editor')
      await action(form, '删除'); await wait('delete confirm', "Boolean(document.querySelector('.profile-confirm[open]'))"); await layout('confirmation', '.profile-confirm[open]')
      await action(confirm, '取消'); await action(form, '取消')
      await action(card(external), '查看来源'); await wait('source dialog', "Boolean(document.querySelector('.profile-source[open]'))"); await layout('source', '.profile-source[open]'); await action("document.querySelector('.profile-source[open]')", '关闭')
    }
    await edit(external); await action(form, '删除'); await wait('delete cancellation', "Boolean(document.querySelector('.profile-confirm[open]'))"); await action(confirm, '取消')
    assert((await entry('city')).id === city.id, 'cancel delete preserves canonical entry')
    await action(form, '删除'); await wait('delete confirmation', "Boolean(document.querySelector('.profile-confirm[open]'))")
    assert(await evaluate(`${confirm} instanceof HTMLDialogElement`), 'delete confirmation uses native dialog')
    await action(confirm, '删除资料'); await saved()
    assert(!(await api<Snapshot>()).entries.some(e => e.id === city.id), 'confirmed delete removes entry from API')
    assert(!await evaluate(`Boolean(${card(external)})`), 'deleted entry disappears from UI')
    await action(root, '关闭')
    await pause(200)
    assert(browser.conflicts.length === 1, 'exactly one intentional HTTP 409 observed')
  } finally {
    if (cdp) {
      const expectedIds = new Set(cdp.conflicts.map(r => r.requestId))
      // Chrome reports HTTP failures in Log as well as Network. Exempt only the
      // specific request ID and 409 status, never generic network errors or 500s.
      for (const log of cdp.logs) if (!(expectedIds.has(log.networkRequestId) && /\b409\b/.test(log.text))) cdp.errors.push(log.text)
      snapshots.push({ intentional409:cdp.conflicts, httpErrors:cdp.responses.filter(r => r.status >= 400), browserErrorLogs:cdp.logs })
      failures.push(...cdp.errors.map(error => `browser error: ${error}`)); cdp.close()
    }
    if (target.id) await request(`${CDP}/json/close/${target.id}`).catch(error => failures.push(`target cleanup: ${String(error)}`))
  }
}
void main().catch(error => failures.push(error instanceof Error ? error.message : String(error))).finally(() => {
  console.log(JSON.stringify({ ok:failures.length === 0, url:app || process.env.JARVIS_URL || null, checked, snapshots, failures, fixtures:'synthetic only; isolated server and cleanup owned by parent; no model calls' }, null, 2))
  if (failures.length) process.exitCode = 1
})
