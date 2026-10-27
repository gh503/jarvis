// Curated service connections. Credentials live only in the active form.
(() => {
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node }
  const button = (text, action, cls = '') => { const node = el('button', `mcp-services-button ${cls}`, text); node.type = 'button'; node.addEventListener('click', action); return node }
  const categories = { life: '生活', office: '办公', developer: '开发', general: '通用' }
  const statuses = { unconfigured: '未配置', disabled: '已停用', connecting: '连接中', connected: '已连接', failed: '连接失败', 'needs-verification': '待验证' }
  const errors = { AUTH_REQUIRED: '凭据无效或权限不足', UNREACHABLE: '连接失败', TIMEOUT: '连接超时', RATE_LIMITED: '请求受到限流，请稍后再试', INVALID_SERVER: '服务协议不兼容' }
  let snapshot = null, epoch = 0, request = 0, busy = false, dirty = false, conflict = false, selected = null, form = null
  const dialog = el('dialog', 'mcp-services-dialog'); dialog.id = 'mcp-services-dialog'; dialog.setAttribute('aria-labelledby', 'mcp-services-title')
  const header = el('header', 'mcp-services-row'), title = el('h2', '', '服务连接'); title.id = 'mcp-services-title'
  const closeDialog = () => { ++epoch; ++request; clearEditor(); busy = false; conflict = false; snapshot = null; lock(); dialog.close() }
  header.append(title, button('关闭', closeDialog))
  const notice = el('div', 'mcp-services-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
  const filters = el('div', 'mcp-services-filters'), search = el('input'), category = el('select')
  search.type = 'search'; search.placeholder = '搜索服务'; search.setAttribute('aria-label', '搜索服务名称和说明'); category.setAttribute('aria-label', '服务分类')
  for (const [key, label] of Object.entries({ all: '全部分类', ...categories })) { const option = el('option', '', label); option.value = key; category.append(option) }
  filters.append(search, category, button('重新加载', () => reload()))
  const catalog = el('div', 'mcp-services-catalog'), editor = el('section', 'mcp-services-editor'); editor.hidden = true
  const advanced = button('高级：自定义 MCP', async () => {
    const ticket = epoch
    if (busy || (dirty && !await confirmAction('放弃未保存的凭据？', '进入高级设置会清空当前凭据草稿。', '放弃并继续')) || ticket !== epoch) return
    closeDialog(); window.dispatchEvent(new CustomEvent('jarvis:tools-open'))
  })
  dialog.append(header, el('p', 'mcp-services-muted', '连接你使用的服务。默认只读，工具结果默认仅供本地模型使用；写入操作需要逐次确认。'), notice, filters, catalog, editor, el('hr'), advanced)
  document.body.append(dialog)
  const say = text => { notice.replaceChildren(document.createTextNode(text)) }
  function safeLink(parent, label, value) {
    try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return
      const link = el('a', '', label); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; parent.append(link)
    } catch { /* Invalid or absent help links are not rendered. */ }
  }
  function help(parent, service) {
    const details = el('details', 'mcp-services-help'); details.open = !service.available; details.append(el('summary', '', '设置、用法与限制'))
    for (const [key, label] of [['setup', '准备与设置'], ['usage', '如何使用'], ['limitations', '限制与前置条件']]) {
      const items = service.help?.[key]; if (!Array.isArray(items) || !items.length) continue
      details.append(el('h4', '', label)); const list = el('ul'); items.forEach(text => list.append(el('li', '', text))); details.append(list)
    }
    const links = el('div', 'mcp-services-links'); safeLink(links, '官方凭据设置', service.help?.credentialsUrl); safeLink(links, '官方使用文档', service.help?.docsUrl); safeLink(links, '前往服务商撤销授权', service.help?.revokeUrl); details.append(links); parent.append(details)
  }
  async function api(path, method = 'GET', body) {
    const token = localStorage.getItem('jarvis_token') || ''
    const response = await fetch(`/api/mcp/services${path}`, { method, cache: 'no-store', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) { const error = new Error(response.status === 401 ? '请先配置有效的访问令牌。' : errors[data.errorCode || data.error?.code || data.code] || `请求失败（${response.status}），请检查服务设置后重试。`); error.status = response.status; throw error }
    return data
  }
  function clearEditor() {
    editor.querySelectorAll('input').forEach(input => { input.value = '' }); editor.replaceChildren(); editor.hidden = true; selected = null; form = null; dirty = false
  }
  function lock() {
    dialog.setAttribute('aria-busy', String(busy))
    // Re-rendered action controls carry their own policy-disabled state.
    dialog.querySelectorAll('button,input,select').forEach(node => {
      if (node.dataset.locked === 'true') { node.disabled = false; delete node.dataset.locked }
      if (busy && !node.disabled) { node.dataset.locked = 'true'; node.disabled = true }
    })
  }
  function verified(connection) { return !!connection.verifiedAt && ['connected', 'disabled'].includes(connection.status) }
  function render() {
    catalog.replaceChildren()
    const query = search.value.trim().toLocaleLowerCase()
    const services = (snapshot?.services || []).filter(service => (category.value === 'all' || service.category === category.value) && `${service.name} ${service.description}`.toLocaleLowerCase().includes(query))
    if (!services.length) catalog.append(el('p', 'mcp-services-muted', snapshot ? '没有符合条件的服务。' : '服务目录尚未载入。'))
    for (const service of services) {
      const connection = service.connection || {}, card = el('article', 'mcp-services-card'), actions = el('div', 'mcp-services-actions')
      card.append(el('span', 'mcp-services-category', categories[service.category] || '通用'), el('h3', '', service.name), el('p', '', service.description), el('p', 'mcp-services-status', service.available ? statuses[connection.status] || '状态未知' : '暂不可用 · 请先满足前置条件'))
      card.append(el('p', 'mcp-services-muted', `${service.readOnly || connection.mode !== 'write' ? '只读' : '允许写入 · 每次确认'} · ${Number.isInteger(connection.toolCount) ? connection.toolCount : 0} 个工具${connection.verifiedAt ? ` · 验证于 ${new Date(connection.verifiedAt).toLocaleString()}` : ''}`))
      if (connection.errorCode) card.append(el('p', 'mcp-services-error', errors[connection.errorCode] || '验证失败，请检查设置及服务商说明。'))
      help(card, service)
      if (service.available) {
        const configure = button(connection.status === 'unconfigured' ? '连接服务' : '管理连接', () => openEditor(service))
        const verify = button('验证连接', () => mutate(service, '/verify', 'POST', {}, '验证已完成。请查看连接状态；验证不会自动启用服务。'))
        verify.disabled = connection.status === 'unconfigured' || connection.status === 'connecting' || dirty || conflict
        const toggle = button(connection.enabled ? '停用' : '启用', () => mutate(service, '/toggle', 'POST', { enabled: !connection.enabled }, connection.enabled ? '服务已停用。' : '服务已启用。'))
        toggle.disabled = (!connection.enabled && !verified(connection)) || dirty || conflict
        actions.append(configure, verify, toggle)
        if (!connection.enabled && !verified(connection)) card.append(el('p', 'mcp-services-muted', '保存后先验证连接，再手动启用。验证仅初始化连接并发现工具，不会执行服务操作。'))
      }
      card.append(actions); catalog.append(card)
    }
    lock()
  }
  async function refresh(message = '') {
    const ticket = epoch, serial = ++request
    try {
      const data = await api('')
      if (!dialog.open || ticket !== epoch || serial !== request) return
      if (!Array.isArray(data.services) || data.revision == null) throw new Error('服务目录格式不正确，请重新加载。')
      snapshot = data; render(); say(message || '选择服务，按照官方说明准备凭据。')
    } catch (error) { if (dialog.open && ticket === epoch && serial === request) say(error.message) }
  }
  function confirmAction(heading, text, accept) {
    return new Promise(resolve => {
      const modal = el('dialog', 'mcp-services-confirm'); modal.id = 'mcp-services-confirm'; modal.setAttribute('aria-label', heading)
      const finish = result => { modal.close(); modal.remove(); resolve(result) }, cancel = button('取消', () => finish(false)), actions = el('div', 'mcp-services-actions')
      actions.append(cancel, button(accept, () => finish(true), 'mcp-services-danger')); modal.append(el('h2', '', heading), el('p', '', text), actions); document.body.append(modal)
      modal.addEventListener('cancel', event => { event.preventDefault(); finish(false) }); modal.showModal(); cancel.focus()
    })
  }
  async function reload() {
    const ticket = epoch
    if (busy || (dirty && !await confirmAction('丢弃草稿并重新加载？', '未保存的凭据将被清空。不会自动重试之前的请求。', '丢弃并重新加载')) || ticket !== epoch) return
    clearEditor(); conflict = false; snapshot = null; render(); say('正在载入服务目录…'); await refresh()
  }
  async function openEditor(service) {
    const ticket = epoch
    if (busy || (dirty && !await confirmAction('放弃当前草稿？', '未保存的凭据将被清空。', '放弃草稿')) || ticket !== epoch) return
    clearEditor(); selected = service.id; editor.hidden = false; form = el('form'); const activeForm = form, connection = service.connection || {}, inputs = new Map()
    form.append(el('h3', '', `管理 ${service.name}`), el('p', 'mcp-services-muted', '已保存的凭据不会回显。留空保留原值；只提交本次新填写的字段。保存配置会停用连接，需要重新验证后手动启用。'))
    for (const field of service.fields || []) {
      const saved = connection.configuredFields?.includes(field.key), label = el('label', 'mcp-services-field'), input = el('input')
      input.type = field.secret ? 'password' : 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.required = !!field.required && !saved; input.placeholder = saved ? '已保存，留空保留' : field.placeholder || ''; input.dataset.field = field.key
      label.append(el('span', '', `${field.label}${field.required ? '（必填）' : ''}${saved ? ' · 已保存' : ''}`), input)
      if (field.help) label.append(el('small', '', field.help)); form.append(label); inputs.set(field.key, input)
    }
    const modeLabel = el('label', 'mcp-services-field'), mode = el('select'); modeLabel.append(el('span', '', '工具权限'), mode)
    for (const [value, text] of [['read', '只读（默认）'], ...(!service.readOnly ? [['write', '允许写入（每次操作需要确认）']] : [])]) { const option = el('option', '', text); option.value = value; mode.append(option) }
    mode.value = 'read'; form.append(modeLabel, el('p', 'mcp-services-muted', service.readOnly ? '此服务仅支持只读。结果默认仅供本地模型使用。' : '只读模式不允许写入。开启写入后，每次有副作用的调用仍需确认；结果默认仅供本地模型使用。'))
    const actions = el('div', 'mcp-services-actions'), save = el('button', 'mcp-services-button mcp-services-primary', '保存配置'); save.type = 'submit'; save.disabled = conflict
    actions.append(save, button('取消编辑', async () => { const current = epoch; if (!busy && (!dirty || await confirmAction('放弃草稿？', '未保存的凭据将被清空。', '放弃草稿')) && current === epoch) { clearEditor(); render() } }))
    if (connection.status !== 'unconfigured') actions.append(button('断开并清除本地凭据', async () => {
      const current = epoch
      if (busy || conflict || !await confirmAction('断开服务连接？', '将停用连接并删除本地保存的凭据。服务商授权不会被撤销，请另外使用官方撤销授权链接。', '断开并清除') || current !== epoch) return
      await mutate(service, '', 'DELETE', {}, '已断开并清除本地凭据。如需撤销服务商授权，请使用官方链接。')
    }, 'mcp-services-danger'))
    form.append(actions); editor.append(form)
    form.addEventListener('input', () => { dirty = true; ++request; render() }); form.addEventListener('change', () => { dirty = true; ++request; render() })
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || conflict || !activeForm.reportValidity()) return
      const credentials = Object.create(null)
      for (const [key, input] of inputs) {
        if (input.required && !input.value.trim()) { input.setCustomValidity('请填写此必填字段。'); input.reportValidity(); input.addEventListener('input', () => input.setCustomValidity(''), { once: true }); return }
        if (input.value.trim()) credentials[key] = input.value
      }
      const current = epoch
      if (mode.value === 'write' && !await confirmAction('允许服务写入？', '服务可能修改或发送资料。每次写入操作仍需要你的明确确认。', '允许写入')) return
      if (current !== epoch || activeForm !== form) return
      await mutate(service, '/configure', 'POST', { credentials, mode: mode.value }, '配置已保存并停用。请验证连接，然后手动启用。')
    })
    editor.scrollIntoView({ block: 'nearest' }); form.querySelector('input,select')?.focus()
  }
  async function mutate(service, suffix, method, body, message) {
    if (busy || conflict || !snapshot) return
    busy = true; const ticket = epoch; ++request; lock(); say('正在处理…')
    try {
      await api(`/${encodeURIComponent(service.id)}${suffix}`, method, { expectedRevision: snapshot.revision, ...body })
      if (ticket !== epoch || !dialog.open) return
      clearEditor(); await refresh(message)
    } catch (error) {
      if (ticket !== epoch || !dialog.open) return
      if (error.status === 409) { conflict = true; say('配置已在别处更改。凭据草稿已保留，不会自动重试。请明确重新加载并确认丢弃草稿后继续。'); notice.append(button('重新加载最新配置', () => reload())) }
      else say(error.message)
    } finally { if (ticket === epoch) { busy = false; lock(); render(); if (conflict && form) form.querySelector('[type="submit"]').disabled = true } }
  }
  search.addEventListener('input', render); category.addEventListener('change', render)
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog() })
  dialog.addEventListener('close', () => { if (dialog.open) return; ++epoch; ++request; clearEditor(); busy = false; conflict = false; snapshot = null; lock(); catalog.replaceChildren(); say('') })
  window.addEventListener('jarvis:mcp-services-open', () => { if (dialog.open) return; ++epoch; dialog.showModal(); say('正在载入服务目录…'); void refresh() })
  window.addEventListener('jarvis:ws-event', event => {
    if (event.detail?.type !== 'mcp.changed' || !dialog.open || busy) return
    if (dirty || conflict) { ++request; say('服务状态已更新；当前草稿保留。保存时会检查版本，也可重新加载。'); return }
    // A clean editor still captures an older service definition; close before refreshing.
    clearEditor(); void refresh()
  })
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = '' } })
})()
