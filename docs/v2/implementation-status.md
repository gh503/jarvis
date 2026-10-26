# Jarvis v2 — 实现状态

- Date: 2026-10-26
- Branch: `feat/jarvis-v2`
- Runtime: `v2/`（TypeScript / Node 24 / SQLite / 本地 Web UI）
- Tests: 62 passing (`TZ=Asia/Shanghai npm test`), typecheck clean

## 1. 已实现并跑通

| 能力 | 代码 | 验证 |
|---|---|---|
| 配置、目录、令牌、TLS fail-closed | `v2/src/config.ts` | `npm run typecheck`；远端配置缺 TLS 会抛错 |
| 数据文件私有权限 | `v2/src/main.ts` (`umask 077`), `v2/src/memory/store.ts` | `test/memory-file.test.ts`；DB/WAL 0600 |
| 事件总线 / 脱敏日志 | `v2/src/events.ts`, `v2/src/logger.ts` | 单元测试 + 运行时日志 |
| 注意力状态机 + 上下文决策 | `v2/src/attention.ts` | `test/attention.test.ts` |
| SQLite 记忆源、FTS5、向量投影 | `v2/src/memory/store.ts` | `test/memory.test.ts` |
| 记忆召回评分 / 上下文渲染 | `v2/src/memory/recall.ts` | 短中文查询、敏感过滤、弃权、历史；proposed 可选召回 |
| 后台记忆抽取（proposed） | `v2/src/memory/extract.ts` | 显式“记住”不重复抽取；候选不自动确认 |
| 记忆巩固 / 冲突更新 / 评测 | `v2/src/memory/{store,update,eval}.ts`, `v2/eval/memory-cases.json` | 过期候选、精确去重、supersedes 链、嵌入修复；11 条评测全过、隐私泄漏 0；显式更新自动退休旧事实 |
| 语音打断与陈旧音频丢弃 | `v2/src/conversation.ts` | `speechEpoch` + turnId；取消后不再播旧音频；`test/conversation-cancel.test.ts` |
| 本地 LLM / embedding / 视觉 adapter | `v2/src/model/ollama.ts` | `qwen2.5:3b`, `nomic-embed-text` 实测 |
| 本地/远端模型切换（UI 一键） | `v2/src/model/{router,openai,settings}.ts`, `v2/web/app.js` | `test/{openai,model-settings}.test.ts`；mock 远端 + UI 实测 |
| 实时语音：PTT → ASR → LLM → TTS | `v2/src/voice/*`, `v2/src/conversation.ts` | `/api/voice` 实测首段语音 2.34 s、整轮 2.57 s（1.56 s 音频） |
| faster-whisper 持久 worker + 预热/状态/重启 | `v2/scripts/asr_worker.py`, `v2/src/voice/faster-whisper.ts` | 启动 `ready` 带 `loadMs/warmupMs`；`asrState` 反映加载/异常；超时自动重启 |
| Piper 中文合成 | `v2/src/voice/tts.ts` | 生成 22.05 kHz WAV，`/api/audio` 可播 |
| 按需屏幕捕获 | `v2/scripts/screen_capture.py`, `v2/src/senses/screen.ts` | Portal 授权/拒绝路径；X11 仅回退；记录窗口标题是否可知 |
| 感官同意与画面删除 | `v2/web/app.js`, `v2/src/server.ts` | 首次看屏幕/摄像头前说明；画面卡片显示留存策略并支持单张删除 |
| 按需摄像头单帧 | `v2/src/senses/camera.ts` | `/dev/video0` 实测 94 KB JPEG |
| 屏幕 OCR（中文/英文） | `v2/scripts/ocr_worker.py`, `v2/src/senses/ocr.ts` | 固定文本图实测逐字正确 |
| 提醒解析 / 调度 / 打扰策略 | `v2/src/proactive/*` | `test/reminders.test.ts`；15 s tick |
| 每日简报 / 只读日历 | `v2/src/{brief,proactive/calendar}.ts` | 08:30 调度、提醒+记忆+ICS 日程；`/api/brief`；桌面通知 |
| HTTP + WebSocket + 静态 PWA | `v2/src/server.ts` | `curl` + headless Chrome DOM；PNG/maskable 图标 |
| 记忆/提醒/运行状态面板 | `v2/web/*` | 浏览器实时事件、搜索、确认/拒绝/删除 |
| Jarvis Studio 总览（延迟/事件/系统） | `v2/src/telemetry.ts`, `v2/web/studio.js` | `/api/observatory`；持久化 JSONL 回合；headless Chrome DOM |
| 记忆星座 / Inspector / 召回实验台 | `v2/src/memory/store.ts` (`graph`), `v2/web/studio.js` | 演示 13 节点 / 22 边；点击、筛选、召回解释 |
| 效果与行为调参（32 项 / 预设 / 实时预览） | `v2/src/tuning.ts`, `v2/web/studio.js`, `v2/web/visual.js` | `test/tuning.test.ts`；UI 拖动/保存/重置实测 |
| 脱敏配置浏览器 | `v2/src/server.ts` (`/api/config`) | 测试断言不含 auth token / API key |
| 开发演示记忆（仅 loopback） | `v2/src/server.ts` (`/api/dev/demo-memory`) | 显式 header + 一键清除；未混入真实记忆 |
| v1 `memory.json` 导入 | `v2/src/memory/store.ts` + `src/cli.ts` | CLI 可跑；字段保留 id/时间/来源 |
| 桌面入口 / systemd user service | `v2/scripts/install-*.sh`, `v2/ops/jarvis.service` | 生成 `.desktop` / `jarvis.service`；单元文件含 NoNewPrivileges/ProtectHome |
| 备份 / 恢复 | `v2/scripts/{backup,restore}.ts` | SQLite `VACUUM INTO` 一致快照；0600；恢复前完整性检查 + 拒绝运行中覆盖 |
| 设备配对 / 撤销 | `v2/src/devices.ts`, `v2/web/pair.*` | 一次性 6 位配对码、SHA-256 设备令牌、可撤销；`test/devices.test.ts` |
| 敏感文件静态加密 | `v2/src/secure-files.ts` | captures/audio/telemetry AES-256-GCM；`test/secure-files.test.ts`；DB 边界见 `security.md` |
| 数据导出 / 彻底删除 | `v2/src/server.ts`, `v2/web/app.js` | `/api/privacy/export`；`/api/privacy/erase` 清空记忆/提醒/审计/音频/画面/trace，需短语确认 |
| 本地安装脚本 | `v2/scripts/setup-models.sh` | 用户目录安装，无 sudo |
| 桌面通知 | `v2/src/notify.ts` | `notify-send`；静默/专注时不打扰；失败不影响回合 |

