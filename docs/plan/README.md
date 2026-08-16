# Jarvis Project Plan

这套计划把 DeepSeek Harness 定位为 Jarvis 的智能体运行时，而不是完整的跨设备产品后端。项目采用独立插件方式接入，不维护 Harness 分叉。

## 已锁定的起点

- V0.1 是单用户、仅本机的 Mac 文字版 MVP。
- 数据模型保留 `owner_id`，为后续家庭多用户迁移留出边界。
- Harness 只能监听回环地址，不能直接暴露到局域网或互联网。
- 首个 Mac MVP 复用 Harness Web UI。
- 有副作用的电脑操作必须经过确定性策略；应用启动需要人工批准。
- 手机访问由后续 Jarvis Gateway 提供认证、设备身份和版本化 API。
- 智能设备首先通过 Home Assistant 和 MQTT 接入，不在设备上运行 Harness。
- 语音在最终转写前保持在 Harness 外部。

## 阅读顺序

1. `architecture.md`：总体边界、关键决策与风险。
2. `00-development-journey.md`：完整里程碑、工期和阶段门禁。
3. `01-stage-0-foundation.md` 至 `08-stage-7-hardening-release.md`：逐阶段模块计划和验收路径。
4. `09-module-dependency-map.md`：模块依赖、数据归属和测试责任。

## 交付关系

同级的 `jarvis-mac-mvp` 是 Stage 1 的最小可执行切片。它不代表 Stage 1 的全部生产级出口条件已经完成；认证网关、精确命令摘要审批、备份恢复和独立节点代理仍属于后续强化工作。
