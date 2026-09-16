# Spec: Skill Targets and Adapters

本规范定义 SkillsPub 如何把易变的 Harness 与安装器规则隔离在 Adapter seams。领域术语见 `CONTEXT.md`，CLI/TUI 行为见 `docs/spec/cli.md`。

## Module seams

```text
src/targets/shared.ts        Shared Target Definition
src/harnesses/registry.ts    检测并调用内置 Harness Adapters
src/harnesses/pi.ts          Pi 专属知识
src/harnesses/grok.ts        Grok Build 专属知识
src/harnesses/codex.ts       Codex 专属知识（required-Shared 样板）
src/harnesses/<name>.ts      后续内置 Harness Adapter
src/sources/npx-skills.ts    固定版本的 npx skills Source Adapter
src/inventory.ts             通用 Target/Slot/Relationship 扫描
```

第一版只支持内置 Adapters，不设计第三方插件系统。Harness 更新通常只修改对应 Adapter、fixtures 和证据；Source CLI 更新只修改对应 Source Adapter。

## Target Definitions

Target Definition 是路径与能力规则，Skill Target 是结合 home、project、profile 与 scope 后得到的具体实例。稳定 ID 采用 definition key 加 scope：例如 `pi:global`、`pi:project:<canonical-path>`。项目路径参与实例身份；用户覆盖 discovery root 不改变 definition 身份。

Shared Target Definition 独立存在，不归属于任何 Harness。`targets.json` 是版本化的用户配置，只保存：

- 内置 Target Definition 的明确 overrides；
- 用户创建的 Generic Targets。

内置默认路径留在 Adapter/Target 模块中，避免把会变化的官方默认值复制到用户文件。Generic Target 只承诺目录扫描与 Relationship 管理，不承诺 Harness 隔离或 Effective visibility。

### Legacy migration

旧 `runtimes.json` 只读兼容到显式迁移：

1. inspect 生成 `Runtime → Skill Target` 迁移计划；
2. 已知 key 的非默认路径转为 Target override；
3. 未知项转为 Generic Target；
4. 用户确认后原子写入 `targets.json` 并验证；
5. 原 `runtimes.json` 改名为带版本的 backup，之后只读取 `targets.json`。

只读命令不触发迁移。CLI 使用 `--target`；`--agent` 在一个兼容周期内作为弃用别名。

## Harness Adapter contract

每个内置支持的 Harness 都必须有 Adapter，即使它只读取路径和能力、完全不修改配置。Adapter 集中拥有该 Harness 的外部契约：

- 产品检测、已验证版本和官方证据；
- Global/Project/Profile Target Definitions；
- 实际消费的 Global/Project/ancestor/Shared roots、Shared consumption 与隔离能力；
- 配置文件定位、schema 检查和迁移；
- `inspect → resolve targets`，以及产品需要时的 `plan → apply → verify`；
- Link 支持与必要的 Mirror 策略。

`setup`、`apply` 和配置写入是可选 capability，不是 Adapter 存在的前提。没有内置 Adapter 的自定义目录只能作为 Generic Target，SkillsPub 不承诺其 Harness Effective visibility。

流程控制属于 SkillsPub 应用层。`inspect`、scan、ls 和打开 TUI 严格只读，不创建目录或配置。Project-scoped Harness operation 统一从 `skillspub project <path> harnesses ...` 进入，并把 canonical project path 传给 Adapter；Global operation 不得静默写入项目路径。setup/apply/reconcile 必须：

1. 读取配置并保存内容/hash；
2. 展示路径、语义与完整变更计划；
3. 用户确认后重新校验文件未变化；
4. 原子写入；
5. 重新读取并验证语义。

结构未知、字段类型改变或并发修改时拒绝写入。版本高于已验证版本但 schema 与语义仍可确认时允许操作并提示；不能确认时降为只读。

SkillsPub 只删除自己可证明拥有的配置 claim。原本已存在的用户配置只视为满足要求；用户删除 managed claim 后形成 Drift，只由显式 reconcile 恢复。State 丢失时保留未知 ownership 的配置，不冒险删除。

## Support levels

- `managed`：官方路径、能力与必要配置有证据和 fixtures；Adapter 能通过已验证流程独立控制并解释该 Harness 的 Effective visibility。
- `discoverable`：能可靠解析并扫描 Skill Targets，但不能承诺确定的 Effective visibility。
- `unsupported`：缺少可靠官方机制，SkillsPub 不猜测。

