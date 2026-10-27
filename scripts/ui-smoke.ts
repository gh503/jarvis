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
const APP = (process.env.JARVIS_URL || 'http://127.0.0.1:3081/').replace(/\/+$/, '') + '/'
const TIMEOUT = 15_000

class Cdp {
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  readonly errors: string[] = []

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
        reject(new Error(`CDP timeout: ${method}`))
      }, TIMEOUT).unref()
    })
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }) as {
      result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } }
    }
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'page evaluation failed')
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

    await cdp.evaluate("document.querySelector('#settings-btn').click()")
    await sleep(900)
    const settings = await cdp.evaluate<{ open: boolean; privacy: boolean; devices: boolean; onboarding: boolean; modelSelect: boolean; protocols: boolean; voice: boolean; adapters: boolean; pool: boolean; scenarioSelect: boolean; tabs: number; tabbed: boolean }>(`({
      open: !document.querySelector('#modal').hidden,
      privacy: Boolean(document.querySelector('#privacy-export') && document.querySelector('#privacy-erase')),
      devices: Boolean(document.querySelector('#device-list')),
      onboarding: Boolean(document.querySelector('#onboard-again')),
      modelSelect: document.querySelector('#model-name')?.tagName === 'SELECT',
      protocols: Boolean(document.querySelector('#model-protocol') || document.querySelector('[data-model-select=remote]')),
      voice: Boolean(document.querySelector('#asr-source') && document.querySelector('#tts-source') && document.querySelector('#voice-save')),
      adapters: Boolean(document.querySelector('#asr-adapter') && document.querySelector('#tts-adapter') && document.querySelectorAll('#tts-adapter option').length === 5),
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
    check(settings.voice, 'settings: ASR/TTS source controls')
    check(settings.adapters, 'settings: provider adapters (OpenAI/Gemini/Cloudflare/Edge)')
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
      fits: document.querySelector('.modal').getBoundingClientRect().width <= window.innerWidth + 1,
      full: document.querySelector('.settings-modal')?.getBoundingClientRect().height >= window.innerHeight - 2,
      tabs: document.querySelectorAll('[data-settings-tab]').length,
      overflow: document.querySelector('.modal-body').scrollWidth > document.querySelector('.modal-body').clientWidth + 1
    })`)
    check(mobileSettings.fits && mobileSettings.full && mobileSettings.tabs === 5 && !mobileSettings.overflow, 'mobile: settings sheet fits viewport')
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
  console.log(JSON.stringify({ ok: true, url: APP, checked: ['home', 'settings', 'brief', 'studio', 'mobile'], browserErrors: 0 }, null, 2))
}

void main().catch(error => {
  console.error(`ui smoke failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
