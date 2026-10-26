# Jarvis Studio — 观察台、记忆星座与调参

- Status: implemented in v2 (development surface)
- Code: `v2/web/studio.js`, `v2/web/studio.css`, `v2/web/visual.js`
- API: `v2/src/server.ts`, `v2/src/tuning.ts`, `v2/src/telemetry.ts`
- Entry: 顶栏波形图标 → **观察台**；或直接打开 `http://127.0.0.1:3081/`

## 1. 为什么不是一块“管理后台”

Jarvis 的日常界面应该只有光球、对话和结果。观察台是**开发/调试时的第二层**，解决三个具体问题：

1. **一次回合到底慢在哪**：ASR、召回、模型首字、首段语音、整轮，必须能拆开看。
2. **记忆为什么被召回/没被召回**：不能只给一个列表，要看到节点、关系、分数和解释。
3. **效果参数到底改了什么**：拖动参数后立即看到界面变化，再决定是否持久化。

因此 Studio 用“叙事 + 可下钻”而不是“几十个孤立指标”：

- 总览先回答“现在好吗”，再给趋势、最新回合瀑布、事件流和系统负载。
- 记忆页先给星座全景，点节点才展开来源、重要度分解和动作。
- 调参页左边改、右边实时预览；保存前不写盘。
- 配置页只读、脱敏，用来确认边界而不是改生产配置。

调研参考：Grafana 的 dashboard best-practice（少而可行动、按故事组织、支持下钻）、Langfuse 的 LLM observability（trace + metrics + logs 三层）、Letta 的 stateful-agent 记忆/状态视角。实现没有引入这些产品，只借用了信息架构。

## 2. 页面与交互

### 2.1 总览 Observatory

| 区块 | 回答的问题 |
|---|---|
| 6 个 KPI | 当前注意力、最近首字、最近整轮、长期记忆、语音就绪、系统负载 |
| 当前注意力 | 状态机现在在哪个状态；模型/语音是否 ready；听→想→说管线 |
| 延迟构成 | 最新回合的 ASR、首字、首段语音、整轮 |
| 延迟趋势 | 最近 42 回合的整轮/首字/首段语音折线 |
| 记忆构成 | 四种记忆类型的环图；进入星座 |
| 最新回合追踪 | 回合瀑布、召回条数、原始输入摘要 |
| 事件流 | 最近 10 条事件，按时间倒序 |
| 回合健康 | 成功率、错误、平均首字、语音/文本比、召回/捕获/动作计数 |
| 持久化回合 | 最近 12 个已完成回合；重启后仍可回看首字/整轮/状态 |
| 系统 | 运行时长、Node、load average、内存、RSS/heap、监听地址 |

### 2.2 记忆星座 Constellation

- 力导向布局：四种 kind 各自成簇，节点大小由重要度、使用次数、连接度共同决定。
- 边：
  - `similar`：有向量时用 cosine；没有向量时退化为字符重叠；每节点最多 3 条，阈值 0.58。
  - `supersedes`：新记忆取代旧记忆，琥珀色箭头。
  - `link`：`memory_links` 里的人工/巩固关系，紫色。
- 节点：实心=已确认；空心虚线环=候选；红边=secret；琥珀外圈=pinned；灰淡=非活跃。
- 交互：拖动平移、滚轮缩放、缩放按钮/复位、标签开关、kind/status/sensitivity 过滤、文本搜索。
- 侧栏 Inspector：摘要、正文、来源、置信度、使用次数、敏感级、时间、六维重要度分解、source ref；候选可确认/拒绝，任意节点可删除。
- 下方：
  - 21 天时间线；
  - 状态分布与 kind 环图；
  - **召回实验台**：输入真实查询，展示 score、semantic/importance/strength 条和 why 标签；
  - 记忆表格，按综合分排序；点行定位节点。

数据上限：`/api/memory/graph?limit=160`，服务端最多 200；相似边每节点最多 3 条，总边最多 320，避免浏览器布局爆炸。

### 2.3 调参实验室 Tuning

- 32 个参数，5 组：界面与动效、对话与模型、记忆召回、声音与语音、打扰与感知。
- 预设：平衡、沉浸、专注、省电。
- 控件：slider + 数字输入、toggle、select、text；每个参数标注生效范围（实时 / 下一轮 / 立即 / 重启）。
- **拖动即预览**：`ui.*` 参数通过 CSS 变量、canvas 粒子和 `body.zoom` 实时改变主界面。
- **保存才持久化**：脏状态显示“N 项未保存”；保存调用 `PUT /api/tuning`，写 `data/tuning.json`（0600，原子 rename）。
- 支持单组恢复默认、全部重置、放弃修改；关闭/切页时若有未保存修改会确认。
- 高级参数默认展开（开发阶段全部开放），可收起。

### 2.4 原始配置 Config

- 只读、脱敏：host/port、认证是否启用、令牌长度、TLS、模型 profile、语音路径、静默/预算/屏幕边界、运行时、数据/网页路径。
- **绝不返回** auth token、TLS 私钥内容、远端 API Key。
- 提供完整脱敏 JSON 复制，便于诊断。
- 仅回环时显示“开发工具”：加载/清除演示记忆。

