# Jarvis Web UI：布局、外观与实时协议

> 这份文档只描述浏览器端（`web/`）与它和服务之间的契约。服务端边界见
> [security.md](security.md)，观察台见 [observatory.md](observatory.md)。

## 0. 独立页面

| 路径 | 作用 | 是否需要登录 |
|---|---|---|
| `/` | 主应用 | 是（loopback 例外） |
| `/providers` | 模型服务指南：分区筛选、每家的步骤/地址/费用/坑，一键带回设置 | 否（目录是公开信息） |
| `/install` | 按设备给出安装步骤，识别系统与浏览器 | 否 |
| `/pair` | 手机配对 | 否 |

`/providers` 和 `/install` 与主应用共用 `styles.css` 的配色变量和
`theme-boot.js`，所以深浅色一致；两者都列进了 Service Worker 的 shell 缓存。

## 1. 布局

- 顶栏：品牌、连接状态、当前模型/供应商、时钟、主题切换、观察台、专注、设置。
- 左栏（presence）：状态球、状态文案、快捷动作（看屏幕 / 看摄像头 / 记住 / 今日简报）。
- 中间：对话流 + 输入框。输入框左侧是**场景**下拉，右侧是麦克风与发送。
- 右栏：记忆 / 提醒 / 运行 三个标签页（`role=tablist`，带 `aria-controls`）。
- 窄屏（≤960px）：左栏折叠为顶部状态区，右栏移到下方；观察台与设置均为全屏抽屉。

## 2. 设置（5 个标签）

| 标签 | 内容 |
|---|---|
| 模型 | 本地/远端切换、三种协议、模型发现、供应商池、优先级、工作场景、保存 |
| 语音 | ASR/TTS 本地或远端、厂商适配器（OpenAI 兼容 / Gemini / Cloudflare / Edge）、试听 |
| 外观 | 主题色相、预设、动效强度、密度、模糊、粒子、字号（服务端 `ui.*` 调参） |
| 设备 | 配对码、设备列表、撤销、远程访问说明 |
| 系统 | 运行态、诊断、导出、擦除、首次引导重放 |

页签支持左右方向键、Home/End；切走前若有未保存修改会提示。设置弹窗是唯一
`settings-modal`，动作确认使用独立弹层，互不覆盖。

## 3. 外观与主题

- 深色/浅色/跟随系统由顶栏按钮循环切换，存在浏览器 `localStorage['jarvis.theme']`，
  **只影响当前浏览器**；首屏由 `theme-boot.js` 预先设好，避免闪白。
- 主题色、动效、密度、字号属于服务端调参（`PUT /api/tuning`），对所有设备生效，
  写入 `data/tuning.json`。
- 颜色通过两个变量分发：`--accent-h`（色相）与 `--accent-rgb`（通道）。
  改色必须同时更新两者，否则会出现“只有一半界面变色”。
- 遵循 `prefers-reduced-motion`；系统设置优先于界面里的动效强度。

## 4. PWA 与离线

`web/sw.js` 是 network-first 的 shell 缓存，版本号在 `CACHE` 常量（当前
`jarvis-shell-v19`）：

- 只缓存 GET 同源请求；`/api/*`、`/ws`、带 `token` 参数的 URL 一律不缓存。
- 导航请求离线时回退到 `/`；脚本/样式等非导航请求离线返回 503，不会把 HTML 当 JS。
- `install` 时 `skipWaiting()`，`activate` 时清理旧缓存并 `clients.claim()`。
- **改了 `web/` 下任何资源都要同时提升 `CACHE` 版本**，否则旧 shell 会继续生效。

## 5. 浏览器 ↔ 服务端 WebSocket

入口 `ws://<host>:<port>/ws`；同源 Cookie 或 `?token=`（仅 WS 接受查询参数）。

客户端 → 服务端：

```json
{ "kind": "chat", "text": "…", "scenario": "coding" }
{ "kind": "cancel" }
{ "kind": "ping" }
```

服务端 → 客户端：

```json
{ "kind": "hello", "recent": [ ...最近 30 条事件... ] }
{ "kind": "event", "event": { "type": "assistant.delta", "data": { "text": "…" } } }
{ "kind": "pong" }
{ "kind": "error", "error": "…" }
```

关键事件：`assistant.delta`（流式增量）、`assistant.done`（完成，含 turnId）、
`assistant.scenario`（本轮场景）、`model.failover`（自动换供应商）、
`sense.capture`（采集卡片）、`memory.pinned`、`tuning.changed`、`voice.changed`、
`turn.start`、`user.message`、`runtime.ready`、`attention.*`。
`model.failover` 走 WebSocket 广播，**没有 SSE 端点**。

## 6. 键盘

- `Enter` 发送，`Shift+Enter` 换行；输入框聚焦时麦克风按钮可用 `Space` 切换录音。
- `#orb`（状态球）同样可聚焦，`Enter` / `Space` 切换录音。
- `Esc` 关闭最上层弹层（动作确认 → 设置 → 大图预览）。
- 所有弹层都有 Tab 焦点陷阱，关闭后焦点回到打开它的控件；
  观察台打开时主界面 `inert`。
