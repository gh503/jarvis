# Jarvis v2 — 运行、隐私与验收

- Status: Implemented baseline (2026-10-26)
- Audience: 这台 Linux 机器的所有者

## 1. 它现在是什么

一个本地优先的私人助手：

- 文字 / 按住说话 → 本地 faster-whisper → 本地 qwen2.5:3b → 本地 Piper 播报。
- “看下屏幕 / 看下这个” → XDG Desktop Portal 按次截屏 → 本地 OCR → 本地模型回答。
- “看看我这边” → 摄像头单帧 → OCR；没有文字时可选视觉模型（较慢）。
- “记住……” → SQLite 确认记忆；“忘掉……” → 检索后删除。
- “提醒我明天 9 点……” → 解析、入库、到点由打扰策略决定是否出声。
- “打开 https://…” / “打开文件管理器” → 只生成一次性待确认动作；点“允许一次”才执行，60 秒过期，执行写审计。
- Web UI 同时有记忆面板、提醒面板、专注模式、停止按钮和实时注意力状态。

默认只监听 `127.0.0.1`。没有云端 API key 也能完整运行。
威胁模型、静态加密范围与残余风险见 [security.md](security.md)。

## 2. 当前机器的安装结果

| 组件 | 位置 / 说明 |
|---|---|
| Node | v24.14.0；使用原生 TypeScript transform，无 build step |
| Ollama | `~/.local/ollama/bin/ollama`，`127.0.0.1:11434` |
| LLM | `qwen2.5:3b`（约 1.9 GB） |
| Embedding | `nomic-embed-text`（274 MB；替换了会挤爆 4 GB 显存的 qwen3-embedding） |
| 视觉 | `qwen2.5vl:3b`（可选；4 GB 显存下很慢，见 §6） |
| ASR | faster-whisper `tiny`，持久 worker，Python 3.10 user site |
| OCR | RapidOCR ONNX，持久 worker，中文/英文 |
| TTS | Piper + `zh_CN-huayan-medium.onnx`，22.05 kHz |
| 数据 | `~/.local/share/jarvis/data/jarvis.db`（SQLite，WAL） |
| 日志 | `~/.local/share/jarvis/data/jarvis.log` |

模型和二进制均在用户目录，不需要 sudo。仓库根目录的 `.env.example` 是配置模板（含 `JARVIS_ALLOWED_HOSTS`、`JARVIS_ALLOW_REMOTE_VISION`、`JARVIS_LOG_LEVEL`）。

## 3. 启动

```bash
cd ~/jarvis
npm start
# http://127.0.0.1:3081
```

首次安装（幂等，慢的是模型下载）：

```bash
cd ~/jarvis
npm run setup
npm run doctor
```

桌面窗口：

```bash
bash scripts/install-desktop.sh          # 应用菜单出现 Jarvis
bash scripts/install-desktop.sh --autostart
```

后台常驻（用户级 systemd，不需要 sudo）：

```bash
bash scripts/install-service.sh
systemctl --user status jarvis.service
journalctl --user -u jarvis -f
```

`install-service.sh` 会写入 `~/.config/systemd/user/jarvis.service`，使用当前
`node` 绝对路径、`UMask=0077`、`NoNewPrivileges`、`ProtectSystem=strict` 和
`ProtectHome=read-only`（只开放数据目录写入）。如果 3081 已被开发进程占用，
安装器只安装不启动，避免两个实例同时写同一个 SQLite。

备份（服务运行时也可以，SQLite 使用 `VACUUM INTO` 生成一致快照）：

```bash
cd ~/jarvis/v2
npm run backup -- ~/jarvis-backup.tar.gz
# 归档含 jarvis.db、tuning.json、manifest.json；不含 auth-token、secret.key、音频、画面、telemetry、日志。
# 需要连模型/语音 Key 一起备份时加 --include-secrets（含 model-config.json、voice-config.json，仍是 0600）
```

恢复（会覆盖本机数据，必须先停服务）：

```bash
systemctl --user stop jarvis.service   # 或停掉开发进程
npm run restore -- ~/jarvis-backup.tar.gz --yes
systemctl --user start jarvis.service
```

恢复前会检查 `PRAGMA integrity_check`，并把当前数据复制到
`~/.local/share/jarvis/data.pre-restore-<时间>`。检测到 `src/main.ts`
仍在运行时会拒绝执行。

Ollama 需要先运行。当前环境用：