### 2.5 事件流 Events

- 全部事件按时间倒序，支持对话/记忆/注意力/动作/模型过滤与搜索。
- 每条 `<details>` 展开原始 JSON（截断 6000 字符）。
- 可暂停轮询，便于阅读。

## 3. 指标定义

| 指标 | 定义 | 注意 |
|---|---|---|
| `firstTokenMs` | `turn.start` → 第一个 `assistant.delta` | 不含 ASR；模型冷加载会明显变大 |
| `firstAudioMs` | trace 起点 → 第一个 `assistant.audio` | trace 起点可能是 `voice.asr.start`，因此含 ASR |
| `totalMs` | `assistant.done.durationMs` | 文本回合在 TTS 入队前完成；音频可能稍后继续 |
| `asrMs` | `voice.asr.start` → `voice.transcribed` | 不是音频时长；是识别处理时间 |
| success | `assistant.done` 无 `error` | cancellation 单独标记 |
| error rate | 有 error 的 turn / 总 turn | 仅最近 80 个 trace，不是全生命周期 |
| recall confidence | `memory.recalled.confidence` | 用于观察召回质量，不是模型置信度 |
| load | `os.loadavg()` / CPU 核数 | 4 核机器上 >0.8 视为压力 |

采用 RED（Rate / Errors / Duration）+ USE（Utilization / Saturation / Errors）的简化版：回合率、错误、首字/整轮延迟；系统负载、内存、进程 RSS、事件量。

Telemetry 内存只保留最近 80 个 turn、30 次 recall、240 条事件；**已完成的回合**以 JSONL 追加到 `data/telemetry.jsonl`（0600，5 MB 滚动），重启后通过 `/api/traces` 读取。文件只含回合文本摘要和延迟，不含音频/截图；设置里的“删除全部本机数据”会删除它。

## 4. 调参架构

```
TuningStore(schema + values + presets)
  ├─ data/tuning.json (0600, atomic)
  ├─ config 可变字段（预算/静默/屏幕）
  ├─ Conversation 每轮读取（温度、历史、召回、切句、超时、追问）
  ├─ MemoryStore 每次召回读取（向量/词法门槛、候选、使用计数）
  ├─ AttentionManager 决策读取（“这个”默认屏幕）
  └─ PiperSynthesizer 重启 worker 读取（length/noise/maxChars）
```

- 所有值在服务端按 schema 校验/夹取；未知 key、非法 HH:MM、非法 select 都返回 400。
- `apply` 元数据只用于 UI 提示；真正的实时性由读取点决定。
- `ui.*` 没有服务端行为，只是持久化的界面配置；手机和桌面共用。
- 调参文件不含密钥；环境变量（端口、TLS、令牌、模型来源）仍由部署控制，避免把安全边界做成可点开关。

## 5. 安全

- 所有 Studio API 走既有认证/同源 CSRF 检查。
- `/api/config` 和 `/api/observatory` 不返回密钥；测试断言 token 不出现在响应里。
- `data/tuning.json` 用 0600、临时文件 + rename；SQLite 主库/WAL/SHM 也由运行时收紧为 0600（进程 umask 077）。
- 演示数据接口 `/api/dev/demo-memory` 仅接受 loopback 且必须带 `x-jarvis-demo: 1`；演示项 `sourceRef=demo:seed`，可一键清除，不触碰真实记忆。
- `/api/traces` 只返回已完成回合；trace 文本可能含用户原话，必须按本机隐私数据对待。
- 记忆图可能包含敏感内容；这是本机所有者视图，默认仍沿用单用户信任模型。远端浏览器访问时由既有 TLS + Bearer 保护。

## 6. 验收

```bash
cd v2
npm run typecheck
npm test
npm start
```

手工：

1. 顶栏打开观察台；发一条文字，总览出现首字/整轮与事件。
2. 记忆页加载演示数据 → 看到 13 节点、22 边、候选/敏感/取代三种视觉；点节点看 Inspector；召回“周五要做什么”出现两条和 why。
3. 调参页拖动“光球辉光/粒子/模糊”，主界面实时变化；保存后刷新仍保留；恢复默认。
4. 配置页确认无 token/Key；复制 JSON。
5. 事件页展开一条 `assistant.done`，核对 payload 与总览瀑布。
6. 发一条文本/语音后，总览底部“持久化回合”出现记录；重启服务后仍在。
7. 清除演示记忆，回到空状态。

## 7. 后续

- 把 telemetry 按天分文件并支持时间回放。
- 记忆图支持手动连线/取消连线、2-hop 聚焦。
- 调参已支持“默认值 → 草稿”的 A/B 对照；双栏并排运行、“仅本机/仅本次”临时覆盖仍待做。
- 离线巩固任务完成后，在记忆图里显示合并/衰减动画。

## 8. 参考

- Grafana, *Dashboard best practices* — 少而可行动的面板、按故事组织、支持下钻：<https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/>
- Langfuse, *Observability overview* — trace / metrics / logs 三层与 LLM 回合追踪：<https://langfuse.com/docs/observability/overview>
- Letta, *Stateful agents* — 把记忆、状态与工具调用放在同一 agent 生命周期里看：<https://docs.letta.com/guides/agents/overview>
