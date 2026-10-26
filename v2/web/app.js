import { initStudio } from './studio.js'
import { loadVisualTuning } from './visual.js'

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

const state = {
  ws: null,
  wsReady: false,
  reconnect: 0,
  token: localStorage.getItem('jarvis_token') || '',
  senseConsent: localStorage.getItem('jarvis_sense_consent') === '1',
  status: {},
  voice: { asr: false, tts: false },
  attention: { state: 'idle' },
  memory: [],
  reminders: [],
  focus: false,
  muted: localStorage.getItem('jarvis_muted') === '1',
  busy: false,
  cancelling: false,
  cancelTimer: 0,
  turnViaWs: false,
  turnWatchdog: 0,
  streamEl: null,
  streamText: '',
  pendingUserEcho: '',
  sawAssistantEvent: false,
  requestStartedAt: 0,
  recording: null,
  micHeld: false,
  recordToken: 0,
  mediaStream: null,
  audioContext: null,
  analyser: null,
  levelTimer: null,
  captureUrl: '',
  tokenPrompted: false,
  actions: [],
  seenActions: new Set(),
  audioQueue: [],
  audioPlaying: false,
  lastTranscript: '',
  modelSettings: null,
  modelFormId: 'local',
  modelOptions: {},
  voiceSettings: null,
  voiceStatus: null,
  settingsTab: 'model',
  settingsDirty: { model: false, voice: false },
  settingsLoadToken: 0,
  modalOpener: null,
}

const labels = {
  idle: ['待命', '说“看下这个”，或按住下方麦克风。'],
  considering: ['在判断', '这件事值不值得现在打扰你。'],
  listening: ['在听', '说完后松手，我会接住。'],
  capturing: ['正在采集', '只取这一小段，不会持续录音。'],
  understanding: ['在想', '正在结合记忆和当前上下文。'],
  need_context: ['需要看一眼', '正在按需打开屏幕或摄像头。'],
  responding: ['回答中', '可以随时打断我。'],
  followup: ['等你补充', '我还在，不用重新叫我。'],
}

const kindLabels = {
  semantic: '事实',
  episodic: '经历',
  procedural: '做法',
  prospective: '计划',
}

function authHeaders(extra = {}) {
  const headers = { ...extra }
  if (state.token) headers.authorization = `Bearer ${state.token}`
  return headers
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: authHeaders({ 'content-type': 'application/json', ...(options.headers || {}) }),
  })
  if (response.status === 401) {
    promptForToken()
    throw new Error('需要访问令牌')
  }
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
  return data
}

function connect() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = new URL(`${scheme}://${location.host}/ws`)
  if (state.token) url.searchParams.set('token', state.token)
  const ws = new WebSocket(url)
  state.ws = ws
  setConnection('connecting')
  ws.addEventListener('open', () => {
    state.wsReady = true
    state.reconnect = 0
    setConnection('online')
    ws.send(JSON.stringify({ kind: 'ping' }))
  })
  ws.addEventListener('message', event => {
    let payload
    try { payload = JSON.parse(event.data) } catch { return }
    if (payload.kind === 'hello') {
      applyStatus(payload.status)
      if (payload.attention) updateAttention(payload.attention)
      clearTurnWatchdog()
      // A reconnect can land after the server finished, while the last
      // assistant.done event was lost with the old socket. Never leave the
      // composer stuck in a permanent busy state.
      if (state.busy && state.turnViaWs && !payload.status?.busy) {
        finishStreaming('连接中断，未收到完整回答；请重试。', true)
        setBusy(false)
        state.turnViaWs = false
      } else if (state.busy && state.turnViaWs && payload.status?.busy) {
        state.turnWatchdog = setTimeout(() => {
          if (!state.busy || !state.turnViaWs) return
          finishStreaming('连接中断，未收到完整回答；请重试。', true)
          setBusy(false)
          state.turnViaWs = false
        }, 130000)
      }
    } else if (payload.kind === 'event') {
      handleEvent(payload.event)
    } else if (payload.kind === 'error') {
      if (state.busy && state.turnViaWs) {
        finishStreaming(payload.error || '连接出错，请重试。', true)
        setBusy(false)
        state.turnViaWs = false
      } else {
        appendMessage('system', payload.error)
      }
    }
  })
  ws.addEventListener('close', () => {
    state.wsReady = false
    state.ws = null
    setConnection('offline')
    state.reconnect += 1
    const delay = Math.min(12000, 1200 * state.reconnect)
    setTimeout(connect, delay)
    if (state.busy && state.turnViaWs) {
      clearTurnWatchdog()
      state.turnWatchdog = setTimeout(() => {
        if (!state.busy || !state.turnViaWs) return
        finishStreaming('连接中断，未收到完整回答；请重试。', true)
        setBusy(false)
        state.turnViaWs = false
      }, 130000)
    }
  })
  ws.addEventListener('error', () => {
    state.wsReady = false
    setConnection('offline')
  })
}

function setConnection(kind) {
  const dot = $('#connection-dot')
  const label = $('#connection-label')
  dot.className = `dot ${kind === 'online' ? 'online' : kind === 'offline' ? 'offline' : ''}`
  label.textContent = kind === 'online' ? '已连接' : kind === 'offline' ? '重连中' : '连接中'
}

window.addEventListener('jarvis:memory-changed', () => {
  if (state.wsReady) void refreshMemory()
})

function handleEvent(event) {
  window.dispatchEvent(new CustomEvent('jarvis:ws-event', { detail: event }))
  const data = event.data || {}
  switch (event.type) {
    case 'attention.state':
      updateAttention(data)
      break
    case 'user.message':
      if (state.pendingUserEcho && data.text === state.pendingUserEcho) {
        state.pendingUserEcho = ''
      } else if (data.source !== 'remote' && data.source !== 'voice') {
        appendMessage('user', data.text)
      }
      break
    case 'assistant.delta':
      state.sawAssistantEvent = true
      ensureStreaming()
      state.streamText = data.full || (state.streamText + (data.text || ''))
      state.streamEl.querySelector('.bubble').textContent = state.streamText
      scrollToBottom()
      break
    case 'assistant.audio':
      if (data.url) playAudio(data.url)
      break
    case 'assistant.done':
      state.sawAssistantEvent = true
      clearCancelTimer()
      clearTurnWatchdog()
      state.turnViaWs = false
      finishStreaming(data.text, Boolean(data.error))
      if (data.audioUrl) playAudio(data.audioUrl)
      setBusy(false)
      updateLatency()
      break
    case 'assistant.cancelled':
      clearCancelTimer()
      clearTurnWatchdog()
      state.turnViaWs = false
      stopAudio()
      finishStreaming('（已停止）')
      setBusy(false)
      break
    case 'voice.transcribed':
      if (data.text) {
        state.lastTranscript = data.text
        appendMessage('system', `听到：${data.text}`)
      }
      break
    case 'memory.added':
    case 'memory.proposed':
    case 'memory.deleted':
    case 'memory.event':
      scheduleMemoryRefresh()
      break
    case 'reminder.added':
    case 'reminder.due':
      refreshReminders()
      break
    case 'action.proposed':
      showAction(data.action)
      break
    case 'action.executed':
      noteAction(data.action, `已执行：${data.action?.label || '动作'}`)
      closeModal()
      break
    case 'action.denied':
      noteAction(data.action, `已拒绝：${data.action?.label || '动作'}`)
      closeModal()
      break
    case 'action.failed':
      noteAction(data.action, `执行失败：${data.action?.error || '未知错误'}`)
      closeModal()
      break
    case 'brief.ready':
      appendMessage('assistant', `今日简报\n${data.brief?.headline || ''}\n${(data.brief?.items || []).map(item => `· ${item.text}`).join('\n')}`)
      break
    case 'proactive.message':
      appendMessage('assistant', `⏰ ${data.reminder?.text || '提醒你一件事'}`)
      if (data.audioUrl) playAudio(data.audioUrl)
      refreshReminders()
      break
    case 'sense.capture':
      showCapture(data)
      break
    case 'model.changed':
      void refreshStatus()
      break
    case 'runtime.ready':
      state.voice = data.voice || state.voice
      applyStatus(data)
      break
    case 'attention.invalid':
      break
    default:
      break
  }
}

function updateAttention(snapshot) {
  state.attention = snapshot
  const [label, hint] = labels[snapshot.state] || labels.idle
  $('#state-label').textContent = label
  $('#state-hint').textContent = hint
  const orb = $('#orb')
  orb.classList.remove('listening', 'recording', 'thinking', 'responding')
  if (snapshot.state === 'listening' || snapshot.state === 'capturing') orb.classList.add('listening')
  if (snapshot.state === 'understanding' || snapshot.state === 'need_context' || snapshot.state === 'considering') orb.classList.add('thinking')
  if (snapshot.state === 'responding') orb.classList.add('responding')
}

function voiceAdapterLabel(adapter, provider) {
  if (adapter === 'gemini') return 'Gemini'
  if (adapter === 'cloudflare') return 'Cloudflare'
  if (adapter === 'edge') return 'Edge'
  return provider === 'remote' ? '远端' : '本地'
}

function voiceLabel() {
  if (!state.voice.asr) return '未启用'
  const prefix = `${voiceAdapterLabel(state.voice.asrAdapter, state.voice.asrProvider)} · `
  if (state.voice.asrState === 'starting') return `${prefix}加载中`
  if (state.voice.asrState === 'error') return `${prefix}异常`
  if (state.voice.asrState === 'idle') return `${prefix}待启动`
  return `${prefix}就绪`
}

function ttsLabel() {
  if (!state.voice.tts) return '未就绪'
  return `${voiceAdapterLabel(state.voice.ttsAdapter, state.voice.ttsProvider)} · 就绪`
}

function applyStatus(status = {}) {
  state.status = { ...state.status, ...status }
  if (status.voice) state.voice = status.voice
  state.focus = Boolean(state.status.focus)
  $('#focus-btn').setAttribute('aria-pressed', String(state.focus))
  const model = state.status.model || '本地模型'
  const provider = state.status.provider === 'remote' ? '远端' : '本地'
  $('#model-pill').textContent = state.status.modelReady ? `${model} · ${provider}` : '模型未就绪'
  $('#model-pill').style.opacity = state.status.modelReady ? '1' : '0.6'
  const asrStarting = state.voice.asrState === 'starting'
  const mic = $('#mic-btn')
  const orb = $('#orb')
  if (mic) {
    mic.disabled = asrStarting
    mic.title = asrStarting ? '语音识别加载中…' : state.voice.asrState === 'error' ? '语音识别异常；仍可重试或直接打字' : '按住说话'
    mic.setAttribute('aria-label', asrStarting ? '语音识别加载中' : state.voice.asrState === 'error' ? '语音识别异常' : '按下说话')
  }
  if (orb) {
    orb.disabled = asrStarting
    orb.title = asrStarting ? '语音识别加载中…' : '按下说话'
  }
  const hint = $('#state-hint')
  if (hint) {
    if (asrStarting) hint.textContent = '语音识别加载中，马上就好…'
    else if (hint.dataset.asr === '1') {
      hint.textContent = '说“看下这个”，或按住下方麦克风。'
      delete hint.dataset.asr
    }
    if (asrStarting) hint.dataset.asr = '1'
  }
  $('#memory-count').textContent = String(state.memory.length)
  $('#reminder-count').textContent = String(state.reminders.length)
  if (state.status.attention) updateAttention(state.status.attention)
  renderRuntime()
  if (!$('#modal').hidden && $('.modal')?.classList.contains('settings-modal')) updateSettingsOverview()
}

