# 模型服务配置指南

> 应用内页面：<http://127.0.0.1:3081/providers>（不用登录也能看）。
> 目录数据在 `src/model/catalog.ts`，页面、`/api/providers/catalog` 和本文档
> 都指向同一份内容；`npm test` 会检查每个条目都在这里出现。

## 0. 先弄清三件事

1. **Jarvis 不带模型额度。** 它是客户端：你提供 API Key，请求从你的电脑直接发往供应商。
2. **可以配多个供应商，按优先级自动切换。** 额度不足（402/429）、Key 失效（401）、
   网络不通时会自动换下一个，并在对话里提示。
3. **Key 只存在本机。** `data/model-config.json`，权限 0600，不进备份、不进导出、不回显。

## 1. 三步接入（所有供应商都一样）

1. 在供应商控制台创建 API Key。
2. 在应用里点“用这个供应商”，地址/协议/模型自动填好。
3. 粘贴 Key → “添加” → 把新供应商拖到优先级第一位 → 保存。

“获取模型列表”会读供应商的 `GET /models`；列表读不到时（如 Anthropic），手填模型名。

## 2. 选哪个：按需求而不是按名气

| 需求 | 建议 | 原因 |
|---|---|---|
| 不想花钱，电脑还行 | 本机 Ollama `qwen2.5:3b` | 不出网、无调用费；8 GB 内存可跑 |
| 不想花钱，电脑一般 | 硅基流动 / 智谱免费模型 / Gemini 免费层 | 免费层有速率限制，够日常问答 |
| 中文写作、日常办公 | DeepSeek、通义千问、Kimi | 国内直连、便宜、中文自然 |
| 长文档总结 | Kimi（32k/128k）、通义千问 long | 上下文长，按量计费 |
| 代码与重构 | Claude、DeepSeek、GLM | 长上下文 + 工具调用稳定 |
| 又便宜又要快 | Groq（需网络）、硅基流动 | 推理速度快 |
| 图片理解 | Gemini、通义千问 VL、Step | 需要单独填“视觉模型” |
| 已经有 GPU | vLLM 自建 | 无调用费，内网可用 |

**别把不稳定的供应商设成唯一项。** 至少配两个，第二个可以是本机 Ollama——
远端挂了也能继续用。

## 3. 国内供应商

### DeepSeek
- 地址：`https://api.deepseek.com/v1` · 协议：Chat Completions
- Key：<https://platform.deepseek.com/api_keys>
- 模型：`deepseek-chat`（日常）、`deepseek-reasoner`（推理）
- 费用：新账号有试用额度，之后按量；价格低于多数国际供应商
- 注意：余额为 0 时全部请求 402，Jarvis 会提示并可自动切换

### 硅基流动 SiliconFlow
- 地址：`https://api.siliconflow.cn/v1`
- Key：<https://cloud.siliconflow.cn/account/ak>
- 模型：从 `/models` 选，名字带前缀（`deepseek-ai/…`、`Qwen/…`）
- 费用：部分开源模型免费；也有极便宜的按量模型
- 额外：同一地址可作语音合成（CosyVoice）

### 通义千问（阿里云百炼）
- 地址：`https://dashscope.aliyuncs.com/compatible-mode/v1`（**必须**是 compatible-mode）
- Key：<https://bailian.console.aliyun.com/>
- 模型：`qwen-plus`、`qwen-max`；视觉用 `qwen-vl-*`
- 注意：百炼是订阅+按量混合计费，欠费直接 403

### 智谱 GLM
- 地址：`https://open.bigmodel.cn/api/paas/v4`（结尾是 `/v4`）
- Key：<https://open.bigmodel.cn/usercenter/apikeys>
- 模型：`glm-4-plus`，或免费的轻量模型
- 注意：免费模型有并发限制

### Kimi（月之暗面）
- 地址：`https://api.moonshot.cn/v1`
- Key：<https://platform.moonshot.cn/console/api-keys>
- 模型：`moonshot-v1-8k` / `-32k` / `-128k`
- 注意：上下文越长越贵，长文档场景注意额度

### 火山方舟（豆包）
- 地址：`https://ark.cn-beijing.volces.com/api/v3`
- Key：<https://console.volcengine.com/ark>
- 模型：**不是模型名，是控制台创建的推理接入点 ID（`ep-…`）**
- 注意：不提供 OpenAI 风格的模型列表，必须手填接入点 ID

### 腾讯混元
- 地址：`https://api.hunyuan.cloud.tencent.com/v1`
- Key：<https://console.cloud.tencent.com/hunyuan/api-key>
- 模型：`hunyuan-turbos-latest` 等
- 注意：要先在控制台“开通服务”，否则有 Key 也会报未开通

### 百度千帆（文心）
- 地址：`https://qianfan.baidubce.com/v2`
- Key：<https://console.bce.baidu.com/iam/#/iam/apikey/list>（IAM API Key，不是 AK/SK）
- 模型：从列表选；手填容易遇到版本后缀
- 注意：旧版千帆地址不走 OpenAI 协议

