# SkillsPub

SkillsPub 是 Agent Skills 的 verified visibility 与 Relationship manager。它管理 skill resources 与 Skill Targets 之间的 Relationships，并解释一个已安装 resource 为何会或不会被 Harness 在下次加载时发现；磁盘记录 Actual state，SkillsPub state 记录人工 intent 与 persistent Preset claims。

## Language

**Skill resource**:
一个含 `SKILL.md` 的自包含真实目录。可解析时以 canonical `realPath` 识别，不通过名称猜测来源。
_避免_: Installation

**Skill name**:
Skill 面向人的名称。名称不保证跨来源唯一；同一 Skill Target 内经 installer 规范化后的名称会竞争同一个 Slot。
_避免_: 全局 Skill ID

**Variant**:
与另一个 skill resource 同名、但 `realPath` 不同的资源。只有同名歧义时，界面才添加来源后缀。
_避免_: Duplicate、受管镜像

**Catalog candidate**:
尚未安装的远程候选，以 `source + skill path/name` 识别。skills.sh 可以包含多个不同来源的同名候选。
_避免_: 用 name 去重搜索结果

**Harness**:
发现并使用 Skills 的产品，例如 Claude Code、Codex、Hermes、OpenClaw 或 Pi。
_避免_: 用 Agent 同时表示产品、Profile 与进程

**Target Definition**:
把 Harness 或公共标准的发现规则解析为 Skill Target 的定义，包括路径规则、scope、parking 和能力。内置定义由 Adapter 维护；用户配置只保存覆盖与 Generic Target。
_避免_: 把未解析的路径模板当作实际 Target

**Skill Target**:
Skill 被放置和管理的具体目标，具有已解析的 discovery root、scope、稳定 ID 与可写状态。Relationship 的目标是 Skill Target，而不是 Harness。
_避免_: Runtime、假设一个 Harness 只有一个 Target

**Shared Skill Target**:
公共标准定义的 Skill Target，例如 `~/.agents/skills`。它只显示一个开关；哪些 Harness 消费或排除它，由各 Harness Adapter 报告。
_避免_: Shared Harness、Dedicated Target、为每个消费者复制 Shared 开关

**Generic Target**:
用户为未内置支持的 Harness 或自定义目录声明的 Skill Target。SkillsPub 可以扫描和管理目录，但不承诺理解其 Harness 配置、隔离或 Effective visibility。

**Target Slot**:
Skill Target discovery root 下由规范化 entry name 占据的位置，以 `(Target, normalized name)` 识别。同一 Target 的一个 Slot 同时只能承载一个来源。

**Relationship**:
一个 skill resource 与 Target Slot 之间已经存在的关联，由 discovery root 或其外部 parking area 中的目录 entry 表示。
_避免_: 把 Relationship 限定为 skill × Harness

**Activation**:
Relationship 的可见性：`on` 表示 entry 位于 Target discovery root；`off` 表示 entry 位于该 Target 的 parking area。`off` 可恢复且不等于删除。
_避免_: 把 OFF 内容放在 discovery root 的递归子目录

**Resource form**:
Relationship 的资源形态：`local` 是原始真实目录，`link` 是 symlink，`mirror` 是 Harness 不支持 Link 时由 SkillsPub 追踪来源的受管副本。Resource form 与 Activation 相互独立。
_避免_: 把 form 当作 Activation、把 mirror 当作 Variant

**Missing relationship**:
选定 resource 与 Target Slot 之间没有 entry。它不是 `off`，需要 Link 或受管 Mirror 才能建立 Relationship。
_避免_: Disabled

**Broken link**:
目标无法解析的 symlink Relationship。它是显式异常，不得与 missing 或同名 Variant 静默合并。

**Provenance**:
当前来源的可靠本地 metadata，优先采用 installer lock 的 `sourceUrl`、`skillPath` 等字段。来源是 Shared Slot 的可变属性，不是其持久身份；无法确认时显示 `Source unknown`。
_避免_: Source guess、Expected source

**Harness Adapter**:
每个内置支持的 Harness 都有一个 Adapter，集中维护其官方发现路径、配置格式、隔离能力、Target 解析、变更计划、写入与验证。Adapter 不一定修改 Harness 配置；`setup`、`apply` 等写入能力按产品需要提供。Inventory 不包含 Harness 专属配置知识。

**Source Adapter**:
集中维护一个安装来源或传输工具的固定版本、命令、输出解析、provenance 和兼容性，例如 `npx skills`。Source Adapter 不决定最终启用哪些 Harness Targets。

