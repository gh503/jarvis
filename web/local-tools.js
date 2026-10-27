// Local task settings and questions are deliberately separate from MCP approvals.
(() => {
  const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n }
  const button = (text, fn) => { const n = node('button', text, 'lt-button'); n.type = 'button'; n.addEventListener('click', fn); return n }
  const text = value => typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)
  const turnKey = q => JSON.stringify([q.sessionId, q.turnId])
  const pending = new Map(), retired = new Set(), ended = new Set(), submitting = new Set()
  let settings, capabilities = {}, dirty = false, saving = false, conflict = false, sessionId = '', loadEpoch = 0, sessionEpoch = 0, activeQuestion = null, expiryTimer
  function dialog(id, title) {
    const d = node('dialog', undefined, 'lt-dialog'); d.id = id; d.setAttribute('aria-labelledby', `${id}-title`)
    const head = node('header', undefined, 'lt-header'), h = node('h2', title); h.id = `${id}-title`
    head.append(h, button('关闭', () => d.close())); d.append(head); document.body.append(d); return d
  }
  const panel = dialog('local-tools-dialog', '本地工具'), body = node('div', undefined, 'lt-body')
  const notice = node('p', '', 'lt-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
  const editor = node('div'), questions = node('section'), activity = node('section')
  body.append(notice, editor, questions, activity); panel.append(body)
  const questionDialog = dialog('local-tools-question', '需要你补充信息'), questionBody = node('div', undefined, 'lt-body'); questionDialog.append(questionBody)
  questionDialog.addEventListener('close', () => { if (!questionDialog.open) activeQuestion = null })
  async function api(path, method = 'GET', data, raw = false) {
    const token = localStorage.getItem('jarvis_token') || ''
    const response = await fetch(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
    if (raw && response.ok) return response
    const result = await response.json().catch(() => ({}))
    if (!response.ok) { const error = new Error(response.status === 401 ? '请先配置有效的访问令牌。' : text(result.error?.message || result.error || `请求失败（${response.status}）`)); error.status = response.status; throw error }
    return result
  }
  function field(parent, label, value, multiline = false) {
    const wrap = node('label', undefined, 'lt-field'), input = node(multiline ? 'textarea' : 'input')
    wrap.append(node('span', label), input); input.value = value ?? ''; input.autocomplete = 'off'; input.spellcheck = false; if (multiline) input.rows = 3
    parent.append(wrap); return input
  }
  function check(parent, label, checked) {
    const wrap = node('label', undefined, 'lt-check'), input = node('input'); input.type = 'checkbox'; input.checked = !!checked
    wrap.append(input, node('span', label)); parent.append(wrap); return input
  }
  function renderSettings() {
    editor.replaceChildren()
    if (!settings) { editor.append(button('重试读取设置', () => load(true))); return }
    const form = node('form'), controls = node('fieldset', undefined, 'lt-controls'); form.append(controls)
    controls.append(node('legend', '目录授权与能力'), node('p', '只授权你明确填写的目录，不会默认开放主目录。每行一个绝对路径；留空表示不授予该类目录权限。', 'lt-help'))
    const reads = field(controls, '只读目录', (settings.readRoots || []).join('\n'), true)
    const writes = field(controls, '可写目录（也可读取）', (settings.writeRoots || []).join('\n'), true)
    const output = field(controls, '输出目录（Jarvis 工作区，路径只读）', settings.outputDir); output.readOnly = true
    controls.append(node('p', '此目录由 Jarvis 管理，用于生成文件和 Shell 输出。“擦除全部本机数据”会删除其中所有文件，包括后来修改的文件；外部授权目录中的用户文件不受影响。', 'lt-warning'))
    const web = check(controls, '启用网页搜索与访问', settings.webEnabled)
    controls.append(node('p', '开启后，搜索查询和访问的 URL 会发送到外部服务。', 'lt-warning'))
    const advanced = node('details'); advanced.append(node('summary', '高级：Shell 与技能目录')); controls.append(advanced)
    const shell = check(advanced, '启用 Shell 沙箱执行', settings.shellEnabled); shell.disabled = !capabilities.shellAvailable
    advanced.append(node('p', 'Shell 的文件工作区仅限上方输出目录，用于生成文件；文件工具的只读、可写授权目录不会挂载到 Shell。沙箱禁用网络。取消任务不会撤销已完成的写入。', 'lt-help'))
    if (!capabilities.shellAvailable) { advanced.open = true; advanced.append(node('p', `Shell 不可用：${text(capabilities.reason || '当前环境未提供沙箱能力')}`, 'lt-warning')) }
    const skills = field(advanced, '技能目录（可选，绝对路径）', settings.skillsDir)
    const actions = node('div', undefined, 'lt-actions'), save = node('button', '保存授权', 'lt-button'); save.type = 'submit'; save.disabled = conflict
    actions.append(save, button('丢弃草稿并重新加载', () => { if (!saving) void load(true) })); controls.append(actions)
    form.addEventListener('input', () => { dirty = true }); form.addEventListener('change', () => { dirty = true })
    const roots = input => [...new Set(input.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean))]
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (saving || conflict) return
      const payload = { expectedRevision: settings.revision, readRoots: roots(reads), writeRoots: roots(writes), webEnabled: web.checked, shellEnabled: shell.checked, skillsDir: skills.value.trim() || null }
      if ([...payload.readRoots, ...payload.writeRoots, ...(payload.skillsDir ? [payload.skillsDir] : [])].some(p => !p.startsWith('/'))) { notice.textContent = '请使用绝对目录路径（以 / 开头）。'; return }
      saving = true; controls.disabled = true; notice.textContent = '正在保存…'
      try { await api('/api/local-tools/settings', 'PATCH', payload); dirty = false; notice.textContent = '授权已保存。'; await load(true) }
      catch (error) { conflict = error.status === 409; notice.textContent = conflict ? '配置已被其他页面修改。你的草稿已保留；请记录修改后，点击“丢弃草稿并重新加载”读取最新版本。' : error.message; save.disabled = conflict }
      finally { saving = false; controls.disabled = false }
    })
    editor.append(form)
  }
  async function load(replace = false) {
    const ticket = ++loadEpoch; notice.textContent = '正在读取本地工具…'
    try {
      const data = await api('/api/local-tools'); if (ticket !== loadEpoch) return
      if (replace || !settings || !dirty) { settings = data.settings; capabilities = data.capabilities || {}; dirty = false; conflict = false; renderSettings() }
      for (const q of data.questions || []) acceptQuestion(q, false)
      renderPending(); notice.textContent = dirty ? '未保存的草稿已保留。' : '目录权限仅在点击“保存授权”后生效。'
    } catch (error) { if (ticket === loadEpoch) { notice.textContent = error.message; if (!settings) renderSettings() } }
  }
  const expiry = q => typeof q.expiresAt === 'number' ? q.expiresAt : Date.parse(q.expiresAt)
  const stale = q => retired.has(q.id) || ended.has(turnKey(q)) || !Number.isFinite(expiry(q)) || expiry(q) <= Date.now()
  function scheduleExpiry() {
    clearTimeout(expiryTimer)
    const times = [...pending.values()].map(expiry).filter(Number.isFinite)
    if (!times.length) return
    expiryTimer = setTimeout(() => { for (const q of pending.values()) if (stale(q)) retire(q.id); renderPending(); scheduleExpiry() }, Math.min(2147483647, Math.max(0, Math.min(...times) - Date.now() + 10)))
  }
  function retire(id) {
    retired.add(id); pending.delete(id)
    if (activeQuestion === id) { questionDialog.close(); activeQuestion = null }
  }
  function acceptQuestion(q, open) {
    if (!q?.id || !q.sessionId || !q.turnId || !Array.isArray(q.questions) || stale(q)) return
    if (!pending.has(q.id)) pending.set(q.id, q)
    renderPending(); scheduleExpiry()
    if (open && !questionDialog.open) showQuestion(q)
  }
  function renderPending() {
    questions.replaceChildren(node('h3', '待回答的问题'))
    const items = [...pending.values()].filter(q => !stale(q) && (!sessionId || q.sessionId === sessionId))
    if (!items.length) questions.append(node('p', '当前没有待回答的问题。', 'lt-help'))
    for (const q of items) questions.append(button(`${q.questions[0]?.question || '回答问题'} · 会话 ${q.sessionId}`, () => showQuestion(q)))
  }
  function showQuestion(q) {
    if (stale(q)) { retire(q.id); renderPending(); return }
    activeQuestion = q.id; questionBody.replaceChildren()
    questionBody.append(node('p', '回答将作为本轮任务的补充信息，不代表授予工具权限。', 'lt-help'), node('p', `会话 ${q.sessionId} · 有效期至 ${new Date(expiry(q)).toLocaleString()}`, 'lt-help'))
    const form = node('form'), controls = node('fieldset', undefined, 'lt-controls'), answers = []
    form.append(controls)
    q.questions.forEach((item, index) => {
      const group = node('fieldset', undefined, 'lt-question'); group.append(node('legend', item.question)); controls.append(group)
      const options = []
      for (const option of item.options || []) {
        const label = node('label', undefined, 'lt-check'), input = node('input'); input.type = item.multiSelect ? 'checkbox' : 'radio'; input.name = `local-question-${index}`; input.value = option.label
        const copy = node('span', option.label); if (option.description) copy.append(node('small', option.description, 'lt-help'))
        label.append(input, copy); group.append(label); options.push(input)
      }
      if (options.length) group.append(node('p', item.multiSelect ? '可选择多项，也可补充文字。' : '可选择一项，也可直接填写文字。', 'lt-help'))
      const custom = field(group, '自定义回答 / 补充', '', true); answers.push({ id: item.id, options, custom })
    })
    const status = node('p', '', 'lt-notice'); status.setAttribute('role', 'status')
    const submit = node('button', '提交回答', 'lt-button'); submit.type = 'submit'; controls.append(status, submit); questionBody.append(form)
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (submitting.has(q.id)) return
      if (stale(q)) { retire(q.id); renderPending(); return }
      const values = answers.map(a => ({ id: a.id, selected: a.options.filter(o => o.checked).map(o => o.value), ...(a.custom.value.trim() ? { custom: a.custom.value.trim() } : {}) }))
      if (values.some(a => !a.selected.length && !a.custom)) { status.textContent = '请为每个问题选择选项或填写回答。'; return }
      submitting.add(q.id); controls.disabled = true; status.textContent = '正在提交…'
      try { await api(`/api/local-tools/questions/${encodeURIComponent(q.id)}`, 'POST', { sessionId: q.sessionId, turnId: q.turnId, answers: values }); retire(q.id); renderPending() }
      catch (error) { if ([404, 409, 410].includes(error.status)) { retire(q.id); renderPending(); notice.textContent = '问题已结束或过期。' } else status.textContent = error.message }
      finally { submitting.delete(q.id); controls.disabled = false }
    })
    if (!questionDialog.open) questionDialog.showModal()
  }
  async function download(event, href, name, link) {
    event.preventDefault(); if (link.getAttribute('aria-busy') === 'true') return
    link.setAttribute('aria-busy', 'true')
    try {
      const response = await api(href, 'GET', undefined, true), blob = await response.blob(), url = URL.createObjectURL(blob), a = node('a')
      a.href = url; a.download = name || 'artifact'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (error) { notice.textContent = error.message } finally { link.removeAttribute('aria-busy') }
  }
  async function loadSession() {
    const ticket = ++sessionEpoch, selected = sessionId
    activity.replaceChildren(node('h3', '本轮工作与产物'))
    if (!selected) { activity.append(node('p', '打开对话后，可查看该会话的任务计划、后台任务与产物。', 'lt-help')); return }
    activity.append(node('p', `会话 ${selected} · 正在读取…`, 'lt-help'))
    try {
      const data = await api(`/api/local-tools/session/${encodeURIComponent(selected)}`); if (ticket !== sessionEpoch) return
      activity.replaceChildren(node('h3', '任务计划'), node('p', '计划描述当前工作的步骤，与到点通知你的提醒分开。', 'lt-help'), button('刷新任务与产物', loadSession))
      const todos = Array.isArray(data.plan) ? data.plan : data.plan?.todos || []
      const list = node('ol', undefined, 'lt-plan'), labels = { pending: '待开始', in_progress: '进行中', completed: '已完成' }
      for (const todo of todos) list.append(node('li', `${labels[todo.status] || todo.status} · ${todo.content}`))
      activity.append(todos.length ? list : node('p', '暂无任务计划。', 'lt-help'), node('h3', '后台任务'))
      if (!data.jobs?.length) activity.append(node('p', '暂无后台任务。', 'lt-help'))
      for (const job of data.jobs || []) {
        const card = node('article', undefined, 'lt-card'); card.append(node('h4', `${job.command || job.id} · ${job.status}`))
        if (job.output) { const details = node('details'); details.append(node('summary', '查看输出'), node('pre', text(job.output))); card.append(details) }
        if (['running', 'pending', 'cancelling'].includes(job.status)) {
          const cancel = button('取消任务', async () => { cancel.disabled = true; try { await api(`/api/local-tools/jobs/${encodeURIComponent(job.id)}/cancel`, 'POST', { sessionId: selected }); if (selected === sessionId) await loadSession() } catch (error) { notice.textContent = error.message; cancel.disabled = false } }); cancel.disabled = job.status === 'cancelling'; card.append(cancel)
        }
        activity.append(card)
      }
      activity.append(node('h3', '产物下载'))
      if (!data.artifacts?.length) activity.append(node('p', '暂无产物。', 'lt-help'))
      for (const item of data.artifacts || []) {
        const id = item.id || item.artifactId; if (!id) continue
        const a = node('a', item.name || id, 'lt-download'), href = `/api/local-tools/artifacts/${encodeURIComponent(id)}?${new URLSearchParams({ sessionId: selected })}`
        a.href = href; a.download = item.name || 'artifact'; a.addEventListener('click', event => download(event, href, item.name, a)); activity.append(a)
      }
    } catch (error) { if (ticket === sessionEpoch) activity.replaceChildren(node('p', error.message, 'lt-warning'), button('重试读取任务', loadSession)) }
  }
  window.addEventListener('jarvis:local-tools-open', event => {
    sessionId = typeof event.detail?.sessionId === 'string' ? event.detail.sessionId : ''
    if (!panel.open) panel.showModal()
    void load(); void loadSession()
  })
  window.addEventListener('jarvis:ws-event', event => {
    const message = event.detail || {}, data = { ...message.data, sessionId: message.data?.sessionId || message.sessionId, turnId: message.data?.turnId || message.turnId }
    if (message.type === 'task.question') acceptQuestion(data, true)
    if (message.type === 'task.question.resolved') { retire(data.id); renderPending(); scheduleExpiry() }
    if (['assistant.done', 'assistant.cancelled', 'turn.end'].includes(message.type) && data.sessionId && data.turnId) {
      ended.add(turnKey(data)); for (const q of pending.values()) if (turnKey(q) === turnKey(data)) retire(q.id)
      renderPending(); scheduleExpiry()
    }
    if (panel.open && data.sessionId === sessionId && /^(task\.(plan|job)|artifact\.)/.test(message.type)) void loadSession()
  })
})()
