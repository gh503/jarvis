const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

const state = {
  ws: null,
  wsReady: false,
  reconnect: 0,
  token: localStorage.getItem('jarvis_token') || '',
  status: {},
  voice: { asr: false, tts: false },
  attention: { state: 'idle' },
  memory: [],
  reminders: [],
  focus: false,
  muted: localStorage.getItem('jarvis_muted') === '1',
  busy: false,
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
    } else if (payload.kind === 'event') {
      handleEvent(payload.event)
    } else if (payload.kind === 'error') {
      appendMessage('system', payload.error)
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
  label.textContent = kind === 'online' ? '本机连接' : kind === 'offline' ? '重连中' : '连接中'
}

function handleEvent(event) {
  const data = event.data || {}
  switch (event.type) {
    case 'attention.state':
      updateAttention(data)
      break
    case 'user.message':
      if (state.pendingUserEcho && data.text === state.pendingUserEcho) {
        state.pendingUserEcho = ''
      } else if (data.source !== 'remote') {
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
    case 'assistant.done':
      state.sawAssistantEvent = true
      finishStreaming(data.text, Boolean(data.error))
      if (data.audioUrl) playAudio(data.audioUrl)
      setBusy(false)
      updateLatency()
      break
    case 'assistant.cancelled':
      finishStreaming('（已停止）')
      setBusy(false)
      break
    case 'voice.transcribed':
      if (data.text) appendMessage('system', `听到：${data.text}`)
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
    case 'proactive.message':
      appendMessage('assistant', `⏰ ${data.reminder?.text || '提醒你一件事'}`)
      if (data.audioUrl) playAudio(data.audioUrl)
      refreshReminders()
      break
    case 'sense.capture':
      showCapture(data)
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

function applyStatus(status = {}) {
  state.status = { ...state.status, ...status }
  if (status.voice) state.voice = status.voice
  state.focus = Boolean(state.status.focus)
  $('#focus-btn').setAttribute('aria-pressed', String(state.focus))
  const model = state.status.model || '本地模型'
  $('#model-pill').textContent = state.status.modelReady ? `${model} · 本地` : '模型未就绪'
  $('#model-pill').style.opacity = state.status.modelReady ? '1' : '0.6'
  $('#memory-count').textContent = String(state.memory.length)
  $('#reminder-count').textContent = String(state.reminders.length)
  if (state.status.attention) updateAttention(state.status.attention)
  renderRuntime()
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

function sendText(text, options = {}) {
  const clean = text.trim()
  if (!clean) return
  if (state.busy && !options.force) {
    appendMessage('system', '我还在处理上一件事。先点停止，或者等我一下。')
    return
  }
  const input = $('#input')
  input.value = ''
  autoGrow(input)
  state.sawAssistantEvent = false
  state.pendingUserEcho = clean
  appendMessage('user', clean)
  setBusy(true)
  const sent = sendWs({ kind: 'chat', text: clean })
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
  if (result.transcript) appendMessage('system', `听到：${result.transcript}`)
  if (!state.sawAssistantEvent) {
    finishStreaming(result.reply || result.error || '', Boolean(result.error))
  }
  if (result.audioUrl) playAudio(result.audioUrl)
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
    ['模型就绪', state.status.modelReady ? '是' : '否'],
    ['语音识别', state.voice.asr ? '就绪' : '未就绪'],
    ['语音合成', state.voice.tts ? '就绪' : '未就绪'],
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
  $('#capture-detail').textContent = `${data.source || 'portal'}${size ? ` · ${size}` : ''}`
  $('#capture-strip').hidden = false
}

function playAudio(url) {
  if (state.muted) return
  const player = $('#player')
  player.src = url
  player.play().catch(() => {
    $('#hint').textContent = '点击页面后可播放语音'
  })
}

function autoGrow(textarea) {
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.min(140, Math.max(34, textarea.scrollHeight))}px`
}

async function startRecording() {
  if (state.recording) return
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
  $('#hint').textContent = '正在识别…'
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
    <p>这台机器不是本机回环访问。输入 <code>~/.local/share/jarvis/data/auth-token</code> 里的令牌。</p>
    <div class="search-row"><input id="token-input" type="password" placeholder="粘贴令牌" autocomplete="off"></div>
    <button class="send-btn" id="token-save" type="button" style="width:auto;padding:0 14px;height:34px">保存并重连</button>
  `)
  $('#token-save').addEventListener('click', () => {
    const value = $('#token-input').value.trim()
    if (!value) return
    state.token = value
    localStorage.setItem('jarvis_token', value)
    location.reload()
  })
}

function openModal(html) {
  $('#modal-body').innerHTML = html
  $('#modal').hidden = false
}

function closeModal() {
  $('#modal').hidden = true
  state.tokenPrompted = false
}

function showSettings() {
  const status = state.status
  openModal(`
    <h3>本地运行时</h3>
    <div class="setting-row"><span>模型</span><span>${escapeHtml(status.model || '—')}</span></div>
    <div class="setting-row"><span>模型就绪</span><span>${status.modelReady ? '是' : '否'}</span></div>
    <div class="setting-row"><span>语音识别</span><span>${state.voice.asr ? '就绪' : '未就绪'}</span></div>
    <div class="setting-row"><span>语音合成</span><span>${state.voice.tts ? '就绪' : '未就绪'}</span></div>
    <div class="setting-row"><span>注意力状态</span><span>${escapeHtml(state.attention.state || 'idle')}</span></div>
    <div class="setting-row"><span>专注模式</span><span>${state.focus ? '开' : '关'}</span></div>
    <h3>隐私</h3>
    <p>屏幕走系统门户，按次授权；摄像头只取单帧；记忆默认只在本机 SQLite。模型上下文不包含标记为 sensitive / secret 的记忆。</p>
    <p>如果远端访问已开启，必须同时启用 TLS 和至少 24 字符的令牌。</p>
    <h3>诊断</h3>
    <p>终端运行 <code>npm run doctor</code> 可以检查模型、Whisper、Piper、屏幕门户和摄像头。</p>
  `)
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
  $('#stop-btn').addEventListener('click', async () => {
    sendWs({ kind: 'cancel' })
    await api('/api/cancel', { method: 'POST', body: '{}' }).catch(() => undefined)
    finishStreaming('（已停止）')
    setBusy(false)
  })
  $('#mute-btn').addEventListener('click', () => {
    state.muted = !state.muted
    localStorage.setItem('jarvis_muted', state.muted ? '1' : '0')
    $('#mute-btn').setAttribute('aria-pressed', String(state.muted))
    if (state.muted) $('#player').pause()
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
  $('#settings-btn').addEventListener('click', showSettings)
  $('#modal-close').addEventListener('click', closeModal)
  $('#modal').addEventListener('click', event => { if (event.target === $('#modal')) closeModal() })
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeModal(); $('#lightbox').hidden = true } })

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

function tickClock() {
  const now = new Date()
  $('#clock').textContent = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

async function main() {
  bind()
  tickClock()
  setInterval(tickClock, 15000)
  await bootstrap()
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