function appendMessage(role, text, options = {}) {
  const empty = $('#empty-state')
  if (empty) empty.remove()
  const article = document.createElement('article')
  article.className = `message ${role}${options.error ? ' error' : ''}`
  if (role !== 'system') {
    const avatar = document.createElement('span')
    avatar.className = 'avatar'
    avatar.textContent = role === 'user' ? '你' : 'J'
    article.appendChild(avatar)
  }
  const bubble = document.createElement('div')
  bubble.className = `bubble${options.streaming ? ' streaming' : ''}`
  if (text) bubble.textContent = text
  else if (options.streaming) bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'
  article.appendChild(bubble)
  if (options.meta) {
    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent = options.meta
    bubble.appendChild(meta)
  }
  $('#transcript').appendChild(article)
  scrollToBottom()
  return article
}

function ensureStreaming() {
  if (state.streamEl) return
  const empty = $('#empty-state')
  if (empty) empty.remove()
  const article = document.createElement('article')
  article.className = 'message assistant'
  const avatar = document.createElement('span')
  avatar.className = 'avatar'
  avatar.textContent = 'J'
  const bubble = document.createElement('div')
  bubble.className = 'bubble streaming'
  bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>'
  article.append(avatar, bubble)
  $('#transcript').appendChild(article)
  state.streamEl = article
  state.streamText = ''
  scrollToBottom()
}

function finishStreaming(text, isError = false) {
  const finalText = (text || state.streamText || '').trim()
  if (state.streamEl) {
    const bubble = state.streamEl.querySelector('.bubble')
    bubble.classList.remove('streaming')
    bubble.textContent = finalText || '（没有内容）'
    if (isError) state.streamEl.classList.add('error')
    state.streamEl = null
    state.streamText = ''
  } else if (finalText) {
    appendMessage('assistant', finalText, { error: isError })
  }
  scrollToBottom()
}

function scrollToBottom() {
  const transcript = $('#transcript')
  const distance = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
  if (distance < 220) transcript.scrollTop = transcript.scrollHeight
}

function clearTurnWatchdog() {
  if (state.turnWatchdog) clearTimeout(state.turnWatchdog)
  state.turnWatchdog = 0
}

function clearCancelTimer() {
  if (state.cancelTimer) clearTimeout(state.cancelTimer)
  state.cancelTimer = 0
  state.cancelling = false
}

function setBusy(busy) {
  state.busy = Boolean(busy)
  $('#send-btn').disabled = state.busy
  $('#stop-btn').hidden = !state.busy
  if (state.busy) state.requestStartedAt = Date.now()
  $('#orb').classList.toggle('thinking', state.busy)
}

function updateLatency() {
  if (!state.requestStartedAt) return
  const seconds = ((Date.now() - state.requestStartedAt) / 1000).toFixed(1)
  $('#latency').textContent = `${seconds}s`
  state.requestStartedAt = 0
}

function looksLikeSenseRequest(text) {
  return /(看|瞧|瞅).{0,8}(屏幕|桌面|摄像头|镜头)|看下这个|看看这个|what.*(screen|camera)/i.test(text)
}

function showSenseConsent(pendingText = '') {
  openModal(`
    <p class="eyebrow">SENSES / CONSENT</p>
    <h3>只在需要时看，不连续录制</h3>
    <p>屏幕通过系统门户单次截取；摄像头只取一张画面。画面保存在本机，1 小时后自动清理，你可以随时删除。</p>
    ${state.status?.provider === 'remote' ? '<p class="settings-error" role="alert">当前对话模型在远端。屏幕/摄像头画面可能发送到服务商；Jarvis 默认会阻止这次采集，除非服务端显式设置 JARVIS_ALLOW_REMOTE_VISION=1。切回本地模型后再看更安全。</p>' : ''}
    <ul class="brief-list">
      <li><b>屏幕</b>会先经过 GNOME 的共享确认；拒绝后我不会绕过。</li>
      <li><b>摄像头</b>只取单帧，不录视频、不留连续画面。</li>
      <li><b>黑名单</b>窗口会被拒绝；如果系统不提供窗口标题，我会在画面卡片里标注“标题未知”。</li>
    </ul>
    <div class="modal-actions">
      <button class="primary" id="sense-allow" type="button">${pendingText ? '允许这次' : '知道了'}</button>
      <button id="sense-always" type="button">以后不再提醒</button>
      <button id="sense-cancel" type="button">取消</button>
    </div>
  `, '感官权限')
  $('#sense-cancel').addEventListener('click', () => closeModal())
  $('#sense-allow').addEventListener('click', () => { closeModal(); if (pendingText) sendText(pendingText, { skipConsent: true }) })
  $('#sense-always').addEventListener('click', () => {
    state.senseConsent = true
    localStorage.setItem('jarvis_sense_consent', '1')
    closeModal()
    if (pendingText) sendText(pendingText, { skipConsent: true })
  })
}

function sendText(text, options = {}) {
  const clean = text.trim()
  if (!clean) return
  if (state.busy && !options.force) {
    appendMessage('system', '我还在处理上一件事。先点停止，或者等我一下。')
    return
  }
  if (!options.skipConsent && !state.senseConsent && looksLikeSenseRequest(clean)) {
    showSenseConsent(clean)
    return
  }
  const input = $('#input')
  input.value = ''
  autoGrow(input)
  stopAudio()
  clearCancelTimer()
  clearTurnWatchdog()
  state.sawAssistantEvent = false
  state.pendingUserEcho = clean
  appendMessage('user', clean)
  setBusy(true)
  const sent = sendWs({ kind: 'chat', text: clean })
  state.turnViaWs = sent
  if (!sent) {
    state.pendingUserEcho = ''
    api('/api/chat', { method: 'POST', body: JSON.stringify({ text: clean }) })
      .then(result => handleHttpResult(result))
      .catch(error => {
        finishStreaming(error.message, true)
        setBusy(false)
      })
  }
}

function handleHttpResult(result) {
  if (result.transcript && result.transcript !== state.lastTranscript) appendMessage('system', `听到：${result.transcript}`)
  if (!state.sawAssistantEvent) {
    finishStreaming(result.reply || result.error || '', Boolean(result.error))
  }
  if (result.audioUrl && !result.audioSpoken) playAudio(result.audioUrl)
  clearCancelTimer()
  clearTurnWatchdog()
  state.turnViaWs = false
  setBusy(false)
  updateLatency()
}

function sendWs(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false
  state.ws.send(JSON.stringify(payload))
  return true
}

async function bootstrap() {
  try {
    const data = await api('/api/bootstrap')
    state.memory = data.memory || []
    state.reminders = data.reminders || []
    state.actions = data.actions || []
    applyStatus(data.status)
    updateAttention(data.attention)
    renderMemory()
    renderReminders()
    renderRuntime()
    if (state.actions.length) setTimeout(() => showAction(state.actions[0]), 450)
  } catch (error) {
    appendMessage('system', `初始化失败：${error.message}`)
  }
}

function renderMemory(items = state.memory) {
  const list = $('#memory-list')
  list.textContent = ''
  if (!items.length) {
    const empty = document.createElement('p')
    empty.className = 'empty-list'
    empty.textContent = '还没有记忆。说“记住……”就会出现在这里。'
    list.appendChild(empty)
    return
  }
  for (const item of items) {
    const card = document.createElement('article')
    card.className = `memory-card${item.status === 'proposed' ? ' proposed' : ''}`
    card.dataset.id = item.id

    const top = document.createElement('div')
    top.className = 'memory-card-top'
    const kind = document.createElement('span')
    kind.className = 'kind-badge'
    kind.textContent = kindLabels[item.kind] || item.kind
    const status = document.createElement('span')
    status.className = 'status-badge'
    status.textContent = item.status === 'proposed' ? '待确认' : item.status === 'confirmed' ? '已确认' : item.status
    top.append(kind, status)

    const text = document.createElement('p')
    text.className = 'memory-text'
    text.textContent = item.gist || item.content

    const source = document.createElement('div')
    source.className = 'memory-source'
    source.textContent = `${item.sourceKind} · ${new Date(item.updatedAt).toLocaleDateString('zh-CN')}`

    let why = null
    if (Array.isArray(item.why) && item.why.length) {
      why = document.createElement('div')
      why.className = 'memory-why'
      why.textContent = `为什么想起：${item.why.join(' · ')}${typeof item.score === 'number' ? ` · 相关度 ${item.score}` : ''}`
    }

    const actions = document.createElement('div')
    actions.className = 'memory-actions'
    if (item.status === 'proposed') {
      actions.appendChild(actionButton('确认', 'confirm'))
      actions.appendChild(actionButton('忽略', 'reject'))
    }
    actions.appendChild(actionButton('删除', 'delete', true))
    card.append(top, text, source, ...(why ? [why] : []), actions)
    list.appendChild(card)
  }
}

function actionButton(label, action, danger = false) {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.action = action
  button.textContent = label
  if (danger) button.className = 'danger'
  return button
}

async function refreshMemory(query = '') {
  try {
    const data = query
      ? await api(`/api/memory?query=${encodeURIComponent(query)}`)
      : await api('/api/memory')
    const items = query ? (data.items || []).map(item => ({ ...item, gist: item.gist || item.content })) : data.items || []
    state.memory = query ? state.memory : items
    renderMemory(items)
    if (!query) $('#memory-count').textContent = String(items.length)
  } catch (error) {
    appendMessage('system', `记忆加载失败：${error.message}`)
  }
}

let memoryTimer = null
function scheduleMemoryRefresh() {
  clearTimeout(memoryTimer)
  memoryTimer = setTimeout(() => refreshMemory(), 600)
}

