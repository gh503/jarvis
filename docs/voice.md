# Jarvis v2 — 语音模型、ASR 传输与 TTS

- Status: implemented
- Code: `src/voice/{settings,runtime,remote,asr,faster-whisper,tts}.ts`
- UI: 设置 → 语音模型
- Tests: `test/{voice-settings,voice-remote}.test.ts`

## 1. 本地 / 远端独立切换

语音不是“模型来源”卡片的附属开关。ASR 和 TTS 各自有 active 来源：

| 侧 | 本地默认 | 远端 |
|---|---|---|
| ASR | faster-whisper `tiny` 持久 worker（或 whisper.cpp） | OpenAI-compatible HTTP、Jarvis Streaming ASR WebSocket、Gemini 原生、Cloudflare Workers AI |
| TTS | Piper + `zh_CN-huayan-medium.onnx` | OpenAI-compatible `POST /audio/speech`、Gemini 原生 TTS、Cloudflare Workers AI、Edge TTS |

设置页的“语音模型”分两张卡；每张卡可以选本地/远端，保存后立即重建
`VoiceRuntime`，不需要重启，也不会打断已经在进行的回合：

- `ConversationDeps.transcriber` / `synthesizer` 现在指向 `VoiceRuntime`
  门面；切换只换内部实现。
- 若当前是本地 ASR，切回本地时会异步预热 worker；服务启动时只预热当前
  激活的本地 ASR。
- 远端 TTS 不做启动预热，避免每次启动都产生费用。
- 远端配置不完整时，保存会拒绝；本地-only 配置可以直接保存，不需要先填
  远端地址。

持久化：`data/voice-config.json`，0600；API Key 不回显，只返回 `hasKey`。
`voiceSettings.publicView()` 与 `model-config.json` 使用同一套隐藏规则。

## 2. 远端 ASR：HTTP

适用：OpenAI `/audio/transcriptions` 兼容服务（OpenAI、Groq、自建
whisper-server 等）。

```http
POST {base}/audio/transcriptions
Authorization: Bearer <key>        # 可选；本机服务可留空
Content-Type: multipart/form-data

file=@audio.wav;type=audio/wav
model=whisper-1
language=zh
```

实现细节：

- 浏览器上传的 webm/ogg/m4a 先由本机 `ffmpeg` 转成 16 kHz 单声道 WAV；已是
  WAV 则直接使用。转换在临时目录进行，结束后删除。
- Base URL 可以是 `https://host/v1`、`https://host` 或完整
  `https://host/v1/audio/transcriptions`；不重复拼接。
- 响应解析 `text`（兼容 `result.text`）；无 JSON 时把纯文本作为转写。
- 超时 120 秒；错误带 HTTP 状态和截断后的响应体，不打印 Key。

UI 选择 **HTTP 一次性上传** 时使用这条路径。它适合短语音、兼容性优先；不提供
partial 字幕。

## 3. 远端 ASR：WebSocket（默认）

UI 的默认远端传输是 **WebSocket 流式**。地址填完整 WebSocket 端点，例如
`wss://asr.example.com/v1/stream`；也接受 `https://.../v1/stream` 并自动转成
`wss://`。

### 3.1 为什么是自定义契约

目前没有跨厂商统一的“ASR WebSocket 流式”标准；把 OpenAI Realtime 的事件名
猜错会造成“连接成功但永远没有转写”的静默失败。Jarvis 因此固定一个很小、
可测试、可自托管的契约（**Jarvis Streaming ASR v1**），并在 UI/文档中明确
标注。接 OpenAI Realtime、Deepgram 等只需要在 `RemoteTranscriber` 增加一个
adapter，不需要改对话层。

### 3.2 协议

连接时带普通 HTTP header：

```http
Authorization: Bearer <key>        # 可选
```

客户端 → 服务端：

```json
{"type":"start","model":"whisper-1","language":"zh","format":"pcm_s16le","sampleRate":16000,"channels":1}
```

随后发送二进制帧：16 kHz、单声道、signed 16-bit little-endian PCM，每帧约
100 ms（3200 字节）。发完后：

```json
{"type":"end"}
```

服务端 → 客户端（JSON 文本）：

```json
{"type":"partial","text":"你"}
{"type":"final","text":"你好，今天怎么样？","language":"zh"}
{"type":"error","error":"model not loaded"}
```

- `partial` 可选，仅用于未来 UI 字幕；当前后端会记录最后一个 partial。
- `final` 或没有 `type` 的 `{"text":...}` 都会结束本轮。
- `error` 立即失败；连接在 final 前关闭且没有文本也会明确报错。
- 总超时 120 秒；客户端在发送 PCM 时每 20 帧让出一次事件循环，避免长语音
  在内存里堆积无限队列。
