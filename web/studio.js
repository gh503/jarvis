/* Jarvis Studio — the observability and tuning surface.
   Vanilla ES module, no chart library: every chart is SVG/CSS generated here so
   the CSP can stay strict and the page works offline. */

import { applyVisualTuning, visualValues } from './visual.js'

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

const TABS = {
  overview: {
    title: '总览', eyebrow: 'OBSERVATORY / LIVE',
    subtitle: 'Jarvis 的注意力、延迟、感官与记忆，一屏可见。',
  },
  memory: {
    title: '记忆星座', eyebrow: 'MEMORY / CONSTELLATION',
    subtitle: '每颗星是一条记忆；边是相似、取代和人工建立的联系。点开任何一颗，查看它为什么存在。',
  },
  tuning: {
    title: '调参实验室', eyebrow: 'TUNING / LAB',
    subtitle: '开发阶段开放全部效果与行为参数。拖动即预览，保存后写入本机。',
  },
  config: {
    title: '原始配置', eyebrow: 'RUNTIME / CONFIG',
    subtitle: '脱敏后的运行时配置、路径与安全状态。只读，不包含任何密钥。',
  },
  events: {
    title: '事件流', eyebrow: 'EVENTS / STREAM',
    subtitle: '系统事件按时间倒序排列；用于看清一次回合里真正发生了什么。',
  },
}

const KIND = {
  semantic: { label: '语义', color: '#7ee7d5', short: 'SEM' },
  episodic: { label: '情景', color: '#f3b36a', short: 'EPI' },
  procedural: { label: '程序', color: '#b9a6ff', short: 'PRO' },
  prospective: { label: '未来', color: '#8fe08f', short: 'FUT' },
}
const STATUS = {
  proposed: { label: '候选', tone: 'amber' },
  confirmed: { label: '已确认', tone: 'cyan' },
  rejected: { label: '已拒绝', tone: 'muted' },
  superseded: { label: '被取代', tone: 'muted' },
  expired: { label: '已过期', tone: 'muted' },
  deleted: { label: '已删除', tone: 'muted' },
}
const ATTENTION = {
  idle: { label: '待命', tone: 'cyan' },
  considering: { label: '判断中', tone: 'amber' },
  listening: { label: '在听', tone: 'cyan' },
  capturing: { label: '采集中', tone: 'amber' },
  understanding: { label: '思考中', tone: 'cyan' },
  need_context: { label: '需要上下文', tone: 'amber' },
  responding: { label: '回应中', tone: 'cyan' },
  followup: { label: '追问窗口', tone: 'muted' },
}

const state = {
  open: false,
  tab: 'overview',
  data: null,
  graph: null,
  graphAt: 0,
  traceHistory: [],
  traceHistoryAt: 0,
  tuning: null,
  tuningDraft: {},
  tuningSaved: {},
  tuningDirty: false,
  config: null,
  loading: false,
  timer: 0,
  previousFocus: null,
  memoryView: { kind: 'all', status: 'all', sensitivity: 'all', search: '', labels: true, labelsTouched: false, zoom: 1, panX: 0, panY: 0, selected: null },
  layout: null,
  layoutNodes: [],
  recall: null,
  recallQuery: '',
  recallLoading: false,
  eventsPaused: false,
  eventFilter: 'all',
  eventSearch: '',
  tuningSearch: '',
  showAdvanced: true,
  tuningCompare: false,
  searchTimer: 0,
  tuningSearchTimer: 0,
  eventSearchTimer: 0,
  toastTimer: 0,
  pendingTab: null,
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const truncate = (value, length) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > length ? `${text.slice(0, Math.max(1, length - 1))}…` : text
}
const fmtMs = value => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  const ms = Number(value)
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${(ms / 60_000).toFixed(1)} min`
}
const fmtAgo = iso => {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (seconds < 60) return `${seconds}s 前`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m 前`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h 前`
  return `${Math.round(seconds / 86_400)}d 前`
}
const fmtTime = iso => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
const pct = (value, total) => (total ? Math.round((value / total) * 100) : 0)
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

async function api(path, options = {}) {
  const token = localStorage.getItem('jarvis_token') || ''
  const headers = new Headers(options.headers || {})
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(path, { ...options, headers })
  let body = null
  try { body = await response.json() } catch { body = null }
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`)
  return body
}

function setHeader() {
  const meta = TABS[state.tab] || TABS.overview
  $('#studio-title').textContent = meta.title
  $('#studio-eyebrow').textContent = meta.eyebrow
  $('#studio-subtitle').textContent = meta.subtitle
  $$('.studio-nav-item').forEach(item => item.classList.toggle('active', item.dataset.studioTab === state.tab))
}

function updateHealth() {
  const data = state.data
  const dot = $('#studio-health-dot')
  const label = $('#studio-health-label')
  if (!data) {
    dot.className = 'warn'
    label.textContent = '连接中'
    return
  }
  const model = data.status?.modelReady || data.status?.providerReady
  const voice = Boolean(data.status?.voice?.asr && data.status?.voice?.tts)
  const voiceState = data.status?.voice?.asrState
  const voiceWarm = voice && (!voiceState || voiceState === 'ready')
  dot.className = model && voiceWarm ? 'ok' : model ? 'warn' : 'bad'
  const modelLabel = data.status?.providerLabel || data.status?.provider || '模型'
  label.textContent = model ? `${modelLabel} · ${data.status?.model || '就绪'}` : '模型未就绪'
  $('#studio-version').textContent = `v${data.version || '2.0.0'}`
}

function notify(message, tone = 'ok') {
  let node = $('#studio-toast')
  if (!node) {
    node = document.createElement('div')
    node.id = 'studio-toast'
    node.className = 'studio-toast'
    node.setAttribute('role', 'status')
    node.setAttribute('aria-live', 'polite')
    $('#studio')?.appendChild(node)
  }
  node.textContent = message
  node.dataset.tone = tone
  node.classList.add('show')
  clearTimeout(state.toastTimer)
  state.toastTimer = setTimeout(() => node.classList.remove('show'), 3200)
}

export function initStudio() {
  $('#studio-btn')?.addEventListener('click', () => openStudio('overview'))
  $('#studio-close')?.addEventListener('click', closeStudio)
  $('#studio-close-top')?.addEventListener('click', closeStudio)
  $('#studio-refresh')?.addEventListener('click', () => {
    if (state.tab === 'tuning' && state.tuningDirty) { notify('先保存或放弃调参修改', 'danger'); return }
    void loadTab(state.tab, true)
  })
  $$('.studio-nav-item').forEach(item => item.addEventListener('click', () => void setTab(item.dataset.studioTab)))
  $('#studio')?.addEventListener('click', event => {
    if (event.target.id === 'studio') closeStudio()
  })
  window.addEventListener('keydown', event => {
    if (!state.open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      closeStudio()
      return
    }
    if (event.key === 'Tab') trapStudioFocus(event)
  })
}

/**
 * Each panel is re-rendered wholesale, which drops focus and the caret while
 * someone is typing in a search box. Remember the focused control and put the
 * caret back after the swap.
 */
let contentObserver = null
let lastContentFocus = null
function observeContentFocus() {
  const root = document.querySelector('#studio-content')
  if (!root || contentObserver) return
  document.addEventListener('focusin', event => {
    const target = event.target
    if (!target || !target.id || !root.contains(target)) return
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
    lastContentFocus = { id: target.id, start: target.selectionStart ?? null, end: target.selectionEnd ?? null }
  })
  contentObserver = new MutationObserver(() => {
    if (!lastContentFocus || !root.contains(document.body)) return
    // Only restore when the render actually stole focus.
    if (document.activeElement && document.activeElement !== document.body && root.contains(document.activeElement)) return
    const next = document.getElementById(lastContentFocus.id)
    if (!next || !root.contains(next)) return
    next.focus({ preventScroll: true })
    if (lastContentFocus.start !== null && typeof next.setSelectionRange === 'function') {
      try { next.setSelectionRange(lastContentFocus.start, lastContentFocus.end) } catch { /* select */ }
    }
  })
  contentObserver.observe(root, { childList: true })
}

function studioFocusable() {
  const root = $('#studio')
  if (!root) return []
  return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.hasAttribute('disabled') && el.getClientRects().length > 0)
}

function trapStudioFocus(event) {
  const items = studioFocusable()
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  if (event.shiftKey && (document.activeElement === first || !$('#studio').contains(document.activeElement))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !$('#studio').contains(document.activeElement))) {
    event.preventDefault()
    first.focus()
  }
}