function renderReminders() {
  const list = $('#reminder-list')
  list.textContent = ''
  if (!state.reminders.length) {
    const empty = document.createElement('p')
    empty.className = 'empty-list'
    empty.textContent = '没有待办提醒。试着说“提醒我明天 9 点……”。'
    list.appendChild(empty)
    return
  }
  for (const reminder of state.reminders) {
    const row = document.createElement('div')
    row.className = 'reminder-row'
    const time = document.createElement('span')
    time.className = 'reminder-time'
    time.textContent = new Date(reminder.dueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    const text = document.createElement('span')
    text.className = 'reminder-text'
    text.textContent = reminder.text
    const complete = document.createElement('button')
    complete.type = 'button'
    complete.textContent = '完成'
    complete.addEventListener('click', async () => {
      try {
        await api(`/api/reminders/${reminder.id}/complete`, { method: 'POST' })
        refreshReminders()
      } catch (error) { appendMessage('system', error.message) }
    })
    row.append(time, text, complete)
    list.appendChild(row)
  }
}

async function refreshReminders() {
  try {
    const data = await api('/api/reminders')
    state.reminders = data.items || []
    renderReminders()
    $('#reminder-count').textContent = String(state.reminders.length)
  } catch {
    // Keep the last known list.
  }
}

function noteAction(action, text) {
  const id = action?.id || `${Date.now()}`
  if (state.seenActions.has(id)) return
  state.seenActions.add(id)
  appendMessage('system', text)
}

function showAction(action) {
  if (!action || action.status !== 'proposed') return
  const title = action.kind === 'open-url' ? '打开网页' : '打开应用'
  const target = escapeHtml(action.target)
  const label = escapeHtml(action.label || action.target)
  openModal(`
    <h3>需要你确认的一次性动作</h3>
    <p>${title}：<strong>${label}</strong></p>
    <div class="action-target">${target}</div>
    <p>只有你点“允许一次”才会执行；确认 60 秒后过期，不会自动重试。</p>
    <div class="modal-actions">
      <button class="primary" id="action-approve" type="button">允许一次</button>
      <button id="action-deny" type="button">拒绝</button>
    </div>
  `, '确认动作')
  const approve = $('#action-approve')
  const deny = $('#action-deny')
  approve.addEventListener('click', async () => {
    approve.disabled = true
    deny.disabled = true
    try {
      const result = await api(`/api/actions/${encodeURIComponent(action.id)}/approve`, { method: 'POST', body: '{}' })
      noteAction(result.action || action, `已执行：${action.label}`)
    } catch (error) {
      noteAction(action, `执行失败：${error.message}`)
    }
    closeModal()
  })
  deny.addEventListener('click', async () => {
    approve.disabled = true
    deny.disabled = true
    try {
      await api(`/api/actions/${encodeURIComponent(action.id)}/deny`, { method: 'POST', body: '{}' })
      noteAction(action, `已拒绝：${action.label}`)
    } catch (error) {
      appendMessage('system', error.message)
    }
    closeModal()
  })
}

function renderRuntime() {
  const grid = $('#runtime-grid')
  grid.textContent = ''
  const rows = [
    ['模型', state.status.model || '—'],
    ['模型来源', state.status.provider === 'remote' ? '远端' : '本地'],
    ['模型就绪', state.status.modelReady ? '是' : '否'],
    ['语音识别', voiceLabel()],
    ['语音合成', ttsLabel()],
    ['注意力', state.attention.state || 'idle'],
    ['专注模式', state.focus ? '开' : '关'],
    ['免打扰', state.status.quiet ? '当前时段' : '否'],
    ['忙碌', state.busy ? '是' : '否'],
  ]
  for (const [key, value] of rows) {
    const wrapper = document.createElement('div')
    const dt = document.createElement('dt')
    const dd = document.createElement('dd')
    dt.textContent = key
    dd.textContent = value
    wrapper.append(dt, dd)
    grid.appendChild(wrapper)
  }
}

function showCapture(data) {
  if (!data?.url) return
  state.captureUrl = data.url
  $('#capture-image').src = data.url
  $('#capture-title').textContent = data.target === 'camera' ? '刚看了一眼摄像头' : '刚看了当前屏幕'
  const size = data.bytes ? `${Math.round(data.bytes / 1024)} KB` : ''
  const title = data.windowTitle ? ` · ${data.windowTitle}` : data.target === 'screen' ? ' · 窗口标题未知' : ''
  $('#capture-detail').textContent = `${data.source || 'portal'}${size ? ` · ${size}` : ''}${title}`
  $('#capture-strip').hidden = false
  $('#capture-delete').onclick = () => void deleteCapture(data.url)
}

async function deleteCapture(url) {
  const name = String(url || '').split('/').pop()
  if (!name) return
  try {
    await api(`/api/captures/${encodeURIComponent(name)}`, { method: 'DELETE' })
    $('#capture-strip').hidden = true
    $('#capture-image').removeAttribute('src')
    state.captureUrl = ''
    $('#hint').textContent = '画面已删除'
  } catch (error) {
    $('#hint').textContent = `删除失败：${error.message}`
  }
}

function playAudio(url) {
  if (state.muted || !url) return
  state.audioQueue.push(url)
  if (!state.audioPlaying) playNextAudio()
}

function playNextAudio() {
  const player = $('#player')
  const url = state.audioQueue.shift()
  if (!url) {
    state.audioPlaying = false
    return
  }
  state.audioPlaying = true
  player.onended = playNextAudio
  player.onerror = playNextAudio
  player.src = url
  player.play().catch(() => {
    state.audioPlaying = false
    $('#hint').textContent = '点击页面后可播放语音'
  })
}

function stopAudio() {
  state.audioQueue = []
  state.audioPlaying = false
  const player = $('#player')
  player.onended = null
  player.onerror = null
  player.pause()
  player.removeAttribute('src')
}

function autoGrow(textarea) {
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(140, Math.max(34, textarea.scrollHeight))}px`
}

async function startRecording() {
  if (state.recording) return
  // Pressing the mic while Jarvis is thinking or speaking is a barge-in: stop
  // the current turn on the server first, then record the next utterance.
  if (state.busy || state.audioPlaying || state.audioQueue.length > 0) {
    sendWs({ kind: 'cancel' })
    setBusy(false)
    state.sawAssistantEvent = false
  }
  stopAudio()
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    appendMessage('system', '这个浏览器不支持录音。请用 Chrome，或直接打字。')
    return
  }
  const token = ++state.recordToken
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    if (!state.micHeld || token !== state.recordToken) {
      stream.getTracks().forEach(track => track.stop())
      return
    }
    state.mediaStream = stream
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type)) || ''
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    const chunks = []
    recorder.addEventListener('dataavailable', event => { if (event.data.size > 0) chunks.push(event.data) })
    recorder.addEventListener('stop', () => void finishRecording(chunks, recorder.mimeType))
    recorder.start(200)
    state.recording = recorder
    $('#mic-btn').classList.add('recording')
    $('#mic-label').textContent = '松开发送'
    $('#orb').classList.add('recording')
    updateAttention({ state: 'capturing' })
    startLevelMeter(stream)
  } catch (error) {
    appendMessage('system', `麦克风没打开：${error.message}`)
  }
}

function stopRecording() {
  if (!state.recording) return
  state.recording.stop()
  state.recording = null
  $('#mic-btn').classList.remove('recording')
  $('#mic-label').textContent = '按住说话'
  $('#orb').classList.remove('recording')
  stopLevelMeter()
  stopStream()
}

function stopStream() {
  state.mediaStream?.getTracks().forEach(track => track.stop())
  state.mediaStream = null
}

async function finishRecording(chunks, mimeType) {
  const blob = new Blob(chunks, { type: mimeType || 'audio/webm' })
  if (blob.size < 600) {
    $('#hint').textContent = '太短了，再说一次'
    return
  }
  state.sawAssistantEvent = false
  setBusy(true)
  $('#hint').textContent = state.voice.asrState === 'starting' ? '语音模型加载中，正在排队识别…' : '正在识别…'
  try {
    const response = await fetch('/api/voice', {
      method: 'POST',
      headers: authHeaders({ 'content-type': blob.type || 'audio/webm' }),
      body: blob,
    })
    if (response.status === 401) {
      promptForToken()
      throw new Error('需要访问令牌')
    }
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
    $('#hint').textContent = '本地推理 · 默认不录屏'
    handleHttpResult(result)
  } catch (error) {
    finishStreaming(`语音没走通：${error.message}`, true)
    setBusy(false)
    $('#hint').textContent = '本地推理 · 默认不录屏'
  }
}

function startLevelMeter(stream) {
  try {
    const context = new AudioContext()
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    state.audioContext = context
    state.analyser = analyser
    const data = new Uint8Array(analyser.frequencyBinCount)
    state.levelTimer = setInterval(() => {
      analyser.getByteFrequencyData(data)
      let sum = 0
      for (const value of data) sum += value * value
      const rms = Math.sqrt(sum / data.length) / 255
      document.documentElement.style.setProperty('--level', String(Math.max(0.12, Math.min(1, rms * 2.4))))
    }, 80)
  } catch {
    // Visual level is optional.
  }
}

function stopLevelMeter() {
  clearInterval(state.levelTimer)
  state.levelTimer = null
  state.analyser = null
  state.audioContext?.close().catch(() => undefined)
  state.audioContext = null
  document.documentElement.style.setProperty('--level', '0.18')
}

function promptForToken() {
  if (state.tokenPrompted) return
  state.tokenPrompted = true
  openModal(`
    <h3>需要访问令牌</h3>
    <p>这台机器不是本机回环访问。输入服务端配置的 <code>JARVIS_AUTH_TOKEN</code>；如果启动时没有设置该环境变量，再使用 <code>~/.local/share/jarvis/data/auth-token</code> 里的令牌。</p>
    <div class="search-row"><input id="token-input" type="password" placeholder="粘贴令牌" autocomplete="off"></div>
    <button class="send-btn" id="token-save" type="button" style="width:auto;padding:0 14px;height:34px">保存并重连</button>
  `, '访问令牌')
  const saveToken = () => {
    const value = $('#token-input').value.trim()
    if (!value) return
    state.token = value
    localStorage.setItem('jarvis_token', value)
    // Media elements (<audio>/<img>) cannot attach a Bearer header. The
    // server's token route sets the HttpOnly cookie those requests need.
    location.replace(`/?token=${encodeURIComponent(value)}`)
  }
  $('#token-save').addEventListener('click', saveToken)
  $('#token-input').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      saveToken()
    }
  })
  $('#token-input').focus()
}

async function showBrief() {
  try {
    const brief = await api('/api/brief')
    const items = (brief.items || []).map(item => `<li><b>${item.kind === 'calendar' ? '日程' : item.kind === 'reminder' ? '提醒' : '记忆'}</b> ${escapeHtml(item.text)}${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ''}</li>`).join('')
    openModal(`
      <p class="eyebrow">DAILY BRIEF · ${new Date().toLocaleDateString('zh-CN')}</p>
      <h3>${escapeHtml(brief.greeting)}</h3>
      <p>${escapeHtml(brief.headline)}</p>
      ${items ? `<ul class="brief-list">${items}</ul>` : '<p class="muted small">日程和提醒会出现在这里。</p>'}
      <div class="modal-actions">
        <button class="primary" id="brief-read" type="button">朗读</button>
        <button id="brief-close" type="button">关闭</button>
      </div>
    `, '今日简报')
    $('#brief-close').addEventListener('click', () => closeModal())
    $('#brief-read').addEventListener('click', async event => {
      const button = event.currentTarget
      button.disabled = true
      button.textContent = '准备语音…'
      try {
        const result = await api('/api/brief/read', { method: 'POST', body: '{}' })
        if (result.audioUrl) playAudio(result.audioUrl)
        button.textContent = '已朗读'
      } catch (error) {
        button.disabled = false
        button.textContent = `朗读失败：${error.message}`
      }
    })
  } catch (error) {
    appendMessage('system', `今日简报读取失败：${error.message}`)
  }
}

function openModal(html, title = '设置', options = {}) {
  if ($('#modal').hidden) state.modalOpener = options.opener || document.activeElement
  $('#modal-title').textContent = title
  $('#modal-body').innerHTML = html
  $('#modal').hidden = false
  $('.modal').classList.toggle('settings-modal', options.className === 'settings-modal')
  $('#modal').classList.toggle('settings-open', options.className === 'settings-modal')
  if (options.focus !== false) {
    requestAnimationFrame(() => {
      const target = options.focusSelector ? $(options.focusSelector) : $('.modal')
      target?.focus?.({ preventScroll: true })
    })
  }
}

function trapModalFocus(event) {
  const modal = $('.modal')
  if (!modal) return
  const focusable = $$('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])', modal)
    .filter(element => element.getClientRects().length > 0)
  if (!focusable.length) {
    event.preventDefault()
    modal.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!modal.contains(document.activeElement)) {
    event.preventDefault()
    first.focus()
    return
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function closeModal(force = false) {
  const dirty = state.settingsDirty.model || state.settingsDirty.voice
  if (!force && !$('#modal').hidden && $('.modal')?.classList.contains('settings-modal') && dirty) {
    if (!window.confirm('设置里有未保存的修改，关闭后会丢失。确定关闭？')) return
  }
  state.settingsLoadToken += 1
  $('#modal').hidden = true
  $('.modal')?.classList.remove('settings-modal')
  $('#modal').classList.remove('settings-open')
  state.settingsDirty = { model: false, voice: false }
  state.tokenPrompted = false
  const opener = state.modalOpener
  state.modalOpener = null
  opener?.focus?.({ preventScroll: true })
}

function protocolLabel(protocol) {
  if (protocol === 'responses') return 'OpenAI Responses'
  if (protocol === 'anthropic') return 'Anthropic Messages'
  if (protocol === 'ollama') return 'Ollama 原生'
  return 'OpenAI Chat Completions'
}

function isLoopbackUrl(value) {
  try {
    const host = new URL(value).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

function profileReachable(profile) {
  return profile.kind !== 'openai' || profile.hasKey || isLoopbackUrl(profile.baseUrl)
}

function modelNameOptions(selected) {
  const names = [...new Set([
    ...(selected.model ? [selected.model] : []),
    ...((state.modelOptions[selected.id] || []).map(item => typeof item === 'string' ? item : item.name).filter(Boolean)),
  ])]
  if (!names.length) return `<option value="">${selected.kind === 'openai' && !profileReachable(selected) ? '填写 Key 后获取模型' : '正在获取模型列表…'}</option>`
  return names.map(name => `<option value="${escapeHtml(name)}" ${name === selected.model ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')
}

function settingsDot(ok, warn = false) {
  return `<i class="settings-dot ${ok ? 'on' : warn ? 'warn' : ''}" aria-hidden="true"></i>`
}

function settingsOverviewInnerHtml() {
  const status = state.status || {}
  const voice = state.voice || {}
  const modelSource = status.provider === 'remote' ? '远端' : '本地'
  const asrSource = voiceAdapterLabel(voice.asrAdapter, voice.asrProvider)
  const ttsSource = voiceAdapterLabel(voice.ttsAdapter, voice.ttsProvider)
  const asrText = voice.asr === false ? '未启用' : voice.asrState === 'starting' ? '加载中' : voice.asrState === 'error' ? '异常' : '就绪'
  const ttsText = voice.tts ? '就绪' : '未就绪'
  return `
    <div class="settings-overview-item">
      ${settingsDot(Boolean(status.modelReady), false)}
      <div><small>对话模型</small><strong>${escapeHtml(modelSource)} · ${escapeHtml(status.model || '—')}</strong></div>
    </div>
    <div class="settings-overview-item">
      ${settingsDot(Boolean(voice.asr) && voice.asrState !== 'error', voice.asrState === 'starting')}
      <div><small>语音识别</small><strong>${escapeHtml(asrSource)} · ${escapeHtml(asrText)}</strong></div>
    </div>
    <div class="settings-overview-item">
      ${settingsDot(Boolean(voice.tts))}
      <div><small>语音合成</small><strong>${escapeHtml(ttsSource)} · ${escapeHtml(ttsText)}</strong></div>
    </div>
    <span class="settings-dirty" id="settings-dirty" ${state.settingsDirty.model || state.settingsDirty.voice ? '' : 'hidden'}>有未保存修改</span>`
}

function settingsOverviewHtml() {
  return `<div class="settings-overview" id="settings-overview" aria-label="当前运行状态">${settingsOverviewInnerHtml()}</div>`
}

function settingsTabBadge(name) {
  if (name === 'model') return state.status?.provider === 'remote' ? '远端' : '本地'
  if (name === 'voice') {
    const asr = voiceAdapterLabel(state.voice?.asrAdapter, state.voice?.asrProvider)
    const tts = voiceAdapterLabel(state.voice?.ttsAdapter, state.voice?.ttsProvider)
    return asr === tts ? asr : '混合'
  }
  return ''
}

function settingsTabsHtml() {
  const tabs = [['model', '模型'], ['voice', '语音'], ['access', '设备'], ['system', '系统']]
  return `<div class="settings-tabs" role="tablist" aria-label="设置分类">
    ${tabs.map(([id, label]) => {
      const active = state.settingsTab === id
      const badge = settingsTabBadge(id)
      return `<button type="button" class="settings-tab${active ? ' active' : ''}${(id === 'model' && state.settingsDirty.model) || (id === 'voice' && state.settingsDirty.voice) ? ' has-dirty' : ''}" id="settings-tab-${id}" data-settings-tab="${id}" role="tab" aria-selected="${active}" aria-controls="settings-panel-${id}" tabindex="${active ? '0' : '-1'}">
        <span>${label}</span>${badge ? `<small class="tab-badge">${escapeHtml(badge)}</small>` : ''}
      </button>`
    }).join('')}
  </div>`
}

function providerCardsHtml(settings, selectedId) {
  return (settings.profiles || []).map(profile => {
    const current = profile.id === settings.active
    const selected = profile.id === selectedId
    const reachable = profileReachable(profile)
    const kind = profile.kind === 'openai' ? protocolLabel(profile.protocol) : 'OLLAMA · 本机'
    return `<div class="provider-card${selected ? ' selected' : ''}${current ? ' active' : ''}" data-model-card="${escapeHtml(profile.id)}">
      <button type="button" class="provider-main" data-model-select="${escapeHtml(profile.id)}" aria-pressed="${selected}" title="编辑 ${escapeHtml(profile.label)}">
        <span class="provider-top">
          <span class="provider-title">${escapeHtml(profile.label)}</span>
          <span class="provider-badge ${current ? 'current' : reachable ? 'ready' : 'muted'}">${current ? '使用中' : reachable ? '可启用' : '待配置'}</span>
        </span>
        <span class="provider-model">${escapeHtml(profile.model || '未配置模型')}</span>
        <span class="provider-meta">${escapeHtml(kind)}${profile.baseUrl ? ` · ${escapeHtml(profile.baseUrl)}` : ''}</span>
      </button>
      <div class="provider-foot">
        <span>${selected ? '正在编辑' : '点击编辑'}</span>
        <button type="button" class="model-action${current ? ' quiet' : ''}" data-model-activate="${escapeHtml(profile.id)}" ${current || !reachable ? 'disabled' : ''}>${current ? '已启用' : reachable ? '启用' : '先填 Key'}</button>
      </div>
    </div>`
  }).join('')
}

function modelFormHtml(selected) {
  const remote = selected.kind === 'openai'
  const keyHint = selected.hasKey ? '已保存；留空保持不变' : isLoopbackUrl(selected.baseUrl) ? '可选（localhost 服务）' : '粘贴 API Key'
  const advancedOpen = Boolean(selected.embedModel || selected.visionModel)
  return `<div class="settings-card" id="model-form" data-model-form="${escapeHtml(selected.id)}">
    <div class="settings-card-head">
      <div><h4>编辑 ${escapeHtml(selected.label)}</h4><p>${escapeHtml(remote ? protocolLabel(selected.protocol) : '本机 Ollama 原生接口')}</p></div>
      <span class="settings-inline-dirty" id="model-dirty" ${state.settingsDirty.model ? '' : 'hidden'}>未保存</span>
    </div>
    <div class="settings-form-grid">
      ${remote ? `<label class="settings-field"><span>接口协议</span>
        <select id="model-protocol">
          <option value="chat-completions" ${selected.protocol !== 'responses' && selected.protocol !== 'anthropic' ? 'selected' : ''}>OpenAI Chat Completions</option>
          <option value="responses" ${selected.protocol === 'responses' ? 'selected' : ''}>OpenAI Responses</option>
          <option value="anthropic" ${selected.protocol === 'anthropic' ? 'selected' : ''}>Anthropic Messages</option>
        </select>
      </label>` : ''}
      <label class="settings-field${remote ? '' : ' wide'}"><span>Base URL</span>
        <input id="model-base" type="url" autocomplete="off" spellcheck="false" value="${escapeHtml(selected.baseUrl || '')}" placeholder="${remote ? 'https://api.deepseek.com/v1' : 'http://127.0.0.1:11434'}">
      </label>
      <label class="settings-field wide"><span>模型 <em>从服务地址自动获取</em></span>
        <div class="inline-control">
          <select id="model-name">${modelNameOptions(selected)}</select>
          <button type="button" class="model-action" id="model-refresh" title="重新读取模型列表">刷新</button>
        </div>
      </label>
    </div>
    <p class="settings-hint" id="model-list-status" role="status"></p>
    <p class="settings-hint">Cloudflare 的 Base URL 形如 <code>https://api.cloudflare.com/client/v4/accounts/&lt;ACCOUNT_ID&gt;/ai/v1</code>，模型从账号的 Workers AI 模型搜索自动读取；Gemini 可用 <code>https://generativelanguage.googleapis.com/v1beta/openai/</code>。其余 OpenAI 兼容服务填各自的 <code>/v1</code>。</p>
    ${remote ? `<label class="settings-field"><span>API Key</span>
      <input id="model-key" type="password" autocomplete="new-password" value="" placeholder="${escapeHtml(keyHint)}">
    </label>` : ''}
    <details class="settings-advanced" ${advancedOpen ? 'open' : ''}>
      <summary>高级：记忆向量与视觉模型</summary>
      <div class="settings-form-grid">
        <label class="settings-field"><span>记忆向量模型 <em>可选</em></span>
          <input id="model-embed" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(selected.embedModel || '')}" placeholder="nomic-embed-text">
        </label>
        <label class="settings-field"><span>视觉模型 <em>可选</em></span>
          <input id="model-vision" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(selected.visionModel || '')}" placeholder="qwen2.5vl:3b">
        </label>
      </div>
      <p class="settings-hint">远端未填写时会回退到本地 Ollama；Anthropic 没有官方 embedding 接口。</p>
    </details>
    <p class="settings-hint">Base URL 只填域名或完整端点都可以。远端必须 HTTPS；只有 localhost 可用 HTTP。Key 只存本机 <code>data/model-config.json</code>（0600），不会回显。</p>
    <div class="settings-actions">
      <button type="button" class="model-action" id="model-test">测试连接</button>
      <button type="button" class="model-action primary" id="model-apply">保存并切换</button>
      <span class="settings-feedback" id="model-result" role="status"></span>
    </div>
  </div>`
}

function voiceSettingsHtml(settings) {
  const asr = settings.asr || {}
  const tts = settings.tts || {}
  const asrRemote = asr.remote || {}
  const ttsRemote = tts.remote || {}
  const asrActive = settings.activeAsr === 'remote'
  const ttsActive = settings.activeTts === 'remote'
  const asrKeyHint = asrRemote.hasKey ? '已保存；留空保持不变' : '粘贴 API Key'
  const ttsKeyHint = ttsRemote.hasKey ? '已保存；留空保持不变' : '粘贴 API Key'
  return `
    <div class="voice-grid">
      <div class="voice-card${asrActive ? ' active' : ''}" data-voice-card="asr">
        <div class="voice-card-head">
          <div><span class="voice-kicker">ASR</span><strong>语音识别</strong></div>
          <label class="source-switch"><span>来源</span>
            <select id="asr-source" aria-label="ASR 来源">
              <option value="local" ${asrActive ? '' : 'selected'}>本地引擎</option>
              <option value="remote" ${asrActive ? 'selected' : ''}>远端服务</option>
            </select>
          </label>
        </div>
        <div class="voice-local-summary">${settingsDot(true)}<span>本地 <b>${escapeHtml(asr.local?.model || '—')}</b> <small>${escapeHtml(asr.local?.label || '')}</small></span></div>
        <div class="voice-remote" data-voice-remote="asr" ${asrActive ? '' : 'hidden'}>
          <label class="settings-field"><span>服务商</span>
            <select id="asr-adapter">
              <option value="auto" ${(asrRemote.adapter || 'auto') === 'auto' ? 'selected' : ''}>自动识别（按服务地址）</option>
              <option value="openai" ${asrRemote.adapter === 'openai' ? 'selected' : ''}>OpenAI 兼容 / Groq / 硅基流动 / OpenRouter</option>
              <option value="gemini" ${asrRemote.adapter === 'gemini' ? 'selected' : ''}>Google Gemini（原生音频）</option>
              <option value="cloudflare" ${asrRemote.adapter === 'cloudflare' ? 'selected' : ''}>Cloudflare Workers AI</option>
            </select>
          </label>
          <label class="settings-field"><span>传输方式</span>
            <select id="asr-transport">
              <option value="websocket" ${asrRemote.transport !== 'http' ? 'selected' : ''}>WebSocket 流式（默认）</option>
              <option value="http" ${asrRemote.transport === 'http' ? 'selected' : ''}>HTTP 一次性上传</option>
            </select>
          </label>
          <label class="settings-field" id="asr-base-field"><span>WebSocket / 服务地址</span>
            <input id="asr-base" type="url" autocomplete="off" spellcheck="false" value="${escapeHtml(asrRemote.baseUrl || '')}" placeholder="wss://asr.example.com/v1/stream">
          </label>
          <div class="settings-form-grid">
            <label class="settings-field"><span>模型</span><input id="asr-model" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(asrRemote.model || '')}" placeholder="whisper-1"></label>
            <label class="settings-field"><span>语言</span><input id="asr-language" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(asrRemote.language || 'zh')}" placeholder="zh"></label>
          </div>
          <label class="settings-field"><span>API Key</span><input id="asr-key" type="password" autocomplete="new-password" value="" placeholder="${escapeHtml(asrKeyHint)}"></label>
          <p class="settings-hint" id="asr-adapter-hint">OpenAI 兼容使用 <code>/audio/transcriptions</code>；Gemini / Cloudflare 使用各自原生音频端点。Gemini 或 Cloudflare 会自动切换为 HTTP。</p>
        </div>
      </div>
      <div class="voice-card${ttsActive ? ' active' : ''}" data-voice-card="tts">
        <div class="voice-card-head">
          <div><span class="voice-kicker">TTS</span><strong>语音合成</strong></div>
          <label class="source-switch"><span>来源</span>
            <select id="tts-source" aria-label="TTS 来源">
              <option value="local" ${ttsActive ? '' : 'selected'}>本地引擎</option>
              <option value="remote" ${ttsActive ? 'selected' : ''}>远端 / Edge TTS</option>
            </select>
          </label>
        </div>
        <div class="voice-local-summary">${settingsDot(true)}<span>本地 <b>${escapeHtml((tts.local?.voice || '').split('/').pop() || '—')}</b> <small>${escapeHtml(tts.local?.label || '')}</small></span></div>
        <div class="voice-remote" data-voice-remote="tts" ${ttsActive ? '' : 'hidden'}>
          <label class="settings-field"><span>服务商</span>
            <select id="tts-adapter">
              <option value="auto" ${(ttsRemote.adapter || 'auto') === 'auto' ? 'selected' : ''}>自动识别（按服务地址）</option>
              <option value="openai" ${ttsRemote.adapter === 'openai' ? 'selected' : ''}>OpenAI 兼容 / Groq / 硅基流动</option>
              <option value="gemini" ${ttsRemote.adapter === 'gemini' ? 'selected' : ''}>Google Gemini（原生 TTS）</option>
              <option value="cloudflare" ${ttsRemote.adapter === 'cloudflare' ? 'selected' : ''}>Cloudflare Workers AI</option>
              <option value="edge" ${ttsRemote.adapter === 'edge' ? 'selected' : ''}>Edge TTS（本机命令，免费）</option>
            </select>
          </label>
          <label class="settings-field" id="tts-base-field"><span>服务地址</span><input id="tts-base" type="url" autocomplete="off" spellcheck="false" value="${escapeHtml(ttsRemote.baseUrl || '')}" placeholder="https://api.openai.com/v1"></label>
          <div class="settings-form-grid">
            <label class="settings-field"><span>模型</span><input id="tts-model" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(ttsRemote.model || '')}" placeholder="tts-1"></label>
            <label class="settings-field"><span>音色</span><input id="tts-voice" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(ttsRemote.voice || '')}" placeholder="alloy / Kore / zh-CN-XiaoxiaoNeural"></label>
          </div>
          <label class="settings-field" id="tts-key-field"><span>API Key</span><input id="tts-key" type="password" autocomplete="new-password" value="" placeholder="${escapeHtml(ttsKeyHint)}"></label>
          <p class="settings-hint" id="tts-adapter-hint">OpenAI 兼容使用 <code>/audio/speech</code>；Gemini / Cloudflare 使用原生接口；Edge TTS 需要本机安装 <code>edge-tts</code>。</p>
        </div>
      </div>
    </div>
    <div class="settings-savebar">
      <span class="settings-inline-dirty" id="voice-dirty" ${state.settingsDirty.voice ? '' : 'hidden'}>未保存</span>
      <span class="settings-feedback" id="voice-result" role="status"></span>
      <button type="button" class="model-action primary" id="voice-save">保存语音设置</button>
    </div>`
}

function settingsPanelsHtml(selected, settings) {
  return `
    <section class="settings-panel" id="settings-panel-model" data-settings-panel="model" role="tabpanel" aria-labelledby="settings-tab-model">
      <div class="settings-section-head">
        <div><h3>对话模型</h3><p>选择本地 Ollama 或远端服务；模型列表会从服务地址自动读取。</p></div>
        <span class="settings-chip">${state.status?.provider === 'remote' ? '远端运行中' : '本地运行中'}</span>
      </div>
      ${state.settingsError ? `<p class="settings-error">模型配置读取失败：${escapeHtml(state.settingsError)}。下面是可用的本地默认项，保存前请确认服务已恢复。</p>` : ''}
      <div class="provider-grid" id="provider-grid"></div>
      <div id="model-form-host"></div>
      <p class="settings-notice" id="settings-model-notice" role="status"></p>
    </section>
    <section class="settings-panel" id="settings-panel-voice" data-settings-panel="voice" role="tabpanel" aria-labelledby="settings-tab-voice" hidden>
      <div class="settings-section-head">
        <div><h3>语音模型</h3><p>ASR 与 TTS 可以分别切换本地或远端；远端 ASR 默认 WebSocket 流式。</p></div>
        <span class="settings-chip">${voiceLabel()}</span>
      </div>
      ${state.voiceSettings ? voiceSettingsHtml(state.voiceSettings) : '<p class="settings-error">语音设置暂不可用。</p>'}
      <p class="settings-hint">切换只影响之后的语音轮次，不会重启服务。浏览器目前仍在上传整段语音，流式发生在 Jarvis 后端到 ASR 服务之间。</p>
    </section>
    <section class="settings-panel" id="settings-panel-access" data-settings-panel="access" role="tabpanel" aria-labelledby="settings-tab-access" hidden>
      <div class="settings-section-head">
        <div><h3>设备与配对</h3><p>配对手机或另一台电脑；每台设备有独立令牌，可单独撤销。</p></div>
      </div>
      <div class="settings-card">
        <div class="settings-card-head"><div><h4>已配对设备</h4><p>设备令牌只保存 SHA-256 哈希；撤销后立即失效。</p></div></div>
        <div class="device-list" id="device-list"><span class="muted small">读取中…</span></div>
        <div class="device-pair-row">
          <input id="device-name" type="text" maxlength="40" value="我的手机" aria-label="新设备名称" autocomplete="off">
          <button class="model-action primary" id="device-pair" type="button">生成配对码</button>
          <a class="model-action" href="/pair" target="_blank" rel="noopener">打开配对页</a>
        </div>
        <div id="pair-result" class="pair-result" hidden aria-live="polite"></div>
      </div>
      <div class="settings-card">
        <div class="settings-card-head"><div><h4>远程访问</h4><p>默认只监听 loopback。跨设备访问必须同时启用 TLS 和至少 24 字符的访问令牌。</p></div></div>
        <p class="settings-hint">手机浏览器可直接使用本页；详细证书和反向代理步骤见 <code>docs/v2/operations.md</code> 第 5 节。</p>
      </div>
    </section>
    <section class="settings-panel" id="settings-panel-system" data-settings-panel="system" role="tabpanel" aria-labelledby="settings-tab-system" hidden>
      <div class="settings-section-head">
        <div><h3>系统状态</h3><p>当前运行态、隐私操作和诊断入口。</p></div>
        <span class="settings-chip">${state.status?.focus ? '专注模式' : '正常'}</span>
      </div>
      <div class="settings-stat-grid" id="settings-runtime">${settingsRuntimeHtml()}</div>
      <div class="settings-card">
        <div class="settings-card-head"><div><h4>隐私与数据</h4><p>屏幕按次授权，摄像头只取单帧，记忆默认只存本机。</p></div></div>
        <p class="settings-hint">模型上下文不包含标记为 sensitive / secret 的记忆。远端模型仍会收到当前对话和普通记忆；屏幕/摄像头画面默认不会发往远端（需服务端显式 JARVIS_ALLOW_REMOTE_VISION=1），切换前请确认服务商政策。</p>
        <details class="settings-advanced">
          <summary>感官权限说明</summary>
          <p class="settings-hint">屏幕走 XDG Desktop Portal，每次按需授权；摄像头只取单帧；原生 Wayland 不读取帧缓冲、不持续录屏。采集前会显示状态，原图不进入长期记忆。</p>
        </details>
        <div class="settings-actions">
          <button class="model-action" id="privacy-export" type="button" aria-expanded="false" aria-controls="export-confirm">导出全部数据</button>
          <button class="model-action danger" id="privacy-erase" type="button" aria-expanded="false" aria-controls="erase-confirm">删除全部对话与记忆</button>
        </div>
        <div class="erase-confirm" id="export-confirm" hidden>
          <p>导出文件包含全部记忆（包括 sensitive/secret）、提醒和回合摘要；只保存到可信位置。</p>
          <div class="device-pair-row">
            <button class="model-action primary" id="export-confirm-btn" type="button">确认导出</button>
            <button class="model-action" id="export-cancel" type="button">取消</button>
          </div>
        </div>
        <div class="erase-confirm" id="erase-confirm" hidden>
          <p>删除会清空记忆、提醒、动作审计、语音与画面，并重置观察台历史；不可撤销，建议先导出。</p>
          <label for="erase-phrase">输入“删除全部”确认</label>
          <div class="device-pair-row">
            <input id="erase-phrase" type="text" autocomplete="off" spellcheck="false" placeholder="删除全部">
            <button class="model-action danger" id="erase-confirm-btn" type="button">确认删除</button>
            <button class="model-action" id="erase-cancel" type="button">取消</button>
          </div>
        </div>
      </div>
      <div class="settings-card">
        <div class="settings-card-head"><div><h4>诊断与引导</h4><p>终端运行 <code>npm run doctor</code> 可检查模型、Whisper、Piper、屏幕门户和摄像头。</p></div></div>
        <div class="settings-actions"><button class="model-action" id="onboard-again" type="button">重新查看首次引导</button></div>
      </div>
    </section>`
}

function settingsRuntimeHtml() {
  const status = state.status || {}
  const rows = [
    ['对话模型', `${status.model || '—'} · ${status.provider === 'remote' ? '远端' : '本地'}`],
    ['模型就绪', status.modelReady ? '就绪' : '未就绪'],
    ['语音识别', voiceLabel()],
    ['语音合成', ttsLabel()],
    ['注意力', state.attention?.state || 'idle'],
    ['专注模式', state.focus ? '开' : '关'],
  ]
  return rows.map(([label, value]) => `<div class="settings-stat"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`).join('')
}

function settingsBodyHtml(selected, settings) {
  return `<div class="settings-wrap">
    ${settingsOverviewHtml()}
    <div class="settings-tabs-wrap">${settingsTabsHtml()}</div>
    <div class="settings-panels">${settingsPanelsHtml(selected, settings)}</div>
  </div>`
}

function updateSettingsTabs() {
  $$('[data-settings-tab]').forEach(tab => {
    const id = tab.dataset.settingsTab
    const active = state.settingsTab === id
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', String(active))
    tab.tabIndex = active ? 0 : -1
    tab.classList.toggle('has-dirty', (id === 'model' && state.settingsDirty.model) || (id === 'voice' && state.settingsDirty.voice))
    const badge = tab.querySelector('.tab-badge')
    const next = settingsTabBadge(id)
    if (badge && next) badge.textContent = next
  })
}

function activateSettingsTab(name, options = {}) {
  const valid = ['model', 'voice', 'access', 'system']
  state.settingsTab = valid.includes(name) ? name : 'model'
  $$('[data-settings-panel]').forEach(panel => { panel.hidden = panel.dataset.settingsPanel !== state.settingsTab })
  if (options.resetScroll !== false) {
    const body = $('.settings-modal .modal-body')
    if (body) body.scrollTop = 0
  }
  updateSettingsTabs()
  if (options.focus) {
    const tab = $(`[data-settings-tab="${state.settingsTab}"]`)
    tab?.focus({ preventScroll: true })
    tab?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }
}

function bindSettingsTabs() {
  $$('[data-settings-tab]').forEach(tab => {
    tab.addEventListener('click', () => activateSettingsTab(tab.dataset.settingsTab, { focus: true }))
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const tabs = $$('[data-settings-tab]')
      const index = tabs.indexOf(tab)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      activateSettingsTab(tabs[next].dataset.settingsTab, { focus: true })
    })
  })
}

