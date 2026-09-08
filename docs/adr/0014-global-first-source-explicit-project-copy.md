# ADR-0014: Global-first Source 与显式 Project 副本边界

状态: accepted (2026-09-07, issue #143)；TUI Project 副本呈现部分由 ADR-0015（#145）取代，本 ADR 其余内容保持历史记录

## 背景

Human acceptance #126 暴露出 #111 批准、#116 落地的对称 Global/exact-Project Source workspace 会被读成两个可互换的下载/更新位置：用户在 Project 上下文打开 Source 时无法分辨该在哪里 add/update，两个 scope 的 lock 与 resource 看似同一条更新流。Owner 据此批准 global-first、显式 Project 副本的修订（#143）。

## 决策

- **Global Source 是默认/推荐的远程 lifecycle**。打开 `3 Source` 始终以 Global scope 起始，即使 TUI 带 exact Project 上下文；Global 标注为 `Scope: Global (default/recommended)`。
- **`p` 不再直接切换 scope**，而是打开一个键盘可达的 Project Source 副本边界，解释两个选择：
  - `Use Global resources (recommended)`：转向现有 `1 Target` / `2 Skill` Relationship 管理去消费 Global resources——纯导航，不执行任何 Link、Source install、lock 写入、network request 或其他 mutation；
  - `Project-owned copy (advanced)`：显式确认后进入 exact Project Source，持久显示 `Scope: exact Project — Project-owned copy (advanced)` 身份与 canonical Project path。
- `Esc` 取消边界，Global Source 保持不变。
- Project Catalog add/replace preview 必须明确说明该操作创建/修改一个独立的 Project-owned resource 与 Project lock，并可能与同名 Global resource 冲突；两者永不构成同一条共享更新流。
- 继承的 Global/ancestor resources 保持解释性 read-only，标明 source directory。
- `g` 返回 Global 的行为不变，仍清除 Project-only selection/marks/plans/cache。

## 后果

- 不变边界继续成立：pinned Vercel `skills` 拥有 remote lifecycle/lock/security audit；TUI 启动与普通只读查询不联网；Source 操作不自动创建 Harness Relationship；不建立中央 Project registry；no-launcher 边界不受影响。
- exact Project Source 能力完整保留，用于 reproducibility、fork 与 project-specific version 场景，但它是显式 advanced 路径，不再与 Global 对称呈现。
- Project 副本与同名 Global resource 各自独立 lock/update/remove；同名共存时，各 Harness 依已验证 Adapter evidence 决定可见性或报告 conflict，Source 不猜测赢家（与 Effective Visibility 的 unknown/conflicted 规则一致），也不回写或影响 Global。