Support level 描述 Adapter 能力，不等于当前配置状态。TUI 主界面只显示检测到的 Harness；未安装的内置支持项放在单独的可添加列表。

## Shared consumption

Harness Adapter 报告它对 Shared Target 的当前状态：

- `not-consumed`：不读取 Shared；无需 setup 也可以独立管理，例如 Claude Code；
- `required`：读取且无官方可靠排除机制；该 Harness 不能达到 `managed`；
- `enabled`：当前读取，但官方支持隔离；Adapter 仍可具有 `managed` 能力，例如 setup 前的 Pi；
- `excluded`：已通过官方机制隔离；
- `unknown`：无法可靠确认。

Shared Target 在矩阵中只显示一次。Harness 详情解释 consumption；`required` 或 `unknown` 时，某个 Harness-specific Target 为 OFF 不等于该 Skill 对 Harness 有确定的 Effective visibility。当前不实现 Consumer/Profile 类型，但 Adapter 结构不得假设一个 Harness 永远只有一个身份或 Target。

## Effective Visibility evidence

Harness Adapter 必须为共用 resolver 提供可审计的本地发现证据，而不是只返回一个路径表或最终布尔值：

- Harness detection、support level、固定 upstream evidence 与 verified version；
- 当前 scope 实际消费、排除或无法确认的 Global、Project、ancestor、Shared 与 vendor-compatible roots；
- 每个 root 的来源、scope、消费理由和配置证据；
- isolation 状态，以及配置/schema/版本不确定性产生的 warnings 或 blockers；
- Adapter 已有的安全 setup/reconcile operations 和 Link/Mirror capability。

Resolver 把该 evidence 与一次 Inventory scan 中的 Resource identity、Target Slots、Relationships、Activation、Resource forms、Variants、Base intent 与 Preset claims 合成 Effective visibility。它不缓存 projection、不创建第二份 Actual state，也不联网读取 Source 或 Harness 文档。

- `visible`：选定 resource 在至少一个已验证 consumed root 中有 ON Relationship，且没有未解析的同名竞争。
- `not-visible`：完整证据证明所有 consumed roots 都不提供该 resource。
- `unknown`：Harness 未检测、support 不是 `managed`、consumption/config/schema 无法确认，或本地版本差异使已验证语义不能成立。
- `conflicted`：不同来源的同名 Variant 可能竞争，而 Adapter 没有官方且经过 fixture 验证的 precedence。不得按 SkillsPub 自定 root 顺序猜测获胜者。

本机 Harness 版本未知或与固定证据版本不同但 schema/语义仍可确认时，结果可保持确定并附 warning；不能确认时降为 `unknown`。Effective visibility 只表示 Harness 下次加载时应发现什么，不承诺运行中进程已经加载。

`--want visible|hidden` 只生成 plan。Managed Harness 的 visible 计划优先使用 Harness-specific Target，并复用 Adapter 的 Link/Mirror 与 isolation operations；hidden 计划必须覆盖所有 contributing roots。Preset claim、未知 ownership、未知配置、同名冲突或未决跨 Skill 副作用阻止 executable plan，并返回 blockers。Explain 不直接修改 Harness 配置或 Relationship。

## Resource forms

Relationship 支持 `local`、`link`、`mirror`：

- 默认使用 Link 复用原始 resource。
- Harness 官方不支持、不跟随 symlink，或其隔离机制按 canonical target 过滤导致 Link 不可见时，Adapter 可以要求使用 Mirror。
- Mirror 是同一 source resource 的受管副本，不是 Variant；其 source identity/hash 必须写入受管 metadata。
- Shared resource 更新后，scan 只报告 Mirror Drift；显式 reconcile 才同步。
- Mirror 被人工修改后标记 diverged，拒绝静默覆盖；用户必须明确覆盖或转为独立 local Variant。
- Mirror OFF 时移入 Target parking area；再次 ON 前校验并按计划同步。

删除仍被当前扫描可见 Links/Mirrors 使用的 source resource 时，计划必须逐项列出依赖。用户再次确认后，级联删除这些已知 Relationships 和 Mirrors。中央 state 不登记项目路径，因此必须警告未打开项目可能遗留 broken links。

## Plugin ownership

SkillsPub 管理落在已管理 Skill Target 中的自包含 `SKILL.md` 目录。Plugin 私有目录中的 Skills 由 Plugin Manager 管理，不进入普通 Target inventory。