```bash
OLLAMA_HOST=127.0.0.1:11434 \
OLLAMA_MODELS=$HOME/.local/share/jarvis/ollama-models \
  ~/.local/ollama/bin/ollama serve
```

如果希望开机自启 Ollama，可把它做成另一个 user service；Jarvis 的 service 不负责拉起 Ollama，避免两个进程互相重启。

## 4. 模型来源：本地 / 远端，一键切换

设置入口：右上角模型徽标，或“设置 → 模型来源”。设置弹窗分为**模型 / 语音 / 外观 / 设备 / 系统**五个标签，状态概览固定在顶部，页签支持键盘左右键切换；改 Base URL、协议或 Key 后会自动刷新模型列表。不需要改 `.env`、不需要重启。

### 4.1 LLM 三种远端协议

- **本地 Ollama**：默认 `http://127.0.0.1:11434` + `qwen2.5:3b`。
- **OpenAI Chat Completions**：`POST /chat/completions`，例如 DeepSeek、OpenAI、OpenRouter、vLLM、LM Studio、Ollama `/v1`。
- **OpenAI Responses**：`POST /responses`，解析 `response.output_text.delta`。
- **Anthropic Messages**：`POST /messages`，`x-api-key` + `anthropic-version: 2023-06-01`，解析 `content_block_delta`。

Base URL 只填域名、填 `/v1`、或填完整端点都可以；客户端会归一化，不会重复拼
`/v1`。远端非 loopback 强制 HTTPS；只有 localhost 可用 HTTP。

### 4.2 模型列表自动获取

设置页的模型名是**下拉框**，不是自由文本：

1. 打开卡片、改 Base URL / 接口协议 / Key；
2. 页面调用 `POST /api/model/list`；
3. 服务端按来源读取 `GET /api/tags`（Ollama）、`GET /models`（OpenAI 兼容）或
   `GET /v1/models`（Anthropic）；
4. 返回的模型 id 自动填入选择器；当前模型预选中。

没有 `/models` 的兼容网关会明确提示“无法自动列出模型”；本版不退回手填。
Cloudflare Workers AI 例外：Jarvis 使用账号级 `ai/models/search` 自动读取模型，
Base URL 填 `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`。
完整说明见 [models.md](models.md) 与 [providers.md](providers.md)。

### 4.3 操作

1. 点模型卡片，编辑 Base URL、接口协议和 API Key；模型从自动列表选。
2. 点 **测试连接**：`/models` 探测 + 一句 `只回复：ok` 的极小请求；测试结果
   也会补齐模型列表。
3. 点 **保存并切换**：测试成功后才原子写入 `data/model-config.json` 并替换
   客户端；失败不破坏当前配置。
4. 已配置卡片可直接 **切换**，下一轮对话立即生效，不用重启。

安全与存储：

- API Key 只写入 `~/.local/share/jarvis/data/model-config.json`，权限 `0600`；
  `GET /api/model` 永远不返回 Key，只返回 `hasKey`。
- 页面留空 Key 表示保留已保存的 Key；如果更换 Base URL 而留空，服务端会拒绝，
  避免把旧密钥发给新地址。
- 远端模型会收到当前对话和按需检索到的记忆上下文；`sensitive` / `secret`
  记忆在构建上下文时被过滤。切换前请确认服务商隐私政策。
- 屏幕/摄像头画面**默认不发给远端模型**：远端激活时 `look` 会直接拒绝采集，
  避免桌面截图出网。确实需要远端视觉时，在服务端设置
  `JARVIS_ALLOW_REMOTE_VISION=1`，并自行承担服务商接收画面的风险；默认保持关闭。
- 远端没有填 `embedModel` 时，记忆向量自动复用本地 Ollama；本地不可用时记忆
  退化为词法召回。视觉默认关闭（见上一条），即使远端配置了 `visionModel` 也不会
  自动采集屏幕/摄像头。
- Anthropic 没有第一方 embedding；`embed()` 返回 null，由路由器回退本地。
- 启动时使用上次激活的配置；远端不可达时服务仍会启动，打开设置切回本地即可。

同样的操作也可以用 API：

