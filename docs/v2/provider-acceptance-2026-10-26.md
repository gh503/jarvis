# Jarvis v2 — 多厂商接入验收记录

- Date: 2026-10-26 (Asia/Shanghai)
- Branch: `feat/jarvis-v2`
- Scope: Gemini / Groq / 硅基流动 / OpenRouter / Cloudflare Workers AI / Edge TTS
- Result: **代码路径与本地 mock 验收通过；真实云端账号调用待用户 Key**
- Provider guide: [providers.md](providers.md)

## 1. 实现结果

| 厂商 | LLM | ASR | TTS | 实现方式 |
|---|---|---|---|---|
| Gemini | ✅ | ✅ | ✅ | LLM 走 OpenAI 兼容；音频走原生 `generateContent` adapter |
| Groq | ✅ | ✅ | ✅（仅英/阿） | 全部 OpenAI 兼容；中文 TTS 受厂商模型限制 |
| 硅基流动 | ✅ | — | ✅ | LLM/TTS OpenAI 兼容；当前无标准 ASR 端点 |
| OpenRouter | ✅ | — | — | 仅 LLM；免费模型每日限流 |
| Cloudflare | ✅ | ✅ | ✅ | 账号模型搜索 + `/ai/run` 原生音频 adapter |
| Edge TTS | — | — | ✅ | 本机 `edge-tts` 命令 + ffmpeg 转 WAV |
| 本地 | ✅ | ✅ | ✅ | Ollama / faster-whisper / Piper |

“—”表示厂商当前没有对应公开端点，或该能力不在本适配范围；不是静默失败。

## 2. 验证记录

### 自动化

```text
npm run typecheck     clean
TZ=Asia/Shanghai npm test
  tests 86, pass 86, fail 0
npm run ui:smoke
  checked: home, settings, brief, studio, mobile
  browserErrors: 0
```

新增测试：

- `test/voice-providers.test.ts`（6）
  - Gemini ASR：模型路径、`x-goog-api-key`、`inline_data`、candidate text
  - Gemini TTS：`responseModalities`、voice、PCM → WAV（24 kHz）
  - Cloudflare ASR：账号 `/ai/run`、原始 WAV、Bearer、`result.text`
  - Cloudflare TTS：`{prompt,lang}`、二进制 WAV
  - voice settings：Edge 无 Base URL、模型默认值、Gemini 强制 HTTP
  - Edge：命令存在性
- `test/cloudflare.test.ts`（3）
  - Base URL / 模型搜索 URL
  - 文本模型过滤（排除 whisper/embedding）
  - 401/403 权限错误

### 真实 Edge TTS

本机实际执行：

```text
edge-tts 7.3.1
voice: zh-CN-XiaoxiaoNeural
text: 你好，Jarvis。
output: 63,054 bytes WAV
```

说明本机命令、MP3 生成、ffmpeg 转 WAV 路径可用。

### UI

设置 → 语音模型页包含 ASR/TTS 服务商下拉：

- ASR：自动 / OpenAI 兼容 / Gemini / Cloudflare
- TTS：自动 / OpenAI 兼容 / Gemini / Cloudflare / Edge

`ui:smoke` 额外断言：Edge 选中后隐藏 Base URL/Key，并自动填入
`edge-tts` 与 `zh-CN-XiaoxiaoNeural`。

## 3. 未验证的部分（诚实边界）

没有真实 Gemini、Groq、硅基流动、OpenRouter、Cloudflare 账号 Key，因此：

- 未对真实云端做端到端请求；mock 只验证 Jarvis 发出的协议形状与响应解析。
- 未验证各厂商当前账号的具体模型名、免费额度、429/402 行为和区域可用性。
- 未验证 Gemini 原生 Transcribe/TTS 在免费层的实际音质与限流。
- 未验证 Cloudflare 账号模型搜索的真实返回结构在所有账号类型下一致。
- 未验证 Edge TTS 在不同网络环境下的稳定性（Edge 无官方 SLA）。

真实接入时，先在小账号用一条短文本/短音频验证，再切为默认。

## 4. 残余风险

1. 厂商原生音频 API 可能改字段或模型名；错误会显式返回，不会静默降级。
2. Cloudflare Base URL 必须含账号 ID；填错会在连接测试阶段失败。
3. Groq TTS 只有英文/阿拉伯语，中文会听起来不对；不要把它作为中文默认。
4. 硅基流动 ASR 与 OpenRouter 音频没有公开标准端点，Jarvis 不会伪装支持。
5. Edge TTS 依赖本机 `edge-tts` 与网络，属于非官方路径；生产应保留本地 Piper 回退。
6. 所有云端免费层都可能使用数据改进服务；敏感内容必须走本地。