export function openStudio(tab = 'overview') {
  state.open = true
  state.previousFocus = document.activeElement
  const overlay = $('#studio')
  overlay.hidden = false
  overlay.setAttribute('aria-hidden', 'false')
  document.body.classList.add('studio-open')
  const shell = document.querySelector('.app-shell')
  if (shell) shell.setAttribute('inert', '')
  observeContentFocus()
  setHeader()
  void setTab(tab, true)
  clearInterval(state.timer)
  state.timer = window.setInterval(() => {
    if (!state.open) return
    if (state.tab === 'tuning') return
    if (state.tab === 'events' && state.eventsPaused) return
    // A re-render mid-keystroke is worse than a slightly stale panel.
    const active = document.activeElement
    if (active && active.closest?.('#studio-content') && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return
    void loadTab(state.tab, false)
  }, 3200)
  setTimeout(() => $('#studio-close')?.focus(), 40)
}

export function closeStudio() {
  if (state.tuningDirty && state.tab === 'tuning') {
    if (!window.confirm('调参还有未保存的修改，确定关闭观察台？')) return
  }
  state.open = false
  clearInterval(state.timer)
  const overlay = $('#studio')
  overlay.hidden = true
  overlay.setAttribute('aria-hidden', 'true')
  document.body.classList.remove('studio-open')
  document.querySelector('.app-shell')?.removeAttribute('inert')
  state.previousFocus?.focus?.()
}

async function setTab(tab, force = false) {
  if (!TABS[tab]) tab = 'overview'
  if (state.tab === 'tuning' && state.tuningDirty && tab !== 'tuning') {
    const leave = window.confirm('调参还有未保存的修改，确定离开？')
    if (!leave) return
    state.tuningDirty = false
  }
  state.tab = tab
  setHeader()
  await loadTab(tab, force)
}

async function loadTab(tab, force = false) {
  if (state.loading) {
    state.pendingTab = { tab, force }
    return
  }
  state.loading = true
  const content = $('#studio-content')
  if (content && !state.data) content.innerHTML = skeleton()
  try {
    if (tab === 'tuning') {
      if (!state.tuning || !state.tuningDirty || force) await loadTuning()
      if (state.data) updateHealth()
      renderTuning()
      return
    }
    if (tab === 'config') {
      if (force || !state.config) {
        const [observatory, config] = await Promise.all([api('/api/observatory'), api('/api/config')])
        state.data = observatory
        state.config = config
      }
      updateHealth()
      renderConfig()
      return
    }
    const observatory = await api('/api/observatory')
    state.data = observatory
    if (tab === 'overview' && (force || Date.now() - state.traceHistoryAt > 12000)) {
      try {
        state.traceHistory = (await api('/api/traces?limit=12')).traces || []
        state.traceHistoryAt = Date.now()
      } catch { /* history is optional */ }
    }
    updateHealth()
    if (tab === 'memory') {
      if (force || !state.graph || Date.now() - state.graphAt > 9000) await loadGraph()
      renderMemory()
      return
    }
    if (tab === 'events') renderEvents()
    else renderOverview()
  } catch (error) {
    content.innerHTML = errorState(error)
  } finally {
    state.loading = false
    const pending = state.pendingTab
    state.pendingTab = null
    if (pending && state.open) void loadTab(pending.tab, pending.force)
  }
}

async function loadGraph() {
  state.graph = await api('/api/memory/graph?limit=160')
  state.graphAt = Date.now()
  if (!state.memoryView.selected || !state.graph.nodes.some(node => node.id === state.memoryView.selected)) {
    const top = [...state.graph.nodes].sort((a, b) => b.score - a.score)[0]
    state.memoryView.selected = top?.id ?? null
  }
}

async function loadTuning() {
  state.tuning = await api('/api/tuning')
  state.tuningSaved = { ...state.tuning.values }
  state.tuningDraft = { ...state.tuning.values }
  state.tuningDirty = false
}

function skeleton() {
  return `<div class="s-skeleton"><div></div><div></div><div></div><div></div><div></div><div></div></div>`
}

function errorState(error) {
  return `<div class="s-error"><strong>暂时读不到数据</strong><p>${esc(error instanceof Error ? error.message : String(error))}</p><p class="muted">本地服务可能正在重启。观察台会自动重试。</p></div>`
}

function panel(title, meta, body, className = '') {
  return `<section class="s-panel ${className}">
    <header class="s-panel-head"><div><h2>${esc(title)}</h2>${meta ? `<p>${esc(meta)}</p>` : ''}</div></header>
    <div class="s-panel-body">${body}</div>
  </section>`
}

function statCard(label, value, detail, tone = '') {
  return `<div class="s-kpi ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></div>`
}

function pill(text, tone = 'muted') {
  return `<span class="s-pill ${tone}">${esc(text)}</span>`
}

function latencyChart(series) {
  const points = series.slice(-42)
  if (points.length < 2) {
    return `<div class="s-empty-chart"><span>还没有足够的回合</span><small>和 Jarvis 说几句话，这里会出现首字与整轮延迟。</small></div>`
  }
  const width = 760
  const height = 244
  const pad = { left: 42, right: 14, top: 16, bottom: 30 }
  const values = points.flatMap(point => [point.totalMs, point.firstTokenMs, point.firstAudioMs]).filter(value => typeof value === 'number' && Number.isFinite(value))
  const max = Math.max(1000, ...values)
  const step = max / 4
  const x = index => pad.left + (index / Math.max(1, points.length - 1)) * (width - pad.left - pad.right)
  const y = value => pad.top + (1 - value / max) * (height - pad.top - pad.bottom)
  const path = key => {
    let output = ''
    let started = false
    points.forEach((point, index) => {
      const value = point[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        started = false
        return
      }
      output += `${started ? 'L' : 'M'}${x(index).toFixed(2)},${y(value).toFixed(2)} `
      started = true
    })
    return output.trim()
  }
  const grid = [0, 1, 2, 3, 4].map(index => {
    const value = step * index
    const yy = y(value)
    return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${yy}" y2="${yy}" class="chart-grid"/>
      <text x="${pad.left - 8}" y="${yy + 4}" class="chart-axis" text-anchor="end">${esc(fmtMs(value))}</text>`
  }).join('')
  const labels = points.map((point, index) => {
    if (index !== 0 && index !== points.length - 1 && index % Math.ceil(points.length / 5) !== 0) return ''
    return `<text x="${x(index)}" y="${height - 8}" class="chart-axis" text-anchor="middle">${esc(fmtAgo(point.at))}</text>`
  }).join('')
  return `<div class="chart-legend"><span><i class="legend-dot total"></i>整轮</span><span><i class="legend-dot token"></i>首字</span><span><i class="legend-dot audio"></i>首段语音</span><b>${points.length} turns</b></div>
    <svg class="latency-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="最近回合延迟趋势">
      <defs>
        <linearGradient id="chart-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#7ee7d5" stop-opacity=".2"/><stop offset="1" stop-color="#7ee7d5" stop-opacity="0"/></linearGradient>
      </defs>
      ${grid}${labels}
      <path d="${path('totalMs')}" class="chart-line total"/>
      <path d="${path('firstTokenMs')}" class="chart-line token"/>
      <path d="${path('firstAudioMs')}" class="chart-line audio"/>
      <path d="${path('totalMs')} L ${x(points.length - 1)},${y(0)} L ${x(0)},${y(0)} Z" class="chart-area"/>
      ${points.map((point, index) => {
        if (typeof point.totalMs !== 'number') return ''
        return `<circle cx="${x(index)}" cy="${y(point.totalMs)}" r="2.4" class="chart-point"><title>${esc(fmtAgo(point.at))} · ${esc(fmtMs(point.totalMs))}</title></circle>`
      }).join('')}
    </svg>`
}

function donut(parts, center) {
  const size = 144
  const stroke = 13
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const total = parts.reduce((sum, part) => sum + part.count, 0)
  let offset = 0
  const rings = parts.map(part => {
    const fraction = total ? part.count / total : 0
    const length = fraction * circumference
    const circle = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${part.color}" stroke-width="${stroke}" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})" class="donut-seg"><title>${esc(part.label)} ${part.count}</title></circle>`
    offset += length
    return circle
  }).join('')
  return `<div class="donut-wrap"><svg viewBox="0 0 ${size} ${size}" class="donut" role="img" aria-label="${esc(center)}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="${stroke}"/>
    ${rings}
    <text x="${size / 2}" y="${size / 2 - 2}" text-anchor="middle" class="donut-total">${center}</text>
    <text x="${size / 2}" y="${size / 2 + 17}" text-anchor="middle" class="donut-caption">TOTAL</text>
  </svg></div>`
}

const EVENT_LABELS = {
  'turn.start': '回合开始', 'assistant.delta': '生成片段', 'assistant.done': '回合完成', 'assistant.audio': '语音片段',
  'voice.asr.start': 'ASR 开始', 'voice.transcribed': '转写完成', 'memory.recalled': '记忆召回', 'brief.ready': '每日简报',
  'memory.proposed': '记忆候选', 'memory.added': '记忆写入', 'memory.episode': '情景记录',
  'sense.capture': '感官捕获', 'attention.state': '注意力迁移', 'model.changed': '模型切换',
  'tuning.changed': '参数变更', 'action.proposed': '动作提案', 'action.executed': '动作执行',
  'action.denied': '动作拒绝', 'action.failed': '动作失败', 'reminder.due': '提醒到期',
  'system.ready': '系统就绪',
}

function eventSummary(event) {
  const data = event.data || {}
  if (typeof data.text === 'string' && data.text.trim()) return truncate(data.text, 130)
  if (typeof data.query === 'string') return `召回「${truncate(data.query, 60)}」${Array.isArray(data.ids) ? ` · ${data.ids.length} 条` : ''}`
  if (typeof data.state === 'string') return `${data.from || '?'} → ${data.state}`
  if (typeof data.error === 'string') return truncate(data.error, 140)
  if (data.changed) return `修改 ${Array.isArray(data.changed) ? data.changed.length : '?'} 项参数`
  if (data.model) return `${data.model}`
  try {
    const text = JSON.stringify(data)
    return truncate(text === '{}' ? '—' : text, 130)
  } catch { return '—' }
}

function eventTone(type) {
  if (type.includes('error') || type.includes('failed') || type.includes('denied')) return 'danger'
  if (type.includes('memory')) return 'amber'
  if (type.includes('assistant') || type.includes('voice')) return 'cyan'
  return 'muted'
}

function eventRows(events, limit = 16) {
  return events.slice(0, limit).map(event => `<div class="event-row">
    <time>${esc(fmtTime(event.at))}</time>
    <span class="event-type ${eventTone(event.type)}">${esc(EVENT_LABELS[event.type] || event.type)}</span>
    <p>${esc(eventSummary(event))}</p>
  </div>`).join('')
}

function renderOverview() {
  const data = state.data
  if (!data) return
  const t = data.telemetry
  const mem = data.memory
  const latest = t.turns[0]
  const attention = data.status?.attention?.state || data.attention?.state || 'idle'
  const attentionMeta = ATTENTION[attention] || { label: attention, tone: 'muted' }
  const series = t.series || []
  const success = t.turns.filter(turn => turn.status === 'ok').length
  const totalTurns = Math.max(1, t.turns.length)
  const tokenTurns = t.turns.filter(turn => turn.firstTokenMs != null)
  const averageToken = tokenTurns.length ? Math.round(tokenTurns.reduce((sum, turn) => sum + (turn.firstTokenMs || 0), 0) / tokenTurns.length) : null
  const kindParts = Object.entries(mem.byKind || {}).map(([kind, count]) => ({ label: KIND[kind]?.label || kind, count, color: KIND[kind]?.color || '#8b97a6' }))
  const eventList = t.events || []
  const byKindText = kindParts.length ? kindParts.map(part => `<span class="legend-row"><i style="background:${part.color}"></i>${esc(part.label)} <b>${part.count}</b></span>`).join('') : '<span class="muted">还没有长期记忆</span>'
  const stageRows = [
    { label: '听写', value: latest?.asrMs, tone: 'amber' },
    { label: '模型首字', value: latest?.firstTokenMs, tone: 'cyan' },
    { label: '首段语音', value: latest?.firstAudioMs, tone: 'green' },
    { label: '整轮', value: latest?.totalMs, tone: 'muted' },
  ]
  const stageMax = Math.max(1, ...stageRows.map(row => row.value || 0))
  const stageHtml = latest
    ? stageRows.map(row => `<div class="stage-row"><span>${esc(row.label)}</span><div class="stage-track"><i class="${row.tone}" style="width:${Math.max(2, Math.round(((row.value || 0) / stageMax) * 100))}%"></i></div><b>${esc(fmtMs(row.value))}</b></div>`).join('')
    : '<div class="muted small">还没有回合。说一句话，或点一下麦克风。</div>'

  $('#studio-content').innerHTML = `
    <div class="s-kpis">
      ${statCard('注意力状态', attentionMeta.label, `${data.status?.busy ? '处理中' : '当前'} · ${data.status?.focus ? '专注' : '常规'}`, attentionMeta.tone)}
      ${statCard('最近首字', fmtMs(latest?.firstTokenMs), latest ? `${latest.source === 'voice' ? '语音' : '文本'}回合` : '等待首个回合', 'cyan')}
      ${statCard('最近整轮', fmtMs(latest?.totalMs), latest ? `${success}/${totalTurns} 轮成功` : '—', '')}
      ${statCard('长期记忆', String(mem.stats?.total ?? 0), `${mem.stats?.confirmed ?? 0} 已确认 · ${mem.stats?.proposed ?? 0} 候选`, 'amber')}
      ${statCard('语音就绪', `${data.status?.voice?.asr ? 'ASR' : '—'} / ${data.status?.voice?.tts ? 'TTS' : '—'}`, data.status?.voice?.asrState === 'starting' ? 'ASR 模型加载中' : data.status?.voice?.asrState === 'error' ? 'ASR 异常，查看日志' : data.status?.voice?.asr && data.status?.voice?.tts ? '本地语音链路可用' : '部分组件未就绪', data.status?.voice?.asrState === 'starting' ? 'amber' : data.status?.voice?.asrState === 'error' ? 'danger' : data.status?.voice?.asr && data.status?.voice?.tts ? 'green' : 'danger')}
      ${statCard('系统负载', `${t.system.load1.toFixed(2)}`, `${t.system.cpuCount} 核 · RSS ${t.system.processRssMb} MB`, t.system.load1 / Math.max(1, t.system.cpuCount) > 0.8 ? 'danger' : '')}
    </div>

    <div class="s-grid">
      ${panel('当前注意力', '注意力状态机在模型之外；它决定 Jarvis 现在是否应该开口、采集或保持安静。', `
        <div class="signal-layout">
          <div class="signal-orb ${esc(attention)}">
            <div class="signal-orb-ring"></div><div class="signal-orb-ring second"></div>
            <div class="signal-orb-core"></div><span>${esc(attentionMeta.label)}</span>
          </div>
          <div class="signal-copy">
            <div class="signal-title">${esc(data.status?.providerLabel || '本地模型')}<span class="s-pill ${data.status?.modelReady ? 'green' : 'danger'}">${data.status?.modelReady ? 'READY' : 'OFFLINE'}</span></div>
            <p class="signal-model">${esc(data.status?.model || '—')}</p>
            <div class="signal-meta">
              <span>${esc(data.status?.focus ? '专注模式' : '常规模式')}</span>
              <span>${esc(data.status?.quiet ? '静默时段' : '可出声')}</span>
              <span>${data.status?.ollamaOk ? '健康检查通过' : '健康检查异常'}</span>
            </div>
            <div class="pipeline">
              <div class="pipe ${latest?.asrMs != null ? 'on' : ''}"><b>听</b><span>${esc(fmtMs(latest?.asrMs))}</span></div>
              <i class="pipe-line"></i>
              <div class="pipe ${latest?.firstTokenMs != null ? 'on' : ''}"><b>想</b><span>${esc(fmtMs(latest?.firstTokenMs))}</span></div>
              <i class="pipe-line"></i>
              <div class="pipe ${latest?.firstAudioMs != null ? 'on' : ''}"><b>说</b><span>${esc(fmtMs(latest?.firstAudioMs))}</span></div>
            </div>
          </div>
        </div>`, 'span-7')}
      ${panel('延迟构成', `首字 ${fmtMs(latest?.firstTokenMs)} · 整轮 ${fmtMs(latest?.totalMs)}。文本回合没有语音阶段。`, `<div class="stage-list">${stageHtml}</div>
        <div class="trace-foot"><span>${latest ? esc(latest.text || '（未记录文本）') : '暂无回合'}</span>${latest ? pill(latest.status === 'ok' ? 'OK' : latest.status.toUpperCase(), latest.status === 'ok' ? 'green' : 'danger') : ''}</div>`, 'span-5')}

      ${panel('延迟趋势', '最近 42 个回合，单位为毫秒；颜色越靠下越接近“用户等待”的实际感受。', latencyChart(series), 'span-7')}
      ${panel('记忆构成', `${mem.stats?.total ?? 0} 条 · ${mem.stats?.episodes ?? 0} 个情景 · ${mem.stats?.embedded ?? 0} 条有向量`, `
        <div class="donut-layout">${donut(kindParts, String(mem.stats?.total ?? 0))}<div class="legend-list">${byKindText}
          <button class="s-link" data-open-tab="memory">打开记忆星座 →</button></div></div>`, 'span-5')}

      ${panel('最新回合 · 追踪', '从 ASR、召回、模型到语音，用一条回合线串起来；这是排查“为什么慢”的入口。', `
        <div class="waterfall">${latest ? `<div class="waterfall-head"><div><b>${esc(latest.source === 'voice' ? '语音回合' : '文本回合')}</b><span>${esc(fmtAgo(latest.startedAt))} · ${esc(latest.id.slice(0, 8))}</span></div><div class="waterfall-total">${esc(fmtMs(latest.totalMs))}</div></div>
          <div class="waterfall-bar"><i class="wf-asr" style="width:${latest.asrMs ? Math.max(4, Math.round((latest.asrMs / Math.max(1, latest.totalMs || 1)) * 100)) : 0}%"></i><i class="wf-model" style="width:${Math.max(4, Math.round(((latest.firstTokenMs || 0) / Math.max(1, latest.totalMs || 1)) * 100))}%"></i><i class="wf-tail"></i></div>
          <div class="waterfall-legend"><span><i class="wf-asr"></i>ASR ${esc(fmtMs(latest.asrMs))}${latest.asrAudioMs ? ` · 音频 ${esc(fmtMs(latest.asrAudioMs))}` : ''}</span><span><i class="wf-model"></i>首字 ${esc(fmtMs(latest.firstTokenMs))}</span><span><i class="wf-audio"></i>首段 ${esc(fmtMs(latest.firstAudioMs))}</span><span>记忆召回 ${latest.contextCount}</span></div>
          <p class="waterfall-text">${esc(truncate(latest.text || '—', 180))}</p>` : '<div class="muted small">还没有可追踪的回合。</div>'}</div>`, 'span-7')}
      ${panel('事件流', '按时间倒序；点击“事件”页看完整载荷。', `<div class="event-list">${eventRows(eventList, 10) || '<div class="muted small">还没有事件。</div>'}</div>`, 'span-5')}

      ${panel('回合健康', '近期成功率、错误和平均首字；偏慢的回合会在趋势里冒尖。', `
        <div class="health-grid">
          <div><span>成功率</span><b>${Math.round((success / totalTurns) * 100)}%</b><small>${success}/${totalTurns} 回合</small></div>
          <div><span>错误</span><b class="${t.counters.errors ? 'danger-text' : ''}">${t.counters.errors}</b><small>累计错误</small></div>
          <div><span>平均首字</span><b>${esc(fmtMs(averageToken))}</b><small>${tokenTurns.length} 个样本</small></div>
          <div><span>语音回合</span><b>${t.counters.voiceTurns}</b><small>${t.counters.textTurns} 文本</small></div>
          <div><span>召回</span><b>${t.counters.recalls}</b><small>${t.counters.memoryAdded} 写入</small></div>
          <div><span>捕获</span><b>${t.counters.captures}</b><small>${t.counters.actions} 动作</small></div>
        </div>`, 'span-6')}
      ${panel('持久化回合', '最近完成的回合会写入本机 JSONL；重启后仍可回看，用于排查“刚才那轮为什么慢”。', traceHistoryTable(state.traceHistory), 'span-12')}
      ${panel('系统', '本机进程与资源；Jarvis 默认只监听回环地址。', `
        <div class="system-rows">
          <div><span>运行时长</span><b>${esc(fmtMs(data.uptimeMs))}</b></div>
          <div><span>Node</span><b>${esc(data.config?.runtime?.node || '—')}</b></div>
          <div><span>1 / 5 / 15 分钟负载</span><b>${t.system.load1.toFixed(2)} / ${t.system.load5.toFixed(2)} / ${t.system.load15.toFixed(2)}</b></div>
          <div><span>内存</span><b>${t.system.freeMemMb} / ${t.system.totalMemMb} MB 空闲</b></div>
          <div><span>进程 RSS / Heap</span><b>${t.system.processRssMb} / ${t.system.heapUsedMb} MB</b></div>
          <div><span>监听</span><b>${esc(data.config?.host)}:${esc(data.config?.port)}</b></div>
        </div>`, 'span-6')}
    </div>`

  $$('[data-open-tab]').forEach(button => button.addEventListener('click', () => void setTab(button.dataset.openTab)))
}

function traceHistoryTable(traces) {
  if (!traces?.length) return '<div class="muted small">还没有持久化回合。完成一次文本或语音对话后会出现。</div>'
  return `<div class="trace-table">${traces.map(trace => `<div class="trace-row">
    <span class="trace-time">${esc(fmtAgo(trace.startedAt))}</span>
    <span class="trace-source">${trace.source === 'voice' ? '语音' : '文本'}</span>
    <span>${pill(trace.status === 'ok' ? 'OK' : trace.status.toUpperCase(), trace.status === 'ok' ? 'green' : 'danger')}</span>
    <span class="trace-metric">首字 ${esc(fmtMs(trace.firstTokenMs))}</span>
    <span class="trace-metric">整轮 ${esc(fmtMs(trace.totalMs))}</span>
    <span class="trace-text">${esc(truncate(trace.text || '—', 54))}</span>
  </div>`).join('')}</div>`
}

function memoryFiltered() {
  if (!state.graph) return { nodes: [], edges: [] }
  const view = state.memoryView
  const search = view.search.trim().toLowerCase()
  const nodes = state.graph.nodes.filter(node => {
    if (view.kind !== 'all' && node.kind !== view.kind) return false
    if (view.status !== 'all' && node.status !== view.status) return false
    if (view.sensitivity !== 'all' && node.sensitivity !== view.sensitivity) return false
    if (search && !`${node.gist} ${node.content}`.toLowerCase().includes(search)) return false
    return true
  })
  const ids = new Set(nodes.map(node => node.id))
  return { nodes, edges: state.graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) }
}