```bash
curl -s http://127.0.0.1:3081/api/model

# 自动列模型（不会保存）
curl -s -X POST http://127.0.0.1:3081/api/model/list \
  -H 'content-type: application/json' \
  -d '{"id":"remote","kind":"openai","protocol":"anthropic","baseUrl":"https://api.anthropic.com/v1","apiKey":"sk-ant-..."}'

curl -s -X POST http://127.0.0.1:3081/api/model/test \
  -H 'content-type: application/json' \
  -d '{"id":"remote","protocol":"responses","baseUrl":"https://api.openai.com/v1","model":"gpt-5","apiKey":"sk-..."}'

curl -s -X POST http://127.0.0.1:3081/api/model/apply \
  -H 'content-type: application/json' \
  -d '{"id":"remote","protocol":"responses","baseUrl":"https://api.openai.com/v1","model":"gpt-5","apiKey":"sk-..."}'

curl -s -X POST http://127.0.0.1:3081/api/model/activate \
  -H 'content-type: application/json' -d '{"id":"local"}'
```

`test` 只测试不保存；`apply` 测试成功后保存并切换；`activate` 切换已保存配置。

### 4.4 ASR / TTS：本地 / 远端独立切换

“设置 → 语音模型”有两张卡；ASR 和 TTS 各自选择本地或远端，保存后
`VoiceRuntime` 立即重建，不重启服务：

- **本地 ASR**：faster-whisper `tiny` 持久 worker（或 whisper.cpp），启动预热，
  热路径约 1–2 秒。
- **远端 ASR HTTP**：OpenAI 兼容 `POST /audio/transcriptions`；浏览器音频先由
  本机 ffmpeg 转 16 kHz 单声道 WAV，再 multipart 上传。
- **远端 ASR WebSocket（默认）**：完整 WS 地址；Jarvis 先发 `start`，再发
  16 kHz PCM s16le 分片，最后 `end`，服务端回 `partial` / `final` / `error`。
  这是本项目的 **Jarvis Streaming ASR v1** 契约，不是 OpenAI Realtime 的别名；
  精确报文见 [voice.md](voice.md)。
- **本地 TTS**：Piper 常驻 worker，按短句流式合成。
- **远端 TTS**：OpenAI 兼容 `POST /audio/speech`，请求 WAV；输出仍在本机加密。
- **Gemini / Cloudflare / Edge**：在“服务商”下拉选择；Gemini/Cloudflare 走原生
  音频端点，Edge 调用本机 `edge-tts` 命令。各厂商的 Base URL、模型、音色和限制见
  [providers.md](providers.md)。

配置持久化在 `data/voice-config.json`（0600）；Key 不回显。远端非 loopback
必须 TLS（`https` / `wss`），TTS 不接受 `ws`。默认全部本地；不配置远端就不出网。
浏览器目前是松手后上传整段语音，**后端 → ASR 服务**才走 WebSocket 流式，尚未
显示逐字字幕；端到端麦克风分片是后续工作。

```bash
curl -s http://127.0.0.1:3081/api/voice

curl -s -X POST http://127.0.0.1:3081/api/voice/apply \
  -H 'content-type: application/json' \
  -d '{"activeAsr":"remote","activeTts":"remote",
       "asr":{"remote":{"transport":"websocket","baseUrl":"wss://asr.example.com/v1/stream","model":"whisper-1","language":"zh","apiKey":"..."}},
       "tts":{"remote":{"baseUrl":"https://api.openai.com/v1","model":"tts-1","voice":"alloy","apiKey":"..."}}}'
```

切回本地只需 `{"activeAsr":"local","activeTts":"local"}`，远端字段省略会保留。

## 5. 远程访问（手机 / 另一台电脑）

默认 loopback 是安全边界，不要为了省事监听 `0.0.0.0` 且不上 TLS。

1. 生成至少 24 字符的随机令牌（`ensureRuntimeDirs` 首次启动会写到
   `~/.local/share/jarvis/data/auth-token`，权限 0600）。
2. 放证书：

```dotenv
JARVIS_HOST=100.x.y.z          # Tailscale / 私网地址，不要公网
JARVIS_AUTH_TOKEN=<至少 24 字符>
JARVIS_TLS_CERT=/home/you/.config/jarvis/cert.pem
JARVIS_TLS_KEY=/home/you/.config/jarvis/key.pem
```

3. 打开 `https://100.x.y.z:3081/?token=<token>`；服务端会设置 HttpOnly、
   SameSite=Strict 的 cookie，然后重定向到 `/`。WebSocket 也走同一令牌。
4. 远端请求不带令牌会得到 401；未配置 TLS 或令牌时配置加载直接失败，
   不会“先开起来再说”。

PWA 可以安装到手机主屏；第一版远程只支持 HTTP/WS + PWA，不包含 WebRTC
把手机摄像头当远端输入。

### 5.0 桌面快捷键