function updateDirtyUi() {
  const any = state.settingsDirty.model || state.settingsDirty.voice
  const overview = $('#settings-dirty')
  if (overview) overview.hidden = !any
  const model = $('#model-dirty')
  if (model) model.hidden = !state.settingsDirty.model
  const voice = $('#voice-dirty')
  if (voice) voice.hidden = !state.settingsDirty.voice
  updateSettingsTabs()
}

function markSettingsDirty(panel) {
  if (panel !== 'model' && panel !== 'voice') return
  state.settingsDirty[panel] = true
  updateDirtyUi()
}

function clearSettingsDirty(panel) {
  if (panel) state.settingsDirty[panel] = false
  else state.settingsDirty = { model: false, voice: false }
  updateDirtyUi()
}

function updateSettingsOverview() {
  const overview = $('#settings-overview')
  if (overview) overview.innerHTML = settingsOverviewInnerHtml()
  const runtime = $('#settings-runtime')
  if (runtime) runtime.innerHTML = settingsRuntimeHtml()
  updateSettingsTabs()
  updateDirtyUi()
}

function renderProviderCards() {
  const grid = $('#provider-grid')
  if (!grid || !state.modelSettings) return
  grid.innerHTML = providerCardsHtml(state.modelSettings, state.modelFormId)
  $$('[data-model-select]').forEach(button => {
    button.addEventListener('click', () => switchModelProfile(button.dataset.modelSelect))
  })
  $$('[data-model-activate]').forEach(button => {
    button.addEventListener('click', async () => {
      const id = button.dataset.modelActivate
      if (state.settingsDirty.model && !window.confirm('当前模型表单有未保存的修改，直接启用会丢弃它们。继续？')) return
      const original = button.textContent
      button.disabled = true
      button.textContent = '切换中…'
      try {
        const data = await api('/api/model/activate', { method: 'POST', body: JSON.stringify({ id }) })
        state.modelSettings = data.settings
        state.modelFormId = data.settings.active
        clearSettingsDirty('model')
        await refreshStatus()
        renderProviderCards()
        renderModelForm()
        updateSettingsOverview()
        showModelNotice(`已切换到 ${data.active?.label || ''} · ${data.active?.model || ''}`, 'ok')
        appendMessage('system', `模型已切换：${data.active?.label || ''} · ${data.active?.model || ''}`)
      } catch (error) {
        button.disabled = false
        button.textContent = original
        showModelNotice(`切换失败：${error.message}`, 'bad')
      }
    })
  })
}

