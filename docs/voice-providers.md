# 语音服务配置指南（ASR / TTS）

> 应用内页面：<http://127.0.0.1:3081/providers#voice>；接口
> `GET /api/voice/catalog`；数据源 `src/voice/catalog.ts`。
> 对话模型（LLM）的供应商指南在 [providers-guide.md](providers-guide.md)。

## 0. 先分清两件事

| | ASR（语音识别） | TTS（语音合成） |
|---|---|---|
| 方向 | 麦克风音频 → 文字 | 回复文字 → 音频 |
| 默认 | 本地 faster-whisper | 本地 Piper |
| 远端协议 | OpenAI `/audio/transcriptions`、Gemini 原生、Cloudflare `/ai/run` | OpenAI `/audio/speech`、Gemini 原生、Cloudflare `/ai/run`、Edge TTS 命令行 |
| 优先级链 | 是（`asr[]`，可配多个） | 是（`tts[]`，可配多个） |

**两边可以各用各的**：常见组合是“识别走 Groq（快）+ 合成走本机 Piper（免费）”，
或者“识别走本机 + 合成走 CosyVoice（中文好听）”。

## 0.1 配多个服务，失效自动切换

ASR 和 TTS **各自是一条有序的链**，不是单选框：设置 → 语音 → “添加语音识别/合成服务”，
可以放多个远端服务，本地引擎也在链里。列表第一项是首选，用 ↑ ↓ 调顺序。

```
ASR 链：硅基流动 → Groq → 本地 faster-whisper
TTS 链：Edge TTS → 硅基流动 CosyVoice → 本地 Piper
```

运行时按顺序尝试；某个服务失败时按错误类型决定是否切换：

| 错误 | 典型原因 | 冷却 | 行为 |
|---|---|---|---|
| 额度/余额（402、quota、insufficient） | 免费额度用完 | 30 分钟 | 切下一个，事件 `voice.failover` |
| 限流（429） | 触发速率限制 | 60 秒 | 切下一个 |
| Key 失效（401/403） | Key 过期、权限不对 | 24 小时 | 切下一个 |
| 网络（超时、DNS、连接拒绝） | 断网、服务挂了 | 2 分钟 | 切下一个 |
| 服务端 5xx | 上游故障 | 5 分钟 | 切下一个 |
| 请求错误 4xx（模型名写错等） | 配置问题 | 不冷却 | **直接报错**，避免掩盖配置错误 |

冷却中的服务会在列表里显示“冷却至 HH:MM”，期间请求直接跳过；全部都在冷却时仍会
按顺序重试一轮（可能额度已刷新、Key 已修好）。冷却记录写在
`<dataDir>/voice-health.json`，重启后仍生效。语音设置本体在
`<dataDir>/voice-config.json`，Key 只存本机（0600）。

> 和 LLM 供应商池的区别：LLM 按**场景**（chat/coding/…）选链，语音只有
> “识别/合成”两条链；两者共用同一套错误分类与冷却规则（`src/model/failover.ts`）。

## 1. 三步接入（所有远端服务通用）

1. 在服务商控制台创建 API Key（Edge TTS 与本地引擎不需要）。
2. 设置 → 语音 → 在对应一侧点“添加语音识别/合成服务”（远端服务也可以排在本地引擎后面）。
3. 服务商选对适配器 → 填地址/模型/音色 → 粘贴 Key → **保存语音设置**。
4. 想配第二个备选，重复 2–3；用 ↑ ↓ 调整优先级，第一项即首选。

页面上每张卡片下方还有“快速预设”，点一下就把地址、模型、音色填好，
只剩 Key 需要粘贴。

> 适配器选错是最常见的失败原因：Gemini 和 Cloudflare 走原生接口，
> 其余绝大多数走 OpenAI 兼容。选“自动识别”时按服务地址的域名判断。

## 2. 该选哪个

| 需求 | ASR | TTS |
|---|---|---|
| 完全离线 / 隐私 | **本机 faster-whisper** | **本机 Piper** |
| 不花钱、中文自然 | 硅基流动 SenseVoice | **Edge TTS** |
| 最快 | Groq Whisper | Groq PlayAI（仅英文） |
| 中文最好听 | 硅基流动 / 百炼 | 硅基流动 CosyVoice |
| 英文播报 | 任意 | OpenAI TTS / Groq PlayAI |
| 已有 GPU | 自建 Whisper | 自建 OpenAI 兼容 TTS |
| 已在用 Cloudflare | Cloudflare Whisper | Cloudflare MeloTTS |

## 2.1 常见模型与音色（设置里可直接选）

`/providers#voice` 的每个预设详情、以及设置 → 语音的模型/音色输入框，都带一份
常见值清单（输入框有自动补全）。下面是调研所得的型号建议，**不是全集，也未逐个线上实测**，以服务商当前文档和账号权限为准。模型与音色不是任意组合都兼容；本机 Piper 音色须先下载，自建服务须先部署对应模型。