## 2. 部分实现

| 能力 | 现状 | 缺口 |
|---|---|---|
| M1 语音 | 按住说话、打断（cancel）、ASR 预热/状态、追问窗口 8 s | 无 VAD 自动端点、无唤醒词、无 AEC |
| M2 屏幕 | Portal 单帧 + OCR + 黑名单（有标题时）+ 标题未知标注 + 单张删除 | 原生 Wayland 拿不到活动窗口；无选区裁剪 |
| M3 记忆 | 显式写入、召回、编辑、删除、巩固、冲突更新、11 条评测 | 无 LLM 摘要式巩固；评测以确定性 HashEmbedder 为回归基线 |
| M3.5 记忆增强 | 后台 proposed 抽取、混合向量召回、冲突候选、评测集 | 真实语义质量仍需更大规模人工标注集 |
| M4 主动性 | 提醒、预算、专注、静默时段、每日简报、只读 ICS | 无双向日历写入；无会议检测 |
| M5 远程 | 令牌 + TLS + PWA + WS + 设备配对/撤销 | 无 WebRTC；无逐设备权限范围（设备令牌等价主令牌） |
| 模型来源 | 本地 Ollama / 远端 OpenAI-compatible 运行时切换 | 远端协议未覆盖 Anthropic/Azure 专有头；向量模型切换需重建索引 |
| 可视化 | 总览、记忆星座、事件流、调参、脱敏配置、持久化回合 | 无时间回放、无手动连线 UI、无 A/B 对照 |
| 工具执行 | 打开网页/文件管理器（一次性确认 + 审计） | 无任意文件写入/终端/日历 |

## 3. 明确不做（本版）

- 数字人 / lip-sync。
- 持续录屏、持续摄像头、持续麦克风。
- 自主付款、开门、批量删除。
- 在 4 GB 显存机器上把 3B 视觉模型当实时主路径。

## 4. 下一步（按收益排序）

0. 真实屏幕 Portal 验收 + 选区裁剪（需要人在场授权）；摄像头/手机真机验收。
1. PWA 按住说话在手机上的真机验收；iOS Safari MediaRecorder 兼容。
2. 记忆评测扩展到 150 题并接入真实 embedding 基线；LLM 摘要式巩固。
3. 双向日历/任务写入与审批；当前只有只读 ICS 和本地提醒。
4. A/B 调参、回合时间回放和记忆手动连线 UI。
5. 唤醒词与 VAD（Silero）需要重新评估 CPU/隐私预算。
6. 视觉模型替换评估（更小、支持中文、能在 4 GB 内全 GPU）。
