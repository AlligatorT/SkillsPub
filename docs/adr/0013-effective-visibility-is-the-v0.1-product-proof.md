# ADR-0013: Effective Visibility 是 v0.1 的产品证明

状态: accepted (2026-08-22)

SkillsPub 不与 Vercel `skills`、GitHub `gh skill` 或现有管理器竞争下载、marketplace 和广泛路径同步；这些能力已有更强分发与 adoption。v0.1 改以 **Effective Visibility** 证明自身价值：对一个已安装 Skill resource，基于现场 Relationships、Harness 实际消费的 roots、配置与已验证 Adapter 证据，解释它在 Harness 下次加载时为何是 `visible`、`not-visible`、`unknown` 或 `conflicted`，并在用户明确给出 `visible`/`hidden` 目标时返回只读计划或 blockers。

该承诺覆盖 Pi、Claude Code 与 Grok Build 三个 v0.1 Managed Adapters，并由同一 resolver 提供 CLI text、versioned JSON 与 TUI detail。Explain 每次本地重扫，不联网、不缓存、不修改磁盘，也不启动 Harness 或声称知道运行中进程的内存状态；Catalog candidates 必须先经固定 `npx skills` Source Adapter 安装。计划优先使用 Harness-specific Target，只组合现有安全 operations；同名 Variant、未知配置、Preset claim、未知 ownership 或跨 Skill 副作用未解决时保持阻塞并解释。

## Considered Options

- 继续把 v0.1 定义为 broad filesystem manager：已有 Skills Manager、ASM、Skill Flow 与 Vercel `skills` 覆盖，且不能证明 SkillsPub 更深模型的必要性。
- 先发布当前 surface、之后再做 Explain：会让首个公开版本缺少可直接验证的差异化。
- 要求 live runtime verification：保证更强，但会引入 launcher、进程控制与每个 Harness 的运行时协议，超出 SkillsPub 边界。

## Consequences

Effective Visibility 的 core 与 TUI tracer 成为公开 v0.1 的发布门槛。Source add/update/remove 仍委托固定 `npx skills`；Update availability、Drift 与 Effective visibility 保持三个不同概念。后续 Harness 只有在 Adapter 能提供足够的 consumed-root 与配置证据时，才可给出非 `unknown` 的结论。
