# Spec: SkillsPub CLI

产品名 **SkillsPub**，npm 包与命令名为 `skillspub`。设计决策见 `docs/adr/`，术语见 `CONTEXT.md`。

## State and storage

### Global

- `~/.config/skillspub/state.json`：全局 Bundle、Tag、Preset definitions，以及 Global Runtime targets 的 Base intent、Preset activations、claims 与 inventory metadata。
- `~/.config/skillspub/runtimes.json`：Agent/Shared Runtime registry。每项声明稳定 `key`、`kind`、Global discovery/parking roots 与项目内相对 `projectPath`；Shared Runtime 可声明可靠 installer `lockFile`。首次读取会把旧 `agents.conf` 保守迁移为 JSON，旧文件不删除。
- 磁盘始终是 Relationship、Activation 与 Resource form 的 Actual state；state 只保存 intent 和 metadata。

```json
{
  "version": 1,
  "runtimes": [{
    "key": "shared",
    "kind": "shared",
    "discoveryRoot": "~/.agents/skills",
    "parkingRoot": "~/.agents/.skillspub-off/skills",
    "projectPath": ".agents/skills",
    "lockFile": "~/.agents/.skill-lock.json"
  }]
}
```

首次运行时，SkillsPub 会把旧配置目录中目标位置尚不存在的文件复制到新目录；已有 SkillsPub 文件优先，旧文件不会被删除或覆盖。

### Project

Project scope 只读取用户选定的精确目录：

```text
<project>/.skillspub/state.json
<project>/.skillspub/off/<runtime-key>/<slot>
<project>/skills-lock.json
```

- TUI 的 Project scope 固定为启动 `cwd`；CLI 可显式指定目录，例如 `skillspub project /repo/a ...`。
- 只做 `realpath` 规范化，不用 Git、`package.json` 等重新定义可写项目根。
- 中央 state 不登记项目路径。项目移动时 state、OFF content 与相对 Links 一起移动。
- Project state 保存 Base intent、active Preset IDs 与每次成功 reconcile 的 `lastClaims`；Bundle、Tag、Preset definitions 仍是全局的。
- Global scope 不枚举项目。已删除 definition 的项目引用在项目下次打开时成为 Orphaned Preset Activation，冻结 `lastClaims`，由用户显式移除并 reconcile。

### Parking

Runtime registry 为每个 Global Runtime 声明 discovery root 与位于其外部的 parking root。Global Shared Runtime 固定使用 `~/.agents/.skillspub-off/skills/`。禁止使用 `skills/.off/`，避免递归扫描器继续发现其中的 `SKILL.md`。

Project Runtime 统一停放到 `<project>/.skillspub/off/<runtime-key>/`；Project Shared Runtime 的 key 为 `shared`。

Local resource 被移动到 OFF 时，所有受 SkillsPub 管理且仍为 ON 的依赖 Links 必须重定向到新位置；不复制 resource。

## Identity and resolution

- Skill resource 以可解析的 canonical `realPath` 识别。
- Catalog candidate 以 `source + skill path/name` 识别；搜索结果不得按 name 去重。
- Runtime Slot 以 `(Runtime, normalized entry name)` 识别。同一 Runtime 的一个 Slot 同时只能承载一个来源。
- 多个 Runtimes 指向同一 `realPath` 时聚合为一个 resource；同名但不同 `realPath` 时保留为 Variants。
- Broken link 保留 link path/target 作为异常 Relationship，不按名称并入可解析 resource。
- Instance metadata 不能只按 Skill name 关联。Provenance 优先使用 installer lock 的 `sourceUrl`、`skillPath` 等字段；不足时显示 `Source unknown`，不联网猜测。
- `ls`、`status`、`on`、`off` 不得静默选择第一个同名 Variant。有歧义时失败并列出明确 selectors。

## Runtime model

### Agent Runtime

专属 root 由一个 Agent 消费。它可以独立 ON/OFF。