**Project-owned Source copy**:
exact Project scope 中独立拥有、独立 lock/update/remove 的 Source resource 副本；仅通过显式 CLI（`skillspub project <path> shared …`）管理，区别于默认推荐的 Global Source lifecycle；v0.1 TUI 不呈现（ADR-0015）；与同名 Global resource 永不构成同一条更新流。
_避免_: 把 Global 与 Project 副本当作一个共享 update stream、把 Source 当作自动创建 Project Link 的途径

**Update availability**:
Source Adapter 对受管 Skill 当前 provenance 与上游内容的缓存比较结果：`current`、`available`、`upstream-missing` 或 `check-failed`，并带 `checkedAt`。它是可过期观察，不属于 Actual state、Desired state 或 Drift。
_避免_: Upstream drift、自动更新状态

**Support level**:
Harness Adapter 的能力等级。`managed` 表示 Adapter 能通过已验证流程独立控制并解释该 Harness 的 Effective visibility；`discoverable` 只可靠解析和扫描 Targets；`unsupported` 不猜测。Support level 描述能力，不表示当前已经隔离 Shared。

**Shared consumption**:
Harness 对 Shared Skill Target 的已验证关系：`not-consumed`、`required`、`enabled`、`excluded` 或 `unknown`。它描述当前状态以及 Effective visibility 的一个输入，不复制 Target Relationship。

**Effective visibility**:
针对一个已安装 Skill resource 与 Harness 的本地只读结论：根据 Actual Relationships、Harness 实际消费的 Targets、配置与 Adapter 证据，判断该 resource 在 Harness 下次加载时是 `visible`、`not-visible`、`unknown` 或 `conflicted`。它不声称知道运行中进程的内存状态。
_避免_: Final visibility、Live visibility、把目录存在直接当作可见

**Visibility explanation**:
Effective visibility 的可审计说明，包括贡献或绕过预期的 Targets/roots、Shared consumption、同名冲突、版本证据和可选目标计划。计划只描述安全的现有操作；证据不足、Preset claim 或未知 ownership 作为 blocker，不被猜测或自动覆盖。

**Actual state**:
现场扫描得到的 Relationship、Activation 与 Resource form。磁盘是 Actual state 的唯一真相。

**Base intent**:
没有 Preset claim 时希望 Relationship 采用的 Activation。人工和外部 ON/OFF 都更新 Base intent。

**Preset claim**:
一个 active Preset 对 Target Slot 产生的正向 ON 要求。Claims 不表达强制 OFF；多个 Claims 按 Slot 去重。

**Desired state**:
`Preset claims` 与 `Base intent` 合成的目标状态：存在任一 claim 时为 ON，否则采用 Base intent。

**Drift**:
Actual state 与 Desired state，或受管 Harness/Source 配置与其 claim 不一致。SkillsPub 显示 drift，但没有 watcher、daemon 或后台自动修复。

**Reconcile**:
显式、幂等地把 Actual state 和受管配置收敛到 Desired state。预检失败时零变更；意外 I/O 失败保留已完成操作与 Desired state，后续再次 reconcile。

**Bundle**:
多个 skill resources 的全局命名分组，是一次性选择器，不保存 activation。

**Tag**:
用于过滤和批量选择 resources 的全局人工标签，不做智能分类。

**Preset**:
由 `skill:`、`bundle:`、`tag:` 等动态 selectors 组成的全局持久 ON policy。Preset 可分别在 Global 或某个 Project Skill Target 上 activate。
_避免_: 一次性拷贝、强制 OFF profile

**Orphaned Preset Activation**:
项目仍引用已删除的全局 Preset definition。项目打开前不做任何变更；打开后冻结上次 `lastClaims`，由用户选择保留或移除并 reconcile。

**Project state**:
只在精确项目目录启动或显式指定该目录时读取的 `.skillspub/state.json`。它保存该项目的 Base intent、Preset activations 与 `lastClaims`；不在中央登记项目路径。

**Stale reference**:
Bundle、Tag 或 Preset selector 仍引用已不存在 resource 时保留的成员关系，供资源恢复后重新解析。

**CLI-coupled skill**:
依赖配套 CLI 才能执行能力的 Skill。SkillsPub 只管理其 skill resource，不管理配套 CLI。

**Projection**:
从一次 inventory scan 派生的展示层翻译（如 skill × target 矩阵行），不写磁盘、不另建真相。矩阵列是 Target key；所有磁盘变更走 plan/apply，不走 Projection。
_避免_: 第二个读模型、视图自带扫描
