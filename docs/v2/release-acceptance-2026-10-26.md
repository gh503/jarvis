# Jarvis v2 发布验收报告

- 日期：2026-10-26（Asia/Shanghai）
- 分支：`feat/jarvis-v2`
- 基线：`1aeeccd` + 本次验收修复（与本报告同批提交）
- 环境：Ubuntu 22.04.5 / Wayland / Node v24.14.0 / Chrome headless CDP
- 主机：单用户、本机优先；监听 `http://127.0.0.1:3081`

## 1. 结论

**通过：可以投入单用户本机生产使用。**

放行范围是“一个所有者、一台 Linux 主机、本地 SQLite、本地模型优先”的日常办公助手。
远端模型/语音、TLS 远程访问、PWA 手机入口也已验证，但只建议在私有网络 + TLS +
令牌的前提下使用。真实云端服务商、真实手机和 GNOME Portal 的人工授权弹窗仍属于
“已设计、未用真实外部账号/真机反复压测”的边界，见 §7。

本次验收没有发现阻断发布的 P0/P1 缺陷；发现的 4xx/5xx 语义、取消重复、工作进程
崩溃、启动卡住、清理遗漏、移动端触控目标、导出误触和远端视觉外发风险均已修复并
回归。

## 2. 自动化结果

| 命令/检查 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | 通过 | `tsc --noEmit`，0 错误 |
| `TZ=Asia/Shanghai npm test` | **77/77 通过** | 0 fail / 0 cancelled / 0 skipped |
| `npm run acceptance` | 通过 | 文字、跨域拒绝、记忆写入/召回/删除、确认式动作、提醒、OCR、语音 ASR→LLM→TTS |
| `npm run doctor` | 核心检查全部通过 | Node、配置、Ollama、LLM/视觉/embedding、ffmpeg、arecord、摄像头、Piper、faster-whisper、RapidOCR、Portal helper、数据库 |
| `npm run memory:eval` | **11/11 通过** | hit@1 = 7；abstain 4/4；`privacyLeaks = 0` |
| `npm run ui:smoke` | 通过 | 主界面、设置、简报、Studio、390px 移动端；浏览器错误 0 |

## 3. 功能验收矩阵

### 3.1 对话与模型

- 本地 Ollama `qwen2.5:3b`：文字回合、流式 UI、健康状态、首轮/热轮均可用。
- 远端 OpenAI Chat Completions：mock 端到端通过，回复正确。
- 远端 OpenAI Responses：mock 端到端通过，SSE `response.output_text.delta` 正确消费。
- 远端 Anthropic Messages：mock 端到端通过，`x-api-key`、system 消息、SSE text delta 正确。
- 模型列表自动发现：Ollama `/api/tags` 与三类远端 `/models` 均可拉取；UI 不允许手输模型名。
- 模型切换：测试连接 → 保存并切换；失败时恢复**持久化配置与运行时**，不会留下半切换状态。
- 无 Key 的本机 loopback 远端地址允许保存/切换；无 Key 的非 loopback 远端在切换前拒绝，
  不会先发网络请求再失败。
- 输入边界：`/api/chat` 8000 字、`/api/memory` 8000 字、`/api/reminders` 500 字；
  HTTP 返回 400，WebSocket 返回错误事件且连接保持；WS 帧上限 256 KiB，超限 1009 关闭。
- 错误语义：坏 JSON 400、超大 body 413、坏 URI 400、缺失资源 404、未知配置 id 400；
  5xx 只返回通用 `internal error`，不泄漏堆栈。

### 3.2 语音

- 本地：faster-whisper ASR + Piper TTS，浏览器按住说话（fake mic）实测
  `听到：你好我是 Jarvis,你好。`，回复与音频均正确。
- 远端 ASR WebSocket（默认）：`start → PCM → end → final` 契约实测通过。
- 远端 ASR HTTP：`POST /audio/transcriptions` multipart 实测通过。
- 远端 TTS：`POST /audio/speech` 返回音频并落盘，`audioUrl` 可播放。
- 本地/远端 ASR 与 TTS 两侧独立切换；切换不影响当前对话。
- 取消：只发一次 cancel，不再重复 assistant 气泡；取消后旧音频不再播放。
- 工作进程崩溃/管道断开：ASR、OCR、Piper 的 EPIPE 不再导致主进程退出；
  TTS 预热失败会把 `tts` 就绪标记为 false，而不是假装可用。

### 3.3 记忆（五类）与 Studio

- working：当前轮上下文按预算裁剪，敏感记忆默认排除。
- episodic：每轮结束写回合摘要；隐私擦除会清空。
- semantic：显式记住/后台 proposed 候选/确认/拒绝/删除/冲突更新/巩固。
- procedural：启动、切换模型等步骤型记忆可写入与召回。
- prospective：提醒与“待兑现”记忆可查询、完成。
- 混合召回：FTS + 向量 + 重要度/时间/置信度；未知问题正确弃权；
  sensitive/secret 默认弃权，显式允许时命中。