### Shared Runtime

`~/.agents/skills` 与项目 `.agents/skills` 是第一类 Shared Runtimes：

- ON/OFF 对所有消费者同时生效。
- 不提供 Shared Skill 的 per-Agent toggle，也不接入 Agent-native disable overrides。
- Agent 视图中的 Shared 可见性只读显示来源 root。
- 同一 Agent 的 effective availability 是它消费的专属、Shared、Project、父级与 Global roots 的并集。

Project view 显示完整继承链。只有当前精确目录可写；父级和 Global Relationships 显示来源并锁定。相同名称来自多个 roots 时分别显示，不做覆盖或合并假设。

## Entry behavior

```text
skillspub                         # TTY 中打开 TUI
skillspub tui                     # 显式打开同一 TUI
skillspub scan                    # 显式扫描 Global Runtime inventory
skillspub doctor [--repair --yes] # 只读诊断；确认后执行安全修复计划
skillspub ls [--runtime R] [--tag T]
skillspub on|off <selector> <runtime...>
skillspub status <selector>
skillspub runtimes
skillspub project <path> <command...> # 包括显式 Project scan/doctor
```

裸命令只在交互式 TTY 中启动 Ink。非 TTY 环境输出 CLI usage。`tui` 不接受额外参数。

## Presets

Bundle 与 Tag 是一次性 selectors。Preset 是 persistent positive-claim policy。

```text
skillspub preset create|add|rm|ls|show ...
skillspub preset activate <name> <runtime...>
skillspub preset deactivate <name> <runtime...>
skillspub preset reconcile [<name>] [<runtime...>]
skillspub preset delete <name> [--yes]
```

- Selectors 可动态引用 `skill:<instance>`、`bundle:<name>` 与 `tag:<name>`；每次 reconcile 重新展开。
- 一个 Preset 通过多个 selectors 命中同一 Slot 时只产生一个 claim。
- Claims 只要求 ON，不表达强制 OFF。
- 人工与外部 ON/OFF 更新 Base intent。active claim 存在时 OFF intent 暂时潜伏，最后一个 claim 消失后生效。
- Activate/deactivate 先预览并立即 reconcile 一次；后续 membership 变化或外部 drift 只由显式 reconcile 修复。
- Preset-created Link 在 deactivate 后通常保留为 `link + off`；显式 Unlink 才回到 missing。
- active claim 要求 ON 时拒绝 Unlink。
- 删除当前可见的 active Preset 依次执行 `deactivate → reconcile → delete definition`。不删除 Skill files、Relationships、Tags 或 Bundles。

## Reconcile and failure behavior

- 无 watcher、daemon、polling、hook 或后台 reconcile。
- Preview/preflight 验证来源、权限、Runtime Slot、同名目标、依赖 Links 和路径冲突。任何预检失败都必须零变更。
- 意外 I/O 失败保留 Desired state 与已完成操作，不尝试脆弱 rollback；输出剩余 drift。再次 reconcile 必须幂等。
- 可在明确且无歧义时，经 preview/confirmation 为 missing Relationship 创建 symlink。
- ON/OFF、Link/Unlink 与 reconcile 后重扫磁盘；外部变化由 `R` 或显式 scan 刷新。

## Shared discovery and installation

SkillsPub 1.0 使用并测试 `skills@1.5.21`。每个 SkillsPub 发布版本升级并验证上游 CLI，不在运行时采用未经测试的动态 latest。

### Search

```text
skillspub shared find <query>
```

第一版包装 `npx skills find`：

- 接受非交互输出最多六条结果的限制。
- 解析 name、source、installs 与 skills.sh detail URL；解析失败时显示原始输出。
- 选中候选后可运行 `npx skills add <source> --list` 获取 description。
- 保留手工输入 `owner/repo@skill`、Git/GitLab/local/download URL 的入口。
- 不直接依赖未文档化的匿名 `/api/search`，也不要求 Vercel OIDC。

