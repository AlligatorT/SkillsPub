# Spec: Skill Targets and Adapters

本规范定义 SkillsPub 如何把易变的 Harness 与安装器规则隔离在 Adapter seams。领域术语见 `CONTEXT.md`，CLI/TUI 行为见 `docs/spec/cli.md`。

## Module seams

```text
src/targets/shared.ts        Shared Target Definition
src/harnesses/registry.ts    检测并调用内置 Harness Adapters
src/harnesses/pi.ts          Pi 专属知识
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

内置默认路径留在 Adapter/Target 模块中，避免把会变化的官方默认值复制到用户文件。Generic Target 只承诺目录扫描与 Relationship 管理，不承诺 Harness 隔离或最终可见性。

### Legacy migration

旧 `runtimes.json` 只读兼容到显式迁移：

1. inspect 生成 `Runtime → Skill Target` 迁移计划；
2. 已知 key 的非默认路径转为 Target override；
3. 未知项转为 Generic Target；
4. 用户确认后原子写入 `targets.json` 并验证；
5. 原 `runtimes.json` 改名为带版本的 backup，之后只读取 `targets.json`。

只读命令不触发迁移。CLI 使用 `--target`；`--agent` 在一个兼容周期内作为弃用别名。

## Harness Adapter contract

每个 Adapter 集中拥有该 Harness 的外部契约：

- 产品检测、已验证版本和官方证据；
- Global/Project/Profile Target Definitions；
- Shared consumption 的读取与隔离能力；
- 配置文件定位、schema 检查和迁移；
- `inspect → resolve targets → plan → apply → verify`；
- Link 支持与必要的 Mirror 策略。

流程控制属于 SkillsPub 应用层。`inspect`、scan、ls 和打开 TUI 严格只读，不创建目录或配置。setup/apply/reconcile 必须：

1. 读取配置并保存内容/hash；
2. 展示路径、语义与完整变更计划；
3. 用户确认后重新校验文件未变化；
4. 原子写入；
5. 重新读取并验证语义。

结构未知、字段类型改变或并发修改时拒绝写入。版本高于已验证版本但 schema 与语义仍可确认时允许操作并提示；不能确认时降为只读。

SkillsPub 只删除自己可证明拥有的配置 claim。原本已存在的用户配置只视为满足要求；用户删除 managed claim 后形成 Drift，只由显式 reconcile 恢复。State 丢失时保留未知 ownership 的配置，不冒险删除。

## Support levels

- `managed`：官方路径与配置有证据、fixtures、读写及语义验证，可安全管理。
- `discoverable`：能可靠解析并扫描 Skill Targets，但不修改 Harness 配置。
- `unsupported`：缺少可靠官方机制，SkillsPub 不猜测。

TUI 主界面只显示检测到的 Harness；未安装的内置支持项放在单独的可添加列表。只有 `managed` 承诺独立管理。

## Shared consumption

Harness Adapter 报告它对 Shared Target 的状态：

- `not-consumed`：不读取 Shared；
- `required`：读取且无官方可靠排除机制；
- `enabled`：当前读取，但官方支持隔离；
- `excluded`：已通过官方机制隔离；
- `unknown`：无法可靠确认。

Shared Target 在矩阵中只显示一次。Harness 详情解释 consumption；`unknown` 不作最终可见性承诺。当前不实现 Consumer/Profile 类型，但 Adapter 结构不得假设一个 Harness 永远只有一个身份或 Target。

## Resource forms

Relationship 支持 `local`、`link`、`mirror`：

- 默认使用 Link 复用原始 resource。
- Harness 官方不支持或不会跟随 symlink 时，Adapter 可以创建 Mirror。
- Mirror 是同一 source resource 的受管副本，不是 Variant；其 source identity/hash 必须写入受管 metadata。
- Shared resource 更新后，scan 只报告 Mirror Drift；显式 reconcile 才同步。
- Mirror 被人工修改后标记 diverged，拒绝静默覆盖；用户必须明确覆盖或转为独立 local Variant。
- Mirror OFF 时移入 Target parking area；再次 ON 前校验并按计划同步。

删除仍被当前扫描可见 Links/Mirrors 使用的 source resource 时，计划必须逐项列出依赖。用户再次确认后，级联删除这些已知 Relationships 和 Mirrors。中央 state 不登记项目路径，因此必须警告未打开项目可能遗留 broken links。

## Plugin ownership

SkillsPub 管理落在已管理 Skill Target 中的自包含 `SKILL.md` 目录。Plugin 私有目录中的 Skills 由 Plugin Manager 管理，不进入普通 Target inventory。

如果 Plugin 或其他外部工具把 Skill 复制到已管理 Target，SkillsPub 按普通 Skill Resource 扫描和管理；除非存在可靠 manifest/lock provenance，否则不猜测 Plugin ownership。SkillsPub 可以 ON/OFF 该 resource，但不负责 Plugin 的安装、升级或卸载。

## Source Adapters

Source Adapter 拥有固定上游版本、命令、输出解析、provenance、lock 语义与兼容 fixtures，不拥有 Harness 配置。

`npx skills` Adapter 固定使用一个经过发布验证的版本，并且只安装到 Shared Target：

- 不自动创建任何 Harness-specific Link/Mirror；
- 上游 `--agent codex` 若仍是实现 Shared-only transport 的必要参数，只留在 Adapter 内部；
- 用户之后通过 SkillsPub 为其他 Skill Targets 建立 Relationships；
- 升级上游版本时同步更新证据、fixtures 和兼容测试，不使用动态 `latest`。

## Evidence baseline and delivery order

以下是 2026-08-12 的官方证据与 Adapter 规划，不表示这些 Adapters 已全部实现：

| Harness | 已确认的官方行为 | Adapter 计划 | 官方证据 |
| --- | --- | --- | --- |
| Pi | 同时发现 Pi 专属 roots 与 `.agents/skills`；`skills` 配置支持 glob exclusion | 第一批达到 `managed`，默认计划隔离 Shared，但只在 setup/apply 时确认写入 | [skills docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md), [v0.54.0](https://github.com/earendil-works/pi/releases/tag/v0.54.0), [discovery commit](https://github.com/earendil-works/pi/commit/39cbf47e42433ce301dabcec398cac6fe5f0fa22) |
| Codex | Global/Repo Skills 使用 `.agents/skills`；`[[skills.config]]` 提供按路径启停 | 先保留证据；另行设计逐 Skill override 后再决定 support level | [Agent Skills](https://developers.openai.com/codex/skills), [config sample](https://developers.openai.com/codex/config-sample) |
| Claude Code | Personal/Project 使用 `.claude/skills`，支持 symlink；Plugin Skills 位于 plugin 内并 namespaced | 后续 Adapter；Shared 默认为 `not-consumed`，Plugin ownership 保持外部 | [Skills](https://docs.anthropic.com/en/docs/claude-code/skills), [Settings](https://docs.anthropic.com/en/docs/claude-code/settings) |
| Hermes | 每个 Profile 有独立 `HERMES_HOME` 与 `skills/`；可配置 `skills.external_dirs` | 等多 Profile 需求明确后实现，不提前引入 Consumer 模型 | [Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles), [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) |
| OpenClaw | 支持多种 Target roots 与 per-Agent final skill allowlists | 等多 Agent 身份模型设计后实现 | [Skills](https://docs.openclaw.ai/tools/skills), [Skills config](https://docs.openclaw.ai/tools/skills-config) |

实施顺序：先收尾现有 Project TUI；再迁移 Skill Target 术语和持久格式；然后建立 Adapter seam 并完成 Pi Managed；再抽离 `npx skills` Source Adapter；其余 Harness 逐个以官方证据和 fixtures 提升支持等级。