| 预设 | 备选模型 | 备选音色 |
|---|---|---|
| 本机 faster-whisper | `tiny` / `base` / `small` / `medium` / `large-v3` | — |
| OpenAI Whisper | `whisper-1`、`gpt-4o-transcribe`、`gpt-4o-mini-transcribe` | — |
| Groq Whisper | `whisper-large-v3`、`whisper-large-v3-turbo`、`distil-whisper-large-v3-en` | — |
| 硅基流动 SenseVoice | `FunAudioLLM/SenseVoiceSmall` | — |
| 百炼 Paraformer | `paraformer-v2`、`paraformer-8k-v2` | — |
| Gemini 音频 | `gemini-2.5-flash`、`gemini-2.5-pro`、`gemini-2.0-flash` | — |
| Cloudflare Whisper | `@cf/openai/whisper`、`@cf/openai/whisper-large-v3-turbo`、`@cf/openai/whisper-tiny-en` | — |
| 自建 FunASR | `iic/SenseVoiceSmall`、`iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch` | — |
| 自建 Whisper | `whisper-large-v3-turbo`、`whisper-large-v3`、`whisper-1` | — |
| 本机 Piper | `piper` | `zh_CN-huayan-medium`、`zh_CN-huayan-x_low`、`en_US-lessac-medium` |
| Edge TTS | `edge-tts` | `zh-CN-XiaoxiaoNeural`、`zh-CN-YunxiNeural`、`zh-CN-YunjianNeural`、`zh-TW-HsiaoChenNeural`、`en-US-AriaNeural` |
| OpenAI TTS | `gpt-4o-mini-tts`、`tts-1`、`tts-1-hd` | `alloy`、`coral`、`nova`、`onyx`、`sage`、`shimmer` |
| 硅基流动 CosyVoice | `FunAudioLLM/CosyVoice2-0.5B` | `alex`、`anna`、`bella`、`benjamin`、`charles`、`claire`、`david`、`diana`（都要带 `FunAudioLLM/CosyVoice2-0.5B:` 前缀） |
| Gemini TTS | `gemini-2.5-flash-preview-tts`、`gemini-2.5-pro-preview-tts` | `Kore`、`Puck`、`Charon`、`Aoede`、`Fenrir`、`Leda` |
| Cloudflare TTS | `@cf/myshell-ai/melotts` | `zh`、`en` |
| Groq TTS | `playai-tts`、`playai-tts-arabic` | `Fritz-PlayAI`、`Celeste-PlayAI`、`Cheyenne-PlayAI`、`Atlas-PlayAI` |
| 自建 OpenAI 兼容 TTS | `tts-1`、`kokoro` | `alloy`、`nova`、`af_heart`、`am_adam` |

> 音色格式随适配器不同：OpenAI 兼容是 `alloy` 这类短名，CosyVoice 是
> `模型:音色`，Edge 是 `zh-CN-XiaoxiaoNeural`，Gemini 是 `Kore` 这种首字母大写的名字。
> 填错通常返回 400/404，属于配置错误，不会触发自动切换。

## 3. ASR：语音识别

### 本机 faster-whisper
- 地址：无（本地引擎） · 模型：`small` · 语言：`zh`
- 免费，音频不出本机；`npm run setup` 会装好
- 注意：模型越大越准越慢；显存不足会落到 CPU

### OpenAI Whisper
- 地址：`https://api.openai.com/v1` · 模型：`whisper-1` · 适配器：OpenAI 兼容
- Key：<https://platform.openai.com/api-keys>
- 按分钟计费（约 $0.006/分钟），无免费额度
- 注意：中国大陆无法直连，用 `HTTPS_PROXY` 而不是把代理写进地址

### Groq Whisper
- 地址：`https://api.groq.com/openai/v1` · 模型：`whisper-large-v3`（或 `-turbo`）
- Key：<https://console.groq.com/keys>
- 有免费层；速度是它最大的优势
- 注意：免费层有音频时长上限，超出返回 429

### 硅基流动 SenseVoice
- 地址：`https://api.siliconflow.cn/v1` · 模型：`FunAudioLLM/SenseVoiceSmall`
- Key：<https://cloud.siliconflow.cn/account/ak>
- 该模型目前免费，中文识别准
- 注意：模型名区分大小写

### 阿里云百炼 Paraformer
- 地址：`https://dashscope.aliyuncs.com/compatible-mode/v1` · 模型：`paraformer-v2`
- Key：<https://bailian.console.aliyun.com/>
- **诚实的说明**：百炼的 OpenAI 兼容模式主要覆盖对话，转写走独立接口。
  这个预设可以试，但如果 `/audio/transcriptions` 返回 404，说明当前账号/模型
  不支持该路径——换硅基流动或本地方案，不要在这上面耗时间。

