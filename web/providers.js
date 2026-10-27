/* 模型服务指南：从 /api/providers/catalog 读取公开目录并渲染。 */

const $ = selector => document.querySelector(selector)
const $$ = selector => [...document.querySelectorAll(selector)]

const state = {
  providers: [],
  filter: 'all',
  query: '',
  platform: null,
  current: null,
}

const REGION_LABEL = { cn: '国内直连', global: '国际', local: '本机模型' }
const KIND_LABEL = { ollama: 'Ollama 原生', openai: 'OpenAI 兼容' }
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
  $$('.pv-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      state.filter = chip.dataset.filter
      $$('.pv-chip').forEach(item => {
        const active = item === chip
        item.classList.toggle('active', active)
        item.setAttribute('aria-selected', String(active))
      })
      render()
    })
    chip.addEventListener('keydown', event => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
      event.preventDefault()
      const chips = $$('.pv-chip')
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

  $('#pv-sheet-close').addEventListener('click', closeDetail)
  $('#pv-sheet').addEventListener('click', event => { if (event.target === $('#pv-sheet')) closeDetail() })
  $('#pv-sheet-use').addEventListener('click', () => { if (state.current) useProvider(state.current.id) })

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