如果 Plugin 或其他外部工具把 Skill 复制到已管理 Target，SkillsPub 按普通 Skill Resource 扫描和管理；除非存在可靠 manifest/lock provenance，否则不猜测 Plugin ownership。SkillsPub 可以 ON/OFF 该 resource，但不负责 Plugin 的安装、升级或卸载。Harness bundled、Plugin-provided 与 server-managed Skills 保持外部所有权；Adapter 可以报告其存在，但不把其私有目录变成普通可写 Target。

## Source Adapters

Source Adapter 拥有固定上游版本、命令、输出解析、provenance、lock 语义与兼容 fixtures，不拥有 Harness 配置。按 #145 修订（ADR-0015），v0.1 TUI 的 Source lifecycle 是 Global-only；exact-Project Source 是显式的 advanced Project-owned 副本路径，仅经 CLI（`skillspub project <path> shared …`）进入；既有的 scope/lock/Relationship 隔离保证不变。

`npx skills` Adapter 固定使用一个经过发布验证的版本，并且只安装到 Shared Target：

- 不自动创建任何 Harness-specific Link/Mirror；
- 上游任何 `--agent <name>` 若仍是实现 Shared-only transport 的必要参数，只留在 Adapter 内部，不作为 Harness 支持或隔离能力的证据；
- 用户之后通过 SkillsPub 为其他 Skill Targets 建立 Relationships；
- 升级上游版本时同步更新证据、fixtures 和兼容测试，不使用动态 `latest`。

## Pi v0.1 repaired Adapter and promotion gate

Pi 在旧验收前曾被标为 `managed`，但 real-machine #109 证明 `!skills/**` 同时匹配 Pi 与 Shared 的 `skills/**`，会把 Pi-specific Target 一起压掉。#127 已在 Pi 0.85.1 上完成 repaired Global/exact-Project Adapter、canonical Target migration、fresh-process canary 与 recovery 验收，因此 v0.1 release support 恢复为 `managed`；当前 Shared consumption 仍按每个 scope 的实际配置显示 `enabled` 或 `excluded`。

### Targets, settings, and matcher semantics

- Global Pi Target 保持 `~/.pi/agent/skills`；canonical Project Pi Target 是 selected exact Project 的 `.pi/skills`。
- Project 若仍有 `.pi/agent/skills` Target override，Adapter 必须显示独立 migration plan：来源/目标、冲突、Relationships、ownership、backup 与 expected final truth；确认后才原子迁移并验证。scan、inspect 与打开 TUI 不迁移。
- Global settings 与 exact-Project settings 是两个独立 operations。Global 只写 Global Pi settings；Project 只写 selected canonical Project 的 `.pi/settings.json`，不靠 Global result 推断 Project 已隔离，也不建立中央 Project registry。
- 每个 applicable Shared root 使用 expanded absolute exclusion，例如 `!/absolute/path/.agents/skills/**`。禁止恢复模糊的 `!skills/**`。
- Project plan 必须覆盖 selected Project 以及 Pi 实际会消费的 trusted ancestor `.agents/skills` roots，并尊重 trust gating 与 Git/filesystem boundary；不能只检查当前目录。
- Pi matcher 在 canonical dedupe 前做 lexical matching。inspect/reconcile 必须实现与 loader 相同的 exclusion/force-include precedence、absolute/relative matching、ancestor bypass、trust、collision 与 dedupe 判断。Shared alias 被 exclusion 时，指向同一 resource 的 Pi-root symlink Relationship 仍可保持 enabled。
- 等价但非 SkillsPub-owned 的安全 exclusion 可以满足隔离，不被接管或删除。未知 schema、类型、matcher semantics、untrusted Project、冲突 path 或 concurrent change 使写入降为 read-only/blocked。

### Plan, apply, recovery, and promotion

Pi setup/reconcile 复用 Harness `inspect → immutable plan → confirm → recheck → atomic apply → semantic verify → filesystem rescan` seam。preview 分开显示 Global/Project scope、resolved Pi/Shared roots、exact exclusions、Target migration、Relationship effects、settings/state hashes、backup/manifest/recovery paths 与 expected Actual/Desired/Drift/Effective Visibility。

确认后，apply 必须保存 fresh settings 与 SkillsPub ownership-state backups、SHA-256、affected-path/migration manifest 和 hash-checked recovery instructions。I/O 或 verification failure 不伪装成 managed；保留 completed work、remaining Drift 与 recovery evidence。reconcile/retry 必须幂等并在 fresh inspect 后拒绝 stale plan。

