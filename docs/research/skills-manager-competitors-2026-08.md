# Agent Skills 管理竞品复盘（2026-08）

**检索日期：2026-08-22。** GitHub stars、更新时间与 release 状态是当日快照，会继续变化。本文只使用项目自己的仓库、README、源码、release 与官方文档；没有把二手榜单或营销文章当作事实来源。

## 结论先行

用户记得的桌面 App 几乎可以确定是 **[xingkongliang/skills-manager](https://github.com/xingkongliang/skills-manager)**：检索时 **3,937 stars**，README 明确展示 Global Workspace、Agent Workspace、Project Workspace，并宣称内置支持 52 个 agents。匹配度约 90%。[仓库元数据](https://api.github.com/repos/xingkongliang/skills-manager) · [README](https://github.com/xingkongliang/skills-manager/blob/main/README.md) · [v1.34.2](https://github.com/xingkongliang/skills-manager/releases/tag/v1.34.2)

但它的“支持 52 个 agents”主要表示：维护了 52 组**检测路径、Global skills 目录、可选 Project skills 目录**，然后把中央 library 通过 symlink/junction/copy materialize 到这些目录。它没有证明 52 个 Harness 都经过真实启动、最终发现结果验证或 Shared/vendor roots 隔离。[ToolAdapter 源码](https://github.com/xingkongliang/skills-manager/blob/main/src-tauri/src/core/tool_adapters.rs) · [sync engine](https://github.com/xingkongliang/skills-manager/blob/main/src-tauri/src/core/sync_engine.rs)

过去几周到几个月里，CLI 竞品已经明显增多：Vercel `skills`、GitHub CLI `gh skill`、ASM、Skillfish、Skill Flow、dotagents、Paks 等已经覆盖安装、Global/Project scope、path adapters、manifest/lock、update、JSON/TUI 的不同组合。**“中央仓库 + 目标路径表 + symlink/copy”已经商品化。**

这并不直接否定 SkillsPub，但迫使它明确产品命题：

- 如果 SkillsPub 只是“把 Skills 分配到很多 Agent 目录”，市场已有更成熟、更宽的产品。
- 如果 SkillsPub 的核心是“解释并验证一个 Harness 最终到底能看到什么；在 Shared roots、兼容入口与 Harness 配置存在时仍能独立控制可见性”，它仍有差异化，但可真正达到 `managed` 的 Harness 数量会比较少。
- 因此，在继续 #76–#82 前，最好先决定 SkillsPub 是要做**广覆盖的 filesystem projector**，还是**少而可信的 final-visibility control plane**。本文建议后者，并避免重复造 marketplace、Git downloader 和 50 项路径表。

## 1. 记忆中的桌面 App

### 1.1 最可能：Skills Manager

| 项目 | 2026-08-22 快照 | 匹配理由 |
| --- | ---: | --- |
| [xingkongliang/skills-manager](https://github.com/xingkongliang/skills-manager) | 3,937 stars / 339 forks | 桌面 App；52 agents；Global/Agent/Project Workspaces；Presets；Project-level 管理；用户记忆全部吻合 |
| [qufei1993/skills-hub](https://github.com/qufei1993/skills-hub) | 1,194 stars / 145 forks | 同样是 Tauri 桌面 App、46 adapters、Global/Project sync，但 star 数与记忆不符 |

Skills Manager 创建于 2026-03-02，最近 inspected release 是 2026-08-16 的 v1.34.2；Skills Hub 创建于 2026-01-25，最近 release 是 2026-08-06 的 v0.8.1。两者都不是只有截图的概念项目。[Skills Manager API](https://api.github.com/repos/xingkongliang/skills-manager) · [Skills Hub API](https://api.github.com/repos/qufei1993/skills-hub)

### 1.2 “支持所有 Agents”实际做了什么

Skills Manager 的 `ToolAdapter` 主要保存：

- tool key / display name；
- Global skills 相对路径；
- 检测目录；
- additional scan directories；
- 可选 Project skills 相对路径；
- 用户 path override；
- UI category。

这是一套**filesystem path adapter**，不是 Harness 启动或隔离契约。[源码](https://github.com/xingkongliang/skills-manager/blob/main/src-tauri/src/core/tool_adapters.rs)

具体例子：

- Codex adapter 把 `~/.codex/skills` 当主要 Global 路径，并额外扫描 `.agents/skills`；
- OpenCode adapter 使用 `~/.config/opencode/skills` 与 Project `.opencode/skills`；
- Grok adapter 使用 `.grok/skills` 路径；
- Custom Tool 本质上也是用户提供 Global/Project 目录。

在已检查的 adapter、sync engine、tool service 与 project scanner 中，没有发现它为 Skills 管理 OpenCode 启动环境、Grok `[skills].ignore` / Claude-Cursor compatibility isolation，或为 Codex 建立逐 Skill 最终可见性控制。它的源码也没有把 launcher/environment/native settings 作为 ToolAdapter 字段。[adapter](https://github.com/xingkongliang/skills-manager/blob/main/src-tauri/src/core/tool_adapters.rs) · [tool service](https://github.com/xingkongliang/skills-manager/blob/main/src-tauri/src/core/tool_service.rs)

### 1.3 Materialization 与安全性

Skills Manager 的 sync engine 支持 symlink 与 copy；Windows 会尝试 symlink、junction，再 fallback 到 copy。源码包含 overlap 防护、foreign link 分类、no-clobber 与 managed target 记录，说明它对文件安全并不草率。[sync engine](https://github.com/xingkongliang/skills-manager/blob/main/src-tauri/src/core/sync_engine.rs)

它也有真实的 `(skill, agent)` intent、per-agent toggle、preset 与 Project Workspace。但当两个 agents 映射到同一个 physical skills directory 时，源码会保留一个共享文件对象并为两个 agent 建 target records；关闭其中一个不会删除另一个仍引用的对象。也就是说，**UI 上独立的 agent toggle 不一定对应物理上、运行时上独立的最终可见性。**[sync commands/tests](https://github.com/xingkongliang/skills-manager/blob/main/src-tauri/src/commands/sync.rs)

Project Workspace 也是实用功能：它扫描并操作所选项目里的 agent-relative paths，可以 symlink/copy，能把 Project Skill 与中央 library 双向比较。但这仍是 project filesystem scope，不是项目启动环境或 Harness-native isolation。[project scanner](https://github.com/xingkongliang/skills-manager/blob/main/src-tauri/src/core/project_scanner.rs)

### 1.4 对 SkillsPub 最重要的解释

Skills Manager 的“52 agents”更准确地理解为：

> 52 个维护中的路径映射与部署入口，而不是 52 个经过最终发现验证的 Managed Harness Adapters。

所以它能非常方便地做“把 Skill 放到某个工具常见的目录”，但不能自动解决 SkillsPub 已经遇到的难题：

- 两个 Harness 同时消费 `.agents/skills` 时，如何分别 ON/OFF；
- Grok 仍从 Shared/Claude/Cursor compatibility roots 读取时，删除 `.grok/skills` entry 是否真的 OFF；
- OpenCode 依赖进程环境或 runtime flag 才能排除默认 roots 时，谁负责启动；
- Harness 的最终 discovery 是否与路径表一致。

## 2. 现在有哪些真正相关的 CLI

### 2.1 当日 adoption 快照

| CLI / 项目 | Stars | 最近 push | 核心定位 |
| --- | ---: | --- | --- |
| [vercel-labs/skills](https://github.com/vercel-labs/skills) | 29,449 | 2026-08-18 | 主流 Agent Skills 安装/发现/update CLI，70+ agent path mappings |
| [luongnv89/asm](https://github.com/luongnv89/asm) | 891 | 2026-08-21 | CLI + Ink TUI；多 provider inventory、audit、install、JSON、library |
| [knoxgraeme/skillfish](https://github.com/knoxgraeme/skillfish) | 310 | 2026-08-07 | 多 agent install/update、project/global manifest、JSON/check-only update |
| [VintLin/skill-flow](https://github.com/VintLin/skill-flow) | 253 | 2026-08-22 | manifest intent + lock deployments + repair；CLI/TUI/macOS desktop |
| [getsentry/dotagents](https://github.com/getsentry/dotagents) | 219 | 2026-08-14 | `agents.toml`/lock；Skills + MCP/hooks/subagents/plugins 的多 runtime projection |
| [reorx/skm](https://github.com/reorx/skm) | 75 | 2026-07-12 | 轻量、声明式、Global-only symlink manager |
| [stakpak/paks](https://github.com/stakpak/paks) | 64 | 2026-07-04 | Agent Skills registry/package manager；agent/scope path install |
| [takemo101/sksync](https://github.com/takemo101/sksync) | 2 | 2026-08-22 | 很新但架构完整的 config/lock/plan/apply symlink projector |

Stars 是 adoption 信号，不是代码质量评分；这里用于回答“现在有没有同类项目、是否已经形成市场”。

### 2.2 Vercel `skills`

Vercel `skills` 已经把路径兼容、Global/Project install、源解析、skills.sh 搜索、update/remove、symlink/copy 与大量 agent IDs 做成事实标准。[README](https://github.com/vercel-labs/skills/blob/main/README.md)

它也进一步提供 `skills use`：临时解析一个 Skill 并生成 prompt，传 `--agent` 时可以启动对应 agent。但这仍不是一个通用的多 Skill final-visibility control plane，而是一次性的 Skill use/launch 入口。

**对 SkillsPub 的意义：** Source 下载、基础 provenance、path table、marketplace/search 不再是差异化，应尽量复用或兼容，而不是重做。

### 2.3 GitHub CLI `gh skill`

GitHub 官方已加入 `gh skill install`，提供 project/user scope 与 agent destinations。[CLI manual](https://cli.github.com/manual/gh_skill_install)

官方 changelog 强调：

- Git tree SHA 内容寻址；
- frontmatter 中携带 portable provenance；
- version pinning；
- immutable releases；
- remote tree change detection。

这是当前最强的 supply-chain/provenance 方向之一，但仍主要是 destination-based installation，不是 Harness final visibility orchestration。[GitHub changelog](https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/)

### 2.4 ASM

ASM 已经有较强 adoption（891 stars），提供 CLI、TUI、JSON、Global/Project inventory、install、audit、outdated/update、bundle 与 local library。[README](https://github.com/luongnv89/asm/blob/main/README.md)

但它的 provider config 是典型路径表：Codex `~/.codex/skills` / `.codex/skills`，OpenCode `~/.config/opencode/skills` / `.opencode/skills`，另有 `.agents/skills` provider。scanner 主要读取这些目录。[config source](https://github.com/luongnv89/asm/blob/main/src/config.ts) · [scanner](https://github.com/luongnv89/asm/blob/main/src/scanner.ts)

**结论：** ASM 在 SkillsPub 的可见功能面上非常接近，但仍没有证明同一 Shared root 的 per-Harness isolation。

### 2.5 Skillfish

Skillfish 具备 Global/Project scope、agent path table、`skillfish.json` manifest、update、bundle、JSON 与非交互模式。值得注意的是 `--json` 无 `--yes` 的 update 会进入 check-only，而不是直接写盘——这与 SkillsPub 刚确定的 plan-only JSON 方向相似。[README](https://github.com/knoxgraeme/skillfish) · [agents source](https://github.com/knoxgraeme/skillfish/blob/main/src/lib/agents.ts) · [project manifest](https://github.com/knoxgraeme/skillfish/blob/main/src/lib/project-manifest.ts)

它仍然主要把 Skill copy 到 agent directories；manifest 管的是安装来源与目标，不是 Shared consumption 或 runtime discovery。

### 2.6 Skill Flow

Skill Flow 是最值得借鉴的状态分层之一：README 明确区分 `manifest.json`（intent）与 `lock.json`（resolved inventory/deployments），并提供 `doctor`、source/state/target repair、TUI 和桌面 bridge。[README](https://github.com/VintLin/skill-flow/blob/main/README.md)

这验证了 SkillsPub 当前“intent 与磁盘 projection 分离”的方向。它仍以 target deployment 为主，没有给出 per-Harness final-discovery isolation 的证据。

### 2.7 dotagents

dotagents 比普通 path manager 更深：它用 `agents.toml` / `agents.lock` 管 Skills、MCP、hooks、subagents 与 plugins，并为不同 runtime 生成 native config。[README](https://github.com/getsentry/dotagents/blob/main/README.md)

但 Skills 本身仍采用 Shared projection：`skillSymlinkTargets()` 找到每个 agent 的 parent dir，`ensureSkillsSymlink()` 会把整个 `<target>/skills` 指向同一 scope 的 `.agents/skills`；已有 real directory 会先迁入 Shared 再被整个 symlink 替换。[skill targets](https://github.com/getsentry/dotagents/blob/main/packages/dotagents/src/targets/skill-symlinks.ts) · [symlink manager](https://github.com/getsentry/dotagents/blob/main/packages/dotagents/src/symlinks/manager.ts)

这能让配置中的 agents 共享同一组 Skills，但天然不支持“同一个 Shared root 对 Agent A ON、Agent B OFF”。dotagents 的强项是跨 runtime config generation，不是逐 Skill final visibility。

### 2.8 Paks、SKM、sksync

- **Paks** 是 registry/package-manager-first：支持 agent 与 Global/Project scope、自定义 agent paths，但安装模型仍是目标目录选择。[repo](https://github.com/stakpak/paks)
- **SKM** 明确是 Global-only 声明式 symlink manager，不尝试 Project scope。[README](https://github.com/reorx/skm/blob/master/README.md)
- **sksync** adoption 很小，但工程边界不错：project/global config、portable lock v5、plan/apply、no-clobber、只删除 managed symlinks、outdated 比较 remote ref 与 lock commit。[README](https://github.com/takemo101/sksync/blob/main/README.md)

## 3. 能力对照

Legend：✓ 明确验证；△ 有一部分或只到 filesystem projection；— 未发现证据。

| 项目 | Global / Project | Persistent intent / lock | ON/OFF / deploy | Shared isolation | Link / copy / mirror | Provenance/update | UI | Final visibility proof |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Skills Manager desktop** | ✓ / ✓ | ✓ SQLite + targets | ✓ per-agent rows/presets | △ 同路径共享对象 | ✓ symlink/junction/copy | ✓ Git/local + update | ✓ Desktop + CLI | △ 只在独立路径时近似成立 |
| **Vercel `skills`** | ✓ / ✓ | ✓ lock | △ install/remove selections | △ Shared destinations 去重 | ✓ symlink/copy | ✓ | CLI prompts | △ destination-based |
| **`gh skill`** | ✓ / ✓ | ✓ portable provenance/pin | △ destination selection | △ 同 destination 安装一次 | copy-oriented | ✓✓ tree SHA/pinning | CLI | △ destination-based |
| **ASM** | ✓ / ✓ | △ config/library | ✓ enable/disable/install | — | copy/link features | ✓ | ✓ TUI + CLI | △ path scan only |
| **Skillfish** | ✓ / ✓ | ✓ project/global manifest | ✓ install/remove/update | — | copy-oriented | ✓ | CLI | △ path table only |
| **Skill Flow** | ✓ / ✓ | ✓ manifest intent + lock deployments | ✓ groups/deployments | △ | projection | ✓ doctor/repair | ✓ TUI/Desktop | △ target deployment |
| **dotagents** | ✓ / ✓ | ✓ agents.toml/lock | △ one Shared set per scope | — entire dir shared | ✓ whole-dir symlink | ✓ source resolution | CLI | △ Shared projection |
| **SkillsPub** | ✓ / ✓ | ✓ intent/claims + disk Actual | ✓ Relationship/Activation | ✓ where Adapter can isolate | ✓ local/link/managed mirror | ✓ planned | TUI + CLI | **目标能力**：Adapter verify |

## 4. 这是否推翻 SkillsPub 的前提？

### 4.1 推翻了“市场没有同类工具”

这个前提已经不成立。桌面端有成熟且高 adoption 的 Skills Manager / Skills Hub；CLI 端从 Vercel、GitHub 到 ASM、Skillfish、Skill Flow、dotagents 已形成明显生态。

如果 SkillsPub 的一句话仍是“统一管理所有 Agent 的 Skills，并支持 Global/Project”，用户会合理地问：为什么不用 Stars 更高、UI 更完整、agent path table 更宽的现有工具？

### 4.2 没有推翻“路径不等于最终可见性”

竞品的大多数“支持 N 个 agents”仍然建立在：

```text
source / central store
  → path adapter
  → symlink / junction / copy
  → agent skills directory
```

这解决了分发与同步，却没有解决：

- 一个 Shared Target 被多个 Harness 同时消费时的独立控制；
- Harness 额外扫描 vendor-compatible roots；
- environment/launcher 才能改变 discovery 的 Harness；
- 配置 drift、unknown schema 与最终 discovery verification。

SkillsPub 对 Grok 的复杂工作并不是竞争对手证明“不需要”，而是竞争对手多数选择**不做这个保证**。

### 4.3 但严格模型也有产品风险

用户的担心成立：真正能达到严格 `managed` 的 Harness 可能只有少数。若大多数 Harness 只能做到 `discoverable` 或 path projection，那么 SkillsPub 的深模型会带来较高实现成本，却只覆盖很窄的产品面。

所以差异化不能只存在于内部架构；必须变成用户能感知的价值，例如：

- “Why is this Skill still visible?” explain；
- 对 Shared/vendor roots 的最终 visibility graph；
- Harness-native config plan/verify；
- 明确的 managed/discoverable/unsupported 可信等级；
- 不假装 50 个 path adapters 都等价于真实控制。

## 5. 对当前路线图的建议

### 建议：先暂停 #76–#82 的实施，不删除 tickets

[#76](https://github.com/AlligatorT/SkillsPub/issues/76)（update cache）、[#78](https://github.com/AlligatorT/SkillsPub/issues/78)（JSON）、[#80](https://github.com/AlligatorT/SkillsPub/issues/80)（公开 package）都是合理工程工作，但它们会把当前产品命题进一步固化。在竞品面已经变化的情况下，应先用一个短 decision gate 回答：

1. **Verified visibility product（推荐）**  
   SkillsPub 只承诺少量、真实验证的 Managed Harness；其他 Harness 清楚标记 discoverable/unsupported。核心卖点是 explain/plan/verify，而不是 agent 数量。

2. **Broad filesystem manager**  
   放弃严格 isolation，快速加大 path table、桌面/TUI、marketplace、copy/symlink。这个方向已有 Skills Manager、Skills Hub、ASM、Vercel `skills`，不建议正面竞争。

3. **Compatibility/audit layer**  
   复用 `npx skills` / `gh skill` / dotagents 的 source/provenance/materialization，SkillsPub 只做 inventory、Relationship、visibility audit 与 Harness verification。这可能是最轻的长期架构，但需要重画产品边界。

若选择方案 1，建议：

- 保留现有 Target/Relationship/Shared consumption/Adapter 词汇；
- 把“50 agents”式 path table 放到长期 roadmap，不作为 v0.1 成功指标；
- 减少 Source/marketplace 重复建设，优先兼容 Vercel/GitHub provenance；
- 在 v0.1 ticket 之前先做一个用户可见的 `explain visibility` tracer bullet，以证明深模型的价值；
- 重新评估 #76–#82 是否仍是最先发布的 frontier。

## 6. 最强架构启示

竞品共同验证的最佳分层是：

1. **Intent**：用户/项目想要哪些 Skills；
2. **Resolution**：不可变版本、source provenance、content hash/lock；
3. **Materialization**：本机实际 copy/symlink/mirror/deployment records；
4. **Verification / explain**：目标路径与运行中 Harness 最终是否一致。

SkillsPub 已经比多数竞品更重视 1、3、4；GitHub CLI 与 Skill Flow 在 2 上值得直接借鉴。不要让 symlink topology 成为领域模型，也不要为已经由 Vercel/GitHub 解决的下载与 registry 重新造一套平行生态。

## 7. 研究限制

- 本文通过源码与官方文档判断行为，没有安装并启动 52 个 Harness 做 live discovery matrix。
- Adapter path 很容易随上游变化；“支持”数量必须按 retrieval date 理解。
- Stars 只是采用度信号，不代表正确性或维护质量。
- Skills Manager 的识别是高置信度而非绝对确定；如果用户能提供旧截图或 DMG 名称，可以进一步确认。

## 主要来源

- [xingkongliang/skills-manager](https://github.com/xingkongliang/skills-manager)
- [Skills Manager ToolAdapter](https://github.com/xingkongliang/skills-manager/blob/main/src-tauri/src/core/tool_adapters.rs)
- [Skills Manager sync engine](https://github.com/xingkongliang/skills-manager/blob/main/src-tauri/src/core/sync_engine.rs)
- [qufei1993/skills-hub](https://github.com/qufei1993/skills-hub)
- [vercel-labs/skills](https://github.com/vercel-labs/skills)
- [GitHub CLI `gh skill` manual](https://cli.github.com/manual/gh_skill_install)
- [GitHub `gh skill` changelog](https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/)
- [luongnv89/asm](https://github.com/luongnv89/asm)
- [knoxgraeme/skillfish](https://github.com/knoxgraeme/skillfish)
- [VintLin/skill-flow](https://github.com/VintLin/skill-flow)
- [getsentry/dotagents](https://github.com/getsentry/dotagents)
- [stakpak/paks](https://github.com/stakpak/paks)
- [reorx/skm](https://github.com/reorx/skm)
- [takemo101/sksync](https://github.com/takemo101/sksync)
