import { BrowserPairing } from './pairing.js?v=4'

const connectionLabel = document.querySelector('#connection-label')
const gatewayDetail = document.querySelector('#gateway-detail')
const gatewayValue = document.querySelector('#gateway-value')
const lastCheck = document.querySelector('#last-check')
const sidebarStatus = document.querySelector('#sidebar-status')
const refreshButton = document.querySelector('#refresh-button')
const installButton = document.querySelector('#install-button')
const installDetail = document.querySelector('#install-detail')
const deviceDetail = document.querySelector('#device-detail')
const deviceValue = document.querySelector('#device-value')
const pairingSetup = document.querySelector('#pairing-setup')
const pairingForm = document.querySelector('#pairing-form')
const pairingChallenge = document.querySelector('#pairing-challenge')
const pairingMessage = document.querySelector('#pairing-message')
const pairingCode = document.querySelector('#pairing-code')
const pairingExpiry = document.querySelector('#pairing-expiry')
const pairButton = document.querySelector('#pair-button')
const cancelPairingButton = document.querySelector('#cancel-pairing-button')
const deviceName = document.querySelector('#device-name')
const sidebarDeviceState = document.querySelector('#sidebar-device-state')
const chatStateTitle = document.querySelector('#chat-state-title')
const chatStateDetail = document.querySelector('#chat-state-detail')
const messageInput = document.querySelector('#message-input')
let installPrompt
let probeInProgress = false
let pairingPhase = 'loading'
let pairingExpiresAt

function updateDeviceSummary() {
  const connected = pairingPhase === 'paired'
  const hasIdentity = connected || pairingPhase === 'paired-offline' || pairingPhase === 'paired-error'
  sidebarDeviceState.textContent = hasIdentity ? '已配对' : '未配对'
  sidebarStatus.textContent = connected
    ? '安全会话已建立'
    : pairingPhase === 'paired-offline'
      ? 'Gateway 未连接'
      : pairingPhase === 'paired-error'
        ? '会话不可用'
        : '无同步数据'
}

function setConnection(state, label, detail) {
  document.body.dataset.connection = state
  connectionLabel.textContent = label
  gatewayValue.textContent = label
  gatewayDetail.textContent = detail
  updateDeviceSummary()
}

function setDeviceValue(label, className = 'is-muted') {
  deviceValue.textContent = label
  deviceValue.className = `value-label ${className}`
}

function handlePairingState(state) {
  pairingPhase = state.phase
  pairingExpiresAt = state.expiresAt
  pairButton.disabled = state.phase === 'loading' || state.phase === 'starting'
  pairingSetup.hidden = state.phase === 'paired' || state.phase === 'paired-offline' || state.phase === 'paired-error'
  pairingForm.hidden = state.phase === 'pending'
  pairingChallenge.hidden = state.phase !== 'pending'
  if (state.phase === 'pending') {
    pairingCode.textContent = state.verificationCode
    pairingMessage.textContent = state.message ?? '等待 Mac 确认'
    setDeviceValue('待确认', 'is-warning')
    deviceDetail.textContent = state.displayName
  } else if (state.phase === 'paired') {
    setDeviceValue('已配对', '')
    deviceDetail.textContent = `${state.displayName} · 安全会话可用`
    chatStateTitle.textContent = '安全会话已建立'
    chatStateDetail.textContent = '此设备已通过 Jarvis Gateway 认证。'
    messageInput.placeholder = '等待对话同步'
  } else if (state.phase === 'paired-offline') {
    setDeviceValue('未连接', 'is-warning')
    deviceDetail.textContent = `${state.displayName} · 本地凭据非当前状态`
    chatStateTitle.textContent = '等待 Gateway'
    chatStateDetail.textContent = '已保存设备身份，但当前无法验证会话。'
    messageInput.placeholder = 'Gateway 未连接'
  } else if (state.phase === 'paired-error') {
    setDeviceValue('需检查', 'is-warning')
    deviceDetail.textContent = `${state.displayName} · ${state.message}`
    chatStateTitle.textContent = '会话不可用'
    chatStateDetail.textContent = 'Gateway 返回的会话状态未通过验证。'
    messageInput.placeholder = '会话不可用'
  } else {
    setDeviceValue(state.phase === 'revoked' ? '已撤销' : '未配对', state.phase === 'revoked' ? 'is-warning' : 'is-muted')
    deviceDetail.textContent = state.phase === 'revoked' ? '此设备凭据已被撤销' : '尚未向此浏览器签发凭据'
    pairingMessage.textContent = state.phase === 'error'
      ? state.message
      : state.phase === 'expired'
        ? '配对请求已过期，可重新开始'
        : state.phase === 'starting'
          ? '正在创建私有设备身份'
          : '创建此浏览器的私有设备身份'
    chatStateTitle.textContent = '连接到 Jarvis'
    chatStateDetail.textContent = '此设备完成配对后，对话会安全地显示在这里。'
    messageInput.placeholder = '配对后即可发送消息'
  }
  updateDeviceSummary()
}

const pairing = new BrowserPairing(handlePairingState)
handlePairingState({ phase: 'loading' })

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
pairButton.addEventListener('click', async () => {
  try {
    await pairing.begin(deviceName.value)
  } catch (error) {
    handlePairingState({ phase: 'error', message: error instanceof Error ? error.message : '无法开始配对' })
  }
})
cancelPairingButton.addEventListener('click', () => { void pairing.cancel() })
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
void pairing.initialize()
window.setInterval(() => { void probeGateway() }, 30_000)
window.setInterval(() => {
  if (pairingPhase !== 'pending' || pairingExpiresAt === undefined) return
  const remainingSeconds = Math.max(0, Math.ceil((pairingExpiresAt - Date.now()) / 1_000))
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = String(remainingSeconds % 60).padStart(2, '0')
  pairingExpiry.textContent = `剩余 ${minutes}:${seconds}`
}, 1_000)
