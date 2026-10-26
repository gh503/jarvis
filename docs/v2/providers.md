# Jarvis v2 — 多厂商模型接入矩阵

- Status: implemented
- Code: `v2/src/model/cloudflare.ts`, `v2/src/voice/providers.ts`, `v2/src/voice/remote.ts`, `v2/src/voice/edge.ts`
- UI: 设置 → 模型来源 / 语音模型
- Tests: `v2/test/{cloudflare,voice-providers,voice-settings,voice-remote}.test.ts`

## 1. 结论矩阵

“直连”指只填地址、模型和 Key 就能工作，不需要改 Jarvis 代码。

| 厂商 | LLM | ASR | TTS | 接入方式 |
|---|---|---|---|---|
| Google Gemini | ✅ Chat Completions + `/models` | ✅ 原生音频 adapter | ✅ 原生 TTS adapter | LLM 直连；语音选 Gemini |
| Groq | ✅ OpenAI 兼容 | ✅ `/audio/transcriptions` | ✅ `/audio/speech`，但只有英文/阿拉伯语 | 直连；中文 TTS 不适用 |
| 硅基流动 | ✅ OpenAI 兼容 | — | ✅ CosyVoice `/audio/speech` | LLM/TTS 直连 |
| OpenRouter | ✅ OpenAI 兼容，含 `:free` | — | — | 只接 LLM |
| Cloudflare Workers AI | ✅ Chat Completions + 账号模型搜索 | ✅ `@cf/openai/whisper*` | ✅ `@cf/myshell-ai/melotts` / `@cf/deepgram/aura-*` | 选 Cloudflare；模型自动读取 |
| Edge TTS | — | — | ✅ 本机 `edge-tts` 命令 | TTS 选 Edge，无需 Key |
| 本地 Ollama / faster-whisper / Piper | ✅ | ✅ | ✅ | 默认，完全不出网 |

“—”表示该厂商当前没有对应的标准公开端点，不是 Jarvis 漏做。OpenRouter 的免费
模型仍受每日请求数限制；Groq 的中文 TTS 受模型语言限制，换 Jarvis 也变不出中文
音色。

## 2. LLM

### 2.1 Gemini