### MiniMax
- 地址：`https://api.minimaxi.com/v1`
- Key：<https://platform.minimaxi.com/user-center/basic-information/interface-key>
- 模型：`MiniMax-Text-01` 等；语音合成另有端点
- 注意：新域名为 `minimaxi.com`，老文档里的 `minimax.chat` 可能逐步迁移

### 阶跃星辰 StepFun
- 地址：`https://api.stepfun.com/v1`
- Key：<https://platform.stepfun.com/interface-key>
- 模型：`step-2-16k`；视觉 `step-1v-*`（填到“视觉模型”）

### 百川智能
- 地址：`https://api.baichuan-ai.com/v1`
- Key：<https://platform.baichuan-ai.com/console/apikey>
- 模型：`Baichuan4` 等
- 注意：部分模型需要企业认证

## 4. 国际供应商

> 中国大陆无法直连；需要自备合规网络。系统级代理请设 `HTTPS_PROXY`，
> **不要**把代理地址写进 Base URL。

### OpenAI
- 地址：`https://api.openai.com/v1` · Key：<https://platform.openai.com/api-keys>
- 模型：`gpt-4o-mini` 起步，按需要换
- 费用：无免费额度，需绑卡

### Anthropic Claude
- 地址：`https://api.anthropic.com` · 协议：**Anthropic Messages**（不是 OpenAI 兼容）
- Key：<https://console.anthropic.com/settings/keys>
- 模型：`claude-sonnet-4-5` 等，手填
- 注意：协议选错会 404；该厂商没有 OpenAI 风格模型列表

### Google Gemini
- 地址：`https://generativelanguage.googleapis.com/v1beta/openai/`（结尾斜杠）
- Key：<https://aistudio.google.com/apikey>
- 模型：从列表选 `gemini-…-flash`
- 注意：免费层数据会被用于改进产品，隐私内容换付费层或本机模型

### OpenRouter
- 地址：`https://openrouter.ai/api/v1` · Key：<https://openrouter.ai/keys>
- 模型：`厂商/模型`，加 `:free` 用免费额度
- 用途：先横向比价再决定长期用谁

### Groq
- 地址：`https://api.groq.com/openai/v1` · Key：<https://console.groq.com/keys>
- 模型：`llama-3.3-70b-versatile` 等
- 额外：语音识别可用 `whisper-large-v3`；TTS 只有英文/阿拉伯语

### Mistral
- 地址：`https://api.mistral.ai/v1` · Key：<https://console.mistral.ai/api-keys>
- 模型：`mistral-large-latest` / `mistral-small-latest`

### xAI Grok
- 地址：`https://api.x.ai/v1` · Key：<https://console.x.ai/>
- 模型：`grok-4` 等

### Together AI
- 地址：`https://api.together.xyz/v1` · Key：<https://api.together.xyz/settings/api-keys>
- 模型：开源模型托管，名字形如 `meta-llama/…`

### Fireworks AI
- 地址：`https://api.fireworks.ai/inference/v1`（少 `/inference` 会 404）
- Key：<https://fireworks.ai/account/api-keys>

### Cloudflare Workers AI
- 地址：`https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`
- Token：<https://dash.cloudflare.com/profile/api-tokens>（需 Workers AI 权限）
- 模型：`@cf/…`，用 Jarvis 的账号级搜索列出
- 费用：每天有免费 Neurons 配额

## 5. 本机 / 自建

### Ollama
- 地址：`http://127.0.0.1:11434`（Ollama 原生协议）
- 安装：<https://ollama.com/download> → `ollama pull qwen2.5:3b`
- 显存 8 GB+ 可换 7B/14B；CPU 也能跑 3B，只是慢

### LM Studio
- 地址：`http://127.0.0.1:1234/v1`，Key 可留空
- 必须先点 “Start Server”

### vLLM / 自建
- 地址：本机 `http://127.0.0.1:8000/v1`；局域网换成 `http://<内网IP>:8000/v1`
- 局域网地址要加进 `JARVIS_ALLOWED_HOSTS`，否则页面返回 421

## 6. 常见错误码

| 状态 | 含义 | Jarvis 的处理 |
|---|---|---|
| 401 | Key 无效/过期 | 冷却 24 小时并切下一个 |
| 402 | 余额不足 | 冷却 30 分钟并切下一个 |
| 403 | 未开通/欠费/地区限制 | 视为不可用并切换 |
| 404 | 地址或模型名错 | 不切换，提示检查配置 |
| 429 | 限流 | 冷却 60 秒并切换 |
| 5xx | 供应商故障 | 冷却 5 分钟并切换 |

## 7. 想换供应商但保留历史

换模型不影响记忆和历史；对话上下文按会话保存。切换后建议在“场景”里
给不同任务指定不同供应商（例如代码走 Claude、日常走 DeepSeek）。
