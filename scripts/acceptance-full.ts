/**
 * Full acceptance suite for Jarvis v2.
 *
 * Boots a throwaway instance (temp data dir + free port) so destructive checks
 * (privacy erase, provider add/delete, tuning writes) never touch real data,
 * then exercises every route, auth/CSRF boundary, WebSocket flow, persistence
 * across a restart, and the erase path.
 *
 *   npm run acceptance:full            # spins its own instance
 *   JARVIS_URL=http://127.0.0.1:3081 npm run acceptance:full -- --no-boot
 *
 * Exit code is non-zero if any check fails.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'

const REPO = join(import.meta.dirname, '..')
const bootOwn = !process.argv.includes('--no-boot')

type Check = { name: string, ok: boolean, detail: string }
const checks: Check[] = []
let currentSection = ''

function section(name: string): void {
  currentSection = name
  console.log(`\u001b[1;36m\n== ${name}\u001b[0m`)
}

function check(name: string, ok: boolean, detail = ''): boolean {
  checks.push({ name: `${currentSection} · ${name}`, ok, detail })
  const mark = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'
  console.log(`  ${mark} ${name}${detail && !ok ? `  \u001b[2m(${detail})\u001b[0m` : ''}`)
  return ok
}

function equal(name: string, actual: unknown, expected: unknown): boolean {
  return check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function includes(name: string, haystack: string, needle: string): boolean {
  return check(name, haystack.includes(needle), `missing ${JSON.stringify(needle)}`)
}

function excludes(name: string, haystack: string, needle: string): boolean {
  return check(name, !haystack.includes(needle), `leaked ${JSON.stringify(needle)}`)
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForHealth(base: string, timeoutMs: number): Promise<void> {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${base}/api/health`)
      if (response.ok) return
      lastError = `status ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`server did not become healthy in ${timeoutMs}ms: ${lastError}`)
}

async function bootInstance(dir: string, port: number): Promise<{ child: ChildProcess, base: string }> {
  const child = spawn(process.execPath, ['--experimental-transform-types', '--enable-source-maps', 'src/main.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      JARVIS_PORT: String(port),
      JARVIS_DATA_DIR: dir,
      JARVIS_OLLAMA_KEEP_ALIVE: '5m',
      JARVIS_DAILY_SPEAK_BUDGET: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log: string[] = []
  child.stdout?.on('data', chunk => log.push(String(chunk)))
  child.stderr?.on('data', chunk => log.push(String(chunk)))
  const base = `http://127.0.0.1:${port}`
  try {
    await waitForHealth(base, 90_000)
  } catch (error) {
    child.kill('SIGKILL')
    throw new Error(`${String(error)}\n--- server log ---\n${log.join('').slice(-4000)}`)
  }
  return { child, base }
}

/** Raw request with a forged Host header (fetch normalises it away). */
async function rawHostStatus(base: string, path: string, host: string, origin?: string): Promise<number | string> {
  const url = new URL(base)
  return await new Promise(resolve => {
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path,
      method: 'GET',
      headers: { host, ...(origin ? { origin } : {}) },
    }, response => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('error', error => resolve(`error: ${error.message}`))
    request.setTimeout(5000, () => { request.destroy(); resolve('timeout') })
    request.end()
  })
}

