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
- Effective visibility 由它实际消费且未排除的 Global、Project、父级与 Shared Targets 共同决定。
- 只有本地证据完整且不存在未解析的同名 Variant 时才返回 `visible` 或 `not-visible`；其余情况返回 `unknown` 或 `conflicted`。

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
skillspub explain <selector> [--harness H] [--want visible|hidden]
skillspub targets
skillspub shared refresh
skillspub shared outdated
skillspub shared add <source> --skill <name> [--replace] [--yes]
skillspub shared update [<managed-name>...] [--yes]
skillspub shared remove <managed-name> [--cascade|--yes]
skillspub harnesses [<name> inspect|setup|reconcile [--yes]]
skillspub migrate targets
skillspub project <path> <command...>  # 包括 scan/doctor/explain/shared/preset/mirror/harnesses
skillspub project <path> explain <selector> [--harness H] [--want visible|hidden]
skillspub project <path> harnesses grok setup|reconcile [--yes]
skillspub project <path> harnesses pi setup|reconcile|migrate [--yes]
```

裸命令只在交互式 TTY 中启动 Ink。非 TTY 环境输出 CLI usage。`tui` 不接受额外参数。

`--target` 是当前术语；现有 `--agent` 暂作兼容别名并输出弃用提示。只读命令和打开 TUI 严格不创建目录、不迁移文件、不修改 Harness 配置。

Pi `migrate` 仅可用于显式 `project <path>` 边界，并与 Project `setup`/`reconcile` 分开预览、确认和应用。它把旧 Target override 的 `.pi/agent/skills` 迁移到 canonical `.pi/skills`，拒绝 Global 调用、目标冲突或 preview 后的并发变化。未带 `--yes` 时 text 只打印 immutable preview，`--json` 返回 `applied: false` 且 `plan.operation` 为 `harness.migrate`；带 `--yes` 才执行迁移与 hash-checked recovery evidence 写入。普通 `inspect`、scan、ls 与 TUI 打开均不触发迁移。

## Effective Visibility Explain

`explain` 只接受当前 Inventory 中可明确解析的已安装 Skill resource；同名 Variants 有歧义时失败并列出 selectors。Catalog candidate 必须先通过 Shared add 安装，不在 Explain 中生成下载计划。

- Global 命令只扫描 Global scope；Project 命令只读取用户给出的 canonical 项目、其适用 ancestor roots 与 Global 继承，不推断 cwd、不维护中央 Project registry。
- 默认解释全部内置 Harness；`--harness` 只缩小输出。未检测到的内置 Harness 仍返回 `detected: false`、support/evidence 和 `unknown`，不按默认目录猜测。
- 每次调用都重新扫描本地 Relationships、配置和 Harness inspection；不联网、不新增 cache，也不读取 Update availability 推断可见性。
- 每个 Harness 聚合为 `visible`、`not-visible`、`unknown` 或 `conflicted`。结果列出 detection、support、Adapter evidence/verified version、所有 consumed roots、贡献的 Relationships/Resource forms、Shared consumption、绕过原因与同名 Variants。
- `visible` 表示选定 resource 在至少一个已验证 consumed root 中有 ON Relationship 且没有未解析冲突；`not-visible` 表示完整证据证明所有 consumed roots 都不提供该 resource；配置/consumption/支持证据不足时为 `unknown`；不同来源的同名 Variant 可能竞争且 Adapter 没有已验证 precedence 时为 `conflicted`。
- Effective visibility 描述 Harness **下次加载**时应发现什么，不启动 Harness、不检查运行中进程的内存。Adapter 展示其固定证据版本；本机版本未知或不匹配时给 warning，不能确认 schema/语义时降为 `unknown`。
- 不带 `--want` 时只解释。`--want visible|hidden` 返回只读 plan；Explain 永不 apply，也不进入 confirmation。计划只组合现有安全 operations，并带重新检查所需的 preconditions。
- `visible` 计划优先建立或激活 Harness-specific Target Relationship，由 Managed Adapter 决定 Link/Mirror；不会为了减少步骤主动扩大 Shared consumption。
- `hidden` 计划必须覆盖该 Harness 的全部 contributing roots。active Preset claim、未知 ownership、同名冲突、未知配置或会影响其他 Skills 且尚未获明确决策的隔离变更成为 blockers；Explain 不停用 Preset、不制造 Drift、不返回 best-effort executable plan。
- `managed` 且证据完整的 Harness 才能给出确定结果；`discoverable`、`unsupported` 或 inspection 不完整时保守返回 `unknown`。

JSON `data` 至少包含选定 resource identity、scope、逐 Harness detection/support/evidence、`effectiveVisibility`、roots、reasons、conflicts、warnings，以及可选的 `wanted` 和 `{ executable, steps, blockers }` plan。Text 与 TUI 只投影同一 resolver 结果，不另建状态。

## Non-interactive JSON contract

所有非 TUI 命令接受 `--json`，并只向 stdout 写一个无 ANSI 的 versioned envelope：

```json
{"schemaVersion":1,"ok":true,"data":{}}
{"schemaVersion":1,"ok":false,"error":{"code":"stable_code","message":"human-readable","details":{}}}
```

- `schemaVersion` 从 `1` 开始；命令专属结构只放在 `data` 或 `error.details` 中。
- JSON 模式永不进入交互 prompt。会修改磁盘的命令没有 `--yes` 时返回完整 plan 与 `applied: false`，退出 0；带 `--yes` 才 apply，并返回 `applied: true` 与结果。
- 退出码固定为：0 表示命令完成；1 表示领域、预检或运行失败；2 表示参数或 usage 错误。
- Drift、update available、warnings 等有效发现属于成功 `data`，不改变退出码。未来若需要 CI gate，另行增加显式检查模式，不复用普通查询的退出码。
- 裸命令加 `--json` 不启动 TUI，而是返回 usage error。`tui` 本身不支持 JSON。

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
- Grok Global/Project setup 预览 Shared/vendor isolation、受影响 Links、backup 与 verification。`--yes` 后只 Unlink manifest 中的 Grok Links，保留 source，写入后打印原 TOML/哈希与 manifest 的手工恢复路径。
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
- SkillsPub 先做名称、来源、ON/OFF 和路径冲突预检；text 与 JSON 在没有 `--yes` 时只返回 immutable plan，确认后以同一命令加 `--yes` 执行。SkillsPub 消费该参数，不向 `skills add` 传递。Text 保留 npx 的 security audit 与最终 `Proceed`；JSON 以关闭的 stdin 和捕获的输出运行，永不 prompt 或把 ANSI/upstream output 混入 envelope，upstream 若要求交互则返回结构化失败。
- 安装后，用户通过 SkillsPub 明确为 Pi、Claude Code 等其他 Targets 建立 Relationships。
- 既有 Harness-specific Relationships 不会被 add 删除。

### Name and source

- skills.sh 可列出多个不同来源的同名 candidates。
- 同一 Shared Target 的规范化名称只有一个 Slot。SkillsPub 自己发起同名不同来源安装时必须明确 Replace，不能静默覆盖。
- Source 是当前 Slot 的可变 metadata。用户在外部手工替换后，SkillsPub 接受 lock 中的新来源并保留 Slot intent、Tags、Bundles 与 claims；不产生 persistent source warning。
- 只有 ON/OFF 同时存在、broken link、lock/file 缺失等结构异常持续告警。

### Update availability

Update availability 是 Source Adapter 的缓存观察，不是 Actual state、Desired state 或 Drift。TUI 启动、scan 和普通只读查询不联网；用户显式刷新：

```text
skillspub shared refresh
skillspub shared outdated
```

- `shared refresh` 按 source 批量检查当前 scope 的全部 npx-managed Skills，以固定 `skills@1.5.21` lock 中的 source、skill path 与 folder hash 对比远端内容。该检查在 Source Adapter 内实现，不调用可能修改磁盘的上游 `skills update`。
- 缓存跟随对应 Global 或精确 Project scope，不建立中央 Project registry。每项保存 `current`、`available`、`upstream-missing` 或 `check-failed` 以及 `checkedAt`；provenance、skill path 或本地内容身份变化后，旧结果不再代表当前 Skill。
- `shared outdated` 只读缓存；没有缓存时显示 unknown，不隐式联网。检查失败不得把旧结果伪装成 current/available。
- `upstream-missing` 只报告上游事实，保留本地 Skill、Relationships 与 provenance；update 拒绝该项，删除仍走显式 remove。

### Update and remove

- Global npx lock 保持在 `~/.agents/.skill-lock.json`；Project lock 保持在 `<project>/skills-lock.json`。OFF 不删除 lock。
- 包装 add/update/remove 时只把 lock 中的 npx-managed names 传给底层；不得用 `remove --all` 删除 SkillsPub Relationships 或 external entries。
- Update 取得操作锁并预检，临时恢复 desired OFF 的 npx entries，运行更新，最后无论成功失败都按 Desired state 停放并验证。
- Shared source 更新后，依赖 Links 自动读取新内容；Mirrors 形成 Drift，等待显式 reconcile。
- Remove 前枚举本次扫描可见的依赖 Links/Mirrors，明确列出 Harness Target 和路径。用户再次确认后级联删除已知 Relationships/Mirrors，再删除 source；同时警告未打开项目可能遗留 broken links。
- 更新期间短暂可见可接受；运行中的 Harness 按其官方 reload/restart 规则读取最终状态。

## TUI

TUI 把已安装资源的 Relationship 管理与远程 Source lifecycle 分开：Target/Skill matrix 仍只管理 Relationships；独立 Source workspace 负责 Global 与 exact Project 的 Catalog/Inventory lifecycle。两者共享同一 Inventory、Desired state、Drift、Effective Visibility 和 plan/apply 核心，不各建真相。

### Source workspace: approved A + C contract

Source workspace 采用 #111 批准的 A+C 组合。Variant A 是持久结构：始终显示 `Global` 或 `exact Project` 及 resolved path、`Discover → Inspect & plan → Confirm ownership → Run & maintain → Verify truth` rail、Catalog/Inventory、一个 selected candidate/resource detail 和 scope truth。只有 operation 执行、失败、retry、log/evidence 与最终验证时，active detail area 临时替换为 Variant C；scope、selection、rail 和 truth 始终保留。prototype code 只作证据，不合并。

状态机固定为 `browse → preview → confirm → run → verify`，以及 `run → failed → retry/re-preview`、`preview → cancelled → browse`：

- search 与 refresh 是 explicit read-only network operations，不要求 mutation confirmation；
- add、explicit replace、single update、marked batch update 与 dependency-aware remove 都先生成 immutable scrollable preview，再确认；
- confirm 或 run 期间不能切 scope，也不能执行无关 mutation；
- apply 前按 preview 的 hashes、lock/provenance、permissions、Slot、policy/config 与 dependencies 重检；任一 precondition 改变就废弃旧 plan，回到 preview；
- success 停在 Verify truth，直到用户 acknowledge；failure 保持 C state，直到 retry、fresh preview，或 acknowledge remaining Drift 后离开；
- 每个 success、failure、partial result 都必须重新扫描 filesystem，再显示 final truth。

Global 只操作 Global Shared Target、Global Vercel lock 和 scope-local update cache。exact Project 是 TUI startup `cwd` 的 canonical `realpath`，只操作该目录的 Project Shared Target、`<project>/skills-lock.json`、Project state 与 Project update cache；不用 Git 或 `package.json` 改写 root，也不建立中央 Project registry。Project Inventory 可显示 Global/ancestor inheritance 解释 effective state，但 inherited entries read-only，必须标明 source directory。selection、batch marks、plan 与 cache 按 candidate/resource identity 和 scope 隔离；sort/refresh 只在 identity 仍有效时保留，scope change 全部清除。

Catalog candidate 以 `source + skill path/name` 识别，不按 name 去重。detail 显示 exact source、skill path/name、description、可用的 installs/detail URL 与 normalized destination Slot。installed resource 以 canonical `realPath` 识别，可靠 provenance 只来自当前 scope 的 Vercel `skills` lock；无法证明时显示 `Source unknown` 与 `realPath`，不得提供伪装成 Vercel-owned 的 update/remove。

若 normalized Shared Slot 已被不同 source 占用，add 变成 explicit Replace。preview 列出 old/new provenance，以及继续指向该 Slot、因此会消费新内容的所有已知 Relationships；Slot intent、Tags、Bundles 与有效 Preset claims 保留，不静默覆盖。

每个 mutation preview 至少包含：

- exact scope/path、candidate/resource identity、provenance、destination Slot、固定 Source Adapter version；
- permissions、lock ownership、path/name conflicts、current hashes、Actual/Desired state、Preset claims 与 concurrent-change checks；
- included/excluded items 及原因；
- 按 scope/Target 分组的完整 Relationship effects：form、Activation、source path、target path 与 planned action；
- update 临时可见性、Mirror Drift/reconcile、next-load Effective Visibility、unopened-Project risk 与 recovery artifacts；
- expected final Actual、Desired、Drift、Source 与 Relationship counts。

大集合可以先 summary，但必须可展开完整 list，不能只显示 count。同一 Relationship-impact projection 供 Source replace/remove 与 Harness setup/reconcile 使用。Grok 已验收操作的 preview 必须明确显示：90 个 Shared-backed Grok Link Relationships 将被 unlink、90 个 source resources 不删除、一个 non-Shared `ego-browser` Relationship 保留，并在确认前显示 config backup、affected-Link manifest 与 recovery path。

confirmation ownership 固定为：

- add/replace 先确认 SkillsPub scope/identity/Slot/Relationship plan，再保留 Vercel `skills` 自己的 security audit 与最终 `Proceed`；
- single/batch update 确认 exact named set 及 Desired/Relationship/Mirror effects；任何 upstream prompt 仍由 Vercel `skills` 拥有；
- remove 先确认完整 known Relationship cascade；cascade 成功后再独立确认通过 Vercel `skills` 删除一个 named Shared source。cascade 不完整则 source 不删除，禁止 `remove --all`。

operation semantics：

- Refresh 只在 explicit `r` 对当前 scope 的全部 proven Vercel-managed resources 运行，返回 `current`、`available`、`upstream-missing` 或 `check-failed` 与 `checkedAt`；无 cache 为 unknown，且 update availability 始终与 Actual、Desired、Drift、Effective Visibility 分开。
- Add/replace 只写 selected Shared Target，不创建 Harness Relationships；完成后验证 resource、lock provenance、Slot 与现有 Relationships。
- Single/batch update 只接受 identity-matching `available` resources。batch 只复用 marked set，v0.1 不做 batch add/remove；一个 confirmed set 在一个 scope operation lock 下执行，逐项报告 `updated`/`skipped`/`failed`，不承诺 all-or-nothing。
- update 可临时暴露 Desired-OFF entry，但 success/failure 后都恢复并验证 Desired Activation。Links 立即消费新 source；Mirrors 形成 `mirror-sync` Drift，diverged Mirrors 不静默覆盖。
- remove 只用于当前 scope 中 proven Vercel-managed local Shared source。它列出所有 known Link/Mirror dependencies；active Preset claims、unknown ownership、same-name conflicts 或 unsafe/read-only dependency 都阻塞。Global remove 同时警告 unopened Projects 可能遗留 broken Links，但不能省略当前 scan 可见的依赖。

Variant C 把 approved plan 投影为 `queued`、`running`、`succeeded`、`failed`、`skipped` timeline，包括 Vercel ownership handoff、local orchestration、verification evidence 以及 lock/backup/manifest/recovery paths。unexpected I/O failure 保留 Desired state 与已完成 work，不尝试 fragile rollback；C 显示 error、partial effects、remaining work/Drift、raw log 与 recovery evidence。`t` 先 fresh rescan/recheck；原 intent 仍有效时 idempotent retry，只重做 remaining work，否则拒绝并要求新 preview。最近一次 transcript 只在当前 TUI session 可见；durable evidence 继续使用 upstream lock、backup 与 manifest，不新增 lifecycle DB 或 background history service。

Verify truth 分栏显示 filesystem Actual Relationships/Activation/forms、preserved Desired、remaining Drift、per-item Source outcome/provenance、Mirrors、broken/unknown dependencies、Relationship effects、recovery paths、update availability 与证据支持的 next-load Effective Visibility；不得声称 running Harness 已 reload。

Source workspace keyboard contract：

- `g` / `p`：idle 时选择 Global / exact Project；`Tab`：Catalog / Inventory；
- `/`：按 name、description、provenance 搜索，并保留 manual source input；`j` / `k`：移动 selection；
- `Enter`：browse 时打开 detail、preview 时推进 displayed confirmation、success 后 acknowledge final truth；
- `a`：preview add/replace；`r`：refresh；`u`：preview selected update；
- `Space`：mark/unmark Inventory resource；`b`：preview marked batch update；`d`：preview dependency-aware remove；
- `t`：只在 failed C state retry；`l`：operation active 时打开 full log/evidence，acknowledge 后重新打开本 TUI session 的 latest transcript；
- `Esc`：关闭 search/detail/log、取消未 apply preview，或在 acknowledge 后离开 result 并保留 underlying selection。

footer 只显示 context-valid actions。search/detail/log modal 必须 trap focus；passive summary 不是 focus stop。confirmation/execution 期间禁用的 action 要解释原因。narrow layout 只减少 passive presentation，不能移除 actionable workflow、impact review 或 final truth；wide layout 不能让长 status/identity 产生歧义。prototype-only fail-next 控件不进入 production。

### Relationship tabs and projection

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
- Effective visibility：selected resource 的 Harness 摘要显示 `visible` / `not-visible` / `unknown` / `conflicted`；未检测项显示 `not-detected`
- Update availability：显示 `current` / `available` / `upstream-missing` / `check-failed` 与 `checkedAt`；无缓存时显示 unknown
- Inherited Project entry：只读并显示 source directory

Source refresh/update/remove 只在 dedicated Source workspace 触发；Target/Skill matrix 仅投影 update availability，不新增旁路 mutation。

Global view 中 `Space` 只切换 existing Relationship；Missing 通过 Link/Mirror plan 建立。Project view 每个 Skill × Target 只投影一个有效条目：inherited ON 只读；inherited OFF 或 missing 可用普通 `Space` 创建 Project Relationship；Project ON/OFF 始终停留在同一条目。

Link/Unlink 和 Mirror create/remove 显示 source → target 并确认。Unlink 只删除 symlink。删除 source local resource 走 Shared remove 的依赖枚举和二次确认，不作为普通 Space 行为。

### Search, sort, details

- `/` 搜索 name、frontmatter description 与 provenance，不搜索完整 `SKILL.md` body。
- `s` 按 Name（默认）→ Status → Source 循环排序。
- 刷新或排序后 selection 跟随 resource identity，不跟随旧 row index。
- Summary 显示 name、description、source；无可靠来源时显示 `Source unknown` 与 `realPath`。Skill view 的详情同时列出全部内置 Harness 的 Effective visibility 摘要，包括未检测项。
- Visibility detail 打开非全屏、可滚动 modal，展示 consumed roots、Relationships、Shared consumption、证据版本、冲突、warnings 与 blockers；用户可选择 `visible` 或 `hidden` 只查看同一 resolver 生成的 plan，不能从 Explain modal apply。
- Enter 打开非全屏、可滚动的完整 `SKILL.md` modal；Esc 返回并保留 selection。
- Keyboard-only；footer 只显示当前上下文可用动作。

## Thin skill layer

薄 Skill 通过 `skillspub` CLI 读取现场状态并执行明确操作。它必须使用 Harness、Skill Target 与 Shared Target 语言，执行前展示 Actual/Desired state，执行后复述变更与剩余 Drift。它与 TUI 共享 programmatic core，但两个入口不要求完整 parity。