function hashJitter(id) {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0
  return ((Math.abs(hash) % 1000) / 1000 - 0.5) * 34
}

function layoutMemory(nodes, edges, width, height) {
  const kinds = ['semantic', 'episodic', 'procedural', 'prospective']
  const positions = new Map()
  const centerX = width / 2
  const centerY = height / 2 + 4
  const cluster = Math.min(width, height) * 0.29
  for (const node of nodes) {
    const kindIndex = Math.max(0, kinds.indexOf(node.kind))
    const angle = (kindIndex / kinds.length) * Math.PI * 2 - Math.PI / 2
    positions.set(node.id, {
      x: centerX + Math.cos(angle) * cluster + hashJitter(`${node.id}a`),
      y: centerY + Math.sin(angle) * cluster + hashJitter(`${node.id}b`),
      vx: 0, vy: 0,
    })
  }
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const activeEdges = edges.filter(edge => nodeById.has(edge.source) && nodeById.has(edge.target))
  for (let iteration = 0; iteration < 110; iteration += 1) {
    const force = new Map(nodes.map(node => [node.id, { x: 0, y: 0 }]))
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = positions.get(nodes[i].id)
        const b = positions.get(nodes[j].id)
        let dx = a.x - b.x
        let dy = a.y - b.y
        let distance = Math.hypot(dx, dy)
        if (distance < 0.01) {
          dx = hashJitter(`${nodes[i].id}${nodes[j].id}`) + 0.01
          dy = hashJitter(`${nodes[j].id}${nodes[i].id}`) + 0.01
          distance = Math.hypot(dx, dy)
        }
        const repulsion = 1250 / (distance * distance)
        const fx = (dx / distance) * repulsion
        const fy = (dy / distance) * repulsion
        const fa = force.get(nodes[i].id)
        const fb = force.get(nodes[j].id)
        fa.x += fx; fa.y += fy
        fb.x -= fx; fb.y -= fy
      }
    }
    for (const edge of activeEdges) {
      const a = positions.get(edge.source)
      const b = positions.get(edge.target)
      const dx = b.x - a.x
      const dy = b.y - a.y
      const distance = Math.max(0.01, Math.hypot(dx, dy))
      const target = edge.type === 'supersedes' ? 70 : 105
      const spring = (distance - target) * 0.0055 * (edge.weight || 0.5)
      const fx = (dx / distance) * spring
      const fy = (dy / distance) * spring
      const fa = force.get(edge.source)
      const fb = force.get(edge.target)
      fa.x += fx; fa.y += fy
      fb.x -= fx; fb.y -= fy
    }
    for (const node of nodes) {
      const position = positions.get(node.id)
      const kindIndex = Math.max(0, kinds.indexOf(node.kind))
      const angle = (kindIndex / kinds.length) * Math.PI * 2 - Math.PI / 2
      const targetX = centerX + Math.cos(angle) * cluster
      const targetY = centerY + Math.sin(angle) * cluster
      const f = force.get(node.id)
      f.x += (centerX - position.x) * 0.0014 + (targetX - position.x) * 0.0022
      f.y += (centerY - position.y) * 0.0014 + (targetY - position.y) * 0.0022
      position.vx = (position.vx + f.x) * 0.78
      position.vy = (position.vy + f.y) * 0.78
      position.x = clamp(position.x + position.vx, 34, width - 34)
      position.y = clamp(position.y + position.vy, 32, height - 32)
    }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const position of positions.values()) {
    minX = Math.min(minX, position.x); minY = Math.min(minY, position.y)
    maxX = Math.max(maxX, position.x); maxY = Math.max(maxY, position.y)
  }
  const paddingX = 82
  const paddingY = 46
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  for (const position of positions.values()) {
    position.x = paddingX + ((position.x - minX) / spanX) * (width - paddingX * 2)
    position.y = paddingY + ((position.y - minY) / spanY) * (height - paddingY * 2)
  }
  return nodes.map(node => ({ ...node, ...positions.get(node.id) }))
}

