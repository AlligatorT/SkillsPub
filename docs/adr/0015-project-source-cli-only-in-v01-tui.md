# ADR-0015: v0.1 TUI 只呈现 Global Source；Project Source 保留为显式 CLI 能力

状态: accepted (2026-09-08, issue #145)

## 背景

Human acceptance #126（candidate `54fe0be4`）证明 ADR-0014/#143 的显式 Project Source 副本边界对 v0.1 TUI 仍然概念过重：即便 Global-first 且 `p` 需要确认，用户依旧要在 TUI 里理解"两个 scope、两把 lock、同名冲突"这一整套 advanced 心智模型。Owner 批准了更简单的表面（#145）：v0.1 TUI 不再呈现 Project Source。本 ADR 只取代 ADR-0014 的 TUI Project 副本呈现部分；ADR-0014 保持历史记录，不被改写。

## 决策

- **`3 Source` 在 v0.1 TUI 中是 Global-only**。无论 TUI 是否带 exact Project 上下文，Source 始终显示 `Scope: Global (default/recommended)` 与 Global Shared Target path，只操作 Global Shared resources、Global lock/cache/state 与 Global operation lock，永不读写 exact-Project Source lock/cache/state。
- **footer、help、empty state、focus model 与 key handling 不再暴露任何 Project Source 开关或副本边界**。`p` 不执行任何 mutation、不能进入 Project Source；它只显示一行指向显式 CLI 的反馈（`skillspub project <path> shared …`）。`g` 随之取消——没有第二个 scope 可返回。
- **Project TUI 聚焦已安装 Skill Relationships**。exact Project 上下文中的 `1 Target` / `2 Skill` 继续管理 Project Relationships、inherited entries、ON/OFF、Link/Mirror plans 与 Effective Visibility，Global Source ownership 不变。
- **exact-Project Source lifecycle 完整保留为显式 CLI 能力**：`skillspub project <path> shared find|add|replace|refresh|update|remove` 保持 immutable preview、JSON plan/apply、lock 隔离、update/Desired restoration、dependency-aware remove、failure/retry/recovery 与 final-rescan 行为；稳定 JSON contract 不变。CLI 创建的 Project-owned Source copies 继续作为已安装 resources 出现在 Project Target/Skill 与 Explain projections 中。
- **不引入自动 Global-to-Project Link**。任何 Source 操作都不会自动创建 Global-to-Project Shared 或 Harness-specific Link。

## 后果

- v0.1 TUI 的认知表面收敛为：Global Source 管远程 lifecycle，`1 Target` / `2 Skill` 管 Project Relationships；不再有第二个 TUI Source scope 需要教学。
- Project-owned Source copy 仍是有效的 domain 概念与 CLI 能力（reproducibility、fork、project-specific version），只是从 v0.1 TUI 省略；未来若重新进入 TUI，需要新的 owner 批准与新的 ADR。
- 不变边界继续成立：pinned Vercel `skills` 拥有 remote lifecycle/lock/security audit；TUI 启动与只读查询不联网；不建立中央 Project registry；no-launcher 边界不受影响。
