# Spec: Skill Targets and Adapters

本规范定义 SkillsPub 如何把易变的 Harness 与安装器规则隔离在 Adapter seams。领域术语见 `CONTEXT.md`，CLI/TUI 行为见 `docs/spec/cli.md`。

## Module seams

```text
src/targets/shared.ts        Shared Target Definition
src/harnesses/registry.ts    检测并调用内置 Harness Adapters
src/harnesses/pi.ts          Pi 专属知识
src/harnesses/grok.ts        Grok Build 专属知识
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

Source Adapter 拥有固定上游版本、命令、输出解析、provenance、lock 语义与兼容 fixtures，不拥有 Harness 配置。

`npx skills` Adapter 固定使用一个经过发布验证的版本，并且只安装到 Shared Target：

- 不自动创建任何 Harness-specific Link/Mirror；
- 上游任何 `--agent <name>` 若仍是实现 Shared-only transport 的必要参数，只留在 Adapter 内部，不作为 Harness 支持或隔离能力的证据；
- 用户之后通过 SkillsPub 为其他 Skill Targets 建立 Relationships；
- 升级上游版本时同步更新证据、fixtures 和兼容测试，不使用动态 `latest`。

## Grok Build v0.1 managed slice

Grok Build 是 Pi、Claude Code 之后的第三个 `managed` Harness。Adapter key 是 `grok`，已验证契约固定到 `xai-org/grok-build` revision `19d42e35c07a9c9244f03f6df0c4c353f970d4f9`。该切片只管理 Grok 原生 Global/Project Skill Targets，不接管 Plugin、bundled、server-managed 或命令目录。

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

## Evidence baseline and delivery order

以下是 2026-08-20 的官方证据与 Adapter 状态：

| Harness | 已确认的官方行为 | Adapter 状态/计划 | 官方证据 |
| --- | --- | --- | --- |
| Pi | 同时发现 Pi 专属 roots 与 `.agents/skills`；`skills` 配置支持 glob exclusion | 已实现 `managed`；setup/apply 显式隔离 Shared | [skills docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md), [v0.54.0](https://github.com/earendil-works/pi/releases/tag/v0.54.0), [discovery commit](https://github.com/earendil-works/pi/commit/39cbf47e42433ce301dabcec398cac6fe5f0fa22) |
| Claude Code | Personal/Project 使用 `.claude/skills`，支持 symlink；Plugin Skills 位于 plugin 内并 namespaced | 已实现 `managed`；Shared 为 `not-consumed`，无需配置写入 | [Skills](https://docs.anthropic.com/en/docs/claude-code/skills), [Settings](https://docs.anthropic.com/en/docs/claude-code/settings) |
| Grok Build | `$GROK_HOME/skills`、Project/ancestor `.grok/skills`、Shared `.agents/skills` 与默认启用的 Claude/Cursor roots；canonical `[skills].ignore` 可隔离 Shared | 已实现 `managed`；setup/reconcile 管理 isolation，missing Relationship 默认 Mirror | [settings](https://docs.x.ai/build/settings/reference), [skills](https://docs.x.ai/build/features/skills-plugins-marketplaces), [pinned source](https://github.com/xai-org/grok-build/blob/19d42e35c07a9c9244f03f6df0c4c353f970d4f9/crates/codegen/xai-grok-agent/src/prompt/skills.rs) |
| Codex | Global/Repo Skills 使用 `.agents/skills`；`[[skills.config]]` 提供按路径启停 | 保留证据；另行设计逐 Skill override 后再决定 support level | [Agent Skills](https://developers.openai.com/codex/skills), [config sample](https://developers.openai.com/codex/config-sample) |
| Kimi Code CLI | 同时发现品牌目录与 `.agents/skills`；`--skills-dir` 可替换自动发现但属于每次启动参数 | 可研究 `discoverable`；SkillsPub 不负责启动 Harness，因此不能据此承诺 `managed` | [Agent Skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html), [Kimi CLI source docs](https://github.com/MoonshotAI/kimi-cli/blob/main/docs/en/customization/skills.md) |
| OpenCode | 原生 `.opencode/skills`，并自动发现 `.agents/skills` 与 `.claude/skills`；可靠总开关是进程环境变量 | 可研究 `discoverable`；不增加 launcher/wrapper 时不承诺 `managed` | [Agent Skills](https://opencode.ai/docs/skills/), [runtime flags](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/src/effect/runtime-flags.ts) |
| DeepSeek Harness | Skill registry/provider 为 Profile plugin；默认 roots 包含 `.dsh/skills` 与 `.agents/skills`，可用 `includeDefaultRoots: false` 重组 | 等 Consumer/Profile 与 Plugin composition 模型明确后实现；developer preview 不进入当前切片 | [Developer preview](https://deepseek.com/harness/en/), [Skills subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md) |
| Hermes | 每个 Profile 有独立 `HERMES_HOME` 与 `skills/`；可配置 `skills.external_dirs` | 等多 Profile 需求明确后实现，不提前引入 Consumer 模型 | [Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles), [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) |
| OpenClaw | 支持多种 Target roots 与 per-Agent final skill allowlists | 等多 Agent 身份模型设计后实现 | [Skills](https://docs.openclaw.ai/tools/skills), [Skills config](https://docs.openclaw.ai/tools/skills-config) |

已完成 Project TUI、Skill Target 迁移、Pi、Claude Code 与 Grok Build Managed Adapters，以及 `npx skills` Source Adapter。v0.1 按 #67 增加共用 Effective Visibility resolver、CLI/JSON Explain 与 TUI evidence detail，并继续 Source update、JSON CLI 与 pre-release hardening。后续 Harness Adapter 必须提供 consumed-root evidence，才能让 Explain 返回非 `unknown` 结论；DeepSeek Harness、OpenClaw 与 Hermes 在 Consumer/Profile 模型明确前保持延后。
