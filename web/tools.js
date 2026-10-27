// Standalone tools surface. Server/model strings are always rendered as text.
(() => {
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node }
  const button = (text, action, cls = '') => { const node = el('button', `tools-button ${cls}`, text); node.type = 'button'; node.addEventListener('click', action); return node }
  const pretty = value => typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)
  const permissions = { ask: '每次询问', allow: '允许', deny: '禁止' }
  const usages = { local: '仅本地模型', shared: '允许远端模型使用' }
  const effects = { read: '读取', write: '写入 / 有副作用' }
  const destinations = { remote: '可能出网，禁止本地受限资料', local: '可信本地处理（自行确保不出网）' }
  const statuses = { pending: '等待处理', awaiting_approval: '等待批准', approved: '已批准', denied: '已拒绝', started: '执行中', running: '执行中', succeeded: '成功', success: '成功', completed: '已完成', error: '失败', failed: '失败', cancelled: '已取消', canceled: '已取消', expired: '已过期', unknown: '结果未知' }
  let tools = { definitions: [], approvals: [] }, mcp = { revision: null, servers: [] }
  let scope = {}, epoch = 0, historyEpoch = 0, busy = false, dirty = false, editor = null, approvalVersion = 0
  const approvals = new Map(), retired = new Set(), inflight = new Set(), endedTurns = new Set(), endedCalls = new Set()
  const turnKey = item => JSON.stringify([item.sessionId, item.turnId])
  const callKey = item => JSON.stringify([item.sessionId, item.turnId, item.callId])
  const ended = item => endedTurns.has(turnKey(item)) || endedCalls.has(callKey(item))
  const dialog = el('dialog', 'tools-dialog'); dialog.id = 'tools-dialog'; dialog.setAttribute('aria-labelledby', 'tools-title')
  const header = el('header', 'tools-header'), title = el('h2', '', '工具与 MCP'); title.id = 'tools-title'
  header.append(title, button('服务连接', () => { dialog.close(); window.dispatchEvent(new CustomEvent('jarvis:mcp-services-open')) }), button('关闭', () => dialog.close()))
  const notice = el('p', 'tools-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
  const body = el('div', 'tools-body'), pending = el('section', 'tools-section'), history = el('section', 'tools-section'), catalog = el('section', 'tools-section'), servers = el('section', 'tools-section'), editPane = el('section', 'tools-editor'); editPane.hidden = true
  body.append(pending, history, catalog, servers, editPane); dialog.append(header, notice, body)
  const approvalDialog = el('dialog', 'tools-approval-dialog'); approvalDialog.setAttribute('aria-labelledby', 'tools-approval-title')
  const approvalHeading = el('h2', '', '工具需要你的批准'); approvalHeading.id = 'tools-approval-title'
  const approvalBody = el('div'), approvalNotice = el('p', 'tools-notice'); approvalNotice.setAttribute('role', 'status')
  approvalDialog.append(approvalHeading, approvalNotice, approvalBody, button('稍后处理', () => approvalDialog.close()))
  document.body.append(dialog, approvalDialog)
  const say = text => { notice.textContent = text }
  async function api(path, method = 'GET', data) {
    const token = localStorage.getItem('jarvis_token') || ''
    const response = await fetch(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) { const error = new Error(response.status === 401 ? '请先配置有效的访问令牌。' : (typeof result.error === 'string' ? result.error : result.error?.message) || `请求失败（${response.status}）`); error.status = response.status; throw error }
    return result
  }
  function heading(section, text, action) { section.replaceChildren(); const row = el('div', 'tools-row'); row.append(el('h3', '', text)); if (action) row.append(action); section.append(row) }
  function details(label, value) { const node = el('details', 'tools-details'); node.append(el('summary', '', label), el('pre', 'tools-code', pretty(value))); return node }
  function identity(item) { return `会话 ${item.sessionId || '未提供'} · 轮次 ${item.turnId || '未提供'}` }
  function expired(item) { const until = typeof item.expiresAt === 'number' ? item.expiresAt : Date.parse(item.expiresAt); return !Number.isFinite(until) || until <= Date.now() }
  function approvalCard(item) {
    const card = el('article', 'tools-card'); card.append(el('h4', '', item.name || '工具调用'), el('p', 'tools-meta', identity(item)), details('查看调用参数', item.args))
    const stale = retired.has(item.id) || expired(item), actions = el('div', 'tools-actions')
    card.append(el('p', 'tools-help', stale ? '请求已结束或过期，不能再批准。' : `仅批准本次调用。有效期至 ${new Date(item.expiresAt).toLocaleString()}`))
    for (const [label, approved] of [['拒绝', false], ['批准本次', true]]) { const b = button(label, () => decide(item, approved), approved ? 'tools-primary' : ''); b.disabled = stale || inflight.has(item.id) || !item.sessionId || !item.turnId; actions.append(b) }
    card.append(actions); return card
  }
  function renderApprovals() {
    heading(pending, '待批准的调用'); approvalBody.replaceChildren()
    const items = [...approvals.values()]
    if (!items.length) pending.append(el('p', 'tools-help', '当前没有待批准的调用。'))
    items.forEach(item => { pending.append(approvalCard(item)); approvalBody.append(approvalCard(item)) })
    if (!items.some(item => !retired.has(item.id) && !expired(item)) && approvalDialog.open) approvalDialog.close()
  }
  async function decide(item, approved) {
    if (inflight.has(item.id) || retired.has(item.id) || expired(item)) { renderApprovals(); return }
    inflight.add(item.id); renderApprovals(); approvalNotice.textContent = '正在提交决定…'
    try {
      await api(`/api/tools/approvals/${encodeURIComponent(item.id)}`, 'POST', { approved, sessionId: item.sessionId, turnId: item.turnId })
      retired.add(item.id); approvals.delete(item.id); ++approvalVersion; approvalNotice.textContent = approved ? '已批准本次调用。' : '已拒绝本次调用。'; say(approvalNotice.textContent)
    } catch (error) {
      if ([404, 409, 410].includes(error.status)) { retired.add(item.id); ++approvalVersion }
      approvalNotice.textContent = error.message; say(error.message)
    } finally { inflight.delete(item.id); renderApprovals(); if (dialog.open) void loadHistory() }
  }
  function renderCatalog() {
    heading(catalog, '可用工具')
    if (!tools.definitions.length) catalog.append(el('p', 'tools-help', '暂时没有可用工具。'))
    tools.definitions.forEach(item => {
      const card = el('article', 'tools-card'); card.append(el('h4', '', item.name), el('p', '', item.description || '暂无说明'), el('p', 'tools-meta', [permissions[item.permission] || item.permission, usages[item.usage] || item.usage, effects[item.effect] || item.effect, destinations[item.destination] || item.destination].filter(Boolean).join(' · '))); catalog.append(card)
    })
  }
  async function refresh() {
    const ticket = ++epoch, version = approvalVersion
    say('正在读取工具和连接…')
    const results = await Promise.allSettled([api('/api/tools'), api('/api/mcp')])
    if (ticket !== epoch) return
    const errors = []
    if (results[0].status === 'fulfilled') {
      tools = { definitions: [], approvals: [], ...results[0].value }
      if (version === approvalVersion) { approvals.clear(); tools.approvals.forEach(item => { if (item.id && !retired.has(item.id) && !ended(item)) approvals.set(item.id, item) }) }
      renderCatalog(); renderApprovals()
    } else errors.push(results[0].reason.message)
    if (results[1].status === 'fulfilled') { mcp = results[1].value; renderServers() } else errors.push(results[1].reason.message)
    say(errors.length ? errors.join('；') : editor ? '编辑草稿已保留。保存时会检查配置版本。' : '新增连接默认停用。请检查资料去向和每个工具的权限。')
  }
  async function loadHistory() {
    const ticket = ++historyEpoch, selected = { ...scope }
    heading(history, '调用记录', button('刷新记录', loadHistory))
    if (!selected.sessionId) { history.append(el('p', 'tools-help', '从回答的工具按钮打开，可查看对应会话或轮次的调用记录。')); return }
    history.append(el('p', 'tools-help', `${identity(selected)} · 正在读取…`))
    try {
      const query = new URLSearchParams({ sessionId: selected.sessionId }); if (selected.turnId) query.set('turnId', selected.turnId)
      const data = await api(`/api/tools/calls?${query}`)
      if (ticket !== historyEpoch) return
      heading(history, '调用记录', button('刷新记录', loadHistory)); history.append(el('p', 'tools-meta', identity(selected)))
      if (!data.items?.length) history.append(el('p', 'tools-help', '没有调用记录。'))
      for (const item of data.items || []) {
        const card = el('article', 'tools-card'), known = Object.hasOwn(statuses, item.status)
        card.append(el('h4', '', `${item.name} · ${statuses[item.status] || `未知状态：${item.status || '未提供'}`}`), el('p', 'tools-meta', `调用 ${item.callId} · ${item.updatedAt || item.createdAt || ''}${item.localOnly ? ' · 仅本地资料' : ''}`), details('调用参数', item.args), details('执行结果', item.content))
        if (item.status === 'unknown' || !known) card.append(el('p', 'tools-warning', '无法确认执行结果；可能已经产生副作用。不会自动重试或重放。'))
        history.append(card)
      }
    } catch (error) { if (ticket === historyEpoch) { heading(history, '调用记录', button('重试', loadHistory)); history.append(el('p', 'tools-warning', error.message)) } }
  }
  function renderServers() {
    heading(servers, '高级：自定义 MCP', button('添加自定义连接', () => openEditor()))
    if (!mcp.servers?.length) servers.append(el('p', 'tools-help', '尚未添加 MCP 连接。'))
    for (const server of mcp.servers || []) {
      const card = el('article', 'tools-card'), actions = el('div', 'tools-actions')
      card.append(el('h4', '', server.id), el('p', 'tools-meta', `${server.enabled ? '已启用' : '已停用'} · ${server.transport} · ${pretty(server.status || '连接状态未知')}`), el('p', 'tools-help', destinations[server.destination] || '资料去向未设置'))
      if (server.error) card.append(el('p', 'tools-warning', pretty(server.error)))
      if (server.preset || String(server.id || '').startsWith('preset-')) {
        card.append(el('p', 'tools-help', '由服务连接管理'))
        actions.append(button('服务连接', () => { dialog.close(); window.dispatchEvent(new CustomEvent('jarvis:mcp-services-open')) }))
      } else actions.append(button('编辑', () => openEditor(server)), button('重新连接', () => reconnect(server.id)))
      card.append(actions); servers.append(card)
    }
  }
  async function reconnect(id) {
    if (busy) return
    busy = true
    try { await api(`/api/mcp/servers/${encodeURIComponent(id)}/reconnect`, 'POST'); await refresh() } catch (error) { say(error.message) } finally { busy = false }
  }
  function field(parent, label, value = '', options, textarea = false) {
    const wrap = el('label', 'tools-field'); wrap.append(el('span', '', label))
    const input = el(options ? 'select' : textarea ? 'textarea' : 'input')
    if (options) { Object.entries(options).forEach(([key, text]) => { const option = el('option', '', text); option.value = key; input.append(option) }); if (value && !Object.hasOwn(options, value)) { const option = el('option', '', `当前值：${value}`); option.value = value; input.append(option) } }
    input.value = value ?? ''; if (textarea) input.rows = 3; wrap.append(input); parent.append(wrap); return input
  }
  function check(parent, label, checked = false) { const wrap = el('label', 'tools-check'), input = el('input'); input.type = 'checkbox'; input.checked = checked; wrap.append(input, document.createTextNode(label)); parent.append(wrap); return input }
  function confirmAction(title, text, accept) {
    return new Promise(resolve => {
      const modal = el('dialog', 'tools-confirm'); modal.setAttribute('aria-label', title); modal.append(el('h2', '', title), el('p', '', text)); const actions = el('div', 'tools-actions')
      const done = value => { modal.close(); modal.remove(); resolve(value) }, cancel = button('取消', () => done(false))
      actions.append(cancel, button(accept, () => done(true), 'tools-danger')); modal.append(actions); document.body.append(modal); modal.addEventListener('cancel', event => { event.preventDefault(); done(false) }); modal.showModal(); cancel.focus()
    })
  }
  function hideEditor() { editor = null; dirty = false; editPane.replaceChildren(); editPane.hidden = true }
  async function openEditor(server) {
    if (busy || (dirty && !await confirmAction('放弃当前草稿？', '尚未保存的修改将被丢弃。', '放弃草稿'))) return
    const source = server || { id: '', enabled: false, transport: 'stdio', destination: 'remote', tools: {} }, revision = mcp.revision
    editor = el('form', 'tools-form'); const form = editor; dirty = false; editPane.hidden = false; editPane.replaceChildren(form)
    form.append(el('h3', '', server ? `编辑 ${server.id}` : '添加 MCP 连接'), el('p', 'tools-help', '关闭面板会保留草稿；刷新页面会丢失草稿。配置命令会在服务端执行，请仅连接可信服务。'))
    const id = field(form, '连接 ID', source.id); id.required = true; id.readOnly = !!server
    const enabled = check(form, '启用此连接', source.enabled)
    const transport = field(form, '连接方式', source.transport, { stdio: '本地命令（stdio）', 'streamable-http': 'HTTP（Streamable HTTP）' })
    if (server) form.append(el('p', 'tools-help', '连接细节不回显。命令、参数、目录和地址留空会保留原值；填写后替换。'))
    const command = field(form, '命令', ''), args = field(form, '命令参数（每行一个，不需要引号）', '', null, true), cwd = field(form, '工作目录（可选，绝对路径）', ''), url = field(form, '服务地址', '')
    command.placeholder = source.command ? '已配置，留空保留' : '例如 /usr/bin/node'; args.placeholder = source.argsCount ? `已保存 ${source.argsCount} 个参数，留空保留` : ''; cwd.placeholder = source.hasCwd ? '已配置，留空保留' : ''; url.placeholder = source.url ? `已配置 ${source.url}，留空保留完整地址` : 'https://example.com/mcp'
    const clearArgs = check(form, '清空已保存的命令参数'); clearArgs.addEventListener('change', () => { args.disabled = clearArgs.checked })
    const updateTransport = () => { const local = transport.value === 'stdio', same = server && source.transport === transport.value; command.parentElement.hidden = args.parentElement.hidden = cwd.parentElement.hidden = clearArgs.parentElement.hidden = !local; url.parentElement.hidden = local; command.required = local && !same; url.required = !local && !same }; transport.addEventListener('change', updateTransport); updateTransport()
    const destination = field(form, '资料去向', source.destination || 'remote', destinations)
    form.append(el('p', 'tools-warning', '“可信本地处理”是你对服务行为的确认；本机命令和 localhost 地址也可能出网。'))
    const secrets = {}
    for (const [key, label, keys] of [['env', '环境变量', source.envKeys], ['headers', 'HTTP 请求头', source.headerKeys]]) {
      form.append(el('p', 'tools-help', `${label}：${keys?.length ? `已保存键名 ${keys.join('、')}` : source[key === 'env' ? 'hasEnv' : 'hasHeaders'] ? '已保存（不回显）' : '尚未保存'}。留空保留已有值；填写 JSON 对象会整体替换。`))
      const value = field(form, `${label} JSON（敏感值，仅用于保存）`, '', null, true); value.autocomplete = 'off'; value.spellcheck = false
      const clear = check(form, `明确清空全部${label}`); clear.addEventListener('change', () => { value.disabled = clear.checked }); secrets[key] = { value, clear }
    }
    const policy = el('fieldset', 'tools-policy'); policy.append(el('legend', '', '逐项工具策略')); form.append(policy)
    const discovered = Array.isArray(source.discoveredTools) ? source.discoveredTools : []
    const names = new Set([...Object.keys(source.tools || {}), ...discovered.map(tool => typeof tool === 'string' ? tool : tool.rawName || tool.name).filter(Boolean)]), controls = new Map()
    if (!names.size) policy.append(el('p', 'tools-help', '尚未发现工具。保存并启用连接后，重新打开编辑器设置逐项策略。默认：仅本地模型、每次询问、有写入副作用。'))
    for (const name of names) {
      const existing = source.tools?.[name] || {}, group = el('div', 'tools-card'); group.append(el('h4', '', name)); const discoveredTool = discovered.find(tool => (tool.rawName || tool.name) === name); if (discoveredTool?.description) group.append(el('p', 'tools-help', discoveredTool.description))
      const on = check(group, '启用工具', existing.enabled !== false), permission = field(group, '调用权限', existing.permission || 'ask', permissions), usage = field(group, '使用范围', existing.usage || 'local', usages), effect = field(group, '副作用', existing.effect || 'write', effects)
      controls.set(name, { on, permission, usage, effect }); policy.append(group)
    }
    form.addEventListener('input', () => { dirty = true }); form.addEventListener('change', () => { dirty = true })
    const actions = el('div', 'tools-actions'), save = el('button', 'tools-button tools-primary', '保存'); save.type = 'submit'; actions.append(save, button('取消编辑', async () => { if (!busy && (!dirty || await confirmAction('放弃草稿？', '尚未保存的修改将被丢弃。', '放弃草稿'))) hideEditor() }))
    if (server) actions.append(button('删除连接', async () => { if (busy || !await confirmAction('删除 MCP 连接？', `将删除连接 ${server.id} 和保存的凭据。`, '删除连接')) return; await saveMutation(`/api/mcp/servers/${encodeURIComponent(server.id)}`, 'DELETE', { expectedRevision: revision }, form) }, 'tools-danger'))
    form.append(actions)
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !form.reportValidity()) return
      try {
        const config = { id: id.value.trim(), enabled: enabled.checked, transport: transport.value, destination: destination.value, tools: Object.create(null), expectedRevision: revision }
        if (transport.value === 'stdio') {
          if (command.value.trim()) config.command = command.value.trim()
          if (clearArgs.checked) config.args = []
          else if (args.value) config.args = args.value.replace(/\r/g, '').split('\n')
          if (cwd.value.trim()) config.cwd = cwd.value.trim()
        } else if (url.value.trim()) config.url = url.value.trim()
        for (const [name, c] of controls) config.tools[name] = { enabled: c.on.checked, permission: c.permission.value, usage: c.usage.value, effect: c.effect.value }
        for (const [key, secret] of Object.entries(secrets)) {
          if (secret.clear.checked) config[key] = {}
          else if (secret.value.value.trim()) { let value; try { value = JSON.parse(secret.value.value) } catch { throw new Error(`${key === 'env' ? '环境变量' : '请求头'}必须是有效的 JSON 对象。`) }; if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(v => typeof v !== 'string')) throw new Error('环境变量和请求头必须是键和值均为字符串的 JSON 对象。'); config[key] = value }
        }
        await saveMutation('/api/mcp/servers', 'POST', config, form)
      } catch (error) { say(error.message) }
    })
    id.focus(); editPane.scrollIntoView({ block: 'start', behavior: 'instant' })
  }
  async function saveMutation(path, method, data, form) {
    busy = true; ++epoch
    const controls = [...form.querySelectorAll('button,input,select,textarea')].map(node => [node, node.disabled]); controls.forEach(([node]) => { node.disabled = true }); form.setAttribute('aria-busy', 'true')
    try { await api(path, method, data); hideEditor(); await refresh() }
    catch (error) {
      say(error.status === 409 ? '配置已在别处更改，草稿仍完整保留。请复制需要的草稿内容，再载入最新版本重新编辑。' : error.message)
      if (error.status === 409) notice.append(button('放弃草稿并载入最新', async () => { if (await confirmAction('载入最新配置？', '这会丢弃当前草稿，包括尚未保存的凭据。', '放弃草稿并载入')) { hideEditor(); await refresh() } }))
    } finally { busy = false; form.removeAttribute('aria-busy'); controls.forEach(([node, disabled]) => { node.disabled = disabled }) }
  }
  function open(detail = {}) {
    scope = { sessionId: detail.sessionId, turnId: detail.turnId }
    if (approvalDialog.open) approvalDialog.close()
    if (!dialog.open) dialog.showModal()
    void refresh(); void loadHistory()
  }
  window.addEventListener('jarvis:tools-open', event => open(event.detail || {}))
  document.addEventListener('click', event => { if (event.target instanceof Element && event.target.closest('#tools-open')) open() })
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = '' } })
  window.addEventListener('jarvis:ws-event', event => {
    const envelope = event.detail || {}, data = { ...envelope.data, sessionId: envelope.data?.sessionId || envelope.sessionId, turnId: envelope.data?.turnId || envelope.turnId }
    if (envelope.type === 'tool.approval') {
      const item = { ...data, ...(data.approval || {}), id: data.approval?.id || data.id || data.approvalId }
      if (!item.id || retired.has(item.id) || ended(item)) return
      approvals.set(item.id, item); ++approvalVersion; renderApprovals(); approvalNotice.textContent = '请核对会话、工具和参数后决定。关闭弹窗不会批准调用。'
      if (!dialog.open && !approvalDialog.open && !expired(item)) approvalDialog.showModal()
    }
    if (['tool.started', 'tool.result', 'turn.end', 'assistant.cancelled', 'assistant.done'].includes(envelope.type)) {
      ++approvalVersion
      if (data.sessionId && data.turnId) {
        if (envelope.type.startsWith('tool.')) { if (data.callId) endedCalls.add(callKey(data)) }
        else endedTurns.add(turnKey(data))
      }
      for (const [id, item] of approvals) { if (item.sessionId === data.sessionId && item.turnId === data.turnId && (!data.callId || item.callId === data.callId)) { retired.add(id); approvals.delete(id); ++approvalVersion } }
      renderApprovals(); if (dialog.open && scope.sessionId === data.sessionId && (!scope.turnId || scope.turnId === data.turnId)) void loadHistory()
    }
    if (envelope.type === 'mcp.changed' && dialog.open) void refresh()
  })
  // Keep expiration controls accurate without issuing network requests or replaying calls.
  setInterval(() => { if (approvals.size && (dialog.open || approvalDialog.open)) { const focus = document.activeElement; for (const item of approvals.values()) if (expired(item) && !retired.has(item.id)) { retired.add(item.id); renderApprovals(); if (focus?.tagName === 'BUTTON') (approvalDialog.open ? approvalDialog : dialog).querySelector('button')?.focus(); break } } }, 1000)
})()