function graphEmpty() {
  return `<div class="graph-empty"><div class="graph-empty-orbit"><i></i><i></i><i></i></div><strong>记忆还是空的</strong><p>当 Jarvis 确认一条事实、完成一段情景或记住一个承诺，它会在这里长出一颗星。</p><div class="graph-empty-actions"><button class="s-btn ghost" data-open-tab="overview">回到总览</button><button class="s-btn" data-demo-seed="1">加载演示记忆</button></div></div>`
}

function renderGraph() {
  const wrap = $('#memory-graph-wrap')
  const svg = $('#memory-graph')
  if (!wrap || !svg) return
  const { nodes, edges } = memoryFiltered()
  if (nodes.length === 0) {
    wrap.innerHTML = graphEmpty()
    $$('[data-open-tab]', wrap).forEach(button => button.addEventListener('click', () => void setTab(button.dataset.openTab)))
    $$('[data-demo-seed]', wrap).forEach(button => button.addEventListener('click', () => void seedDemoMemory()))
    state.layoutNodes = []
    return
  }
  const width = 920
  const height = 570
  const layout = layoutMemory(nodes, edges, width, height)
  state.layoutNodes = layout
  const positions = new Map(layout.map(node => [node.id, node]))
  const selected = state.memoryView.selected
  const labels = state.memoryView.labels
  const edgeSvg = edges.map(edge => {
    const a = positions.get(edge.source)
    const b = positions.get(edge.target)
    if (!a || !b) return ''
    const cls = edge.type === 'supersedes' ? 'supersedes' : edge.type === 'link' ? 'link' : 'similar'
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" class="m-edge ${cls}" style="opacity:${edge.type === 'similar' ? Math.max(0.12, Math.min(0.55, edge.weight * 0.55)) : 0.75}" ${edge.type === 'supersedes' ? 'marker-end="url(#arrow)"' : ''}><title>${esc(edge.type)} · ${edge.weight}</title></line>`
  }).join('')
  const nodeSvg = layout.map(node => {
    const meta = KIND[node.kind] || KIND.semantic
    const radius = clamp(6 + node.importance * 9 + Math.log2(node.useCount + 1) * 1.8 + Math.min(4, node.degree * 0.5), 7, 27)
    const selectedClass = node.id === selected ? 'selected' : ''
    const statusClass = node.status === 'proposed' ? 'proposed' : node.status !== 'confirmed' ? 'inactive' : ''
    const label = truncate(node.gist || node.content, 18)
    return `<g class="m-node ${selectedClass} ${statusClass}" data-memory-id="${esc(node.id)}" tabindex="0" role="button" aria-label="${esc(label)}">
      <circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${(radius + 7).toFixed(1)}" class="m-halo" style="stroke:${meta.color}"/>
      <circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${radius.toFixed(1)}" class="m-dot" style="fill:${meta.color};stroke:${node.sensitivity === 'secret' ? '#f07984' : node.pinned ? '#f3b36a' : 'rgba(8,11,15,.9)'}"/>
      ${node.status === 'proposed' ? `<circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${(radius + 3.5).toFixed(1)}" class="m-proposed-ring" style="stroke:${meta.color}"/>` : ''}
      ${(labels || node.id === selected) ? `<text x="${node.x.toFixed(1)}" y="${(node.y + radius + 14).toFixed(1)}" text-anchor="middle" class="m-label ${node.id === selected ? 'selected' : ''}">${esc(label)}</text>` : ''}
      <title>${esc(node.gist || node.content)}\n${esc(meta.label)} · ${esc(STATUS[node.status]?.label || node.status)} · 重要度 ${node.importance}</title>
    </g>`
  }).join('')
  const zoom = state.memoryView.zoom
  const viewWidth = width / zoom
  const viewHeight = height / zoom
  const maxPanX = (width - viewWidth) / 2
  const maxPanY = (height - viewHeight) / 2
  state.memoryView.panX = clamp(state.memoryView.panX, -maxPanX, maxPanX)
  state.memoryView.panY = clamp(state.memoryView.panY, -maxPanY, maxPanY)
  const viewX = (width - viewWidth) / 2 - state.memoryView.panX
  const viewY = (height - viewHeight) / 2 - state.memoryView.panY
  svg.setAttribute('viewBox', `${viewX} ${viewY} ${viewWidth} ${viewHeight}`)
  svg.innerHTML = `<defs>
      <radialGradient id="graph-bg" cx="50%" cy="48%" r="65%"><stop offset="0" stop-color="rgba(43,102,96,.18)"/><stop offset="1" stop-color="rgba(8,11,15,0)"/></radialGradient>
      <pattern id="graph-grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="rgba(255,255,255,.035)" stroke-width="1"/></pattern>
      <marker id="arrow" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#f3b36a"/></marker>
      <filter id="node-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#graph-bg)"/>
    <rect width="${width}" height="${height}" fill="url(#graph-grid)"/>
    <g class="m-edges">${edgeSvg}</g>
    <g class="m-nodes">${nodeSvg}</g>`
  $$('.m-node', svg).forEach(element => {
    const select = () => selectMemory(element.dataset.memoryId)
    element.addEventListener('click', select)
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select() }
    })
  })
  bindGraphInteractions(svg, width, height)
}

function bindGraphInteractions(svg, width, height) {
  const applyView = () => {
    const zoom = state.memoryView.zoom
    const viewWidth = width / zoom
    const viewHeight = height / zoom
    const maxPanX = (width - viewWidth) / 2
    const maxPanY = (height - viewHeight) / 2
    state.memoryView.panX = clamp(state.memoryView.panX, -maxPanX, maxPanX)
    state.memoryView.panY = clamp(state.memoryView.panY, -maxPanY, maxPanY)
    svg.setAttribute('viewBox', `${(width - viewWidth) / 2 - state.memoryView.panX} ${(height - viewHeight) / 2 - state.memoryView.panY} ${viewWidth} ${viewHeight}`)
  }
  svg.onwheel = event => {
    event.preventDefault()
    const next = clamp(state.memoryView.zoom + (event.deltaY > 0 ? -0.08 : 0.08), 0.6, 2.4)
    if (Math.abs(next - state.memoryView.zoom) < 0.001) return
    state.memoryView.zoom = next
    applyView()
    const label = $('.zoom-label')
    if (label) label.textContent = `${Math.round(next * 100)}%`
  }
  const host = svg.parentElement || svg
  host.style.touchAction = 'none'
  let dragging = false
  let lastX = 0
  let lastY = 0
  host.onpointerdown = event => {
    if (event.target.closest('.m-node')) return
    dragging = true
    lastX = event.clientX
    lastY = event.clientY
    try { host.setPointerCapture(event.pointerId) } catch { /* synthetic pointers */ }
    svg.classList.add('dragging')
  }
  host.onpointermove = event => {
    if (!dragging) return
    const rect = svg.getBoundingClientRect()
    const scaleX = (width / state.memoryView.zoom) / Math.max(1, rect.width)
    const scaleY = (height / state.memoryView.zoom) / Math.max(1, rect.height)
    state.memoryView.panX += (event.clientX - lastX) * scaleX
    state.memoryView.panY += (event.clientY - lastY) * scaleY
    lastX = event.clientX
    lastY = event.clientY
    applyView()
  }
  const stop = () => {
    dragging = false
    svg.classList.remove('dragging')
  }
  host.onpointerup = stop
  host.onpointercancel = stop
  host.onpointerleave = stop
}

function selectMemory(id) {
  state.memoryView.selected = id
  $$('.m-node').forEach(element => element.classList.toggle('selected', element.dataset.memoryId === id))
  const node = state.graph?.nodes.find(item => item.id === id)
  if (node) {
    if (!state.memoryView.labels) renderGraph()
    renderInspector(node)
  }
}

function renderInspector(node = null) {
  const panel = $('#memory-inspector')
  if (!panel) return
  const selected = node || state.graph?.nodes.find(item => item.id === state.memoryView.selected)
  if (!selected) {
    panel.innerHTML = `<div class="inspector-empty"><span>✦</span><strong>选择一颗星</strong><p>点击左侧记忆节点，查看内容、来源、重要度与可执行动作。</p></div>`
    return
  }
  const meta = KIND[selected.kind] || KIND.semantic
  const status = STATUS[selected.status] || { label: selected.status, tone: 'muted' }
  const importance = selected.importanceDetail || {}
  const bars = [
    ['目标', importance.goal], ['新意', importance.novelty], ['社交', importance.social],
    ['重复', importance.repetition], ['明确', importance.explicit], ['期限', importance.deadline],
  ].map(([label, value]) => `<div class="importance-row"><span>${label}</span><i><b style="width:${Math.round((value || 0) * 100)}%"></b></i><em>${Math.round((value || 0) * 100)}</em></div>`).join('')
  panel.innerHTML = `<div class="inspector-head">
      <div><span class="s-pill" style="border-color:${meta.color};color:${meta.color}">${esc(meta.label)}</span> ${pill(status.label, status.tone)} ${selected.pinned ? pill('已固定', 'amber') : ''}</div>
      <span class="inspector-id">${esc(selected.id.slice(0, 10))}</span>
    </div>
    <h3>${esc(selected.gist || '（无摘要）')}</h3>
    <p class="inspector-content">${esc(selected.content)}</p>
    <div class="inspector-meta">
      <div><span>来源</span><b>${esc(selected.sourceKind)}</b></div>
      <div><span>置信度</span><b>${Math.round(selected.confidence * 100)}%</b></div>
      <div><span>使用</span><b>${selected.useCount} 次</b></div>
      <div><span>敏感级</span><b>${esc(selected.sensitivity)}</b></div>
      <div><span>创建</span><b>${esc(fmtAgo(selected.createdAt))}</b></div>
      <div><span>更新</span><b>${esc(fmtAgo(selected.updatedAt))}</b></div>
      <div><span>有效期</span><b>${esc((selected.validTo ? '至 ' + fmtDate(selected.validTo) : '至今'))}</b></div>
    </div>
    <div class="inspector-importance"><div class="inspector-subhead"><span>重要度分解</span><b>${selected.importance.toFixed(2)}</b></div>${bars}</div>
    <div class="inspector-source"><span>SOURCE REF</span><code>${esc(selected.sourceRef || '—')}</code></div>
    <div class="inspector-actions">
      ${selected.status === 'proposed' ? `<button class="s-btn primary" data-memory-action="confirm">确认记忆</button><button class="s-btn" data-memory-action="reject">拒绝</button>` : ''}
      <button class="s-btn danger" data-memory-action="delete">删除</button>
      <button class="s-btn ghost" data-memory-action="close">收起</button>
    </div>`
  $$('[data-memory-action]', panel).forEach(button => button.addEventListener('click', () => void memoryAction(selected.id, button.dataset.memoryAction)))
}

async function memoryAction(id, action) {
  if (action === 'close') {
    state.memoryView.selected = null
    $$('.m-node').forEach(element => element.classList.remove('selected'))
    renderInspector(null)
    return
  }
  if (action === 'delete' && !window.confirm('删除这条记忆？此操作不可撤销。')) return
  try {
    if (action === 'delete') await api(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })
    else await api(`/api/memory/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' })
    notify(action === 'delete' ? '记忆已删除' : action === 'confirm' ? '已确认' : '已拒绝')
    await loadGraph()
    state.data = await api('/api/observatory')
    const { nodes } = memoryFiltered()
    if (!nodes.some(node => node.id === state.memoryView.selected)) state.memoryView.selected = nodes[0]?.id ?? null
    renderMemory()
    window.dispatchEvent(new CustomEvent('jarvis:memory-changed'))
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'danger')
  }
}

function memoryTimeline(nodes) {
  const days = 21
  const buckets = []
  const now = new Date()
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(now)
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - index)
    buckets.push({ key: date.toISOString().slice(0, 10), label: `${date.getMonth() + 1}/${date.getDate()}`, count: 0 })
  }
  const byKey = new Map(buckets.map(bucket => [bucket.key, bucket]))
  for (const node of nodes) {
    const key = String(node.createdAt || '').slice(0, 10)
    const bucket = byKey.get(key)
    if (bucket) bucket.count += 1
  }
  const max = Math.max(1, ...buckets.map(bucket => bucket.count))
  return `<div class="m-timeline">${buckets.map((bucket, index) => `<div class="m-timeline-col" title="${bucket.key} · ${bucket.count}"><span>${bucket.count || ''}</span><i style="height:${Math.max(3, Math.round((bucket.count / max) * 100))}%"></i><em>${index % 4 === 0 || index === days - 1 ? bucket.label : ''}</em></div>`).join('')}</div>`
}

