# Jarvis v2 — 安全模型与静态加密

- Status: implemented baseline; honest about residual risk
- Code: `v2/src/{server,devices,secure-files}.ts`, `v2/src/config.ts`
- Test: `v2/test/{server,devices,secure-files,telemetry}.test.ts`

## 1. 信任边界

Jarvis 是一个**单用户、单机优先**的私人助手。默认只监听 `127.0.0.1`；
本机回环请求视为已登录，因为能连回环的进程本来就能读同一用户的
`~/.local/share/jarvis`。这不是多租户系统，也不把浏览器扩展/同用户恶意进程
当作可防对象。

远程访问必须同时满足：

1. 显式设置 `JARVIS_HOST` 为非回环地址；
2. 配置 `JARVIS_AUTH_TOKEN`；
3. 配置 TLS 证书和私钥（否则启动失败，fail closed）。

远端请求必须带 `Authorization: Bearer` 或配对设备 Cookie；跨源写请求被
`SameSite`/Origin 检查拒绝。设备令牌是**全权限**的，等价于主令牌；当前没有
按设备限权。

## 2. 凭据

| 凭据 | 存储 | 说明 |
|---|---|---|
| 主令牌 | 环境变量 `JARVIS_AUTH_TOKEN` | 不写数据库、不回显到 `/api/config` |
| 设备令牌 | `data/devices.json` 的 SHA-256 哈希 | 只在配对响应中出现一次；可逐个撤销 |
| 配对码 | 进程内存 | 6 位、5 分钟、一次性；60 秒内最多 30 次失败尝试 |
| 本地加密密钥 | `data/secret.key`，0600 | 32 字节随机；不进入备份、不写日志 |
| 远端模型 Key | `data/model-config.json`，0600 | 设置页不回显；导出/备份默认不含 |
| 远端 ASR/TTS Key | `data/voice-config.json`，0600 | 设置页不回显；导出默认不含；本地-only 可为空 |

`umask 077`；SQLite 主库/WAL/SHM、调参、模型配置、设备文件都收紧到 0600。
配对设备在“删除全部对话与记忆”时一并撤销并删除 `devices.json`。

## 3. 静态加密（已实现范围）

敏感**瞬态文件**使用 AES-256-GCM（每条随机 96-bit IV、128-bit tag）：

- 屏幕/摄像头单帧：`data/captures/*`，回合结束后立即替换为密文；
- TTS 输出：`data/audio/*.wav`，合成完成后替换为密文；
- 观察台持久化回合：`data/telemetry.jsonl`，每条 `J1:` 前缀的密文行。

启动时会把遗留的明文 captures/audio 和旧 JSONL trace 就地迁移为密文；
“删除全部对话与记忆”会移除加密文件并**轮换** `secret.key`，让任何残留密文
失效。

服务端在 `/api/captures/:name`、`/api/audio/:name` 读取时解密；浏览器拿到的
仍是明文响应（否则无法显示/播放），但磁盘上不是。篡改密文会导致 GCM
校验失败并返回 404，不会把损坏内容当正常文件送出。

**没有做全库加密。** 记忆正文、FTS5 索引和向量投影仍在 `jarvis.db` 中，
因为当前 `node:sqlite` 没有 SQLCipher，且应用层字段加密会让 FTS/中文召回
不可用。保护依赖：

- 数据目录 0600/0700、进程 `umask 077`；
- 建议整盘 LUKS/home 加密（发行版安装时选择），这是防离线取证的主控制；
- `secret` 记忆默认不进入普通召回/模型上下文；但它在数据库中仍是明文，
  不要把它当硬件保险箱。

这是明确的取舍，不是“已经全加密”。若威胁模型要求“数据库文件被拿走也不
可读”，下一步应换 SQLCipher/加密 FUSE，而不是继续加字段级补丁。

## 4. 动作与出网

- 只有打开网页/文件管理器等低风险动作；每次高风险动作需要一次性确认，
  确认令牌绑定 action id，不能重放；审计写 `data/audit/actions.jsonl`。
- 没有任意 shell、任意文件写入、付款、开门或批量删除工具。
- 远端模型/ASR/TTS 只在用户显式切换/配置后使用；隐私过滤和“本地优先”路由在
  `src/model/router.ts` 与 `src/voice/runtime.ts`，但**没有网络层 DLP 网关**；
  不要把 secret 发给远端，也不要把远端 ASR/TTS 地址指向不可信服务。
- 屏幕/摄像头始终按需单帧；系统门户是真正的同意点，黑名单是补充而非替代。
- **远端视觉默认关闭**：远端模型启用时，`look` 不采集屏幕/摄像头，也不把画面或
  图像发给服务商；只有服务端显式设置 `JARVIS_ALLOW_REMOTE_VISION=1` 才放行。
  这是防止“换了个模型就把桌面截图发出去”的硬边界；OCR 文字同样属于屏幕内容。

## 5. 数据导出与擦除

- `GET /api/privacy/export`：导出记忆、提醒、动作审计、配置摘要；需要认证。
- `POST /api/privacy/erase`：body 必须是 `{"confirm":"ERASE ALL"}`；清空
  记忆/链接/事件/提醒/审计/音频/画面/观察台历史，撤销设备，`VACUUM` 数据库。
- 导出/擦除都不会删除 `secret.key`（否则残留密文会变成永久垃圾）；擦除会
  删除所有由它加密的文件。
- 浏览器缓存、系统截图缓存、备份归档不在擦除范围内；需要另行清理。

## 6. 已知残余风险（必须在验收时说明）

1. 同用户恶意进程可以读数据目录和主令牌；单用户模型不防这个。
2. 数据库未全库加密；整盘加密是推荐控制。
3. 设备令牌全权限；丢失设备应立即撤销。
4. 屏幕窗口标题在原生 Wayland 常为空；黑名单只能尽力而为，最终同意点是
   GNOME Portal。
5. 远端模型/ASR/TTS 若被替换为云服务，数据会离开本机；当前默认全部本地。远端 ASR 会发送整段语音，远端 TTS 会发送待朗读文本。WS 默认契约见 `voice.md`。
6. 配对页依赖浏览器 Cookie；禁用 Cookie 时需手动粘贴一次性令牌。