```bash
bash scripts/install-hotkey.sh '<Super>j'
```

只在 GNOME/Unity 下写入 `org.gnome.settings-daemon.plugins.media-keys` 的自定义
快捷键；命令是 `xdg-open http://127.0.0.1:3081`，不会启动第二个服务。Wayland
下是否能把已有窗口提到前台由桌面决定；最稳妥的是把 PWA 安装到独立窗口后使用。

### 5.1 设备配对与撤销

在已登录的桌面端打开 **设置 → 设备 → 生成配对码**，得到 6 位一次性配对码
（5 分钟有效；每个客户端每分钟最多 8 次错误、全局限 60 次）。在手机/另一台电脑打开
`https://<host>:3081/pair`，输入配对码和设备名即可。成功后服务端设置
HttpOnly、SameSite=Strict 的 Cookie 并跳回首页；令牌只在配对响应中出现一次。

设备令牌以 SHA-256 哈希保存在 `data/devices.json`（0600），可在同一设置面板
逐个撤销；撤销立即生效。设备令牌目前等价于主令牌（全权限），不要把它当成
受限子账户。

## 6. 隐私边界

- **屏幕**：只通过 `org.freedesktop.portal.Screenshot` 单次授权；Jarvis 不读
  Wayland framebuffer。Portal 拒绝时不会退回 X11 截屏。只有 portal 不可用
  （超时/无 portal）才尝试 X11；X11 在 Wayland 上通常只得到黑屏。
- **摄像头**：`ffmpeg -f v4l2` 单帧，不保存视频；抓帧写入
  `data/captures`，UI 显示缩略图，服务端定时清理音频，capture 保留时间较短。
- **记忆**：SQLite 源数据；FTS/向量是可重建投影。`sensitive` 默认不进入
  普通召回；`secret` 也不进入。UI 的“记忆”面板以本机所有者身份显示，
  远端访问必须已通过令牌。
- **日志**：logger 对 `token/key/secret/password/authorization` 字段做脱敏；
  不会把完整对话写进日志。
- **默认静默**：主动提醒先过 `ProactivePolicy`（专注模式、免打扰时段、
  每日语音预算）；被拦下时只进入面板，不出声。
- **画面留存**：`data/captures` 只保留 1 小时，音频保留 6 小时；画面卡片
  显示“只在本机 · 1 小时后自动删除”，并提供单张删除按钮。删除接口拒绝
  路径穿越。
- **每日简报**：08:30 生成本地规则简报（提醒 + 相关记忆 + 可选只读 ICS），
  通过 WebSocket 和桌面通知送达；不调用云端模型。
- **数据导出/擦除**：设置 → 系统 → 隐私数据 → 导出数据（JSON：记忆、情景、
  提醒、设备列表、不含密钥的配置摘要）；“删除全部本机数据”会清空记忆、提醒、
  动作审计、音频、画面、trace、日志，重置已保存的模型/语音供应商（连同远端
  API Key）、清空内存中的对话历史和事件回放、断开所有连接并轮换加密密钥。
  必须输入确认短语，不可撤销。访问令牌不在擦除范围内，避免把自己锁在门外。

Wayland 下拿不到活动窗口标题（`xdotool` 对原生 Wayland 失败，
`org.gnome.Shell.Eval` 返回 false），因此窗口级黑名单目前只能在能拿到标题的
X11/XWayland 场景生效；真正的强制点是 portal 的按次授权。不要把“黑名单”
当成比 portal 更强的保证。

## 7. 性能事实（这台 i5-7300HQ / 4 GB VRAM）

| 路径 | 实测 |
|---|---|
| 文字回答（热） | ~0.8–1.5 s |
| 文字回答（模型冷启动） | 4–9 s；启动预热最多等 8 s，超时会先放行 HTTP 并记录 `model warm-up deferred`，首轮可能仍是冷加载 |
| 语音首句（热） | ~2–3 s：ASR ~1.3 s + LLM 首字 ~0.5 s + 首段 Piper ~1 s |
| 语音整轮（热） | ~2.5–4 s（1.5 s 音频实测 2.57 s）；文本先流式出现，音频按短句排队播放 |
| ASR 冷启动 | ~3–4 s 模型加载 + ~1 s 推理预热；启动日志 `loadMs/warmupMs`，期间 `asrState=starting` |
| OCR 一帧 | 4–8 s（RapidOCR CPU） |
| 屏幕 OCR + 回答 | ~8–16 s |
| qwen2.5vl 3B 视觉 | 40–150 s，4 GB 显存下会 CPU/GPU 分层 |
| 远端模型首 token | 取决于网络与服务商；测试连接会显示实测总延迟，Jarvis 不做远端预热（避免启动即扣费） |

