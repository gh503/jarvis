/* 安装引导：识别设备并给出对应的“添加到主屏幕 / 安装应用”步骤。 */

const $ = selector => document.querySelector(selector)
const $$ = selector => [...document.querySelectorAll(selector)]

const ua = navigator.userAgent
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isAndroid = /Android/i.test(ua)
const isSafari = /^((?!chrome|android|crios|edg|fxios).)*safari/i.test(ua)
const isEdge = /Edg\//.test(ua)
const isChrome = /Chrome\//.test(ua) && !isEdge && !/OPR\//.test(ua)
const isFirefox = /Firefox\//.test(ua)
const isMac = /Macintosh/.test(ua)
const isWindows = /Windows/.test(ua)
const isLinux = /Linux/.test(ua) && !isAndroid

const STEPS = {
  ios: {
    title: 'iPhone / iPad',
    steps: [
      '用 Safari 打开这个页面（Chrome 也行，但“添加到主屏幕”在 Safari 最稳）。',
      '点底部中间的“分享”按钮（方框 + 向上箭头）。',
      '下滑找到“添加到主屏幕”，起个名字，点“添加”。',
      '以后从主屏幕图标打开，就是全屏 App，没有地址栏。',
    ],
    note: 'iOS 的“添加到主屏幕”不会像 Android 那样在后台同步：Jarvis 需要电脑开机并运行。',
  },
  android: {
    title: 'Android 手机 / 平板',
    steps: [
      '用 Chrome 打开这个页面。',
      '点右上角“⋮”→ 选择“安装应用”或“添加到主屏幕”。',
      '确认后主屏幕会出现 Jarvis 图标。',
      '如果没看到“安装”，说明浏览器不认为它可以安装：确认地址是 http:// 且同一网络可访问。',
    ],
    note: 'Android 上也可以把它当普通网页用，功能一样。',
  },
  mac: {
    title: 'macOS',
    steps: [
      'Safari 26+：菜单栏“文件 → 添加到程序坞”。',
      'Chrome / Edge：地址栏右侧的安装图标（显示器 + 箭头），或菜单“投放、保存和分享 → 安装 Jarvis”。',
      '装好后从“启动台 / 应用程序”打开，独立窗口运行。',
      '想让它开机就在：系统设置 → 通用 → 登录项，把 Jarvis 加进去（或运行 npm run app 的启动器）。',
    ],
    note: '屏幕捕获与摄像头目前仅 Linux 支持；macOS 上用文字对话、记忆、提醒、远端模型都正常。',
  },
  windows: {
    title: 'Windows',
    steps: [
      '用 Chrome 或 Edge 打开这个页面。',
      '点地址栏右侧的安装图标，或菜单“应用 → 将此站点作为应用安装”。',
      '安装后开始菜单里会有 Jarvis，可固定到任务栏。',
      '想开机自启：把快捷方式放进 shell:startup（Win+R 输入 shell:startup）。',
    ],
    note: '屏幕捕获与摄像头目前仅 Linux 支持；Windows 上其余功能正常。',
  },
  linux: {
    title: 'Linux',
    steps: [
      'Chrome / Chromium / Edge：地址栏右侧安装图标 → “安装”。',
      'GNOME 下也可以在浏览器菜单“应用 → 安装为 Web 应用”。',
      '想常驻后台：bash scripts/install-service.sh（systemd 用户服务，登录即启动）。',
      '桌面窗口：npm run app，会用已装的 Chromium 内核浏览器开一个无地址栏窗口。',
    ],
    note: 'Linux 是功能最全的平台：屏幕捕获、摄像头、本地语音都可用。',
  },
  other: {
    title: '这台设备',
    steps: [
      '用 Chrome / Edge / Safari 打开这个页面。',
      '在浏览器菜单里找“安装应用 / 添加到主屏幕”。',
      '没有安装入口也不影响使用，功能和装成 App 完全一样。',
    ],
    note: '',
  },
}

