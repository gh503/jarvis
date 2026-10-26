# Jarvis v2 — LLM 接口、协议与模型发现

- Status: implemented
- Code: `v2/src/model/{settings,openai,anthropic,ollama,router}.ts`
- UI: 设置 → 模型来源
- Tests: `v2/test/{openai,anthropic,ollama,model-settings}.test.ts`

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
模型名变成自由文本输入**，所以这类服务需要在上游补 `/models`（或使用支持
模型发现的网关）。

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

## 5. 已知缺口

- 不支持 OpenAI Responses 的 tools/structured outputs；当前只用文本 + 图片。
- 不支持 Anthropic prompt caching / extended thinking 参数。
- 模型发现没有分页；超过 200 个模型会截断。
- Azure OpenAI 的部署名和 `api-key` 头需要单独 adapter。
- 切换 embedding 模型不会自动重建向量索引；需要 `npm run memory:reindex`（或删除投影后重建）。