语音的“慢”主要来自两段：模型冷加载（Ollama 默认 5 分钟后卸载）和
Piper 每次启动的模型加载。v2 现在在启动时预热 LLM/nomic，并把 Piper
保持为常驻 `--json-input` 进程；`JARVIS_OLLAMA_KEEP_ALIVE=24h` 避免
办公间隙后第一次回答重新加载模型。若内存紧张，可把它设为 `5m`。

远端模式不再有本机模型冷加载问题，但每次请求都有网络往返；切换后下一轮生效，当前轮不会被打断。

因此默认策略是 **OCR-first**：屏幕/摄像头先读文字；只有明确说
“用视觉看屏幕”或摄像头没有文字时才调用视觉模型。视觉模型是可选能力，
不是实时对话路径。

启动预热有 8 秒上限：超时只表示“预热被推迟”，不是失败；`/api/health` 的
`modelReady` 来自一次轻量健康探测，也不代表模型已经预热完成。首个请求在
这种情况下仍会承担冷加载时间，但服务不会因为 Ollama 卡住而迟迟不监听。

远端视觉默认关闭：即使远端配置了 `visionModel`，`look` 也会在采集前直接拒绝，
除非服务端设置 `JARVIS_ALLOW_REMOTE_VISION=1`。这是有意的隐私硬边界，不是
模型能力故障。

## 8. 验收命令

本机 2026-10-26 的完整结果见
[release-acceptance-2026-10-26.md](release-acceptance-2026-10-26.md)。

```bash
cd ~/jarvis/v2
npm run typecheck
npm test
npm run doctor
curl -s http://127.0.0.1:3081/api/health

# 记忆回归评测（11 条；弃权/隐私/候选/更新）
npm run memory:eval

# 浏览器 smoke（Chrome 开 --remote-debugging-port；无 Playwright 依赖）
JARVIS_CDP_URL=http://127.0.0.1:9223 npm run ui:smoke

# 每日简报 / 持久化回合 / 设备 / 隐私
curl -s http://127.0.0.1:3081/api/brief
curl -s 'http://127.0.0.1:3081/api/traces?limit=20'
curl -s http://127.0.0.1:3081/api/devices

# 文字 + 记忆
curl -s -X POST http://127.0.0.1:3081/api/chat \
  -H 'content-type: application/json' \
  -d '{"text":"记住：我每周三晚上整理项目进度。"}'
curl -s 'http://127.0.0.1:3081/api/memory?query=项目进度'

# 语音（用已有 WAV 或浏览器按住说话）
curl -s -X POST http://127.0.0.1:3081/api/voice \
  -H 'content-type: audio/wav' --data-binary @/tmp/piper-test-16k.wav

# 提醒
curl -s -X POST http://127.0.0.1:3081/api/chat \
  -H 'content-type: application/json' \
  -d '{"text":"提醒我明天上午 9 点开周会。"}'
curl -s http://127.0.0.1:3081/api/reminders
```

屏幕验收需要人在场：第一次点击“看屏幕”时 GNOME 会弹出共享确认；
允许后 OCR 才能读到真实窗口。这是产品设计，不是 bug。

## 9. 故障排查

| 现象 | 处理 |
|---|---|
| `modelReady: false` | `ollama list`；拉 `qwen2.5:3b`；检查 `JARVIS_OLLAMA_URL` |
| 回答很慢 / 显存不足 | `ollama ps` 看是否 CPU/GPU 分层和 `expires_at`；只保留 LLM + nomic；停掉视觉模型；确认 `JARVIS_OLLAMA_KEEP_ALIVE=24h` |
| 只有第一次回答慢 | 模型被 Ollama 卸载后重新加载；`ollama ps` 为空说明冷启动；v2 启动预热 + keep_alive 可消除 |
| `没听清` / ASR 空 | 确认 faster-whisper worker ready；`python3 -c "import faster_whisper"` |
| 屏幕 15 s 后黑屏 | Portal 未授权或超时；允许 GNOME 共享；X11 回退在 Wayland 不可用 |
| OCR 读不到 | 屏幕主要是图片/视频；说“用视觉看屏幕”，或换到文字窗口 |
| 摄像头不可用 | `ls -l /dev/video0`；`ffmpeg -f v4l2 -i /dev/video0 -frames:v 1 /tmp/x.jpg` |
| 远程 401 | 用 `/?token=...` 设置 cookie；确认 TLS 与令牌同时配置 |
| 端口占用 | `JARVIS_PORT=3082 npm start`；桌面脚本读同一个变量 |

