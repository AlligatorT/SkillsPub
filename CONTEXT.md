# SkillsPub

SkillsPub 管理多个 agent runtime 与本地 skill resources 之间的关系，并以磁盘现场状态为准。

## Language

**Skill instance**:
一个含 `SKILL.md` 的自包含真实目录。可解析时，它的身份是 canonical `realPath`，不是目录名。
_避免_: 用 skill name 充当实例身份

**Skill name**:
Skill instance 面向人的名称。名称用于分组和展示，不保证唯一。
_避免_: Skill ID

**Variant**:
与另一个 skill instance 同名、但 `realPath` 不同的实例。只有同名歧义时，界面才添加来源后缀。
_避免_: Duplicate、copy

**Agent**:
消费 skills 的 runtime，例如 Claude、Codex 或 Pi。Agent 顺序由注册表决定。
_避免_: Client、provider

**Relationship**:
一个 skill instance 与一个 agent 之间已经存在的关联，由 agent skill root 或其 `.off/` 下的目录 entry 表示。
_避免_: Installation

**Activation**:
Relationship 的可见性维度：`on` 表示 entry 在 agent skill root，`off` 表示 entry 在该 root 的 `.off/`。`off` 可恢复且不等于删除。
_避免_: 用 `link` 或 `missing` 表示 activation

**Resource form**:
Relationship 的资源形态：`local` 是真实目录，`link` 是 symlink。Resource form 与 activation 相互独立。
_避免_: 把 `link` 当作第三种 activation

**Missing relationship**:
选定的 skill instance 与 agent 之间没有目录 entry。界面可显示 `missing`，但它不是 `off`，需要 Link 才能建立 relationship。
_避免_: Disabled、stale reference

**Broken link**:
目标无法解析的 symlink relationship。它是需要明显标出的异常状态，不得与同名 skill instance 静默合并。
_避免_: Missing relationship

**Provenance**:
将 skill instance 追溯到来源的可靠本地 metadata，优先采用 installer lock 中的 `sourceUrl`、`skillPath` 等字段。无法确认时为 `Source unknown`，不得通过名称猜测或联网补全。
_避免_: Source guess

**Bundle**:
多个 skills 的命名分组；可以来自共同 provenance，也可以手动维护。
_避免_: Activation group

**Tag**:
用于过滤和批量选择 skills 的人工标签。
_避免_: 自动分类

**Preset**:
Bundles、skills 与目标 agents 的命名组合；apply 表示幂等收敛。
_避免_: 一次性拷贝

**Stale reference**:
Bundle、tag 或 preset 仍引用已不存在的 skill 时保留的成员关系，供重装后恢复。
_避免_: Missing relationship

**CLI-coupled skill**:
依赖配套 CLI 才能执行能力的 skill。SkillsPub 只管理其 skill instance，不管理配套 CLI。
