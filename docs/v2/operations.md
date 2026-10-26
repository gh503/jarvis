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

模型和二进制均在用户目录，不需要 sudo。`v2/.env.example` 是完整配置模板。

## 3. 启动

```bash
cd ~/jarvis/v2
npm start
# http://127.0.0.1:3081
```

首次安装（幂等，慢的是模型下载）：

```bash
cd ~/jarvis/v2
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
```

Ollama 需要先运行。当前环境用：

```bash
OLLAMA_HOST=127.0.0.1:11434 \
OLLAMA_MODELS=$HOME/.local/share/jarvis/ollama-models \
  ~/.local/ollama/bin/ollama serve
```

如果希望开机自启 Ollama，可把它做成另一个 user service；Jarvis 的 service 不负责拉起 Ollama，避免两个进程互相重启。

## 4. 远程访问（手机 / 另一台电脑）

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

## 5. 隐私边界

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

Wayland 下拿不到活动窗口标题（`xdotool` 对原生 Wayland 失败，
`org.gnome.Shell.Eval` 返回 false），因此窗口级黑名单目前只能在能拿到标题的
X11/XWayland 场景生效；真正的强制点是 portal 的按次授权。不要把“黑名单”
当成比 portal 更强的保证。

## 6. 性能事实（这台 i5-7300HQ / 4 GB VRAM）

| 路径 | 实测 |
|---|---|
| 文字回答（热） | ~0.9 s |
| 文字回答（冷启动） | 8–15 s（模型加载） |
| 语音整轮（热） | ~6 s：ASR ~2 s + LLM ~1 s + Piper ~3 s |
| OCR 一帧 | 4–8 s（RapidOCR CPU） |
| 屏幕 OCR + 回答 | ~8–16 s |
| qwen2.5vl 3B 视觉 | 40–150 s，4 GB 显存下会 CPU/GPU 分层 |

因此默认策略是 **OCR-first**：屏幕/摄像头先读文字；只有明确说
“用视觉看屏幕”或摄像头没有文字时才调用视觉模型。视觉模型是可选能力，
不是实时对话路径。

## 7. 验收命令

```bash
cd ~/jarvis/v2
npm run typecheck
npm test
npm run doctor
curl -s http://127.0.0.1:3081/api/health

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

## 8. 故障排查

| 现象 | 处理 |
|---|---|
| `modelReady: false` | `ollama list`；拉 `qwen2.5:3b`；检查 `JARVIS_OLLAMA_URL` |
| 回答很慢 / 显存不足 | `ollama ps` 看是否 CPU/GPU 分层；只保留 LLM + nomic；停掉视觉模型 |
| `没听清` / ASR 空 | 确认 faster-whisper worker ready；`python3 -c "import faster_whisper"` |
| 屏幕 15 s 后黑屏 | Portal 未授权或超时；允许 GNOME 共享；X11 回退在 Wayland 不可用 |
| OCR 读不到 | 屏幕主要是图片/视频；说“用视觉看屏幕”，或换到文字窗口 |
| 摄像头不可用 | `ls -l /dev/video0`；`ffmpeg -f v4l2 -i /dev/video0 -frames:v 1 /tmp/x.jpg` |
| 远程 401 | 用 `/?token=...` 设置 cookie；确认 TLS 与令牌同时配置 |
| 端口占用 | `JARVIS_PORT=3082 npm start`；桌面脚本读同一个变量 |

## 9. 已知缺口

- 没有唤醒词常听；第一版是按住说话。音频只在按住期间采集。
- 没有 WebRTC；远程是 PWA + WebSocket。
- 工具执行目前只有确认后的打开网页/文件管理器；没有任意文件写入、终端或日历。
- 视觉模型在 4 GB 显存上不具备实时性；已降级为显式可选路径。
- 记忆巩固目前是确定性去重/过期/索引重建，不含 LLM 摘要。
- 屏幕捕获的窗口级黑名单在原生 Wayland 下不可用；portal 授权是实际边界。
