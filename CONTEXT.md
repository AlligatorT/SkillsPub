# SkillsPub

SkillsPub 管理 skill resources 与 Runtime discovery roots 之间的 Relationships。磁盘记录实际状态；SkillsPub state 记录人工 intent 与 persistent Preset claims。

## Language

**Skill resource**:
一个含 `SKILL.md` 的自包含真实目录。可解析时以 canonical `realPath` 识别，不通过名称猜测来源。
_避免_: Installation

**Skill name**:
Skill 面向人的名称。名称不保证跨来源唯一；同一 Runtime 内经 installer 规范化后的名称会竞争同一个 Slot。
_避免_: 全局 Skill ID

**Variant**:
与另一个 skill resource 同名、但 `realPath` 不同的资源。只有同名歧义时，界面才添加来源后缀。
_避免_: Duplicate、copy

**Catalog candidate**:
尚未安装的远程候选，以 `source + skill path/name` 识别。skills.sh 可以包含多个不同来源的同名候选。
_避免_: 用 name 去重搜索结果

**Agent**:
消费一个或多个 Runtime roots 的执行环境，例如 Claude、Codex 或 Pi。
_避免_: Client、provider

**Runtime**:
一个可独立管理的 skill discovery root。Runtime 是 Relationship 的目标；它不一定等于一个 Agent。
_避免_: 假设每个 root 只属于一个 Agent

**Agent Runtime**:
只有一个 Agent 消费的专属 Runtime，例如 `~/.claude/skills`。

**Shared Runtime**:
多个 Agents 共同消费的 Runtime，例如 `~/.agents/skills`。Shared Runtime 只有整体开关；消费者 Agent 上的 Shared 状态只读展示，不提供无法兑现的 per-Agent OFF。
_避免_: Universal Agent

**Runtime Slot**:
Runtime root 下由规范化 entry name 占据的位置，以 `(Runtime, normalized name)` 识别。同一 Runtime 的一个 Slot 同时只能承载一个来源。

**Relationship**:
一个 skill resource 与 Runtime Slot 之间已经存在的关联，由 Runtime root 或其外部 parking area 中的目录 entry 表示。
_避免_: 把 Relationship 限定为 skill × Agent

**Activation**:
Relationship 的可见性：`on` 表示 entry 位于 Runtime discovery root；`off` 表示 entry 位于该 Runtime 的 parking area。`off` 可恢复且不等于删除。
_避免_: 把 OFF 内容放在 discovery root 的递归子目录

**Resource form**:
Relationship 的资源形态：`local` 是真实目录，`link` 是 symlink。Resource form 与 Activation 相互独立。
_避免_: 把 `link` 当作第三种 Activation

**Missing relationship**:
选定 resource 与 Runtime Slot 之间没有 entry。它不是 `off`，需要 Link 才能建立 Relationship。
_避免_: Disabled

**Broken link**:
目标无法解析的 symlink Relationship。它是显式异常，不得与 missing 或同名 Variant 静默合并。

**Provenance**:
当前来源的可靠本地 metadata，优先采用 installer lock 的 `sourceUrl`、`skillPath` 等字段。来源是 Shared Slot 的可变属性，不是其持久身份；无法确认时显示 `Source unknown`。
_避免_: Source guess、Expected source

**Actual state**:
现场扫描得到的 Relationship、Activation 与 Resource form。磁盘是 Actual state 的唯一真相。

**Base intent**:
没有 Preset claim 时希望 Relationship 采用的 Activation。人工和外部 ON/OFF 都更新 Base intent。

**Preset claim**:
一个 active Preset 对 Runtime Slot 产生的正向 ON 要求。Claims 不表达强制 OFF；多个 Claims 按 Slot 去重。

**Desired state**:
`Preset claims` 与 `Base intent` 合成的目标状态：存在任一 claim 时为 ON，否则采用 Base intent。

**Drift**:
Actual state 与 Desired state 不一致。SkillsPub 显示 drift，但没有 watcher、daemon 或后台自动修复。

**Reconcile**:
显式、幂等地把 Actual state 收敛到 Desired state。预检失败时零变更；意外 I/O 失败保留已完成操作与 Desired state，后续再次 reconcile。

**Bundle**:
多个 skill resources 的全局命名分组，是一次性选择器，不保存 activation。

**Tag**:
用于过滤和批量选择 resources 的全局人工标签，不做智能分类。

**Preset**:
由 `skill:`、`bundle:`、`tag:` 等动态 selectors 组成的全局持久 ON policy。Preset 可分别在 Global 或某个 Project Runtime target 上 activate。
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
从一次 inventory scan 派生的展示层翻译（如 skill × agent 矩阵行），不写磁盘、不另建真相。矩阵列是 Runtime key；所有磁盘变更走 plan/apply，不走 Projection。
_避免_: 第二个读模型、视图自带扫描
