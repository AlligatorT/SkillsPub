# Spec: SkillsPub CLI

产品名 **SkillsPub**，npm 包与命令名为 `skillspub`。设计决策见 `docs/adr/`，术语见 `CONTEXT.md`，Harness/Source Adapter 契约见 `docs/spec/harnesses.md`。

## State and storage

### Global

- `~/.config/skillspub/state.json`：全局 Bundle、Tag、Preset definitions，以及 Global Skill Targets 的 Base intent、Preset activations、claims 与 inventory metadata。
- `~/.config/skillspub/targets.json`：只保存内置 Target Definitions 的用户 overrides 与 Generic Targets。官方默认路径和能力留在对应 Adapter 模块。
- 磁盘始终是 Relationship、Activation 与 Resource form 的 Actual state；state 只保存 intent、claims、managed configuration ownership 和 metadata。

旧 `runtimes.json` 只读兼容到显式迁移。SkillsPub 先展示迁移计划：已知非默认路径转为 override，未知项转为 Generic Target；用户确认后原子写入并验证 `targets.json`，再把旧文件改名为带版本的 backup。scan、ls 和打开 TUI 不触发迁移。

首次运行时，SkillsPub 会把旧配置目录中目标位置尚不存在的文件复制到新目录；已有 SkillsPub 文件优先，旧文件不会被删除或覆盖。

### Project

Project scope 只读取用户选定的精确目录：

```text
<project>/.skillspub/state.json
<project>/.skillspub/off/<target-key>/<slot>
<project>/skills-lock.json
```

- TUI 的 Project scope 固定为启动 `cwd`；CLI 可显式指定目录，例如 `skillspub project /repo/a ...`。
- 只做 `realpath` 规范化，不用 Git、`package.json` 等重新定义可写项目根。
- 中央 state 不登记项目路径。项目移动时 state、OFF content 与相对 Links 一起移动。
- Project state 保存 Base intent、active Preset IDs 与每次成功 reconcile 的 `lastClaims`；Bundle、Tag、Preset definitions 仍是全局的。
- Global scope 不枚举项目。已删除 definition 的项目引用在项目下次打开时成为 Orphaned Preset Activation，冻结 `lastClaims`，由用户显式移除并 reconcile。

### Parking

每个 Target Definition 声明 discovery root 与 discovery root 外部的 parking root。Global Shared Target 使用 `~/.agents/.skillspub-off/skills/`。禁止使用 `skills/.off/`，避免递归扫描器继续发现其中的 `SKILL.md`。

Project Skill Targets 统一停放到 `<project>/.skillspub/off/<target-key>/`。Local resource 被移动到 OFF 时，所有受 SkillsPub 管理且仍为 ON 的依赖 Links 必须重定向到新位置；不复制 resource。Mirror OFF 时移入该 Target parking area，再次 ON 前校验 source 并按计划同步。

## Identity and resolution

- Skill resource 以可解析的 canonical `realPath` 识别。
- Catalog candidate 以 `source + skill path/name` 识别；搜索结果不得按 name 去重。
- Target Slot 以 `(Skill Target, normalized entry name)` 识别。同一 Target 的一个 Slot 同时只能承载一个来源。
- Skill Target ID 采用 definition key 加 scope，例如 `pi:global` 或 `pi:project:<canonical-path>`。
- 多个 Links 指向同一 `realPath` 时聚合为一个 resource；同名但不同 `realPath` 时保留为 Variants。Mirror 通过受管 source identity 归入原始 resource，不作为 Variant。
- Broken link 保留 link path/target 作为异常 Relationship，不按名称并入可解析 resource。
- Instance metadata 不能只按 Skill name 关联。Provenance 优先使用 installer lock 的 `sourceUrl`、`skillPath` 等字段；不足时显示 `Source unknown`，不联网猜测。
- `ls`、`status`、`on`、`off` 不得静默选择第一个同名 Variant。有歧义时失败并列出明确 selectors。

## Skill Target model

Target Definition 是 Harness 或公共标准的路径/能力规则；结合 home、project、profile 和 scope 后才得到具体 Skill Target。Relationship 始终面向 Skill Target，而不是 Harness。

`~/.agents/skills` 与项目 `.agents/skills` 是 Shared Skill Targets：

- Shared Target 在矩阵中只显示一次，ON/OFF 对该 Target 的全部消费者生效。
- Harness Adapter 报告 `not-consumed`、`required`、`enabled`、`excluded` 或 `unknown`，但不复制 Shared 开关。
- Harness 最终可见性是它实际消费且未排除的 Global、Project、父级与 Shared Targets 的并集。
- `unknown` 不作最终可见性承诺。