function memoryStatusBars(byStatus) {
  const entries = Object.entries(byStatus || {})
  const max = Math.max(1, ...entries.map(([, count]) => count))
  if (!entries.length) return '<div class="muted small">还没有数据。</div>'
  return entries.map(([status, count]) => `<div class="status-row"><span>${esc(STATUS[status]?.label || status)}</span><i><b class="${status}" style="width:${Math.round((count / max) * 100)}%"></b></i><em>${count}</em></div>`).join('')
}

function renderRecall() {
  const result = state.recall
  if (state.recallLoading) return `<div class="muted small">正在召回…</div>`
  if (!result) return `<div class="recall-idle"><span>⌕</span><p>输入一句真实的问题，查看哪些记忆被召回、为什么被召回，以及每一项的得分。</p></div>`
  if (!result.items?.length) return `<div class="muted small">没有召回结果。${esc((result.missing || []).join(' '))}</div>`
  return `<div class="recall-summary">置信度 <b>${Math.round((result.confidence || 0) * 100)}%</b> · ${esc(result.queryType || 'query')} · ${result.items.length} 条</div>
    ${result.items.map(item => `<div class="recall-item"><div class="recall-head"><strong>${esc(truncate(item.gist, 52))}</strong><b>${item.score.toFixed(2)}</b></div>
      <div class="recall-bars"><span title="语义">S <i><b style="width:${Math.round((item.semantic || 0) * 100)}%"></b></i></span><span title="重要度">I <i><b style="width:${Math.round((item.importanceScore || 0) * 100)}%"></b></i></span><span title="强度">R <i><b style="width:${Math.round((item.strength || 0) * 100)}%"></b></i></span></div>
      <div class="recall-why">${(item.why || []).map(why => pill(why, 'muted')).join('')}</div></div>`).join('')}`
}


