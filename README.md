# Jarvis

[![CI](https://github.com/gh503/jarvis/actions/workflows/ci.yml/badge.svg)](https://github.com/gh503/jarvis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个仅在本机运行的个人 Jarvis 原型，使用 DeepSeek Harness 提供对话、会话持久化和人工审批界面。

## 项目状态

当前版本是 `v0.1.0` 前的 Mac MVP。项目通过 [Jarvis Roadmap](https://github.com/users/gh503/projects/6) 跟踪执行，通过 [Milestones](https://github.com/gh503/jarvis/milestones) 管理阶段出口，通过 [Issues](https://github.com/gh503/jarvis/issues) 定义可验收工作。

- [总体架构](docs/plan/architecture.md)
- [开发旅程与里程碑](docs/plan/00-development-journey.md)
- [完整阶段计划](docs/plan/README.md)
- [备份与恢复](docs/operations/backup-restore.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 当前能力

- 在 Harness Web UI 中进行文字对话。
- 读取当前 Mac 的系统、内存、负载和运行时长。
- 创建、查看、完成和删除本地提醒。
- 经人工批准后打开白名单内的 macOS 应用。
- 应用审批绑定规范化命令摘要，60 秒过期且每个调用只能消费一次。
- 记录追加式操作审计，提醒和审计文件权限为 `0600`。
- 默认只监听 `127.0.0.1`，并关闭 Harness 遥测。
- 单调拒绝非 Jarvis 工具，模型不能绕过策略调用终端或文件工具。
- 已实现节点命令安全核心：节点绑定、能力版本、本地暂停、应用白名单、过期检查和幂等执行。
- 已实现版本化 Mac 能力注册协议；未知能力、版本变更和异常注册字段会被拒绝。
- 已实现仅主动发起的 `wss://` 节点 Agent 原型；认证、注册、断线重连、命令去重和 Keychain 凭据读取已覆盖。
- 已实现 macOS Keychain 凭据存储层；写入通过 `security` 标准输入完成，凭据不进入命令参数、普通文件或日志。
- Ed25519 设备私钥同样只保存在 macOS Keychain；读取时会验证公私钥匹配和指纹，已有身份不会被静默覆盖。
- Node Agent 支持异步凭据提供器；每次启动读取当前凭据，停止时清除内存副本。
- 已实现配对协议核心及 Gateway API：Ed25519 设备身份、短期单次验证码、凭据轮换、撤销和原子状态持久化。
- 已实现私网受限的 `v1` Gateway 控制面原型：Owner/Device 认证、配对确认、轮换、撤销、请求 correlation ID、按连接来源和认证身份隔离的有界限流，以及 `/v1/node` WebSocket 的认证、能力注册和在线连接管理；默认 loopback，可启用私网 TLS，但禁止公网绑定。
- Gateway 可由设备凭据签发短期访问会话；refresh 每次轮换，旧 refresh 复用、Owner 登出或设备撤销都会使会话族失效。
- Gateway 通过固定 allowlist bridge 访问 loopback Harness；远程会话 API 只返回归一化的标题和最终用户/助手文本，不透传本机路径、内部事件、tool 或 reasoning 数据。
- Gateway 已提供认证的 `/v1/events` WebSocket：只推送归一化会话事件，支持有界持久化游标重放；重启、游标过期或 Harness 事件中断时明确要求客户端全量刷新。
- 已提供离线一致性备份和原子恢复命令；运行租约阻止在 Harness 或 Gateway 活跃时复制状态，恢复前校验结构、权限和 SHA-256。

## 环境要求

- Apple Silicon 或 Intel Mac
- macOS 13 或更高版本
- Node.js 24
- DeepSeek API Key

## 首次运行

```bash
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY
npm install
npm run verify
npm run verify:runtime
npm start
```

浏览器打开 [http://127.0.0.1:3080](http://127.0.0.1:3080)。健康检查地址为 [http://127.0.0.1:3080/jarvis/health](http://127.0.0.1:3080/jarvis/health)。

首次进入需要接受 Harness 内测声明，并选择本项目目录作为工作区。也可以在“设置 -> 模型”中配置 DeepSeek Key；使用 `.env` 更适合后台启动。

可以尝试：

- `查看这台 Mac 当前状态`
- `提醒我 2030-01-01T09:00:00+08:00 检查计划`
- `列出我的提醒`
- `打开 Notes`

应用启动会停在 Harness 的审批界面，只有点击允许后才执行。白名单位于 `config/apps.json`，修改后需要重启。

## 后台启动

Gateway 原型单独启动，必须通过环境变量提供 Owner Token：

```bash
JARVIS_OWNER_TOKEN='use-a-local-secret-of-at-least-16-characters' npm run start:gateway
```

默认模式只监听 `127.0.0.1:3090`，并只连接 `http://127.0.0.1:3080` 的 Harness。可用 `JARVIS_HARNESS_URL` 指向其他 `127.0.0.1` 端口，`JARVIS_HARNESS_TIMEOUT_MS` 默认 10000；非 loopback Harness 地址会在启动前被拒绝。配对状态原子写入未纳入 Git 的 `data/pairing-state.json`。节点和客户端 WebSocket 分别只接受 `/v1/node` 与 `/v1/events`，并各自限制消息大小、握手时间和连接数。

短期 Session token 可访问 `GET/POST /v1/conversations`、`GET /v1/conversations/:id`、`POST /v1/conversations/:id/messages` 和 `POST /v1/conversations/:id/cancel`。消息只接受最多 16 KiB 的纯文本；远程 slash command 被拒绝。`/v1/events` 不在 URL 携带令牌，第一条消息必须是 `events.authenticate`；同源浏览器或无 Origin 的受信客户端可连接。客户端保存每个事件的 `cursor`，重连时提交该游标；若缓冲已淘汰、Gateway 重启或上游连续性丢失，`events.ready`/`sync.required` 会要求先重新读取会话快照。

Gateway 默认允许每个连接来源突发 60 次请求并每秒恢复 1 次额度；每个已认证 Owner、设备或 Session 可突发 120 次并每秒恢复 2 次额度。它只使用直接连接地址，不信任客户端提供的转发来源头；HTTP `429` 会返回 `Retry-After`、限额余量和 correlation ID。

Gateway 也支持绑定到明确的 RFC 1918、Tailscale CGNAT 或 IPv6 ULA 地址。非 loopback 模式强制 HTTPS/WSS，拒绝公网地址、主机名和通配地址；TLS 私钥文件权限必须为 `0600` 或更严格：

```bash
JARVIS_OWNER_TOKEN='use-a-local-secret-of-at-least-16-characters' \
JARVIS_GATEWAY_HOST='100.64.0.10' \
JARVIS_GATEWAY_TLS_KEY='/private/path/gateway-key.pem' \
JARVIS_GATEWAY_TLS_CERT='/private/path/gateway-certificate-chain.pem' \
npm run start:gateway
```

证书必须由连接设备信任并覆盖客户端使用的 Gateway 名称。该配置不会安装或管理 Tailscale，也不能直接暴露到互联网；完整手机体验仍需 PWA、私网接入和设备端验收。

Gateway 运行后，可以在另一个终端为当前 Mac 创建身份并完成人工验证码确认：

```bash
JARVIS_OWNER_TOKEN='the-same-local-owner-token' npm run pair:node -- \
  --node-id my-mac \
  --display-name 'My Mac'
```

命令只连接 loopback Gateway。设备私钥和确认后签发的访问凭据分别写入 macOS Keychain，不会显示或写入项目文件；如果凭据保存失败，流程会立即撤销刚签发的服务端身份。

确认前台运行正常后执行：

```bash
./scripts/install-launch-agent.sh
```

卸载后台服务但保留数据：

```bash
./scripts/uninstall-launch-agent.sh
```

## 备份与恢复

备份和恢复必须在 Harness 与 Gateway 都停止后执行；命令会检查运行租约并拒绝在线操作：

```bash
npm run backup -- --output backups/jarvis-backup.jarvis
npm run restore -- --archive backups/jarvis-backup.jarvis
```

归档包含 Harness 会话、工作区映射、提醒、审计和已有 Gateway 状态，文件权限为 `0600`。它不包含 `.env`、Harness 模型凭据、Keychain 项、Owner Token 或 TLS 私钥。当前归档未加密，应只保存在受保护磁盘；完整停止、验证和跨机器恢复步骤见[备份与恢复指南](docs/operations/backup-restore.md)。

## 数据与安全

- Harness 会话：`.dsh/sessions/`
- Jarvis 提醒：`data/reminders.json`
- Jarvis 审计：`data/audit.jsonl`
- Gateway 配对、访问会话和有界归一化事件：`data/pairing-state.json`、`data/session-state.json`、`data/event-state.json`
- API Key：存放在未纳入 Git 的 `.env` 或 Harness 本机凭据存储，均不进入备份归档
- 网络：Harness 始终只限本机回环；Gateway 仅可绑定明确的回环、私网或 overlay IP，非回环强制 TLS，禁止直接暴露到互联网

这是单用户文字版 MVP，尚不包含手机 UI、语音、智能家居、任意终端、文件操作和消息发送。Gateway 已提供认证、设备身份、受控会话 API 和可恢复的实时事件；客户端不得直接暴露或调用 Harness Web 服务。

## 上游边界

项目不分叉 DeepSeek Harness，依赖精确锁定到 `@deepseek-ai/dsh@0.1.0-rc.6`。Harness 仍是预发布项目，升级时必须重新执行类型检查、测试、启动、审批和持久化验证。

项目采用 [MIT License](LICENSE)。
