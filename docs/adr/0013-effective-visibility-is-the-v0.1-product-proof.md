# ADR-0013: Effective Visibility 是 v0.1 的产品证明

状态: accepted (2026-08-22)，按 #112 approved v0.1.0 contract 修订 (2026-09-04)

SkillsPub 不与 Vercel `skills`、GitHub `gh skill` 或现有管理器竞争下载、marketplace 和广泛路径同步；这些能力已有更强分发与 adoption。v0.1 以 **Effective Visibility** 证明自身价值：对一个已安装 Skill resource，基于现场 Relationships、Harness 实际消费的 roots、配置与已验证 Adapter 证据，解释它在 Harness 下次加载时为何是 `visible`、`not-visible`、`unknown` 或 `conflicted`，并在用户明确给出 `visible`/`hidden` 目标时返回只读计划或 blockers。

该承诺由同一 resolver 提供 CLI text、versioned JSON 与 TUI detail。Explain 每次本地重扫，不联网、不缓存、不修改磁盘，也不启动 Harness 或声称知道运行中进程的内存状态；Catalog candidates 必须先经固定 Vercel `skills` Source Adapter 安装。计划优先使用 Harness-specific Target，只组合现有安全 operations；同名 Variant、未知配置、Preset claim、未知 ownership 或跨 Skill 副作用未解决时保持阻塞并解释。

## v0.1 boundary amendment

Issue #112 修订了 superseded 的“三个 Harness 已全部验证 Managed”边界：

- Claude Code 保持 `managed`，accepted Adapter contract 不消费 Shared，因此 isolation 是 `not-required`；
- Grok Build 依据 #109 real-machine evidence 保持 Global/exact-Project `managed/excluded`，setup/reconcile 必须在确认前完整披露 Relationship impact、source preservation 与 recovery；
- Pi 在 #109 的 `!skills/**` chain 抑制 Pi Target 后降为 `discoverable`。只有完成 #115 的 root-specific absolute exclusions、Global/Project separation、matcher-aware inspection、canonical Project Target migration、backup/recovery，并通过新的 tools-enabled real-machine apply/recovery acceptance，candidate commit 才能恢复 `managed/excluded` claim；
- v0.1 不新增 Codex、OpenCode、Kimi Code、WorkBuddy 或 TraeCode Managed Adapter。前四者保持 `discoverable` roadmap candidates，WorkBuddy 保持 `unsupported`。

Effective Visibility 不扩张为 Harness startup control。SkillsPub 不建立 wrapper、OS environment provisioner、per-entry-point argument/environment profile、IDE/GUI/daemon integration 或 Launch Profile entity。launch-dependent consumption 保持 `unknown`，already-running process 不被当作 reloaded。

完整 Global/exact-Project Source lifecycle 使用 #111 批准的 A+C TUI contract，并继续把 remote find/add/update/remove、security audit、provenance 与 Source lock ownership 委托给 pinned Vercel `skills`。SkillsPub 只拥有 scope、preconditions、Slot/Relationship/Desired-state orchestration、progress/recovery projection 与 final local verification；不建立第二 marketplace、installer、updater 或 lock。

## Considered Options

- 继续把 v0.1 定义为 broad filesystem manager：已有 Skills Manager、ASM、Skill Flow 与 Vercel `skills` 覆盖，且不能证明 SkillsPub 更深模型的必要性。
- 先发布现有 surface、之后补 complete Source TUI 与 Pi repair：会把已证伪的 Pi Managed claim 和不完整 lifecycle 带进首个公开版本。
- 为 OpenCode/Kimi 等加入 launch profiles：可以得到较窄 entry-point 的 positive result，但无法覆盖所有 CLI、GUI、IDE、service、remote/container 与 existing process，且会把产品变成 launcher manager。
- 要求 live runtime verification：保证更强，但会引入 launcher、进程控制与每个 Harness 的运行时协议，超出 SkillsPub 边界。

## Consequences

Effective Visibility、complete Source workspace、repaired Pi contract 与 exact real-machine acceptance 共同成为公开 v0.1 的发布门槛。Source add/update/remove 始终委托固定 Vercel `skills`；Update availability、Drift 与 Effective Visibility 保持不同概念。Pi 未通过新 acceptance 时保持 `discoverable`，而不是用实现意图替代证据。Grok 的大规模 Relationship effects 必须显示完整清单与 recovery，不能只显示 count。后续 Harness 只有在不依赖 SkillsPub launch ownership且 Adapter 能提供完整 consumed-root、control、next-load 与 recovery evidence 时，才可给出 release-quality Managed 结论。