Harness-specific Targets 由对应 Adapter 定义。Generic Target 可由用户指定路径，SkillsPub 只承诺目录管理。当前不建立 Consumer/Profile 类型，但 Target 结构不得假设一个 Harness 永远只有一个身份或 Target。

Project view 把 project、parent 与 Global 继承收敛成每个 Skill × Target 一个有效条目，并显示获胜来源目录。只有当前精确目录可写。交互见下方 TUI「Status and actions」。

## Entry behavior

```text
skillspub                              # TTY 中打开 TUI
skillspub tui                          # 显式打开同一 TUI
skillspub scan                         # 只读扫描 Global Target inventory
skillspub doctor [--repair --yes]      # 只读诊断；确认后执行安全修复计划
skillspub ls [--target T] [--tag T]
skillspub on|off <selector> <target...>
skillspub status <selector>
skillspub targets
skillspub harnesses [<name> inspect|setup|reconcile [--yes]]
skillspub migrate targets
skillspub project <path> <command...>  # 包括显式 Project scan/doctor
```

裸命令只在交互式 TTY 中启动 Ink。非 TTY 环境输出 CLI usage。`tui` 不接受额外参数。

`--target` 是当前术语；现有 `--agent` 暂作兼容别名并输出弃用提示。只读命令和打开 TUI 严格不创建目录、不迁移文件、不修改 Harness 配置。

## Presets

Bundle 与 Tag 是一次性 selectors。Preset 是 persistent positive-claim policy。

```text
skillspub preset create|add|rm|ls|show ...
skillspub preset activate <name> <target...>
skillspub preset deactivate <name> <target...>
skillspub preset reconcile [<name>] [<target...>]
skillspub preset delete <name> [--yes]
```

- Selectors 可动态引用 `skill:<instance>`、`bundle:<name>` 与 `tag:<name>`；每次 reconcile 重新展开。
- 一个 Preset 通过多个 selectors 命中同一 Target Slot 时只产生一个 claim。
- Claims 只要求 ON，不表达强制 OFF。
- 人工与外部 ON/OFF 更新 Base intent。active claim 存在时 OFF intent 暂时潜伏，最后一个 claim 消失后生效。
- Activate/deactivate 先预览并立即 reconcile 一次；后续 membership 变化或外部 drift 只由显式 reconcile 修复。
- Preset-created Link/Mirror 在 deactivate 后通常保留为 OFF；显式 Unlink 或删除 Mirror 才回到 missing。
- active claim 要求 ON 时拒绝移除 Relationship。
- 删除当前可见的 active Preset 依次执行 `deactivate → reconcile → delete definition`。不删除 Skill files、Relationships、Tags 或 Bundles。

## Reconcile and failure behavior

- 无 watcher、daemon、polling、hook 或后台 reconcile。
- Preview/preflight 验证来源、权限、Target Slot、同名目标、依赖 Links/Mirrors、Harness 配置 hash 和路径冲突。任何预检失败都必须零变更。
- Harness 配置修改采用 `inspect → plan → recheck → atomic apply → verify`；无法识别的 schema 或并发变化拒绝写入。
- 意外 I/O 失败保留 Desired state 与已完成操作，不尝试脆弱 rollback；输出剩余 drift。再次 reconcile 必须幂等。
- 可在明确且无歧义时，经 preview/confirmation 为 missing Relationship 创建 Link。Harness 不支持 symlink 时，由 Managed Adapter 明确规划 Mirror。
- Mirror source 更新时 scan 只报告 Drift；显式 reconcile 才同步。人工修改的 Mirror 标记 diverged，拒绝静默覆盖。
- ON/OFF、Link/Unlink、Mirror 和 reconcile 后重扫磁盘；外部变化由 `R` 或显式 scan 刷新。

## Shared discovery and installation

`npx skills` 是 Source Adapter，不是 Harness Adapter。SkillsPub 1.0 的已验证基线是 `skills@1.5.21`；每个发布版本绑定并测试一个明确版本，不在运行时采用未经验证的动态 latest。

### Search

```text
skillspub shared find <query>
```

第一版包装 `npx skills find`：

- 接受非交互输出最多六条结果的限制。
- 解析 name、source、installs 与 skills.sh detail URL；解析失败时显示原始输出。
- 选中候选后可运行 `npx skills add <source> --list` 获取 description。
- 保留手工输入 `owner/repo@skill`、Git/GitLab/local/download URL 的入口。
- 不直接依赖未文档化的匿名 API，也不要求 Vercel OIDC。

### Shared-only add

Source Adapter 只安装到用户选定的 Global 或 Project Shared Target，不创建任何 Harness-specific Link/Mirror。当前固定上游命令中的 `--agent codex` 只是已验证的 Shared-only transport，必须封装在 Adapter 内部，不进入 Inventory、领域模型或 TUI。