function renderModelForm() {
  const host = $('#model-form-host')
  if (!host || !state.modelSettings) return
  const selected = state.modelSettings.profiles.find(item => item.id === state.modelFormId)
    || state.modelSettings.profiles[0]
  if (!selected) return
  host.innerHTML = modelFormHtml(selected)
  bindModelForm(selected)
  const status = $('#model-list-status')
  if (status && selected.kind === 'openai' && !selected.hasKey && !$('#model-key')?.value.trim()) {
    status.textContent = '填写 API Key 后，会从服务地址自动读取模型列表。'
    status.className = 'settings-hint'
  }
  updateDirtyUi()
}

function switchModelProfile(id) {
  if (!id || id === state.modelFormId) return
  if (state.settingsDirty.model && !window.confirm('当前模型表单有未保存的修改，切换编辑对象会丢弃它们。继续？')) return
  state.modelFormId = id
  state.settingsDirty.model = false
  renderProviderCards()
  renderModelForm()
  updateDirtyUi()
  const profile = state.modelSettings?.profiles.find(item => item.id === id)
  if (profile && (profile.kind !== 'openai' || profile.hasKey)) void refreshModelOptions(profile, { silent: true })
}

function showModelNotice(text, kind = '') {
  const notice = $('#settings-model-notice')
  if (!notice) return
  notice.textContent = text
  notice.className = `settings-notice ${kind}`.trim()
}

