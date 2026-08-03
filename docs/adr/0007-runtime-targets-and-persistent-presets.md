# ADR-0007: Relationship 面向 Runtime，Preset 是持久 ON policy

状态: accepted (2026-08-01)

## 背景

一个 Agent 可能同时扫描专属目录、`~/.agents/skills`、项目目录和父目录。反过来，一个 Shared root 也可能被多个 Agents 消费。因此“一个目录属于一个 Agent”和“删除某个 Agent 专属 symlink 就等于该 Agent OFF”都不成立。

Preset 也不能继续作为一次性批量命令：用户需要保留长期 intent，同时允许外部工具直接改变磁盘，并且明确不要 watcher、daemon、polling 或后台强制修复。

## 决策

### Runtime 是 Relationship 的目标

- **Agent Runtime** 是只有一个 Agent 消费的专属 discovery root。
- **Shared Runtime** 是多个 Agents 消费的 discovery root，例如 `~/.agents/skills`。
- Relationship 连接 skill resource 与 Runtime Slot，不再固定建模为 skill × Agent。
- Shared Runtime 只有整体 ON/OFF。消费者 Agent 只读显示 `Shared` 状态；SkillsPub 不实现 Agent-native override，也不承诺 Shared Skill 的 per-Agent OFF。
- 同一 Agent 的有效可见性是它消费的所有 Runtime roots 的并集。项目或专属 Runtime 的 OFF 不能遮蔽其他 root 中仍为 ON 的实例。

### Actual state 与 Desired state 分离

- 磁盘仍是 Relationship、Activation 与 Resource form 的 **Actual state** 真相。
- State 保存人工 **Base intent**、active Presets 与 positive **Preset claims**。它不伪造磁盘已经发生的变化。
- 人工 ON/OFF 和外部 ON/OFF 都更新 Base intent。若 active Preset 仍要求 ON，OFF intent 暂时潜伏，最后一个 claim 消失后才生效。
- Preset 只产生 ON claims，不表达强制 OFF。一个 Preset 通过多个 selector 命中同一 Slot 时只产生一个 claim。
- Preset selectors 在 reconcile 时动态展开；Bundle 与 Tag 本身仍是一次性选择器。
- Preset activation 按 `(Preset, Runtime target)` 独立记录。

### Reconcile 必须显式

- Activate/deactivate 先展示计划，再立即执行一次 reconcile；之后的 selector membership 变化或外部 drift 只在显式 `preset reconcile` 时修复。
- 不增加 watcher、daemon、polling、filesystem hook 或后台自动 reconcile。
- 预检失败时零变更。预检包括来源存在、目标唯一、同名 Slot、路径冲突、依赖 Links 与权限。
- 意外 I/O 失败不做脆弱 rollback：保留 Desired state 与已完成操作，报告 drift，再次 reconcile 必须幂等补完。
- Preset 创建的 Links 是 sticky Relationships。Deactivate 后通常保留为 `link + off`；只有显式 Unlink 才回到 missing。
- active claim 仍要求 ON 时拒绝 Unlink。

### OFF 必须离开 discovery root

- 不再使用 `skills/.off/`；递归扫描器可能继续发现其中的 `SKILL.md`。
- Global Runtime 使用该 Runtime root 外部的 SkillsPub parking area。
- Project Runtime 使用 `<project>/.skillspub/off/<runtime>/...`，与项目一起移动。
- Local resource 在 Agent Runtime ON/OFF 移动时，SkillsPub 同步重定向所有受管理的依赖 Links；`local + off` 仍可作为另一个 Runtime 的来源。

### Project state 跟随项目

- Project scope 绑定 TUI 启动目录或 CLI 显式目录，只做 `realpath` 规范化，不把 Git、`package.json` 等推断结果当成可写项目根。
- Project state 位于 `<project>/.skillspub/state.json`；中央状态不登记项目路径或维护项目索引。
- Project TUI 显示 Agent 实际可见的当前、父级与全局 roots。只有当前精确目录可写；继承项显示来源并只读。
- 项目移动时 state、parking content 与相对 Links 一起移动。
- 全局 Preset definition 被删除时，不扫描未知项目。项目下次打开后将该引用显示为 Orphaned Preset Activation，冻结 `lastClaims`，由用户明确移除并 reconcile。

### 删除 Preset definition

- 对当前可见 target，删除流程是 `deactivate → reconcile → delete definition`，并展示影响。
- CLI 需要确认或显式 `--yes`。
- 不删除 Skill files、Relationships、Tags 或 Bundles。
- 未打开项目按上述 orphaned activation 规则延迟清理。

## 后果

- UI 不再用不可兑现的 per-Agent 开关描述 Shared roots。
- State 文件可以保存 intent，但不能替代现场扫描；ADR-0001 中“state 永不保存 ON/OFF”被收窄为“Actual state 只来自磁盘”。
- Project state 可随目录移动，代价是 Global scope 无法枚举所有项目。
- Reconcile 的失败模型简单、可恢复，不需要事务 rollback 或后台服务。
- ADR-0001、0002、0003、0004 与本 ADR 冲突的部分由本 ADR 取代。