```text
npx --yes skills@1.5.21 add <source>
  --skill <name>
  --agent codex
  [--global]
  --copy
```

- 开头的 `npx --yes` 只允许 npx 获取固定 package；不向 `skills add` 传 `--yes`。
- SkillsPub 先做名称、来源、ON/OFF 和路径冲突预检；npx 展示 security audit 并负责最终 `Proceed` 确认。
- 安装后，用户通过 SkillsPub 明确为 Pi、Claude Code 等其他 Targets 建立 Relationships。
- 既有 Harness-specific Relationships 不会被 add 删除。

### Name and source

- skills.sh 可列出多个不同来源的同名 candidates。
- 同一 Shared Target 的规范化名称只有一个 Slot。SkillsPub 自己发起同名不同来源安装时必须明确 Replace，不能静默覆盖。
- Source 是当前 Slot 的可变 metadata。用户在外部手工替换后，SkillsPub 接受 lock 中的新来源并保留 Slot intent、Tags、Bundles 与 claims；不产生 persistent source warning。
- 只有 ON/OFF 同时存在、broken link、lock/file 缺失等结构异常持续告警。

### Update and remove

- Global npx lock 保持在 `~/.agents/.skill-lock.json`；Project lock 保持在 `<project>/skills-lock.json`。OFF 不删除 lock。
- 包装 add/update/remove 时只把 lock 中的 npx-managed names 传给底层；不得用 `remove --all` 删除 SkillsPub Relationships 或 external entries。
- Update 取得操作锁并预检，临时恢复 desired OFF 的 npx entries，运行更新，最后无论成功失败都按 Desired state 停放并验证。
- Shared source 更新后，依赖 Links 自动读取新内容；Mirrors 形成 Drift，等待显式 reconcile。
- Remove 前枚举本次扫描可见的依赖 Links/Mirrors，明确列出 Harness Target 和路径。用户再次确认后级联删除已知 Relationships/Mirrors，再删除 source；同时警告未打开项目可能遗留 broken links。
- 更新期间短暂可见可接受；运行中的 Harness 按其官方 reload/restart 规则读取最终状态。

## TUI

TUI 是 matrix-first 的单项 Relationship manager，不追求完整 CLI parity。

### Tabs and projection

1. **Target**（默认）
   - Shared Target 只显示一次；检测到的 Harness Targets 按 Harness 分组
   - selected Target 的 existing Relationships（on、off、local、link、mirror、broken）
   - selected resource 的 passive summary
2. **Skill**
   - 所有 resources/Variants
   - selected resource 的 passive summary
   - Skill Targets 与 selected resource 的 Relationship/status

主界面只显示已安装、已有配置或已有 Target 的 Harness；未检测到的内置支持项在单独的可添加列表。宽屏三栏；窄屏只隐藏 passive summary，保留两个 actionable columns。水平焦点跳过 summary。

### Status and actions

- Activation：`[ ON ]` / `[ OFF ]`
- Resource form：`local` / `link` / `mirror`
- Absent Relationship：灰色 `missing`
- Broken symlink：明显异常 `broken`
- Shared consumption：Harness 详情显示 `required` / `enabled` / `excluded` 等状态
- Inherited Project entry：只读并显示 source directory

Global view 中 `Space` 只切换 existing Relationship；Missing 通过 Link/Mirror plan 建立。Project view 每个 Skill × Target 只投影一个有效条目：inherited ON 只读；inherited OFF 或 missing 可用普通 `Space` 创建 Project Relationship；Project ON/OFF 始终停留在同一条目。

Link/Unlink 和 Mirror create/remove 显示 source → target 并确认。Unlink 只删除 symlink。删除 source local resource 走 Shared remove 的依赖枚举和二次确认，不作为普通 Space 行为。

### Search, sort, details

- `/` 搜索 name、frontmatter description 与 provenance，不搜索完整 `SKILL.md` body。
- `s` 按 Name（默认）→ Status → Source 循环排序。
- 刷新或排序后 selection 跟随 resource identity，不跟随旧 row index。
- Summary 显示 name、description、source；无可靠来源时显示 `Source unknown` 与 `realPath`。
- Enter 打开非全屏、可滚动的完整 `SKILL.md` modal；Esc 返回并保留 selection。
- Keyboard-only；footer 只显示当前上下文可用动作。

## Thin skill layer

薄 Skill 通过 `skillspub` CLI 读取现场状态并执行明确操作。它必须使用 Harness、Skill Target 与 Shared Target 语言，执行前展示 Actual/Desired state，执行后复述变更与剩余 Drift。它与 TUI 共享 programmatic core，但两个入口不要求完整 parity。
