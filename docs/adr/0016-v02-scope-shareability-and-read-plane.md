# ADR-0016: v0.2 范围冻结——可分享性打磨与读取面显形

状态: accepted (2026-09-16, owner 访谈)

## 背景

v0.1.0 发布后，owner 决策继续短期维护。决策依据之一是一份本地竞品调研（按 owner 要求不公开，仅存本地）。调研结论中与产品方向相关的两点：(a) "原位管理"理念已存在其他独立实现者，不再独占；(b) 调研提议的 preview→confirm→verify 变更安全模型经 owner 质询后确认降级——现有批量/远程更新场景下价值未被感知，不作为差异化押注，已有实现保留但不扩展。

## 决策

v0.2 范围冻结为：

- **README 重写**：工具叙事为主（"终端里的 skills 开关矩阵"为门面），"磁盘即真相不绑架"与"读取面管理"作支柱。
- **TUI 键位区重做**：底部一行键位提示改为独立区域。
- **Source tab 信息分层**：用户态/开发态分离——TUI 默认只呈现用户可决策的信息；hash、路径解析、下载过程等归入 CLI `--json` 或 detail 展开层。
- **读取面显形**：对无法通过自身配置停止读取全局 `~/.agents/skills/` 的 Harness，矩阵中诚实呈现其强制读取关系与不可隔离性；可管理部分（Harness 自有目录的 Skill 发现、开关、更新、批量、Project 级）照常支持。
- **接入新 Harness**：Codex、Cursor、OpenCode、Hermes。
- **跨目录分配能力的 TUI 呈现清晰化**：模型层已支持任意 Resource（含 Harness 目录中的 local Skill）向任意 Target 建立 Link/Mirror 关系，v0.2 只补呈现，不扩能力。

显式排除（v0.2 不做）：TUI 首屏 logo、初始设置向导、skills 生态方向（markdown 渲染阅读、编辑器、开发工具、运维）、preview→confirm→verify 扩展。

## 后果

- preview→confirm→verify 降级记录在此：不排期、不预研；触发重启评估的条件是 owner 实际遭遇批量误操作或上游更新事故。
- 新 Harness 接入遵循读取面策略：不支持关闭全局读取的 Harness 按"部分可管理"呈现，不 hack 阻断。
- 后续 spec/ticket 拆分以本 ADR 的范围清单为准；范围外需求需要新的 owner 决策。
