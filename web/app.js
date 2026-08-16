const connectionLabel = document.querySelector('#connection-label')
const gatewayDetail = document.querySelector('#gateway-detail')
const gatewayValue = document.querySelector('#gateway-value')
const lastCheck = document.querySelector('#last-check')
const sidebarStatus = document.querySelector('#sidebar-status')
const refreshButton = document.querySelector('#refresh-button')
const installButton = document.querySelector('#install-button')
const installDetail = document.querySelector('#install-detail')
let installPrompt
let probeInProgress = false

function setConnection(state, label, detail) {
  document.body.dataset.connection = state
  connectionLabel.textContent = label
  gatewayValue.textContent = label
  gatewayDetail.textContent = detail
  sidebarStatus.textContent = state === 'online' ? '等待设备配对' : '无同步数据'
}

async function probeGateway() {
  if (probeInProgress) return
  if (!navigator.onLine) {
    setConnection('offline', '离线', '设备当前没有网络连接')
    return
  }
  probeInProgress = true
  refreshButton.disabled = true
  setConnection('checking', '正在检查', '正在连接 Jarvis Gateway')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetch('../v1/health', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    const health = await response.json()
    if (!response.ok || health.service !== 'jarvis-gateway' || health.status !== 'ok') throw new Error('invalid gateway response')
    setConnection('online', '网关可用', `安全范围：${health.scope === 'loopback-only' ? '仅本机' : '私有网络'}`)
    lastCheck.textContent = `网关检查于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())} 完成；账户数据仍不可用`
  } catch {
    setConnection('unavailable', '无法连接', 'Jarvis Gateway 暂时不可用')
  } finally {
    window.clearTimeout(timeout)
    refreshButton.disabled = false
    probeInProgress = false
  }
}

function showView(name) {
  for (const panel of document.querySelectorAll('[data-view-panel]')) {
    const active = panel.dataset.viewPanel === name
    panel.hidden = !active
    panel.classList.toggle('is-active', active)
  }
  for (const button of document.querySelectorAll('[data-view-target]')) {
    const active = button.dataset.viewTarget === name
    button.classList.toggle('is-active', active)
    if (active) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }
}

for (const button of document.querySelectorAll('[data-view-target]')) {
  button.addEventListener('click', () => showView(button.dataset.viewTarget))
}

document.querySelector('#open-settings-button').addEventListener('click', () => showView('settings'))
refreshButton.addEventListener('click', () => { void probeGateway() })
window.addEventListener('online', () => { void probeGateway() })
window.addEventListener('offline', () => setConnection('offline', '离线', '设备当前没有网络连接'))
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void probeGateway()
})

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault()
  installPrompt = event
  installButton.hidden = false
  installDetail.textContent = '可安装到此设备'
})

installButton.addEventListener('click', async () => {
  if (installPrompt === undefined) return
  await installPrompt.prompt()
  installPrompt = undefined
  installButton.hidden = true
})

window.addEventListener('appinstalled', () => {
  installButton.hidden = true
  installDetail.textContent = '已安装到此设备'
})

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js', { scope: './' })
  })
}

void probeGateway()
window.setInterval(() => { void probeGateway() }, 30_000)
