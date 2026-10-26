# Jarvis v2 — LLM 接口、协议与模型发现

- Status: implemented
- Code: `src/model/{settings,openai,anthropic,ollama,router}.ts`
- UI: 设置 → 模型来源
- Tests: `test/{openai,anthropic,ollama,model-settings}.test.ts`

## 1. 三种远端协议

Jarvis 不假设“远端就是 OpenAI Chat Completions”。配置里有一个显式的
`protocol` 字段，它和 Base URL、模型一起持久化在
`data/model-config.json`（0600）：

| 协议 | 值 | 请求 | 流式回复 |
|---|---|---|---|
| OpenAI Chat Completions | `chat-completions` | `POST /chat/completions` | SSE `choices[].delta.content` |
| OpenAI Responses | `responses` | `POST /responses` | SSE `response.output_text.delta` |
| Anthropic Messages | `anthropic` | `POST /messages`，`x-api-key` + `anthropic-version: 2023-06-01` | SSE `content_block_delta.delta.text` |

本地 Ollama 走原生 `/api/chat`，不参与这个三选一；它的状态协议是
`ollama`。

### Base URL 归一化

客户端接受“服务根地址”“带 `/v1` 的地址”和“完整端点”三种写法：

- `https://api.openai.com` → `/v1/chat/completions` 或 `/v1/responses`
- `https://api.deepseek.com/v1` → `/v1/chat/completions`
- `https://api.anthropic.com` → `/v1/messages`
- 已经以 `/chat/completions`、`/responses`、`/messages` 或 `/models` 结尾时，
  不会重复拼接。

非 loopback 地址强制 HTTPS；只有 `localhost` / `127.0.0.1` / `::1` 允许
HTTP，方便本机 vLLM、LM Studio、Ollama `/v1`。地址里禁止用户名密码、
查询参数和锚点，避免密钥进入 URL/代理日志。

## 2. 模型列表自动发现

设置页不再让人手打模型名。打开设置、切换卡片、改 Base URL / 协议/Key 后，
前端会调用：

```http
POST /api/model/list
content-type: application/json

{"id":"remote","kind":"openai","protocol":"anthropic",
 "baseUrl":"https://api.anthropic.com/v1","apiKey":"sk-ant-..."}
```

服务端用同一套客户端做发现，返回 `{ok, models: string[], error?}`：

| 来源 | 发现请求 | 解析 |
|---|---|---|
| Ollama | `GET /api/tags` | `models[].name` |
| Chat Completions / Responses | `GET /models` | `data[].id`（也兼容 `models[]`） |
| Cloudflare Workers AI | `GET /client/v4/accounts/<id>/ai/models/search` | `result[]`，过滤文本生成模型 |
| Anthropic Messages | `GET /v1/models` | `data[].id` / `display_name` |

UI 把结果放进 `<select>`，当前模型预选中；没有结果时保留当前值并显示原因。
`POST /api/model/test` 也会返回 `models`，测试成功后同样刷新选择器。

Key 仍然是“留空表示保留已保存的 Key”；换 Base URL 时如果留空 Key，服务端
会拒绝，避免把旧密钥发给新地址。`/api/model/list` 只在内存中使用 Key，不写
日志、不回显。

### 没有 `/models` 的服务

部分兼容网关不实现 `GET /models`。发现会返回
`服务没有 /models，无法自动列出模型`，这是明确的可解释失败，不会静默显示
空列表。此时仍可用“测试连接”做一次极小的聊天请求验证；但**本版坚持不把
模型名变成自由文本输入**，所以这类服务需要在上游补 `/models`。

Cloudflare Workers AI 是例外：它没有 OpenAI `/models`，但有账号级模型搜索，
`src/model/cloudflare.ts` 把它映射成同一份 `ModelHealth` 列表。Base URL
必须包含 `/client/v4/accounts/<ACCOUNT_ID>/ai/v1`。

## 3. 测试与切换

- **测试连接**：`health()` 做 `/models` 探测，再发一句 `只回复：ok` 的极小
  请求（`max_tokens=8`）；远端协议不通过就不写盘。
- **保存并切换**：测试成功 → 写 `model-config.json` → 替换内存客户端 →
  下一轮对话立即使用；失败保留旧配置。