function renderMemory() {
  if (!state.graph) return
  const graph = state.graph
  if (!state.memoryView.labelsTouched) state.memoryView.labels = Boolean(visualValues['ui.graphLabels'])
  const { nodes, edges } = memoryFiltered()
  if (!nodes.some(node => node.id === state.memoryView.selected)) state.memoryView.selected = nodes.slice().sort((a, b) => b.score - a.score)[0]?.id ?? null
  const selected = graph.nodes.find(node => node.id === state.memoryView.selected) || null
  const stats = state.data?.memory?.stats || {}
  const byKind = graph.counts || {}
  const kindChips = [['all', '全部', graph.nodes.length], ...Object.entries(KIND).map(([kind, meta]) => [kind, meta.label, byKind[kind] || 0])]
    .map(([kind, label, count]) => `<button class="filter-chip ${state.memoryView.kind === kind ? 'active' : ''}" data-kind="${kind}">${esc(label)} <b>${count}</b></button>`).join('')
  const rows = nodes.slice().sort((a, b) => b.score - a.score).slice(0, 60).map(node => `<tr data-memory-id="${esc(node.id)}" tabindex="0" class="${node.id === selected?.id ? 'selected' : ''}">
      <td><i class="kind-dot" style="background:${KIND[node.kind]?.color || '#888'}"></i>${esc(truncate(node.gist, 46))}</td>
      <td>${esc(KIND[node.kind]?.label || node.kind)}</td>
      <td>${pill(STATUS[node.status]?.label || node.status, STATUS[node.status]?.tone || 'muted')}</td>
      <td>${Math.round(node.confidence * 100)}%</td>
      <td>${node.importance.toFixed(2)}</td>
      <td>${esc(fmtAgo(node.updatedAt))}</td>
    </tr>`).join('')
  const kindParts = Object.entries(byKind).map(([kind, count]) => ({ label: KIND[kind]?.label || kind, count, color: KIND[kind]?.color || '#8b97a6' }))
  $('#studio-content').innerHTML = `
    <div class="memory-hero">
      <div><p class="s-eyebrow">CONSTELLATION / ${graph.nodes.length} NODES · ${graph.edges.length} EDGES</p><h2>记忆不是列表，是一张会发光的图。</h2><p>语义、情景、程序和未来承诺各自成簇；相似度、取代关系和人工链接形成边。候选记忆是空心环，敏感记忆带红色边界。</p></div>
      <div class="memory-hero-side"><div class="memory-orbit-mini"><i></i><i></i><i></i></div><span>${stats.embedded || 0} / ${stats.total || 0} 有向量</span></div>
    </div>
    <div class="s-kpis memory-kpis">
      ${statCard('总记忆', String(stats.total ?? graph.nodes.length), `${graph.nodes.length} 个显示节点`, 'cyan')}
      ${statCard('已确认', String(stats.confirmed ?? 0), `${stats.proposed ?? 0} 个候选`, 'green')}
      ${statCard('敏感', String(stats.sensitive ?? 0), '标准 / 敏感 / 秘密', 'amber')}
      ${statCard('联系', String(graph.edges.length), `${graph.edges.filter(edge => edge.type === 'supersedes').length} 条取代`, '')}
      ${statCard('情景', String(stats.episodes ?? 0), '对话与感知留下的轨迹', '')}
    </div>
    <section class="s-panel graph-panel">
      <div class="graph-toolbar">
        <div class="filter-chips">${kindChips}</div>
        <div class="graph-controls">
          <select id="memory-status" aria-label="状态筛选"><option value="all">全部状态</option>${Object.entries(STATUS).map(([value, meta]) => `<option value="${value}" ${state.memoryView.status === value ? 'selected' : ''}>${esc(meta.label)}</option>`).join('')}</select>
          <select id="memory-sensitivity" aria-label="敏感级筛选"><option value="all">全部敏感级</option><option value="standard" ${state.memoryView.sensitivity === 'standard' ? 'selected' : ''}>标准</option><option value="sensitive" ${state.memoryView.sensitivity === 'sensitive' ? 'selected' : ''}>敏感</option><option value="secret" ${state.memoryView.sensitivity === 'secret' ? 'selected' : ''}>秘密</option></select>
          <input id="memory-search" type="search" placeholder="搜索记忆…" aria-label="搜索记忆" value="${esc(state.memoryView.search)}">
          <button class="s-icon-btn ${state.memoryView.labels ? 'active' : ''}" id="memory-labels" title="切换标签" aria-pressed="${state.memoryView.labels}" aria-label="显示节点标签">Aa</button>
          <button class="s-icon-btn" id="graph-zoom-out" title="缩小" aria-label="缩小关系图">−</button><span class="zoom-label">${Math.round(state.memoryView.zoom * 100)}%</span><button class="s-icon-btn" id="graph-zoom-in" title="放大" aria-label="放大关系图">+</button>
          <button class="s-icon-btn" id="graph-reset" title="复位" aria-label="复位关系图">⌂</button>
        </div>
      </div>
      <div class="memory-stage">
        <div class="graph-wrap" id="memory-graph-wrap"><svg class="memory-graph" id="memory-graph" role="img" aria-label="记忆关系图"></svg><div class="graph-legend"><span><i class="semantic"></i>语义</span><span><i class="episodic"></i>情景</span><span><i class="procedural"></i>程序</span><span><i class="prospective"></i>未来</span><span class="legend-note">空心=候选 · 红边=敏感</span></div><div class="graph-hint">拖动平移 · 滚轮缩放 · 点击节点查看</div></div>
        <aside class="inspector-panel" id="memory-inspector"></aside>
      </div>
    </section>
    <div class="s-grid memory-lower">
      ${panel('记忆时间线', '最近 21 天创建的记忆；空白不代表遗忘，可能只是没有新记忆。', memoryTimeline(nodes), 'span-4')}
      ${panel('状态分布', '候选记忆需要确认才会进入默认召回。', `<div class="donut-layout small">${donut(kindParts, String(graph.nodes.length))}<div class="status-bars">${memoryStatusBars(state.data?.memory?.byStatus)}</div></div>`, 'span-4')}
      ${panel('召回实验台', '用真实查询验证召回解释；这是调参记忆门槛时最直接的反馈。', `<form class="recall-form" id="recall-form"><input id="recall-query" placeholder="例如：我上次说周五要做什么？" autocomplete="off" aria-label="召回测试查询" value="${esc(state.recallQuery)}"><button class="s-btn primary" type="submit">召回</button></form><div id="recall-results" class="recall-results">${renderRecall()}</div>`, 'span-4')}
    </div>
    ${panel('记忆列表', `${nodes.length} 条符合筛选 · 按综合分排序`, `<div class="table-wrap"><table class="s-table"><thead><tr><th>摘要</th><th>类型</th><th>状态</th><th>置信</th><th>重要</th><th>更新</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="muted">没有符合筛选的记忆。</td></tr>`}</tbody></table></div>`, 'span-12')}`

  renderGraph()
  renderInspector(selected)

  $$('.filter-chip').forEach(button => button.addEventListener('click', () => {
    state.memoryView.kind = button.dataset.kind
    renderMemory()
  }))
  $('#memory-status')?.addEventListener('change', event => { state.memoryView.status = event.target.value; renderMemory() })
  $('#memory-sensitivity')?.addEventListener('change', event => { state.memoryView.sensitivity = event.target.value; renderMemory() })
  $('#memory-search')?.addEventListener('input', event => {
    state.memoryView.search = event.target.value
    clearTimeout(state.searchTimer)
    state.searchTimer = setTimeout(() => renderMemory(), 180)
  })
  $('#memory-labels')?.addEventListener('click', () => { state.memoryView.labels = !state.memoryView.labels; state.memoryView.labelsTouched = true; renderMemory() })
  $('#graph-zoom-in')?.addEventListener('click', () => { state.memoryView.zoom = clamp(state.memoryView.zoom + 0.15, 0.6, 2); renderGraph() })
  $('#graph-zoom-out')?.addEventListener('click', () => { state.memoryView.zoom = clamp(state.memoryView.zoom - 0.15, 0.6, 2); renderGraph() })
  $('#graph-reset')?.addEventListener('click', () => { state.memoryView.zoom = 1; state.memoryView.panX = 0; state.memoryView.panY = 0; renderGraph() })
  $$('tr[data-memory-id]').forEach(row => row.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectMemory(row.dataset.memoryId) }
  }))
  $$('tr[data-memory-id]').forEach(row => row.addEventListener('click', () => {
    selectMemory(row.dataset.memoryId)
    $('#memory-inspector')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }))
  $('#recall-form')?.addEventListener('submit', event => { event.preventDefault(); void runRecall() })
  $('#recall-query')?.addEventListener('input', event => { state.recallQuery = event.target.value })
}

async function runRecall() {
  const input = $('#recall-query')
  const query = input?.value.trim()
  if (!query) return
  state.recallQuery = query
  state.recallLoading = true
  const target = $('#recall-results')
  if (target) target.innerHTML = renderRecall()
  try {
    state.recall = await api(`/api/memory?query=${encodeURIComponent(query)}`)
  } catch (error) {
    state.recall = { items: [], confidence: 0, missing: [error instanceof Error ? error.message : String(error)] }
  } finally {
    state.recallLoading = false
    if (target) target.innerHTML = renderRecall()
  }
}

async function seedDemoMemory() {
  const buttons = $$('[data-demo-seed]')
  if (buttons.some(button => button.disabled)) return
  buttons.forEach(button => { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = '加载中…' })
  try {
    const result = await api('/api/dev/demo-memory', { method: 'POST', headers: { 'x-jarvis-demo': '1' }, body: '{}' })
    notify(`已加载 ${result.items} 条演示记忆`)
    await loadGraph()
    state.data = await api('/api/observatory')
    renderMemory()
    window.dispatchEvent(new CustomEvent('jarvis:memory-changed'))
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'danger')
  } finally {
    buttons.forEach(button => { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = '加载演示记忆' })
  }
}

async function consolidateMemory() {
  const button = $('#consolidate-memory')
  if (button) { button.disabled = true; button.textContent = '整理中…' }
  try {
    const result = await api('/api/memory/consolidate', { method: 'POST' })
    notify(`已整理：${result.stats?.deduped ?? 0} 条去重 · ${result.stats?.superseded ?? 0} 条取代 · ${result.stats?.expiredProposals ?? 0} 条候选过期`, 'ok')
    await loadGraph()
    state.data = await api('/api/observatory')
    renderMemory()
    window.dispatchEvent(new CustomEvent('jarvis:memory-changed'))
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'danger')
  } finally {
    if (button) { button.disabled = false; button.textContent = '整理记忆' }
  }
}

async function clearDemoMemory() {
  if (!window.confirm('清除所有 demo: 来源的演示记忆？真实记忆不会受影响。')) return
  try {
    const result = await api('/api/dev/demo-memory', { method: 'DELETE', headers: { 'x-jarvis-demo': '1' } })
    notify(`已清除 ${result.removed} 条演示记忆`)
    await loadGraph()
    state.data = await api('/api/observatory')
    renderMemory()
    window.dispatchEvent(new CustomEvent('jarvis:memory-changed'))
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'danger')
  }
}

const APPLY_LABEL = { live: '立即', 'next-turn': '下一轮', restart: '重启', ui: '实时预览' }

function paramValue(param) {
  return state.tuningDraft[param.key] ?? param.default
}

function controlHtml(param) {
  const value = paramValue(param)
  const id = `tune-${param.key.replace(/\./g, '-')}`
  const apply = APPLY_LABEL[param.apply] || param.apply
  let control = ''
  if (param.type === 'range') {
    control = `<div class="range-row"><input type="range" id="${id}" data-tuning-key="${esc(param.key)}" min="${param.min}" max="${param.max}" step="${param.step}" value="${esc(value)}"><input class="num-input" type="number" data-tuning-key="${esc(param.key)}" min="${param.min}" max="${param.max}" step="${param.step}" value="${esc(value)}" aria-label="${esc(param.label)}数值"><span class="unit">${esc(param.unit || '')}</span></div>`
  } else if (param.type === 'number') {
    control = `<div class="range-row"><input class="num-input wide" type="number" id="${id}" data-tuning-key="${esc(param.key)}" min="${param.min}" max="${param.max}" step="${param.step}" value="${esc(value)}"><span class="unit">${esc(param.unit || '')}</span></div>`
  } else if (param.type === 'boolean') {
    control = `<label class="switch-row"><input type="checkbox" id="${id}" data-tuning-key="${esc(param.key)}" ${value ? 'checked' : ''}><span class="switch"></span><em>${value ? '开启' : '关闭'}</em></label>`
  } else if (param.type === 'select') {
    control = `<select id="${id}" data-tuning-key="${esc(param.key)}">${(param.options || []).map(option => `<option value="${esc(option.value)}" ${String(value) === option.value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>`
  } else {
    control = `<input class="text-input" id="${id}" data-tuning-key="${esc(param.key)}" type="text" value="${esc(value)}" maxlength="500">`
  }
  return `<div class="control ${param.advanced ? 'advanced' : ''}" data-control-key="${esc(param.key)}">
    <div class="control-head"><label for="${id}">${esc(param.label)}</label><div class="control-tags"><span class="apply-tag ${param.apply}">${esc(apply)}</span><output data-output-for="${esc(param.key)}">${esc(value)}${esc(param.unit || '')}</output></div></div>
    ${control}<p>${esc(param.description)}</p>
  </div>`
}

