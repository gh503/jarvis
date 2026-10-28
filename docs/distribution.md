# 分发与安装：把 Jarvis 变成 App

## 原生便携预览包已发布

[v2.0.20](https://github.com/gh503/jarvis/releases/tag/v2.0.20) 提供 Linux x64、Windows x64、macOS arm64 的未签名便携包，每个平台包含归档、SHA256 与 provenance，共九个资产文件。包内自带 Node 24；源码运行要求 Node.js >=24。

三平台自动化发布门槛已通过，覆盖运行时生命周期、便携包以及打包后隐私、备份与更新检查，Windows 还验证 Unicode 快捷方式实际启动。这是预览交付与自动化证据，不是稳定生产保证、签名安装器或所有平台功能对齐。

| 形态 | 覆盖平台 | 当前入口 |
|---|---|---|
| PWA 客户端 | 桌面浏览器 / Android / iOS | 先启动主机，再安装网页应用 |
| 源码桌面窗口 | Windows / macOS / Linux | Git、Node >=24，`npm ci` 后 `npm run app` |
| Node 24 便携预览包 | 与构建机相同的系统 / CPU | 从 v2.0.20 获取上述三种目标；无需另装 Node |
| 原生桌面集成 | macOS `.app` / Windows 开始菜单 | 包内 `scripts/install-native.ts` 创建入口，仍需浏览器 |

便携包与生成的 macOS wrapper 未签名、未公证；当前不提供已完成签名的 `.msi` / `.dmg` 安装器。首次启动按操作系统的受支持流程批准。

## 获取预览与正式发布门槛

从上述固定版本 Release 下载匹配系统和 CPU 的归档、SHA256 和 provenance，核对 tag 与完整 source SHA，校验归档后解压到独立固定目录。SHA256 用于校验内容，不等于发行者签名。其他构建可在 [GitHub Actions](https://github.com/gh503/jarvis/actions) 的 `Native release artifacts` 成功运行中查找；没有匹配产物时使用 [源码上手步骤](getting-started.md)。

发布开关 `JARVIS_NATIVE_RELEASE_PUBLISH` 已启用，自动附加资产仍要求三平台构建门槛全部通过。手动 dispatch 必须指定已有的稳定发布 tag，且永远只生成 unsigned preview artifacts，不附加 Release 资产；旧 tag 如果缺少所需脚本不能重建。详见 [原生发布流水线](native-release-pipeline.md)。CI 覆盖 hosted runner 的架构，不表示所有 x64/arm64 组合均已实机验证。

面向普通用户的生产分发目标尚未完成：代表性机器上的 Finder / 开始菜单 / 登录启动与浏览器人工验收、签名／公证仍需完成。跨平台外部文件／技能／Shell、完整功能对齐和事务式更新激活也尚未实现。

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
| 离线外壳 | Service Worker 缓存 shell；对话仍需模型 |
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
- 关掉窗口服务仍在；通过运行时身份与控制通道管理启停，日志在数据目录的 `jarvis.log`。
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

产物：`dist/jarvis-<version>-<os>-<arch>.tar.gz`（Linux/macOS 使用系统 tar；Windows 使用系统 PowerShell Compress-Archive 生成 `.zip`），以及归档的 `.sha256` 校验文件。每次在全新临时目录生成归档，再替换同名旧版本，不保留旧 ZIP 条目。包含：

```
jarvis-<version>-<os>-<arch>/
├── jarvis            # macOS 另有 Jarvis.command；Windows 有 Jarvis.cmd / Jarvis.ps1
├── PORTABLE.txt
├── runtime/node      # Windows 为 node.exe；附完整 Node LICENSE
├── node_modules/     # 全新 npm ci --omit=dev --ignore-scripts 安装的锁定生产依赖
├── src/  web/  scripts/  docs/  # 仅 Git 跟踪的公开文件白名单
├── manifest.json     # 源 SHA/tag、运行时身份、每个其他文件的 SHA256/大小
├── THIRD-PARTY-LICENSES.json
└── package.json  package-lock.json  README.md  LICENSE
```

要点：

- **必须逐系统打包**：使用当前 Node 24 运行时，支持 Linux/macOS/Windows 的 x64/arm64，目标 OS 与架构必须匹配构建机。不能在 Linux 上产出 Windows 包。
- 打包不启动服务器或浏览器，只执行运行时身份、生产依赖导入和内存 SQLite 检查。无需本地 `node_modules`；必须能访问 npm registry 和精确 Node 版本的官方 LICENSE。
- 环境变量 `JARVIS_RELEASE_VERSION` 指定产物版本；`JARVIS_SOURCE_SHA` 必须等于当前 HEAD；`JARVIS_RELEASE_TAG` 必须为 `v<version>` 且已有本地标签指向 HEAD。提供 SHA 或 tag 时要求已跟踪文件无修改，供发布 CI 精确绑定来源。不提供时使用 package 版本、当前 HEAD，并在清单标记 dirty。
- 新增运行时源文件必须先纳入 Git 跟踪。`.env`、私有数据目录、未跟踪文件、符号链接、开发依赖和环境中的 npm 配置不会进入应用包；依赖中的开发用点文件统一移除，避免 Windows 压缩工具遗漏后造成清单不一致。
- 归档仍是**未签名便携包**。签名安装器需要平台工具链、证书与凭据；本命令不声称生成签名安装器。
- 体积以 Node 二进制为主（约 100 MB 量级），解压即用，不写注册表。
- 默认数据目录：Linux `~/.local/share/jarvis/data`；macOS `~/Library/Application Support/Jarvis/data`；Windows `%LOCALAPPDATA%\Jarvis\data`。
- 升级不要覆盖运行中的包。见下面的安装与更新边界。

---

## D. 常驻服务（Linux）

```bash
bash scripts/install-service.sh     # systemd --user，登录即启动
systemctl --user status jarvis
journalctl --user -u jarvis -f
```

macOS / Windows 使用包内 `scripts/install-native.ts --install --autostart`（通过包内 Node 24 执行），创建下次登录启动入口；不是受监督重启的常驻服务。完整平台命令见 [原生集成](native-install.md)。安装器只创建引用固定包目录的快捷方式／app wrapper，不复制程序、不启动服务；已有集成需先卸载再安装。卸载保留应用数据与包目录。

## 安装与更新边界

解压后从包目录运行 Linux `./jarvis`、macOS `./Jarvis.command` 或 Windows `.\Jarvis.cmd`。macOS / Windows 可通过上述原生安装脚本创建桌面入口。便携包不包含模型，也不保证具备全部语音组件。

更新脚本提供 verify、stage、隔离 health 和 rollback，**不会自动激活、替换快捷方式、停止生产服务或迁移数据库**。rollback 只放弃暂存事务，不是恢复一个已切换的生产版本。手动升级应停止旧服务、保留旧包与备份，在另一个固定目录解压并验证新包，再显式卸载旧集成和安装新集成。健康检查仅证明隔离启动可用，不证明旧数据迁移兼容；详见 [更新暂存与恢复](native-update.md)。

---

## 平台能力矩阵

代码里由 `src/platform.ts` 探测，`/api/health` 返回，UI 据此禁用按钮并给出原因。

| 能力 | Linux | macOS | Windows | 备注 |
|---|---|---|---|---|
| 对话 / 记忆 / 提醒 / 远端模型 | 可用 | 可用 | 可用 | 核心功能无需 Python |
| 本机模型 | 可用 | 可用 | 可用 | 自行安装 Ollama / LM Studio 等 |
| 浏览器屏幕／摄像头单帧预览 | 可用 | 可用 | 可用 | 需浏览器支持、安全上下文、显式授权；视觉分析 local-only，需本地视觉模型 |
| OS 服务端屏幕捕获 | 可用 | 不提供 | 不提供 | Linux portal helper |
| OS 服务端摄像头单帧 | 可用 | 不提供 | 不提供 | Linux ffmpeg / 视频设备 |
| 外部授权文件与外部 Markdown 技能 | 按权限开启 | fail-closed | fail-closed | 非 Linux 保持拒绝执行 |
| Shell | Bubblewrap + 逐次批准 | fail-closed | fail-closed | 默认关闭、无网络 |
| 本地 ASR | 可选 | 可选 | 可选 | 自行安装 Python + faster-whisper，不随 Node 包提供 |
| 本地 TTS | 依赖引擎与音色 | 依赖引擎与音色 | 依赖引擎与音色 | 云端 ASR / TTS 均须配置供应商 |
| 桌面通知 | notify-send | 不提供 | 不提供 | 按系统能力启用 |
| 登录自启 | systemd 用户服务 | 原生脚本 LaunchAgent | 原生脚本 Startup 快捷方式 | 交互登录行为仍需人工验收 |

可选的旧版 `npm run setup` 安装脚本仅支持 Linux x64；源码基础对话无需运行它。浏览器单帧入口与服务端系统捕获不同，不代表持续录屏或录像。此表描述实现边界，不等于每个环境和设备都已通过人工验收。

---

## 验收

```bash
npm run typecheck && npm test
JARVIS_SMOKE_UI=1 npm run acceptance:full
npm run package
JARVIS_PACKAGE_ARCHIVE=auto node --experimental-transform-types --test test/packaged-runtime.test.ts
```

Windows PowerShell 使用 `$env:JARVIS_PACKAGE_ARCHIVE='auto'` 设置变量后运行同一个 Node 测试命令。`auto` 选择当前版本/系统/架构归档，也可以提供明确归档路径。此显式验收会验证归档及所有文件校验值，在包含空格和中文的临时路径解压，清空子进程 PATH，仅用包内 Node 和启动器启动隔离数据目录的本地服务，检查健康状态后安全停止。普通 `npm test` 跳过这个需要归档的启动验收。

`acceptance:full` 会检查 `/providers`、`/install`、`/api/providers/catalog`
和 `/api/health` 的平台字段；`ui:smoke` 在真实浏览器里点开供应商指南、
用预填流程走一遍，并检查深浅色对比度与横向溢出。
