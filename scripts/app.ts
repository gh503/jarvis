#!/usr/bin/env node
/**
 * `npm run app` — start Jarvis if needed and open it like a desktop app.
 *
 * Uses the Chromium `--app=` window mode, which gives a frameless window with
 * no address bar or tabs. That is the same thing the "install as app" button
 * produces, but works on the first run without any installer, code signing or
 * extra dependency. Falls back to the default browser when no Chromium-family
 * browser is installed.
 *
 * Flags:
 *   --no-open     only make sure the server is running
 *   --stop        stop a server that was started in the background
 *   --browser=X   force a browser binary
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const flag = (name: string): boolean => args.includes(`--${name}`)
const value = (name: string): string | undefined => {
  const hit = args.find(item => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

const port = Number(process.env.JARVIS_PORT ?? 3081)
const url = `http://127.0.0.1:${port}/`
const pidFile = join(process.env.JARVIS_DATA_DIR ?? join(homedir(), '.local', 'share', 'jarvis', 'data'), 'app.pid')

async function alive(): Promise<boolean> {
  try {
    const response = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForHealth(timeoutMs = 45_000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await alive()) return true
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

function stopServer(): void {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGTERM')
        console.log(`已停止后台 Jarvis（pid ${pid}）`)
      } catch {
        console.log('后台进程已经不在了')
      }
    }
    rmSync(pidFile, { force: true })
    return
  }
  console.log('没有找到通过 npm run app 启动的后台进程；如果用的是 systemd，请用 systemctl --user stop jarvis')
}

function startServer(): boolean {
  mkdirSync(dirname(pidFile), { recursive: true })
  const child = spawn(process.execPath, ['--experimental-transform-types', '--enable-source-maps', join(root, 'src', 'main.ts')], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, JARVIS_APP: '1' },
  })
  child.unref()
  if (child.pid) {
    try { writeFileSync(pidFile, String(child.pid), { mode: 0o600 }) } catch { /* best effort */ }
  }
  console.log(`正在启动 Jarvis（进程 ${child.pid}，日志在数据目录的 jarvis.log）…`)
  return true
}

interface Candidate { label: string; paths: string[] }

function candidates(): Candidate[] {
  const forced = value('browser') ?? process.env.JARVIS_APP_BROWSER
  if (forced) return [{ label: forced, paths: [forced] }]
  if (process.platform === 'darwin') {
    return [
      { label: 'Google Chrome', paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
      { label: 'Chromium', paths: ['/Applications/Chromium.app/Contents/MacOS/Chromium'] },
      { label: 'Microsoft Edge', paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] },
      { label: 'Brave', paths: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'] },
      { label: 'Vivaldi', paths: ['/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'] },
    ]
  }
  if (process.platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] ?? 'C:\\Program Files'
    const localAppData = process.env['LOCALAPPDATA'] ?? ''
    const roots = [programFiles, process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', localAppData].filter(Boolean)
    const relative = [
      ['Google Chrome', 'Google\\Chrome\\Application\\chrome.exe'],
      ['Microsoft Edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
      ['Brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      ['Vivaldi', 'Vivaldi\\Application\\vivaldi.exe'],
    ]
    return relative.map(([label, path]) => ({ label, paths: roots.map(base => join(base, path)) }))
  }
  return [
    { label: 'Google Chrome', paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/snap/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'] },
    { label: 'Microsoft Edge', paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'] },
    { label: 'Brave', paths: ['/usr/bin/brave-browser', '/usr/bin/brave'] },
    { label: 'Vivaldi', paths: ['/usr/bin/vivaldi'] },
  ]
}

function findBrowser(): { label: string; path: string } | null {
  for (const candidate of candidates()) {
    for (const path of candidate.paths) {
      if (existsSync(path)) return { label: candidate.label, path }
    }
  }
  return null
}

function openFallback(): void {
  if (process.platform === 'darwin') { spawn('open', [url], { stdio: 'ignore', detached: true }).unref(); return }
  if (process.platform === 'win32') { spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref(); return }
  spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
}

async function main(): Promise<void> {
  if (flag('stop')) { stopServer(); return }

  if (!(await alive())) {
    startServer()
  } else {
    console.log('Jarvis 已经在运行。')
  }

  if (flag('no-open')) {
    console.log(`服务地址：${url}`)
    return
  }

  await waitForHealth().then(ready => {
    if (!ready) {
      console.error('启动超时。看看日志，或者手动运行 npm start。')
      process.exitCode = 1
      return
    }
    const browser = findBrowser()
    if (!browser) {
      console.log('没有找到 Chrome/Edge/Chromium，改用默认浏览器打开。')
      openFallback()
      return
    }
    // A dedicated profile keeps the app window independent from the user's
    // normal browser session (no stray tabs, own icon, own window size).
    const profile = join(dirname(pidFile), 'app-profile')
    mkdirSync(profile, { recursive: true })
    const child = spawn(browser.path, [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      '--window-size=1280,860',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
    ], { stdio: 'ignore', detached: true })
    child.unref()
    console.log(`已用 ${browser.label} 打开 Jarvis。关掉窗口后服务仍在后台；要停止请运行 npm run app -- --stop。`)
  })
}

void main()