### Google Gemini 音频
- 地址：`https://generativelanguage.googleapis.com/v1beta` · 模型：`gemini-2.0-flash`
- 适配器：**Gemini（原生）**，会自动改走 HTTP
- Key：<https://aistudio.google.com/apikey>
- 免费层可用；数据会被用于改进产品

### Cloudflare Whisper
- 地址：`https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`
- 模型：`@cf/openai/whisper`
- Token：<https://dash.cloudflare.com/profile/api-tokens>（需 Workers AI 权限）
- 注意：`<ACCOUNT_ID>` 要替换；模型名必须以 `@cf/` 开头

### 自建 FunASR（达摩院）
- 地址：本机 `http://127.0.0.1:8000/v1`（局域网换 `http://<内网IP>:8000/v1`）
- 模型：`iic/SenseVoiceSmall`
- 免费；中文与方言强，可完全离线
- 注意：不同版本端点路径不同，先 `curl` 确认 `/v1/audio/transcriptions`；CPU 上延迟高

### 自建 Whisper（vLLM / 兼容服务）
- 地址：本机 `http://127.0.0.1:8000/v1`；局域网换成 `http://<内网IP>:8000/v1`
- 模型：`whisper-large-v3-turbo`
- 免费（自有算力），内网可用
- 注意：先 `curl` 确认它真的实现了 `/audio/transcriptions`；内网 IP 要进 `JARVIS_ALLOWED_HOSTS`

## 4. TTS：语音合成

### 本机 Piper
- 地址：无 · 模型：`piper` · 音色：`zh_CN-huayan-medium`
- 免费、离线、零延迟；自然度一般
- 想换音色就填 `models/` 里的其他 `.onnx` 名

### Edge TTS
- 地址：无 · 模型：`edge-tts` · 音色：`zh-CN-XiaoxiaoNeural`
- 免费、无需 Key，中文自然；需要本机装 `edge-tts`
- 注意：文本会发到微软的朗读服务，不算隐私方案；第三方可用性不受你控制

### OpenAI TTS
- 地址：`https://api.openai.com/v1` · 模型：`gpt-4o-mini-tts` · 音色：`alloy`
- Key：<https://platform.openai.com/api-keys>
- 按字符计费；`gpt-4o-mini-tts` 支持语气指令，`tts-1` 不支持

### 硅基流动 CosyVoice
- 地址：`https://api.siliconflow.cn/v1` · 模型：`FunAudioLLM/CosyVoice2-0.5B`
- 音色：`FunAudioLLM/CosyVoice2-0.5B:alex`（**必须带模型前缀**）
- Key：<https://cloud.siliconflow.cn/account/ak>
- 国内直连、中文好、便宜

### Google Gemini TTS
- 地址：`https://generativelanguage.googleapis.com/v1beta`
- 模型：`gemini-2.5-flash-preview-tts` · 音色：`Kore`
- Key：<https://aistudio.google.com/apikey>
- 注意：preview 模型名称与配额可能变；免费层数据会用于改进产品

### Cloudflare MeloTTS
- 地址：`https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`
- 模型：`@cf/myshell-ai/melotts` · 音色：`zh`（填语言代码，不是人名）
- 免费 Neurons 配额；适合已经在用 Cloudflare 的人

### Groq PlayAI TTS
- 地址：`https://api.groq.com/openai/v1` · 模型：`playai-tts` · 音色：`Fritz-PlayAI`
- **只支持英文**（少量阿拉伯语）；中文场景不要选它

### 自建 OpenAI 兼容 TTS
- 地址：本机 `http://127.0.0.1:8001/v1`；局域网换成 `http://<内网IP>:8001/v1`
- 模型：`tts-1` · 音色：`alloy`（以你的服务为准）
- 适合 openedai-speech / XTTS 这类实现
- 注意：不同实现的音色名不通用；内网 IP 要进 `JARVIS_ALLOWED_HOSTS`

## 5. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 401 / 403 | Key 错或未开通 | 重新创建 Key；确认服务已开通 |
| 404 + `audio/transcriptions` | 该服务没有这个端点 | 换适配器或换供应商（见百炼说明） |
| 400 音色错误 | 音色名格式不对 | CosyVoice 要带 `模型:` 前缀；MeloTTS 填语言 |
| 连接超时 | 网络/代理 | 系统级 `HTTPS_PROXY`，不要写进地址 |
| 中文读成英文 | 选了只支持英文的音色 | 换 CosyVoice / Edge / Piper |
| `edge-tts` 报错 | 没装命令行 | `pip install edge-tts`，或改用本机 Piper |

## 6. 隐私

- 本地 ASR/TTS 全程不出网。
- 远端 ASR 会把你说的**整段音频**发给该服务商；远端 TTS 会把**要朗读的文本**发出去。
- 屏幕/摄像头内容不会随语音一起上传。
- 想验证是否真的不出网：断开网络后用本地引擎对话。
