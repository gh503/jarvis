/* 模型服务指南：从 /api/providers/catalog 读取公开目录并渲染。 */

const $ = selector => document.querySelector(selector)
const $$ = selector => [...document.querySelectorAll(selector)]

const state = {
  providers: [],
  voices: [],
  filter: 'all',
  query: '',
  voiceFilter: 'all',
  voiceQuery: '',
  platform: null,
  current: null,
}

const REGION_LABEL = { cn: '国内直连', global: '国际', local: '本机模型' }
const KIND_LABEL = { ollama: 'Ollama 原生', openai: 'OpenAI 兼容' }
const VOICE_KIND_LABEL = { asr: '语音识别 ASR', tts: '语音合成 TTS' }
const ADAPTER_LABEL = {
  auto: '自动识别', openai: 'OpenAI 兼容', gemini: 'Gemini 原生', cloudflare: 'Cloudflare 原生', edge: 'Edge TTS 命令行',
}
const PROTOCOL_LABEL = { 'chat-completions': 'Chat Completions', responses: 'Responses', anthropic: 'Anthropic Messages' }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function matches(provider) {
  if (state.filter !== 'all' && provider.region !== state.filter) return false
  const query = state.query.trim().toLowerCase()
  if (!query) return true
  const haystack = [provider.id, provider.name, provider.nameEn, provider.summary, provider.freeTier, ...(provider.tags || []), ...(provider.cautious || [])].join(' ').toLowerCase()
  return haystack.includes(query)
}

function cardHtml(provider) {
  return `<article class="pv-card" data-provider="${escapeHtml(provider.id)}">
    <div class="pv-card-top">
      <div>
        <h2 class="pv-card-name">${escapeHtml(provider.name)}</h2>
        <p class="pv-card-en">${escapeHtml(provider.nameEn)}</p>
      </div>
      <span class="pv-badge ${provider.region === 'local' ? '' : provider.region}">${REGION_LABEL[provider.region] || provider.region}</span>
    </div>
    <p class="pv-card-summary">${escapeHtml(provider.summary)}</p>
    <div class="pv-tags">${(provider.tags || []).map(tag => `<span class="pv-tag">${escapeHtml(tag)}</span>`).join('')}</div>
    <div class="pv-card-meta">
      <span>${provider.chinaDirect ? '✓ 中国大陆可直连' : '需自备网络'}</span>
      <span>${escapeHtml(provider.freeTier)}</span>
    </div>
    <div class="pv-card-actions">
      <button class="pv-primary" type="button" data-use="${escapeHtml(provider.id)}">用这个供应商</button>
      <button class="pv-secondary" type="button" data-detail="${escapeHtml(provider.id)}">看步骤</button>
    </div>
  </article>`
}

function render() {
  const grid = $('#pv-grid')
  const list = state.providers.filter(matches)
  grid.innerHTML = list.length
    ? list.map(cardHtml).join('')
    : '<p class="pv-empty">没有匹配的供应商，换个关键词或点「全部」。</p>'
  const count = $('#pv-count')
  count.textContent = state.providers.length
    ? `共 ${state.providers.length} 个供应商，当前显示 ${list.length} 个`
    : '正在读取供应商列表…'
}

function voiceMatches(entry) {
  if (state.voiceFilter !== 'all' && entry.kind !== state.voiceFilter) return false
  const query = state.voiceQuery.trim().toLowerCase()
  if (!query) return true
  const haystack = [entry.id, entry.name, entry.nameEn, entry.summary, entry.model, entry.voice || '', entry.freeTier, ...(entry.tags || [])].join(' ').toLowerCase()
  return haystack.includes(query)
}

function voiceCardHtml(entry) {
  const needsKey = Boolean(entry.keyUrl)
  return `<article class="pv-card" data-voice="${escapeHtml(entry.id)}">
    <div class="pv-card-top">
      <div>
        <h2 class="pv-card-name">${escapeHtml(entry.name)}</h2>
        <p class="pv-card-en">${escapeHtml(entry.nameEn)}</p>
      </div>
      <span class="pv-badge ${entry.kind}">${entry.kind === 'asr' ? 'ASR' : 'TTS'}</span>
    </div>
    <p class="pv-card-summary">${escapeHtml(entry.summary)}</p>
    <div class="pv-tags">${(entry.tags || []).map(tag => `<span class="pv-tag">${escapeHtml(tag)}</span>`).join('')}</div>
    <div class="pv-card-meta">
      <span>${entry.region === 'local' ? '本机 / 内网' : entry.chinaDirect ? '✓ 中国大陆可直连' : '需自备网络'}</span>
      <span>${escapeHtml(entry.freeTier)}</span>
    </div>
    <div class="pv-card-actions">
      <button class="pv-primary" type="button" data-voice-use="${escapeHtml(entry.id)}">${needsKey ? '用这个语音服务' : '填入语音设置'}</button>
      <button class="pv-secondary" type="button" data-voice-detail="${escapeHtml(entry.id)}">看步骤</button>
    </div>
  </article>`
}

