#!/usr/bin/env node
/**
 * Browser smoke test over the Chrome DevTools Protocol.
 *
 * No Playwright/Chromium download: it drives the Chrome already installed on
 * the desktop. Start Chrome with `--remote-debugging-port=9223`, then run:
 *
 *   npm run ui:smoke
 *
 * It opens an isolated tab, checks the main shell, settings/privacy, brief,
 * Studio config and a 390 px layout, then closes the tab. It does not send a
 * conversation or mutate memory.
 */
const CDP = (process.env.JARVIS_CDP_URL || 'http://127.0.0.1:9223').replace(/\/+$/, '')
/** Interaction checks that write to the server are opt-in so a developer can
 * run the smoke against the live instance without changing real settings. */
const WRITE = process.env.JARVIS_SMOKE_WRITE === '1'

const CONTRAST_AUDIT = `(() => {
  const parse = value => {
    const m = String(value).match(/rgba?\\(([^)]+)\\)/)
    if (!m) return null
    const parts = m[1].split(/[, /]+/).filter(Boolean).map(Number)
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] }
  }
  const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })
  const bgOf = el => {
    const stack = []
    let node = el
    while (node && node !== document.documentElement) { stack.push(node); node = node.parentElement }
    let result = { r: 8, g: 11, b: 15, a: 1 }
    for (const item of stack.reverse()) {
      const c = parse(getComputedStyle(item).backgroundColor)
      if (c && c.a > 0) result = blend(c, result)
    }
    return result
  }
  const bad = []
  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.15) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2 || el.closest('[hidden]')) continue
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1)
    if (!own) continue
    const fg = parse(style.color)
    if (!fg) continue
    const bg = bgOf(el)
    const fgc = fg.a < 1 ? blend(fg, bg) : fg
    const L1 = lum(fgc), L2 = lum(bg)
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
    const size = parseFloat(style.fontSize)
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700)
    if (ratio < (large ? 3 : 4.5)) bad.push(((el.textContent || '').trim().slice(0, 20)) + ' @' + ratio.toFixed(2))
  }
  return { bad: bad.slice(0, 6), count: bad.length, overflow: document.documentElement.scrollWidth - window.innerWidth }
})()`

const APP = (process.env.JARVIS_URL || 'http://127.0.0.1:3081/').replace(/\/+$/, '') + '/'
const TIMEOUT = 15_000