function tuningGroupHtml(group) {
  const params = group.params.filter(param => {
    if (!state.showAdvanced && param.advanced) return false
    const query = state.tuningSearch.trim().toLowerCase()
    return !query || `${param.label} ${param.description} ${param.key}`.toLowerCase().includes(query)
  })
  if (!params.length) return ''
  return panel(group.label, group.description, `<div class="control-list">${params.map(controlHtml).join('')}</div>
    <div class="group-foot"><span>${params.length} 项 · 默认值已标记</span><button class="s-link" data-reset-group="${esc(group.id)}">恢复本组默认</button></div>`, 'tuning-group')
}

function tuningDirtyCount() {
  return Object.keys(state.tuningDraft).filter(key => state.tuningDraft[key] !== state.tuningSaved[key]).length
}

function tuningCompareHtml(groups) {
  const changed = groups.flatMap(group => (group.params || []))
    .filter(param => String(state.tuningDraft[param.key] ?? param.default) !== String(param.default))
    .slice(0, 10)
  if (!changed.length) return `<div class="tuning-impact"><p class="s-eyebrow">DEFAULT VS DRAFT</p><div><span class="apply-tag ui">一致</span><p>当前草稿与默认值一致；拖动控件后再看这里。</p></div></div>`
  return `<div class="tuning-impact"><p class="s-eyebrow">DEFAULT VS DRAFT · ${changed.length}</p>${changed.map(param => `<div><span class="apply-tag ui">${esc(param.label)}</span><p><del>${esc(param.default)}</del> → <b>${esc(state.tuningDraft[param.key] ?? param.default)}</b></p></div>`).join('')}</div>`
}

function renderTuning() {
  if (!state.tuning) return
  const dirty = tuningDirtyCount()
  const presets = state.tuning.presets || []
  const groups = state.tuning.groups || []
  const model = state.data?.status
  const currentModel = `${model?.providerLabel || '本地模型'} / ${model?.model || '—'}`
  const dirtyLabel = dirty ? `${dirty} 项未保存` : '全部已保存'
  $('#studio-content').innerHTML = `
    <div class="tuning-hero">
      <div><p class="s-eyebrow">TUNING / ${groups.length} GROUPS · ${Object.keys(state.tuning.values).length} PARAMETERS</p><h2>参数不是开关，是乐器。</h2><p>拖动左侧控件，右侧与主界面实时预览；点“保存并应用”后写入本机 <code>data/tuning.json</code>（0600）。</p></div>
      <div class="preset-row">${presets.map(preset => `<button class="preset-btn" data-preset="${esc(preset.id)}"><strong>${esc(preset.label)}</strong><span>${esc(preset.description)}</span></button>`).join('')}</div>
    </div>
    <div class="tuning-bar ${dirty ? 'dirty' : ''}">
      <div><i></i><span id="tuning-dirty-label">${esc(dirtyLabel)}</span><small>${dirty ? '预览已生效，尚未持久化' : '参数与运行时一致'}</small></div>
      <div class="tuning-bar-actions"><button class="s-btn ghost" id="tuning-revert" ${dirty ? '' : 'disabled'}>放弃修改</button><button class="s-btn" id="tuning-reset-all">全部重置</button><button class="s-btn primary" id="tuning-save" ${dirty ? '' : 'disabled'}>保存并应用</button></div>
    </div>
    <div class="tuning-layout">
      <div class="tuning-main">
        <div class="tuning-tools"><input type="search" id="tuning-search" aria-label="搜索调参项" placeholder="搜索参数名、说明或 key…" value="${esc(state.tuningSearch)}"><button class="s-btn ghost ${state.showAdvanced ? 'active' : ''}" id="tuning-advanced">${state.showAdvanced ? '隐藏高级' : '显示高级'}</button><button class="s-btn ghost ${state.tuningCompare ? 'active' : ''}" id="tuning-compare">A/B 对照</button></div>
        ${groups.map(tuningGroupHtml).join('') || '<div class="s-error"><strong>没有匹配的参数</strong><p>换一个关键词，或显示高级参数。</p></div>'}
      </div>
      <aside class="tuning-side">
        <div class="tuning-preview">
          <p class="s-eyebrow">LIVE PREVIEW</p>
          <div class="preview-orb"><div class="preview-ring"></div><div class="preview-core"></div><span>JARVIS</span></div>
          <div class="preview-values"><span>辉光 <b>${Number(state.tuningDraft['ui.orbGlow']).toFixed(2)}</b></span><span>粒子 <b>${state.tuningDraft['ui.particles']}</b></span><span>模糊 <b>${state.tuningDraft['ui.blur']}px</b></span></div>
        </div>
        <div class="tuning-context">
          <p class="s-eyebrow">ACTIVE MODEL</p><strong>${esc(currentModel)}</strong>
          <span>${state.data?.status?.modelReady ? '健康检查通过' : '模型未就绪'} · ${state.data?.status?.voice?.asr && state.data?.status?.voice?.tts ? '语音链路就绪' : '语音未全就绪'}</span>
        </div>
        <div class="tuning-impact">
          <p class="s-eyebrow">IMPACT</p>
          <div><span class="apply-tag ui">实时</span><p>界面参数立即改变当前页面与主界面；刷新后仍从服务端读取。</p></div>
          <div><span class="apply-tag next-turn">下一轮</span><p>对话、记忆召回参数在下一轮生效，不需要重启。</p></div>
          <div><span class="apply-tag live">立即</span><p>声音参数会重启 Piper worker；正在播放的音频不受影响。</p></div>
          <div><span class="apply-tag restart">重启</span><p>当前版本没有必须重启的参数；端口、TLS 与密钥仍由环境变量控制。</p></div>
        </div>
        ${state.tuningCompare ? tuningCompareHtml(groups) : ''}
        <div class="tuning-file"><span>PERSISTED AT</span><code>data/tuning.json</code><small>权限 0600 · 原子写入 · 不含密钥</small></div>
      </aside>
    </div>`

  bindTuningControls()
}

function bindTuningControls() {
  $$('[data-tuning-key]').forEach(input => {
    input.addEventListener('input', onTuningInput)
    if (input.type === 'range' || input.type === 'number') {
      input.addEventListener('change', onTuningInput)
    }
  })
  $('#tuning-search')?.addEventListener('input', event => {
    state.tuningSearch = event.target.value
    clearTimeout(state.tuningSearchTimer)
    state.tuningSearchTimer = setTimeout(() => renderTuning(), 180)
  })
  $('#tuning-advanced')?.addEventListener('click', () => { state.showAdvanced = !state.showAdvanced; renderTuning() })
  $('#tuning-compare')?.addEventListener('click', () => { state.tuningCompare = !state.tuningCompare; renderTuning() })
  $('#tuning-save')?.addEventListener('click', () => void saveTuning())
  $('#tuning-revert')?.addEventListener('click', () => {
    state.tuningDraft = { ...state.tuningSaved }
    state.tuningDirty = false
    applyVisualTuning(state.tuningDraft)
    renderTuning()
  })
  $('#tuning-reset-all')?.addEventListener('click', () => void resetTuning())
  $$('[data-reset-group]').forEach(button => button.addEventListener('click', () => void resetTuning(button.dataset.resetGroup)))
  $$('[data-preset]').forEach(button => button.addEventListener('click', () => void applyPreset(button.dataset.preset)))
}

function onTuningInput(event) {
  const input = event.target
  const key = input.dataset.tuningKey
  if (!key) return
  const value = input.type === 'checkbox' ? input.checked : input.type === 'range' || input.type === 'number' ? Number(input.value) : input.value
  state.tuningDraft[key] = value
  $$(`[data-tuning-key="${CSS.escape(key)}"]`).forEach(peer => {
    if (peer !== input && peer.type !== 'checkbox') peer.value = String(value)
  })
  const control = input.closest('.control')
  $$('[data-tuning-key]', control).forEach(sibling => {
    if (sibling !== input && sibling.type === input.type) sibling.value = input.value
  })
  const output = $(`[data-output-for="${CSS.escape(key)}"]`, control)
  if (output) {
    const param = state.tuning.groups.flatMap(group => group.params).find(item => item.key === key)
    output.textContent = `${value}${param?.unit || ''}`
    if (param?.type === 'boolean') {
      const label = $('.switch-row em', control)
      if (label) label.textContent = value ? '开启' : '关闭'
    }
  }
  const dirty = tuningDirtyCount()
  state.tuningDirty = dirty > 0
  $('#tuning-dirty-label').textContent = dirty ? `${dirty} 项未保存` : '全部已保存'
  $('.tuning-bar')?.classList.toggle('dirty', dirty > 0)
  $('#tuning-save').disabled = dirty === 0
  $('#tuning-revert').disabled = dirty === 0
  if (key.startsWith('ui.')) applyVisualTuning(state.tuningDraft)
  const preview = $('.preview-values')
  if (preview && key.startsWith('ui.')) {
    preview.innerHTML = `<span>辉光 <b>${Number(state.tuningDraft['ui.orbGlow']).toFixed(2)}</b></span><span>粒子 <b>${state.tuningDraft['ui.particles']}</b></span><span>模糊 <b>${state.tuningDraft['ui.blur']}px</b></span>`
  }
}