## 10. 观察台与调参（开发期）

顶栏波形图标打开 **Jarvis Studio**，或直接访问 `http://127.0.0.1:3081/` 后点开。

| 页 | 用途 | 关键 API |
|---|---|---|
| 总览 | 当前注意力、首字/整轮、延迟趋势、最新回合瀑布、事件、系统负载 | `GET /api/observatory` |
| 记忆 | 星座图、筛选、Inspector、时间线、召回实验台 | `GET /api/memory/graph`, `GET /api/memory?query=` |
| 调参 | 32 项效果/行为参数，预设、实时预览、保存/重置 | `GET/PUT /api/tuning`, `POST /api/tuning/reset`, `POST /api/tuning/preset` |
| 配置 | 只读脱敏运行时配置 | `GET /api/config` |
| 事件 | 完整事件流与 JSON payload | `GET /api/observatory` |

调参写入 `~/.local/share/jarvis/data/tuning.json`（0600，原子写）。界面参数实时生效；
对话/记忆参数下一轮生效；声音参数会重启 Piper worker，正在播放的音频不受影响。
端口、TLS、认证令牌、模型 API Key 不在调参页，仍由环境变量或模型设置管理。

开发演示记忆：

```bash
# 仅 loopback 可用，必须显式带 header
curl -s -X POST http://127.0.0.1:3081/api/dev/demo-memory \
  -H 'content-type: application/json' -H 'x-jarvis-demo: 1' -d '{}'
curl -s -X DELETE http://127.0.0.1:3081/api/dev/demo-memory -H 'x-jarvis-demo: 1'
```

演示项 `sourceRef` 以 `demo:` 开头，只删除这些，不会触碰真实记忆。

### 排查“为什么慢”

1. 总览看最近回合的 `首字` 与 `整轮`；首字大 → 模型冷加载/上下文太长/远端网络。
2. 看“最新回合 · 追踪”的 ASR、召回条数、语音首段；ASR 大 → faster-whisper；语音首段大 → Piper。
3. 事件流展开 `assistant.done`，核对 `durationMs` 与错误。
4. 调参页把 `conversation.maxContextMessages` / `recallLimit` 调小，观察下一轮；确认后再保存。

### 安全说明

- `/api/config`、`/api/observatory` 不返回 token/私钥/API Key。
- Studio 走既有认证与同源 CSRF；远端访问仍需 HTTPS + Bearer。
- `data/tuning.json`、`jarvis.db`（含 `-wal`/`-shm`）均为 0600；进程以 `umask 077` 启动，新增音频/截图/日志继承私有权限。
- 不要把这些文件提交到 git 或发到公开 issue。
- 演示数据接口仅回环 + `x-jarvis-demo: 1`；不要在生产反向代理后面暴露。

## 11. 已知缺口

- 没有唤醒词常听；第一版是按住说话。音频只在按住期间采集。
- 没有 WebRTC；远程是 PWA + WebSocket。
- 工具执行目前只有确认后的打开网页/文件管理器；没有任意文件写入、终端或**双向**日历；只读 ICS 只用于简报。
- 视觉模型在 4 GB 显存上不具备实时性；已降级为显式可选路径。
- 记忆巩固目前是确定性去重/过期/索引重建，不含 LLM 摘要。
- 屏幕捕获的窗口级黑名单在原生 Wayland 下不可用；portal 授权是实际边界。
- Studio 的实时 ring 只保留最近 80 个 turn / 240 条事件；已完成回合另存 `data/telemetry.jsonl`（加密、5 MB 滚动），重启后可回看。
- 记忆图暂不支持手动连线/取消连线；`memory_links` 表已存在，API 仅服务端演示/巩固可写。
- 记忆数据库没有全库加密；captures/audio/telemetry 已加密，但 DB 依赖 0600 + 整盘 LUKS。
- 设备令牌等价主令牌，没有按设备限权；丢失设备要在设置里撤销。
- 托盘是可选 `scripts/tray.py`（GTK3 legacy）；GNOME 42 Wayland 默认不显示 XEmbed 图标，需状态图标扩展；日常入口仍推荐桌面图标、PWA 独立窗口或 `scripts/install-hotkey.sh`。
