# Jarvis v2 — 实现状态

- Date: 2026-10-26
- Branch: `feat/jarvis-v2`
- Runtime: `v2/`（TypeScript / Node 24 / SQLite / 本地 Web UI）

## 1. 已实现并跑通

| 能力 | 代码 | 验证 |
|---|---|---|
| 配置、目录、令牌、TLS fail-closed | `v2/src/config.ts` | `npm run typecheck`；远端配置缺 TLS 会抛错 |
| 事件总线 / 脱敏日志 | `v2/src/events.ts`, `v2/src/logger.ts` | 单元测试 + 运行时日志 |
| 注意力状态机 + 上下文决策 | `v2/src/attention.ts` | `test/attention.test.ts` |
| SQLite 记忆源、FTS5、向量投影 | `v2/src/memory/store.ts` | `test/memory.test.ts` |
| 记忆召回评分 / 上下文渲染 | `v2/src/memory/recall.ts` | 短中文查询、敏感过滤、弃权、历史 |
| 后台记忆抽取（proposed） | `v2/src/memory/extract.ts` | 显式“记住”不重复抽取；候选不自动确认 |
| 本地 LLM / embedding / 视觉 adapter | `v2/src/model/ollama.ts` | `qwen2.5:3b`, `nomic-embed-text` 实测 |
| 本地/远端模型切换（UI 一键） | `v2/src/model/{router,openai,settings}.ts`, `v2/web/app.js` | `test/{openai,model-settings}.test.ts`；mock 远端 + UI 实测 |
| 实时语音：PTT → ASR → LLM → TTS | `v2/src/voice/*`, `v2/src/conversation.ts` | `/api/voice` 实测 6 s 热路径 |
| faster-whisper 持久 worker | `v2/scripts/asr_worker.py` | `tiny` 中文转写；模型只加载一次 |
| Piper 中文合成 | `v2/src/voice/tts.ts` | 生成 22.05 kHz WAV，`/api/audio` 可播 |
| 按需屏幕捕获 | `v2/scripts/screen_capture.py`, `v2/src/senses/screen.ts` | Portal 授权/拒绝路径；X11 仅回退 |
| 按需摄像头单帧 | `v2/src/senses/camera.ts` | `/dev/video0` 实测 94 KB JPEG |
| 屏幕 OCR（中文/英文） | `v2/scripts/ocr_worker.py`, `v2/src/senses/ocr.ts` | 固定文本图实测逐字正确 |
| 提醒解析 / 调度 / 打扰策略 | `v2/src/proactive/*` | `test/reminders.test.ts`；15 s tick |
| HTTP + WebSocket + 静态 PWA | `v2/src/server.ts` | `curl` + headless Chrome DOM |
| 记忆/提醒/运行状态面板 | `v2/web/*` | 浏览器实时事件、搜索、确认/拒绝/删除 |
| v1 `memory.json` 导入 | `v2/src/memory/store.ts` + `src/cli.ts` | CLI 可跑；字段保留 id/时间/来源 |
| 桌面入口 / systemd user service | `v2/scripts/install-*.sh` | 生成 `.desktop` / `jarvis.service` |
| 本地安装脚本 | `v2/scripts/setup-models.sh` | 用户目录安装，无 sudo |

## 2. 部分实现

| 能力 | 现状 | 缺口 |
|---|---|---|
| M1 语音 | 按住说话、打断（cancel）、追问窗口 8 s | 无 VAD 自动端点、无唤醒词、无 AEC |
| M2 屏幕 | Portal 单帧 + OCR + 黑名单（有标题时） | 原生 Wayland 拿不到活动窗口；无选区裁剪 |
| M3 记忆 | 显式写入、召回、编辑、删除、巩固 v0 | 无实体图和多跳；巩固无 LLM 摘要 |
| M3.5 记忆增强 | 后台 proposed 抽取、混合向量召回 | 评测集未建；冲突链接/衰减未完整 |
| M4 主动性 | 提醒、预算、专注、静默时段 | 无日历/任务触发；无会议检测 |
| M5 远程 | 令牌 + TLS + PWA + WS | 无 WebRTC；无设备配对/撤销 UI |
| 模型来源 | 本地 Ollama / 远端 OpenAI-compatible 运行时切换 | 远端协议未覆盖 Anthropic/Azure 专有头；向量模型切换需重建索引 |
| 工具执行 | 打开网页/文件管理器（一次性确认 + 审计） | 无任意文件写入/终端/日历 |

## 3. 明确不做（本版）

- 数字人 / lip-sync。
- 持续录屏、持续摄像头、持续麦克风。
- 自主付款、开门、批量删除。
- 在 4 GB 显存机器上把 3B 视觉模型当实时主路径。

## 4. 下一步（按收益排序）

1. 真实屏幕 Portal 验收 + 选区裁剪（需要人在场授权）。
2. PWA 按住说话在手机上的真机验收；iOS Safari MediaRecorder 兼容。
3. 记忆评测集（弃权 / 更新 / 冲突 / 隐私）和 150 题基线。
4. 更多工具执行 + 审批：日历、文件读取/写入、浏览器自动化；当前只有打开网页/文件管理器。
5. 唤醒词与 VAD（Silero）需要重新评估 CPU/隐私预算。
6. 视觉模型替换评估（更小、支持中文、能在 4 GB 内全 GPU）。
