# Jarvis

[![CI](https://github.com/gh503/jarvis/actions/workflows/ci.yml/badge.svg)](https://github.com/gh503/jarvis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个仅在本机运行的个人 Jarvis 原型，使用 DeepSeek Harness 提供对话、会话持久化和人工审批界面。

## 项目状态

当前版本是 `v0.1.0` 前的 Mac MVP。项目通过 [GitHub Project](https://github.com/users/gh503/projects) 跟踪执行，通过 [Milestones](https://github.com/gh503/jarvis/milestones) 管理阶段出口，通过 [Issues](https://github.com/gh503/jarvis/issues) 定义可验收工作。

- [总体架构](docs/plan/architecture.md)
- [开发旅程与里程碑](docs/plan/00-development-journey.md)
- [完整阶段计划](docs/plan/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 当前能力

- 在 Harness Web UI 中进行文字对话。
- 读取当前 Mac 的系统、内存、负载和运行时长。
- 创建、查看、完成和删除本地提醒。
- 经人工批准后打开白名单内的 macOS 应用。
- 记录追加式操作审计，提醒和审计文件权限为 `0600`。
- 默认只监听 `127.0.0.1`，并关闭 Harness 遥测。
- 单调拒绝非 Jarvis 工具，模型不能绕过策略调用终端或文件工具。

## 环境要求

- Apple Silicon 或 Intel Mac
- macOS 13 或更高版本
- Node.js 24
- DeepSeek API Key

## 首次运行

```bash
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY
npm install
npm run verify
npm start
```

浏览器打开 [http://127.0.0.1:3080](http://127.0.0.1:3080)。健康检查地址为 [http://127.0.0.1:3080/jarvis/health](http://127.0.0.1:3080/jarvis/health)。

首次进入需要接受 Harness 内测声明，并选择本项目目录作为工作区。也可以在“设置 -> 模型”中配置 DeepSeek Key；使用 `.env` 更适合后台启动。

可以尝试：

- `查看这台 Mac 当前状态`
- `提醒我 2030-01-01T09:00:00+08:00 检查计划`
- `列出我的提醒`
- `打开 Notes`

应用启动会停在 Harness 的审批界面，只有点击允许后才执行。白名单位于 `config/apps.json`，修改后需要重启。

## 后台启动

确认前台运行正常后执行：

```bash
./scripts/install-launch-agent.sh
```

卸载后台服务但保留数据：

```bash
./scripts/uninstall-launch-agent.sh
```

## 数据与安全

- Harness 会话：`.dsh/sessions/`
- Jarvis 提醒：`data/reminders.json`
- Jarvis 审计：`data/audit.jsonl`
- API Key：仅存放在未纳入 Git 的 `.env`
- 网络：仅限本机回环地址，不要通过端口转发直接暴露到局域网或互联网

这是单用户、本机文字版 MVP，不包含手机远程访问、语音、智能家居、任意终端、文件操作和消息发送。手机与智能设备阶段需要先增加 Jarvis 自有的认证网关、设备身份和版本化 API，不能直接暴露 Harness Web 服务。

## 上游边界

项目不分叉 DeepSeek Harness，依赖精确锁定到 `@deepseek-ai/dsh@0.1.0-rc.6`。Harness 仍是预发布项目，升级时必须重新执行类型检查、测试、启动、审批和持久化验证。

项目采用 [MIT License](LICENSE)。