function bindVoiceSettings() {
  const sync = kind => {
    const source = $(`#${kind}-source`)
    const remote = $(`[data-voice-remote="${kind}"]`)
    if (source && remote) remote.hidden = source.value !== 'remote'
  }
  const applyPreset = (kind, adapter) => {
    const base = $(`#${kind}-base`)
    const model = $(`#${kind}-model`)
    const voice = kind === 'tts' ? $('#tts-voice') : null
    if (adapter === 'gemini') {
      if (base && !base.value.trim()) base.value = 'https://generativelanguage.googleapis.com/v1beta'
      if (model && !model.value.trim()) model.value = kind === 'asr' ? 'gemini-3.5-transcribe' : 'gemini-3.8-flash-tts'
      if (voice && !voice.value.trim()) voice.value = 'Kore'
    } else if (adapter === 'cloudflare') {
      if (base) base.placeholder = 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1'
      if (model && !model.value.trim()) model.value = kind === 'asr' ? '@cf/openai/whisper' : '@cf/myshell-ai/melotts'
    } else if (adapter === 'edge') {
      if (model && !model.value.trim()) model.value = 'edge-tts'
      if (voice && !voice.value.trim()) voice.value = 'zh-CN-XiaoxiaoNeural'
    }
  }
  const syncAdapter = kind => {
    const adapter = $(`#${kind}-adapter`)?.value || 'auto'
    const edge = kind === 'tts' && adapter === 'edge'
    const native = adapter === 'gemini' || adapter === 'cloudflare'
    const baseField = $(`#${kind}-base-field`)
    if (baseField) baseField.hidden = edge
    if (kind === 'tts') {
      const keyField = $('#tts-key-field')
      if (keyField) keyField.hidden = edge
      if (edge) {
        const model = $('#tts-model')
        const voice = $('#tts-voice')
        if (model && !model.value.trim()) model.value = 'edge-tts'
        if (voice && !voice.value.trim()) voice.value = 'zh-CN-XiaoxiaoNeural'
        if (voice) voice.placeholder = 'zh-CN-XiaoxiaoNeural'
      }
    }
    if (kind === 'asr') {
      const transport = $('#asr-transport')
      if (transport && native) {
        transport.value = 'http'
        transport.disabled = true
      } else if (transport) {
        transport.disabled = false
      }
    }
    const hint = $(`#${kind}-adapter-hint`)
    if (hint) {
      hint.textContent = edge
        ? 'Edge TTS 调用本机 edge-tts 命令，需要联网且没有官方 SLA；首次使用前运行 python3 -m pip install --user edge-tts。'
        : native
          ? 'Gemini / Cloudflare 使用各自原生音频端点，不使用 OpenAI /audio/* 路径；模型和音色名以对应控制台为准。'
          : 'OpenAI 兼容使用 /audio/* 路径；Groq、硅基流动、OpenRouter 等按各自模型与音频能力选择。'
    }
  }
  for (const kind of ['asr', 'tts']) {
    const source = $(`#${kind}-source`)
    source?.addEventListener('change', () => {
      sync(kind)
      markSettingsDirty('voice')
    })
    const adapter = $(`#${kind}-adapter`)
    adapter?.addEventListener('change', () => {
      applyPreset(kind, adapter.value)
      syncAdapter(kind)
      markSettingsDirty('voice')
    })
    syncAdapter(kind)
  }
  $('#voice-save')?.addEventListener('click', async event => {
    const button = event.currentTarget
    const result = $('#voice-result')
    const original = button.textContent
    button.disabled = true
    button.textContent = '保存中…'
    if (result) {
      result.textContent = '正在校验并切换语音运行时…'
      result.className = 'settings-feedback'
    }
    try {
      const data = await api('/api/voice/apply', {
        method: 'POST',
        body: JSON.stringify({
          activeAsr: $('#asr-source')?.value || 'local',
          activeTts: $('#tts-source')?.value || 'local',
          asr: { remote: { adapter: $('#asr-adapter')?.value || 'auto', transport: $('#asr-transport')?.value || 'websocket', baseUrl: $('#asr-base')?.value.trim() || '', model: $('#asr-model')?.value.trim() || '', language: $('#asr-language')?.value.trim() || 'zh', apiKey: $('#asr-key')?.value.trim() || '' } },
          tts: { remote: { adapter: $('#tts-adapter')?.value || 'auto', baseUrl: $('#tts-base')?.value.trim() || '', model: $('#tts-model')?.value.trim() || '', voice: $('#tts-voice')?.value.trim() || '', apiKey: $('#tts-key')?.value.trim() || '' } },
        }),
      })
      state.voiceSettings = data.settings
      state.voiceStatus = data.status
      clearSettingsDirty('voice')
      if (result) {
        result.textContent = `已生效：ASR ${data.status.asr.label} · TTS ${data.status.tts.label}`
        result.className = 'settings-feedback ok'
      }
      await refreshStatus()
      for (const kind of ['asr', 'tts']) {
        $(`[data-voice-card="${kind}"]`)?.classList.toggle('active', data.status[kind].kind === 'remote')
      }
      const chip = $('#settings-panel-voice .settings-chip')
      if (chip) chip.textContent = voiceLabel()
      updateSettingsOverview()
      appendMessage('system', `语音设置已保存：ASR ${data.status.asr.kind === 'remote' ? '远端' : '本地'} · TTS ${data.status.tts.kind === 'remote' ? '远端' : '本地'}`)
    } catch (error) {
      if (result) {
        result.textContent = `保存失败：${error.message}`
        result.className = 'settings-feedback bad'
      }
    } finally {
      button.disabled = false
      button.textContent = original
    }
  })
}