- 导出：全量 SQL 导出，不再被 UI 的 200 条分页上限截断（205 条回归）。
- Studio：总览、记忆星座、Inspector、筛选、召回实验台、调参、脱敏配置、事件流；
  浏览器 smoke 无错误。

### 3.4 主动性与感官

- 提醒：不同时区偏移的 ISO 时间按数值排序/到期，不再按字符串误判；
  调度器在 WebSocket/通知监听器就绪后启动，不会吞掉启动瞬间的提醒。
- 专注/免打扰/每日语音预算：提醒被拦截时只进面板，不出声。
- 每日简报：提醒 + 相关记忆 + 可选只读 ICS；08:30 调度。
- 屏幕：XDG Portal 单帧 + OCR；Portal 拒绝不绕过；X11 仅作为受控回退。
- 摄像头：`/dev/video0` 单帧，不录视频；画面卡片可删除；1 小时后清理。
- 远端视觉：默认直接拒绝采集，不把屏幕/摄像头画面发给远端；
  只有服务端显式 `JARVIS_ALLOW_REMOTE_VISION=1` 才放行。OCR 文本同样视为屏幕内容。

### 3.5 安全与隐私

- 默认只监听 loopback；非 loopback 必须 TLS + ≥24 字符 `JARVIS_AUTH_TOKEN`，否则启动失败。
- 非 loopback 无令牌 401、错令牌 401、Bearer/Cookie 通过；`?token=` 只用于设置
  HttpOnly/Secure/SameSite=Strict cookie，API 查询参数令牌被拒绝。
- Cookie 修复后，`<audio>` / `<img>` 媒体请求可鉴权；service worker 不缓存带 token 的 URL。
- 设备配对：6 位一次性码、5 分钟、最多 5 次尝试；成功写入设备哈希，重放 401；
  撤销立即生效；连续失败触发 429。
- 同源 CSRF：跨源 POST 403；WebSocket 校验 Origin，错误 Origin 401。
- 路径穿越返回 404；缺失 memory/confirm/reject/reminder 返回 404。
- HSTS、CSP、`X-Frame-Options: DENY`、`nosniff`、Referrer-Policy、Permissions-Policy 均存在。
- 数据文件 0600、目录 0700；captures/audio/telemetry AES-256-GCM；DB 明文边界在
  `security.md` 中明确说明，不假装全库加密。
- 隐私擦除：清空记忆、提醒、动作审计、音频、画面、trace 与 telemetry 轮转文件；
  撤销全部设备；轮换 `secret.key`；保留配置与令牌；必须输入中文短语确认。
- 导出增加内联二次确认（包含 sensitive/secret 的提醒），不再一点即下载。

### 3.6 运维与客户端

- 备份：SQLite `VACUUM INTO` 一致快照，归档 0600，含 manifest；默认不含密钥/音频/画面/日志。
- 恢复：拒绝覆盖运行中的实例；完整性检查；拒绝恶意归档路径；目标目录 0700。
- 重启持久化：记忆、提醒、配置、设备在重启后保留；已删除数据不复活。
- PWA：`jarvis-shell-v9` 离线壳可加载；API 离线按设计失败；缓存中无 token URL。
- 移动端 390×844：无横向溢出；输入/按钮主要触控目标 ≥42px；
  设置页签、设备配对、导出/擦除确认均可操作。
- 设置交互：页签 ARIA/键盘、Escape 关闭、脏状态提示、焦点返回、窄屏单列；
  设备命名/擦除/导出均改为内联控件，不再依赖原生 `prompt`。
- 启动：模型预热最多等 8 秒；Ollama 卡住时 HTTP 仍会起来并记录
  `model warm-up deferred`；首轮可能是冷加载，但不会让服务“消失”。

