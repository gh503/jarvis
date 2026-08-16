import { ConversationsClient } from './conversations.js?v=8'
import { BrowserPairing } from './pairing.js?v=8'

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
const conversationEmpty = document.querySelector('#conversation-empty')
const conversationListItems = document.querySelector('#conversation-list-items')
const messageList = document.querySelector('#message-list')
const messageForm = document.querySelector('#message-form')
const messageInput = document.querySelector('#message-input')
const sendButton = document.querySelector('#send-button')
const newConversationButton = document.querySelector('#new-conversation-button')
const emptyNewConversationButton = document.querySelector('#empty-new-conversation-button')
const mobileConversationSelect = document.querySelector('#mobile-conversation-select')
const chatTitle = document.querySelector('#chat-title')
const chatFreshness = document.querySelector('#chat-freshness')
const conversationNotice = document.querySelector('#conversation-notice')
const activityFreshness = document.querySelector('#activity-freshness')
const activityEmpty = document.querySelector('#activity-empty')
const activityList = document.querySelector('#activity-list')
const approvalList = document.querySelector('#approval-list')
const approvalEmpty = document.querySelector('#approval-empty')
const approvalNotice = document.querySelector('#approval-notice')
const syncValue = document.querySelector('#sync-value')
let installPrompt
let probeInProgress = false
let pairingPhase = 'loading'
let pairingExpiresAt
let conversationsClient
let stateForRendering = { conversations: [], approvals: [], approvalSubmittedIds: [] }

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
  if (conversationsClient !== undefined) {
    if (state.phase === 'paired') {
      conversationsClient.setOnline(navigator.onLine)
      void conversationsClient.start()
    } else if (state.phase === 'paired-offline') {
      conversationsClient.setOnline(false)
      void conversationsClient.start()
    } else {
      conversationsClient.stop(state.phase)
    }
  }
}

const pairing = new BrowserPairing(handlePairingState)
conversationsClient = new ConversationsClient(pairing, handleConversationState)
handlePairingState({ phase: 'loading' })

