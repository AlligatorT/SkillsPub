# ADR-0010: TUI Project Scope 视图(tui --project)

状态: partially superseded by `docs/spec/cli.md` (Status and actions) and issue #49 (2026-08-14)

进入方式、专用项目 TUI、catalog 仍只读全局、以及 plan 携带 `stateFile` 仍有效。下列投影与按键规则是历史原文，已被取代：继承行分开列出；拦截 `space`；用 `i` 或批量 `o` 开启。现行规则：每个 Skill × Target 只投影一个有效条目；inherited ON 只读；inherited OFF 或 missing 用普通 `Space` 创建 Project Relationship。

## 背景

ADR-0007 定案 Project scope 的语义(state 跟随项目、当前目录可写、继承只读),引擎层已实现(`scanProjectInventory`、project/parent/global 三级 Runtime、readOnly 标记),CLI 也有 `skillspub project <path> ...`。缺口在 TUI:无论在哪启动都只显示全局视图。Issue #46。

## 决策(grilling 确认)

- **进入方式**:`skillspub tui` 保持全局视图不变;`skillspub tui --project [path]`(缺省 cwd)打开**专用**项目 TUI,不提供切换回全局的选项。不做自动检测——避免在任意目录悄悄绑定项目态。
- **视图模型**(historical):复用同一套矩阵设计,不新增界面。agent 列 = 当前项目的 project Runtime(每 agent 一列);skill 行 = 项目+父级+全局的并集;继承自父级/全局的行带 scope 标签显示来源。项目级管理 = 为这个项目特别开启哪些 skill(按 agent 分别定义);全局已 ON 的在项目视图不可 OFF。现行投影见 Status 行。
- **只读边界**(historical):继承行(scope ≠ project)的 mutation 键(space/i/u 对其 relationship)被拦截,提示 `read-only: inherited from <scope>`;为项目开启用 i(link 入 project Runtime)或批量 o。
- **catalog**:本轮不做项目 catalog overlay。TUI catalog(tags/bundles/presets 定义)仍只读全局 state;orphan preset 展示同属后续 ticket。
- **state 写入**:ActivationPlan 携带 `stateFile`(取自 scan report,project scan 即项目 state),apply 写入 plan 自带文件——apply 不需要知道 scope。

## 后果

- 四个 plan 函数(planActivation/planToggle/planLink/planUnlink)新增可选 scope 参数;project report 中同 key Runtime 有多个时按 `scope==='project'` 解析。
- `SkillInfo`/`SkillRelationship` 携带 scope 与 readOnly,TUI 只做呈现与拦截,语义判定全在引擎。
- 项目 TUI 里批量 o 对未在项目开启的 skill 是 missing→on(在 project Runtime 建 link),与"为项目特别开启"的心智模型一致。现行开启路径是 `Space`,不再暴露 Link。
