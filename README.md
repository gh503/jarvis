# Jarvis

[![CI](https://github.com/gh503/jarvis/actions/workflows/ci.yml/badge.svg)](https://github.com/gh503/jarvis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个仅在本机运行的个人 Jarvis 原型，使用 DeepSeek Harness 提供对话、会话持久化和人工审批界面。

## 项目状态

当前版本是 `v0.1.0` Mac MVP。项目通过 [Jarvis Roadmap](https://github.com/users/gh503/projects/6) 跟踪执行，通过 [Milestones](https://github.com/gh503/jarvis/milestones) 管理阶段出口，通过 [Issues](https://github.com/gh503/jarvis/issues) 定义可验收工作。

- [总体架构](docs/plan/architecture.md)
- [开发旅程与里程碑](docs/plan/00-development-journey.md)
- [完整阶段计划](docs/plan/README.md)
- [备份与恢复](docs/operations/backup-restore.md)
- [私网恢复与 Gateway 诊断](docs/operations/private-network-recovery.md)
- [v0.1.0 发布说明](docs/releases/v0.1.0.md)
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
- Gateway 已从 `/app/` 提供响应式 PWA 外壳、安装清单和离线应用缓存；未配对时只显示真实连接状态，不缓存或伪装账户数据。真机安装仍待指定首台 iPhone 或 Android 后验收。
- Gateway 已通过 Harness 的公开审批传输提供移动审批收件箱；只有带完整 `tool/call`、`approval/asked` 和 `approval/requested` 证据的 `jarvis_open_app` 可在 60 秒内远程允许一次，其他请求只能拒绝或取消本轮。
- 配对后的 PWA 可读取 Gateway 认可的当前设备与会话状态，并可在设置中撤销自身设备凭据；撤销会关闭该设备全部会话与实时连接，并清除浏览器中的身份、令牌、对话快照和事件游标。
- 配对后的 PWA 提供隐私优先的应用内通知中心；审批、对话完成和连接事件只生成固定摘要，支持分类开关、静默时段、每小时系统通知上限、已读/清空和显式系统通知授权。
- 已提供离线一致性备份和原子恢复命令；运行租约阻止在 Harness 或 Gateway 活跃时复制状态，恢复前校验结构、权限和 SHA-256。
- 已提供用户可控记忆的私有存储核心：候选默认仅为提议，确认、拒绝、编辑继承、到期、导出和物理删除均使用严格版本化状态；尚未接入模型自动提取、提示词召回或管理 UI。
- 已实现智能设备注册核心：规范化设备、位置、能力、风险、别名、稳定外部身份映射和带时间戳状态；真实设备验收仍未完成。
- 已实现只读 Home Assistant WebSocket 协议核心及可选 Gateway 运行时装配：认证、确定性实体快照、状态事件过滤、删除实体降级、断线重连和全量重同步；真实 Home Assistant 地址、凭据、服务行为和硬件验收仍未完成。
- 已实现低风险 Home Assistant 服务调用对账核心：灯、开关和普通媒体使用幂等键，服务确认与实际状态分离；只有后续目标状态被观察到才报告成功，中高风险动作和真实硬件验收仍需后续阶段。
- 已实现智能家居高风险审批策略核心：锁和警报保持强制高风险，审批绑定精确命令摘要并只能消费一次；PWA 审批工作区、实时事件传输和带授权的 Home Assistant 锁/警报服务调用核心已接入，真实部署和硬件验收仍未完成。
- Gateway 已提供独立的 `/v1/device-approvals` 会话接口，用于读取和幂等处理归一化的锁/警报审批记录；PWA 已展示该审批工作区，并通过 `/v1/events` 接收脱敏的 `device.approval.pending` / `device.approval.resolved` 事件。真实设备执行和物理验收仍未完成。
- 已提供可选的 MQTT 5 设备适配器和 Gateway 低风险命令通道；默认不连接 Broker，真实 Broker、设备凭据和物理设备验收仍需单独配置与验证。
- PWA 已提供默认关闭的浏览器按住说话输入、由用户逐条触发的助手消息朗读，以及运行中回复的显式停止入口；实时转写只保留在页面内存，最终文本进入可编辑草稿且不会自动发送，新的按住说话会停止当前朗读并通过 Gateway 请求取消 Harness 当前轮次。浏览器或系统语音服务可能依赖网络，取消接收不代表供应商即时停止；Mac 与手机真机验收和 Jarvis 自有流式 ASR/TTS 仍未完成。

## 环境要求

- Apple Silicon 或 Intel Mac
- macOS 13 或更高版本
- Node.js 24
- DeepSeek API Key

## 首次运行

```bash
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY
npm ci
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

如需启用 Harness 的 `jarvis_device_control` 工具，必须为 Gateway 和 Harness 进程设置同一个、独立于 Owner Token 的本地令牌：

```bash
export JARVIS_DEVICE_COMMAND_TOKEN='use-a-separate-local-secret-of-at-least-16-characters'
export JARVIS_DEVICE_GATEWAY_URL='http://127.0.0.1:3090'
JARVIS_OWNER_TOKEN='use-a-local-secret-of-at-least-16-characters' npm run start:gateway
```

Harness 进程会继承这两个变量，并通过 loopback Gateway 的 `POST /v1/device-commands` 创建脱敏审批记录。`JARVIS_DEVICE_GATEWAY_URL` 只能指向 `127.0.0.1` 或 `[::1]`；两个进程必须使用同一个内部令牌。工具结果只表示审批已创建，配对 PWA 仍需批准；未配置 Home Assistant 时不会执行供应商调用。

要在批准后连接 Home Assistant，另外设置 Gateway 进程使用的 WebSocket 地址和访问令牌：

```bash
export JARVIS_HOME_ASSISTANT_URL='wss://home-assistant.example/api/websocket'
export JARVIS_HOME_ASSISTANT_TOKEN='keep-this-local-and-uncommitted'
export JARVIS_HOME_ASSISTANT_COMMAND_TIMEOUT_MS='10000'
```

URL 必须是 `ws://` 或 `wss://`，不能在 URL 中嵌入用户名或密码；地址与令牌必须同时配置。令牌只保存在 Gateway 进程内存中，不会写入审批、事件、审计或响应。未配置 Home Assistant 时仍可创建审批，但批准后不会执行供应商调用；配置后，适配器只有在完成认证、快照和状态订阅后才发送命令，网络确认仍不等于实体状态已改变。

MQTT 设备适配器使用同样的本地环境配置，但不会默认连接任何 Broker：

```bash
export JARVIS_MQTT_URL='mqtts://broker.example:8883'
export JARVIS_MQTT_USERNAME='device-scoped-user'
export JARVIS_MQTT_PASSWORD='keep-this-local-and-uncommitted'
export JARVIS_MQTT_CLIENT_ID='jarvis-mac-mqtt'
export JARVIS_MQTT_DEVICE_ID='constrained-device-1'
```

适配器固定在 `jarvis/v1/devices/{deviceId}/` topic 范围内，命令带有 MQTT message expiry 和 Jarvis 侧过期时间；相同幂等键不会重复发布，设备确认与最终结果分开处理。配置 `JARVIS_DEVICE_COMMAND_TOKEN` 后，Harness 可使用 `jarvis_mqtt_device_control` 提交 `switch.set`、`light.set`、`media.play_pause` 或 `cover.set`；锁和警报仍必须走审批工具。当前仍未声称连接了真实 Broker、定制硬件或完成物理设备验收。

默认模式只监听 `127.0.0.1:3090`，并只连接 `http://127.0.0.1:3080` 的 Harness。可用 `JARVIS_HARNESS_URL` 指向其他 `127.0.0.1` 端口，`JARVIS_HARNESS_TIMEOUT_MS` 默认 10000；非 loopback Harness 地址会在启动前被拒绝。配对状态原子写入未纳入 Git 的 `data/pairing-state.json`。节点和客户端 WebSocket 分别只接受 `/v1/node` 与 `/v1/events`，并各自限制消息大小、握手时间和连接数。

Gateway 启动后可从 `http://127.0.0.1:3090/app/` 打开移动端应用外壳。默认资源目录为项目内 `web/`，部署时可通过 `JARVIS_PWA_ROOT` 指向同一组受审计资源；Gateway 只服务固定清单中的文件，未知 `/app/*` 路径不会访问文件系统。

在 PWA 的“设置”中开始配对，手机会生成同源私有设备身份并显示 6 位确认码。在运行 Gateway 的 Mac 上批准该代码：

```bash
JARVIS_OWNER_TOKEN='the-same-local-owner-token' npm run pair:approve -- --code 123456
```

Owner Token 只提交给 loopback Gateway，不进入手机。Gateway 只持久化一次性领取密钥和设备凭据的 SHA-256 摘要；设备凭据通过领取密钥派生的 AES-256-GCM 密钥加密返回，重复领取返回同一密文。浏览器将不可导出的 P-256 私钥、设备凭据和短期 Session 保存在同源 IndexedDB；离线时只显示本地身份为非当前状态。清除站点数据会移除本地访问材料，但不会替代服务端设备撤销。

短期 Session token 可访问 `GET/POST /v1/conversations`、`GET /v1/conversations/:id`、`POST /v1/conversations/:id/messages`、`POST /v1/conversations/:id/cancel`、`GET /v1/approvals`、`POST /v1/approvals/:id/decision`、`GET /v1/device-approvals`、`POST /v1/device-approvals/:id/decision` 以及 `GET/DELETE /v1/devices/current`。配对后的 PWA 可列出、新建、选择和继续文字对话，处理当前审批和智能设备审批，并查看或撤销当前设备；设备状态响应只含名称、平台、凭据代次、配对时间和会话时限，不含公钥、凭据摘要或任何令牌。消息只接受最多 16 KiB 的纯文本，发送期间会锁定重复提交，远程 slash command 被拒绝。审批决定使用客户端幂等键，Gateway 将上游 `rpcId` 保留在 loopback 桥接层，手机只能提交 `allowed-once` 或 `rejected`；取消本轮沿用会话取消接口并由 Harness 产生 `cancelled`。`/v1/events` 不在 URL 携带令牌，第一条消息必须是 `events.authenticate`；同源浏览器或无 Origin 的受信客户端可连接。客户端保存每个事件的 `cursor`，重连时提交该游标；设备审批的请求和结果也会以不含服务数据或凭据的标准化事件进入 retained stream。若缓冲已淘汰、Gateway 重启或上游连续性丢失，`events.ready`/`sync.required` 会先要求重新读取权威会话与审批快照，刷新失败时不会推进游标。

PWA 只在同源 IndexedDB 保存最近一次规范化对话列表、当前最多 50 条文字消息和事件游标，不缓存审批、API 响应或 Owner Token。Gateway 不可达时，离线壳可只读显示对话快照并明确标记为“旧数据”，审批详情会从页面内存清除；所有新建、发送和审批操作保持禁用，恢复连接并重新验证 Session 后才切回实时状态。

通知中心同样只保存最多 50 条固定摘要，不写入消息正文、审批参数、目标、令牌或 Harness 内部标识。系统通知不会自动请求权限；用户必须在设置中明确允许，静默时段和分类/频率限制只抑制系统弹出，不丢失应用内记录。后台 Web Push 和锁屏内容仍需在指定首台实体手机上完成可行性与隐私验收。

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

默认后台端口是 `3080`。安装时设置 `JARVIS_PORT` 可以固定其他端口，并会写入 LaunchAgent：

```bash
JARVIS_PORT=3182 ./scripts/install-launch-agent.sh
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

归档包含 Harness 会话、工作区映射、提醒、用户记忆、审计和已有 Gateway 状态，文件权限为 `0600`。它不包含 `.env`、Harness 模型凭据、Keychain 项、Owner Token 或 TLS 私钥。当前归档未加密，应只保存在受保护磁盘；完整停止、验证和跨机器恢复步骤见[备份与恢复指南](docs/operations/backup-restore.md)。

## 本机记忆管理

记忆内容从交互提示或标准输入读取，不作为命令参数传入。新记忆先进入 `proposed`，确认后才会出现在 `recall` 结果中：

```bash
printf '%s\n' '偏好使用简体中文' | npm run memory -- propose --class profile
npm run memory -- list --status proposed
npm run memory -- confirm --id <memory-id>
npm run memory -- recall
printf '%s\n' '偏好使用中文回答' | npm run memory -- edit --id <memory-id>
npm run memory -- export --output backups/jarvis-memory.json
npm run memory -- delete --id <memory-id>
```

导出文件以 `0600` 新建且不会覆盖已有路径。该管理入口仅面向本机 Owner。Harness 的只读 `jarvis_memory_recall` 工具可按分类读取已确认、未过期且非敏感的记忆，并返回来源、置信度和确认时间；默认最多 10 条，硬上限 20 条和 16 KiB。该工具不能提议、确认、编辑或删除记忆，敏感记忆不会提交给模型。模型是否调用该工具取决于当前对话，它不是自动提示词注入，也不代表远端模型不会保留已提交的上下文。

## 数据与安全

- Harness 会话：`.dsh/sessions/`
- Jarvis 提醒：`data/reminders.json`
- Jarvis 用户记忆：`data/memory.json`
- Jarvis 审计：`data/audit.jsonl`
- Gateway 配对、访问会话和有界归一化事件：`data/pairing-state.json`、`data/session-state.json`、`data/event-state.json`
- API Key：存放在未纳入 Git 的 `.env` 或 Harness 本机凭据存储，均不进入备份归档
- 网络：Harness 始终只限本机回环；Gateway 仅可绑定明确的回环、私网或 overlay IP，非回环强制 TLS，禁止直接暴露到互联网

这是单用户文字版 MVP；手机端已有可安装的离线应用、Owner 批准的设备配对、短期 Session、文字对话、实时同步、受限审批收件箱和隐私优先通知中心。智能设备目前只有不连接供应商的注册核心，尚未接入 Home Assistant、MQTT 或真实设备；也不包含语音、任意终端、文件操作和第三方消息发送。Gateway 已提供认证、设备身份、受控会话与审批 API 和可恢复的实时事件；客户端不得直接暴露或调用 Harness Web 服务。Gateway 重启后，仍在 Harness 等待但缺少本次进程内完整审计证据的请求会显示为不可远程允许，避免以重新计时或猜测参数恢复授权。

## 上游边界

项目不分叉 DeepSeek Harness，依赖精确锁定到 `@deepseek-ai/dsh@0.1.0-rc.6`。Harness 仍是预发布项目，升级时必须重新执行类型检查、测试、启动、审批和持久化验证。

项目采用 [MIT License](LICENSE)。
