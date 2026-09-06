# ADR-0011: Skill Target 与 Harness/Source Adapter seams

状态: accepted (2026-08-12)，Harness 支持级别由 ADR-0013 的 v0.1 boundary amendment 修订

当前 `Runtime` 同时表示 Harness、路径规则与具体 discovery root，导致 Pi、Codex 和 `npx skills` 等外部契约泄漏进 Inventory。SkillsPub 改用 **Skill Target** 表示 Skill 被放置和管理的具体目标，并把易变的外部知识集中到 Adapter seams；ADR-0007、0008、0010 中与 Runtime 命名、Shared per-Harness override 和安装器职责冲突的当前规范由本 ADR 取代，旧 ADR 保留历史原文。

## 决策

- **Target Definition** 描述路径和能力规则；解析后才成为具有 scope、绝对 discovery root 与稳定 ID 的 **Skill Target**。`~/.agents/skills` 是一个独立 **Shared Skill Target**，不归属任何 Harness，也不为消费者复制开关。不引入 `Dedicated` 分类，暂不实现 Consumer/Profile 模型。
- **Harness Adapter** 以独立 TypeScript 模块集中维护一个 Harness 的官方路径、配置格式、Shared consumption、隔离、迁移与验证。Inventory 只扫描已解析 Targets。**Source Adapter** 独立维护 `npx skills` 等安装工具的固定版本、命令、输出和 provenance。
- inspect、scan、ls 与打开 TUI 严格只读。setup、apply 与 reconcile 先展示计划；写 Harness 配置前复核原内容、原子写入并重新验证。未知配置结构拒绝写入。支持级别为 `managed`、`discoverable`、`unsupported`；当前 release claim 以 ADR-0013 为准，不能从 Adapter 的写入能力推断 `managed`。
- `npx skills` 只把资源安装到 Shared Target，不创建 Harness-specific Relationships。其他 Targets 由用户随后开启，默认 Link；Harness 不支持 symlink 时，Adapter 可创建可追溯的 `mirror`。Mirror 的更新只在显式 reconcile 发生，人工改动使其 diverged，不能静默覆盖。
- 删除仍被当前可见 Links 或 Mirrors 使用的 Shared resource 时，必须列出级联影响并再次确认；确认后删除已知 Relationships。SkillsPub 不维护中央项目索引，因此同时警告未知项目可能遗留 broken links。
- `targets.json` 只保存 Generic Targets 与内置 Target Definitions 的用户 overrides。旧 `runtimes.json` 在展示迁移计划后转为新格式并改名备份；未知旧项保守转为 Generic Target。CLI 使用 `--target`，`--agent` 暂作弃用别名。

## 后果

Harness 或安装器更新通常只修改对应 Adapter、fixtures 与官方证据。TUI 以 Skill Target 为真实开关单位，以 Harness 分组和解释最终可见性。多 Profile/Agent 身份留给后续 Adapter 扩展；当前结构不得假设一个 Harness 永远只有一个目标身份。
