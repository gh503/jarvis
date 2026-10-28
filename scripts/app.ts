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
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { loadConfig } from '../src/config.ts'
import { acquireLifecycleLock, canonicalDataDir, launcherUrl, requestRuntime } from '../src/runtime-lifecycle.ts'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const flag = (name: string): boolean => args.includes(`--${name}`)
const value = (name: string): string | undefined => {
  const hit = args.find(item => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

let url: string
let dataDir: string

async function stopServer(): Promise<void> {
  const status = await requestRuntime(dataDir, 'shutdown')
  if (!status) {
    // The runtime lock is authoritative even if metadata is stale or unavailable.
    const release = await acquireLifecycleLock(dataDir, 'runtime')
    release()
    console.log('Jarvis 没有运行。')
    return
  }
  if (status.state !== 'stopping') throw new Error('Jarvis is still initializing; retry shutdown when ready')
  const release = await acquireLifecycleLock(dataDir, 'runtime', 45_000)
  release()
  console.log('Jarvis 已安全停止。')
}

async function ensureServer(): Promise<void> {
  let status = await requestRuntime(dataDir)
  let startupError: Error | undefined
  if (!status) {
    // Never launch over an unresponsive owner or trust a stale app.pid file.
    const release = await acquireLifecycleLock(dataDir, 'runtime')
    release()
    const log = openSync(join(dataDir, 'launcher.log'), 'a', 0o600)
    try {
      const child = spawn(process.execPath, ['--experimental-transform-types', '--enable-source-maps', join(root, 'src', 'main.ts')], {
        // Preserve relative env configuration resolution, including paths containing spaces.
        cwd: process.cwd(), detached: true, stdio: ['ignore', log, log],
        env: { ...process.env, JARVIS_APP: '1', JARVIS_DATA_DIR: dataDir },
      })
      child.once('error', error => { startupError = error })
      child.once('exit', code => { startupError = new Error(`Jarvis exited before readiness (code ${code}); see ${join(dataDir, 'launcher.log')}`) })
      child.unref()
    } finally { closeSync(log) }
  }
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    status = await requestRuntime(dataDir)
    if (status?.state === 'ready') {
      if (!status.url || !/^https?:\/\//.test(status.url)) throw new Error('Runtime returned an invalid browser URL')
      url = status.url
      return
    }
    if (startupError) throw startupError
    if (status?.state === 'stopping') throw new Error('Jarvis is stopping; retry after shutdown finishes')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Jarvis startup timed out; see ${join(dataDir, 'launcher.log')}`)
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
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const child = spawn(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url], { stdio: 'ignore', detached: true })
  child.on('error', error => { console.error(`Unable to open browser: ${error.message}. Open ${url}`); process.exitCode = 1 })
  child.unref()
}

async function main(): Promise<void> {
  const config = loadConfig()
  dataDir = canonicalDataDir(config.dataDir)
  url = launcherUrl(config)
  const release = await acquireLifecycleLock(dataDir, 'launcher', 50_000)
  try {
    if (flag('stop')) { await stopServer(); return }
    await ensureServer()
  } finally { release() }

  if (flag('no-open')) {
    console.log(`服务地址：${url}`)
    return
  }

  {
    const browser = findBrowser()
    if (!browser) {
      console.log('没有找到 Chrome/Edge/Chromium，改用默认浏览器打开。')
      openFallback()
      return
    }
    // A dedicated profile keeps the app window independent from the user's
    // normal browser session (no stray tabs, own icon, own window size).
    const profile = join(dataDir, 'app-profile')
    mkdirSync(profile, { recursive: true })
    const child = spawn(browser.path, [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      '--window-size=1280,860',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
    ], { stdio: 'ignore', detached: true })
    child.on('error', error => { console.error(`Unable to open browser: ${error.message}. Open ${url}`); process.exitCode = 1 })
    child.unref()
    console.log(`已用 ${browser.label} 打开 Jarvis。关掉窗口后服务仍在后台；要停止请运行 npm run app -- --stop。`)
  }
}

void main().catch(error => { console.error(String(error)); process.exitCode = 1 })
