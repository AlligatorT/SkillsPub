# CONTEXT: skill-pub

多 agent skills 开关管理 CLI(命令名 `skm`)+ 薄 skill 路由层。

## Ubiquitous Language

| 术语 | 定义 |
| --- | --- |
| **skill** | 唯一管理单元:自包含的 `SKILL.md` 目录,位于各 agent 的全局 skills 根目录(`~/.claude/skills/`、`~/.agents/skills/`、`~/.pi/agent/skills/` 等) |
| **agent** | 消费 skills 的工具(claude、pi、codex 等)。注册表在 `~/.config/skm/agents.conf` |
| **开 (on)** | symlink/目录存在于某 agent 的 skills/ 一级目录 |
| **关 (off)** | 挪到同目录的 `.off/` 子目录(agent 只扫一级,自动隐身)。**关 ≠ 删**,可恢复 |
| **state file** | `~/.config/skm/state.json`,只存元数据(bundle/tag/preset/inventory),**不存 on/off 状态** |
| **inventory** | state file 的一部分,记录每个 skill 的来源 repo、内容 hash、首次发现时间 |
| **bundle** | skill 的命名分组。**自动 bundle** 按来源 repo 成组,命名 `repo:<owner>/<name>`;**手动 bundle** 由 `skm bundle create` 自由组合 |
| **tag** | 纯标签,手动打,用于过滤和批量操作。不做智能分类 |
| **preset** | bundles + skills + 目标 agents 的命名组合。`apply` 是**幂等的收敛操作**,不是一次性拷贝 |
| **cli-coupled skill** | SKILL.md 里声明了 `allowed-tools`/`Bash(...cli...)` 的 skill(如 lark-*、agent-browser)。本体只是文档,能力在配套 CLI;可开关,但 CLI 不管 |
| **悬空 (missing)** | skill 被删后,它在 bundle/tag/preset 里的成员关系。标 missing 不自动删,skill 重装回来时配置自动复活 |

## 核心模型

**磁盘是唯一真相,state file 只存元数据。** on/off 状态每次 `skm ls` 现场扫磁盘,外部工具(npx skills / skills-manager / 手动)怎么动都不冲突。

关键决策见 `docs/adr/`:

- [0001](adr/0001-disk-is-source-of-truth.md) — 磁盘唯一真相 + off = 挪 `.off/`
- [0002](adr/0002-grouping-model.md) — bundle / tag / preset 分组模型
- [0003](adr/0003-explicit-sync.md) — scan/doctor 显式同步,无监听无 hook
- [0004](adr/0004-scope-skill-directories-only.md) — 管理范围 = 纯 SKILL.md 目录
- [0005](adr/0005-tui.md) — 全功能 TUI;core 是 library,CLI/TUI/skill 三个入口共用

实现:TypeScript/Node,TUI 用 Ink,分发走 npm(`npx skm`)。(ADR-0005)

命令面与同步规则见 [docs/spec/cli.md](spec/cli.md)。

## Scope

**只管**:自包含 SKILL.md 目录的开关、分组、分类、场景组合。

**明确不碰**:

| 形态 | 例子 | 为什么 |
| --- | --- | --- |
| cli-coupled skill 的配套 CLI | lark-cli、agent-browser | skill 可开关,CLI 不管 |
| plugin 包 | Claude Code plugins、codex/pi/opencode 各自格式 | 格式私有,只能用各 agent 自己的 plugin 管理机制 |
| MCP 配置 | mcp.json、config.toml | 各家格式/位置不同,是另一个工具的事 |

## 非目标(YAGNI)

不做 GUI(桌面/网页);不做安装/更新/发现(npx skills、gh skill、asm registry 够好);不做内容 hash 版本管理(CAS/lockfile);不做智能分类;不监听文件系统;不做 registry/hub;不管 plugin/hooks/MCP。