- **切换已保存配置**：只走已保存的 profile，不重新测试；远端没有 Key 时
  拒绝激活。
- **回退**：远端没有配置 `embedModel` / `visionModel` 时，记忆 embedding 和
  摄像头视觉复用本地 Ollama；本地也不可用时，记忆退化为词法召回，视觉路径
  返回明确错误。
- **Anthropic 没有第一方 embedding**：`embed()` 返回 `null`，由路由器回退到
  本地 embedding；不会伪造成远端向量。

## 4. 安全边界

- Key 只存在 `data/model-config.json`（0600）；公开接口只返回 `hasKey`。
- Key 不进入浏览器 DOM（`type=password`，不回填）、不进入日志、不进入导出
  默认字段。
- 远端模型会收到当前对话和按需检索的记忆上下文；`sensitive` / `secret`
  记忆在构建上下文时被过滤。切换前的隐私提示在设置页和 `security.md`。
- 不实现任意自定义 header / Azure `api-key` 专有头；需要时加协议适配器，
  不在 UI 里开放任意 header（那会把密钥泄漏面扩大）。

## 5. 供应商池、优先级与自动切换（failover）

模型配置不再限于 local/remote 两个槽位：`POST /api/model/profile/add` 可添加任意多个
远端供应商（id 为小写字母/数字/连字符）。每个供应商有独立的 Base URL、协议、Key 和
模型；Key 之间完全隔离，互不可见。

### 优先级链

`priority` 是按顺序的供应商 id 列表（设置页卡片上的 ↑↓ 调整）。每次请求从链头开始
尝试，跳过处于冷却中的供应商；全部冷却时仍按原顺序重试（冷却可能已过时，例如免费
额度已重置）。手动「保存并切换」会把该供应商置顶并清除它的冷却。

### 错误分类与冷却

只有「供应商当前不可用」类错误才会切换；请求本身有问题（4xx client）不会静默转移：

| 分类 | 判定 | 冷却时长 |
|---|---|---|
| quota | HTTP 402 / insufficient balance / 额度不足 | 30 分钟 |
| rate-limit | HTTP 429 / rate limit | 1 分钟 |
| auth | HTTP 401/403 / invalid api key | 24 小时 |
| network | fetch failed / 超时 / 连接拒绝 | 2 分钟 |
| server | HTTP 5xx | 5 分钟 |

冷却持久化在 `model-config.json` 的 `cooldowns` 字段，重启不失效；切换事件
`model.failover` 通过 SSE 推送到 UI（系统消息提示「已自动切换到 …」）。
流式回复一旦已经产出内容就**不再重试**（避免重复输出），整段未产出时才转移到
下一家。 embedding 和视觉不做跨供应商 failover——向量维度不同，画面默认不出网。

### 工作场景

内置场景：日常对话 / 编程开发 / 写作翻译 / 深度分析。每个场景可配置：

- 供应商链（不配置 = 跟随全局优先级）
- 模型覆盖（该场景下用这个模型名）
- 温度、注入系统提示的场景指令、参与自动识别的关键词

`scenarioAuto` 开启时按消息内容确定性识别（代码围栏/语言后缀/报错堆栈 → 编程；
翻译/润色 → 写作；分析/推理 → 深度分析），识别不到就回默认场景。输入框旁的
「场景」下拉可手动指定本轮场景；`POST /api/chat` 与 WS chat 都接受 `scenario` 字段。
场景识别结果通过 `assistant.scenario` 事件显示在输入框下方。

## 6. 已知缺口

- failover 只在一次请求内部转移；已产出部分内容后失败会把半成品交给用户，不换下一家重跑。
- 不支持 OpenAI Responses 的 tools/structured outputs；当前只用文本 + 图片。
- 不支持 Anthropic prompt caching / extended thinking 参数。
- 模型发现没有分页；超过 200 个模型会截断。
- Azure OpenAI 的部署名和 `api-key` 头需要单独 adapter。
- Cloudflare 模型搜索只过滤文本生成任务；音频/embedding 模型不会出现在聊天模型下拉中（语音设置单独填写）。
- 切换 embedding 模型不会自动重建向量索引；需要 `npm run memory:reindex`（或删除投影后重建）。
