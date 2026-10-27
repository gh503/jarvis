#!/usr/bin/env node
/** Nine-page settings regression. Parent must start isolated :3097; never starts a server.
 * Node 24: JARVIS_URL=http://127.0.0.1:3097 node scripts/settings-pages-ui-smoke.ts
 * Real localhost API only. Voice 409 is the sole mocked response. No synthesis,
 * recognition, model generation, MCP calls, or account credentials are used.
 */
const TIMEOUT = 15000
const checked: string[] = []
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function origin(value: string, app = false) {
  const u = new URL(value)
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || !u.port || u.port === '3081' || (app && u.port !== '3097') || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Require explicit isolated HTTP loopback :3097 app and local CDP; :3081 forbidden')
  return u.origin
}
const APP = origin(process.env.JARVIS_URL || 'http://127.0.0.1:3097', true)
const CDP = origin(process.env.JARVIS_CDP_URL || 'http://127.0.0.1:9223')
function check(value: unknown, label: string) { if (!value) throw new Error(label); checked.push(label) }
async function request(url: string, options: RequestInit = {}) {
  const r = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) })
  if (!r.ok) throw new Error(`${options.method || 'GET'} ${new URL(url).pathname}: HTTP ${r.status}`)
  return r
}
async function api(path: string, body?: unknown) { return (await request(APP + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() }
class Browser {
  id = 0
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  errors: string[] = []
  writes: { path: string; body: any }[] = []
  dialogs = 0
  acceptDialog = false
  holdVoice = false
  held = ''
  conflictVoice = false
  readonly ws: WebSocket
  constructor(ws: WebSocket) {
    this.ws = ws
    ws.onmessage = event => {
      const m = JSON.parse(String(event.data)), p = m.params
      if (m.id) { const w = this.pending.get(m.id); if (!w) return; clearTimeout(w.timer); this.pending.delete(m.id); m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); return }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text)
      if (m.method === 'Page.javascriptDialogOpening') { this.dialogs++; void this.send('Page.handleJavaScriptDialog', { accept: this.acceptDialog }) }
      if (m.method === 'Fetch.requestPaused') {
        const u = new URL(p.request.url)
        if (u.origin !== APP) { this.errors.push('Blocked request outside isolated app'); void this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }); return }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(p.request.method)) this.writes.push({ path: u.pathname, body: p.request.postData ? JSON.parse(p.request.postData) : null })
        if (u.pathname === '/api/voice/apply' && p.request.method === 'POST') {
          if (this.holdVoice) { this.held = p.requestId; return }
          if (this.conflictVoice) { void this.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 409, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: 'synthetic settings conflict; reload before retry' })).toString('base64') }); return }
        }
        void this.send('Fetch.continueRequest', { requestId: p.requestId })
      }
    }
  }
  static async open(url: string) {
    const u = new URL(url)
    if (u.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.port === '3081') throw new Error('Nonlocal CDP websocket rejected')
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new Error('CDP connect timeout')), TIMEOUT); ws.onopen = () => { clearTimeout(t); resolve() }; ws.onerror = () => { clearTimeout(t); reject(new Error('CDP connection error')) } })
    return new Browser(ws)
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, TIMEOUT); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval<T = any>(expression: string): Promise<T> { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value }
  async wait(label: string, predicate: () => Promise<boolean>) { const end = Date.now() + TIMEOUT; while (Date.now() < end) { if (await predicate()) return; await pause(100) }; throw new Error(`Timeout: ${label}`) }
  click(selector: string) { return this.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); if(!e || e.disabled || !e.getClientRects().length) throw new Error('Unavailable control: '+${JSON.stringify(selector)}); e.click()})()`) }
  fill(selector: string, value: string) { return this.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}))})()`) }
  async tab(name: string) { await this.click(`[data-settings-tab="${name}"]`); await this.wait(name, () => this.eval(`document.querySelector('#settings-panel-${name}')?.hidden === false`)) }
  close() { for (const w of this.pending.values()) { clearTimeout(w.timer); w.resolve({}) }; this.pending.clear(); this.ws.close() }
}
async function main() {
  const initialModel = await api('/api/model')
  const initialVoice = await api('/api/voice')
  const settings = initialModel.settings || initialModel
  const restoreScenario = { scenarios: settings.scenarios, scenarioAuto: settings.scenarioAuto, defaultScenario: settings.defaultScenario }
  const target = await (await request(CDP + '/json/new?about:blank', { method: 'PUT' })).json() as { id: string; webSocketDebuggerUrl: string }
  let b: Browser | undefined, scenarioWritten = false
  try {
    b = await Browser.open(target.webSocketDebuggerUrl)
    const browser = b
    await b.send('Page.enable'); await b.send('Runtime.enable'); await b.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('jarvis_onboarded','1')" })
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
    await b.send('Page.navigate', { url: APP })
    await b.wait('initialized shell', () => browser.eval("Boolean(document.querySelector('#settings-btn')) && document.querySelectorAll('#scenario-select option').length > 1"))
    await b.click('#settings-btn')
    await b.wait('settings loaded', () => browser.eval("Boolean(document.querySelector('#asr-save') && document.querySelector('#scenario-save'))"))
    const tabs = ['model', 'scenario', 'tts', 'asr', 'tools', 'mcp', 'appearance', 'access', 'system']
    check(JSON.stringify(await b.eval("[...document.querySelectorAll('[data-settings-tab]')].map(e=>e.dataset.settingsTab)")) === JSON.stringify(tabs), 'exact nine navigation pages in order')
    check(await b.eval("!document.querySelector('#settings-panel-model #scenario-card') && !!document.querySelector('#settings-panel-scenario #scenario-save')"), 'model excludes scenario editor; scenario owns save')
    for (const kind of ['tts', 'asr']) check(await b.eval(`!!document.querySelector('#settings-panel-${kind} #voice-chain-${kind}') && !document.querySelector('#settings-panel-${kind} #voice-chain-${kind === 'tts' ? 'asr' : 'tts'}')`), `${kind} owns only its chain`)
    for (const [tab, selector] of [['tools', '#settings-tools-host .lt-inline'], ['mcp', '#settings-mcp-host .mcp-services-inline']]) {
      await b.tab(tab)
      await b.wait(`${tab} inline editor`, () => browser.eval(`Boolean(document.querySelector(${JSON.stringify(selector)})?.querySelector('input,select,textarea,button'))`))
      check(await b.eval("document.querySelectorAll('dialog[open]').length === 0"), `${tab} actual inline controls without secondary dialog`)
    }
    for (const width of [320, 1440]) for (const theme of ['dark', 'light']) {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: width < 500 })
      await b.eval(`window.JarvisTheme.set('${theme}')`)
      for (const tab of tabs) {
        await b.tab(tab)
        await pause(60)
        const layout = await b.eval("({ viewport:innerWidth, document:document.documentElement.scrollWidth, modal:document.querySelector('.settings-modal').getBoundingClientRect().width, panel:document.querySelector('#settings-panel-'+document.querySelector('[data-settings-tab][aria-selected=true]').dataset.settingsTab).scrollWidth, body:document.querySelector('.settings-modal .modal-body').clientWidth })")
        check(layout.document <= layout.viewport+1 && layout.modal <= layout.viewport+1 && layout.panel <= layout.body+1, `${theme} ${width}px ${tab}: no page/content horizontal overflow ${JSON.stringify(layout)}`)
      }
      check(await b.eval("[...document.querySelectorAll('[data-settings-tab]')].every(e=>e.getBoundingClientRect().width>0)"), `${theme} ${width}px all navigation tabs remain laid out`)
      if (width === 320) check(await b.eval("(() => {const n=document.querySelector('.settings-tabs'); return ['auto','scroll'].includes(getComputedStyle(n).overflowX) && n.scrollWidth>n.clientWidth && n.getAttribute('aria-orientation')==='horizontal'})()"), `${theme} mobile navigation clips and scrolls naturally`)
    }
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
    await b.tab('scenario')
    await b.eval("document.querySelector('[data-scenario]').open=true")
    const scenarioSelector = '[data-scenario] .scenario-extra'
    await b.fill(scenarioSelector, 'Synthetic isolated settings smoke prompt')
    await b.tab('model'); await b.tab('scenario')
    check(await b.eval(`document.querySelector('${scenarioSelector}').value === 'Synthetic isolated settings smoke prompt'`), 'scenario draft preserved across tabs')
    const beforeDialogs = b.dialogs
    await b.eval("setTimeout(()=>document.querySelector('#modal-close').click(),0)")
    await b.wait('discard confirmation rejected', async () => browser.dialogs > beforeDialogs)
    check(await b.eval("!document.querySelector('#modal').hidden"), 'rejecting discard confirmation leaves settings open')
    scenarioWritten = true
    await b.click('#scenario-save')
    await b.wait('scenario save', () => browser.eval("document.querySelector('#scenario-result').classList.contains('ok')"))
    const saved = await api('/api/model')
    check((saved.settings || saved).scenarios.some((s: any) => s.systemExtra === 'Synthetic isolated settings smoke prompt'), 'scenario synthetic prompt persisted through real API')
    await api('/api/model/scenarios', restoreScenario)
    const restored = (await api('/api/model')).settings
    check(JSON.stringify({ scenarios: restored.scenarios, scenarioAuto: restored.scenarioAuto, defaultScenario: restored.defaultScenario }) === JSON.stringify(restoreScenario), 'scenario persisted settings restored exactly')
    scenarioWritten = false
    await b.tab('asr'); await b.click('[data-voice-edit="asr"]')
    await b.fill('#asr-label', 'Synthetic unsaved ASR draft')
    await b.tab('tts'); await b.click('[data-voice-edit="tts"]')
    const ttsLabel = await b.eval<string>("document.querySelector('#tts-label').value")
    await b.fill('#tts-label', ttsLabel)
    b.holdVoice = true
    await b.click('#tts-save')
    await b.wait('held voice request', async () => Boolean(browser.held))
    const writesAtHold = b.writes.length
    await b.tab('asr')
    check(await b.eval("document.querySelector('#asr-label').value === 'Synthetic unsaved ASR draft' && document.querySelector('#asr-save').disabled"), 'switching during voice save preserves draft and disables other save')
    check(b.writes.length === writesAtHold, 'busy tab switch makes no mutation request')
    const voiceWrite = b.writes.filter(w => w.path === '/api/voice/apply').at(-1)!
    check(JSON.stringify(Object.keys(voiceWrite.body)) === '["tts"]', 'TTS save payload contains only TTS chain')
    b.holdVoice = false
    await b.send('Fetch.continueRequest', { requestId: b.held }); b.held = ''
    await b.wait('real TTS save', () => browser.eval("document.querySelector('#tts-result').classList.contains('ok')"))
    check(await b.eval("document.querySelector('#asr-label').value === 'Synthetic unsaved ASR draft' && !document.querySelector('#asr-dirty').hidden"), 'successful TTS save leaves ASR draft untouched')
    b.conflictVoice = true
    await b.click('#asr-save')
    await b.wait('voice 409 feedback', () => browser.eval("document.querySelector('#asr-result').classList.contains('bad')"))
    check(await b.eval("document.querySelector('#asr-label').value === 'Synthetic unsaved ASR draft' && !document.querySelector('#asr-dirty').hidden"), '409 preserves unsaved ASR draft with visible failure')
    check(JSON.stringify(Object.keys(b.writes.filter(w => w.path === '/api/voice/apply').at(-1)!.body)) === '["asr"]', 'ASR save payload contains only ASR chain')
    check(JSON.stringify((await api('/api/voice')).settings) === JSON.stringify(initialVoice.settings), 'voice persisted settings unchanged after real unchanged TTS save and ASR conflict')
    const writesBeforeInline = b.writes.length
    await b.tab('tools')
    const toolsSelector = '#settings-tools-host textarea'
    const toolsBefore = await b.eval<string>(`document.querySelector('${toolsSelector}').value`)
    await b.fill(toolsSelector, '/tmp/synthetic-unsaved-settings-grant')
    await b.tab('mcp')
    await b.eval("[...document.querySelectorAll('#settings-mcp-host .mcp-services-card')].find(e=>e.textContent.includes('和风')).querySelector('.mcp-services-actions button').click()")
    const passwordSelector = '#settings-mcp-host input[type=password]'
    await b.fill(passwordSelector, 'synthetic-unsaved-credential')
    await b.tab('model'); await b.tab('tools')
    check(await b.eval(`document.querySelector('${toolsSelector}').value === '/tmp/synthetic-unsaved-settings-grant'`), 'inline tools draft survives tab switches')
    await b.tab('mcp')
    check(await b.eval(`document.querySelector('${passwordSelector}').value === 'synthetic-unsaved-credential'`), 'inline MCP credential draft survives tab switches')
    const inlineDialogs = b.dialogs
    await b.eval("setTimeout(()=>document.querySelector('#modal-close').click(),0)")
    await b.wait('inline discard rejected', async () => browser.dialogs > inlineDialogs)
    check(await b.eval(`!document.querySelector('#modal').hidden && document.querySelector('${passwordSelector}').value === 'synthetic-unsaved-credential'`), 'rejecting close preserves inline credential draft')
    b.acceptDialog = true
    await b.eval("setTimeout(()=>document.querySelector('#modal-close').click(),0)")
    await b.wait('confirmed close', () => browser.eval("document.querySelector('#modal').hidden"))
    await b.click('#settings-btn')
    await b.wait('settings reopened', () => browser.eval("Boolean(document.querySelector('[data-settings-tab=tools]')?.getClientRects().length)"))
    await b.tab('tools')
    await b.wait('tools remounted', () => browser.eval(`Boolean(document.querySelector('${toolsSelector}'))`))
    check(await b.eval(`document.querySelector('${toolsSelector}').value === ${JSON.stringify(toolsBefore)}`), 'confirmed close discards inline tools draft')
    await b.tab('mcp')
    await b.wait('MCP remounted', () => browser.eval("document.querySelectorAll('#settings-mcp-host .mcp-services-card').length>0"))
    check(await b.eval(`!document.querySelector('${passwordSelector}')`), 'confirmed close clears inline credential editor')
    const reopenWrites = b.writes.slice(writesBeforeInline)
    check(reopenWrites.every(w => w.path === '/api/model/list' || w.path.startsWith('/api/local-tools') || w.path.startsWith('/api/mcp')), `reopen requests limited to model discovery: ${reopenWrites.map(w => w.path).join(', ')}`)
    const inlineWrites = reopenWrites.filter(w => w.path.startsWith('/api/local-tools') || w.path.startsWith('/api/mcp'))
    check(inlineWrites.length === 0, `inline draft switching and discard never persist grants or credentials (${inlineWrites.map(w => w.path).join(', ')})`)
    check(b.errors.length === 0, `no uncaught browser errors or external requests (${b.errors.join('; ')})`)
  } finally {
    if (b?.held) await b.send('Fetch.failRequest', { requestId: b.held, errorReason: 'Aborted' }).catch(() => {})
    if (scenarioWritten) await api('/api/model/scenarios', restoreScenario)
    b?.close()
    await request(`${CDP}/json/close/${target.id}`).catch(() => {})
  }
  console.log(JSON.stringify({ ok: true, url: APP, checked }, null, 2))
}
void main().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message, checked }, null, 2)); process.exitCode = 1 })
