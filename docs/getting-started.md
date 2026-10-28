# 上手：从零到第一次对话

Jarvis 是跑在自己电脑上的助手：对话、记忆与提醒保存在本机，模型可以选择本地或远端供应商。先在一台电脑上启动服务，再通过浏览器或 PWA 使用；手机是客户端，不能替代主机。

## 1. 选择启动方式

**原生便携预览包已发布**：[v2.0.20](https://github.com/gh503/jarvis/releases/tag/v2.0.20) 提供 Linux x64、Windows x64、macOS arm64 的未签名包，自带 Node 24。它们是预览交付，不代表签名安装器、稳定生产保证或完整平台功能对齐。其他架构可参考源码方式；CI artifacts 仅在相应构建成功且未过期时可用。

| 你的情况 | 选择 |
|---|---|
| 想试用无需单独安装 Node 的原生包 | 使用下方固定版本预览入口，选择匹配系统与 CPU 的包 |
| 没有可用预览包，或想参与开发 | 安装 Git 和 Node.js >=24，从源码启动 |
| 只有手机或平板 | 连接已运行的主机，按远程访问文档配置后添加 PWA |

三平台自动化发布门槛已通过，覆盖原生生命周期、Node 24 便携包及打包后隐私、备份与更新检查，Windows 还验证了 Unicode 快捷方式实际启动。自动化检查不代替各类机器上的桌面交互验收。剩余生产发行边界见 [分发说明](distribution.md)。

## 2. 启动 Jarvis

### A. 原生便携预览包已发布

1. 打开 [v2.0.20 原生预览下载](https://github.com/gh503/jarvis/releases/tag/v2.0.20)，选择 Linux x64、Windows x64 或 macOS arm64。每个平台提供归档、SHA256 与 provenance 来源信息。需要其他构建时，可在 [GitHub Actions](https://github.com/gh503/jarvis/actions) 查找相符的成功预览产物；没有匹配包则使用源码方式。
2. 下载对应应用归档、SHA256 与来源信息。先核对归档 SHA256，再解压到固定、可写的独立目录。便携包自带 Node 24，不包含本地模型或全部语音组件。
3. 在解压目录运行 Linux 的 `./jarvis`、macOS 的 `./Jarvis.command`，或 Windows PowerShell 的 `.\Jarvis.cmd`。窗口未打开时访问 <http://127.0.0.1:3081/>。
4. macOS `.app` 与 Windows 开始菜单入口可通过包内 `scripts/install-native.ts --install` 创建，必须使用包内 Node 执行；完整命令见 [原生集成说明](native-install.md)。可选 `--autostart` 在下次登录时启动服务。快捷方式引用当前目录，请保持目录位置不变。

预览包和生成的 macOS app wrapper **未签名、未公证**，首次打开可能需要按操作系统提供的流程批准。它们尚不是面向普通用户的可信签名安装器。

### B. 源码启动：三平台基础能力

安装 [Node.js >=24](https://nodejs.org/) 和 [Git](https://git-scm.com/)，在终端或 PowerShell 运行：

```sh
git clone https://github.com/gh503/jarvis.git
cd jarvis
npm ci
npm run app
```

`npm run app` 启动后台服务并尝试打开 Chromium 应用窗口；找不到合适浏览器时使用默认浏览器。也可以 `npm start` 前台运行，再访问 <http://127.0.0.1:3081/>。关闭窗口不会停止后台服务；用 `npm run app -- --stop` 停止它。

基础文字对话不要求 Python、Ollama 或语音组件。`npm run doctor` 可检查环境；Linux x64 用户需要本地模型和感知组件时，可选运行 `npm run setup`，该脚本会下载组件到用户目录，并非跨平台安装步骤。

## 3. 接一个模型

打开 **设置 → 模型**，选择：

- **本地模型**：自行安装 [Ollama](https://ollama.com/download)，例如运行 `ollama pull qwen2.5:3b`，在设置中获取模型列表并保存。模型需要相应内存和存储。
- **远端模型**：打开 <http://127.0.0.1:3081/providers>，选择供应商，按指南填写 API Key 并保存。费用由供应商收取；可配置多个供应商的优先级链。

## 4. 平台能力与可选语音

| 能力 | Linux | macOS / Windows |
|---|---|---|
| 文字对话、记忆、提醒、远端模型 | 可用 | 可用 |
| 本地模型 | 自行安装并配置 | 自行安装并配置 |
| 浏览器屏幕／摄像头单帧预览 | 支持的浏览器中显式授权 | 支持的浏览器中显式授权 |
| 浏览器画面分析 | 需要可用的本地视觉模型，local-only | 同左 |
| 服务端 OS 屏幕／摄像头捕获 | 需要 portal / ffmpeg 等组件 | 不提供 |
| 外部授权文件、外部 Markdown 技能、Shell | 文件按范围授权；Shell 需 Bubblewrap 与逐次批准 | 保持拒绝执行（fail-closed） |
| 登录启动 | systemd 用户服务 | 原生安装脚本的可选登录启动 |

浏览器感知需要浏览器支持、权限及安全上下文；只在你明确操作后获取单帧预览，不表示后台持续采集。它和 Linux 的服务端系统捕获是两个入口。

语音是可选项。浏览器可录音，本地 ASR 还需要 Python 和 faster-whisper；本地 TTS 需要可用引擎与音色。便携包不保证这些依赖已安装。远端 ASR/TTS 必须分别在 **设置 → 语音** 配置供应商；选择远端语音会把相应音频或文字发送给供应商。详见 [语音配置](voice-providers.md)。

## 5. 桌面入口与手机访问

原生包的 `.app`／开始菜单入口会启动本机服务；PWA 是浏览器客户端，两者用途不同。在支持的浏览器中安装 PWA，或在 Safari 选择“添加到程序坞／主屏幕”，具体步骤见应用的 `/install` 页面。

手机访问前，按 [远程访问与 TLS 配置](operations.md) 设置监听地址、主机白名单、至少 24 字符的认证令牌及 TLS，再通过电脑上的 **设置 → 设备** 生成配对码。电脑必须保持在线；普通局域网 HTTP 不足以提供完整的浏览器权限与安全访问条件。

## 6. 第一次用，试这些

- “帮我把这段话改得更正式：……”
- “记住：我周五下午要交季度报告。”（记忆候选需要确认）
- “我上次说周五要干什么？”
- 在支持的浏览器中明确选择屏幕或摄像头，预览单帧，再使用本地视觉模型分析。

## 7. 数据与更新

默认数据目录是 Linux 的 `~/.local/share/jarvis/data`、macOS 的 `~/Library/Application Support/Jarvis/data`、Windows 的 `%LOCALAPPDATA%\Jarvis\data`（可通过 `JARVIS_DATA_DIR` 配置）。远端模型会收到当前对话和符合召回条件的普通记忆，sensitive/secret 不进入常规召回。浏览器单帧视觉分析保持 local-only。

设置中的隐私页面可导出或确认后擦除数据；备份和恢复前应停止服务。更新工具只提供候选包验证、stage、隔离 health 与 rollback；**不会自动激活或替换生产版本**。手动升级须先停止旧服务，保留备份与旧包，将新包解压到另一固定目录，再显式卸载旧集成并安装新集成。隔离健康检查不证明旧数据库迁移兼容，详见 [更新与恢复边界](native-update.md)。

## 8. 卡住了看哪里

| 现象 | 先看 |
|---|---|
| 找不到原生下载 | 打开 v2.0.20 的 Assets；没有匹配系统／CPU 的包时使用源码方式 |
| 页面打不开 | 确认服务启动、端口；源码运行 `npm run doctor` |
| 模型无法对话 | 设置中的模型地址、凭据与供应商状态 |
| 语音或视觉不可用 | 对应依赖、浏览器权限、本地视觉模型或语音供应商是否配置 |
| macOS / Windows 文件或 Shell 不可用 | 当前平台边界，不是补一次目录授权就能开启 |
| 手机无法访问 | 按远程文档核对 TLS、令牌、监听地址与白名单 |
| 需要日志 | 数据目录内的 `jarvis.log` |
