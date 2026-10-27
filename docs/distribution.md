# 分发与安装：把 Jarvis 变成 App

三种交付形态，按“用户要做什么”选，而不是按技术栈选：

| 形态 | 覆盖平台 | 用户要做什么 | 需要签名/商店 |
|---|---|---|---|
| **A. PWA 安装**（推荐默认） | Windows / macOS / Linux / Android / iOS | 打开一次网页，点“安装”或“添加到主屏幕” | 不需要 |
| **B. 桌面窗口**（`npm run app`） | 三桌面平台 | 双击一个脚本 / 启动器 | 不需要 |
| **C. 便携包**（`npm run package`） | 同系统之间拷贝 | 解压，双击 `jarvis` / `Jarvis.cmd` | 不需要 |

> 明确不做：`.msi` / `.dmg` / `.AppImage` / 应用商店上架。这些需要各平台签名证书
> 与打包工具链，本仓库无法“顺手”产出可信的安装包；硬做一个未签名安装包只会让
> 用户看到 SmartScreen / Gatekeeper 拦截。便携包 + PWA 覆盖同样的需求，且没有
> 证书依赖。

---

## A. PWA：最省事，且唯一能覆盖手机的方式

`web/manifest.webmanifest` + `web/sw.js` 已经具备安装条件，`/install` 页面会按
设备给出具体步骤。

- **Windows / Linux**：Chrome/Edge 地址栏右侧“安装”图标。
- **macOS**：Safari 26+ “文件 → 添加到程序坞”；Chrome/Edge 同 Windows。
- **Android**：Chrome ⋮ → “安装应用”。
- **iOS**：Safari → 分享 → “添加到主屏幕”。

安装后的行为：

| 能力 | 说明 |
|---|---|
| 独立窗口 | `display: standalone` + `display_override: window-controls-overlay` |
| 离线外壳 | Service Worker 缓存 shell（`jarvis-shell-v20`）；对话仍需模型 |
| 快捷方式 | 长按图标：新对话 / 模型服务 / 安装 |
| 身份 | 同源 Cookie（HttpOnly），或首次 `/?token=` 引导 |

**限制（必须知道）**：iOS/Android 上 Jarvis 是客户端，服务仍跑在你的电脑上。
手机断网、电脑关机，App 就打不开对话——这是本地优先的代价，不是 bug。

---

## B. 桌面窗口：`npm run app`

```bash
npm run app              # 启动服务（如果没跑）+ 打开无地址栏窗口
npm run app -- --no-open # 只启动服务
npm run app -- --stop    # 停掉由它启动的后台进程
npm run app -- --browser=/usr/bin/chromium
```

实现方式：用 Chromium 系浏览器的 `--app=` 模式，独立 `user-data-dir`
（`<数据目录>/app-profile`），所以它和日常浏览器互不干扰，也不需要 Electron。

- 找不到 Chromium 系浏览器时退回默认浏览器打开同一地址。
- 进程以 detached 方式运行，关掉窗口服务仍在；日志在数据目录的 `jarvis.log`。
- macOS/Windows 上同样可用，只要装了 Chrome/Edge。

**为什么不用 Electron/Tauri？** 需要引入构建链与数百 MB 运行时，而 `--app=`
已经得到同样的“无地址栏独立窗口”。如果将来需要托盘、全局热键、自动更新，
再评估 Tauri（Rust）比 Electron 更合适。

---

## C. 便携包：`npm run package`

```bash
npm run package                          # 为当前系统/架构打包
npm run package -- --target=win32        # 会明确拒绝：不能跨系统打包
```

产物：`dist/jarvis-<os>-<arch>.tar.gz`（有 `zip` 命令时用 `.zip`），包含：

```
jarvis-<os>-<arch>/
├── jarvis            # 或 Jarvis.cmd（Windows）
├── 双击这里.txt
├── runtime/node      # 当前系统的 Node 运行时副本
├── node_modules/     # 只有 ws 一个依赖
├── src/  web/  scripts/  docs/
└── package.json  README.md
```

要点：

- **必须逐系统打包**：Node 运行时与目标 OS 绑定，不能在 Linux 上产出 Windows 包。
- 体积以 Node 二进制为主（约 100 MB 量级），解压即用，不写注册表。
- 数据目录默认在用户主目录（`~/.local/share/jarvis`），不污染便携目录，
  所以升级只需替换程序文件。
- 想真正做到“双击安装”，需要平台签名证书；见上面的说明。

---

## D. 常驻服务（Linux）

```bash
bash scripts/install-service.sh     # systemd --user，登录即启动
systemctl --user status jarvis
journalctl --user -u jarvis -f
```

Windows 用“启动”文件夹放快捷方式，macOS 用“登录项”，都能达到同样效果。

---

## 平台能力矩阵

代码里由 `src/platform.ts` 探测，`/api/health` 返回，UI 据此禁用按钮并给出原因。

| 能力 | Linux | macOS | Windows | 备注 |
|---|---|---|---|---|
| 对话 / 记忆 / 提醒 / 文件 | ✅ | ✅ | ✅ | 纯 Node，无平台依赖 |
| 本机模型（Ollama/LM Studio） | ✅ | ✅ | ✅ | 需要用户自己装 |
| 屏幕捕获 | ✅ | ❌ | ❌ | 依赖 xdg-desktop-portal 辅助脚本 |
| 摄像头单帧 | ✅ | ❌ | ❌ | 依赖 `/dev/video0` + ffmpeg |
| 本地 ASR | ✅ | 取决于是否装了 Python + faster-whisper | 同 macOS | 浏览器录音，服务端转写 |
| 本地 TTS | ✅ | 取决于 `piper` / `edge-tts` | 同 macOS | 也可用远端 TTS |
| 桌面通知 | ✅ | ❌ | ❌ | 目前只有 `notify-send` |
| 开机自启 | ✅ | 手动 | 手动 | Linux 用 systemd |

这张表是**实现现状**，不是路线图。加一个平台支持 = 实现对应 helper 并让
`capabilities()` 检测到它；UI 不需要改。

---

## 验收

```bash
npm run typecheck && npm test
JARVIS_SMOKE_UI=1 npm run acceptance:full
```

`acceptance:full` 会检查 `/providers`、`/install`、`/api/providers/catalog`
和 `/api/health` 的平台字段；`ui:smoke` 在真实浏览器里点开供应商指南、
用预填流程走一遍，并检查深浅色对比度与横向溢出。
