# 分发与安装：把 Jarvis 变成 App

## 原生便携预览包已发布

当前推荐 [v2.0.52](https://github.com/gh503/jarvis/releases/tag/v2.0.52)，提供 Linux x64、Windows x64、macOS arm64 的未签名便携包，每个平台包含归档、SHA256 与 provenance，共九个资产文件。包内自带 Node 24；源码运行要求 Node.js >=24。

v2.0.52 的三平台[打包与发布运行](https://github.com/gh503/jarvis/actions/runs/41486361114)已成功，九个资产均已发布。发布源码为 `ec015b75fd698b03d50896a8df939dfe24550b64`；独立的[原生 CI](https://github.com/gh503/jarvis/actions/runs/41485954079)三平台任务均成功。自动化检查不代替代表性机器上的桌面交互验收。这不是稳定生产保证、签名安装器或所有平台功能对齐。

| 形态 | 覆盖平台 | 当前入口 |
|---|---|---|
| PWA 客户端 | 桌面浏览器 / Android / iOS | 先启动主机，再安装网页应用 |
| 源码桌面窗口 | Windows / macOS / Linux | Git、Node >=24，`npm ci` 后 `npm run app` |
| Node 24 便携预览包 | 与构建机相同的系统 / CPU | 从 v2.0.52 获取上述三种目标；无需另装 Node |
| 原生桌面集成 | macOS `.app` / Windows 开始菜单 | 包内 `scripts/install-native.ts` 创建入口，仍需浏览器 |

便携包与生成的 macOS wrapper 未签名、未公证；当前不提供已完成签名的 `.msi` / `.dmg` 安装器。首次启动按操作系统的受支持流程批准。

## 获取预览与正式发布门槛

从上述固定版本 Release 下载匹配系统和 CPU 的归档、SHA256 和 provenance，核对 tag 与完整 source SHA，校验归档后解压到独立固定目录。SHA256 用于校验内容，不等于发行者签名。其他构建可在 [GitHub Actions](https://github.com/gh503/jarvis/actions) 的 `Native release artifacts` 成功运行中查找；没有匹配产物时使用 [源码上手步骤](getting-started.md)。

发布开关 `JARVIS_NATIVE_RELEASE_PUBLISH` 已启用，自动附加资产仍要求三平台构建门槛全部通过。手动 dispatch 必须指定已有的稳定发布 tag，且永远只生成 unsigned preview artifacts，不附加 Release 资产；旧 tag 如果缺少所需脚本不能重建。详见 [原生发布流水线](native-release-pipeline.md)。CI 覆盖 hosted runner 的架构，不表示所有 x64/arm64 组合均已实机验证。

面向普通用户的生产分发目标尚未完成：代表性机器上的 Finder / 开始菜单 / 登录启动与浏览器人工验收、签名／公证仍需完成。v2.0.52 已通过原生 helper 提供 macOS / Windows 的 `file_read`、`file_list`、`file_search`；写入、输出工作区操作、产物交付、图片检查与 Shell 仍不提供。只读 Markdown 技能此前已支持三平台。完整功能对齐和事务式更新激活尚未完成。

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
├── runtime/jarvis-scoped-fs  # Windows 为 .exe；编译好的 helper，无需运行时编译器
├── node_modules/     # 全新 npm ci --omit=dev --ignore-scripts 安装的锁定生产依赖
├── src/  web/  scripts/  docs/  # 仅 Git 跟踪的公开文件白名单
├── manifest.json     # 源 SHA/tag、运行时身份、每个其他文件的 SHA256/大小
├── THIRD-PARTY-LICENSES.json
└── package.json  package-lock.json  README.md  LICENSE
```

要点：

- **必须逐系统打包**：使用当前 Node 24 运行时，支持 Linux/macOS/Windows 的 x64/arm64，目标 OS 与架构必须匹配构建机。不能在 Linux 上产出 Windows 包。
- 打包会从锁定源码编译原生 helper，需要 Rust 1.94+ 与本平台构建工具链；编译器不随运行时要求用户安装。打包不启动服务器或浏览器，并检查运行时身份、生产依赖导入和内存 SQLite。无需本地 `node_modules`；必须能访问 npm registry 和精确 Node 版本的官方 LICENSE。
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

macOS / Windows 使用包内 `scripts/install-native.ts --install --autostart`（通过包内 Node 24 执行），创建下次登录启动入口；不是受监督重启的常驻服务。可选 `--install --config ABS` 将入口与登录启动绑定到包外私有配置；启动器也支持 `--config ABS` 启动和停止同一实例。完整平台命令与配置要求见 [原生集成](native-install.md#optional-private-external-configuration)。安装器只创建引用固定包目录的快捷方式／app wrapper，不复制程序、不启动服务；已有集成需先卸载再安装。卸载保留应用数据与包目录。

## 安装与更新边界

解压后从包目录运行 Linux `./jarvis`、macOS `./Jarvis.command` 或 Windows `.\Jarvis.cmd`。macOS / Windows 可通过上述原生安装脚本创建桌面入口。便携包不包含模型，也不保证具备全部语音组件。

**归档内容更正：**历史便携包遗漏了快照、恢复集、诊断命令及部分安装／更新依赖。源码标签和九个附件发布成功不代表这些工具已包含。`94e75fe` 已修复允许列表并随 [v2.0.75](https://github.com/gh503/jarvis/releases/tag/v2.0.75) 三平台九个附件发布；发布验收包含管理模块导入、诊断与启动停止。下载的 Linux 原始发布归档另外通过当前扩展验收，包括三类快照和恢复集创建／验证，整项约 24.2 秒；其中集成快照是 macOS 布局模拟。Windows/macOS 的新增操作验收仍待结果，实际桌面安装、事务式激活和签名保障也不由此证明。受影响旧包不能照搬安装／更新命令，旧包中的遗漏不会自动修复。详见[归档修复证据](native-release-pipeline.md)。

源码更新脚本提供 verify、stage、隔离 health 和 rollback，**不会自动激活、替换快捷方式、停止生产服务或迁移数据库**。rollback 只放弃暂存事务，不是恢复一个已切换的生产版本。手动升级应停止旧服务、保留旧包与备份，在另一个固定目录解压并验证新包，再显式卸载旧集成和安装新集成。健康检查仅证明隔离启动可用，不证明旧数据迁移兼容；详见 [更新暂存与恢复](native-update.md)。

---

完整源码提供离线[数据快照 CLI](native-state-snapshot.md)：停止运行时及所有其他写入者后创建快照，用独立保存的可信清单摘要验证，只恢复到全新目录。它保留数据目录内的原始秘密与 SQLite WAL（排除文档列出的根级协调文件），不包含外部配置、外部路径或安装集成，也不自动激活版本或保证数据库兼容。

完整源码中的私有[配置快照 CLI](native-config-snapshot.md)：保留配置文件的精确原始字节，不修改进程环境；只恢复到全新私有目录，保留原来的 `JARVIS_DATA_DIR`。源配置的父目录与数据目录必须互不包含；已有显式配置绑定可位于数据根目录内，但该布局不支持配置快照。配置与数据快照是分开的操作，不是原子配对备份或完整回滚，不自动激活版本，也不复制外部 TLS 文件、模型或安装集成。

完整源码中的[恢复集 CLI](native-recovery-set.md)，在持续持有停止数据作用域的两把生命周期锁期间，顺序捕获私有配置和数据，并用聚合清单绑定已验证的基线包身份及两个子快照摘要。验证要求原基线包在记录路径保持可用且不变；恢复集不复制基线包或安装集成，不保证数据库／配置跨版本兼容，也没有恢复集恢复或激活命令。创建前仍须停止运行时及所有其他写入者。

v2.0.52 已包含[安装失败时的进程内清理与只读集成清单 API](native-install.md#installation-failure-cleanup-included-in-v2052)。持久化[集成快照 API 与 CLI](native-integration-snapshot.md)已存在于后续源码标签，但历史归档未包含所需文件，**不包含在 v2.0.52 中**；只读清单不会保存快照，已发布能力也不提供持久恢复日志、集成恢复或事务式激活。

## 平台能力矩阵

下表描述 v2.0.52 的能力边界，包含已发布的原生只读文件支持。平台能力由 `src/platform.ts` 探测，`/api/health` 返回，UI 据此禁用按钮并给出原因。

| 能力 | Linux | macOS | Windows | 备注 |
|---|---|---|---|---|
| 对话 / 记忆 / 提醒 / 远端模型 | 可用 | 可用 | 可用 | 核心功能无需 Python |
| 本机模型 | 可用 | 可用 | 可用 | 自行安装 Ollama / LM Studio 等 |
| 浏览器屏幕／摄像头单帧预览 | 可用 | 可用 | 可用 | 需浏览器支持、安全上下文、显式授权；视觉分析 local-only，需本地视觉模型 |
| OS 服务端屏幕捕获 | 可用 | 不提供 | 不提供 | Linux portal helper |
| OS 服务端摄像头单帧 | 可用 | 不提供 | 不提供 | Linux ffmpeg / 视频设备 |
| 外部文件读取 / 列表 / 搜索 | 按范围授权 | 原生 helper + 只读目录授权 | 原生 helper + 只读目录授权 | macOS / Windows 最多显式授权 16 个读取根目录；UTF-8 文本读取最多 1 MiB，过滤秘密路径并拒绝私钥内容 |
| 文件写入 / 输出工作区 / 产物交付 / 图片检查 | 按权限及依赖开启 | 不提供 | 不提供 | 只读目录授权不能开启写入；图片检查还需本地视觉模型 |
| 只读 Markdown 技能 | 显式配置目录 | 原生 helper | 原生 helper | 设置 → 系统配置技能目录；每文件最多 64 KiB，不可信指引，加载不执行代码 |
| Shell | Bubblewrap + 逐次批准 | fail-closed | fail-closed | 默认关闭、无网络 |
| 本地 ASR | 可选 | 可选 | 可选 | 自行安装 Python + faster-whisper，不随 Node 包提供 |
| 本地 TTS | 依赖引擎与音色 | 依赖引擎与音色 | 依赖引擎与音色 | 云端 ASR / TTS 均须配置供应商 |
| 桌面通知 | notify-send | osascript | Jarvis 自有 toast 身份 | Windows 须显式原生安装；可见投递未验证，系统设置与会话可抑制通知 |
| 登录自启 | systemd 用户服务 | 原生脚本 LaunchAgent | 原生脚本 Startup 快捷方式 | 交互登录行为仍需人工验收 |

macOS / Windows 的源码用户如需只读文件工具或只读技能，可选运行 `npm run native:build`，需要 Rust 1.94+ 与本平台构建工具链。便携构建随包携带编译好的 helper，运行它不要求安装编译器；核心对话不依赖此可选构建。读取目录默认未授权，技能目录默认未配置；helper 不可用时这两类能力保持关闭，加载指引不会运行 Shell、Python 或安装软件。

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