- Base URL：`https://generativelanguage.googleapis.com/v1beta/openai/`
- 协议：OpenAI Chat Completions
- Key：Google AI Studio API Key
- 模型：从 `/models` 自动读取，例如 `gemini-3.8-flash`
- 注意：免费层会使用数据改进产品；敏感内容不要走免费层
- 文档：[OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)、[pricing](https://ai.google.dev/gemini-api/docs/pricing)

### 2.2 Groq

- Base URL：`https://api.groq.com/openai/v1`
- 协议：OpenAI Chat Completions
- 模型：`openai/gpt-oss-20b`、`openai/gpt-oss-120b`、`qwen/qwen3.8-27b`
- 文档：[models](https://console.groq.com/docs/models)

### 2.3 硅基流动

- Base URL：`https://api.siliconflow.cn/v1`
- 协议：OpenAI Chat Completions
- 模型：从 `/models` 读取；免费模型与额度以控制台为准
- 文档：[pricing](https://siliconflow.cn/pricing)

### 2.4 OpenRouter

- Base URL：`https://openrouter.ai/api/v1`
- 协议：OpenAI Chat Completions
- 模型：选择带 `:free` 的模型；免费层默认 50 请求/天（累计充值 10 美元后提高）
- 文档：[limits](https://openrouter.ai/docs/api-reference/limits)

### 2.5 Cloudflare Workers AI

- Base URL：`https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`
- 协议：OpenAI Chat Completions；GPT-OSS 的 Responses API 只支持非流式，Jarvis 当前不把它作为默认路径
- Key：Cloudflare API Token，至少需要 Workers AI 读取/调用权限
- 模型发现：`GET /client/v4/accounts/<id>/ai/models/search?per_page=100`，过滤为
  文本生成模型；不需要手填模型
- 模型示例：`@cf/openai/gpt-oss-120b`、`@cf/qwen/qwen3.8-27b`、`@cf/zai-org/glm-5.3-flash`
- 文档：[OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)、[pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

Cloudflare 没有 OpenAI 的 `GET /models`；Jarvis 使用账号级模型搜索，这是该平台
对应的发现接口。账号 ID 必须出现在 Base URL 里。

## 3. ASR

### 3.1 OpenAI 兼容 / Groq

- 来源：远端
- 服务商：OpenAI 兼容
- 传输：HTTP
- Base URL：Groq 填 `https://api.groq.com/openai/v1`
- 模型：`whisper-large-v3-turbo`（或 `whisper-large-v3`）
- 语言：`zh`
- 免费层单文件上限以控制台为准（Groq 当前为 25 MB）

Jarvis 会把浏览器音频先转成 16 kHz 单声道 WAV，再 multipart 上传。

### 3.2 Gemini

- 来源：远端
- 服务商：Google Gemini
- 传输：自动切换 HTTP
- Base URL：`https://generativelanguage.googleapis.com/v1beta`
- 模型：`gemini-3.5-transcribe`（或支持音频输入的 Gemini Flash）
- Key：Gemini API Key
- 请求：`POST /models/<model>:generateContent`，音频以 base64 inline_data 发送
- 限制：单次音频 18 MB；原生接口，不走 `/audio/transcriptions`

### 3.3 Cloudflare

- Base URL：`https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`
- 模型：`@cf/openai/whisper` 或 `@cf/openai/whisper-large-v3-turbo`
- 请求：`POST /ai/run/<model>`，请求体是原始 WAV（不是 multipart）
- 响应：`result.text`；Key 使用 Bearer Token

## 4. TTS

### 4.1 OpenAI 兼容 / 硅基流动 / Groq

- Base URL：硅基流动 `https://api.siliconflow.cn/v1`；Groq `https://api.groq.com/openai/v1`
- 模型：硅基流动 `FunAudioLLM/CosyVoice2-0.5B`；Groq `canopylabs/orpheus-v1-english`
- 音色：硅基流动 `FunAudioLLM/CosyVoice2-0.5B:alex` / `:anna` / `:claire`；Groq 英文音色
- 请求：`POST /audio/speech`，`response_format=wav`
- **Groq TTS 只有英文/阿拉伯语**；中文请用硅基流动、Gemini、Cloudflare 或 Edge
- 硅基流动文档：[TTS](https://docs.siliconflow.cn/cn/userguide/capabilities/text-to-speech)

### 4.2 Gemini

- Base URL：`https://generativelanguage.googleapis.com/v1beta`
- 模型：`gemini-3.8-flash-tts`（或 `gemini-3.8-flash-lite-tts`、`gemini-2.5-flash-preview-tts`）
- 音色：`Kore`、`Puck`、`Charon`、`Aoede` 等
- 请求：`POST /models/<model>:generateContent`，`responseModalities=["AUDIO"]` +
  `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`
- 返回：PCM/ WAV inlineData；PCM 由 Jarvis 补 WAV 头，不依赖 ffmpeg
- 免费层可用，但免费层数据会被用于改进产品
- 文档：[speech generation](https://ai.google.dev/gemini-api/docs/speech-generation)

### 4.3 Cloudflare

- Base URL：同上
- 模型：`@cf/myshell-ai/melotts`（中文/多语，返回 MP3）或
  `@cf/deepgram/aura-1` / `aura-2-en`（英文，返回 MP3）
- MeloTTS 请求：`{ "prompt": "...", "lang": "zh" }`
- Aura 请求：`{ "text": "...", "speaker": "angus" }`
- 返回 MP3 时由本机 ffmpeg 转 16 kHz WAV；没有 ffmpeg 会明确报错

### 4.4 Edge TTS

- 来源：远端卡片 → 服务商选 Edge TTS
- 不需要 Base URL、Key
- 音色：`zh-CN-XiaoxiaoNeural`、`zh-CN-YunxiNeural`、`zh-CN-XiaoyiNeural` 等
- 依赖本机命令：`python3 -m pip install --user edge-tts`
- 首次合成会调用 Microsoft 在线服务；没有官方 SLA，不适合作为唯一生产路径
- Jarvis 用 `edge-tts` 生成 MP3，再由 ffmpeg 转 WAV 并加密保存

## 5. 隐私与可用性

- 远端 LLM 会收到当前对话和按需检索的记忆上下文；`sensitive` / `secret` 记忆
  仍会被过滤，但对话本身会出网。
- 远端 ASR 会发送整段音频；远端 TTS 会发送待朗读文本。
- Gemini 免费层明确会使用数据改进产品；其他厂商的免费层/数据条款以其政策为准。
- 免费额度、模型名和端点会变化；以各厂商控制台为准。生产上保留本地回退。
- “直连”不等于“无限制”：Groq TTS 语言、OpenRouter 每日请求、Cloudflare 每日
  neurons、Gemini 免费层限流都可能触发 429/402。

## 6. 验证

```bash
cd v2
npm run typecheck
TZ=Asia/Shanghai npm test          # 86 tests
```

新增测试使用本地 mock HTTP，不需要真实 Key：

- Gemini ASR：inline_data、candidate text、模型路径
- Gemini TTS：responseModalities、voice、PCM → WAV
- Cloudflare ASR：账号 `/ai/run`、原始 WAV、`result.text`
- Cloudflare TTS：prompt/lang、二进制音频
- Cloudflare 模型发现：账号搜索、文本模型过滤、权限错误
- Edge：命令存在性、无 Base URL 设置、模型默认值