async function runNode(args: string[], env: Record<string, string>): Promise<{ code: number, output: string }> {
  const child = spawn(process.execPath, ['--experimental-transform-types', ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output: string[] = []
  child.stdout?.on('data', chunk => output.push(String(chunk)))
  child.stderr?.on('data', chunk => output.push(String(chunk)))
  const code = await new Promise<number>(resolve => child.once('exit', value => resolve(value ?? 1)))
  return { code, output: output.join('') }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 8000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

interface Reply {
  status: number
  text: string
  json: any
  headers: Headers
}

async function req(base: string, path: string, init: RequestInit = {}): Promise<Reply> {
  const headers = new Headers(init.headers)
  if (init.body && typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' })
  const text = await response.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: response.status, text, json, headers: response.headers }
}

const post = (base: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  req(base, path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers })
const put = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  req(base, path, { method: 'PUT', body: JSON.stringify(body), headers })
const del = (base: string, path: string, headers: Record<string, string> = {}) =>
  req(base, path, { method: 'DELETE', headers })

const PROXIED = { 'x-forwarded-for': '203.0.113.9' }

async function main(): Promise<void> {
  let token = ''
  let dir = ''
  let base = process.env.JARVIS_URL?.trim() || ''
  let child: ChildProcess | null = null

  if (bootOwn) {
    dir = await mkdtemp(join(tmpdir(), 'jarvis-acceptance-'))
    const port = await freePort()
    console.log(`booting isolated instance on :${port} with data dir ${dir}`)
    const booted = await bootInstance(dir, port)
    child = booted.child
    base = booted.base
  }
  if (!base) throw new Error('JARVIS_URL is empty')
  token = (await readFile(join(dir || process.env.JARVIS_DATA_DIR || '', 'auth-token'), 'utf8').catch(() => '')).trim()

  const AUTH: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
  const AUTH_PROXIED: Record<string, string> = { ...AUTH, ...PROXIED }

  try {
    // ---------------------------------------------------------------- static
    section('静态资源与安全头')
    const shell = await req(base, '/')
    check('/ 返回 200', shell.status === 200, `status ${shell.status}`)
    includes('/ 是 Jarvis 外壳', shell.text, 'Jarvis')
    equal('/ 不被缓存', shell.headers.get('cache-control'), 'no-cache')
    includes('CSP 存在', shell.headers.get('content-security-policy') ?? '', "default-src 'self'")
    equal('X-Frame-Options', shell.headers.get('x-frame-options'), 'DENY')
    equal('nosniff', shell.headers.get('x-content-type-options'), 'nosniff')
    equal('Referrer-Policy', shell.headers.get('referrer-policy'), 'no-referrer')
    const pairPage = await req(base, '/pair')
    check('/pair 返回 200', pairPage.status === 200, `status ${pairPage.status}`)
    includes('/pair 是配对页', pairPage.text, 'PAIRING')
    const appJs = await req(base, '/app.js')
    includes('app.js 的 content-type', appJs.headers.get('content-type') ?? '', 'javascript')
    equal('缺失静态文件 404', (await req(base, '/nope-does-not-exist.js')).status, 404)
    equal('目录穿越 (编码) 被拒', (await req(base, '/%2e%2e%2f%2e%2e%2fetc%2fpasswd')).status, 400)
    equal('不存在的方法 405', (await req(base, '/api/health', { method: 'PATCH' })).status, 405)
    const headShell = await fetch(`${base}/`, { method: 'HEAD' })
    equal('HEAD / 返回 200', headShell.status, 200)

    // ------------------------------------------------- app shell: guide pages
    section('供应商指南与安装页')
    const providersPage = await req(base, '/providers')
    equal('/providers 返回 200', providersPage.status, 200)
    includes('/providers 是供应商指南', providersPage.text, '模型服务')
    includes('/providers 引用样式', providersPage.text, '/providers.css')
    const providersJs = await req(base, '/providers.js')
    includes('/providers.js 的 content-type', providersJs.headers.get('content-type') ?? '', 'javascript')
    const installPage = await req(base, '/install')
    equal('/install 返回 200', installPage.status, 200)
    includes('/install 是安装引导', installPage.text, '把 Jarvis 装成 App')
    // The guide must be readable before anyone signs in: it is the page that
    // tells a new user how to get a key in the first place.
    equal('代理场景下指南页仍可读', (await req(base, '/providers', { headers: PROXIED })).status, 200)
    const catalog = await req(base, '/api/providers/catalog', { headers: PROXIED })
    equal('供应商目录无需登录', catalog.status, 200)
    const catalogJson = catalog.json as { providers?: any[], platform?: { os?: string } }
    const providerCount = (catalogJson.providers ?? []).length
    check('目录条目足够多', providerCount >= 15, `${providerCount} 条`)
    check('目录包含国内直连供应商', (catalogJson.providers ?? []).some((item: any) => item.region === 'cn' && item.chinaDirect === true))
    check('目录包含本机供应商', (catalogJson.providers ?? []).some((item: any) => item.region === 'local'))
    check('目录不包含任何密钥字段', !JSON.stringify(catalogJson).includes('"apiKey":'))
    check('目录带平台信息', Boolean(catalogJson.platform?.os))
    const providers = catalogJson.providers ?? []
    check('每个供应商都带模型清单', providers.every((item: any) => Array.isArray(item.models)))
    check('目录带视觉模型清单', providers.filter((item: any) => (item.visionModels ?? []).length).length >= 8)
    check('目录带向量模型清单', providers.filter((item: any) => (item.embeddingModels ?? []).length).length >= 7)
    check('本机条目列出 Ollama 向量模型', providers.some((item: any) => item.id === 'ollama' && item.embeddingModels.includes('nomic-embed-text')))
    const platformHealth = await req(base, '/api/health')
    const voiceCatalog = await req(base, '/api/voice/catalog', { headers: PROXIED })
    equal('语音目录无需登录', voiceCatalog.status, 200)
    const voiceJson = voiceCatalog.json as { voices?: any[], platform?: { os?: string } }
    const voiceCount = (voiceJson.voices ?? []).length
    check('语音目录条目足够多', voiceCount >= 15, `${voiceCount} 条`)
    check('语音目录含 ASR', (voiceJson.voices ?? []).some((item: any) => item.kind === 'asr'))
    check('语音目录含 TTS', (voiceJson.voices ?? []).some((item: any) => item.kind === 'tts'))
    check('语音目录含国内直连', (voiceJson.voices ?? []).some((item: any) => item.region === 'cn' && item.chinaDirect === true))
    check('语音目录不含密钥字段', !JSON.stringify(voiceJson).includes('"apiKey":'))
    const voices = voiceJson.voices ?? []
    check('语音预设都带可选模型', voices.every((item: any) => Array.isArray(item.models) && item.models.length > 0))
    check('TTS 预设都带可选音色', voices.filter((item: any) => item.kind === 'tts').every((item: any) => Array.isArray(item.voices) && item.voices.length > 0))
    check('Edge 预设列出中文音色', voices.some((item: any) => item.id === 'edge-tts' && item.voices.includes('zh-CN-XiaoxiaoNeural')))
    includes('指南页含语音分区', providersPage.text, '语音识别与合成')
    includes('指南页锚点', providersPage.text, 'id="voice"')

    check('health 暴露平台能力', Boolean((platformHealth.json as any)?.platform?.os))
    check('health 给出不可用原因', typeof (platformHealth.json as any)?.platform?.reasons === 'object')

    // ------------------------------------------------------------------ auth
    section('鉴权（模拟反向代理）')
    equal('代理头无令牌 → 401', (await req(base, '/api/health', { headers: PROXIED })).status, 401)
    equal('代理头错令牌 → 401', (await req(base, '/api/health', { headers: { authorization: 'Bearer wrong-token-wrong-token', ...PROXIED } })).status, 401)
    equal('代理头正确 Bearer → 200', (await req(base, '/api/health', { headers: AUTH_PROXIED })).status, 200)
    equal('代理头 cookie → 200', (await req(base, '/api/health', { headers: { cookie: `jarvis_token=${encodeURIComponent(token)}`, ...PROXIED } })).status, 200)
    equal('代理头写操作无令牌 → 401', (await post(base, '/api/memory', { content: 'x' }, PROXIED)).status, 401)
    if (token) {
      const login = await req(base, `/?token=${encodeURIComponent(token)}`)
      equal('?token= 登录返回 302', login.status, 302)
      includes('登录下发 HttpOnly cookie', login.headers.get('set-cookie') ?? '', 'HttpOnly')
    }
    const badLogin = await req(base, '/?token=not-the-token-at-all')
    equal('错误 ?token= 不下发 cookie', badLogin.headers.get('set-cookie'), null)

    // ------------------------------------------------------------------- csrf
    section('跨站请求防护')
    const evil = { origin: 'https://evil.example' }
    equal('POST 跨站 → 403', (await post(base, '/api/memory', { content: 'csrf' }, evil)).status, 403)
    equal('PUT 跨站 → 403', (await put(base, '/api/tuning', { values: { 'ui.blur': 12 } }, evil)).status, 403)
    equal('DELETE 跨站 → 403', (await del(base, '/api/reminders/none', evil)).status, 403)
    equal('POST 同源 → 放行', (await post(base, '/api/memory', { content: '同源写入' }, { origin: base })).status, 201)
    equal('无 Origin → 放行', (await post(base, '/api/cancel')).status, 200)
    // DNS-rebinding defence: a foreign Host header must not reach the API even
    // though the socket is loopback.
    equal('陌生 Host → 421', await rawHostStatus(base, '/api/bootstrap', 'evil.example:3081'), 421)
    equal('陌生 Host + 同源伪装 → 421', await rawHostStatus(base, '/api/health', 'evil.example:3081', 'http://evil.example:3081'), 421)
    equal('陌生 Host 的导出被挡住', await rawHostStatus(base, '/api/privacy/export', 'evil.example:3081'), 421)
    equal('本机 Host 仍可用', (await req(base, '/api/health')).status, 200)

    // -------------------------------------------------------------- bootstrap
    section('状态与配置读取')
    const health = await req(base, '/api/health')
    equal('health ok', health.json?.ok, true)
    check('health 有版本', typeof health.json?.version === 'string')
    const bootstrap = await req(base, '/api/bootstrap')
    check('bootstrap 有 status/models/memory/reminders', Boolean(bootstrap.json?.status && bootstrap.json?.models && Array.isArray(bootstrap.json?.memory) && Array.isArray(bootstrap.json?.reminders)))
    excludes('bootstrap 不含密钥', bootstrap.text, '"apiKey"')
    const models = await req(base, '/api/models')
    check('/api/models 有就绪状态', typeof models.json?.modelReady === 'boolean')
    const observatory = await req(base, '/api/observatory')
    check('observatory 有 telemetry 与 memory.stats', Boolean(observatory.json?.telemetry && observatory.json?.memory?.stats))
    check('observatory 有 tuning/config', Boolean(observatory.json?.tuning && observatory.json?.config))
    const config = await req(base, '/api/config')
    excludes('config 不泄漏令牌', config.text, token || 'no-token-configured')
    equal('config 标记已配置令牌', config.json?.config?.auth?.tokenConfigured, Boolean(token))
    excludes('config 不泄漏 API Key 字段', config.text, '"apiKey"')

    // ---------------------------------------------------------------- tuning
    section('外观参数（调参 API）')
    const tuning = await req(base, '/api/tuning')
    check('tuning 有 groups/values/defaults/presets', Boolean(tuning.json?.groups && tuning.json?.values && tuning.json?.defaults && Array.isArray(tuning.json?.presets)))
    check('预设包含 平衡/沉浸/专注/省电', ['balanced', 'cinematic', 'focus', 'lowpower'].every(id => tuning.json.presets.some((p: any) => p.id === id)))
    const setHue = await put(base, '/api/tuning', { values: { 'ui.accentHue': 200 } })
    equal('写入强调色 200', setHue.status, 200)
    equal('强调色已生效', (await req(base, '/api/tuning')).json?.values?.['ui.accentHue'], 200)
    equal('未知参数 → 400', (await put(base, '/api/tuning', { values: { 'ui.notAKey': 1 } })).status, 400)
    equal('未知分组重置 → 400', (await post(base, '/api/tuning/reset', { group: 'nope' })).status, 400)
    const clamped = await put(base, '/api/tuning', { values: { 'ui.accentHue': 9999 } })
    check('越界值被夹取或拒绝', clamped.status === 400 || clamped.json?.values?.['ui.accentHue'] <= 230, `status ${clamped.status} value ${clamped.json?.values?.['ui.accentHue']}`)
    equal('错误类型 → 400', (await put(base, '/api/tuning', { values: { 'ui.motion': 'warp' } })).status, 400)
    equal('缺 values → 400', (await put(base, '/api/tuning', {})).status, 400)
    const preset = await post(base, '/api/tuning/preset', { id: 'cinematic' })
    equal('应用预设 200', preset.status, 200)
    equal('未知预设 → 400', (await post(base, '/api/tuning/preset', { id: 'nope' })).status, 400)
    equal('重置 appearance 分组 200', (await post(base, '/api/tuning/reset', { group: 'appearance' })).status, 200)
    equal('重置后回到默认强调色', (await req(base, '/api/tuning')).json?.values?.['ui.accentHue'], tuning.json.defaults['ui.accentHue'])

    // ---------------------------------------------------------------- memory
    section('记忆')
    const created = await post(base, '/api/memory', { content: '验收记忆：代号 ORBIT-42，偏好先给结论。' })
    equal('创建记忆 201', created.status, 201)
    const memoryId = created.json?.item?.id
    check('创建返回 id', typeof memoryId === 'string' && memoryId.length > 0)
    const list = await req(base, '/api/memory')
    check('列表包含新记忆', (list.json?.items ?? []).some((item: any) => item.id === memoryId))
    const recalled = await req(base, '/api/memory?query=ORBIT-42')
    check('检索命中', (recalled.json?.items ?? []).some((item: any) => JSON.stringify(item).includes('ORBIT-42')))
    equal('空 content → 400', (await post(base, '/api/memory', { content: '   ' })).status, 400)
    equal('超长 content → 400', (await post(base, '/api/memory', { content: 'x'.repeat(9000) })).status, 400)
    const identified = await post(base, '/api/memory', { content: '可确认的记忆', kind: 'semantic' })
    const confirmRes = await post(base, `/api/memory/${identified.json.item.id}/confirm`)
    equal('确认记忆 200', confirmRes.status, 200)
    const rejectTarget = await post(base, '/api/memory', { content: '可拒绝的记忆' })
    equal('拒绝记忆 200', (await post(base, `/api/memory/${rejectTarget.json.item.id}/reject`)).status, 200)
    equal('确认不存在的记忆 → 404', (await post(base, '/api/memory/ghost/confirm')).status, 404)
    equal('删除记忆 200', (await del(base, `/api/memory/${rejectTarget.json.item.id}`)).status, 200)
    equal('重复删除 → 404', (await del(base, `/api/memory/${rejectTarget.json.item.id}`)).status, 404)
    equal('合并记忆 200', (await post(base, '/api/memory/consolidate')).status, 200)
    const graph = await req(base, '/api/memory/graph')
    check('记忆图有节点', Array.isArray(graph.json?.nodes) && graph.json.nodes.length > 0)
    const sensitive = await post(base, '/api/memory', { content: '敏感：我的住址是测试大道 1 号', sensitivity: 'sensitive' })
    equal('写入敏感记忆 201', sensitive.status, 201)
    // The local memory browser shows the owner's sensitive items (they are the
    // owner); the privacy boundary is model context and outbound traffic.
    const publicList = await req(base, '/api/memory')
    check('本地记忆列表显示敏感项（带标记）', (publicList.json?.items ?? []).some((item: any) => item.id === sensitive.json.item.id))
    // Search from the local UI also sees it; the model-context boundary is
    // covered by test/memory-privacy.test.ts, which asserts the exact
    // messages handed to the provider.
    const recallLocal = await req(base, `/api/memory?query=${encodeURIComponent('住址')}`)
    check('本地检索可见敏感项', JSON.stringify(recallLocal.json ?? {}).includes('测试大道 1 号'))

    // ------------------------------------------------------------------ chat
    section('对话')
    const chat = await post(base, '/api/chat', { text: '用五个字回答：你叫什么？' })
    equal('文本对话 200', chat.status, 200)
    check('对话有回复', typeof chat.json?.reply === 'string' && chat.json.reply.trim().length > 0, JSON.stringify(chat.json).slice(0, 200))
    equal('空消息 → 400', (await post(base, '/api/chat', { text: '   ' })).status, 400)
    equal('超长消息 → 400', (await post(base, '/api/chat', { text: 'x'.repeat(8001) })).status, 400)
    equal('非法 JSON → 400', (await req(base, '/api/chat', { method: 'POST', body: '{oops', headers: { 'content-type': 'application/json' } })).status, 400)
    const chatScenario = await post(base, '/api/chat', { text: '写一个判断回文的 Python 函数', scenario: 'coding' })
    equal('场景对话 200', chatScenario.status, 200)
    check('场景对话有回复', typeof chatScenario.json?.reply === 'string' && chatScenario.json.reply.length > 0)
    equal('未知场景被忽略但仍回复', (await post(base, '/api/chat', { text: '你好', scenario: 'no-such-scenario' })).status, 200)
    const huge = await post(base, '/api/chat', { text: 'y'.repeat(1_500_000) })
    equal('超大请求体 → 413', huge.status, 413)
    const parallel = await Promise.all([1, 2, 3].map(index => post(base, '/api/chat', { text: `并发测试 ${index}` })))
    check('并发请求明确返回完成或忙碌，不伪造回复', parallel.some(item => item.status === 200 && item.json?.reply) && parallel.every(item => item.status === 200 || (item.status === 409 && item.json?.busy === true)))

    // ----------------------------------------------------------------- model
    section('供应商池与场景')
    const modelView = await req(base, '/api/model')
    check('模型视图有 settings/active/health', Boolean(modelView.json?.settings && modelView.json?.active && modelView.json?.health))
    excludes('模型视图不含 API Key', modelView.text, '"apiKey"')
    check('内置 10 个场景', (modelView.json?.settings?.scenarios ?? []).length >= 10)
    const added = await post(base, '/api/model/profile/add', {
      id: 'acc-test', label: '验收供应商', kind: 'openai', protocol: 'chat-completions',
      baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'sk-acceptance-secret',
    })
    equal('添加供应商 200', added.status, 200)
    includes('新供应商进入优先级链', JSON.stringify(added.json?.settings?.priority ?? []), 'acc-test')
    excludes('添加响应不泄漏 Key', added.text, 'sk-acceptance-secret')
    equal('重复 id → 400', (await post(base, '/api/model/profile/add', { id: 'acc-test', label: 'x', baseUrl: 'https://x.example/v1', model: 'm' })).status, 400)
    equal('非法 id → 400', (await post(base, '/api/model/profile/add', { id: 'Bad ID', label: 'x', baseUrl: 'https://x.example/v1', model: 'm' })).status, 400)
    const reordered = await post(base, '/api/model/priority', { priority: ['acc-test', 'local'] })
    equal('调整优先级 200', reordered.status, 200)
    equal('优先级已保存', (await req(base, '/api/model')).json?.settings?.priority?.[0], 'acc-test')
    equal('未知 id 优先级 → 400', (await post(base, '/api/model/priority', { priority: ['ghost'] })).status, 400)
    equal('优先级非数组 → 400', (await post(base, '/api/model/priority', { priority: 'local' })).status, 400)
    const scenarios = await post(base, '/api/model/scenarios', {
      scenarios: [{ id: 'coding', profileIds: ['acc-test'], model: 'test-model', temperature: 0.15 }],
      scenarioAuto: true,
      defaultScenario: 'chat',
    })
    equal('保存场景配置 200', scenarios.status, 200)
    const coding = (scenarios.json?.settings?.scenarios ?? []).find((item: any) => item.id === 'coding')
    equal('场景链已保存', coding?.profileIds, ['acc-test'])
    equal('场景温度已保存', coding?.temperature, 0.15)
    const custom = await post(base, '/api/model/scenarios', { scenarios: [{ id: 'counsel', label: '树洞', custom: true, patterns: ['倾诉'] }] })
    equal('自定义场景 200', custom.status, 200)
    equal('内置场景不可删除（仍在列表中）', (custom.json?.settings?.scenarios ?? []).some((item: any) => item.id === 'chat'), true)
    equal('活动供应商改配置被拒 409', (await post(base, '/api/model/profile/update', { id: 'local', model: 'qwen2.5:3b' })).status, 409)
    equal('非活动供应商可改 200', (await post(base, '/api/model/profile/update', { id: 'acc-test', label: '验收供应商 2' })).status, 200)
    equal('删除 local 被拒 400', (await post(base, '/api/model/profile/delete', { id: 'local' })).status, 400)
    equal('删除不存在的供应商 400', (await post(base, '/api/model/profile/delete', { id: 'ghost' })).status, 400)
    equal('激活不存在的供应商 409', (await post(base, '/api/model/activate', { id: 'ghost' })).status, 409)
    equal('激活本地供应商 200', (await post(base, '/api/model/activate', { id: 'local' })).status, 200)
    equal('非法 baseUrl 应用 → 409', (await post(base, '/api/model/apply', { id: 'local', baseUrl: 'not-a-url' })).status, 409)
    equal('模型列表：无 Key 远端拒绝测试 400/502', [400, 502].includes((await post(base, '/api/model/test', { id: 'acc-test' })).status), true)

    // ----------------------------------------------------------------- voice
    section('语音')
    const voice = await req(base, '/api/voice')
    check('语音设置可读', Boolean(voice.json?.settings && voice.json?.status))
    excludes('语音设置不泄漏 Key', voice.text, '"apiKey"')
    const badVoice = await post(base, '/api/voice/apply', { asr: [{ id: 'remote', label: '远端 ASR', kind: 'remote', transport: 'http', baseUrl: 'not-a-url', model: 'whisper-1' }] })
    equal('非法语音地址 → 409', badVoice.status, 409)
    equal('回滚后 ASR 仍本地', (await req(base, '/api/voice')).json?.status?.asr?.kind, 'local')
    check('语音设置是优先级链', Array.isArray((voice.json?.settings as any)?.asr) && Array.isArray((voice.json?.settings as any)?.tts))
    check('语音状态暴露链与冷却', Array.isArray((voice.json?.status as any)?.asr?.chain) && typeof voice.json?.cooldowns === 'object')
    const pool = await post(base, '/api/voice/apply', {
      asr: [
        { id: 'acc-primary', label: '验收主用', kind: 'remote', transport: 'http', baseUrl: 'https://asr.example.com/v1', model: 'whisper-1', language: 'zh' },
        { id: 'local', label: '本地', kind: 'local', transport: 'http', baseUrl: '', model: 'tiny', language: 'zh' },
      ],
    })
    equal('多 ASR 服务可保存', pool.status, 200)
    const poolState = await req(base, '/api/voice')
    equal('链顺序按要求保存', ((poolState.json?.settings as any)?.asr ?? []).map((entry: any) => entry.id).join(','), 'acc-primary,local')
    excludes('链里也不泄漏 Key', poolState.text, '"apiKey"')
    equal('恢复本地单服务', (await post(base, '/api/voice/apply', { asr: [{ id: 'local', label: '本地', kind: 'local', transport: 'http', baseUrl: '', model: 'tiny', language: 'zh' }] })).status, 200)
    equal('恢复后链长度 1', (((await req(base, '/api/voice')).json?.settings as any)?.asr ?? []).length, 1)
    equal('空音频 → 400', (await req(base, '/api/voice', { method: 'POST', body: new Uint8Array(0), headers: { 'content-type': 'audio/wav' } })).status, 400)

    // --------------------------------------------------------------- sensors
    section('感知（无门户时应优雅失败）')
    const look = await post(base, '/api/look', { target: 'screen' })
    check('/api/look 不崩溃（返回 JSON 错误或回复）', look.json !== null && (look.status < 500 || typeof look.json?.error === 'string'), `status ${look.status}`)

    // ------------------------------------------------------------- brief/rem
    section('简报、提醒、动作、专注')
    const brief = await req(base, '/api/brief')
    check('简报有文本', typeof brief.json?.text === 'string' && brief.json.text.length > 0)
    const due = new Date(Date.now() + 3_600_000).toISOString()
    const reminder = await post(base, '/api/reminders', { text: '验收提醒', dueAt: due })
    equal('创建提醒 201', reminder.status, 201)
    const reminderId = reminder.json?.reminder?.id
    equal('非法时间 → 400', (await post(base, '/api/reminders', { text: 'x', dueAt: 'not-a-date' })).status, 400)
    equal('缺字段 → 400', (await post(base, '/api/reminders', { text: 'x' })).status, 400)
    equal('超长提醒 → 400', (await post(base, '/api/reminders', { text: 'x'.repeat(501), dueAt: due })).status, 400)
    equal('完成提醒 200', (await post(base, `/api/reminders/${reminderId}/complete`)).status, 200)
    equal('完成不存在的提醒 → 404', (await post(base, '/api/reminders/ghost/complete')).status, 404)
    const second = await post(base, '/api/reminders', { text: '待删除提醒', dueAt: due })
    equal('删除提醒 200', (await del(base, `/api/reminders/${second.json.reminder.id}`)).status, 200)
    equal('重复删除提醒 → 404', (await del(base, `/api/reminders/${second.json.reminder.id}`)).status, 404)
    const actions = await req(base, '/api/actions')
    check('动作列表可读', Array.isArray(actions.json?.items))
    equal('批准不存在的动作 → 409', (await post(base, '/api/actions/ghost/approve')).status, 409)
    await post(base, '/api/chat', { text: '打开 https://example.com/acceptance' })
    const proposed = (await req(base, '/api/actions')).json?.items ?? []
    const pending = proposed.find((item: any) => item.status === 'proposed')
    if (pending) {
      equal('拒绝动作 200', (await post(base, `/api/actions/${pending.id}/deny`)).status, 200)
    } else {
      check('外部链接会先请求确认', false, '没有产生待确认动作')
    }
    equal('专注开', (await post(base, '/api/focus', { enabled: true })).json?.focus, true)
    equal('专注关', (await post(base, '/api/focus', { enabled: false })).json?.focus, false)
    const traces = await req(base, '/api/traces?limit=5')
    check('轨迹接口可读', Array.isArray(traces.json?.traces))

    // ------------------------------------------------------------- dev/demo
    section('开发数据隔离')
    equal('无 demo 头 → 403', (await post(base, '/api/dev/demo-memory')).status, 403)
    const demo = await post(base, '/api/dev/demo-memory', undefined, { 'x-jarvis-demo': '1' })
    equal('带 demo 头 → 200', demo.status, 200)
    check('演示记忆已注入', (demo.json?.items ?? 0) > 0)
    const demoDeleted = await del(base, '/api/dev/demo-memory', { 'x-jarvis-demo': '1' })
    equal('演示记忆可清理', demoDeleted.status, 200)

    // ----------------------------------------------------- captures / audio
    section('文件服务边界')
    equal('缺失截图 → 404', (await req(base, '/api/captures/nope.png')).status, 404)
    equal('截图路径穿越 → 400', (await req(base, '/api/captures/%2e%2e%2f%2e%2e%2fpackage.json')).status, 400)
    equal('缺失音频 → 404', (await req(base, '/api/audio/nope.wav')).status, 404)
    const audioTraversal = await req(base, '/api/audio/%2e%2e%2fjarvis.db')
    check('音频路径穿越被拒', [400, 403, 404].includes(audioTraversal.status), `status ${audioTraversal.status}`)
    excludes('音频穿越不返回数据库内容', audioTraversal.text, 'SQLite format')

    // -------------------------------------------------------------- pairing
    section('设备配对与撤销')
    const pair = await post(base, '/api/devices/pair', { name: '验收手机' })
    equal('生成配对码 200', pair.status, 200)
    check('配对码是 6 位', /^\d{6}$/.test(String(pair.json?.code ?? '')), String(pair.json?.code))
    equal('错误配对码 → 401', (await post(base, '/api/devices/claim', { code: '000000', name: 'x' })).status, 401)
    let rateLimited = false
    for (let index = 0; index < 32; index += 1) {
      const attempt = await post(base, '/api/devices/claim', { code: '000000' })
      if (attempt.status === 429) { rateLimited = true; break }
    }
    check('连续失败触发限流 429', rateLimited)
    // The rate limit is per minute; wait for the window to expire before the happy path.
    await new Promise(resolve => setTimeout(resolve, 61_000))
    const freshPair = await post(base, '/api/devices/pair', { name: '验收手机' })
    const claim = await post(base, '/api/devices/claim', { code: freshPair.json.code, name: '验收手机' })
    equal('正确配对码 200', claim.status, 200)
    const deviceToken = String(claim.json?.token ?? '')
    check('配对返回设备令牌', deviceToken.length > 20)
    includes('配对下发 cookie', claim.headers.get('set-cookie') ?? '', 'HttpOnly')
    const deviceList = await req(base, '/api/devices')
    check('设备列表包含新设备', (deviceList.json?.devices ?? []).some((item: any) => item.name === '验收手机'))
    const deviceId = claim.json?.device?.id
    equal('设备令牌可访问 API（经代理头）', (await req(base, '/api/health', { headers: { authorization: `Bearer ${deviceToken}`, ...PROXIED } })).status, 200)
    // A revoked device must not keep streaming: the server closes its sockets.
    const deviceSocket = new WebSocket(`${base.replace('http', 'ws')}/ws`, {
      headers: { authorization: `Bearer ${deviceToken}`, ...PROXIED },
    })
    const deviceSocketClosed = new Promise<boolean>(resolve => {
      deviceSocket.on('close', () => resolve(true))
      deviceSocket.on('error', () => resolve(true))
      setTimeout(() => resolve(false), 6000)
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('device ws open timeout')), 8000)
      deviceSocket.on('open', () => { clearTimeout(timer); resolve() })
      deviceSocket.on('error', error => { clearTimeout(timer); reject(error) })
    })
    equal('撤销设备 200', (await del(base, `/api/devices/${deviceId}`)).status, 200)
    equal('撤销后设备 WS 被断开', await deviceSocketClosed, true)
    equal('撤销后令牌失效 401', (await req(base, '/api/health', { headers: { authorization: `Bearer ${deviceToken}`, ...PROXIED } })).status, 401)
    equal('撤销非法 id → 404', (await del(base, '/api/devices/not-a-uuid')).status, 404)

    // ------------------------------------------------------------------- ws
    section('WebSocket')
    if (token) {
      const rejected = await new Promise<number>(resolve => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { origin: 'https://evil.example', ...AUTH } })
        ws.on('unexpected-response', (_request, response) => { resolve(response.statusCode ?? 0); ws.terminate() })
        ws.on('open', () => { resolve(200); ws.terminate() })
        ws.on('error', () => resolve(0))
      })
      equal('跨站 WS 被拒', rejected, 401)
      const unauthed = await new Promise<number>(resolve => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: PROXIED })
        ws.on('unexpected-response', (_request, response) => { resolve(response.statusCode ?? 0); ws.terminate() })
        ws.on('open', () => { resolve(200); ws.terminate() })
        ws.on('error', () => resolve(0))
      })
      equal('代理头无令牌 WS 被拒', unauthed, 401)
    }
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: AUTH })
    const events: any[] = []
    // Attach before awaiting open: the server sends `hello` immediately, and
    // the open callback can fire after that frame has already arrived.
    socket.on('message', raw => {
      try { events.push(JSON.parse(String(raw))) } catch { /* ignore */ }
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws open timeout')), 8000)
      socket.on('open', () => { clearTimeout(timer); resolve() })
      socket.on('error', error => { clearTimeout(timer); reject(error) })
    })
    const waitFor = async (predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> => {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        if (predicate()) return true
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return false
    }
    check('连接后收到 hello', await waitFor(() => events.some(item => item.kind === 'hello')))
    socket.send(JSON.stringify({ kind: 'ping' }))
    check('ping 得到 pong', await waitFor(() => events.some(item => item.kind === 'pong')))
    socket.send('{not json')
    check('非法 JSON 返回 error', await waitFor(() => events.some(item => item.kind === 'error' && item.error === 'invalid JSON')))
    socket.send(JSON.stringify({ kind: 'nope' }))
    check('未知消息类型返回 error', await waitFor(() => events.some(item => item.kind === 'error' && String(item.error).includes('unknown message kind'))))
    const before = events.length
    socket.send(JSON.stringify({ kind: 'chat', text: '用三个字回答', scenario: 'chat' }))
    const streamed = await waitFor(() => events.slice(before).some(item => item.kind === 'event' && item.event?.type === 'assistant.delta'), 60_000)
    check('WS 对话产生流式增量', streamed)
    check('WS 对话产生完成事件', await waitFor(() => events.slice(before).some(item => item.kind === 'event' && item.event?.type === 'assistant.done'), 60_000))
    socket.send(JSON.stringify({ kind: 'chat', text: '写一段很长的说明', scenario: 'chat' }))
    await new Promise(resolve => setTimeout(resolve, 400))
    socket.send(JSON.stringify({ kind: 'cancel' }))
    check('取消后连接仍可用', await new Promise<boolean>(resolve => {
      const id = setTimeout(() => resolve(false), 3000)
      socket.send(JSON.stringify({ kind: 'ping' }))
      const onMessage = (raw: any) => {
        const data = JSON.parse(String(raw))
        if (data.kind === 'pong') { clearTimeout(id); socket.off('message', onMessage); resolve(true) }
      }
      socket.on('message', onMessage)
    }))
    socket.close()

    // ------------------------------------------------------------- browser
    section('浏览器交互（可选）')
    if (process.env.JARVIS_SMOKE_UI === '1') {
      const smoke = spawn(process.execPath, ['--experimental-transform-types', 'scripts/ui-smoke.ts'], {
        cwd: REPO,
        env: { ...process.env, JARVIS_URL: base, JARVIS_SMOKE_WRITE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const output: string[] = []
      const errors: string[] = []
      smoke.stdout?.on('data', chunk => output.push(String(chunk)))
      smoke.stderr?.on('data', chunk => errors.push(String(chunk)))
      const code = await new Promise<number>(resolve => smoke.once('exit', value => resolve(value ?? 1)))
      const detail = code === 0 ? '' : `${output.join('')}\n${errors.join('')}`.replace(/ExperimentalWarning[^\n]*\n?/g, '').slice(-1500)
      check('浏览器冒烟（含主题/外观/优先级/场景/对话）', code === 0, detail)
    } else {
      check('浏览器冒烟已跳过（设 JARVIS_SMOKE_UI=1 并启动 Chrome CDP 后启用）', true, 'skipped')
    }

    // ------------------------------------------------------------ persistence
    section('重启后的持久化')
    const marker = `PERSIST-${Date.now()}`
    const persistedMemory = await post(base, '/api/memory', { content: `重启标记 ${marker}` })
    const persistedReminder = await post(base, '/api/reminders', { text: '重启后仍在的提醒', dueAt: due })
    const persistedProfile = await post(base, '/api/model/profile/add', {
      id: 'persist-test', label: '持久化供应商', kind: 'openai', protocol: 'chat-completions',
      baseUrl: 'https://persist.example.com/v1', model: 'persist-model', apiKey: 'sk-persist-secret',
    })
    await put(base, '/api/tuning', { values: { 'ui.accentHue': 145 } })
    if (bootOwn) {
      await stop(child!)
      child = (await bootInstance(dir, Number(new URL(base).port))).child
      await waitForHealth(base, 60_000)
      const afterRestart = await req(base, '/api/memory')
      check('记忆在重启后仍在', (afterRestart.json?.items ?? []).some((item: any) => item.content?.includes(marker)))
      const remindersAfter = await req(base, '/api/reminders')
      check('提醒在重启后仍在', (remindersAfter.json?.items ?? []).some((item: any) => item.id === persistedReminder.json.reminder.id))
      const modelAfter = await req(base, '/api/model')
      check('供应商在重启后仍在', (modelAfter.json?.settings?.profiles ?? []).some((item: any) => item.id === 'persist-test'))
      excludes('重启后配置仍不泄漏 Key', modelAfter.text, 'sk-persist-secret')
      equal('外观参数在重启后仍在', (await req(base, '/api/tuning')).json?.values?.['ui.accentHue'], 145)
      const sessionsAfter = await req(base, '/api/devices')
      check('设备列表在重启后仍可读', Array.isArray(sessionsAfter.json?.devices))
    } else {
      check('重启持久化（需自有实例）', true, 'skipped')
    }

    // ------------------------------------------------------------ backup
    section('备份与恢复')
    if (bootOwn) {
      const archive = join(dir, 'backup.tar.gz')
      await stop(child!)
      const backup = await runNode(['scripts/backup.ts', archive], { JARVIS_DATA_DIR: dir })
      check('备份脚本成功', backup.code === 0, backup.output.slice(-400))
      check('备份文件已生成', await readFile(archive).then(buffer => buffer.length > 0).catch(() => false))
      await rm(join(dir, 'jarvis.db'), { force: true })
      const restore = await runNode(['scripts/restore.ts', archive, '--yes', '--force'], { JARVIS_DATA_DIR: dir })
      check('恢复脚本成功', restore.code === 0, restore.output.slice(-400))
      child = (await bootInstance(dir, Number(new URL(base).port))).child
      await waitForHealth(base, 60_000)
      const restored = await req(base, '/api/memory')
      check('恢复后记忆回来了', (restored.json?.items ?? []).some((item: any) => item.content?.includes(marker)))
    } else {
      check('备份/恢复（需自有实例）', true, 'skipped')
    }

    // ---------------------------------------------------------------- erase
    section('隐私导出与擦除')
    const exported = await req(base, '/api/privacy/export')
    equal('导出 200', exported.status, 200)
    includes('导出带下载文件名', exported.headers.get('content-disposition') ?? '', 'attachment')
    check('导出包含记忆', JSON.stringify(exported.json).includes(marker))
    equal('错误确认短语 → 400', (await post(base, '/api/privacy/erase', { confirm: 'erase' })).status, 400)
    const erased = await post(base, '/api/privacy/erase', { confirm: 'ERASE ALL' })
    equal('擦除 200', erased.status, 200)
    const memoryAfterErase = await req(base, '/api/memory')
    equal('擦除后记忆为空', (memoryAfterErase.json?.items ?? []).length, 0)
    equal('擦除后提醒为空', ((await req(base, '/api/reminders')).json?.items ?? []).length, 0)
    check('擦除后导出为空', !JSON.stringify((await req(base, '/api/privacy/export')).json).includes(marker))
    check('擦除后设备被清空', ((await req(base, '/api/devices')).json?.devices ?? []).length === 0)
    check('擦除后仍可正常对话', (await post(base, '/api/chat', { text: '擦除后还在吗' })).status === 200)
    equal('擦除报告包含供应商重置', erased.json?.providersReset, true)
    const modelAfterErase = await req(base, '/api/model')
    check('擦除后没有残留任何 API Key', !(modelAfterErase.json?.settings?.profiles ?? []).some((item: any) => item.hasKey || item.apiKey))
    equal('擦除后本机是当前供应商', modelAfterErase.json?.settings?.active, 'local')
    equal('擦除后本地优先', modelAfterErase.json?.settings?.priority?.[0], 'local')

    // ---------------------------------------------------------------- report
    const failed = checks.filter(item => !item.ok)
    console.log(`\n\u001b[1m验收结果：${checks.length - failed.length}/${checks.length} 项通过\u001b[0m`)
    if (failed.length) {
      console.log('\u001b[31m失败项：\u001b[0m')
      for (const item of failed) console.log(`  ✗ ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
    }
    process.exitCode = failed.length ? 1 : 0
  } finally {
    await stop(child as ChildProcess).catch(() => undefined)
    if (bootOwn && dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

main().catch(error => {
  console.error('acceptance:full crashed:', error)
  process.exitCode = 1
})