function renderSettings(options = {}) {
  if (!state.modelSettings) return
  if (options.resetDirty !== false) state.settingsDirty = { model: false, voice: false }
  state.settingsTab = options.tab || state.settingsTab || 'model'
  let selected = state.modelSettings.profiles.find(item => item.id === state.modelFormId)
  if (!selected) selected = state.modelSettings.profiles.find(item => item.id === state.modelSettings.active) || state.modelSettings.profiles[0]
  if (!selected) return
  state.modelFormId = selected.id
  const scrollTop = options.scrollTop ?? $('.settings-modal .modal-body')?.scrollTop ?? 0
  openModal(settingsBodyHtml(selected, state.modelSettings), '设置', { className: 'settings-modal', focus: options.focus !== false, opener: $('#settings-btn') })
  bindSettingsTabs()
  activateSettingsTab(state.settingsTab)
  renderProviderCards()
  renderModelForm()
  bindVoiceSettings()
  bindSettingsActions()
  updateDirtyUi()
  void refreshDevices()
  if (selected.kind !== 'openai' || selected.hasKey) void refreshModelOptions(selected, { silent: true })
  requestAnimationFrame(() => {
    const body = $('.settings-modal .modal-body')
    if (body) body.scrollTop = scrollTop
  })
}

function settingsLoadingHtml() {
  return `<div class="settings-loading" role="status" aria-live="polite">
    <span class="settings-spinner" aria-hidden="true"></span>
    <p>正在读取本机配置…</p>
  </div>`
}

async function showSettings(options = {}) {
  const token = ++state.settingsLoadToken
  const wasOpen = !$('#modal').hidden
  if (!wasOpen) openModal(settingsLoadingHtml(), '设置', { className: 'settings-modal', opener: $('#settings-btn') })
  const [voiceResult, modelResult] = await Promise.allSettled([
    api('/api/voice'),
    api('/api/model'),
  ])
  if (voiceResult.status === 'fulfilled') {
    state.voiceSettings = voiceResult.value.settings
    state.voiceStatus = voiceResult.value.status
  } else {
    state.voiceSettings = null
    state.voiceStatus = null
  }
  if (modelResult.status === 'fulfilled') {
    state.modelSettings = modelResult.value.settings
    state.settingsError = ''
  } else {
    state.settingsError = modelResult.reason?.message || '模型状态读取失败'
    state.modelSettings = {
      active: 'local',
      profiles: [{
        id: 'local', label: '本地 Ollama', kind: 'ollama', protocol: 'ollama',
        baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b',
        visionModel: '', embedModel: '', keepAlive: '24h', hasKey: false,
      }],
    }
  }
  if (token !== state.settingsLoadToken || $('#modal').hidden) return
  if (!state.modelSettings.profiles?.some(item => item.id === state.modelFormId)) {
    state.modelFormId = state.modelSettings.active
  }
  renderSettings({ tab: options.tab || state.settingsTab, focus: !wasOpen })
}

async function refreshDevices() {
  const list = $('#device-list')
  if (!list) return
  try {
    const data = await api('/api/devices')
    const devices = data.devices || []
    list.innerHTML = devices.length === 0
      ? '<span class="muted small">还没有配对设备。主令牌仍然可用。</span>'
      : devices.map(device => `<div class="device-row"><span><b>${escapeHtml(device.name)}</b><small>${device.revoked ? '已撤销' : `配对于 ${new Date(device.createdAt).toLocaleDateString('zh-CN')}`}</small></span><button class="model-action${device.revoked ? ' quiet' : ' danger'}" data-revoke-device="${escapeHtml(device.id)}" ${device.revoked ? 'disabled' : ''}>${device.revoked ? '已撤销' : '撤销'}</button></div>`).join('')
    $$('[data-revoke-device]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true
      try {
        await api(`/api/devices/${encodeURIComponent(button.dataset.revokeDevice)}`, { method: 'DELETE' })
        await refreshDevices()
      } catch (error) {
        button.disabled = false
        appendMessage('system', `撤销失败：${error.message}`)
      }
    }))
  } catch (error) {
    list.innerHTML = `<span class="muted small">读取设备失败：${escapeHtml(error.message)}</span>`
  }
}

function renderModelSelect(selected, names) {
  const select = $('#model-name')
  if (!select || !names.length || state.modelFormId !== selected.id) return
  const unique = [...new Set(names.filter(Boolean))]
  state.modelOptions[selected.id] = unique
  const current = select.value || selected.model
  select.innerHTML = unique.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')
  select.value = unique.includes(current) ? current : unique[0]
}

async function refreshModelOptions(selected, options = {}) {
  const status = $('#model-list-status')
  const base = $('#model-base')?.value.trim() ?? selected.baseUrl ?? ''
  if (!base) {
    if (status) {
      status.textContent = '先填写 Base URL。'
      status.className = 'settings-hint bad'
    }
    return
  }
  const localBase = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(base)
  const hasKey = selected.hasKey || Boolean($('#model-key')?.value.trim())
  if (selected.kind === 'openai' && !hasKey && !localBase) {
    if (status) {
      status.textContent = '填写 API Key 后自动获取模型列表。'
      status.className = 'settings-hint'
    }
    return
  }
  if (status && !options.silent) {
    status.textContent = '正在从服务地址读取模型列表…'
    status.className = 'settings-hint loading'
  }
  try {
    const data = await api('/api/model/list', {
      method: 'POST',
      body: JSON.stringify({
        id: selected.id,
        label: selected.label,
        kind: selected.kind,
        protocol: $('#model-protocol')?.value || selected.protocol || 'chat-completions',
        baseUrl: base,
        apiKey: $('#model-key')?.value.trim() || '',
        model: selected.model || '',
        embedModel: $('#model-embed')?.value.trim() || '',
        visionModel: $('#model-vision')?.value.trim() || '',
        keepAlive: selected.keepAlive || '24h',
      }),
    })
    if (state.modelFormId !== selected.id) return
    const names = (data.models || []).map(item => typeof item === 'string' ? item : item.name).filter(Boolean)
    if (names.length) {
      renderModelSelect(selected, names)
      if (status) {
        status.textContent = `已从服务读取 ${names.length} 个模型；选择后再保存。`
        status.className = 'settings-hint ok'
      }
    } else if (status) {
      status.textContent = data.error || '服务没有返回模型；仍可使用当前模型。'
      status.className = 'settings-hint bad'
    }
  } catch (error) {
    if (status) {
      status.textContent = `自动获取失败：${error.message}`
      status.className = 'settings-hint bad'
    }
  }
}

function bindModelForm(selected) {
  $('#model-refresh')?.addEventListener('click', async event => {
    const button = event.currentTarget
    const original = button.textContent
    button.disabled = true
    button.textContent = '刷新中…'
    await refreshModelOptions(selected)
    button.disabled = false
    button.textContent = original
  })
  $('#model-protocol')?.addEventListener('change', () => void refreshModelOptions(selected))
  $('#model-base')?.addEventListener('change', () => void refreshModelOptions(selected))
  $('#model-key')?.addEventListener('change', () => void refreshModelOptions(selected))
  $('#model-test')?.addEventListener('click', async event => {
    const button = event.currentTarget
    const result = $('#model-result')
    const original = button.textContent
    button.disabled = true
    button.textContent = '测试中…'
    if (result) {
      result.textContent = '正在连接服务并验证模型…'
      result.className = 'settings-feedback'
    }
    try {
      const payload = modelPayload(selected)
      if (!payload.baseUrl) throw new Error('请先填写 Base URL')
      const data = await api('/api/model/test', { method: 'POST', body: JSON.stringify(payload) })
      if (Array.isArray(data.models) && data.models.length) renderModelSelect(selected, data.models)
      if (result) {
        result.textContent = `${data.ok ? '连接成功' : '连接失败'} · ${data.latencyMs ?? '—'} ms · ${data.message || ''}`
        result.className = `settings-feedback ${data.ok ? 'ok' : 'bad'}`
      }
    } catch (error) {
      if (result) {
        result.textContent = `连接失败：${error.message}`
        result.className = 'settings-feedback bad'
      }
    } finally {
      button.disabled = false
      button.textContent = original
    }
  })
  $('#model-apply')?.addEventListener('click', async event => {
    const button = event.currentTarget
    const result = $('#model-result')
    const original = button.textContent
    button.disabled = true
    button.textContent = '切换中…'
    if (result) {
      result.textContent = '正在验证并切换模型…'
      result.className = 'settings-feedback'
    }
    try {
      const payload = modelPayload(selected)
      if (!payload.baseUrl) throw new Error('请先填写 Base URL')
      const data = await api('/api/model/apply', { method: 'POST', body: JSON.stringify(payload) })
      state.modelSettings = data.settings
      state.modelFormId = data.settings.active
      clearSettingsDirty('model')
      await refreshStatus()
      renderProviderCards()
      renderModelForm()
      updateSettingsOverview()
      showModelNotice(`已保存并切换到 ${data.active?.label || ''} · ${data.active?.model || ''}`, 'ok')
      appendMessage('system', `模型已保存并切换：${data.active?.label || ''} · ${data.active?.model || ''}`)
    } catch (error) {
      if (result) {
        result.textContent = `切换失败：${error.message}`
        result.className = 'settings-feedback bad'
      }
    } finally {
      button.disabled = false
      button.textContent = original
    }
  })
}