Pi promotion 是 release acceptance gate，不是代码完成后的默认 label。对 acceptance 时安装的 Pi version，必须在 real machine 上：

1. 从 fresh backup 分别 preview/approve/apply Global 与 exact Project；
2. 以 tools-enabled fresh Pi processes 证明 Pi Relationships 仍加载，且每个 applicable Shared root 都被排除；
3. 证明 Adapter inspection、filesystem truth 与 loader canaries 一致；
4. 验证 `.pi/agent/skills` → `.pi/skills` migration 或无迁移条件；
5. 实际执行 recovery，并对 settings/state/content/manifest 做 hash 检查。

任一项未通过，Pi 在 v0.1 仍须保持 `discoverable`，Shared consumption/Effective Visibility 按证据返回 `enabled`、`excluded` 或 `unknown`，不得保留 release-quality Managed claim。#127 已在候选 `e17a9829a489ea2df0ab65c4e574e1f38b3bbe70` 与 Pi 0.85.1 上通过上述五项：Global 136 个与 exact-Project 13 个 Pi Relationships 全部保留，Shared-only canaries 被排除，完整 recovery chain 恢复了 baseline hashes 与可见性。

## Grok Build v0.1 managed slice

Grok Build 保持 `managed/excluded` release contract；Pi 已依据 #127 恢复 `managed` support。Adapter key 是 `grok`，已验证契约固定到 `xai-org/grok-build` revision `19d42e35c07a9c9244f03f6df0c4c353f970d4f9`。该切片只管理 Grok 原生 Global/Project Skill Targets，不接管 Plugin、bundled、server-managed 或命令目录。

### Targets and resource form

- Global Target：`$GROK_HOME/skills`，未设置时为 `~/.grok/skills`。
- Project Target：所选项目的 `.grok/skills`；现有 Project inventory 继续把 ancestor entries 投影为只读继承。
- 当前上游实现会遍历 symlink，但没有稳定的官方兼容承诺，且 `[skills].ignore` 会 canonicalize link target。为避免被隔离 Shared root 下的 Link 绕过 Relationship ON/OFF，Adapter 把有效 Link capability 报为 unsupported，新建 missing Relationship 使用现有 Managed Mirror 实现。
- Mirror 更新、Drift、diverged 与 parking 继续使用通用 Resource form 语义，不在 Adapter 内另建副本模型。

### Isolation

Grok 默认读取 `.grok/skills`、Global/Project/ancestor `.agents/skills` 以及 Claude/Cursor 兼容 Skill 目录。严格 managed setup 必须：

1. 在 `[skills].ignore` 中加入 user Shared root；Project setup 还加入所选项目及当前已存在 ancestor Shared roots；
2. 设置 `[compat.claude].skills = false` 与 `[compat.cursor].skills = false`，不改 rules、agents、MCP、hooks 或 sessions 等其他兼容 surface；
3. 重新读取有效配置并验证上述来源不再贡献 Skills；
4. 把兼容入口保留为 Adapter 私有 isolation 细节，不泛化新的 Target-consumption 领域类型。

若用户已有非空 `skills.paths`、`skills.disabled`，或 `skills.ignore` 与 Grok Targets 冲突，setup 列出 blocker 并保持零变更；TOML malformed 或类型异常同样在写入前失败，不导入、不覆盖、不猜测 intent。Plugin、bundled 与 server-managed Skills 保持外部所有权，不影响 Grok 原生 Targets 的 Relationship 管理。

### Migration and commands

setup 计划列出隔离后将失效的 Relationships。用户确认后，SkillsPub 只 Unlink affected-Link manifest 中的 Grok symlinks，不删除 source resource，也不自动创建 Mirrors。写入前保存原配置、SHA-256 与 affected-Link manifest，复核并发变化后原子写配置，再验证 Shared 与 vendor-compatible isolation。

Global 操作使用 `skillspub harnesses grok setup|reconcile [--yes]`。Project 操作使用 `skillspub project <path> harnesses grok setup|reconcile [--yes]`，只传递 canonical project path，不创建中央 Project registry。写入保留无关 TOML、comments、非-Skill compatibility cells 与 Grok-private resources；apply 后打印 backup/manifest 的手工恢复步骤。v0.1 不提供 `unsetup`。

