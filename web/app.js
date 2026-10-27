import { initStudio } from './studio.js'
import { applyVisualTuning, loadVisualTuning, visualValues } from './visual.js'

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

const state = {
  bootRetry: 0,
  selectedSessionId: localStorage.getItem('jarvis_selected_session') || '',
  session: null, sessions: [], drafts: new Map(), activeTurn: null,
  snapshotToken: 0, snapshotLoading: false, snapshotDirty: false, snapshotFailed: false,
  messages: [], hasMore: false, historyOffset: 0, historyToken: 0, historyTotal: 0,
  playbackTurn: null, optimisticTurns: new Set(), turnDrafts: new Map(),
  capabilities: null,
  catalog: null,
  pendingProvider: null,
  voices: null,
  voiceSettings: null,
  voiceStatus: null,
  voiceCooldowns: { asr: {}, tts: {} },
  voiceDraft: null,
  voiceEdit: { asr: '', tts: '' },
  voicePicker: { asr: false, tts: false },
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
  sendShortcut: localStorage.getItem('jarvis_send_shortcut') === 'ctrl-enter' ? 'ctrl-enter' : 'enter',
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
  // A hung request used to disable a button forever. Give every call a bound,
  // and let callers override it for the genuinely long ones (model download,
  // voice transcription).
  const timeoutMs = options.timeoutMs ?? 30_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(path, {
      ...options,
      signal: options.signal ?? controller.signal,
      headers: authHeaders({ 'content-type': 'application/json', ...(options.headers || {}) }),
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (response.status === 401) {
    promptForToken()
    throw new Error('需要访问令牌')
  }
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!response.ok) { const error = new Error(data?.error || `HTTP ${response.status}`); error.status = response.status; throw error }
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
      setActiveTurn(payload.activeTurn ?? null)
      void refreshSelected()
    } else if (payload.kind === 'chat.result') {
      handleHttpResult(payload.result || payload, payload)
    } else if (payload.kind === 'event') {
      handleEvent(payload.event)
    } else if (payload.kind === 'error') {
      if (sameTurn(payload, state.activeTurn)) void rejectTurn(payload, payload.error || '请求被拒绝')
      else notify(payload.error || '连接出错')
    }
  })
  ws.addEventListener('close', () => {
    state.wsReady = false
    state.ws = null
    setConnection('offline')
    state.reconnect += 1
    const delay = Math.min(12000, 1200 * state.reconnect)
    setTimeout(connect, delay)
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
  const data = { ...event.data, sessionId: event.data?.sessionId || event.sessionId, turnId: event.data?.turnId || event.turnId }
  const turnEvent = /^(assistant\.|user\.message|voice\.transcribed|sense\.capture)/.test(event.type)
  if (turnEvent) {
    if (!data.sessionId || !data.turnId) return
    const terminal = event.type === 'assistant.done' || event.type === 'assistant.cancelled'
    if (!state.activeTurn && !terminal) { void refreshSelected(); return }
    if (!sameTurn(data, state.activeTurn)) return
    if (terminal) {
      if (state.snapshotLoading) state.snapshotDirty = true
      if (event.type === 'assistant.cancelled' && selectedTurn(data)) stopAudio()
      if (event.type === 'assistant.done' && selectedTurn(data)) appendToolHistoryButton(state.streamEl, data.toolUsed, data)
      if (selectedTurn(data) && !state.snapshotLoading && data.audioUrl) playAudio(data.audioUrl, data)
      setActiveTurn(null)
      updateLatency()
      void refreshSelected()
      if ($('#history-dialog').open) void loadHistory()
      return
    }
    if (state.snapshotLoading) { state.snapshotDirty = true; return }
    if (!selectedTurn(data)) return
  }
  switch (event.type) {
    case 'tool.started':
    case 'tool.result':
      if (!selectedTurn(data)) break
      if (state.snapshotLoading) { state.snapshotDirty = true; break }
      ensureStreaming()
      appendToolHistoryButton(state.streamEl, true, data)
      break
    case 'turn.start':
      if (data.sessionId && data.turnId && !sameTurn(data, state.activeTurn)) {
        setActiveTurn(data)
        void refreshSelected()
      }
      break
    case 'turn.end':
      if (sameTurn(data, state.activeTurn)) setActiveTurn(null)
      void refreshSelected()
      if ($('#history-dialog').open) void loadHistory()
      break
    case 'session.changed':
      if ($('#history-dialog').open) void loadHistory()
      if (!data.sessionId || data.sessionId === state.selectedSessionId) void refreshSelected()
      break
    case 'attention.state':
      updateAttention(data)
      break
    case 'user.message':
      if (state.optimisticTurns.has(data.turnId)) {
        state.pendingUserEcho = ''
      } else {
        state.optimisticTurns.add(data.turnId)
        appendMessage('user', data.text)
      }
      break
    case 'assistant.context':
      ensureStreaming()
      if (data.state === 'tool') {
        const reason = data.reason || '正在使用工具…'
        notify(reason)
        if (!state.streamText) state.streamEl.querySelector('.bubble').textContent = reason
      } else if (!state.streamText) state.streamEl.querySelector('.bubble').textContent = data.state === 'compacting'
        ? '正在整理较早的对话，保留近期内容…'
        : data.state === 'compacted' ? '上下文已整理，正在回答…' : (data.reason || '已按模型容量保留近期上下文，正在回答…')
      break
    case 'assistant.delta':
      state.sawAssistantEvent = true
      ensureStreaming()
      state.streamText = data.full || (state.streamText + (data.text || ''))
      state.streamEl.querySelector('.bubble').textContent = state.streamText
      scrollToBottom()
      break
    case 'assistant.audio':
      if (data.url) playAudio(data.url, data)
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
      notify(`今日简报\n${data.brief?.headline || ''}\n${(data.brief?.items || []).map(item => `· ${item.text}`).join('\n')}`)
      break
    case 'proactive.message':
      notify(`⏰ ${data.reminder?.text || '提醒你一件事'}`)
      refreshReminders()
      break
    case 'sense.capture':
      showCapture(data)
      break
    case 'model.changed':
      void refreshStatus()
      break
    case 'voice.failover': {
      const labels = { quota: '额度不足', 'rate-limit': '触发限流', auth: 'Key 被拒', network: '网络异常', server: '服务异常' }[data.failure] || '不可用'
      const kind = data.kind === 'tts' ? '语音合成' : '语音识别'
      const until = data.cooldownUntil ? new Date(data.cooldownUntil).toLocaleTimeString('zh-CN', { hour12: false }) : ''
      appendMessage('system', `🔁 ${kind} ${data.fromLabel || data.from} ${labels}，已自动切到 ${data.toLabel || data.to}${until ? `（冷却至 ${until}）` : ''}`)
      if (state.voiceSettings) {
        void api('/api/voice').then(payload => {
          state.voiceStatus = payload.status || state.voiceStatus
          state.voiceCooldowns = payload.cooldowns || state.voiceCooldowns
          if (!state.settingsDirty.voice && !$('#modal').hidden && state.settingsTab === 'voice') renderVoicePanel()
        }).catch(() => undefined)
      }
      void refreshStatus()
      break
    }
    case 'model.failover': {
      const kindLabel = { quota: '额度不足', 'rate-limit': '触发限流', auth: 'Key 被拒', network: '网络异常', server: '服务异常' }[data.kind] || '不可用'
      const to = data.to && state.modelSettings?.profiles?.find(item => item.id === data.to)?.label
      appendMessage('system', `⚡ ${data.fromLabel || data.from} ${kindLabel}，已自动切换${to ? `到 ${to}` : '到下一个可用供应商'}（冷却至 ${new Date(data.cooldownUntil).toLocaleTimeString('zh-CN', { hour12: false })}）`)
      void refreshStatus()
      break
    }
    case 'assistant.scenario': {
      const hint = $('#hint')
      if (hint && data.label) hint.textContent = `场景：${data.label}${data.pinned ? '（手动）' : '（自动）'}`
      break
    }
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

function bindPushToTalk(control) {
  let pointerHeld = false
  let lastPointerUp = 0
  const start = () => {
    if (control.disabled) return
    state.micHeld = true
    void startRecording()
  }
  const stop = () => {
    state.micHeld = false
    stopRecording()
  }
  control.addEventListener('pointerdown', event => {
    if (event.button !== undefined && event.button !== 0) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    pointerHeld = true
    control.setPointerCapture?.(event.pointerId)
    start()
  })
  control.addEventListener('pointerup', event => {
    if (!pointerHeld) return
    event.preventDefault()
    pointerHeld = false
    lastPointerUp = Date.now()
    stop()
  })
  control.addEventListener('pointercancel', () => {
    if (!pointerHeld) return
    pointerHeld = false
    lastPointerUp = Date.now()
    stop()
  })
  // A completed pointer gesture also fires click; ignore that one.
  control.addEventListener('click', () => {
    if (Date.now() - lastPointerUp < 400) return
    if (state.micHeld) stop()
    else start()
  })
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
    mic.disabled = asrStarting || state.busy || state.snapshotLoading || state.snapshotFailed || !state.session || state.session.archived
    mic.title = asrStarting ? '语音识别加载中…' : state.voice.asrState === 'error' ? '语音识别异常；仍可重试或直接打字' : '按住说话'
    mic.setAttribute('aria-label', asrStarting ? '语音识别加载中' : state.voice.asrState === 'error' ? '语音识别异常' : '按下说话')
  }
  if (orb) {
    orb.disabled = asrStarting || state.busy || state.snapshotLoading || state.snapshotFailed || !state.session || state.session.archived
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
  if (!$('#modal').hidden && $('#modal .modal')?.classList.contains('settings-modal')) updateSettingsOverview()
}

function appendMessage(role, text, options = {}) {
  if (role === 'system' && !options.historical) { notify(text); return null }
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
  $('#send-btn').disabled = state.busy || state.snapshotLoading || state.snapshotFailed || !state.session || state.session.archived
  for (const el of [$('#mic-btn'), $('#orb')]) el.disabled = state.busy || state.snapshotLoading || state.snapshotFailed || !state.session || state.session.archived || state.voice.asrState === 'starting'
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
  const consentSessionId = state.selectedSessionId
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
  $('#sense-allow').addEventListener('click', () => { closeModal(); if (pendingText && consentSessionId === state.selectedSessionId) sendText(pendingText, { skipConsent: true }) })
  $('#sense-always').addEventListener('click', () => {
    state.senseConsent = true
    localStorage.setItem('jarvis_sense_consent', '1')
    closeModal()
    if (pendingText && consentSessionId === state.selectedSessionId) sendText(pendingText, { skipConsent: true })
  })
}

function notify(text) {
  $('#session-notice').textContent = text || ''
}
function sameTurn(a, b) { return Boolean(a && b && a.sessionId === b.sessionId && a.turnId === b.turnId) }
function selectedTurn(identity) { return identity?.sessionId === state.selectedSessionId && sameTurn(identity, state.playbackTurn) }
function setActiveTurn(identity) {
  state.activeTurn = identity ? { sessionId: identity.sessionId, turnId: identity.turnId } : null
  clearCancelTimer()
  clearTurnWatchdog()
  setBusy(Boolean(identity))
  if (identity && identity.sessionId !== state.selectedSessionId) notify('另一段对话正在处理中；可以浏览历史，完成后即可发送。')
}
function canSend() {
  if (state.busy || state.snapshotLoading || state.snapshotFailed || !state.session || state.session.archived || state.recording) {
    notify(state.session?.archived ? '此对话已归档，请在历史中取消归档后继续。' : '请等待当前处理完成，或重试加载对话。')
    return false
  }
  return true
}
function beginTurn() {
  stopAudio()
  const identity = { sessionId: state.selectedSessionId, turnId: crypto.randomUUID() }
  state.playbackTurn = identity
  state.sawAssistantEvent = false
  state.pendingUserEcho = ''
  state.streamEl = null
  state.streamText = ''
  setActiveTurn(identity)
  return identity
}
async function rejectTurn(identity, message) {
  if (!sameTurn(identity, state.activeTurn)) return
  notify(message)
  // A rejection may mean a different tab owns the global engine. Only a
  // snapshot can safely unlock the composer after an uncertain request.
  await refreshSelected()
  if (identity.sessionId === state.selectedSessionId) {
    notify(message)
    const draft = state.turnDrafts.get(identity.turnId)
    if (draft && !state.messages.some(m => m.turnId === identity.turnId) && !$('#input').value) {
      $('#input').value = draft; state.drafts.set(identity.sessionId, draft); autoGrow($('#input'))
    }
  }
  state.turnDrafts.delete(identity.turnId)
}
async function selectSession(id) {
  if (state.selectedSessionId) state.drafts.set(state.selectedSessionId, $('#input').value)
  state.recordToken++
  if (state.recording) { state.recording.onstop = null; stopRecording() }
  stopAudio()
  state.selectedSessionId = id
  localStorage.setItem('jarvis_selected_session', id)
  state.session = null
  state.messages = []
  state.hasMore = false
  $('#messages-more').hidden = true
  state.playbackTurn = null
  state.streamEl = null
  state.streamText = ''
  state.pendingUserEcho = ''
  state.sawAssistantEvent = false
  $('#input').value = state.drafts.get(id) || ''
  autoGrow($('#input'))
  $('#capture-strip').hidden = true
  $('#session-title').textContent = '加载对话…'
  $('#transcript').replaceChildren()
  await refreshSelected()
}
async function refreshSelected(older = false) {
  const id = state.selectedSessionId
  if (!id) return
  const token = ++state.snapshotToken
  state.snapshotLoading = true
  state.snapshotDirty = false
  state.snapshotFailed = false
  setBusy(state.busy)
  $('#session-retry').hidden = true
  $('#messages-more').disabled = true
  const before = older && state.messages.length ? Math.min(...state.messages.map(m => m.id)) : null
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(id)}?limit=100${before ? `&before=${before}` : ''}`)
    if (token !== state.snapshotToken || id !== state.selectedSessionId) return
    state.session = data.session
    state.messages = older ? [...data.messages.items, ...state.messages] : data.messages.items
    state.messages = [...new Map(state.messages.map(m => [m.id, m])).values()].sort((a, b) => a.id - b.id)
    state.hasMore = data.messages.hasMore
    setActiveTurn(data.activeTurn)
    if (data.activeTurn?.sessionId === id) state.playbackTurn = { ...data.activeTurn }
    renderMessages(older)
    $('#session-title').textContent = data.session.title || '新对话'
    $('#session-title').title = data.session.title || '新对话'
    if (!state.busy) notify(data.session.archived ? '已归档 · 在历史中取消归档后可继续对话' : '')
  } catch (error) {
    if (token !== state.snapshotToken) return
    if (error.status === 404) {
      state.selectedSessionId = ''
      localStorage.removeItem('jarvis_selected_session')
      state.session = null
      try {
        const data = await api('/api/sessions?limit=50&offset=0&archived=false')
        if (data.items.length) await selectSession(data.items[0].id)
        else await createSession()
        notify('原对话已删除，已打开可用对话。')
      } catch (fallback) { notify(fallback.message); $('#session-retry').hidden = false; state.snapshotFailed = true }
      return
    }
    state.snapshotFailed = true
    notify(`对话加载失败：${error.message}`)
    $('#session-retry').hidden = false
  } finally {
    if (token === state.snapshotToken) {
      state.snapshotLoading = false
      setBusy(state.busy)
      $('#messages-more').disabled = false
      if (state.snapshotDirty) { state.snapshotDirty = false; void refreshSelected() }
    }
  }
}
function appendToolHistoryButton(article, toolUsed, identity) {
  const count = Array.isArray(toolUsed) ? toolUsed.length : typeof toolUsed === 'number' ? toolUsed : toolUsed ? 1 : 0
  if (!article || !count || !identity.sessionId || !identity.turnId || article.querySelector('[data-tool-history]')) return
  const sessionId = identity.sessionId, turnId = identity.turnId
  const button = document.createElement('button')
  button.type = 'button'; button.className = 'text-btn'; button.dataset.toolHistory = 'true'
  button.textContent = '查看本次工具调用'; button.setAttribute('aria-haspopup', 'dialog')
  button.addEventListener('click', () => window.dispatchEvent(new CustomEvent('jarvis:tools-open', { detail: { sessionId, turnId } })))
  article.querySelector('.bubble')?.append(button)
}
function renderMessages(older = false) {
  const transcript = $('#transcript')
  const previousHeight = transcript.scrollHeight
  const previousTop = transcript.scrollTop
  transcript.replaceChildren()
  state.streamEl = null
  state.streamText = ''
  state.optimisticTurns.clear()
  const statuses = { streaming: '生成中', cancelled: '已停止', error: '出错', interrupted: '连接中断' }
  for (const message of state.messages) {
    if (message.role === 'user') state.optimisticTurns.add(message.turnId)
    const article = appendMessage(message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant', message.content, {
      historical: true, error: message.status === 'error',
      meta: `${new Date(message.createdAt).toLocaleString('zh-CN')} ${statuses[message.status] || ''}`,
    })
    article.dataset.messageId = String(message.id)
    article.dataset.turnId = message.turnId || ''
    if (message.role === 'assistant') appendToolHistoryButton(article, message.metadata?.toolUsed, { sessionId: message.sessionId || state.selectedSessionId, turnId: message.turnId })
    const profileUsed = message.metadata?.profileUsed
    if (message.role === 'assistant' && Array.isArray(profileUsed) && profileUsed.length) {
      const used = document.createElement('button')
      used.type = 'button'; used.className = 'text-btn'
      used.textContent = `本次参考了 ${profileUsed.length} 项个人资料`
      used.addEventListener('click', () => window.dispatchEvent(new CustomEvent('jarvis:profile-open', { detail: { ids: profileUsed } })))
      article.querySelector('.bubble').append(used)
    }
    if (message.role === 'assistant' && message.status === 'streaming' && sameTurn(message, state.activeTurn)) {
      state.streamEl = article
      state.streamText = message.content || ''
      article.querySelector('.bubble').classList.add('streaming')
    }
  }
  if (!state.messages.length) {
    const empty = document.createElement('p'); empty.className = 'history-empty'; empty.textContent = '新的对话，从一句话开始。'; transcript.append(empty)
  }
  $('#messages-more').hidden = !state.hasMore
  transcript.scrollTop = older ? previousTop + transcript.scrollHeight - previousHeight : transcript.scrollHeight
}
async function createSession() {
  $('#session-new').disabled = true
  try {
    const data = await api('/api/sessions', { method: 'POST', body: '{}' })
    await selectSession(data.session.id)
    $('#input').focus()
    if ($('#history-dialog').open) void loadHistory()
  } catch (error) { notify(`新建失败：${error.message}`) }
  finally { $('#session-new').disabled = false }
}
async function loadHistory() {
  const token = ++state.historyToken
  $('#history-status').textContent = '正在加载…'
  $('#history-retry').hidden = true
  const params = new URLSearchParams({ query: $('#history-search').value.trim(), limit: '50', offset: String(state.historyOffset), archived: $('#history-filter').value })
  try {
    const data = await api(`/api/sessions?${params}`)
    if (token !== state.historyToken) return
    if (!data.items.length && state.historyOffset) { state.historyOffset = Math.max(0, state.historyOffset - 50); return loadHistory() }
    state.historyTotal = data.total
    $('#history-status').textContent = data.total ? `共 ${data.total} 段对话` : '没有符合条件的对话'
    $('#history-page').textContent = `${Math.floor(state.historyOffset / 50) + 1} / ${Math.max(1, Math.ceil(data.total / 50))}`
    $('#history-prev').disabled = state.historyOffset === 0
    $('#history-next').disabled = state.historyOffset + 50 >= data.total
    const list = $('#history-list'); list.replaceChildren()
    for (const session of data.items) {
      const row = document.createElement('article'); row.className = 'history-row'
      if (session.id === state.selectedSessionId) row.classList.add('selected')
      const open = document.createElement('button'); open.type = 'button'; open.className = 'history-session'
      const title = document.createElement('strong'); title.textContent = session.title || '新对话'
      const preview = document.createElement('span'); preview.textContent = session.preview || '暂无消息'
      const meta = document.createElement('small'); meta.textContent = `${new Date(session.updatedAt).toLocaleString('zh-CN')} · ${session.messageCount} 条消息${session.id === state.selectedSessionId ? ' · 当前对话' : ''}`
      open.append(title, preview, meta); open.addEventListener('click', () => { $('#history-dialog').close(); void selectSession(session.id) })
      const actions = document.createElement('div'); actions.className = 'history-row-actions'
      for (const [label, action] of [['重命名', 'rename'], [session.archived ? '取消归档' : '归档', 'archive'], ['导出', 'export'], ['删除', 'delete']]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'text-btn'; button.textContent = label; button.setAttribute('aria-label', `${label}：${session.title}`)
        button.addEventListener('click', () => void sessionAction(session, action, button)); actions.append(button)
      }
      row.append(open, actions); list.append(row)
    }
  } catch (error) { if (token === state.historyToken) { $('#history-status').textContent = `加载失败：${error.message}`; $('#history-retry').hidden = false } }
}
function confirmHistory(title, copy, value = null, required = '') {
  const dialog = $('#history-confirm'); const input = $('#history-confirm-input')
  $('#history-confirm-title').textContent = title
  $('#history-confirm-copy').textContent = copy
  $('#history-confirm-error').textContent = ''
  $('#history-confirm-label').textContent = value !== null ? '对话标题' : required ? `请输入 ${required}` : ''
  input.hidden = value === null && !required
  input.value = value || ''; input.maxLength = value !== null ? 120 : 100
  dialog.showModal()
  if (!input.hidden) input.focus(); else $('#history-confirm-cancel').focus()
  return new Promise(resolve => {
    let result = null
    dialog.onclose = () => { $('#history-confirm-form').onsubmit = null; resolve(result) }
    $('#history-confirm-cancel').onclick = () => dialog.close()
    $('#history-confirm-form').onsubmit = event => {
      event.preventDefault()
      if ((value !== null && !input.value.trim()) || (required && input.value !== required)) { $('#history-confirm-error').textContent = '请准确填写后再确认。'; return }
      result = value !== null ? input.value.trim() : true; dialog.close()
    }
  })
}
async function sessionAction(session, action, button) {
  button.disabled = true
  const path = `/api/sessions/${encodeURIComponent(session.id)}`
  try {
    if (action === 'rename') {
      const title = await confirmHistory('重命名对话', '修改标题不会改变消息内容。', session.title)
      if (title === null) return
      await api(path, { method: 'PATCH', body: JSON.stringify({ title }) })
    } else if (action === 'archive') {
      await api(path, { method: 'PATCH', body: JSON.stringify({ archived: !session.archived }) })
    } else if (action === 'delete') {
      if (!await confirmHistory('删除对话？', `“${session.title}”及其全部消息将被永久删除，无法撤销。`)) return
      await api(path, { method: 'DELETE' })
      state.drafts.delete(session.id)
    } else if (action === 'export') {
      const response = await fetch(`${path}/export`, { headers: authHeaders() })
      if (!response.ok) throw new Error(`导出失败：HTTP ${response.status}`)
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a')
      link.href = url; link.download = `jarvis-session-${session.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      return
    }
    if (session.id === state.selectedSessionId) await refreshSelected()
    await loadHistory()
  } catch (error) { $('#history-status').textContent = error.message }
  finally { button.disabled = false }
}
function bindHistory() {
  $('#session-new').addEventListener('click', () => void createSession())
  $('#session-retry').addEventListener('click', () => { if (state.selectedSessionId) void refreshSelected(); else void bootstrap() })
  $('#messages-more').addEventListener('click', () => void refreshSelected(true))
  $('#history-open').addEventListener('click', () => { $('#history-dialog').showModal(); void loadHistory() })
  $('#history-close').addEventListener('click', () => $('#history-dialog').close())
  $('#history-retry').addEventListener('click', () => void loadHistory())
  let timer
  $('#history-search').addEventListener('input', () => { clearTimeout(timer); state.historyOffset = 0; timer = setTimeout(loadHistory, 250) })
  $('#history-filter').addEventListener('change', () => { state.historyOffset = 0; void loadHistory() })
  $('#history-prev').addEventListener('click', () => { state.historyOffset = Math.max(0, state.historyOffset - 50); void loadHistory() })
  $('#history-next').addEventListener('click', () => { state.historyOffset += 50; void loadHistory() })
  $('#history-clear').addEventListener('click', async () => {
    if (!await confirmHistory('清空全部对话？', '这会永久删除所有对话，包括已归档的对话。此操作无法撤销。', null, 'DELETE ALL SESSIONS')) return
    try {
      const data = await api('/api/sessions', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE ALL SESSIONS' }) })
      state.drafts.clear(); await selectSession(data.session.id); await loadHistory()
    } catch (error) { $('#history-status').textContent = error.message }
  })
}

function sendText(text, options = {}) {
  const clean = text.trim()
  if (!clean || !canSend()) return
  if (!options.skipConsent && !state.senseConsent && looksLikeSenseRequest(clean)) { showSenseConsent(clean); return }
  const identity = beginTurn()
  $('#input').value = ''
  state.drafts.delete(identity.sessionId)
  autoGrow($('#input'))
  state.optimisticTurns.add(identity.turnId)
  state.turnDrafts.set(identity.turnId, clean)
  appendMessage('user', clean)
  const payload = { text: clean, ...identity, scenario: currentScenarioPin() }
  state.turnViaWs = sendWs({ kind: 'chat', ...payload })
  if (!state.turnViaWs) api('/api/chat', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 180000 })
    .then(result => handleHttpResult(result, identity)).catch(error => rejectTurn(identity, error.message))
}

function handleHttpResult(result, identity) {
  if (!sameTurn(identity, state.activeTurn)) {
    if (!state.activeTurn && identity?.sessionId === state.selectedSessionId) void refreshSelected()
    return
  }
  if (selectedTurn(identity) && result.audioUrl && !result.audioSpoken && !state.sawAssistantEvent) playAudio(result.audioUrl, identity)
  state.turnDrafts.delete(identity.turnId)
  if (result.error) notify(result.error)
  setActiveTurn(null)
  updateLatency()
  void refreshSelected()
}

function sendWs(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false
  state.ws.send(JSON.stringify(payload))
  return true
}

async function bootstrap() {
  try {
    const data = await api('/api/bootstrap')
    state.sessions = data.sessions?.items || []
    setActiveTurn(data.activeTurn ?? null)
    const selected = state.selectedSessionId || data.defaultSessionId || state.sessions[0]?.id
    if (selected) await selectSession(selected)
    else await createSession()
    state.memory = data.memory || []
    state.reminders = data.reminders || []
    state.actions = data.actions || []
    applyStatus(data.status)
    updateAttention(data.attention)
    // Not awaited: the composer must not wait for the guide catalogue.
    void loadCatalog()
    renderMemory()
    renderReminders()
    renderRuntime()
    if (state.actions.length) setTimeout(() => showAction(state.actions[0]), 450)
  } catch (error) {
    // A transient failure used to leave an empty page with no way back.
    appendMessage('system', `初始化失败：${error.message}。3 秒后自动重试。`)
    clearTimeout(state.bootRetry)
    state.bootRetry = setTimeout(() => { void bootstrap() }, 3000)
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

/**
 * The action prompt has its own overlay: reusing the settings modal would
 * throw away whatever the person was editing when a proposal arrived.
 */
function openActionModal(html) {
  state.actionOpener = document.activeElement
  $('#action-body').innerHTML = html
  $('#action-modal').hidden = false
  requestAnimationFrame(() => $('#action-approve')?.focus({ preventScroll: true }))
}

function closeActionModal() {
  if ($('#action-modal').hidden) return
  $('#action-modal').hidden = true
  $('#action-body').innerHTML = ''
  state.actionOpener?.focus?.()
}

function showAction(action) {
  if (!action || action.status !== 'proposed') return
  const title = action.kind === 'open-url' ? '打开网页' : '打开应用'
  const target = escapeHtml(action.target)
  const label = escapeHtml(action.label || action.target)
  openActionModal(`
    <h3>需要你确认的一次性动作</h3>
    <p>${title}：<strong>${label}</strong></p>
    <div class="action-target">${target}</div>
    <p>只有你点“允许一次”才会执行；确认 60 秒后过期，不会自动重试。</p>
    <div class="modal-actions">
      <button class="primary" id="action-approve" type="button">允许一次</button>
      <button id="action-deny" type="button">拒绝</button>
    </div>
  `)
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
    closeActionModal()
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
    closeActionModal()
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

function playAudio(url, identity = state.playbackTurn) {
  if (state.muted || !url || !selectedTurn(identity)) return
  state.audioQueue.push({ url, identity: { ...identity } })
  if (!state.audioPlaying) playNextAudio()
}

function playNextAudio() {
  const player = $('#player')
  const item = state.audioQueue.shift()
  if (!item) {
    state.audioPlaying = false
    return
  }
  if (!selectedTurn(item.identity)) { playNextAudio(); return }
  state.audioPlaying = true
  player.onended = playNextAudio
  player.onerror = playNextAudio
  player.src = item.url
  player.play().catch(() => {
    if (!selectedTurn(item.identity)) return
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
  if (!canSend()) return
  const sessionId = state.selectedSessionId
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
    if (!state.micHeld || token !== state.recordToken || sessionId !== state.selectedSessionId || state.busy) {
      stream.getTracks().forEach(track => track.stop())
      return
    }
    state.mediaStream = stream
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type)) || ''
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    const chunks = []
    recorder.addEventListener('dataavailable', event => { if (event.data.size > 0) chunks.push(event.data) })
    recorder.addEventListener('stop', () => void finishRecording(chunks, recorder.mimeType, sessionId, token))
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

async function finishRecording(chunks, mimeType, sessionId, token) {
  if (token !== state.recordToken || sessionId !== state.selectedSessionId || !canSend()) return
  const blob = new Blob(chunks, { type: mimeType || 'audio/webm' })
  if (blob.size < 600) {
    $('#hint').textContent = '太短了，再说一次'
    return
  }
  const identity = beginTurn()
  $('#hint').textContent = state.voice.asrState === 'starting' ? '语音模型加载中，正在排队识别…' : '正在识别…'
  try {
    const response = await fetch(`/api/voice?${new URLSearchParams({ ...identity, scenario: currentScenarioPin() || 'auto' })}`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': blob.type || 'audio/webm' }),
      body: blob,
      // Local transcription of a long clip is slow but not infinite.
      signal: AbortSignal.timeout(120_000),
    })
    if (response.status === 401) {
      promptForToken()
      throw new Error('需要访问令牌')
    }
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)
    if (sameTurn(identity, state.activeTurn) && selectedTurn(identity)) $('#hint').textContent = '本地推理 · 默认不录屏'
    handleHttpResult(result, identity)
  } catch (error) {
    void rejectTurn(identity, `语音没走通：${error.message}`)
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
    <div class="search-row"><input id="token-input" type="password" placeholder="粘贴令牌" autocomplete="off" aria-label="访问令牌"></div>
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
        const result = await api('/api/brief/read', { method: 'POST', body: '{}', timeoutMs: 90_000 })
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
  $('#modal .modal').classList.toggle('settings-modal', options.className === 'settings-modal')
  $('#modal').classList.toggle('settings-open', options.className === 'settings-modal')
  if (options.focus !== false) {
    requestAnimationFrame(() => {
      const target = options.focusSelector ? $(options.focusSelector) : $('#modal .modal')
      target?.focus?.({ preventScroll: true })
    })
  }
}

function trapModalFocus(event, root = $('#modal .modal')) {
  const modal = root
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
  if (!force && !$('#modal').hidden && $('#modal .modal')?.classList.contains('settings-modal') && dirty) {
    if (!window.confirm('设置里有未保存的修改，关闭后会丢失。确定关闭？')) return
  }
  state.settingsLoadToken += 1
  $('#modal').hidden = true
  $('#modal .modal')?.classList.remove('settings-modal')
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

function normalizeEndpoint(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * Match a saved profile back to the public catalogue so the form can offer
 * curated ids (vision/embedding especially) before any network call.
 */
function catalogEntryFor(profile) {
  const list = state.catalog || []
  if (!profile) return null
  const base = normalizeEndpoint(profile.baseUrl)
  if (base) {
    const byBase = list.find(item => item.kind === profile.kind && normalizeEndpoint(item.baseUrl) === base)
    if (byBase) return byBase
  }
  return profile.kind === 'ollama' ? list.find(item => item.id === 'ollama') || null : null
}

function catalogModelList(profile, field) {
  return (catalogEntryFor(profile)?.[field] || []).filter(Boolean)
}

function modelNameOptions(selected) {
  const curated = catalogModelList(selected, 'models')
  const fetched = (state.modelOptions[selected.id] || []).map(item => typeof item === 'string' ? item : item.name).filter(Boolean)
  // Fetched ids come from the service; listing does not guarantee call access.
  const names = [...new Set([
    ...(selected.model ? [selected.model] : []),
    ...fetched,
    ...curated,
  ])]
  if (!names.length) return `<option value="">${selected.kind === 'openai' && !profileReachable(selected) ? '填写 Key 后获取模型' : '正在获取模型列表…'}</option>`
  return names.map(name => `<option value="${escapeHtml(name)}" ${name === selected.model ? 'selected' : ''}>${escapeHtml(name)}${fetched.includes(name) ? ' · 服务返回' : curated.includes(name) ? ' · 参考预设' : ' · 当前配置'}</option>`).join('')
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
  const tabs = [['model', '模型'], ['voice', '语音'], ['appearance', '外观'], ['access', '设备'], ['system', '系统']]
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
  const profiles = settings.profiles || []
  const priority = Array.isArray(settings.priority) && settings.priority.length ? settings.priority : profiles.map(item => item.id)
  const ordered = [...profiles].sort((a, b) => {
    const ia = priority.indexOf(a.id)
    const ib = priority.indexOf(b.id)
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
  })
  const cooldowns = settings.cooldowns || {}
  const now = Date.now()
  return ordered.map((profile, index) => {
    const current = profile.id === settings.active
    const selected = profile.id === selectedId
    const reachable = profileReachable(profile)
    const kind = profile.kind === 'openai' ? protocolLabel(profile.protocol) : 'OLLAMA · 本机'
    const cooldown = cooldowns[profile.id]
    const parked = cooldown && cooldown.until > now
    const parkedUntil = parked ? new Date(cooldown.until).toLocaleTimeString('zh-CN', { hour12: false }) : ''
    const deletable = profile.id !== 'local' && !current
    return `<div class="provider-card${selected ? ' selected' : ''}${current ? ' active' : ''}" data-model-card="${escapeHtml(profile.id)}">
      <button type="button" class="provider-main" data-model-select="${escapeHtml(profile.id)}" aria-pressed="${selected}" title="编辑 ${escapeHtml(profile.label)}">
        <span class="provider-top">
          <span class="provider-title"><small class="provider-rank" title="故障转移优先级">#${index + 1}</small> ${escapeHtml(profile.label)}</span>
          <span class="provider-badge ${parked ? 'muted' : current ? 'current' : reachable ? 'ready' : 'muted'}">${parked ? `冷却至 ${parkedUntil}` : current ? '使用中' : reachable ? '可启用' : '待配置'}</span>
        </span>
        <span class="provider-model">${escapeHtml(profile.model || '未配置模型')}</span>
        <span class="provider-meta">${escapeHtml(kind)}${profile.baseUrl ? ` · ${escapeHtml(profile.baseUrl)}` : ''}</span>
        ${parked ? `<span class="provider-meta cooldown" title="${escapeHtml(cooldown.reason || '')}">自动切换原因：${escapeHtml(cooldown.kind || '')}</span>` : ''}
      </button>
      <div class="provider-foot">
        <span class="provider-tools">
          <button type="button" class="model-action quiet" data-model-up="${escapeHtml(profile.id)}" ${index === 0 ? 'disabled' : ''} title="提高优先级">↑</button>
          <button type="button" class="model-action quiet" data-model-down="${escapeHtml(profile.id)}" ${index === ordered.length - 1 ? 'disabled' : ''} title="降低优先级">↓</button>
        </span>
        <button type="button" class="model-action${current ? ' quiet' : ''}" data-model-activate="${escapeHtml(profile.id)}" ${current || !reachable ? 'disabled' : ''}>${current ? '已启用' : reachable ? '启用' : '先填 Key'}</button>
        ${deletable ? `<button type="button" class="model-action quiet danger" data-model-delete="${escapeHtml(profile.id)}" title="删除该供应商">删除</button>` : ''}
      </div>
    </div>`
  }).join('')
}

function scenarioRowHtml(scenario, orderedProfiles, profiles) {
  const chain = scenario.profileIds && scenario.profileIds.length ? scenario.profileIds : []
  const chainText = chain.length
    ? chain.map(id => profiles.find(item => item.id === id)?.label || id).join(' → ')
    : '跟随全局优先级'
  return `<details class="scenario-row" data-scenario="${escapeHtml(scenario.id)}"${scenario.custom ? ' data-custom="1"' : ''}>
    <summary>
      <span class="scenario-title">${escapeHtml(scenario.label)}${scenario.custom ? ' <small class="scenario-custom-tag">自定义</small>' : ''}</span>
      <span class="scenario-meta">${escapeHtml(chainText)}${scenario.model ? ` · ${escapeHtml(scenario.model)}` : ''}${scenario.temperature !== null && scenario.temperature !== undefined ? ` · T=${scenario.temperature}` : ''}</span>
    </summary>
    <div class="scenario-body">
      <div class="scenario-row-head">
        <label class="scenario-enable-control">
          <span class="scenario-enable-copy"><strong>启用场景</strong><small>参与自动识别</small></span>
          <input type="checkbox" role="switch" class="scenario-enabled" ${scenario.enabled ? 'checked' : ''}>
          <span class="scenario-switch-track" aria-hidden="true"></span>
        </label>
        ${scenario.custom ? `<button type="button" class="model-action quiet danger scenario-delete" title="删除该自定义场景">删除场景</button>` : ''}
      </div>
      ${scenario.custom ? `<label class="settings-field"><span>名称</span><input type="text" class="scenario-label" value="${escapeHtml(scenario.label)}" maxlength="32"></label>` : ''}
      <fieldset class="scenario-chain-field">
        <legend>供应商链</legend>
        <p class="scenario-chain-help">按全局优先级依次使用；不选择时跟随全局设置。</p>
        <div class="scenario-chain">
          ${orderedProfiles.map(profile => `<label class="scenario-chain-item"><input type="checkbox" class="scenario-profile" value="${escapeHtml(profile.id)}" ${chain.includes(profile.id) ? 'checked' : ''}><span>${escapeHtml(profile.label)}</span></label>`).join('')}
        </div>
      </fieldset>
      <div class="settings-form-grid">
        <label class="settings-field"><span>模型覆盖 <em>可选</em></span>
          <input type="text" class="scenario-model" value="${escapeHtml(scenario.model || '')}" placeholder="留空用供应商默认模型" autocomplete="off" spellcheck="false">
        </label>
        <label class="settings-field"><span>温度 <em>可选</em></span>
          <input type="number" class="scenario-temperature" min="0" max="2" step="0.1" value="${scenario.temperature ?? ''}" placeholder="默认">
        </label>
      </div>
      <label class="settings-field"><span>自动识别关键词（逗号分隔）</span>
        <input type="text" class="scenario-patterns" value="${escapeHtml((scenario.patterns || []).join('，'))}" placeholder="留空不参与自动识别" autocomplete="off">
      </label>
      <label class="settings-field"><span>场景提示词（注入系统提示）</span>
        <textarea class="scenario-extra" rows="2" maxlength="4000">${escapeHtml(scenario.systemExtra || '')}</textarea>
      </label>
    </div>
  </details>`
}

function scenarioCardHtml(settings) {
  const scenarios = settings.scenarios || []
  const profiles = settings.profiles || []
  const priority = Array.isArray(settings.priority) && settings.priority.length ? settings.priority : profiles.map(item => item.id)
  const orderedProfiles = [...profiles].sort((a, b) => {
    const ia = priority.indexOf(a.id)
    const ib = priority.indexOf(b.id)
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
  })
  const rows = scenarios.map(scenario => scenarioRowHtml(scenario, orderedProfiles, profiles)).join('')
  return `<div class="settings-card" id="scenario-card">
    <div class="settings-card-head">
      <div><h4>工作场景</h4><p>参考 ChatGPT / Claude Code / 办公助手的场景设计：每个场景有独立的供应商链、模型、温度和提示词；自动识别按消息内容判断，也可在输入框旁手动指定。</p></div>
    </div>
    <div class="scenario-toolbar">
      <label class="scenario-auto"><input type="checkbox" id="scenario-auto" ${settings.scenarioAuto !== false ? 'checked' : ''}> 自动识别场景</label>
      <label class="scenario-default">默认场景
        <select id="scenario-default">
          ${scenarios.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === settings.defaultScenario ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
        </select>
      </label>
      <button type="button" class="model-action" id="scenario-add">+ 自定义场景</button>
      <button type="button" class="model-action primary" id="scenario-save">保存场景</button>
      <span class="settings-feedback" id="scenario-result" role="status"></span>
    </div>
    <div id="scenario-list">${rows}</div>
  </div>`
}

function addProviderCardHtml() {
  return `<div class="settings-card" id="provider-add-card">
    <div class="settings-card-head">
      <div><h4>添加供应商</h4><p>保存后进入优先级列表，参与额度/故障自动切换。</p></div>
    </div>
    <div class="settings-form-grid">
      <label class="settings-field"><span>名称</span><input id="add-label" type="text" maxlength="32" placeholder="例如 Groq 免费层" autocomplete="off"></label>
      <label class="settings-field"><span>接口协议</span>
        <select id="add-protocol">
          <option value="chat-completions">OpenAI Chat Completions</option>
          <option value="responses">OpenAI Responses</option>
          <option value="anthropic">Anthropic Messages</option>
        </select>
      </label>
      <label class="settings-field wide"><span>Base URL</span><input id="add-base" type="url" placeholder="https://api.groq.com/openai/v1" autocomplete="off" spellcheck="false"></label>
      <label class="settings-field"><span>模型</span><input id="add-model" type="text" list="add-model-list" placeholder="先测试连接从列表选择" autocomplete="off" spellcheck="false"></label>
      <datalist id="add-model-list">${[...new Set((state.catalog || []).flatMap(item => item.models || []))].slice(0, 80).map(name => `<option value="${escapeHtml(name)}"></option>`).join('')}</datalist>
      <label class="settings-field"><span>API Key</span><input id="add-key" type="password" autocomplete="new-password" placeholder="sk-..."></label>
    </div>
    <div class="settings-actions">
      <button type="button" class="model-action primary" id="provider-add">添加</button>
      <span class="settings-feedback" id="provider-add-result" role="status"></span>
    </div>
  </div>`
}

function modelHintText(profile) {
  const entry = catalogEntryFor(profile)
  const parts = []
  if (entry?.embeddingModels?.length) parts.push(`常见向量：${entry.embeddingModels.slice(0, 3).map(name => `\`${name}\``).join('、')}`)
  if (entry?.visionModels?.length) parts.push(`常见视觉：${entry.visionModels.slice(0, 3).map(name => `\`${name}\``).join('、')}`)
  if (entry?.modelNote) parts.push(entry.modelNote)
  parts.push('留空时回退到本地 Ollama；远端向量只用于 standard 级记忆，敏感记忆永不出网。')
  return parts.join(' ')
}

function modelFormHtml(selected) {
  const remote = selected.kind === 'openai'
  const keyHint = selected.hasKey ? '已保存；留空保持不变' : isLoopbackUrl(selected.baseUrl) ? '可选（localhost 服务）' : '粘贴 API Key'
  const advancedOpen = Boolean(selected.embedModel || selected.visionModel || selected.supportsTools)
  const visionHints = catalogModelList(selected, 'visionModels')
  const embedHints = catalogModelList(selected, 'embeddingModels')
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
      <label class="settings-field wide"><span>模型 <em>服务返回 / 参考预设，调用权限以控制台为准</em></span>
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
      <summary>高级：工具调用、上下文容量、记忆向量与视觉模型</summary>
      <label class="scenario-auto"><input id="model-supports-tools" type="checkbox" ${selected.supportsTools === true ? 'checked' : ''}> 此模型支持工具调用</label>
      <p class="settings-hint">默认关闭。仅在模型和接口确实支持工具调用时启用；工具的权限与资料去向仍分别检查。</p>
      <div class="settings-form-grid">
        <label class="settings-field"><span>上下文容量（tokens）</span>
          <input id="model-context-window" type="number" min="2048" max="2000000" step="1" value="${Number(selected.contextWindow) || 4096}">
          <small>按模型实际支持的容量填写；未知时使用 4096。会自动预留回答空间。</small>
        </label>
        <label class="settings-field"><span>记忆向量模型 <em>可选</em></span>
          <input id="model-embed" type="text" list="model-embed-list" autocomplete="off" spellcheck="false" value="${escapeHtml(selected.embedModel || '')}" placeholder="nomic-embed-text">
          <datalist id="model-embed-list">${embedHints.map(name => `<option value="${escapeHtml(name)}"></option>`).join('')}</datalist>
        </label>
        <label class="settings-field"><span>视觉模型 <em>可选</em></span>
          <input id="model-vision" type="text" list="model-vision-list" autocomplete="off" spellcheck="false" value="${escapeHtml(selected.visionModel || '')}" placeholder="qwen2.5vl:3b">
          <datalist id="model-vision-list">${visionHints.map(name => `<option value="${escapeHtml(name)}"></option>`).join('')}</datalist>
        </label>
      </div>
      <p class="settings-hint">${escapeHtml(modelHintText(selected))}</p>
    </details>
    <p class="settings-hint">Base URL 只填域名或完整端点都可以。远端必须 HTTPS；只有 localhost 可用 HTTP。Key 只存本机 <code>data/model-config.json</code>（0600），不会回显。</p>
    <div class="settings-actions">
      <button type="button" class="model-action" id="model-test">测试连接</button>
      <button type="button" class="model-action primary" id="model-apply">保存并切换</button>
      <span class="settings-feedback" id="model-result" role="status"></span>
    </div>
  </div>`
}

const VOICE_KIND_LABEL = { asr: '语音识别', tts: '语音合成' }
const VOICE_ADAPTER_LABEL = {
  auto: '自动识别', openai: 'OpenAI 兼容', gemini: 'Gemini 原生', cloudflare: 'Cloudflare 原生', edge: 'Edge TTS',
}
const VOICE_PRESET_IDS = {
  asr: ['siliconflow-sensevoice', 'groq-whisper', 'openai-whisper', 'dashscope-paraformer', 'gemini-audio', 'cloudflare-whisper', 'selfhosted-funasr', 'local-faster-whisper'],
  tts: ['edge-tts', 'siliconflow-cosyvoice', 'openai-tts', 'gemini-tts', 'cloudflare-tts', 'groq-tts', 'selfhosted-openai-tts', 'local-piper'],
}

/** Work on a copy: cancelling the sheet must not mutate the saved settings. */
function cloneVoiceChain(chain) {
  return (chain || []).map(entry => ({ ...entry }))
}

function ensureVoiceDraft() {
  if (state.voiceDraft) return state.voiceDraft
  const settings = state.voiceSettings || { asr: [], tts: [] }
  state.voiceDraft = { asr: cloneVoiceChain(settings.asr), tts: cloneVoiceChain(settings.tts) }
  if (!state.voiceEdit) state.voiceEdit = { asr: '', tts: '' }
  for (const kind of ['asr', 'tts']) {
    const chain = state.voiceDraft[kind]
    if (!chain.find(entry => entry.id === state.voiceEdit[kind])) state.voiceEdit[kind] = chain[0]?.id || ''
  }
  return state.voiceDraft
}

function resetVoiceDraft() {
  state.voiceDraft = null
  state.voiceEdit = { asr: '', tts: '' }
  state.voicePicker = { asr: false, tts: false }
  ensureVoiceDraft()
}

function voiceEntry(kind, id) {
  return ensureVoiceDraft()[kind].find(entry => entry.id === id)
}

function uniqueVoiceId(kind, base) {
  const chain = ensureVoiceDraft()[kind]
  const seed = /^[a-z0-9-]{1,24}$/.test(base) ? base : 'voice'
  if (!chain.some(entry => entry.id === seed)) return seed
  for (let index = 2; index < 50; index += 1) {
    const candidate = `${seed}-${index}`
    if (!chain.some(entry => entry.id === candidate)) return candidate
  }
  return `voice-${Date.now().toString(36)}`
}

function voiceCooling(kind, id) {
  const entry = state.voiceCooldowns?.[kind]?.[id]
  return entry && entry.until > Date.now() ? entry : null
}

function voiceChainHtml(kind) {
  const chain = ensureVoiceDraft()[kind]
  const serving = state.voiceStatus?.serving?.[kind]
  const rows = chain.map((entry, index) => {
    const cooling = voiceCooling(kind, entry.id)
    const detail = kind === 'asr'
      ? `${entry.model || '—'}${entry.kind === 'local' ? '' : ` · ${entry.transport === 'websocket' ? 'WebSocket' : 'HTTP'}`}`
      : `${entry.model || '—'}${entry.voice ? ` · ${entry.voice}` : ''}`
    return `<li class="voice-chain-row${state.voiceEdit[kind] === entry.id ? ' editing' : ''}" data-voice-row="${escapeHtml(entry.id)}">
      <span class="voice-chain-order" aria-hidden="true">${index + 1}</span>
      <div class="voice-chain-main">
        <div class="voice-chain-title">
          <strong>${escapeHtml(entry.label || entry.id)}</strong>
          <span class="voice-chain-badge">${entry.kind === 'local' ? '本地引擎' : escapeHtml(VOICE_ADAPTER_LABEL[entry.adapter] || entry.adapter || '自动识别')}</span>
          ${index === 0 ? '<span class="voice-chain-preferred">首选</span>' : ''}
          ${serving === entry.id ? '<span class="voice-chain-live" title="最近一次请求由它处理">运行中</span>' : ''}
          ${cooling ? `<span class="voice-chain-cooling" title="${escapeHtml(cooling.reason || '')}">冷却至 ${new Date(cooling.until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>` : ''}
        </div>
        <div class="voice-chain-meta">${escapeHtml(detail)}${entry.kind === 'local' ? '' : entry.hasKey === false && !entry.apiKey ? ' · 未填 Key' : ''}</div>
      </div>
      <div class="voice-chain-actions">
        <button type="button" class="voice-icon" data-voice-move="up" data-voice-kind="${kind}" data-voice-id="${escapeHtml(entry.id)}" aria-label="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="voice-icon" data-voice-move="down" data-voice-kind="${kind}" data-voice-id="${escapeHtml(entry.id)}" aria-label="下移" ${index === chain.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="voice-icon" data-voice-edit="${kind}" data-voice-id="${escapeHtml(entry.id)}" aria-label="编辑">✎</button>
        <button type="button" class="voice-icon danger" data-voice-remove="${kind}" data-voice-id="${escapeHtml(entry.id)}" aria-label="删除" ${chain.length <= 1 ? 'disabled' : ''}>✕</button>
      </div>
    </li>`
  }).join('')
  const coolingCount = chain.filter(entry => voiceCooling(kind, entry.id)).length
  return `<div class="voice-chain-head">
      <span class="voice-chain-count">${chain.length} 个服务${coolingCount ? ` · ${coolingCount} 个冷却中` : ''}</span>
      <button type="button" class="voice-add" data-voice-add="${kind}">+ 添加${VOICE_KIND_LABEL[kind]}</button>
    </div>
    <ol class="voice-chain" id="voice-chain-${kind}" aria-label="${VOICE_KIND_LABEL[kind]}优先级">${rows}</ol>
    <p class="settings-hint">从上到下依次尝试。额度不足、Key 失效、限流、网络或服务端错误会自动切到下一个，并把它冷却一段时间；参数写错（4xx）不会静默切换。</p>
    ${state.voicePicker?.[kind] ? voicePresetHtml(kind) : ''}`
}

function voicePresetHtml(kind) {
  const presets = (state.voices || []).filter(entry => entry.kind === kind)
    .filter(entry => VOICE_PRESET_IDS[kind].includes(entry.id))
    .sort((a, b) => VOICE_PRESET_IDS[kind].indexOf(a.id) - VOICE_PRESET_IDS[kind].indexOf(b.id))
  if (!presets.length) {
    return `<div class="voice-preset-row" data-voice-picker="${kind}"><span class="settings-hint">常见预设未加载，点“添加”会创建一个空白远端服务，手动填写即可。</span>
      <button type="button" class="voice-add" data-voice-blank="${kind}">空白远端服务</button></div>`
  }
  const buttons = presets.map(entry => `<button type="button" class="voice-preset" data-voice-preset-kind="${kind}" data-voice-preset-id="${escapeHtml(entry.id)}">${escapeHtml(entry.name)}</button>`).join('')
  return `<div class="voice-preset-row" data-voice-picker="${kind}">
    <span class="voice-presets-label">常见预设</span>${buttons}
    <button type="button" class="voice-add" data-voice-blank="${kind}">空白远端服务</button>
    <a class="voice-presets-more" href="/providers#voice" target="_blank" rel="noopener">全部语音服务 ↗</a>
  </div>`
}

function voiceHintsFor(kind, entry) {
  const list = (state.voices || []).filter(item => item.kind === kind)
  const candidates = list.filter(item => entry.kind === 'local'
    ? !item.baseUrl && item.adapter !== 'edge'
    : entry.adapter === 'edge'
      ? item.adapter === 'edge'
      : Boolean(entry.baseUrl) && normalizeEndpoint(item.baseUrl) === normalizeEndpoint(entry.baseUrl)
        && (!entry.adapter || entry.adapter === 'auto' || entry.adapter === item.adapter))
  const found = candidates.find(item => item.id === entry.id)
    || candidates.find(item => item.models?.includes(entry.model))
    || (candidates.length === 1 ? candidates[0] : null)
  return {
    models: (found?.models || (entry.model ? [entry.model] : [])).filter(Boolean),
    voices: (found?.voices || (entry.voice ? [entry.voice] : [])).filter(Boolean),
  }
}

function voiceFormHtml(kind) {
  const entry = voiceEntry(kind, state.voiceEdit[kind])
  if (!entry) return ''
  const local = entry.kind === 'local'
  const hints = voiceHintsFor(kind, entry)
  const datalists = `<datalist id="${kind}-model-list">${hints.models.map(name => `<option value="${escapeHtml(name)}"></option>`).join('')}</datalist>
    <datalist id="${kind}-voice-list">${hints.voices.map(name => `<option value="${escapeHtml(name)}"></option>`).join('')}</datalist>`
  const adapters = kind === 'asr'
    ? [['auto', '自动识别（按服务地址）'], ['openai', 'OpenAI 兼容'], ['gemini', 'Google Gemini（原生音频）'], ['cloudflare', 'Cloudflare Workers AI']]
    : [['auto', '自动识别（按服务地址）'], ['openai', 'OpenAI 兼容'], ['gemini', 'Google Gemini（原生 TTS）'], ['cloudflare', 'Cloudflare Workers AI'], ['edge', 'Edge TTS（本机命令，免费）']]
  const field = (name, label, value, options = {}) => {
    const attrs = `data-voice-field="${name}" data-voice-kind="${kind}"`
    if (name === 'adapter') {
      return `<label class="settings-field"><span>服务商</span><select ${attrs} id="${kind}-adapter">${adapters.map(([valueId, name]) => `<option value="${valueId}" ${String(value || 'auto') === valueId ? 'selected' : ''}>${name}</option>`).join('')}</select></label>`
    }
    if (name === 'transport') {
      const disabled = entry.adapter === 'gemini' || entry.adapter === 'cloudflare'
      return `<label class="settings-field"><span>传输方式</span><select ${attrs} id="${kind}-transport" ${disabled ? 'disabled' : ''}>
        <option value="websocket" ${value !== 'http' ? 'selected' : ''}>WebSocket 流式</option>
        <option value="http" ${value === 'http' ? 'selected' : ''}>HTTP 一次性上传</option></select></label>`
    }
    if (name === 'apiKey') {
      const hint = entry.hasKey ? '已保存；留空保持不变' : '粘贴 API Key'
      return `<label class="settings-field"><span>API Key</span><input ${attrs} type="password" autocomplete="new-password" value="" placeholder="${hint}" ${options.id ? `id="${options.id}"` : ''}></label>`
    }
    const type = name === 'baseUrl' ? 'url' : 'text'
    const extra = name === 'baseUrl' ? 'autocomplete="off" spellcheck="false"' : ''
    const list = options.list ? ` list="${options.list}"` : ''
    return `<label class="settings-field"><span>${label}</span><input ${attrs} type="${type}" ${extra}${list} value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(options.placeholder || '')}" ${options.id ? `id="${options.id}"` : ''}></label>`
  }
  const header = `<div class="voice-form-head">
      <strong>${local ? '本地引擎' : '远端服务'} · ${escapeHtml(entry.label || entry.id)}</strong>
      <button type="button" class="voice-add" data-voice-cancel="${kind}">收起</button>
    </div>`
  if (local) {
    return `<div class="voice-form" data-voice-form="${kind}">${header}
      ${field('label', '名称', entry.label, { id: `${kind}-label` })}
      <div class="settings-form-grid">
        ${field('model', '模型', entry.model, { placeholder: kind === 'asr' ? 'small' : 'piper', id: `${kind}-model`, list: `${kind}-model-list` })}
        ${kind === 'asr' ? field('language', '语言', entry.language, { id: `${kind}-language` }) : field('voice', '音色', entry.voice, { id: `${kind}-voice`, list: `${kind}-voice-list` })}
      </div>
      ${datalists}
      <p class="settings-hint">本地引擎不出网、无调用费${kind === 'asr' ? '；首次识别要加载模型，会慢几秒' : '；音色数量取决于本机安装的模型'}。</p>
    </div>`
  }
  const keyField = kind === 'tts' && entry.adapter === 'edge' ? '' : field('apiKey', 'API Key', '', { id: `${kind}-key` })
  const baseField = kind === 'tts' && entry.adapter === 'edge'
    ? '<p class="settings-hint">Edge TTS 调用本机命令行，不需要地址和 Key。</p>'
    : field('baseUrl', '服务地址', entry.baseUrl, { id: `${kind}-base`, placeholder: 'https://api.openai.com/v1' })
  return `<div class="voice-form" data-voice-form="${kind}">${header}
    ${field('label', '名称', entry.label, { id: `${kind}-label`, placeholder: '例如 硅基流动' })}
    <div class="settings-form-grid">
      ${field('adapter', '服务商', entry.adapter || 'auto')}
      ${kind === 'asr' ? field('transport', '传输方式', entry.transport) : ''}
    </div>
    ${baseField}
    <div class="settings-form-grid">
      ${field('model', '模型', entry.model, { placeholder: kind === 'asr' ? 'whisper-1' : 'tts-1', id: `${kind}-model`, list: `${kind}-model-list` })}
      ${kind === 'asr' ? field('language', '语言', entry.language, { id: `${kind}-language` }) : field('voice', '音色', entry.voice, { placeholder: 'alloy / Kore / zh-CN-XiaoxiaoNeural', id: `${kind}-voice`, list: `${kind}-voice-list` })}
    </div>
    ${keyField}
  </div>
  ${datalists}`
}

function voicePanelHtml() {
  ensureVoiceDraft()
  const status = state.voiceStatus
  return `<div class="settings-section-head">
      <div><h3>语音模型</h3><p>ASR 与 TTS 各自是一条优先级链，可以配多个服务；前一个失效时自动切换。</p></div>
      <span class="settings-chip">${ensureVoiceDraft().asr.length + ensureVoiceDraft().tts.length} 个服务</span>
    </div>
    <div class="voice-grid">
      <div class="voice-card" data-voice-card="asr">
        <div class="voice-card-head"><div><span class="voice-kicker">ASR</span><strong>语音识别</strong></div></div>
        ${voiceChainHtml('asr')}
        ${voiceFormHtml('asr')}
      </div>
      <div class="voice-card" data-voice-card="tts">
        <div class="voice-card-head"><div><span class="voice-kicker">TTS</span><strong>语音合成</strong></div></div>
        ${voiceChainHtml('tts')}
        ${voiceFormHtml('tts')}
      </div>
    </div>
    <div class="settings-savebar">
      <span class="settings-inline-dirty" id="voice-dirty" ${state.settingsDirty.voice ? '' : 'hidden'}>未保存</span>
      <span class="settings-feedback" id="voice-result" role="status"></span>
      <button type="button" class="model-action primary" id="voice-save">保存语音设置</button>
    </div>`
}

function voiceSettingsHtml(settings) {
  return voicePanelHtml()
}


function settingsPanelsHtml(selected, settings) {
  return `
    <section class="settings-panel" id="settings-panel-model" data-settings-panel="model" role="tabpanel" aria-labelledby="settings-tab-model">
      <div class="settings-section-head">
        <div><h3>对话模型</h3><p>选择本地 Ollama 或远端服务；模型列表会从服务地址自动读取。</p></div>
        <span class="settings-chip">${state.status?.provider === 'remote' ? '远端运行中' : '本地运行中'}</span>
      </div>
      <div class="provider-guide">
        <div>
          <p class="provider-guide-title">还没选好供应商？</p>
          <p class="settings-hint">国内直连、国际、本机模型，一页看完价格与三步接入。</p>
        </div>
        <div class="provider-guide-actions">
          <a class="model-action" href="/providers" target="_blank" rel="noopener">打开供应商指南</a>
          <button class="model-action" type="button" id="provider-guide-inline">就地选一个</button>
        </div>
      </div>
      <div class="provider-quick" id="provider-quick" hidden></div>
      ${state.settingsError ? `<p class="settings-error">模型配置读取失败：${escapeHtml(state.settingsError)}。下面是可用的本地默认项，保存前请确认服务已恢复。</p>` : ''}
      <div class="provider-grid" id="provider-grid"></div>
      <div id="model-form-host"></div>
      ${addProviderCardHtml()}
      ${state.modelSettings ? scenarioCardHtml(state.modelSettings) : ''}
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
    <section class="settings-panel" id="settings-panel-appearance" data-settings-panel="appearance" role="tabpanel" aria-labelledby="settings-tab-appearance" hidden>
      <div class="settings-section-head">
        <div><h3>外观与主题</h3><p>颜色、动效、密度保存到服务端，所有设备保持一致；深色/浅色只影响当前浏览器。</p></div>
      </div>
      <div id="appearance-host">${appearanceCardHtml()}</div>
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
        <p class="settings-hint">手机浏览器可直接使用本页；详细证书和反向代理步骤见 <code>docs/operations.md</code> 第 5 节。</p>
      </div>
    </section>
    <section class="settings-panel" id="settings-panel-system" data-settings-panel="system" role="tabpanel" aria-labelledby="settings-tab-system" hidden>
      <div class="settings-section-head">
        <div><h3>系统状态</h3><p>当前运行态、隐私操作和诊断入口。</p></div>
        <span class="settings-chip">${state.status?.focus ? '专注模式' : '正常'}</span>
      </div>
      <div class="settings-stat-grid" id="settings-runtime">${settingsRuntimeHtml()}</div>
      <div class="settings-card">
        <div class="settings-card-head"><div><h4>工具与 MCP</h4><p>管理连接、工具权限和资料去向，查看待批准的调用。</p></div></div>
        <div class="settings-actions"><button type="button" class="model-action" id="tools-open" aria-haspopup="dialog">管理工具与 MCP</button></div>
      </div>
      <div class="settings-card">
        <div class="settings-card-head"><div><h4>安装与平台</h4><p>装成 App、在手机上用，以及这台机器支持哪些能力。</p></div></div>
        <div class="settings-actions">
          <a class="model-action" href="/install" target="_blank" rel="noopener">安装到这台设备</a>
          <a class="model-action" href="/providers" target="_blank" rel="noopener">模型服务指南</a>
          <a class="model-action" href="/pair" target="_blank" rel="noopener">配对手机</a>
        </div>
        <ul class="capability-list" id="capability-list">${capabilityListHtml()}</ul>
      </div>
      <div class="settings-card">
        <div class="settings-card-head"><div><h4>隐私与数据</h4><p>屏幕按次授权，摄像头只取单帧，记忆默认只存本机。</p></div></div>
        <p class="settings-hint">模型上下文不包含标记为 sensitive / secret 的记忆。远端模型仍会收到当前对话和普通记忆；屏幕/摄像头画面默认不会发往远端（需服务端显式 JARVIS_ALLOW_REMOTE_VISION=1），切换前请确认服务商政策。</p>
        <details class="settings-advanced">
          <summary>感官权限说明</summary>
          <p class="settings-hint">屏幕走 XDG Desktop Portal，每次按需授权；摄像头只取单帧；原生 Wayland 不读取帧缓冲、不持续录屏。采集前会显示状态，原图不进入长期记忆。</p>
        </details>
        <div class="settings-actions">
          <button class="model-action" id="privacy-export" type="button" aria-expanded="false" aria-controls="export-confirm">导出全部数据</button>
          <button class="model-action danger" id="privacy-erase" type="button" aria-expanded="false" aria-controls="erase-confirm">擦除全部本机数据</button>
        </div>
        <div class="erase-confirm" id="export-confirm" hidden>
          <p>导出文件包含全部记忆（包括 sensitive/secret）、情景、提醒、设备列表和不含密钥的配置摘要；只保存到可信位置。</p>
          <div class="device-pair-row">
            <button class="model-action primary" id="export-confirm-btn" type="button">确认导出</button>
            <button class="model-action" id="export-cancel" type="button">取消</button>
          </div>
        </div>
        <div class="erase-confirm" id="erase-confirm" hidden>
          <p>擦除会清空记忆、提醒、动作审计、语音、画面、日志和观察台历史；同时重置已保存的模型/语音供应商（连同远端 API Key）、清空对话历史并断开所有连接。不可撤销，建议先导出。</p>
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

const ACCENT_SWATCHES = [
  [145, '竹绿'], [168, '青玉'], [195, '湖蓝'], [220, '黛蓝'], [230, '靛紫'],
]

function appearanceCardHtml() {
  const v = visualValues
  const presets = (state.tuningSnapshot?.presets || []).filter(preset => preset.id !== 'balanced' || true)
  const themeMode = window.JarvisTheme?.mode || 'dark'
  return `<div class="settings-card" id="appearance-card">
    <div class="settings-card-head"><div><h4>主题</h4><p>顶栏的 ☾/☀ 按钮也可以循环切换。</p></div>
      <div class="segmented" id="appearance-theme" role="radiogroup" aria-label="主题">
        ${[['dark', '深色'], ['light', '浅色'], ['auto', '跟随系统']].map(([mode, label]) => `<button type="button" class="segment${themeMode === mode ? ' active' : ''}" data-theme-mode="${mode}" role="radio" aria-checked="${themeMode === mode}">${label}</button>`).join('')}
      </div>
    </div>
    <div class="settings-form-grid">
      <label class="settings-field wide"><span>发送快捷键</span>
        <select id="send-shortcut">
          <option value="enter" ${state.sendShortcut === 'enter' ? 'selected' : ''}>Enter 发送 · Shift+Enter 换行</option>
          <option value="ctrl-enter" ${state.sendShortcut === 'ctrl-enter' ? 'selected' : ''}>Ctrl+Enter 发送 · Enter 换行</option>
        </select>
      </label>
    </div>
    <p class="settings-hint" id="send-shortcut-status" role="status">立即生效，自动保存在当前浏览器。</p>
    <div class="settings-card-head"><div><h4>预设</h4><p>一键切换整套视觉参数。</p></div></div>
    <div class="appearance-presets">
      ${presets.map(preset => `<button type="button" class="model-action appearance-preset" data-preset="${escapeHtml(preset.id)}" title="${escapeHtml(preset.description || '')}">${escapeHtml(preset.label)}</button>`).join('')}
    </div>
    <div class="settings-form-grid">
      <div class="settings-field wide"><span>强调色</span>
        <div class="appearance-swatches">
          ${ACCENT_SWATCHES.map(([hue, name]) => `<button type="button" class="appearance-swatch${Math.round(Number(v['ui.accentHue'])) === hue ? ' active' : ''}" data-hue="${hue}" style="--swatch-h:${hue}" title="${name}（色相 ${hue}°）" aria-label="${name}"></button>`).join('')}
        </div>
      </div>
      <label class="settings-field"><span>动效等级</span>
        <select id="appearance-motion">
          <option value="full" ${v['ui.motion'] === 'full' ? 'selected' : ''}>完整</option>
          <option value="subtle" ${v['ui.motion'] === 'subtle' ? 'selected' : ''}>减弱</option>
          <option value="off" ${v['ui.motion'] === 'off' ? 'selected' : ''}>关闭</option>
        </select>
      </label>
      <label class="settings-field"><span>信息密度</span>
        <select id="appearance-density">
          <option value="comfortable" ${v['ui.density'] === 'comfortable' ? 'selected' : ''}>舒适</option>
          <option value="compact" ${v['ui.density'] === 'compact' ? 'selected' : ''}>紧凑</option>
        </select>
      </label>
      <label class="settings-field"><span>文字比例 <em id="appearance-textscale-value">${Number(v['ui.textScale']).toFixed(2)}×</em></span>
        <input id="appearance-textscale" type="range" min="0.85" max="1.15" step="0.01" value="${Number(v['ui.textScale'])}">
      </label>
      <label class="settings-field"><span>环境粒子 <em id="appearance-particles-value">${Number(v['ui.particles'])}</em></span>
        <input id="appearance-particles" type="range" min="0" max="60" step="1" value="${Number(v['ui.particles'])}">
      </label>
      <label class="settings-field"><span>背景氛围 <em id="appearance-ambient-value">${Number(v['ui.ambient']).toFixed(2)}</em></span>
        <input id="appearance-ambient" type="range" min="0" max="1" step="0.05" value="${Number(v['ui.ambient'])}">
      </label>
    </div>
    <div class="settings-actions">
      <button type="button" class="model-action" id="appearance-reset">恢复外观默认</button>
      <span class="settings-feedback" id="appearance-result" role="status"></span>
    </div>
  </div>`
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
  const valid = ['model', 'voice', 'appearance', 'access', 'system']
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
  const movePriority = async (id, direction) => {
    const settings = state.modelSettings
    if (!settings) return
    const order = [...(settings.priority?.length ? settings.priority : settings.profiles.map(item => item.id))]
    const index = order.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= order.length) return
    ;[order[index], order[target]] = [order[target], order[index]]
    try {
      const data = await api('/api/model/priority', { method: 'POST', body: JSON.stringify({ priority: order }) })
      state.modelSettings = data.settings
      renderProviderCards()
      renderScenarioCard()
      showModelNotice(`优先级已更新：${order.map((pid, i) => `${i + 1}.${settings.profiles.find(item => item.id === pid)?.label || pid}`).join(' → ')}`, 'ok')
    } catch (error) {
      showModelNotice(`优先级保存失败：${error.message}`, 'bad')
    }
  }
  $$('[data-model-up]').forEach(button => {
    button.addEventListener('click', () => movePriority(button.dataset.modelUp, -1))
  })
  $$('[data-model-down]').forEach(button => {
    button.addEventListener('click', () => movePriority(button.dataset.modelDown, 1))
  })
  $$('[data-model-delete]').forEach(button => {
    button.addEventListener('click', async () => {
      const id = button.dataset.modelDelete
      const profile = state.modelSettings?.profiles.find(item => item.id === id)
      if (!window.confirm(`删除供应商「${profile?.label || id}」？它的 API Key 会一并移除。`)) return
      try {
        const data = await api('/api/model/profile/delete', { method: 'POST', body: JSON.stringify({ id }) })
        state.modelSettings = data.settings
        if (state.modelFormId === id) state.modelFormId = data.settings.active
        renderProviderCards()
        renderModelForm()
        renderScenarioCard()
        showModelNotice('已删除', 'ok')
      } catch (error) {
        showModelNotice(`删除失败：${error.message}`, 'bad')
      }
    })
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

function renderScenarioCard() {
  const host = $('#scenario-card')
  if (!host || !state.modelSettings) return
  const wrapper = host.parentElement
  if (!wrapper) return
  const template = document.createElement('template')
  template.innerHTML = scenarioCardHtml(state.modelSettings).trim()
  host.replaceWith(template.content.firstElementChild)
  bindScenarioCard()
}

function scenarioRowFromDom(row) {
  const temperatureRaw = row.querySelector('.scenario-temperature')?.value
  const patternsRaw = row.querySelector('.scenario-patterns')?.value || ''
  return {
    id: row.dataset.scenario,
    label: row.querySelector('.scenario-label')?.value.trim(),
    enabled: Boolean(row.querySelector('.scenario-enabled')?.checked),
    profileIds: [...row.querySelectorAll('.scenario-profile:checked')].map(input => input.value),
    model: row.querySelector('.scenario-model')?.value.trim() || '',
    temperature: temperatureRaw === '' ? null : Number(temperatureRaw),
    systemExtra: row.querySelector('.scenario-extra')?.value || '',
    patterns: patternsRaw.split(/[,，]/).map(item => item.trim()).filter(Boolean),
  }
}

function bindScenarioCard() {
  const save = $('#scenario-save')
  if (!save || save.dataset.bound) return
  save.dataset.bound = '1'

  $('#scenario-add')?.addEventListener('click', () => {
    const list = $('#scenario-list')
    if (!list || !state.modelSettings) return
    const profiles = state.modelSettings.profiles || []
    const priority = state.modelSettings.priority?.length ? state.modelSettings.priority : profiles.map(item => item.id)
    const orderedProfiles = [...profiles].sort((a, b) => priority.indexOf(a.id) - priority.indexOf(b.id))
    const draft = {
      id: `s-${Date.now().toString(36)}`,
      label: '新场景',
      profileIds: [], model: '', temperature: null, maxTokens: null,
      systemExtra: '', patterns: [], enabled: true, custom: true,
    }
    const template = document.createElement('template')
    template.innerHTML = scenarioRowHtml(draft, orderedProfiles, profiles).trim()
    const row = template.content.firstElementChild
    row.open = true
    list.appendChild(row)
    bindScenarioRowDeletes(list)
    markSettingsDirty('model')
  })

  bindScenarioRowDeletes($('#scenario-list'))

  save.addEventListener('click', async () => {
    const rows = [...document.querySelectorAll('#scenario-list [data-scenario]')]
    const scenarios = rows.map(scenarioRowFromDom)
    if (scenarios.some(item => item.label !== undefined && !item.label)) {
      const result = $('#scenario-result')
      if (result) { result.textContent = '自定义场景需要名称'; result.className = 'settings-feedback bad' }
      return
    }
    const result = $('#scenario-result')
    save.disabled = true
    try {
      const data = await api('/api/model/scenarios', {
        method: 'POST',
        body: JSON.stringify({
          scenarios,
          scenarioAuto: Boolean($('#scenario-auto')?.checked),
          defaultScenario: $('#scenario-default')?.value,
        }),
      })
      state.modelSettings = data.settings
      renderScenarioCard()
      renderScenarioSelect()
      clearSettingsDirty('model')
      // renderScenarioCard() replaced the card, so the old reference is detached;
      // write the confirmation into the live element instead.
      const fresh = $('#scenario-result')
      if (fresh) { fresh.textContent = '场景已保存'; fresh.className = 'settings-feedback ok' }
    } catch (error) {
      const fresh = $('#scenario-result')
      if (fresh) { fresh.textContent = `保存失败：${error.message}`; fresh.className = 'settings-feedback bad' }
    } finally {
      const live = $('#scenario-save')
      if (live) live.disabled = false
    }
  })
}

function bindScenarioRowDeletes(scope) {
  scope?.querySelectorAll('.scenario-delete').forEach(button => {
    if (button.dataset.bound) return
    button.dataset.bound = '1'
    button.addEventListener('click', () => {
      const row = button.closest('[data-scenario]')
      if (row && window.confirm('删除这个自定义场景？')) {
        row.remove()
        markSettingsDirty('model')
      }
    })
  })
}

function bindAddProvider() {
  const button = $('#provider-add')
  if (!button || button.dataset.bound) return
  button.dataset.bound = '1'
  button.addEventListener('click', async () => {
    const result = $('#provider-add-result')
    const label = $('#add-label')?.value.trim()
    const baseUrl = $('#add-base')?.value.trim()
    const model = $('#add-model')?.value.trim()
    const apiKey = $('#add-key')?.value.trim()
    const protocol = $('#add-protocol')?.value
    if (!label || !baseUrl || !model) {
      if (result) { result.textContent = '名称、Base URL、模型都要填'; result.className = 'settings-feedback bad' }
      return
    }
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || `p${Date.now().toString(36)}`
    button.disabled = true
    try {
      const data = await api('/api/model/profile/add', {
        method: 'POST',
        body: JSON.stringify({ id, label, kind: 'openai', protocol, baseUrl, model, apiKey }),
      })
      state.modelSettings = data.settings
      state.modelFormId = id
      renderProviderCards()
      renderModelForm()
      renderScenarioCard()
      showModelNotice(`已添加 ${label}，建议点「测试连接」确认可用`, 'ok')
      if (result) { result.textContent = ''; }
      $('#add-label').value = ''
      $('#add-base').value = ''
      $('#add-model').value = ''
      $('#add-key').value = ''
    } catch (error) {
      if (result) { result.textContent = `添加失败：${error.message}`; result.className = 'settings-feedback bad' }
    } finally {
      button.disabled = false
    }
  })
}

async function loadScenarioOptions() {
  if (state.modelSettings?.scenarios?.length) {
    renderScenarioSelect()
    return
  }
  try {
    const data = await api('/api/model')
    if (!state.modelSettings?.scenarios?.length) state.modelSettings = data.settings
    renderScenarioSelect()
  } catch {
    // Keep the auto-only selector; settings can still be opened manually.
  }
}

function renderScenarioSelect() {
  const select = $('#scenario-select')
  if (!select) return
  const scenarios = state.modelSettings?.scenarios || []
  const current = select.value || 'auto'
  select.innerHTML = '<option value="auto">场景 · 自动</option>'
    + scenarios.filter(item => item.enabled).map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join('')
  select.value = [...select.options].some(option => option.value === current) ? current : 'auto'
}

function currentScenarioPin() {
  const value = $('#scenario-select')?.value
  return value && value !== 'auto' ? value : undefined
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
  bindScenarioCard()
  bindAddProvider()
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

function bindAppearance() {
  const card = $('#appearance-card')
  if (!card || card.dataset.bound) return
  card.dataset.bound = '1'
  const result = $('#appearance-result')
  $('#send-shortcut')?.addEventListener('change', event => {
    state.sendShortcut = event.target.value === 'ctrl-enter' ? 'ctrl-enter' : 'enter'
    updateSendShortcutHint()
    try {
      localStorage.setItem('jarvis_send_shortcut', state.sendShortcut)
      $('#send-shortcut-status').textContent = '已保存，立即生效。'
    } catch {
      $('#send-shortcut-status').textContent = '已生效，但浏览器阻止了保存；刷新后需要重新选择。'
    }
  })
  card.querySelectorAll('#appearance-theme .segment').forEach(button => {
    button.addEventListener('click', () => {
      window.JarvisTheme?.set(button.dataset.themeMode)
      card.querySelectorAll('#appearance-theme .segment').forEach(item => {
        const active = item === button
        item.classList.toggle('active', active)
        item.setAttribute('aria-checked', String(active))
      })
    })
  })
  const note = (text, kind = 'ok') => {
    if (result) { result.textContent = text; result.className = `settings-feedback ${kind}`.trim() }
  }
  const persist = async values => {
    applyVisualTuning({ ...visualValues, ...values })
    try {
      const data = await api('/api/tuning', { method: 'PUT', body: JSON.stringify({ values }) })
      state.tuningSnapshot = data.tuning || state.tuningSnapshot
      note('已保存，全设备生效')
    } catch (error) {
      note(`保存失败：${error.message}`, 'bad')
    }
  }
  card.querySelectorAll('.appearance-preset').forEach(button => {
    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        const data = await api('/api/tuning/preset', { method: 'POST', body: JSON.stringify({ id: button.dataset.preset }) })
        state.tuningSnapshot = data.tuning || state.tuningSnapshot
        applyVisualTuning(data.values || {})
        const host = $('#appearance-host')
        if (host) { host.innerHTML = appearanceCardHtml(); bindAppearance() }
        note(`已应用「${button.textContent}」预设`)
      } catch (error) {
        note(`预设失败：${error.message}`, 'bad')
      } finally {
        button.disabled = false
      }
    })
  })
  card.querySelectorAll('.appearance-swatch').forEach(button => {
    button.addEventListener('click', () => {
      card.querySelectorAll('.appearance-swatch').forEach(item => item.classList.toggle('active', item === button))
      void persist({ 'ui.accentHue': Number(button.dataset.hue) })
    })
  })
  $('#appearance-motion')?.addEventListener('change', event => void persist({ 'ui.motion': event.target.value }))
  $('#appearance-density')?.addEventListener('change', event => void persist({ 'ui.density': event.target.value }))
  const slider = (id, key, format) => {
    const input = $(`#appearance-${id}`)
    const label = $(`#appearance-${id}-value`)
    if (!input) return
    let timer = 0
    input.addEventListener('input', () => {
      const value = Number(input.value)
      if (label) label.textContent = format(value)
      applyVisualTuning({ ...visualValues, [key]: value })
      clearTimeout(timer)
      timer = setTimeout(() => void persist({ [key]: value }), 350)
    })
  }
  slider('textscale', 'ui.textScale', v => `${v.toFixed(2)}×`)
  slider('particles', 'ui.particles', v => String(v))
  slider('ambient', 'ui.ambient', v => v.toFixed(2))
  $('#appearance-reset')?.addEventListener('click', async event => {
    const button = event.currentTarget
    button.disabled = true
    try {
      const data = await api('/api/tuning/reset', { method: 'POST', body: JSON.stringify({ group: 'appearance' }) })
      state.tuningSnapshot = data.tuning || state.tuningSnapshot
      applyVisualTuning(data.values || {})
      const host = $('#appearance-host')
      if (host) { host.innerHTML = appearanceCardHtml(); bindAppearance() }
      note('外观已恢复默认')
    } catch (error) {
      note(`重置失败：${error.message}`, 'bad')
    } finally {
      button.disabled = false
    }
  })
}

function applyVoiceAdapterDefaults(entry, kind) {
  const adapter = entry.adapter || 'auto'
  if (adapter === 'gemini') {
    if (!entry.baseUrl) entry.baseUrl = 'https://generativelanguage.googleapis.com/v1beta'
    if (!entry.model) entry.model = kind === 'asr' ? 'gemini-2.0-flash' : 'gemini-2.5-flash-preview-tts'
    if (kind === 'tts' && !entry.voice) entry.voice = 'Kore'
    if (kind === 'asr') entry.transport = 'http'
  } else if (adapter === 'cloudflare') {
    if (!entry.baseUrl) entry.baseUrl = 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1'
    if (!entry.model) entry.model = kind === 'asr' ? '@cf/openai/whisper' : '@cf/myshell-ai/melotts'
    if (kind === 'tts' && !entry.voice) entry.voice = 'zh'
    if (kind === 'asr') entry.transport = 'http'
  } else if (adapter === 'edge') {
    entry.baseUrl = ''
    entry.apiKey = ''
    if (!entry.model) entry.model = 'edge-tts'
    if (!entry.voice) entry.voice = 'zh-CN-XiaoxiaoNeural'
  }
}

function renderVoicePanel() {
  const panel = $('#settings-panel-voice')
  if (!panel) return
  panel.innerHTML = voicePanelHtml()
  const dirty = $('#voice-dirty')
  if (dirty) dirty.hidden = !state.settingsDirty.voice
}

function voiceProfileFromCatalog(entry) {
  const kind = entry.kind
  const local = !entry.baseUrl && entry.adapter !== 'edge'
  return {
    id: uniqueVoiceId(kind, local ? 'local' : entry.id),
    label: entry.name.slice(0, 64),
    kind: local ? 'local' : 'remote',
    transport: entry.transport || 'http',
    baseUrl: entry.baseUrl,
    model: entry.model,
    voice: entry.voice || '',
    language: entry.language || 'zh',
    adapter: entry.adapter || 'auto',
    apiKey: '',
    hasKey: false,
  }
}

function addVoiceEntry(kind, entry, options = {}) {
  const chain = ensureVoiceDraft()[kind]
  chain.unshift(entry)
  state.voiceEdit[kind] = entry.id
  state.voicePicker[kind] = false
  markSettingsDirty('voice')
  renderVoicePanel()
  const form = document.querySelector(`[data-voice-form="${kind}"]`)
  form?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  form?.classList.add('flash')
  setTimeout(() => form?.classList.remove('flash'), 1600)
  const key = document.getElementById(`${kind}-key`)
  if (key) key.focus({ preventScroll: true })
  else $('#voice-save')?.focus({ preventScroll: true })
  const result = $('#voice-result')
  if (result && options.notice) {
    result.textContent = options.notice
    result.className = 'settings-feedback ok'
  }
}

async function saveVoiceSettings() {
  const button = $('#voice-save')
  const result = $('#voice-result')
  const original = button?.textContent || '保存语音设置'
  if (button) { button.disabled = true; button.textContent = '保存中…' }
  if (result) { result.textContent = '正在校验并切换语音运行时…'; result.className = 'settings-feedback' }
  const chain = ensureVoiceDraft()
  const strip = entry => {
    const { hasKey, ...rest } = entry
    if (!rest.apiKey) delete rest.apiKey
    return rest
  }
  try {
    const data = await api('/api/voice/apply', {
      method: 'POST',
      body: JSON.stringify({ asr: chain.asr.map(strip), tts: chain.tts.map(strip) }),
    })
    state.voiceSettings = data.settings
    state.voiceStatus = data.status
    state.voiceCooldowns = data.cooldowns ?? state.voiceCooldowns
    state.settingsDirty.voice = false
    resetVoiceDraft()
    renderVoicePanel()
    // renderVoicePanel rebuilt the savebar, so re-query instead of writing to
    // the detached nodes captured before the render.
    const feedback = $('#voice-result')
    if (feedback) {
      const asr = data.status?.asr
      const tts = data.status?.tts
      feedback.textContent = `已生效：ASR ${asr?.label || '—'}（${asr?.chain?.length || 1} 个）· TTS ${tts?.label || '—'}（${tts?.chain?.length || 1} 个）`
      feedback.className = 'settings-feedback ok'
    }
    await refreshStatus()
    updateSettingsOverview()
    appendMessage('system', `语音设置已保存：ASR ${data.status?.asr?.label ?? ''} · TTS ${data.status?.tts?.label ?? ''}`)
  } catch (error) {
    if (result) {
      result.textContent = `保存失败：${error.message}`
      result.className = 'settings-feedback bad'
    }
  } finally {
    const live = $('#voice-save')
    if (live) { live.disabled = false; live.textContent = original }
    else if (button) { button.disabled = false; button.textContent = original }
  }
}

function bindVoiceSettings() {
  const panel = $('#settings-panel-voice')
  if (!panel) return
  const touch = () => {
    markSettingsDirty('voice')
    const dirty = $('#voice-dirty')
    if (dirty) dirty.hidden = false
  }

  panel.addEventListener('input', event => {
    const field = event.target.closest('[data-voice-field]')
    if (!field) return
    const kind = field.dataset.voiceKind
    const entry = voiceEntry(kind, state.voiceEdit[kind])
    if (!entry) return
    entry[field.dataset.voiceField] = field.value
    touch()
  })

  panel.addEventListener('change', event => {
    const field = event.target.closest('[data-voice-field]')
    if (!field) return
    const kind = field.dataset.voiceKind
    const entry = voiceEntry(kind, state.voiceEdit[kind])
    if (!entry) return
    const name = field.dataset.voiceField
    entry[name] = field.value
    if (name === 'adapter') applyVoiceAdapterDefaults(entry, kind)
    touch()
    renderVoicePanel()
  })

  panel.addEventListener('click', async event => {
    const save = event.target.closest('#voice-save')
    if (save) { await saveVoiceSettings(); return }

    const add = event.target.closest('[data-voice-add]')
    if (add) {
      const kind = add.dataset.voiceAdd
      state.voicePicker[kind] = !state.voicePicker[kind]
      if (state.voicePicker[kind] && !state.voices) await loadVoiceCatalog()
      renderVoicePanel()
      return
    }

    const blank = event.target.closest('[data-voice-blank]')
    if (blank) {
      const kind = blank.dataset.voiceBlank
      addVoiceEntry(kind, {
        id: uniqueVoiceId(kind, 'voice'),
        label: kind === 'asr' ? '新的识别服务' : '新的合成服务',
        kind: 'remote', transport: 'http', baseUrl: '', model: '', voice: '', language: 'zh',
        adapter: 'openai', apiKey: '', hasKey: false,
      }, { notice: '已加入一个空白远端服务，填写地址和 Key 后保存' })
      return
    }

    const preset = event.target.closest('[data-voice-preset-id]')
    if (preset) {
      const kind = preset.dataset.voicePresetKind
      const entry = (state.voices || []).find(item => item.id === preset.dataset.voicePresetId)
      if (!entry) return
      const local = !entry.baseUrl && entry.adapter !== 'edge'
      const existing = ensureVoiceDraft()[kind].find(item => local ? item.kind === 'local' : entry.adapter === 'edge' ? item.adapter === 'edge' : item.kind === 'remote' && item.baseUrl === entry.baseUrl && item.model === entry.model)
      if (existing) {
        state.voiceEdit[kind] = existing.id
        state.voicePicker[kind] = false
        renderVoicePanel()
        const result = $('#voice-result')
        if (result) { result.textContent = `已经在列表里：${existing.label}${local ? '（本地引擎，无需 Key）' : entry.adapter === 'edge' ? '（Edge TTS，无需 Key）' : ''}，保存后按顺序生效`; result.className = 'settings-feedback ok' }
        return
      }
      addVoiceEntry(kind, voiceProfileFromCatalog(entry), {
        notice: local ? `已选中「${entry.name}」（本地引擎，无需 Key）` : entry.adapter === 'edge' ? `已加入「${entry.name}」（无需 Key），保存后生效` : `已加入「${entry.name}」并设为首选，粘贴 Key 后保存`,
      })
      return
    }

    const edit = event.target.closest('[data-voice-edit]')
    if (edit) {
      state.voiceEdit[edit.dataset.voiceEdit] = edit.dataset.voiceId
      renderVoicePanel()
      return
    }

    const cancel = event.target.closest('[data-voice-cancel]')
    if (cancel) {
      state.voiceEdit[cancel.dataset.voiceCancel] = ''
      renderVoicePanel()
      return
    }

    const move = event.target.closest('[data-voice-move]')
    if (move) {
      const kind = move.dataset.voiceKind
      const chain = ensureVoiceDraft()[kind]
      const index = chain.findIndex(entry => entry.id === move.dataset.voiceId)
      const target = move.dataset.voiceMove === 'up' ? index - 1 : index + 1
      if (index < 0 || target < 0 || target >= chain.length) return
      const [item] = chain.splice(index, 1)
      chain.splice(target, 0, item)
      touch()
      renderVoicePanel()
      return
    }

    const remove = event.target.closest('[data-voice-remove]')
    if (remove) {
      const kind = remove.dataset.voiceRemove
      const chain = ensureVoiceDraft()[kind]
      if (chain.length <= 1) return
      const index = chain.findIndex(entry => entry.id === remove.dataset.voiceId)
      if (index < 0) return
      const [removed] = chain.splice(index, 1)
      if (state.voiceEdit[kind] === removed.id) state.voiceEdit[kind] = chain[0]?.id || ''
      touch()
      renderVoicePanel()
      return
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
  bindAppearance()
  bindSettingsActions()
  updateDirtyUi()
  void refreshDevices()
  if (selected.kind !== 'openai' || selected.hasKey) void refreshModelOptions(selected, { silent: true })
  requestAnimationFrame(() => {
    const body = $('.settings-modal .modal-body')
    if (body) body.scrollTop = scrollTop
    applyPendingProvider()
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
  const [voiceResult, modelResult, tuningResult] = await Promise.allSettled([
    api('/api/voice'),
    api('/api/model'),
    api('/api/tuning'),
    // Warm the public catalogue before rendering: the model form uses it for
    // vision/embedding suggestions without a second round-trip.
    loadCatalog(),
    loadVoiceCatalog(),
  ])
  if (voiceResult.status === 'fulfilled') {
    state.voiceSettings = voiceResult.value.settings
    state.voiceStatus = voiceResult.value.status
    state.voiceCooldowns = voiceResult.value.cooldowns || { asr: {}, tts: {} }
    resetVoiceDraft()
  } else {
    state.voiceSettings = null
    state.voiceStatus = null
    state.voiceDraft = null
  }
  if (modelResult.status === 'fulfilled') {
    state.modelSettings = modelResult.value.settings
    state.settingsError = ''
    renderScenarioSelect()
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
  if (tuningResult.status === 'fulfilled') {
    state.tuningSnapshot = tuningResult.value
    applyVisualTuning(tuningResult.value.values || {})
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
      timeoutMs: 60_000,
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
        contextWindow: Number($('#model-context-window')?.value || selected.contextWindow || 4096),
        supportsTools: $('#model-supports-tools')?.checked ?? selected.supportsTools ?? false,
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
      const data = await api('/api/model/test', { method: 'POST', body: JSON.stringify(payload), timeoutMs: 60_000 })
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

const QUICK_PROVIDER_IDS = ['deepseek', 'siliconflow', 'moonshot', 'zhipu', 'dashscope', 'gemini']

async function loadCatalog() {
  if (Array.isArray(state.catalog) && state.catalog.length) return state.catalog
  try {
    const data = await api('/api/providers/catalog', { timeoutMs: 15_000 })
    state.catalog = Array.isArray(data.providers) ? data.providers : []
  } catch {
    state.catalog = []
  }
  return state.catalog
}

async function loadVoiceCatalog() {
  if (Array.isArray(state.voices) && state.voices.length) return state.voices
  try {
    const data = await api('/api/voice/catalog', { timeoutMs: 15_000 })
    state.voices = Array.isArray(data.voices) ? data.voices : []
  } catch {
    state.voices = []
  }
  return state.voices
}

const VOICE_REGION_LABEL = { cn: '国内直连', global: '国际', local: '本机 / 自建' }

async function applyVoiceGuide(id, options = {}) {
  const catalog = await loadVoiceCatalog()
  const entry = catalog.find(item => item.id === id)
  if (!entry) {
    appendMessage('system', '没有找到这个语音服务，请到「语音服务」页面重新选择。')
    return
  }
  if ($('#modal').hidden) await showSettings({ tab: 'voice' })
  else if (state.settingsTab !== 'voice') activateSettingsTab('voice')
  ensureVoiceDraft()
  const kind = entry.kind
  const chain = state.voiceDraft[kind]
  const local = !entry.baseUrl && entry.adapter !== 'edge'
  const existing = chain.find(item => local ? item.kind === 'local' : entry.adapter === 'edge' ? item.adapter === 'edge' : item.kind === 'remote' && item.baseUrl === entry.baseUrl && item.model === entry.model)
  if (existing) {
    state.voiceEdit[kind] = existing.id
    state.voicePicker[kind] = false
    markSettingsDirty('voice')
    renderVoicePanel()
    const result = $('#voice-result')
    if (result) {
      result.textContent = local
        ? `「${existing.label}」已经在链里（本地引擎，无需 Key），保存后生效`
        : `「${existing.label}」已经在链里；粘贴 Key 或调整顺序后保存`
      result.className = 'settings-feedback ok'
    }
    if (options.focus !== false) document.getElementById(`${kind}-key`)?.focus({ preventScroll: true })
    return
  }
  addVoiceEntry(kind, voiceProfileFromCatalog(entry), {
    notice: local
      ? `已选中「${entry.name}」（本地引擎，无需 Key），保存后生效`
      : entry.adapter === 'edge' ? `已把「${entry.name}」加到${VOICE_KIND_LABEL[kind]}链首位（无需 Key），保存后生效` : `已把「${entry.name}」加到${VOICE_KIND_LABEL[kind]}链首位，粘贴 Key 后保存`,
  })
}

function capabilityListHtml() {
  const caps = state.capabilities
  if (!caps) return '<li class="capability"><span>平台能力</span><span>读取中…</span></li>'
  const rows = [
    ['屏幕捕获', caps.screenCapture, caps.reasons?.screenCapture],
    ['摄像头', caps.camera, caps.reasons?.camera],
    ['本地语音识别', caps.localAsr, caps.reasons?.localAsr],
    ['本地语音合成', caps.localTts, caps.reasons?.localTts],
    ['桌面通知', caps.notify, caps.reasons?.notify],
    ['开机自启', caps.autostart, caps.reasons?.autostart],
  ]
  return rows.map(([label, ok, reason]) => `<li class="capability ${ok ? 'ok' : 'off'}"><span>${label}</span><span>${ok ? '可用' : escapeHtml(reason || '不可用')}</span></li>`).join('')
}

/**
 * Hide features the current OS cannot serve. On macOS/Windows the screen and
 * camera helpers do not exist; a button that always fails is worse than a
 * button that explains why it is off.
 */
function applyCapabilities(platform) {
  if (!platform || !platform.os) return
  state.capabilities = platform
  for (const [action, ok] of Object.entries({ screen: platform.screenCapture, camera: platform.camera })) {
    const button = document.querySelector(`.quick[data-action="${action}"]`)
    if (!button) continue
    button.disabled = !ok
    if (!ok) {
      const reason = platform.reasons?.[action] || '当前平台不支持'
      button.title = reason
      button.setAttribute('aria-description', reason)
    } else {
      button.removeAttribute('title')
      button.removeAttribute('aria-description')
    }
  }
  const list = $('#capability-list')
  if (list) list.innerHTML = capabilityListHtml()
}

async function toggleProviderQuick() {
  const host = $('#provider-quick')
  if (!host) return
  if (!host.hidden) { host.hidden = true; return }
  host.innerHTML = '<p class="settings-hint">正在读取供应商…</p>'
  host.hidden = false
  const catalog = await loadCatalog()
  const picks = QUICK_PROVIDER_IDS
    .map(id => catalog.find(item => item.id === id))
    .filter(Boolean)
  if (!picks.length) {
    host.innerHTML = '<p class="settings-hint">读取失败，请打开「供应商指南」页查看。</p>'
    return
  }
  host.innerHTML = picks.map(item => `<button type="button" class="provider-pick" data-provider="${escapeHtml(item.id)}">
    <b>${escapeHtml(item.name)}</b>
    <span>${item.chinaDirect ? '国内直连' : '需自备网络'}</span>
  </button>`).join('') + '<a class="provider-pick more" href="/providers" target="_blank" rel="noopener"><b>全部供应商</b><span>价格与步骤 →</span></a>'
}

async function applyProviderGuide(id) {
  const catalog = await loadCatalog()
  const entry = catalog.find(item => item.id === id)
  if (!entry) {
    appendMessage('system', '没有找到这个供应商，请到「模型服务」页面重新选择。')
    return
  }
  if ($('#modal').hidden) await showSettings({ tab: 'model' })
  else activateSettingsTab('model')
  const normalize = value => String(value || '').replace(/\/+$/, '')
  const existing = (state.modelSettings?.profiles ?? []).find(item => normalize(item.baseUrl) === normalize(entry.baseUrl))
  if (existing) {
    // Already configured: select that profile instead of adding a duplicate.
    state.modelFormId = existing.id
    renderSettings({ tab: 'model', focus: false })
    $('#model-form')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    $('#model-key')?.focus({ preventScroll: true })
    const result = $('#model-result')
    if (result) { result.textContent = `已选中「${entry.name}」，粘贴 API Key 后保存`; result.className = 'settings-feedback ok' }
    return
  }
  // Keep it as pending state: any background re-render of the settings sheet
  // (tuning broadcast, device refresh) rebuilds the form and would otherwise
  // wipe the values before the user can paste a key.
  state.pendingProvider = entry
  applyPendingProvider()
}

function applyPendingProvider() {
  const entry = state.pendingProvider
  if (!entry) return
  const base = $('#add-base')
  if (!base) return
  const setValue = (selector, value) => {
    const element = $(selector)
    if (!element) return
    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }
  setValue('#add-label', entry.name.slice(0, 32))
  setValue('#add-protocol', entry.protocol)
  setValue('#add-base', entry.baseUrl)
  setValue('#add-model', entry.model || '')
  const card = $('#provider-add-card')
  card?.classList.add('flash')
  setTimeout(() => card?.classList.remove('flash'), 1800)
  $('#add-key')?.focus({ preventScroll: true })
  const result = $('#provider-add-result')
  if (result) { result.textContent = `已填入「${entry.name}」的地址，粘贴 API Key 后点添加`; result.className = 'settings-feedback ok' }
  // Keep it pending: the settings sheet re-renders itself after background
  // refreshes, and a second render would otherwise blank the fields again.
  // Typing a key (or adding the provider) is what ends the prefill.
}

function bindSettingsActions() {
  $('#add-key')?.addEventListener('input', () => { state.pendingProvider = null }, { once: true })
  $('#provider-add')?.addEventListener('pointerdown', () => { state.pendingProvider = null }, { once: true })
  $('#provider-guide-inline')?.addEventListener('click', () => { void toggleProviderQuick() })
  $('#provider-quick')?.addEventListener('click', event => {
    const pick = event.target.closest('[data-provider]')
    if (!pick) return
    $('#provider-quick').hidden = true
    void applyProviderGuide(pick.dataset.provider)
  })
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
      appendMessage('system', `擦除完成：${result.erased?.items ?? 0} 条记忆、${result.erased?.reminders ?? 0} 个提醒；供应商已重置为本机默认，连接会重新建立。`)
      // The server dropped every socket and reset the provider config; reload so
      // the UI starts from the same clean state instead of stale caches.
      setTimeout(() => window.location.reload(), 1400)
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
        contextWindow: Number($('#model-context-window')?.value || selected.contextWindow || 4096),
        supportsTools: $('#model-supports-tools')?.checked ?? selected.supportsTools ?? false,
  }
}

async function refreshStatus() {
  try {
    const data = await api('/api/health')
    applyStatus(data.status)
    applyCapabilities(data.platform)
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

function updateSendShortcutHint() {
  const ctrl = state.sendShortcut === 'ctrl-enter'
  const hint = ctrl ? 'Ctrl+Enter 发送，Enter 换行' : 'Enter 发送，Shift+Enter 换行'
  $('#input').placeholder = `说点什么…  ${hint}`
  $('#input').setAttribute('aria-description', hint)
  $('#send-btn').title = ctrl ? '发送（Ctrl+Enter）' : '发送（Enter）'
  $('#send-btn').setAttribute('aria-keyshortcuts', ctrl ? 'Control+Enter' : 'Enter')
  const help = $('#send-shortcut-help')
  if (help) help.textContent = `${hint} · 按住麦克风说话`
}

function bind() {
  bindHistory()
  updateSendShortcutHint()
  $('#send-btn').addEventListener('click', () => sendText($('#input').value))
  $('#input').addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || event.repeat) return
    const send = event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey
      && (state.sendShortcut === 'ctrl-enter' ? event.ctrlKey : !event.ctrlKey)
    if (send) {
      event.preventDefault()
      sendText($('#input').value)
    }
  })
  $('#input').addEventListener('input', event => { autoGrow(event.target); state.drafts.set(state.selectedSessionId, event.target.value) })
  $('#stop-btn').addEventListener('click', () => {
    if (state.cancelling || !state.activeTurn) return
    const identity = { ...state.activeTurn }
    state.cancelling = true
    stopAudio()
    api('/api/cancel', { method: 'POST', body: JSON.stringify(identity) })
      .then(() => { if (sameTurn(identity, state.activeTurn)) void refreshSelected() })
      .catch(error => { if (sameTurn(identity, state.activeTurn)) { state.cancelling = false; notify(error.message); void refreshSelected() } })
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
  $('#action-modal-close').addEventListener('click', () => closeActionModal())
  $('#action-modal').addEventListener('click', event => { if (event.target === $('#action-modal')) closeActionModal() })
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
    if ($('#profile-dialog')?.open || $('#history-confirm').open || $('#history-dialog').open) return
    if (!$('#action-modal').hidden) {
      if (event.key === 'Tab') trapModalFocus(event, $('#action-modal .modal'))
      if (event.key === 'Escape') {
        event.preventDefault()
        closeActionModal()
      }
      return
    }
    // Every dialog rendered into #modal (settings, senses, brief, token,
    // onboarding) traps Tab, not just the settings sheet.
    if (!$('#modal').hidden) {
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

  // Push-to-talk works for pointers (hold) and keyboards/screen readers
  // (click toggles). Both the composer mic and the big orb share it, so the
  // orb is no longer a focusable control that does nothing.
  for (const control of [$('#mic-btn'), $('#orb')]) {
    if (!control) continue
    bindPushToTalk(control)
  }

  $('#capture-close').addEventListener('click', () => { $('#capture-strip').hidden = true })
  const openLightbox = () => {
    if (!state.captureUrl) return
    state.lightboxOpener = document.activeElement
    $('#lightbox-image').src = state.captureUrl
    $('#lightbox').hidden = false
    $('#lightbox-close')?.focus({ preventScroll: true })
  }
  const closeLightbox = () => {
    if ($('#lightbox').hidden) return
    $('#lightbox').hidden = true
    $('#lightbox-image').removeAttribute('src')
    state.lightboxOpener?.focus?.()
  }
  $('#capture-image').addEventListener('click', openLightbox)
  $('#capture-image').addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openLightbox() }
  })
  $('#lightbox-close').addEventListener('click', closeLightbox)
  $('#lightbox').addEventListener('click', event => { if (event.target === $('#lightbox')) closeLightbox() })
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
      <div><b>1 · 本地模型</b><span class="${modelReady ? 'ok-text' : 'warn-text'}">${modelReady ? '已就绪，可以直接对话。' : '未就绪；先运行 npm run doctor，或到设置里配置模型。'}</span><a class="model-action" id="onboard-providers" href="/providers" target="_blank" rel="noopener" style="width:auto;display:inline-flex;align-items:center;min-height:34px;margin-top:6px">还没选供应商？看指南</a></div>
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
  // Recover if the connection loses a terminal event or an HTTP timeout leaves
  // the engine's outcome unknown. Never unlock solely on a client timer.
  setInterval(() => { if (state.busy && !state.snapshotLoading) void refreshSelected() }, 5000)
  await bootstrap()
  void loadScenarioOptions()
  maybeOnboarding()
  // The Whisper worker warms up in the background. Poll a few times so the
  // "加载中" state clears promptly instead of waiting for the 30 s status poll.
  setTimeout(() => void refreshStatus(), 2500)
  setTimeout(() => void refreshStatus(), 7000)
  setTimeout(() => void refreshStatus(), 12000)
  // Capabilities decide which quick actions exist; fetch them once immediately
  // so a macOS/Windows user never sees a button that cannot work.
  void refreshStatus()
  const pendingVoice = new URLSearchParams(location.search).get('voice')
  if (pendingVoice) {
    history.replaceState(null, '', location.pathname)
    setTimeout(() => { void applyVoiceGuide(pendingVoice) }, 500)
  }
  const pendingProvider = new URLSearchParams(location.search).get('provider')
  if (pendingProvider) {
    // The guide hands off with ?provider=<id>; drop it from the URL so a refresh
    // does not re-open the prefill.
    history.replaceState({}, '', location.pathname + location.hash)
    setTimeout(() => { void applyProviderGuide(pendingProvider) }, 500)
  }
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