function renderVoices() {
  const grid = $('#pv-voice-grid')
  if (!grid) return
  const list = state.voices.filter(voiceMatches)
  grid.innerHTML = list.length
    ? list.map(voiceCardHtml).join('')
    : '<p class="pv-empty">没有匹配的语音服务，换个关键词或点「全部」。</p>'
  const count = $('#pv-voice-count')
  if (count) {
    count.textContent = state.voices.length
      ? `共 ${state.voices.length} 个语音服务，当前显示 ${list.length} 个`
      : '正在读取语音服务…'
  }
}

function openVoiceDetail(entry) {
  state.current = { ...entry, __voice: true }
  $('#pv-sheet-title').textContent = entry.name
  $('#pv-sheet-region').textContent = `${VOICE_KIND_LABEL[entry.kind] || entry.kind} · ${REGION_LABEL[entry.region] || entry.region} · ${ADAPTER_LABEL[entry.adapter] || entry.adapter}`
  const keyLink = $('#pv-sheet-key')
  if (entry.keyUrl) {
    keyLink.hidden = false
    keyLink.href = entry.keyUrl
    keyLink.textContent = '去创建 API Key ↗'
  } else {
    keyLink.hidden = true
  }
  const address = entry.baseUrl
    ? `<div class="pv-url"><code>${escapeHtml(entry.baseUrl)}</code><button class="pv-copy" type="button" data-copy="${escapeHtml(entry.baseUrl)}">复制</button></div>`
    : '<p class="pv-card-summary">不需要地址：本地引擎或命令行，保存在本机。</p>'
  const extras = [
    entry.model ? `<li>模型：<code>${escapeHtml(entry.model)}</code></li>` : '',
    entry.voice ? `<li>音色：<code>${escapeHtml(entry.voice)}</code></li>` : '',
    entry.kind === 'asr' ? `<li>传输：${entry.transport === 'websocket' ? 'WebSocket 流式' : 'HTTP 一次性上传'}</li>` : '',
    entry.language ? `<li>默认语言：<code>${escapeHtml(entry.language)}</code></li>` : '',
  ].filter(Boolean).join('')
  $('#pv-sheet-body').innerHTML = `
    <h3>三步接上</h3>
    <ol>${entry.setup.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    <h3>要填什么</h3>
    ${address}
    <ul class="pv-voice-fields">${extras}</ul>
    <h3>费用</h3>
    <p class="pv-card-summary">${escapeHtml(entry.freeTier)}</p>
    ${entry.cautions.length ? `<h3>注意</h3><ul>${entry.cautions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
    <h3>官方链接</h3>
    <ul>
      <li><a href="${escapeHtml(entry.docsUrl)}" target="_blank" rel="noopener">接口文档 ↗</a></li>
    </ul>`
  $('#pv-sheet-use').textContent = '填入语音设置'
  const sheet = $('#pv-sheet')
  if (typeof sheet.showModal === 'function') sheet.showModal()
  else sheet.setAttribute('open', '')
  $('#pv-sheet-close').focus({ preventScroll: true })
}

function useVoice(id) {
  location.href = `/?voice=${encodeURIComponent(id)}`
}

function openDetail(provider) {
  state.current = provider
  $('#pv-sheet-title').textContent = provider.name
  $('#pv-sheet-region').textContent = `${REGION_LABEL[provider.region] || provider.region} · ${KIND_LABEL[provider.kind] || provider.kind} · ${PROTOCOL_LABEL[provider.protocol] || provider.protocol}`
  const keyLink = $('#pv-sheet-key')
  keyLink.href = provider.keyUrl
  keyLink.textContent = provider.region === 'local' ? '下载 / 查看安装方式 ↗' : '去创建 API Key ↗'
  $('#pv-sheet-body').innerHTML = `
    <h3>三步接上</h3>
    <ol>${provider.setup.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    <h3>要填的地址</h3>
    <div class="pv-url"><code>${escapeHtml(provider.baseUrl)}</code><button class="pv-copy" type="button" data-copy="${escapeHtml(provider.baseUrl)}">复制</button></div>
    <h3>费用</h3>
    <p class="pv-card-summary">${escapeHtml(provider.freeTier)}</p>
    ${provider.cautions.length ? `<h3>注意</h3><ul>${provider.cautions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
    <h3>官方链接</h3>
    <ul>
      <li><a href="${escapeHtml(provider.docsUrl)}" target="_blank" rel="noopener">接口文档 ↗</a></li>
      <li><a href="${escapeHtml(provider.consoleUrl)}" target="_blank" rel="noopener">控制台 / 用量 ↗</a></li>
    </ul>`
  const sheet = $('#pv-sheet')
  if (typeof sheet.showModal === 'function') sheet.showModal()
  else sheet.setAttribute('open', '')
  $('#pv-sheet-close').focus({ preventScroll: true })
}

function closeDetail() {
  const sheet = $('#pv-sheet')
  if (typeof sheet.close === 'function') sheet.close()
  else sheet.removeAttribute('open')
  const previous = state.current
  state.current = null
  $('#pv-sheet-use').textContent = '用这个供应商'
  if (previous) document.querySelector(`[data-detail="${previous.id}"]`)?.focus({ preventScroll: true })
}

function useProvider(id) {
  // The app picks this up on load: opens 设置 → 模型 and prefills the form.
  location.href = `/?provider=${encodeURIComponent(id)}`
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text)
    const original = button.textContent
    button.textContent = '已复制'
    setTimeout(() => { button.textContent = original }, 1400)
  } catch {
    button.textContent = '复制失败'
  }
}

function bind() {
  // Scope by data attribute: the voice chips also carry .pv-chip, and binding
  // them to the model filter blanked the model grid when they were clicked.
  $$('[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      state.filter = chip.dataset.filter
      $$('[data-filter]').forEach(item => {
        const active = item === chip
        item.classList.toggle('active', active)
        item.setAttribute('aria-selected', String(active))
      })
      render()
    })
    chip.addEventListener('keydown', event => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
      event.preventDefault()
      const chips = $$('[data-filter]')
      const index = chips.indexOf(chip)
      const next = chips[(index + (event.key === 'ArrowRight' ? 1 : -1) + chips.length) % chips.length]
      next.focus()
      next.click()
    })
  })

  $('#pv-search').addEventListener('input', event => {
    state.query = event.target.value
    render()
  })

  $('#pv-grid').addEventListener('click', event => {
    const use = event.target.closest('[data-use]')
    if (use) { useProvider(use.dataset.use); return }
    const detail = event.target.closest('[data-detail]')
    if (detail) {
      const provider = state.providers.find(item => item.id === detail.dataset.detail)
      if (provider) openDetail(provider)
      return
    }
    const copy = event.target.closest('[data-copy]')
    if (copy) void copyText(copy.dataset.copy, copy)
  })

  $$('[data-voice-filter]').forEach(chip => {
    chip.addEventListener('keydown', event => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
      event.preventDefault()
      const chips = $$('[data-voice-filter]')
      const index = chips.indexOf(chip)
      const next = chips[(index + (event.key === 'ArrowRight' ? 1 : -1) + chips.length) % chips.length]
      next.focus()
      next.click()
    })
    chip.addEventListener('click', () => {
      state.voiceFilter = chip.dataset.voiceFilter
      $$('[data-voice-filter]').forEach(item => {
        const active = item === chip
        item.classList.toggle('active', active)
        item.setAttribute('aria-selected', String(active))
      })
      renderVoices()
    })
  })
  $('#pv-voice-search')?.addEventListener('input', event => {
    state.voiceQuery = event.target.value
    renderVoices()
  })
  $('#pv-voice-grid')?.addEventListener('click', event => {
    const use = event.target.closest('[data-voice-use]')
    if (use) { useVoice(use.dataset.voiceUse); return }
    const detail = event.target.closest('[data-voice-detail]')
    if (detail) {
      const entry = state.voices.find(item => item.id === detail.dataset.voiceDetail)
      if (entry) openVoiceDetail(entry)
    }
  })

  $('#pv-sheet-close').addEventListener('click', closeDetail)
  $('#pv-sheet').addEventListener('click', event => { if (event.target === $('#pv-sheet')) closeDetail() })
  $('#pv-sheet-use').addEventListener('click', () => {
    if (!state.current) return
    if (state.current.__voice) useVoice(state.current.id)
    else useProvider(state.current.id)
  })

  $('#pv-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('jarvis.theme', next) } catch { /* ignore */ }
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', next === 'light' ? '#f1f4f7' : '#0b0f14')
  })
}

async function boot() {
  bind()
  try {
    const response = await fetch('/api/providers/catalog', { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    state.providers = Array.isArray(data.providers) ? data.providers : []
    state.platform = data.platform || null
    render()
    try {
      const voiceResponse = await fetch('/api/voice/catalog', { headers: { accept: 'application/json' } })
      if (voiceResponse.ok) {
        const voiceData = await voiceResponse.json()
        state.voices = Array.isArray(voiceData.voices) ? voiceData.voices : []
      }
    } catch {
      state.voices = []
    }
    renderVoices()
    if (state.platform) {
      const note = $('#pv-count')
      const caps = state.platform
      if (!caps.screenCapture) {
        note.textContent += ` · 当前系统（${caps.label}）不支持屏幕捕获，其它功能正常`
      }
    }
  } catch (error) {
    $('#pv-count').textContent = `读取供应商列表失败：${error.message}。请确认 Jarvis 正在运行。`
  }
}

void boot()