官方证据：[settings reference](https://docs.x.ai/build/settings/reference)、[Skills/Plugins/Marketplaces](https://docs.x.ai/build/features/skills-plugins-marketplaces)、[pinned discovery source](https://github.com/xai-org/grok-build/blob/19d42e35c07a9c9244f03f6df0c4c353f970d4f9/crates/codegen/xai-grok-agent/src/prompt/skills.rs)。

## Codex v0.2 required-Shared Adapter

v0.2 为 Codex 增加 `discoverable` Adapter（#170）。这是强制读全局 Harness 的样板：Shared consumption 如实报告 `required`，不做阻断 hack；自有 Target 仍走通用 ON/OFF/批量/Project inventory。Cursor/OpenCode/Hermes（#171–#173）按同一 Adapter 形状复制，不抽公共基类。

### Targets

- Global Target：`$CODEX_HOME/skills`，未设置时为 `~/.codex/skills`。官方 loader 将其标为 deprecated user location，仍消费。
- Canonical user root：`$HOME/.agents/skills`（Shared Target）。官方文档无 root-level exclusion；`[[skills.config]]` 只是 per-skill 开关，不当作 Shared Target isolation。
- Project Target：所选项目的 `.codex/skills`（project config-folder skills）。
- Repository Shared：所选项目的 `.agents/skills`。Adapter 不把 `/etc/codex/skills`、bundled SYSTEM 或 plugin roots 做成可写 Target。

Support 保持 `discoverable`：required Shared 使该 Harness 不能达到 `managed`。无 setup/reconcile。官方支持 symlink，Link capability 为 supported。

官方证据：[Agent Skills](https://developers.openai.com/codex/skills)（verifiedVersion `0.154.0`）、[pinned host_roots.rs rust-v0.154.0](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/ext/skills/src/host_roots.rs)。

## v0.1 no-launcher boundary and empty additional shortlist

SkillsPub 不拥有 Harness startup。v0.1 不增加 wrapper command、OS persistent environment provisioning、per-entry-point environment/argument profiles、IDE/GUI/daemon/service/remote/container launch integration，也不建立 Launch Profile identity、Desired state、Drift、backup 或 recovery model。already-running process 永远不被当作 reload；依赖 process environment、arguments 或特定 launcher 的 consumption 在未受控 entry point 下为 `unknown`。

Harness 只有在自己的 persistent filesystem/configuration seam 允许 SkillsPub 完整 inspect、reconcile、verify 与 recover claimed consumption boundary 时才可为 `managed`。因此 v0.1 additional Managed Harness shortlist 为零：

- OpenCode、Kimi Code、TraeCode 保持 evidence-backed `discoverable` compatibility-roadmap candidates，不实现 runtime Adapter；Codex 在 v0.2 有 `discoverable` Adapter（#170），Shared `required`，仍不能 promotion 为 `managed`；
- WorkBuddy 保持 `unsupported`，不根据未合并 patch 猜 `.workbuddy/skills`；
- adoption、path table、partial discovery 与 launch-scoped control 都不能替代 Managed evidence bar。

以后 promotion 必须重新取得 current official evidence、real installation/detection、consumed roots/config/precedence、real setup/reconcile、fresh next-load canary、backup 与 exercised recovery；它不是本 v0.1 map 中延后的实现。

## Evidence baseline and delivery order

以下是 2026-09-04 owner-approved boundary 的证据与 release 状态：

| Harness | 已确认的官方/本机行为 | v0.1 状态/计划 | 证据 |
| --- | --- | --- | --- |
| Pi | Pi roots 与 `.agents/skills` 共用 matcher；root-specific absolute exclusions 可在 canonical dedupe 前只排除 Shared alias | `managed`；Global/exact-Project isolation 可独立为 `enabled` 或 `excluded`，并保留 Pi Target Relationships | [#109 failed machine chain](https://github.com/AlligatorT/SkillsPub/issues/109#issuecomment-5532175662), [#115 decision](https://github.com/AlligatorT/SkillsPub/issues/115#issuecomment-5543708195), [#127 Pi 0.85.1 real-machine acceptance](https://github.com/AlligatorT/SkillsPub/issues/127), [pinned research](https://github.com/AlligatorT/SkillsPub/blob/4f6ae8d62bf1c4182ec70682b4ff755435dcfab5/docs/research/pi-shared-skill-root-isolation-0.84.4.md), [Pi 0.85.1 skills docs](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/skills.md) |
| Claude Code | Personal/Project `.claude/skills` 支持 symlink；accepted Adapter contract 不消费 Shared | `managed`；Shared `not-consumed`、isolation `not-required`，不增加配置写入；只解释 next load | [Skills](https://docs.anthropic.com/en/docs/claude-code/skills), [Settings](https://docs.anthropic.com/en/docs/claude-code/settings), [#112 contract](https://github.com/AlligatorT/SkillsPub/issues/112#issuecomment-5547687525) |
| Grok Build | `$GROK_HOME/skills`、Project/ancestor `.grok/skills`、Shared 与 Claude/Cursor compatible roots；canonical ignore 可隔离 Shared | 保持 `managed/excluded`；Global/Project setup/reconcile 必须完整显示 Relationship impact 与 recovery | [settings](https://docs.x.ai/build/settings/reference), [skills](https://docs.x.ai/build/features/skills-plugins-marketplaces), [pinned source](https://github.com/xai-org/grok-build/blob/19d42e35c07a9c9244f03f6df0c4c353f970d4f9/crates/codegen/xai-grok-agent/src/prompt/skills.rs), [#109 machine evidence](https://github.com/AlligatorT/SkillsPub/issues/109#issuecomment-5532175662) |
| OpenCode | Native/Shared/vendor roots 强；完整 isolation 依赖 actual process 的 environment flag | `discoverable` roadmap candidate；v0.1 无 Adapter，no-launcher boundary 下不 promotion | [research resolution](https://github.com/AlligatorT/SkillsPub/issues/104#issuecomment-5470909113), [launch evidence](https://github.com/AlligatorT/SkillsPub/issues/113#issuecomment-5531242966) |
| Codex | 官方 user root 为 `$HOME/.agents/skills`；`$CODEX_HOME/skills` 为 deprecated 兼容位置；Project `.codex/skills`；symlink 跟随；无 root-level Shared exclusion | v0.2 `discoverable` Adapter；Shared `required`；自有 Global/Project Target 可管理；无 isolation write | [Agent Skills](https://developers.openai.com/codex/skills), [pinned host_roots.rs 0.154.0](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/ext/skills/src/host_roots.rs), [#103 research](https://github.com/AlligatorT/SkillsPub/issues/103#issuecomment-5470908872) |
| Kimi Code | roots、precedence、schema、symlink 与 next-session 有证据；替换自动 Shared discovery 依赖每次启动的 `--skills-dir` | `discoverable` roadmap candidate；v0.1 无 Adapter，no-launcher boundary 下不 promotion | [research resolution](https://github.com/AlligatorT/SkillsPub/issues/105#issuecomment-5470909355), [launch evidence](https://github.com/AlligatorT/SkillsPub/issues/113#issuecomment-5531242966) |
| TraeCode | International product 有 native Global/Project roots 与 opt-in Project Shared evidence | `discoverable` roadmap candidate；toggle/schema/precedence/recovery/regional parity/real-machine evidence 不足，v0.1 无 Adapter | [research resolution](https://github.com/AlligatorT/SkillsPub/issues/107#issuecomment-5470909721) |
| WorkBuddy | official evidence 未证明 directory-based Agent Skills Target 或 machine-readable visibility control | `unsupported`；v0.1 无 Adapter | [research resolution](https://github.com/AlligatorT/SkillsPub/issues/106#issuecomment-5470909548) |
| DeepSeek Harness | Skill registry/provider 为 Profile plugin；default roots 可重组 | Consumer/Profile 与 Plugin composition 明确前延后 | [Developer preview](https://deepseek.com/harness/en/), [Skills subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md) |
| Hermes | 每个 Profile 有独立 `HERMES_HOME` 与 `skills/`；可配置 external dirs | 多 Profile 需求明确前延后 | [Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles), [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) |
| OpenClaw | 多 Target roots 与 per-Agent final allowlists | 多 Agent identity model 明确前延后 | [Skills](https://docs.openclaw.ai/tools/skills), [Skills config](https://docs.openclaw.ai/tools/skills-config) |

集成 candidate 已包含 complete A+C Source workspace、通过 #127 的 Pi Global/Project repair 与 promotion、Relationship/Desired-state、Effective Visibility，以及 Claude/Grok contracts。v0.1 publication 仍受 #128 exact-candidate Grok/Claude revalidation、#129 automated/package handoff 和 human release gates 阻塞。固定 Vercel `skills` 仍是唯一 remote Source lifecycle/lock owner。后续 Harness 只有满足 complete consumed-root/control/recovery evidence 才能让 resolver 给出 release-quality non-`unknown` claim。