## 4. 本次修复的缺陷（摘要）

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | 坏 JSON / 超大 body / 坏 URI 返回 500 | 400 / 413 / 400，5xx 不再泄漏内部错误 |
| 2 | 缺失 memory/confirm/reject/reminder 仍返回成功 | 统一 404 |
| 3 | 提醒混合时区按字符串排序，可能漏到期 | 数值 `Date.parse` 排序/过滤 |
| 4 | 启动调度器早于监听器，启动瞬间提醒被吞 | 调整启动顺序 |
| 5 | 取消产生重复气泡/多次停止 | 服务端幂等 cancel + 客户端单次发送 |
| 6 | ASR/OCR/Piper 管道断开导致进程崩溃 | stdin/stdout error + EPIPE 防护 |
| 7 | TTS 预热失败仍显示 ready | 失败置 false，`speak()` 直接跳过 |
| 8 | 隐私导出被 200 条分页截断 | 全量 SQL 导出 |
| 9 | 擦除漏掉 `telemetry.jsonl.1` | 删除轮转文件并重置 trace |
| 10 | 恢复目录权限 775 | 改为 700 |
| 11 | SW 旧缓存/可能缓存 token URL | 升到 v9，跳过含 token 的 URL |
| 12 | 远端 token 只存 localStorage，媒体元素 401 | 用 `/?token=` 设置 HttpOnly cookie |
| 13 | 模型 apply 失败后运行时仍是半切换 | 回滚持久化配置 + `restoreModelRuntime` |
| 14 | 无 Key 远端先发网络请求再报错 | `assertActivatable` 预检 |
| 15 | 输入无上限，可能拖垮上下文/数据库 | chat/memory/reminder 上限 + WS 帧上限 |
| 16 | Ollama 预热卡住导致启动拖 20–60 s | 8 s raced warmup，先监听 |
| 17 | 移动端按钮 21–38px、设置页溢出 | 42px 目标、单列、可换行 |
| 18 | 设置关闭丢焦点、设备命名/擦除用原生 prompt | opener/focus 恢复、内联控件 |
| 19 | 远端视觉可能把桌面截图发给服务商 | 服务端默认拒绝 + UI/文档警告 + 显式 env 才放行 |
| 20 | 导出一点即下载含敏感记忆 | 内联二次确认 |
| 21 | 验收脚本的召回断言可能假阳性 | 改为检查标记 `ORBIT-42` 消失 |

## 5. 未覆盖 / 残余风险

1. **GNOME Portal 的人工授权弹窗**没有在 CI 中自动点击。屏幕 OCR 使用固定图片和
   真实 Portal helper 验证；摄像头单帧在本机验证；但“人第一次点允许共享”的完整
   桌面路径仍需真人在场验收。Portal 拒绝/超时路径已测。
2. **没有真实云端 API Key**。三种协议用本机 mock 做线级 E2E，能验证请求形状、鉴权头、
   SSE 解析、错误和回滚；不能替代对具体服务商（尤其 Azure 专有头、区域部署名、
   限流/内容审核）的账号级验收。
3. **真实手机/PWA 真机**未做长期压测；本次用 390×844 headless Chrome 和离线缓存
   验证布局/离线壳，iOS Safari 的 MediaRecorder 差异仍需真机确认。
4. **视觉模型很慢**：4 GB 显存下 `qwen2.5vl:3b` 可能 40–150 s；默认 OCR-first，
   远端视觉默认关闭。不要把它当实时主路径。
5. **DB 明文**：记忆主库未做页级加密；captures/audio/telemetry 才做静态加密。
   单用户本机威胁模型下接受，但磁盘被复制时记忆内容可见；见 `security.md`。
6. **设备令牌等价主令牌**，没有逐设备权限范围；撤销是唯一的细粒度控制。
7. **没有 VAD/唤醒词/AEC/WebRTC**；浏览器仍是整段录音上传，不是实时音频流。
8. **单机单用户**；没有多租户、集群、跨设备同步或高可用。
9. 少数非破坏性流程仍使用原生 `window.confirm`（脏设置关闭、模型切换、首次引导、
   Studio 删除等）。正常浏览器可用；headless 自动化会覆盖/规避，不作为产品缺陷。

## 6. 最终清理状态

验收结束后执行了设置页的“删除全部对话与记忆”（输入“删除全部”），并复核：

- 记忆 0、提醒 0、动作/确认 0、trace 0。
- `data/captures`、`data/audio` 为空，权限 0700。
- `telemetry.jsonl` 及轮转文件、`audit/actions.jsonl`、`devices.json` 已删除。
- `secret.key` 已轮换，0600；`jarvis.db` 0600。
- 模型恢复为**本地 Ollama `qwen2.5:3b`**；远端配置为占位默认（DeepSeek 地址、
  `deepseek-chat`、无 Key、未激活）。
- 语音恢复为**本地 faster-whisper + 本地 Piper**；远端地址/Key 已清空。
- 调参为默认值；没有配对设备。
- 验收用的 QA/TLS/恢复实例、LLM/语音 mock 和 headless Chrome 已停止；
  `/tmp` 验收数据已清理。实际服务仍为 `http://127.0.0.1:3081`。

## 7. 复现命令

```bash
cd ~/jarvis/v2
npm run typecheck
TZ=Asia/Shanghai npm test
npm run doctor
npm run acceptance
npm run memory:eval
JARVIS_CDP_URL=http://127.0.0.1:9223 npm run ui:smoke
```

远端/语音/认证矩阵需要对应的 mock 或测试实例；本报告使用的 mock 端口为
4010（LLM）、4012（voice），QA 端口 3091/3093/3094。它们不属于生产进程。

## 8. 放行决定

- **单用户本机生产：放行。**
- **私有网络远程访问：有条件放行**：必须 TLS + ≥24 字符令牌；建议 Tailscale/私网，
  不要直接暴露公网；设备令牌按主令牌对待。
- **真实云端服务商/真实手机/真实 Portal**：在完成一次人工账号级验收前，不作为
  已完全验收项；代码路径和失败回退已就绪。