function formatDate(value, includeDate = false) {
  return new Intl.DateTimeFormat('zh-CN', includeDate
    ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function conversationLabel(conversation) {
  return conversation.title?.trim() || (conversation.blank ? '新对话' : '未命名对话')
}

function approvalStatus(approval) {
  if (approval.blockReason === 'expired' || (approval.expiresAt !== null && approval.expiresAt <= Date.now())) return '已过期'
  if (approval.blockReason === 'evidence_missing') return '仅可拒绝'
  if (approval.blockReason === 'unsupported_action') return '需在 Mac 处理'
  return '等待决定'
}

function approvalCard(approval, mutable, busy) {
  const item = document.createElement('li')
  item.className = 'approval-card'
  item.dataset.approvalId = approval.id
  const header = document.createElement('div')
  header.className = 'approval-card-header'
  const title = document.createElement('strong')
  title.textContent = approval.action === 'open_app' ? '打开 Mac 应用' : approval.toolName
  const risk = document.createElement('span')
  risk.className = 'risk-label'
  risk.textContent = '高风险'
  header.append(title, risk)
  const target = document.createElement('p')
  target.className = 'approval-target'
  target.textContent = approval.target ?? '此操作不能从手机批准'
  const details = document.createElement('dl')
  details.className = 'approval-details'
  for (const [label, value] of [
    ['对话', conversationLabel({
      title: undefined, blank: false,
      ...stateForRendering.conversations.find(item => item.id === approval.conversationId),
    })],
    ['参数', approval.arguments === null ? '未向手机提供' : JSON.stringify(approval.arguments)],
    ['状态', approvalStatus(approval)],
    ['到期', approval.expiresAt === null ? '不允许远程批准' : formatDate(approval.expiresAt, true)],
  ]) {
    const term = document.createElement('dt')
    term.textContent = label
    const description = document.createElement('dd')
    description.textContent = value
    details.append(term, description)
  }
  const actions = document.createElement('div')
  actions.className = 'approval-actions'
  const reject = document.createElement('button')
  reject.type = 'button'
  reject.className = 'secondary-button'
  reject.dataset.approvalAction = 'rejected'
  reject.textContent = '拒绝'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'secondary-button'
  cancel.dataset.approvalAction = 'cancel'
  cancel.textContent = '取消本轮'
  const allow = document.createElement('button')
  allow.type = 'button'
  allow.className = 'primary-button'
  allow.dataset.approvalAction = 'allowed-once'
  allow.textContent = '允许一次'
  reject.disabled = !mutable || busy
  cancel.disabled = !mutable || busy
  allow.disabled = !mutable || busy || !approval.canAllow
    || approval.expiresAt === null || approval.expiresAt <= Date.now()
  actions.append(reject, cancel, allow)
  item.append(header, target, details, actions)
  return item
}

function renderApprovals(state, mutable) {
  approvalList.replaceChildren()
  for (const approval of state.approvals) {
    const submitted = state.approvalSubmittedIds.includes(approval.id)
    approvalList.append(approvalCard(approval, mutable, state.approvalBusyId === approval.id || submitted))
  }
  approvalEmpty.hidden = state.approvals.length > 0
  approvalList.hidden = state.approvals.length === 0
  approvalNotice.hidden = state.message === undefined
  approvalNotice.textContent = state.message ?? ''
  for (const count of document.querySelectorAll('[data-approval-count]')) {
    count.textContent = String(state.approvals.length)
    count.hidden = state.approvals.length === 0
  }
}

function handleConversationState(state) {
  stateForRendering = state
  const current = state.conversations.find(item => item.id === state.selectedId)
  const mutable = state.phase === 'ready' && pairingPhase === 'paired' && navigator.onLine
  const freshness = state.phase === 'ready'
    ? '实时'
    : state.phase === 'sending' || state.phase === 'refreshing' || state.phase === 'loading'
      ? '同步中'
      : state.phase === 'stale'
        ? '旧数据'
        : '不可用'
  chatFreshness.textContent = freshness
  activityFreshness.textContent = freshness
  syncValue.textContent = freshness
  syncValue.className = `value-label ${state.phase === 'ready' ? '' : 'is-warning'}`
  if (state.cachedAt !== undefined) lastCheck.textContent = `最近同步：${formatDate(state.cachedAt, true)}`

  conversationListItems.replaceChildren()
  for (const conversation of state.conversations) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `conversation-item ${conversation.id === state.selectedId ? 'is-active' : ''}`
    button.dataset.conversationId = conversation.id
    const title = document.createElement('strong')
    title.textContent = conversationLabel(conversation)
    const running = document.createElement('span')
    running.className = 'conversation-running'
    running.textContent = conversation.running ? '回复中' : ''
    const timestamp = document.createElement('small')
    timestamp.textContent = formatDate(conversation.updatedAt, true)
    button.append(title, running, timestamp)
    conversationListItems.append(button)
  }
  if (state.conversations.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'empty-list'
    empty.textContent = pairingPhase === 'paired' ? '暂无对话' : '配对后显示对话'
    conversationListItems.append(empty)
  }

  mobileConversationSelect.replaceChildren()
  if (state.conversations.length === 0) {
    const option = document.createElement('option')
    option.textContent = '无对话'
    mobileConversationSelect.append(option)
  } else {
    for (const conversation of state.conversations) {
      const option = document.createElement('option')
      option.value = conversation.id
      option.textContent = conversationLabel(conversation)
      option.selected = conversation.id === state.selectedId
      mobileConversationSelect.append(option)
    }
  }
  mobileConversationSelect.disabled = !mutable || state.conversations.length === 0
  newConversationButton.disabled = !mutable || state.sending
  emptyNewConversationButton.disabled = !mutable || state.sending

  chatTitle.textContent = current === undefined ? '对话' : conversationLabel(current)
  messageList.replaceChildren()
  for (const message of state.messages) {
    const item = document.createElement('li')
    item.className = `message is-${message.role}`
    const body = document.createElement('p')
    body.className = 'message-body'
    body.textContent = message.text
    const meta = document.createElement('span')
    meta.className = 'message-meta'
    meta.textContent = `${message.role === 'assistant' ? 'Jarvis' : '你'} · ${formatDate(message.createdAt)}`
    item.append(body, meta)
    messageList.append(item)
  }
  messageList.hidden = state.messages.length === 0
  conversationEmpty.hidden = state.messages.length > 0
  document.querySelector('#open-settings-button').hidden = pairingPhase === 'paired'
  emptyNewConversationButton.hidden = pairingPhase !== 'paired' || current !== undefined
  if (pairingPhase === 'paired') {
    chatStateTitle.textContent = current === undefined ? '开始一段对话' : '暂无消息'
    chatStateDetail.textContent = current === undefined
      ? '新建对话后即可向 Jarvis 发送文字。'
      : '输入第一条消息，Jarvis 的回复会实时显示。'
  }
  conversationNotice.hidden = state.message === undefined && state.phase !== 'stale'
  conversationNotice.textContent = state.message ?? (state.phase === 'stale' ? '当前显示上次同步的数据，发送功能已停用。' : '')
  messageInput.disabled = !mutable || current === undefined || state.sending
  sendButton.disabled = messageInput.disabled || messageInput.value.trim().length === 0
  messageInput.placeholder = current === undefined ? '先新建或选择对话' : state.sending ? '正在发送' : '输入消息'

  renderApprovals(state, mutable)

  activityList.replaceChildren()
  for (const activity of state.activity) {
    const item = document.createElement('li')
    item.className = 'activity-item'
    const label = document.createElement('span')
    label.textContent = activity.label
    const time = document.createElement('time')
    time.dateTime = new Date(activity.occurredAt).toISOString()
    time.textContent = formatDate(activity.occurredAt)
    item.append(label, time)
    activityList.append(item)
  }
  activityEmpty.hidden = state.activity.length > 0
  activityList.hidden = state.activity.length === 0
  if (state.messages.length > 0) queueMicrotask(() => { messageList.scrollTop = messageList.scrollHeight })
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
    if (pairingPhase === 'paired-offline') void pairing.accessSession(true).catch(() => {})
    if (pairingPhase !== 'paired') {
      lastCheck.textContent = `网关检查于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())} 完成；配对后同步数据`
    }
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
conversationListItems.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest('[data-conversation-id]') : null
  if (button !== null) void conversationsClient.select(button.dataset.conversationId)
})
approvalList.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest('[data-approval-action]') : null
  const card = button?.closest('[data-approval-id]')
  if (button === null || card === null) return
  if (button.dataset.approvalAction === 'cancel') void conversationsClient.cancelApproval(card.dataset.approvalId)
  else void conversationsClient.decideApproval(card.dataset.approvalId, button.dataset.approvalAction)
})
mobileConversationSelect.addEventListener('change', () => { void conversationsClient.select(mobileConversationSelect.value) })
newConversationButton.addEventListener('click', () => { void conversationsClient.create() })
emptyNewConversationButton.addEventListener('click', () => { void conversationsClient.create() })
messageInput.addEventListener('input', () => {
  sendButton.disabled = messageInput.disabled || messageInput.value.trim().length === 0
  messageInput.style.height = 'auto'
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 120)}px`
})
messageInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    messageForm.requestSubmit()
  }
})
messageForm.addEventListener('submit', async event => {
  event.preventDefault()
  const text = messageInput.value
  if (await conversationsClient.send(text)) {
    messageInput.value = ''
    messageInput.style.height = 'auto'
    sendButton.disabled = true
  }
})
refreshButton.addEventListener('click', () => {
  void probeGateway()
  void conversationsClient.refresh()
})
window.addEventListener('online', () => {
  conversationsClient.setOnline(true)
  void probeGateway()
})
window.addEventListener('offline', () => {
  conversationsClient.setOnline(false)
  setConnection('offline', '离线', '设备当前没有网络连接')
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void probeGateway()
    void conversationsClient.refresh()
  }
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
window.setInterval(() => {
  if (stateForRendering.approvals?.length > 0) {
    renderApprovals(stateForRendering, stateForRendering.phase === 'ready' && pairingPhase === 'paired' && navigator.onLine)
  }
}, 1_000)
