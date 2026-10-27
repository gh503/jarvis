// Standalone profile surface. All user-provided values are rendered as text.
const categories = { basic: '个人信息', career: '职业', experience: '经历', interest: '兴趣', preference: '偏好', goal: '目标', understanding: 'Jarvis 的理解' }
const fields = { gender: '性别', birthday: '生日', age: '自报年龄', city: '所在城市', industry: '行业', role: '职业 / 角色', hobby: '兴趣爱好', communication: '沟通偏好', workstyle: '工作习惯', goal: '目标', understanding: '理解', experience: '经历', notes: '补充说明' }
const usageNames = { display: '仅展示', local: '仅本地模型', relevant: '相关时可用于模型' }
const statusNames = { confirmed: '已确认', proposed: '待确认', inactive: '已停用' }
const fieldCategories = { industry: 'career', role: 'career', hobby: 'interest', communication: 'preference', workstyle: 'preference', goal: 'goal', understanding: 'understanding', notes: 'understanding', experience: 'experience' }
const categoryFields = { basic: ['gender', 'birthday', 'age', 'city'], career: ['industry', 'role'], interest: ['hobby'], preference: ['communication', 'workstyle'], goal: ['goal'], understanding: ['understanding', 'notes'], experience: ['experience'] }
let snapshot = { entries: [], people: [], settings: {}, changes: [], derived: [] }
let dirty = false
let busy = false
let epoch = 0
let editor = null
let pendingRefresh = false
let referencedIds = []
const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n }
const button = (text, action, className = '') => { const n = el('button', `profile-button ${className}`, text); n.type = 'button'; n.addEventListener('click', action); return n }
const dialog = el('dialog', 'profile-dialog'); dialog.id = 'profile-dialog'; dialog.setAttribute('aria-labelledby', 'profile-title')
const rail = el('aside', 'profile-rail')
const brand = el('div', 'profile-brand'); const brandCopy = el('div'); brandCopy.append(el('strong', '', 'JARVIS'), el('span', '', 'PROFILE')); brand.append(el('span', 'profile-mark', 'J'), brandCopy)
const nav = el('nav', 'profile-nav'); nav.setAttribute('aria-label', '资料分区导航')
const railFoot = el('div', 'profile-rail-foot'); railFoot.append(el('p', '', '由你确认 · 随时纠正'), button('关闭资料', () => closeProfile(), 'profile-close-link'))
rail.append(brand, nav, railFoot)
const main = el('div', 'profile-main')
const header = el('header', 'profile-header')
const heading = el('div'); heading.append(el('p', 'profile-eyebrow', 'PROFILE / UNDERSTANDING'))
const title = el('h2', '', '对我的了解'); title.id = 'profile-title'; heading.append(title, el('p', 'profile-subtitle', '查看 Jarvis 记住的资料，决定如何使用，也可以随时纠正。'))
const closeButton = button('关闭', () => closeProfile(), 'profile-close'); closeButton.setAttribute('aria-label', '关闭对我的了解'); closeButton.title = '关闭（Esc）'
header.append(heading, closeButton)
const status = el('p', 'profile-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite')
const body = el('div', 'profile-body')
const content = el('div', 'profile-content')
const editPane = el('section', 'profile-editor'); editPane.hidden = true; editPane.setAttribute('aria-label', '编辑资料')
body.append(content, editPane); main.append(header, status, body); dialog.append(rail, main); document.body.append(dialog)
let sectionLinks = []
function syncNavigation() {
  if (!dialog.open || !sectionLinks.length) return
  const top = body.getBoundingClientRect().top + 32
  let current = sectionLinks[0]
  for (const item of sectionLinks) { if (item.section.getBoundingClientRect().top <= top) current = item }
  // At the end, short final sections must still become reachable and active.
  if (body.scrollTop > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 2) current = sectionLinks.at(-1)
  for (const item of sectionLinks) {
    const active = item === current
    item.link.classList.toggle('active', active)
    if (active) item.link.setAttribute('aria-current', 'location'); else item.link.removeAttribute('aria-current')
  }
}
body.addEventListener('scroll', syncNavigation, { passive: true })
new ResizeObserver(syncNavigation).observe(body)
function notice(text) { status.replaceChildren(document.createTextNode(text)) }
function pretty(value) { if (value == null) return ''; return typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
async function api(path = '', method = 'GET', data) {
  const token = localStorage.getItem('jarvis_token') || ''
  const response = await fetch(`/api/profile${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) { const error = new Error(response.status === 401 ? '请先在设置中配置有效的访问令牌。' : (typeof result.error === 'string' ? result.error : result.error?.message) || `请求失败（${response.status}）`); error.status = response.status; throw error }
  return result
}
async function refresh() {
  if (dirty || busy) { pendingRefresh = true; return }
  const ticket = ++epoch
  notice('正在读取资料…')
  try {
    const data = await api()
    if (ticket !== epoch || dirty || busy) { pendingRefresh = true; return }
    snapshot = { entries: [], people: [], settings: {}, changes: [], derived: [], ...data }
    pendingRefresh = false; render(); notice('你可以修改、停用或删除任何一条。未填写的信息不会猜测。')
  } catch (error) { if (ticket !== epoch) return; notice(error.message); status.append(button('重试', refresh)) }
}
function ask(titleText, copy, accept = '确认') {
  return new Promise(resolve => {
    const modal = el('dialog', 'profile-confirm'); const h = el('h2', '', titleText); h.id = 'profile-confirm-title'; modal.setAttribute('aria-labelledby', h.id)
    const actions = el('div', 'profile-actions')
    const done = value => { modal.close(); modal.remove(); resolve(value) }
    const cancel = button('取消', () => done(false)); actions.append(cancel, button(accept, () => done(true), 'profile-danger'))
    modal.append(h, el('p', '', copy), actions); document.body.append(modal)
    modal.addEventListener('cancel', event => { event.preventDefault(); done(false) }); modal.showModal(); cancel.focus()
  })
}
async function closeProfile() {
  if (busy) { notice('正在保存，请稍候。'); return }
  if (dirty && !await ask('保留未保存的修改？', '关闭后草稿会保留在当前页面，重新打开可继续编辑。刷新页面会丢失草稿。', '保留草稿并关闭')) return
  dialog.close()
}
dialog.addEventListener('cancel', event => { event.preventDefault(); closeProfile() })
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = '' } })
async function mutate(path, method, data, after) {
  if (busy) return
  busy = true; ++epoch; dialog.setAttribute('aria-busy', 'true'); editPane.querySelectorAll('button,input,select,textarea').forEach(n => { n.disabled = true })
  try {
    await api(path, method, data); dirty = false; if (after) after(); busy = false; await refresh()
  } catch (error) {
    notice(error.status === 409 ? '这条资料已在别处更新。你的修改已保留；可继续查看草稿，或重新载入最新版本。' : error.message)
    if (error.status === 409) status.append(button('重新载入', async () => { if (await ask('载入最新版本？', '这会放弃当前未保存的修改。', '放弃修改并载入')) { dirty = false; hideEditor(); await refresh() } }))
  } finally { busy = false; dialog.removeAttribute('aria-busy'); editPane.querySelectorAll('button,input,select,textarea').forEach(n => { n.disabled = false }) }
}
function hideEditor() { if (editPane.contains(document.activeElement)) header.querySelector('button')?.focus(); editor = null; editPane.hidden = true; editPane.replaceChildren(); body.classList.remove('profile-editing') }
async function abandonEditor() {
  if (busy) return false
  if (dirty && !await ask('放弃这次修改？', '尚未保存的内容将被丢弃。', '放弃修改')) return false
  dirty = false; hideEditor(); return true
}
function section(name, helper) {
  const s = el('section', 'profile-section'); s.id = `profile-section-${sectionLinks.length}`; s.tabIndex = -1
  const h = el('div', 'profile-section-head'); const label = el('h3', '', name); label.id = `${s.id}-title`; h.append(label); s.setAttribute('aria-labelledby', label.id)
  s.append(h); if (helper) s.append(el('p', 'profile-help', helper)); content.append(s)
  const link = el('a', 'profile-nav-item'); link.href = `#${s.id}`
  const number = el('span', 'profile-nav-glyph', String(sectionLinks.length + 1).padStart(2, '0')); number.setAttribute('aria-hidden', 'true'); link.append(number, el('span', '', name))
  link.addEventListener('click', event => { event.preventDefault(); s.scrollIntoView({ block: 'start', behavior: 'instant' }); s.focus({ preventScroll: true }); syncNavigation() })
  nav.append(link); sectionLinks.push({ section: s, link }); return s
}
function render() {
  content.replaceChildren(); nav.replaceChildren(); sectionLinks = []
  if (referencedIds.length) {
    const reference = section('这次回答参考的资料', '以下为当前版本，可能已修改；已删除的资料无法恢复展示。')
    const entries = snapshot.entries.filter(entry => referencedIds.includes(entry.id) || referencedIds.includes(entry.memoryId))
    if (!entries.length) reference.append(el('p', 'profile-empty', '引用的资料已删除或暂不可用。'))
    entries.forEach(entry => reference.append(entryCard(entry)))
    reference.append(button('查看全部资料', () => { referencedIds = []; render() }))
  }
  const settings = section('如何使用这些资料', '“持续学习”和“回答时使用”分别控制收集与调用；单条资料还受使用范围限制。')
  for (const [key, label] of [['learningEnabled', '持续学习：从对话中提出新理解'], ['useEnabled', '回答时使用已确认的资料']]) {
    const wrap = el('label', 'profile-switch'); const input = el('input'); input.type = 'checkbox'; input.checked = snapshot.settings?.[key] === true
    input.addEventListener('change', async () => { const value = input.checked; input.checked = !value; if (busy) return; if (dirty) { notice('请先保存或取消当前编辑，再修改设置。'); return } await mutate('/settings', 'PATCH', { [key]: value }) })
    wrap.append(input, document.createTextNode(label)); settings.append(wrap)
  }
  const groups = [ ['个人信息', ['basic']], ['职业与经历', ['career', 'experience']], ['兴趣、偏好与目标', ['interest', 'preference', 'goal']], ['Jarvis 的理解', ['understanding']] ]
  for (const [name, cats] of groups) {
    const s = section(name, cats[0] === 'understanding' ? '待确认只是建议。你可以直接纠正后确认，也可以停用。' : '')
    s.firstChild.append(button('添加', () => openEntry(null, { category: cats[0] })))
    const entries = snapshot.entries.filter(e => e.subjectId === 'self' && cats.includes(e.category))
    if (!entries.length) s.append(el('p', 'profile-empty', '还没有记录。由你补充，或在对话中逐渐了解。'))
    entries.forEach(e => s.append(entryCard(e)))
    if (cats[0] === 'basic') {
      const derived = Array.isArray(snapshot.derived) ? snapshot.derived.filter(d => d.subjectId === 'self') : []
      for (const d of derived) {
        const bits = [d.age != null ? `年龄：${pretty(d.age)}` : '', d.zodiac ? `生肖：${pretty(d.zodiac)}` : '', d.sunSign ? `星座：${pretty(d.sunSign)}` : ''].filter(Boolean)
        if (bits.length) s.append(el('p', 'profile-derived', `根据生日计算 · ${bits.join(' · ')}（只读）`))
        if (d.unsupported) s.append(el('p', 'profile-help', '暂不能可靠推算农历生日对应的年龄、生肖或星座；保留原始生日。'))
      }
    }
  }
  const people = section('家人与重要的人', '人物资料默认仅供本地模型使用。可以分别管理每个人的信息。')
  people.firstChild.append(button('添加人物', () => openPerson()))
  if (!snapshot.people.length) people.append(el('p', 'profile-empty', '还没有人物记录。'))
  snapshot.people.forEach(person => {
    const box = el('article', 'profile-person'); const head = el('div', 'profile-section-head')
    head.append(el('h4', '', person.name), el('span', 'profile-muted', person.relationship || '关系未填写'), button('编辑人物', () => openPerson(person)), button('添加资料', () => openEntry(null, { subjectId: person.id })))
    box.append(head); const entries = snapshot.entries.filter(e => e.subjectId === person.id)
    if (!entries.length) box.append(el('p', 'profile-empty', '尚未添加资料。'))
    entries.forEach(e => box.append(entryCard(e))); people.append(box)
  })
  const log = section('变更记录', '保留资料变动的线索，不为了解程度打分。')
  if (!snapshot.changes.length) log.append(el('p', 'profile-empty', '暂无变更记录。'))
  snapshot.changes.slice(0, 60).forEach(change => {
    const row = el('div', 'profile-log'); row.append(el('span', 'profile-muted', change.createdAt || change.at || ''), el('span', '', change.summary || change.description || ({ created: '添加资料', updated: '更新资料', deleted: '删除资料', proposed: '提出新的理解', 'person-created': '添加人物', 'person-updated': '更新人物', 'person-deleted': '删除人物' }[change.action]) || change.action || change.type || '资料已更新')); log.append(row)
  })
  syncNavigation()
}
function valueText(entry) {
  const v = entry.value
  if (entry.field === 'birthday' && v && typeof v === 'object') return `${v.calendar === 'lunar' ? '农历' : '公历'} ${v.year ? `${v.year}年 ` : ''}${v.leap ? '闰' : ''}${v.month}月${v.day}日`
  if (entry.field === 'age' && v && typeof v === 'object') return `${v.years} 岁 · 自报于 ${v.asOf || '日期未记录'}`
  if (entry.field === 'experience' && v && typeof v === 'object') return [v.title, v.organization, v.role, v.industry, v.location, [v.startDate || v.start, v.endDate || v.end].filter(Boolean).join(' — '), v.description].filter(Boolean).join(' · ')
  return pretty(v) || entry.content || '未填写'
}
function entryCard(entry) {
  const card = el('article', `profile-card ${entry.status === 'inactive' ? 'profile-inactive' : ''}`)
  const head = el('div', 'profile-card-head'); head.append(el('strong', '', fields[entry.field] || entry.field), el('span', `profile-badge ${entry.status === 'proposed' ? 'profile-proposed' : ''}`, statusNames[entry.status] || entry.status))
  card.append(head, el('p', 'profile-value', valueText(entry)))
  // Structured content is a backend retrieval representation, not a second user-facing value.
  card.append(el('p', 'profile-meta', `${usageNames[entry.usage] || entry.usage} · ${entry.scope === 'global' ? '所有场景' : `场景：${entry.scope}`} ${entry.userLocked ? '· 由你锁定' : ''}`))
  const actions = el('div', 'profile-actions'); actions.append(button(entry.status === 'proposed' ? '纠正 / 确认' : '编辑', () => openEntry(entry)), button('查看来源', () => showSource(entry)))
  card.append(actions); return card
}
async function showSource(entry) {
  const modal = el('dialog', 'profile-source'); modal.setAttribute('aria-label', '资料来源')
  const copy = el('pre', 'profile-source-text', '正在读取来源…'); modal.append(el('h2', '', '资料来源'), copy, button('关闭', () => modal.close())); document.body.append(modal); modal.addEventListener('close', () => modal.remove()); modal.showModal()
  try { const source = await api(`/entries/${encodeURIComponent(entry.id)}/source`); copy.textContent = source.available && typeof source.text === 'string' ? source.text : '原始来源暂不可用。不会用推测内容替代原文。'; if (source.available && (source.sessionId || source.turnId)) modal.insertBefore(el('p', 'profile-meta', [source.sessionId && `会话 ${source.sessionId}`, source.turnId && `轮次 ${source.turnId}`].filter(Boolean).join(' · ')), copy) } catch (error) { copy.textContent = error.message }
}
function control(form, label, name, value = '', options) {
  const wrap = el('label', 'profile-field'); wrap.append(el('span', '', label))
  const input = el(options ? 'select' : 'input'); input.name = name
  if (options) Object.entries(options).forEach(([key, text]) => { const option = el('option', '', text); option.value = key; input.append(option) })
  input.value = value ?? ''; wrap.append(input); form.append(wrap); return input
}
function startEditor(titleText) {
  ++epoch; editor = el('form', 'profile-form'); editor.append(el('h3', '', titleText)); editPane.replaceChildren(editor); editPane.hidden = false; body.classList.add('profile-editing')
  editor.addEventListener('input', () => { dirty = true }); editor.addEventListener('change', () => { dirty = true })
  return editor
}
function finishForm(form, submit, remove) {
  const actions = el('div', 'profile-actions'); const save = el('button', 'profile-button profile-primary', '保存'); save.type = 'submit'
  actions.append(save, button('取消', async () => { if (await abandonEditor()) { if (pendingRefresh) refresh(); else notice('已取消编辑。') } }))
  if (remove) actions.append(button('删除', remove, 'profile-danger'))
  form.append(actions); form.addEventListener('submit', event => { event.preventDefault(); if (!busy && form.reportValidity()) submit() })
  form.querySelector('input,select,textarea')?.focus(); editPane.scrollIntoView({ block: 'nearest' })
}
async function openEntry(entry, defaults = {}) {
  if (!await abandonEditor()) return
  const data = entry || { subjectId: 'self', category: 'basic', status: 'confirmed', scope: 'global', ...defaults }
  const form = startEditor(entry ? '纠正这条资料' : '添加资料')
  const subject = control(form, '关于谁', 'subjectId', data.subjectId, { self: '我', ...Object.fromEntries(snapshot.people.map(p => [p.id, p.name])) })
  const category = control(form, '分类', 'category', data.category, categories)
  const initialField = data.field || ({ basic: 'gender', career: 'role', interest: 'hobby', preference: 'communication', goal: 'goal', understanding: 'understanding', experience: 'experience' }[data.category])
  const field = control(form, '信息项', 'field', initialField, fields)
  const valueGroup = el('div', 'profile-value-fields'); form.append(valueGroup)
  function buildValue(value) {
    valueGroup.replaceChildren()
    if (field.value === 'birthday') {
      const v = value && typeof value === 'object' ? value : {}
      control(valueGroup, '历法', 'calendar', v.calendar || 'solar', { solar: '公历', lunar: '农历' })
      for (const [key, label, min, max] of [['year', '出生年份（可不填）', 1, 9999], ['month', '月', 1, 12], ['day', '日', 1, 31]]) { const input = control(valueGroup, label, key, v[key]); input.type = 'number'; input.min = min; input.max = max; input.required = key !== 'year' }
      control(valueGroup, '是否农历闰月', 'leap', v.leap ? 'true' : 'false', { false: '否', true: '是' })
      valueGroup.append(el('p', 'profile-help', '可只填月日。农历日期不会擅自换算；生肖、年龄、星座由系统在信息足够时显示。'))
    } else if (field.value === 'age') {
      const input = control(valueGroup, '自报年龄（岁）', 'years', value?.years); input.type = 'number'; input.min = 0; input.max = 150; input.required = true
      const asOf = control(valueGroup, '截至日期', 'asOf', value?.asOf || ''); asOf.type = 'date'; asOf.required = true
      valueGroup.append(el('p', 'profile-help', '这是某一天自报的年龄，不会当作出生日期。'))
    } else if (field.value === 'experience') {
      for (const [key, label] of [['title', '经历标题'], ['organization', '组织 / 项目'], ['role', '角色'], ['industry', '行业（选填）'], ['location', '地点（选填）'], ['start', '开始月份（选填）'], ['end', '结束月份（选填）'], ['startDate', '开始日期（选填）'], ['endDate', '结束日期（选填）'], ['description', '经历说明']]) { const input = control(valueGroup, label, key, value?.[key] || ''); if (['start', 'end'].includes(key)) input.type = 'month'; if (key.endsWith('Date')) input.type = 'date' }
      valueGroup.append(el('p', 'profile-help', '填写标题、说明，或同时填写组织和角色。时间可按月或按日填写。'))
    } else {
      const label = el('label', 'profile-field'); label.append(el('span', '', '内容')); const input = el('textarea'); input.name = 'value'; input.rows = 4; input.required = true; input.maxLength = 8000; input.value = pretty(value); label.append(input); valueGroup.append(label)
    }
  }
  buildValue(data.value)
  field.addEventListener('change', () => { category.value = fieldCategories[field.value] || 'basic'; buildValue('') })
  category.addEventListener('change', () => { if (!categoryFields[category.value].includes(field.value)) { field.value = categoryFields[category.value][0]; buildValue('') } })
  const usage = control(form, '模型使用范围', 'usage', data.usage || (data.subjectId !== 'self' || data.category === 'preference' ? 'local' : 'display'), usageNames)
  subject.addEventListener('change', () => { if (!entry && subject.value !== 'self') usage.value = 'local' })
  form.append(el('p', 'profile-help', '仅展示：不交给模型。仅本地模型：不用于远端模型。相关时可用于模型：可能发送到当前配置的模型，包括远端服务。'))
  control(form, '状态', 'status', data.status, statusNames)
  const scope = control(form, '适用场景', 'scope', data.scope || 'global'); scope.required = true
  form.append(el('p', 'profile-help', 'global 表示所有场景；也可填写已有场景 ID。待确认和已停用的资料不参与回答。'))
  finishForm(form, () => {
    const values = Object.fromEntries(new FormData(form)); let value = values.value?.trim()
    if (field.value === 'birthday') value = { calendar: values.calendar, ...(values.year ? { year: Number(values.year) } : {}), month: Number(values.month), day: Number(values.day), leap: values.calendar === 'lunar' && values.leap === 'true' }
    if (field.value === 'age') value = { years: Number(values.years), asOf: values.asOf }
    if (field.value === 'experience') value = Object.fromEntries(['title', 'organization', 'role', 'industry', 'location', 'start', 'end', 'startDate', 'endDate', 'description'].filter(key => values[key]?.trim()).map(key => [key, values[key].trim()]))
    mutate('/entries', 'POST', { ...(entry ? { id: entry.id, expectedRevision: entry.revision } : {}), subjectId: values.subjectId, category: values.category, field: values.field, value, status: values.status, usage: values.usage, scope: values.scope.trim() }, hideEditor)
  }, entry ? async () => { if (await ask('删除这条资料？', '删除后将不再展示或用于回答。', '删除资料')) mutate(`/entries/${encodeURIComponent(entry.id)}`, 'DELETE', { expectedRevision: entry.revision }, hideEditor) } : null)
}
async function openPerson(person) {
  if (!await abandonEditor()) return
  const form = startEditor(person ? '编辑人物' : '添加人物')
  const name = control(form, '称呼', 'name', person?.name); name.required = true; name.maxLength = 100
  const relationship = control(form, '与你的关系', 'relationship', person?.relationship); relationship.required = true; relationship.maxLength = 100
  form.append(el('p', 'profile-help', '可以使用昵称。人物资料单独管理，不会混入你的个人信息。'))
  finishForm(form, () => mutate('/people', 'POST', { ...(person ? { id: person.id, expectedRevision: person.revision } : {}), name: name.value.trim(), relationship: relationship.value.trim() }, hideEditor), person ? async () => { if (await ask('删除这个人物？', '该人物及其资料将被移除，不再用于回答。', '删除人物')) mutate(`/people/${encodeURIComponent(person.id)}`, 'DELETE', { expectedRevision: person.revision }, hideEditor) } : null)
}
function openProfile(ids = []) { referencedIds = ids; if (!dialog.open) dialog.showModal(); if (dirty) notice('已保留上次未保存的修改。请先完成编辑，再查看引用资料。'); else { hideEditor(); refresh() } }
document.getElementById('profile-open')?.addEventListener('click', () => openProfile())
window.addEventListener('jarvis:profile-open', event => openProfile(Array.isArray(event.detail?.ids) ? event.detail.ids.filter(id => typeof id === 'string') : []))
window.addEventListener('jarvis:ws-event', event => {
  const type = event.detail?.type || event.detail?.event || ''
  if (type === 'profile.changed' || type.startsWith('memory.')) { if (dialog.open && !dirty && !busy) refresh(); else pendingRefresh = true }
})