class Cdp {
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  readonly errors: string[] = []
  readonly dialogs: string[] = []

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = event => {
      let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown> }
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message.id) {
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        this.pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error.message || 'CDP error'))
        else waiter.resolve(message.result)
        return
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const detail = (message.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } })?.exceptionDetails
        this.errors.push(detail?.exception?.description || detail?.text || 'uncaught exception')
      }
      if (message.method === 'Page.javascriptDialogOpening') {
        const params = message.params as { message?: string; type?: string }
        // A native confirm() blocks the renderer, which makes the next
        // Runtime.evaluate time out. Accept it and remember what was asked.
        this.dialogs.push(`${params.type || 'dialog'}: ${params.message || ''}`)
        void this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined)
      }
      if (message.method === 'Log.entryAdded') {
        const entry = (message.params as { entry?: { level?: string; text?: string; url?: string } })?.entry
        if (entry?.level === 'error') this.errors.push(`${entry.text || 'log error'}${entry.url ? ` @ ${entry.url}` : ''}`)
      }
    }
  }

  static async open(url: string): Promise<Cdp> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket timeout')), 5000)
      socket.onopen = () => { clearTimeout(timer); resolve() }
      socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP websocket error')) }
    })
    return new Cdp(socket)
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method} ${String((params as { expression?: string }).expression ?? '').slice(0, 160)}`))
      }, TIMEOUT).unref()
    })
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }) as {
      result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } }
    }
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || 'page evaluation failed'
      throw new Error(`${detail}\n  in: ${expression.slice(0, 160)}`)
    }
    return result.result?.value as T
  }

  close(): void {
    try { this.socket.close() } catch { /* already closed */ }
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const failures: string[] = []
function check(condition: boolean, label: string): void {
  if (!condition) failures.push(label)
}

async function main(): Promise<void> {
  let target: { id?: string; webSocketDebuggerUrl?: string }
  try {
    const response = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })
    if (!response.ok) throw new Error(`CDP returned ${response.status}`)
    target = await response.json() as typeof target
  } catch (error) {
    throw new Error(`cannot open Chrome tab at ${CDP}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!target.id || !target.webSocketDebuggerUrl) throw new Error('Chrome did not return a debuggable target')
  const cdp = await Cdp.open(target.webSocketDebuggerUrl)
  try {
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "try { localStorage.setItem('jarvis_onboarded','1') } catch {}" })
    await cdp.send('Page.navigate', { url: APP })
    await sleep(2600)

    check((await cdp.evaluate<string>('document.title')).includes('Jarvis'), 'home: title')
    check(await cdp.evaluate<boolean>("Boolean(document.querySelector('#input') && document.querySelector('#mic-btn'))"), 'home: composer and mic')
    check(await cdp.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'home: no horizontal overflow')
    // Regression: the composer scenario selector must be populated at boot,
    // not only after the settings modal has been opened once.
    await sleep(1200)
    check(await cdp.evaluate<boolean>("document.querySelectorAll('#scenario-select option').length > 1"), 'home: scenario selector populated before opening settings')
    // Regression: line-style SVG icons must declare stroke; fill:currentColor alone renders nothing.
    check(await cdp.evaluate<boolean>(`[...document.querySelectorAll('svg path[d*="m6 6"], svg path[d*="M12 2v3"], svg path[d*="M4 7h16"]')].every(el => el.closest('svg').hasAttribute('stroke'))`), 'icons: stroke icons carry stroke attributes')

    await cdp.evaluate("document.querySelector('#settings-btn').click()")
    await sleep(900)
    const settings = await cdp.evaluate<{ open: boolean; privacy: boolean; devices: boolean; onboarding: boolean; modelSelect: boolean; protocols: boolean; voice: boolean; adapters: boolean; pool: boolean; scenarioSelect: boolean; tabs: number; tabbed: boolean }>(`({
      open: !document.querySelector('#modal').hidden,
      privacy: Boolean(document.querySelector('#privacy-export') && document.querySelector('#privacy-erase')),
      devices: Boolean(document.querySelector('#device-list')),
      onboarding: Boolean(document.querySelector('#onboard-again')),
      modelSelect: document.querySelector('#model-name')?.tagName === 'SELECT',
      protocols: Boolean(document.querySelector('#model-protocol') || document.querySelector('[data-model-select=remote]')),
      voice: Boolean(document.querySelector('#voice-chain-asr') && document.querySelector('#voice-chain-tts') && document.querySelector('#voice-save') && document.querySelectorAll('[data-voice-add]').length === 2),
      adapters: Boolean(document.querySelector('#provider-add-card') && document.querySelector('#scenario-card')),
      pool: Boolean(document.querySelector('#provider-add-card') && document.querySelector('#scenario-card') && document.querySelector('#scenario-save')),
      scenarioSelect: Boolean(document.querySelector('#scenario-select')),
      tabs: document.querySelectorAll('[data-settings-tab]').length,
      tabbed: Boolean(document.querySelector('#settings-panel-model') && document.querySelector('.settings-modal'))
    })`)
    check(settings.open, 'settings: modal opens')
    check(settings.privacy, 'settings: privacy controls')
    check(settings.devices, 'settings: device list')
    check(settings.onboarding, 'settings: onboarding replay')
    check(settings.modelSelect, 'settings: model list is a selector')
    check(settings.protocols, 'settings: three LLM protocols')
    check(settings.voice, 'settings: ASR/TTS priority chains with add buttons')
    check(settings.adapters, 'settings: provider pool card still present')
    check(settings.pool, 'settings: provider pool + scenario card')
    check(settings.scenarioSelect, 'composer: scenario selector')
    await cdp.evaluate("document.querySelector('[data-settings-tab=\"appearance\"]').click()")
    await sleep(400)
    check(await cdp.evaluate<boolean>("Boolean(document.querySelector('#appearance-card') && document.querySelectorAll('.appearance-swatch').length === 5 && document.querySelectorAll('.appearance-preset').length >= 4)"), 'settings: appearance tab with swatches and presets')
    check(await cdp.evaluate<boolean>("document.querySelector('#settings-panel-appearance')?.hidden === false"), 'settings: appearance panel actually visible after tab click')
    check(settings.tabs === 5 && settings.tabbed, 'settings: five-section tabbed layout (incl. appearance)')
    await cdp.evaluate("document.querySelector('[data-settings-tab=voice]').click()")
    await sleep(200)
    check(await cdp.evaluate<boolean>("!document.querySelector('#settings-panel-voice').hidden && document.querySelector('#settings-panel-model').hidden"), 'settings: voice tab switches panel')
    await cdp.evaluate("document.querySelector('[data-settings-tab=system]').click()")
    await sleep(200)
    check(await cdp.evaluate<boolean>("document.querySelector('#settings-panel-system').offsetParent !== null && document.querySelector('#settings-panel-system').getBoundingClientRect().height > 0"), 'settings: system panel visible')
    await cdp.evaluate("document.querySelector('[data-settings-tab=model]').click()")
    await sleep(200)
    if (WRITE) {
      // Theme: the header button cycles dark -> light -> auto, and the
      // document reflects it immediately.
      const themeBefore = await cdp.evaluate<string>("document.documentElement.dataset.themeMode")
      await cdp.evaluate("document.querySelector('#theme-btn').click()")
      await sleep(250)
      const themeAfter = await cdp.evaluate<string>("document.documentElement.dataset.themeMode")
      check(themeBefore !== themeAfter, 'theme: header button changes the mode')
      // One click already moved off the start mode; two more complete the cycle.
      for (let index = 0; index < 2; index += 1) {
        await cdp.evaluate("document.querySelector('#theme-btn').click()")
        await sleep(120)
      }
      check(await cdp.evaluate<string>("document.documentElement.dataset.themeMode") === themeBefore, 'theme: cycling three times returns to the start')

      // Accent colour must repaint both CSS channels (this regressed once:
      // only --accent-h moved while rgb(var(--accent-rgb)) stayed teal).
      await cdp.evaluate("document.querySelector('[data-settings-tab=\"appearance\"]').click()")
      await sleep(300)
      const accentBefore = await cdp.evaluate<string>("getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()")
      await cdp.evaluate("document.querySelectorAll('.appearance-swatch')[4].click()")
      await sleep(700)
      const accentAfter = await cdp.evaluate<string>("getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()")
      check(accentBefore !== accentAfter, 'appearance: accent swatch repaints --accent-rgb')
      await cdp.evaluate("document.querySelector('#appearance-reset').click()")
      await sleep(900)
      check(await cdp.evaluate<string>("getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()") === accentBefore, 'appearance: reset restores the accent')

      // Provider priority: the up arrow reorders cards and persists.
      await cdp.evaluate("document.querySelector('[data-settings-tab=model]').click()")
      await sleep(300)
      const orderBefore = await cdp.evaluate<string[]>("[...document.querySelectorAll('[data-model-card]')].map(el => el.dataset.modelCard)")
      if (orderBefore.length >= 2) {
        await cdp.evaluate("document.querySelectorAll('[data-model-down]')[0].click()")
        await sleep(900)
        const orderAfter = await cdp.evaluate<string[]>("[...document.querySelectorAll('[data-model-card]')].map(el => el.dataset.modelCard)")
        check(orderAfter[0] === orderBefore[1] && orderAfter[1] === orderBefore[0], 'settings: priority arrow reorders providers')
        await cdp.evaluate("document.querySelectorAll('[data-model-up]')[1].click()")
        await sleep(900)
        check(JSON.stringify(await cdp.evaluate<string[]>("[...document.querySelectorAll('[data-model-card]')].map(el => el.dataset.modelCard)")) === JSON.stringify(orderBefore), 'settings: priority round-trips back')
      }

      // Scenario editor saves through the API and reports success.
      if (await cdp.evaluate<boolean>("Boolean(document.querySelector('[data-scenario=coding]'))")) {
        await cdp.evaluate("document.querySelector('[data-scenario=coding]').open = true")
        await cdp.evaluate("document.querySelector('#scenario-result').textContent = ''")
        await cdp.evaluate("document.querySelector('#scenario-save').click()")
        await sleep(1200)
        check(await cdp.evaluate<boolean>("document.querySelector('#scenario-result').classList.contains('ok')"), 'settings: scenario save reports success')
      }

      // Escape closes the modal and focus returns to the opener.
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(500)
      check(await cdp.evaluate<boolean>("document.querySelector('#modal').hidden"), 'settings: Escape closes the modal')
      check(await cdp.evaluate<boolean>("document.activeElement?.id === 'settings-btn'"), 'settings: focus returns to the opener')

      // A real message round-trips through the WebSocket into the transcript.
      await cdp.evaluate("document.querySelector('#settings-btn') && 0")
      await cdp.evaluate(`(() => {
        const input = document.querySelector('#input')
        input.value = 'UI 冒烟：用四个字回答'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelector('#send-btn').click()
      })()`)
      await sleep(9000)
      const transcript = await cdp.evaluate<string>("document.querySelector('#transcript')?.innerText || ''")
      check(transcript.includes('UI 冒烟'), 'chat: user message appears')
      const assistantText = await cdp.evaluate<string>("[...document.querySelectorAll('.message.assistant .bubble')].map(el => el.innerText).join(String.fromCharCode(10))")
      check(assistantText.trim().length > 0, 'chat: assistant reply appears')
      await cdp.evaluate("document.querySelector('#settings-btn').click()")
      await sleep(700)
    }
    if (WRITE) {
      // The provider guide is the page a new user is sent to; verify it renders,
      // filters, and that its handoff pre-fills the settings form.
      const origin = new URL(APP).origin
      await cdp.send('Page.navigate', { url: `${origin}/providers` })
      await sleep(1800)
      const cardCount = await cdp.evaluate<number>("document.querySelectorAll('#pv-grid .pv-card').length")
      check(cardCount >= 15, `providers: renders every catalogue entry (${cardCount})`)
      await cdp.evaluate("[...document.querySelectorAll('.pv-chip')].find(el => el.dataset.filter === 'cn').click()")
      await sleep(300)
      const cnOnly = await cdp.evaluate<boolean>("[...document.querySelectorAll('#pv-grid .pv-card')].every(card => card.querySelector('.pv-badge')?.classList.contains('cn'))")
      check(cnOnly, 'providers: region filter keeps only mainland entries')
      await cdp.evaluate("[...document.querySelectorAll('.pv-chip')].find(el => el.dataset.filter === 'all').click()")
      await cdp.evaluate(`(() => {
        const input = document.querySelector('#pv-search')
        input.value = '月之暗面'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await sleep(300)
      check(await cdp.evaluate<number>("document.querySelectorAll('#pv-grid .pv-card').length") === 1, 'providers: search narrows to one entry')
      await cdp.evaluate("[...document.querySelectorAll('.pv-chip')].find(el => el.dataset.filter === 'all').click(); document.querySelector('#pv-search').value = ''; document.querySelector('#pv-search').dispatchEvent(new Event('input', { bubbles: true }))")
      await sleep(300)

      await cdp.evaluate("document.querySelector('[data-detail=\"siliconflow\"]').click()")
      await sleep(400)
      check(await cdp.evaluate<boolean>("document.querySelector('#pv-sheet').open === true"), 'providers: detail sheet opens')
      check(await cdp.evaluate<boolean>("(document.querySelector('#pv-sheet-body')?.innerText || '').includes('https://api.siliconflow.cn/v1')"), 'providers: detail shows the base URL')
      await cdp.evaluate("document.querySelector('#pv-sheet-close').click()")
      await sleep(250)
      check(await cdp.evaluate<boolean>("document.querySelector('#pv-sheet').open === false"), 'providers: detail sheet closes')

      // ---- voice section: ASR and TTS presets share the guide page ----
      const voiceCards = await cdp.evaluate<number>("document.querySelectorAll('#pv-voice-grid .pv-card').length")
      check(voiceCards >= 15, `providers: voice section renders presets (${voiceCards})`)
      await cdp.evaluate("[...document.querySelectorAll('[data-voice-filter]')].find(el => el.dataset.voiceFilter === 'asr').click()")
      await sleep(300)
      check(await cdp.evaluate<boolean>("[...document.querySelectorAll('#pv-voice-grid .pv-card')].every(card => card.querySelector('.pv-badge')?.textContent.trim() === 'ASR')"), 'providers: ASR filter keeps only recognition presets')
      check(await cdp.evaluate<number>("document.querySelectorAll('#pv-voice-grid .pv-card').length") === 9, 'providers: ASR filter keeps every recognition preset')
      await cdp.evaluate("[...document.querySelectorAll('[data-voice-filter]')].find(el => el.dataset.voiceFilter === 'all').click()")
      await sleep(200)
      await cdp.evaluate("document.querySelector('[data-voice-detail=\"siliconflow-cosyvoice\"]').click()")
      await sleep(400)
      check(await cdp.evaluate<boolean>("document.querySelector('#pv-sheet').open === true"), 'providers: voice detail sheet opens')
      check(await cdp.evaluate<boolean>("(document.querySelector('#pv-sheet-body')?.innerText || '').includes('FunAudioLLM/CosyVoice2-0.5B:alex')"), 'providers: voice detail shows the exact voice id')
      await cdp.evaluate("document.querySelector('#pv-sheet-close').click()")
      await sleep(250)

      // The guide page has its own CSS; audit it here, while we are still on it.
      for (const [theme, width] of [['dark', 1440], ['light', 1440], ['light', 390]] as const) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 })
        await cdp.evaluate("(() => { document.documentElement.dataset.theme = '" + theme + "'; const s = document.createElement('style'); s.id = 'smoke-freeze'; s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}'; document.head.append(s) })()")
        await sleep(220)
        const audit = await cdp.evaluate<{ bad: string[], count: number, overflow: number }>(CONTRAST_AUDIT)
        check(audit.count === 0, `providers contrast: ${theme} @${width}px (${audit.bad.join(' | ')})`)
        check(audit.overflow <= 1, `providers layout: ${theme} @${width}px no overflow (${audit.overflow}px)`)
        await cdp.evaluate("document.getElementById('smoke-freeze')?.remove()")
      }
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })

      // Handoff: /?provider=siliconflow must land in 设置 → 模型 with the form filled.
      // Click from a timer: the handler navigates, and a navigating context
      // never answers the pending Runtime.evaluate call.
      await cdp.evaluate("(() => { const el = document.querySelector('[data-use=\"siliconflow\"]'); setTimeout(() => el && el.click(), 0); return true })()")
      await sleep(3600)
      check(await cdp.evaluate<boolean>("location.pathname === '/' && !location.search"), 'providers: handoff cleans the query string')
      check(await cdp.evaluate<boolean>("!document.querySelector('#modal').hidden && document.querySelector('#settings-panel-model')?.hidden === false"), 'providers: handoff opens the model settings panel')
      check(await cdp.evaluate<string>("document.querySelector('#add-base')?.value || ''") === 'https://api.siliconflow.cn/v1', 'providers: handoff fills the base URL')
      check(await cdp.evaluate<string>("document.querySelector('#add-label')?.value || ''") === '硅基流动', 'providers: handoff fills the label')
      check(await cdp.evaluate<string>("document.querySelector('#add-protocol')?.value || ''") === 'chat-completions', 'providers: handoff selects the protocol')
      check(await cdp.evaluate<string>("document.activeElement?.id || ''") === 'add-key', 'providers: handoff focuses the API key field')
      check(await cdp.evaluate<boolean>("document.querySelector('#model-dirty')?.hidden === false"), 'providers: prefill marks the form unsaved')
      // Closing now asks for confirmation (the prefill is an unsaved change).
      await cdp.evaluate("(() => { const el = document.querySelector('#modal-close'); setTimeout(() => el && el.click(), 0); return true })()")
      await sleep(700)
      check(cdp.dialogs.some(message => message.includes('未保存')), 'providers: unsaved prefill warns before closing')
      check(await cdp.evaluate<boolean>("document.querySelector('#modal').hidden"), 'providers: confirming closes the sheet')

      // Voice handoff, same pattern, back on the guide page.
      await cdp.send('Page.navigate', { url: `${origin}/providers` })
      await sleep(1800)
      await cdp.evaluate("(() => { const el = document.querySelector('[data-voice-use=\"openai-whisper\"]'); setTimeout(() => el && el.click(), 0); return true })()")
      await sleep(3800)
      check(await cdp.evaluate<boolean>("location.pathname === '/' && !location.search"), 'providers: voice handoff cleans the query string')
      check(await cdp.evaluate<boolean>("!document.querySelector('#modal').hidden && document.querySelector('#settings-panel-voice')?.hidden === false"), 'providers: voice handoff opens the voice panel')
      check(await cdp.evaluate<number>("document.querySelectorAll('#voice-chain-asr li').length") === 2, 'providers: handoff appends a second ASR provider to the chain')
      check(await cdp.evaluate<boolean>("(document.querySelector('#voice-chain-asr li')?.textContent || '').includes('OpenAI')"), 'providers: new provider becomes the preferred entry')
      check(await cdp.evaluate<string>("document.querySelector('#asr-base')?.value || ''") === 'https://api.openai.com/v1', 'providers: voice handoff fills the endpoint')
      check(await cdp.evaluate<string>("document.querySelector('#asr-model')?.value || ''") === 'whisper-1', 'providers: voice handoff fills the model')
      check(await cdp.evaluate<string>("document.querySelector('#asr-adapter')?.value || ''") === 'openai', 'providers: voice handoff selects the adapter')
      check(await cdp.evaluate<boolean>("document.querySelector('#voice-dirty')?.hidden === false"), 'providers: voice prefill marks the form unsaved')

      // Add-from-catalogue inside the settings sheet: TTS gets a remote entry,
      // then the existing local engine is reused instead of duplicated.
      await cdp.evaluate("document.querySelector('[data-voice-add=\"tts\"]').click()")
      await sleep(900)
      check(await cdp.evaluate<number>("document.querySelectorAll('[data-voice-preset-id]').length") >= 5, 'settings: add panel lists catalogue presets')
      await cdp.evaluate("document.querySelector('[data-voice-preset-id=\"openai-tts\"]').click()")
      await sleep(500)
      check(await cdp.evaluate<number>("document.querySelectorAll('#voice-chain-tts li').length") === 2, 'settings: adding a TTS preset extends the chain')
      check(await cdp.evaluate<number>("document.querySelectorAll('#tts-adapter option').length") === 5, 'settings: remote TTS adapter offers OpenAI/Gemini/Cloudflare/Edge')
      await cdp.evaluate("document.querySelector('[data-voice-add=\"tts\"]').click()")
      await sleep(400)
      await cdp.evaluate("document.querySelector('[data-voice-preset-id=\"local-piper\"]').click()")
      await sleep(400)
      check(await cdp.evaluate<boolean>("document.querySelectorAll('#voice-chain-tts li').length === 2"), 'settings: picking an existing local engine does not duplicate it')
      check(await cdp.evaluate<boolean>("(document.querySelector('#voice-result')?.textContent || '').includes('本地引擎')"), 'settings: local preset explains that no key is needed')

      await cdp.evaluate("(() => { const el = document.querySelector('#modal-close'); setTimeout(() => el && el.click(), 0); return true })()")
      await sleep(800)

      await cdp.send('Page.navigate', { url: `${origin}/install` })
      await sleep(1500)
      {
        const audit = await cdp.evaluate<{ bad: string[], count: number, overflow: number }>(CONTRAST_AUDIT)
        check(audit.count === 0, `install contrast: dark (${audit.bad.join(' | ')})`)
        check(audit.overflow <= 1, `install layout: no overflow (${audit.overflow}px)`)
      }
      check(await cdp.evaluate<boolean>("(document.querySelector('#install-detect')?.textContent || '').includes('检测到')"), 'install: detects the current device')
      check(await cdp.evaluate<number>("document.querySelectorAll('#install-steps article').length") >= 2, 'install: renders device-specific steps')
      await cdp.send('Page.navigate', { url: `${origin}/` })
      await sleep(2600)
      // The assertions below expect the settings sheet to be open.
      await cdp.evaluate("document.querySelector('#settings-btn').click()")
      await sleep(1200)
    }
    await cdp.evaluate("document.querySelector('[data-model-select=remote]').click()")
    await sleep(700)
    check(await cdp.evaluate<boolean>("document.querySelectorAll('#model-protocol option').length === 3"), 'settings: three LLM protocols')
    check(await cdp.evaluate<boolean>("getComputedStyle(document.querySelector('.settings-modal .modal-body')).overflowY === 'auto'"), 'settings: modal owns scrolling')
    await cdp.evaluate("document.querySelector('#modal-close').click()")
    await sleep(250)

    await cdp.evaluate("document.querySelector('.quick[data-action=brief]').click()")
    await sleep(800)
    check(await cdp.evaluate<boolean>("Boolean(document.querySelector('#brief-close'))"), 'brief: modal opens')
    await cdp.evaluate("document.querySelector('#brief-close').click()")
    await sleep(200)

    await cdp.evaluate("document.querySelector('#studio-btn').click()")
    await sleep(1600)
    check(await cdp.evaluate<boolean>("!document.querySelector('#studio').hidden"), 'studio: opens')
    await cdp.evaluate("document.querySelector('[data-studio-tab=tuning]').click()")
    await sleep(900)
    check(await cdp.evaluate<boolean>("Boolean(document.querySelector('#tuning-compare'))"), 'studio: A/B control')
    await cdp.evaluate("document.querySelector('#tuning-compare').click()")
    await sleep(400)
    check(await cdp.evaluate<boolean>("document.body.innerText.includes('DEFAULT VS DRAFT')"), 'studio: A/B compare renders')
    await cdp.evaluate("document.querySelector('[data-studio-tab=config]').click()")
    await sleep(1100)
    check(await cdp.evaluate<boolean>("Boolean(document.querySelector('#config-raw'))"), 'studio: config renders')
    await cdp.evaluate("document.querySelector('#studio-close').click()")
    await sleep(300)

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await cdp.send('Page.reload', { ignoreCache: true })
    await sleep(2400)
    check(await cdp.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'mobile: no horizontal overflow')
    check(await cdp.evaluate<boolean>("Boolean(document.querySelector('#mic-btn'))"), 'mobile: mic present')
    await cdp.evaluate("document.querySelector('#settings-btn').click()")
    await sleep(900)
    const mobileSettings = await cdp.evaluate<{ fits: boolean; full: boolean; tabs: number; overflow: boolean }>(`({
      fits: document.querySelector('#modal .modal').getBoundingClientRect().width <= window.innerWidth + 1,
      full: document.querySelector('.settings-modal')?.getBoundingClientRect().height >= window.innerHeight - 2,
      tabs: document.querySelectorAll('[data-settings-tab]').length,
      overflow: document.querySelector('.modal-body').scrollWidth > document.querySelector('.modal-body').clientWidth + 1
    })`)
    check(mobileSettings.fits && mobileSettings.full && mobileSettings.tabs === 5 && !mobileSettings.overflow, 'mobile: settings sheet fits viewport')

    // Contrast and overflow at both themes and a phone width. This is the check
    // that caught "light theme text at 4.2:1" after a palette change.
    for (const [theme, width] of [['dark', 1440], ['light', 1440], ['light', 390]] as const) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 })
      await cdp.evaluate(`window.JarvisTheme?.set('${theme}')`)
      // Freeze transitions/animations: measuring mid-fade reports phantom
      // contrast failures (a colour halfway between the two themes).
      await cdp.evaluate("(() => { const s = document.createElement('style'); s.id = 'smoke-freeze'; s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}'; document.head.append(s) })()")
      await sleep(200)
      const applied = await cdp.evaluate<string>('document.documentElement.dataset.theme || ""')
      check(applied === theme, `theme: ${theme} applied (@${width}px, got "${applied}")`)
      const audit = await cdp.evaluate<{ bad: string[], count: number, overflow: number }>(CONTRAST_AUDIT)
      await cdp.evaluate("document.getElementById('smoke-freeze')?.remove()")
      check(audit.count === 0, `contrast: ${theme} @${width}px (${audit.bad.join(' | ')})`)
      check(audit.overflow <= 1, `layout: ${theme} @${width}px has no horizontal overflow (${audit.overflow}px)`)
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await cdp.evaluate("window.JarvisTheme?.set('dark')")
    await sleep(250)
    await cdp.evaluate("document.querySelector('#modal-close').click()")
    await sleep(200)
  } finally {
    if (cdp.errors.length) failures.push(...cdp.errors.map(error => `browser error: ${error.split('\n')[0]}`))
    cdp.close()
    if (target.id) await fetch(`${CDP}/json/close/${target.id}`).catch(() => undefined)
  }

  if (failures.length) {
    console.error(JSON.stringify({ ok: false, url: APP, failures }, null, 2))
    process.exitCode = 1
    return
  }
  console.log(JSON.stringify({ ok: true, url: APP, checked: ['home', 'settings', 'brief', 'studio', 'mobile', ...(WRITE ? ['theme', 'appearance', 'priority', 'scenario', 'chat'] : [])], browserErrors: 0 }, null, 2))
}

void main().catch(error => {
  console.error(`ui smoke failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