function bindSettingsActions() {
  const pairNow = async button => {
    const name = $('#device-name')?.value.trim() || '我的手机'
    if (name.length > 40) {
      appendMessage('system', '设备名称最多 40 个字符。')
      return
    }
    button.disabled = true
    try {
      const result = await api('/api/devices/pair', { method: 'POST', body: JSON.stringify({ name }) })
      const box = $('#pair-result')
      if (!box) return
      box.hidden = false
      box.innerHTML = `<strong>${escapeHtml(result.code)}</strong><span>5 分钟内有效；在另一台设备打开 <code>${escapeHtml(location.origin)}/pair</code> 输入它。</span>`
      await refreshDevices()
    } catch (error) {
      appendMessage('system', `生成配对码失败：${error.message}`)
    } finally {
      button.disabled = false
    }
  }
  $('#device-pair')?.addEventListener('click', event => void pairNow(event.currentTarget))
  $('#device-name')?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const button = $('#device-pair')
    if (button && !button.disabled) void pairNow(button)
  })
  const setExportPanel = open => {
    const panel = $('#export-confirm')
    const opener = $('#privacy-export')
    if (!panel) return
    panel.hidden = !open
    opener?.setAttribute('aria-expanded', String(open))
    if (open) {
      const erase = $('#erase-confirm')
      if (erase) erase.hidden = true
      $('#privacy-erase')?.setAttribute('aria-expanded', 'false')
      $('#export-confirm-btn')?.focus()
    } else {
      opener?.focus()
    }
  }
  $('#privacy-export')?.addEventListener('click', () => setExportPanel(Boolean($('#export-confirm')?.hidden)))
  $('#export-cancel')?.addEventListener('click', () => setExportPanel(false))
  $('#export-confirm-btn')?.addEventListener('click', async event => {
    const button = event.currentTarget
    button.disabled = true
    try {
      const data = await api('/api/privacy/export')
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `jarvis-export-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      button.disabled = false
      setExportPanel(false)
      const opener = $('#privacy-export')
      if (opener) opener.textContent = '已导出'
    } catch (error) {
      button.disabled = false
      appendMessage('system', `导出失败：${error.message}`)
    }
  })
  $('#privacy-erase')?.addEventListener('click', event => {
    const panel = $('#erase-confirm')
    if (!panel) return
    panel.hidden = !panel.hidden
    event.currentTarget.setAttribute('aria-expanded', String(!panel.hidden))
    if (!panel.hidden) {
      const exportPanel = $('#export-confirm')
      if (exportPanel) exportPanel.hidden = true
      $('#privacy-export')?.setAttribute('aria-expanded', 'false')
      $('#erase-phrase')?.focus()
    }
  })
  $('#erase-cancel')?.addEventListener('click', () => {
    const panel = $('#erase-confirm')
    if (panel) panel.hidden = true
    const opener = $('#privacy-erase')
    opener?.setAttribute('aria-expanded', 'false')
    $('#erase-phrase').value = ''
    opener?.focus()
  })
  $('#erase-confirm-btn')?.addEventListener('click', async event => {
    if (($('#erase-phrase')?.value || '').trim() !== '删除全部') {
      appendMessage('system', '请准确输入“删除全部”后再确认。')
      $('#erase-phrase')?.focus()
      return
    }
    const button = event.currentTarget
    button.disabled = true
    try {
      const result = await api('/api/privacy/erase', { method: 'POST', body: JSON.stringify({ confirm: 'ERASE ALL' }) })
      closeModal(true)
      $('#capture-strip').hidden = true
      $('#capture-image').removeAttribute('src')
      await Promise.all([refreshMemory(), refreshReminders(), refreshStatus()])
      appendMessage('system', `本机数据已删除：${result.erased?.items ?? 0} 条记忆、${result.erased?.reminders ?? 0} 个提醒。`)
    } catch (error) {
      button.disabled = false
      appendMessage('system', `删除失败：${error.message}`)
    }
  })
  $('#onboard-again')?.addEventListener('click', () => {
    if ((state.settingsDirty.model || state.settingsDirty.voice) && !window.confirm('设置里有未保存的修改，重新查看引导会丢弃它们。继续？')) return
    closeModal(true)
    localStorage.removeItem('jarvis_onboarded')
    showOnboarding()
  })
}

function modelPayload(selected) {
  return {
    id: selected.id,
    label: selected.label,
    kind: selected.kind,
    protocol: $('#model-protocol')?.value || selected.protocol || 'chat-completions',
    baseUrl: $('#model-base')?.value.trim() || '',
    model: $('#model-name')?.value || selected.model || '',
    apiKey: $('#model-key')?.value.trim() || '',
    embedModel: $('#model-embed')?.value.trim() || '',
    visionModel: $('#model-vision')?.value.trim() || '',
    keepAlive: selected.keepAlive || '24h',
  }
}

async function refreshStatus() {
  try {
    const data = await api('/api/health')
    applyStatus(data.status)
  } catch {
    // Keep the last known status.
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function setTab(name) {
  $$('.side-tab').forEach(tab => {
    const active = tab.dataset.tab === name
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', String(active))
  })
  $$('.side-content').forEach(panel => {
    const active = panel.dataset.panel === name
    panel.classList.toggle('active', active)
    panel.hidden = !active
  })
  if (name === 'memory') refreshMemory()
  if (name === 'reminders') refreshReminders()
  if (name === 'runtime') renderRuntime()
}

function bind() {
  $('#send-btn').addEventListener('click', () => sendText($('#input').value))
  $('#input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendText($('#input').value)
    }
  })
  $('#input').addEventListener('input', event => autoGrow(event.target))
  $('#stop-btn').addEventListener('click', () => {
    if (state.cancelling) return
    state.cancelling = true
    // Send exactly one cancel command. Sending both the WebSocket event and
    // the HTTP endpoint used to produce two assistant.cancelled events.
    if (!sendWs({ kind: 'cancel' })) {
      api('/api/cancel', { method: 'POST', body: '{}' }).catch(() => undefined)
    }
    clearCancelTimer()
    state.cancelling = true
    state.cancelTimer = setTimeout(() => {
      if (!state.busy || !state.cancelling) return
      finishStreaming('（已停止）')
      setBusy(false)
      state.turnViaWs = false
      state.cancelling = false
      state.cancelTimer = 0
    }, 5000)
  })
  $('#mute-btn').addEventListener('click', () => {
    state.muted = !state.muted
    localStorage.setItem('jarvis_muted', state.muted ? '1' : '0')
    $('#mute-btn').setAttribute('aria-pressed', String(state.muted))
    if (state.muted) stopAudio()
  })
  $('#mute-btn').setAttribute('aria-pressed', String(state.muted))
  $('#focus-btn').addEventListener('click', async () => {
    try {
      const data = await api('/api/focus', { method: 'POST', body: JSON.stringify({ enabled: !state.focus }) })
      state.focus = data.focus
      $('#focus-btn').setAttribute('aria-pressed', String(state.focus))
      appendMessage('system', state.focus ? '专注模式已开启；提醒只进面板，不出声。' : '专注模式已关闭。')
      renderRuntime()
    } catch (error) { appendMessage('system', error.message) }
  })
  $('#settings-btn').addEventListener('click', () => { void showSettings() })
  $('#model-pill').addEventListener('click', () => { void showSettings({ tab: 'model' }) })
  $('#modal-close').addEventListener('click', () => closeModal())
  $('#modal').addEventListener('click', event => { if (event.target === $('#modal')) closeModal() })
  $('#modal-body').addEventListener('input', event => {
    if (event.target.closest('[data-settings-panel="model"]')) markSettingsDirty('model')
    else if (event.target.closest('[data-settings-panel="voice"]')) markSettingsDirty('voice')
  })
  $('#modal-body').addEventListener('change', event => {
    if (event.target.closest('[data-settings-panel="model"]')) markSettingsDirty('model')
    else if (event.target.closest('[data-settings-panel="voice"]')) markSettingsDirty('voice')
  })
  document.addEventListener('keydown', event => {
    if (!$('#modal').hidden && $('.modal')?.classList.contains('settings-modal')) {
      if (event.key === 'Tab') trapModalFocus(event)
      if (event.key === 'Escape') {
        if (!$('#lightbox').hidden) $('#lightbox').hidden = true
        else closeModal()
        return
      }
    }
    if (event.key === 'Escape') {
      closeModal()
      $('#lightbox').hidden = true
    }
  })

  $$('.side-tab').forEach(tab => tab.addEventListener('click', () => setTab(tab.dataset.tab)))
  $('#memory-refresh').addEventListener('click', () => refreshMemory())
  $('#reminder-refresh').addEventListener('click', refreshReminders)
  $('#memory-search').addEventListener('input', event => {
    clearTimeout(memoryTimer)
    const query = event.target.value.trim()
    memoryTimer = setTimeout(() => refreshMemory(query), 260)
  })

  $('#memory-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]')
    if (!button) return
    const card = button.closest('.memory-card')
    const id = card?.dataset.id
    if (!id) return
    try {
      if (button.dataset.action === 'delete') await api(`/api/memory/${id}`, { method: 'DELETE' })
      if (button.dataset.action === 'confirm') await api(`/api/memory/${id}/confirm`, { method: 'POST', body: '{}' })
      if (button.dataset.action === 'reject') await api(`/api/memory/${id}/reject`, { method: 'POST', body: '{}' })
      await refreshMemory($('#memory-search').value.trim())
    } catch (error) { appendMessage('system', error.message) }
  })

  $$('.quick').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.action
    if (action === 'screen') sendText('看下屏幕，告诉我最值得注意的一件事。')
    if (action === 'camera') sendText('看下摄像头，看看我这边有什么。')
    if (action === 'remember') {
      const input = $('#input')
      input.value = '记住：'
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
      autoGrow(input)
    }
    if (action === 'brief') void showBrief()
  }))
  $$('.prompt-chips button').forEach(button => button.addEventListener('click', () => sendText(button.dataset.prompt)))

  const mic = $('#mic-btn')
  mic.addEventListener('pointerdown', event => {
    event.preventDefault()
    state.micHeld = true
    mic.setPointerCapture?.(event.pointerId)
    void startRecording()
  })
  mic.addEventListener('pointerup', event => {
    event.preventDefault()
    state.micHeld = false
    stopRecording()
  })
  mic.addEventListener('pointercancel', () => {
    state.micHeld = false
    stopRecording()
  })

  $('#capture-close').addEventListener('click', () => { $('#capture-strip').hidden = true })
  $('#capture-image').addEventListener('click', () => {
    if (!state.captureUrl) return
    $('#lightbox-image').src = state.captureUrl
    $('#lightbox').hidden = false
  })
  $('#lightbox-close').addEventListener('click', () => { $('#lightbox').hidden = true })
  $('#lightbox').addEventListener('click', event => { if (event.target === $('#lightbox')) $('#lightbox').hidden = true })
}


function showOnboarding() {
  localStorage.setItem('jarvis_onboarded', '1')
  const modelReady = Boolean(state.status.modelReady)
  openModal(`
    <p class="eyebrow">FIRST RUN / LOCAL FIRST</p>
    <h3>先确认三件事。</h3>
    <p>Jarvis 默认只在本机运行。麦克风只在按住时采集，屏幕和摄像头按次授权；没有账号，也没有默认上传。</p>
    <div class="onboard-grid">
      <div><b>1 · 本地模型</b><span class="${modelReady ? 'ok-text' : 'warn-text'}">${modelReady ? '已就绪，可以直接对话。' : '未就绪；先运行 npm run doctor，或到设置里配置模型。'}</span></div>
      <div><b>2 · 麦克风</b><span id="onboard-mic-result">按一次测试，确认浏览器权限。</span><button class="model-action" id="onboard-mic" type="button" style="width:auto">测试麦克风</button></div>
      <div><b>3 · 感官</b><span>看屏幕/摄像头前会再问你一次。</span><button class="model-action" id="onboard-senses" type="button" style="width:auto">查看权限说明</button></div>
    </div>
    <div class="modal-actions">
      <button class="primary" id="onboard-start" type="button">开始使用</button>
      <button id="onboard-skip" type="button">稍后</button>
    </div>
  `, '第一次使用')
  const finish = () => {
    localStorage.setItem('jarvis_onboarded', '1')
    closeModal()
    $('#input')?.focus()
  }
  $('#onboard-start').addEventListener('click', finish)
  $('#onboard-skip').addEventListener('click', finish)
  $('#onboard-mic').addEventListener('click', async event => {
    const button = event.currentTarget
    const result = $('#onboard-mic-result')
    button.disabled = true
    result.textContent = '正在请求麦克风…'
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('这个浏览器不支持录音')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(track => track.stop())
      result.textContent = '麦克风可用。按住主界面的麦克风说话即可。'
      result.className = 'ok-text'
    } catch (error) {
      result.textContent = `麦克风不可用：${error.message}`
      result.className = 'warn-text'
    } finally {
      button.disabled = false
    }
  })
  $('#onboard-senses').addEventListener('click', () => showSenseConsent())
}

function maybeOnboarding() {
  if (localStorage.getItem('jarvis_onboarded') === '1') return
  if (state.memory.length > 0 || state.reminders.length > 0) {
    localStorage.setItem('jarvis_onboarded', '1')
    return
  }
  setTimeout(() => {
    if ($('#modal').hidden && !state.busy) showOnboarding()
  }, 900)
}

function tickClock() {
  const now = new Date()
  $('#clock').textContent = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

async function main() {
  bind()
  initStudio()
  await loadVisualTuning()
  tickClock()
  setInterval(tickClock, 15000)
  await bootstrap()
  maybeOnboarding()
  // The Whisper worker warms up in the background. Poll a few times so the
  // "加载中" state clears promptly instead of waiting for the 30 s status poll.
  setTimeout(() => void refreshStatus(), 2500)
  setTimeout(() => void refreshStatus(), 7000)
  setTimeout(() => void refreshStatus(), 12000)
  connect()
  setInterval(() => {
    if (state.wsReady) sendWs({ kind: 'ping' })
  }, 25000)
  setInterval(async () => {
    try { applyStatus(await api('/api/models')) } catch { /* offline */ }
  }, 30000)
}

main()
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}