async function saveTuning() {
  const values = {}
  for (const key of Object.keys(state.tuningDraft)) {
    if (state.tuningDraft[key] !== state.tuningSaved[key]) values[key] = state.tuningDraft[key]
  }
  if (!Object.keys(values).length) return
  const button = $('#tuning-save')
  if (button) { button.disabled = true; button.textContent = '保存中…' }
  try {
    const result = await api('/api/tuning', { method: 'PUT', body: JSON.stringify({ values }) })
    state.tuning = result.tuning
    state.tuningSaved = { ...result.values }
    state.tuningDraft = { ...result.values }
    state.tuningDirty = false
    applyVisualTuning(result.values)
    renderTuning()
    notify(`已保存 ${result.changed.length} 项参数`)
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'danger')
    if (button) { button.disabled = false; button.textContent = '保存并应用' }
  }
}

async function resetTuning(group) {
  if (!window.confirm(group ? '恢复这一组的默认值？' : '恢复全部参数默认值？这会覆盖当前调参。')) return
  try {
    const result = await api('/api/tuning/reset', { method: 'POST', body: JSON.stringify(group ? { group } : {}) })
    state.tuning = result.tuning
    state.tuningSaved = { ...result.values }
    state.tuningDraft = { ...result.values }
    state.tuningDirty = false
    applyVisualTuning(result.values)
    renderTuning()
    notify('已恢复默认值')
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'danger')
  }
}

async function applyPreset(id) {
  try {
    const result = await api('/api/tuning/preset', { method: 'POST', body: JSON.stringify({ id }) })
    state.tuning = result.tuning
    state.tuningSaved = { ...result.values }
    state.tuningDraft = { ...result.values }
    state.tuningDirty = false
    applyVisualTuning(result.values)
    renderTuning()
    notify(`预设「${result.preset.label}」已应用`)
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'danger')
  }
}

function flattenRows(value, prefix = '', depth = 0) {
  if (depth > 3) return []
  if (value === null || value === undefined) return [{ key: prefix, value: '—' }]
  if (Array.isArray(value)) {
    if (!value.length) return [{ key: prefix, value: '[]' }]
    if (value.every(item => typeof item !== 'object' || item === null)) return [{ key: prefix, value: value.join(', ') }]
    return [{ key: prefix, value: `${value.length} 项` }]
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => flattenRows(child, prefix ? `${prefix}.${key}` : key, depth + 1))
  }
  return [{ key: prefix, value: String(value) }]
}

function configRows(value) {
  return `<div class="config-rows">${flattenRows(value).map(row => `<div class="config-row"><span>${esc(row.key)}</span><code>${esc(row.value)}</code></div>`).join('')}</div>`
}

function renderConfig() {
  const payload = state.config
  if (!payload) return
  const config = payload.config || {}
  const security = config.auth || {}
  const tls = config.tls || {}
  const runtime = config.runtime || {}
  const raw = JSON.stringify(payload, null, 2)
  $('#studio-content').innerHTML = `
    <div class="config-hero">
      <div><p class="s-eyebrow">READ ONLY / REDACTED</p><h2>系统真实运行在什么之上。</h2><p>这里暴露路径、模型、语音和边界条件，但密钥、令牌与远端 API Key 永远不会返回。真正需要修改的值在调参页；端口、TLS 与认证仍由环境变量控制。</p></div>
      <div class="config-actions"><button class="s-btn primary" data-open-tab="tuning">去调参</button><button class="s-btn" id="config-copy">复制 JSON</button></div>
    </div>
    <div class="config-grid">
      ${panel('安全边界', '默认只监听回环；远端必须 HTTPS + Bearer。', `
        <div class="security-list">
          <div class="security-item ${security.required ? 'on' : ''}"><span>认证</span><b>${security.required ? '已启用' : '仅回环'}</b><small>${security.required ? `Bearer · ${security.tokenLength || 0} 字符` : '无令牌，本机默认'}</small></div>
          <div class="security-item ${tls.enabled ? 'on' : ''}"><span>TLS</span><b>${tls.enabled ? '启用' : '关闭'}</b><small>${tls.enabled ? 'HTTPS 终止于本进程' : 'Loopback HTTP'}</small></div>
          <div class="security-item"><span>监听</span><b>${esc(config.host)}:${esc(config.port)}</b><small>${config.host === '127.0.0.1' || config.host === '::1' ? '仅本机可达' : '非回环，必须启用认证与 TLS'}</small></div>
        </div>`, 'span-5')}
      ${panel('运行时', '进程级事实；调试时先看这里。', configRows(runtime), 'span-7')}
      ${panel('模型', '当前 profile 与健康状态；密钥不在此列。', configRows(config.model || {}), 'span-6')}
      ${panel('语音', 'ASR / TTS 二进制与模型路径；本地优先。', configRows(config.voice || {}), 'span-6')}
      ${panel('感知与打扰', '静默、预算与屏幕捕获边界。', configRows({ quiet: config.quiet, dailySpeakBudget: config.dailySpeakBudget, screenTimeoutMs: config.screenTimeoutMs, screenBlocklist: config.screenBlocklist }), 'span-6')}
      ${panel('路径', '数据、网页与运行时目录。', configRows({ dataDir: config.dataDir, webDir: config.webDir }), 'span-6')}
      ${config.host === '127.0.0.1' || config.host === '::1' ? panel('开发工具', '仅回环可用。演示记忆带 demo: 来源标记，可一键清除，不会混入真实记忆。', `<div class="dev-actions"><button class="s-btn primary" data-demo-seed="1">加载演示记忆</button><button class="s-btn" id="consolidate-memory">整理记忆</button><button class="s-btn danger" data-demo-clear="1">清除演示记忆</button><span>演示数据带 demo: 来源标记；整理只做去重、取代链和过期候选，不删除事实。</span></div>`, 'span-12') : ''}
      ${panel('完整脱敏 JSON', '可直接复制给诊断或 issue；已移除所有密钥。', `<pre class="raw-json" id="config-raw">${esc(raw)}</pre>`, 'span-12')}
    </div>`
  $$('[data-demo-seed]').forEach(button => button.addEventListener('click', () => void seedDemoMemory()))
  $('#consolidate-memory')?.addEventListener('click', () => void consolidateMemory())
  $$('[data-demo-clear]').forEach(button => button.addEventListener('click', () => void clearDemoMemory()))
  $$('[data-open-tab]').forEach(button => button.addEventListener('click', () => void setTab(button.dataset.openTab)))
  $('#config-copy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(raw)
      notify('已复制脱敏配置')
    } catch {
      notify('浏览器拒绝剪贴板；请手动选择 JSON', 'danger')
    }
  })
}

const EVENT_FILTERS = {
  all: () => true,
  conversation: type => type.startsWith('turn.') || type.startsWith('assistant.') || type.startsWith('voice.'),
  memory: type => type.startsWith('memory.'),
  attention: type => type.startsWith('attention.'),
  action: type => type.startsWith('action.') || type.startsWith('reminder.'),
  model: type => type.startsWith('model.') || type.startsWith('tuning.'),
}

function renderEvents() {
  if (!state.data) return
  const t = state.data.telemetry
  const filter = EVENT_FILTERS[state.eventFilter] || EVENT_FILTERS.all
  const query = state.eventSearch.trim().toLowerCase()
  const events = (t.events || []).filter(event => filter(event.type) && (!query || `${event.type} ${eventSummary(event)}`.toLowerCase().includes(query)))
  const chips = Object.entries({ all: '全部', conversation: '对话', memory: '记忆', attention: '注意力', action: '动作', model: '模型' }).map(([key, label]) => `<button class="filter-chip ${state.eventFilter === key ? 'active' : ''}" data-event-filter="${key}">${label}</button>`).join('')
  $('#studio-content').innerHTML = `
    <div class="s-kpis">
      ${statCard('事件总数', String(t.counters.events), `${events.length} 条当前视图`, 'cyan')}
      ${statCard('回合', String(t.counters.turns), `${t.counters.voiceTurns} 语音 / ${t.counters.textTurns} 文本`, '')}
      ${statCard('错误', String(t.counters.errors), '累计错误', t.counters.errors ? 'danger' : 'green')}
      ${statCard('记忆', String(t.counters.recalls), `${t.counters.memoryAdded} 写入 · ${t.counters.memoryProposed} 候选`, 'amber')}
      ${statCard('捕获', String(t.counters.captures), '按需采集次数', '')}
    </div>
    <section class="s-panel">
      <div class="event-toolbar"><div class="filter-chips">${chips}</div><div class="graph-controls"><input id="event-search" aria-label="搜索事件" type="search" placeholder="搜索事件…" value="${esc(state.eventSearch)}"><button class="s-btn ghost" id="event-pause">${state.eventsPaused ? '继续' : '暂停'}</button></div></div>
      <div class="event-detail-list">${events.length ? events.map(event => `<details class="event-detail">
        <summary><time>${esc(fmtTime(event.at))}</time><span class="event-type ${eventTone(event.type)}">${esc(EVENT_LABELS[event.type] || event.type)}</span><p>${esc(eventSummary(event))}</p><i>${esc(event.id.slice(0, 8))}</i></summary>
        <pre>${esc(JSON.stringify(event.data || {}, null, 2).slice(0, 6000))}</pre>
      </details>`).join('') : '<div class="muted small" style="padding:24px">没有匹配的事件。</div>'}</div>
    </section>`
  $$('[data-event-filter]').forEach(button => button.addEventListener('click', () => { state.eventFilter = button.dataset.eventFilter; renderEvents() }))
  $('#event-search')?.addEventListener('input', event => {
    state.eventSearch = event.target.value
    clearTimeout(state.eventSearchTimer)
    state.eventSearchTimer = setTimeout(() => renderEvents(), 180)
  })
  $('#event-pause')?.addEventListener('click', () => { state.eventsPaused = !state.eventsPaused; renderEvents() })
}
