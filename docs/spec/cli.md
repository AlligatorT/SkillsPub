# Spec: SkillsPub CLI

产品名 **SkillsPub**，npm 包与命令名为 `skillspub`。设计决策见 `docs/adr/`，术语见 `CONTEXT.md`。

## Disk and metadata

磁盘是 activation 与 relationship 的唯一真相（ADR-0001）。`~/.config/skillspub/state.json` 只保存 bundle、tag、preset、inventory/provenance 等 metadata，不保存 on/off 状态；agent registry 位于 `~/.config/skillspub/agents.conf`。

首次运行时，SkillsPub 会把旧配置目录中目标位置尚不存在的文件复制到新目录；已有 SkillsPub 文件优先，旧文件不会被删除或覆盖。

Instance-level metadata 必须以 skill instance identity 关联，不能只按 skill name 关联。Provenance 优先读取 installer lock 中可靠的 `sourceUrl`、`skillPath` 等字段；字段不足时保留 `Source unknown` 与本地 `realPath`，不联网猜测。

## Entry behavior

```text
skillspub                         # stdin/stdout 为 TTY 时打开 TUI
skillspub tui                     # 显式打开同一个 TUI
skillspub ls [--agent A] [--tag T]
skillspub on|off <skill> <agent...>
skillspub status <skill>
skillspub agents
```

裸命令只在交互式 TTY 中启动 Ink。非 TTY 环境不得尝试渲染 TUI，应输出 CLI usage。保留 `tui` 子命令，便于脚本、文档和排错时显式调用；该子命令不接受额外参数。

`ls`、`status`、`on`、`off` 不得把同名 variants 当成同一个实例，也不得静默选择第一个同名目录。名称只能在唯一解析时作为简写；有歧义时命令必须失败并清楚列出 variants，用户可改用 TUI 选择明确实例。具体的非交互 identity selector 由 naming/core ticket 定义。

## TUI scope

TUI 是 matrix-first 的单项 relationship manager，不追求完整 CLI parity。

### Tabs and projection

1. **Agent**（默认）
   - Agents
   - selected agent 已有的 skill relationships（包含 on、off、local、link、broken）
   - selected skill 的 passive summary
   - 完全 absent 的 skills 不出现在此 tab
2. **Skill**
   - 所有 skill instances/variants
   - selected skill 的 passive summary
   - Agents 与 selected skill 的 relationship/status

宽屏显示三栏。终端宽度低于一个简单 breakpoint 时只隐藏 passive summary，保留两个 actionable columns；Enter 仍可打开详情。水平焦点移动必须跳过 summary：Agent tab 为 Agents ↔ Skills，Skill tab 为 Skills ↔ Agents。

### Identity and labels

- 可解析的 skill instance 以 canonical `realPath` 为身份。
- 多个 agents 指向同一 `realPath` 时聚合为一个 instance。
- 同名但不同 `realPath` 时保留为 variants。
- 只有同名歧义时才显示来源后缀，例如 `tdd — claude`。
- Broken link 保留其 link path/target 作为异常 relationship，不得按名称并入可解析实例。

### Status

- Activation：`[ ON ]` / `[ OFF ]`
- Resource form：`local` / `link`
- Absent relationship：灰色 `missing`
- Broken symlink：明显异常的 `broken`

文字承载主要语义，颜色只做强化；不要求 Nerd Font。

### Actions and safety

- `Space`：现有 relationship 在 root ↔ `.off/` 间切换，不确认。
- `Link`：从当前明确选中的 variant 向 selected agent 创建 symlink，显示 source → target 并确认。
- `Unlink`：只移除 symlink（包括 `.off/` 下的 symlink），显示 source → target 并确认。
- Local directory 不提供 Unlink；本版本绝不删除真实 skill directory。
- Missing relationship 不能通过 ON/OFF 创建，必须使用 Link。
- 单项操作；不支持 multiselect 或 bulk mutation。
- 启动和自身 mutation 后重扫磁盘。外部变化由 `R` 显式刷新；不使用 watcher、polling 或后台进程。

### Search, sort, details

- `/` 搜索 skill name、frontmatter description 与 provenance/source；不搜索完整 SKILL.md body。
- `s` 按 Name（默认）→ Status → Source 循环排序。
- 排序或刷新后 selection 跟随 skill instance identity，不跟随旧 row index。
- Agent 顺序保持 registry order。
- Summary 显示 name、description、`sourceUrl`；无可靠来源时显示 `Source unknown` 与 `realPath`。
- Enter 打开非全屏、可滚动的完整 SKILL.md modal；Esc 返回且保留 selection。
- Keyboard-only；footer 只显示当前上下文可用动作。

## Deferred command surface

ADR-0002/0003 中的 bundle、tag、preset、scan 与 doctor 仍是独立 CLI roadmap，但不属于本次 matrix-first TUI build，也不得作为 TUI 上线依赖。Skill discovery、install、update、uninstall、真实目录删除与 recoverable trash 均不在本版本范围。

## Thin skill layer

薄 skill 通过 `skillspub` CLI 读取现场状态并执行明确的单项操作。它与 TUI 共享 programmatic core，但两个入口不要求暴露完全相同的功能。