### Shared-only add

Global：

```text
npx --yes skills@1.5.21 add <source>
  --skill <name>
  --agent codex
  --global
  --copy
```

Project：在精确项目目录执行同一命令并去掉 `--global`。

- `--agent codex` 在 1.5.21 中已验证只写 canonical `.agents/skills`，不创建新的非 Universal Agent symlinks。
- 开头的 `npx --yes` 只允许 npx 获取固定 package；不向 `skills add` 传 `--yes`。
- SkillsPub 先做名称、来源、ON/OFF 与路径冲突预检；npx 展示 security audit 并负责最终 `Proceed` 确认。
- 既有 Agent-specific Links 不会被 add 删除，继续作为普通 Relationships 展示。

### Name and source

- skills.sh 可列出多个不同来源的同名 candidates。
- 同一 Shared Runtime 的规范化名称只有一个 Slot。SkillsPub 自己发起同名不同来源安装时必须明确 Replace，不能静默覆盖。
- Source 是当前 Slot 的可变 metadata。用户在外部手工替换后，SkillsPub 接受 lock 中的新来源并保留 Slot intent、Tags、Bundles 与 claims；不产生 persistent source warning。
- 只有 ON/OFF 同时存在、broken link、lock/file 缺失等结构异常持续告警。

### Update and remove

- Global npx lock 保持在 `~/.agents/.skill-lock.json`；Project lock 保持在 `<project>/skills-lock.json`。OFF 不删除 lock。
- 包装 add/update/remove 时只把 lock 中的 npx-managed names 传给底层；不得用 `remove --all` 删除 SkillsPub Links 或 external entries。
- Update 取得操作锁并预检，临时恢复 desired OFF 的 npx entries，运行更新，最后无论成功失败都按 Desired state 停放并验证。
- 更新期间短暂可见可接受；运行中的 Agent 在 reload/restart 后读取最终状态。

## TUI

TUI 是 matrix-first 的单项 Relationship manager，不追求完整 CLI parity。

### Tabs and projection

1. **Runtime**（默认）
   - Agent Runtimes 与 Shared Runtimes
   - selected Runtime 的 existing Relationships（on、off、local、link、broken）
   - selected resource 的 passive summary
2. **Skill**
   - 所有 resources/Variants
   - selected resource 的 passive summary
   - Runtimes 与 selected resource 的 Relationship/status

宽屏三栏；窄屏只隐藏 passive summary，保留两个 actionable columns。水平焦点跳过 summary。

### Status and actions

- Activation：`[ ON ]` / `[ OFF ]`
- Resource form：`local` / `link`
- Absent Relationship：灰色 `missing`
- Broken symlink：明显异常 `broken`
- Shared consumer：只读 `Shared via <root>`
- Inherited Project entry：只读并显示 source directory

`Space` 只切换 existing Relationship；Missing 必须通过 Link 建立。Link/Unlink 显示 source → target 并确认；Unlink 只删除 symlink。Local directory 不提供 Unlink，本版本绝不删除真实 resource。

### Search, sort, details

- `/` 搜索 name、frontmatter description 与 provenance，不搜索完整 `SKILL.md` body。
- `s` 按 Name（默认）→ Status → Source 循环排序。
- 刷新或排序后 selection 跟随 resource identity，不跟随旧 row index。
- Summary 显示 name、description、source；无可靠来源时显示 `Source unknown` 与 `realPath`。
- Enter 打开非全屏、可滚动的完整 `SKILL.md` modal；Esc 返回并保留 selection。
- Keyboard-only；footer 只显示当前上下文可用动作。

## Thin skill layer

薄 Skill 通过 `skillspub` CLI 读取现场状态并执行明确操作。它必须使用 Runtime/Shared Runtime 语言，执行前展示 Actual/Desired state，执行后复述变更与剩余 drift。它与 TUI 共享 programmatic core，但两个入口不要求完整 parity。