function currentDevice() {
  if (isIOS) return 'ios'
  if (isAndroid) return 'android'
  if (isMac) return 'mac'
  if (isWindows) return 'windows'
  if (isLinux) return 'linux'
  return 'other'
}

function detectText() {
  const parts = []
  parts.push(currentDevice() === 'ios' ? 'iPhone / iPad' : currentDevice() === 'android' ? 'Android' : isMac ? 'macOS' : isWindows ? 'Windows' : isLinux ? 'Linux' : '未知系统')
  if (isEdge) parts.push('Edge')
  else if (isChrome) parts.push('Chrome')
  else if (isSafari) parts.push('Safari')
  else if (isFirefox) parts.push('Firefox')
  else parts.push('浏览器')
  return `检测到：${parts.join(' · ')}。当前地址 ${location.origin}`
}

function renderSteps() {
  const device = currentDevice()
  const data = STEPS[device]
  const host = $('#install-steps')
  host.innerHTML = `<article>
    <h3>${data.title}</h3>
    <ol style="margin:0;padding-left:20px;color:var(--muted);font-size:12.5px;line-height:1.85">
      ${data.steps.map(step => `<li>${step}</li>`).join('')}
    </ol>
    ${data.note ? `<p style="margin:10px 0 0;font-size:11.5px;color:var(--faint);line-height:1.7">${data.note}</p>` : ''}
  </article>`
  // 把其它平台折叠成一句提示，避免信息过载
  const others = Object.entries(STEPS).filter(([key]) => key !== device && key !== 'other')
  host.insertAdjacentHTML('beforeend', `<article>
    <h3>换台设备？</h3>
    <p>同一套 Jarvis 可以在多台设备上用：${others.map(([, value]) => value.title).join('、')} 都支持“安装 / 添加到主屏幕”。</p>
    <p style="margin-top:8px">手机第一次打开会要求配对，电脑上生成六位配对码即可。</p>
  </article>`)
}

let deferredPrompt = null

function bindInstallButton() {
  const button = $('#install-now')
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    deferredPrompt = event
    button.hidden = false
  })
  window.addEventListener('appinstalled', () => {
    button.hidden = true
    $('#install-detect').textContent = '已安装。可以从桌面图标打开了。'
  })
  button.addEventListener('click', async () => {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    const choice = await deferredPrompt.userChoice.catch(() => null)
    deferredPrompt = null
    button.hidden = true
    $('#install-detect').textContent = choice?.outcome === 'accepted' ? '安装完成，去桌面找 Jarvis。' : '已取消安装，随时可以再点。'
  })
  if (window.matchMedia('(display-mode: standalone)').matches) {
    button.hidden = true
    $('#install-detect').textContent = '当前已经是独立 App 模式在运行。'
  }
}

function bindCopy() {
  const button = $('#install-copy')
  button.addEventListener('click', async () => {
    const original = button.textContent
    try {
      await navigator.clipboard.writeText(location.origin)
      button.textContent = '已复制'
    } catch {
      button.textContent = location.origin
    }
    setTimeout(() => { button.textContent = original }, 1600)
  })
}

async function boot() {
  $('#install-detect').textContent = detectText()
  renderSteps()
  bindInstallButton()
  bindCopy()
  try {
    const response = await fetch('/api/health')
    if (!response.ok) return
    const data = await response.json()
    const caps = data.platform
    if (!caps) return
    const missing = []
    if (!caps.screenCapture) missing.push('屏幕捕获')
    if (!caps.camera) missing.push('摄像头')
    if (!caps.localAsr) missing.push('本地语音识别')
    if (!caps.localTts) missing.push('本地语音合成')
    $('#install-platform-note').textContent = missing.length
      ? `当前这台 ${caps.label} 上不可用：${missing.join('、')}（缺依赖或平台限制），设置页里会标出来。`
      : `当前这台 ${caps.label} 支持全部功能。`
  } catch {
    /* 健康检查失败不影响安装引导 */
  }
}

void boot()