- 服务端应先回 `start` 的 ack 再收音频；Jarvis 不强制 ack，但不能把二进制
  帧当 JSON 解析。

### 3.3 最小服务端示例

```python
# 仅为契约示意，不是生产服务器
async def handler(ws):
    start = json.loads(await ws.recv())
    pcm = bytearray()
    async for message in ws:
        if isinstance(message, bytes):
            pcm.extend(message)
        elif json.loads(message).get("type") == "end":
            text = transcribe(bytes(pcm), start["sampleRate"])
            await ws.send(json.dumps({"type": "final", "text": text, "language": "zh"}))
            break
```

### 3.4 当前限制（诚实说明）

- 浏览器仍然是“按住说话 → 松手后上传整段音频”；WebSocket 的流式发生在
  **Jarvis 后端 → ASR 服务**。还没有把麦克风分片从浏览器实时送到 ASR，
  因此不会显示逐字字幕。要做端到端实时，需要新增 `/ws/asr` 和前端分片，
  属于下一层工作。
- 没有 VAD/唤醒词；默认仍是按住说话（D-025）。
- WS 契约是本项目定义的，不是 OpenAI Realtime 的别名。

## 4. 远端 TTS

适用：OpenAI `/audio/speech` 兼容服务。

```http
POST {base}/audio/speech
Authorization: Bearer <key>
Content-Type: application/json

{"model":"tts-1","input":"要朗读的句子","voice":"alloy","response_format":"wav"}
```

- 请求 `response_format=wav`；返回音频写入 `data/audio/` 临时文件，随后由
  `SecureFiles` 立即 AES-256-GCM 加密；浏览器通过 `/api/audio/:name` 解密读取。
- 远端 TTS 不预热；`available()` 检查地址（Edge 检查本机命令是否存在）。
- 失败会记录 warning 并让该句没有音频，不会中断文字回复；下一句仍可继续。
- OpenAI/Gemini/Cloudflare 的 WAV 直接保存；Cloudflare MeloTTS/Aura 与 Edge 的
  MP3 由本机 ffmpeg 转成 16 kHz 单声道 WAV，再加密保存。转换失败会明确报错。

### 4.1 多厂商 adapter

语音设置里的“服务商”决定调用哪条端点；也可以保持“自动识别”，由 Base URL
的 host 判断：

| 服务商 | ASR 端点 | TTS 端点 | 说明 |
|---|---|---|---|
| OpenAI 兼容 | `POST /audio/transcriptions` | `POST /audio/speech` | Groq、硅基流动、OpenAI、自建 whisper-server |
| Gemini | `POST /models/<model>:generateContent` | 同左，`responseModalities=["AUDIO"]` | 原生音频，不走 `/audio/*` |
| Cloudflare | `POST /ai/run/<model>` | 同左 | ASR 发原始 WAV；TTS 发 JSON |
| Edge TTS | — | 本机 `edge-tts` 命令 | 无 Key、无 Base URL、无 SLA |

详细填法、模型名、免费额度和隐私注意见 [providers.md](providers.md)。

Gemini / Cloudflare 的原生音频 adapter 会强制使用 HTTP；即使旧配置里保存了
WebSocket，加载时也会归一到 HTTP。Edge TTS 只出现在 TTS 服务商下拉中。

## 5. 配置 API

```bash
curl -s http://127.0.0.1:3081/api/voice

curl -s -X POST http://127.0.0.1:3081/api/voice/apply \
  -H 'content-type: application/json' \
  -d '{
    "activeAsr":"remote","activeTts":"remote",
    "asr":{"remote":{"transport":"websocket","baseUrl":"wss://asr.example.com/v1/stream","model":"whisper-1","language":"zh","apiKey":"..."}},
    "tts":{"remote":{"baseUrl":"https://api.openai.com/v1","model":"tts-1","voice":"alloy","apiKey":"..."}}
  }'
```

- `GET /api/voice` 返回 `{settings, status}`；`settings` 不含 Key。
- `POST /api/voice/apply` 先校验/原子写 `voice-config.json`，再重建运行时；
  失败返回 409，旧运行时不变。
- 切回本地只需 `{"activeAsr":"local","activeTts":"local"}`；远端字段可以省略，
  会保留已保存的值。
- 所有远端地址非 loopback 必须 TLS（`https` / `wss`）；TTS 不接受 `ws`。

## 6. 隐私

- 远端 ASR 会把整段语音发给该服务；远端 TTS 会把待朗读文本发给该服务。
- 默认全部本地，不配置远端就不出网。
- Key 存在 `voice-config.json`（0600），不进入日志/公开接口；语音文件仍在
  本机加密。
- 语音链路的录音文件只在临时目录/内存中短暂存在；Piper/远端输出落盘后立即
  加密，6 小时后清理。
