# ADR-0006: SkillsPub 采用 matrix-first TUI

状态: extended by ADR-0007 (2026-08-01)

Matrix-first 方向保留；ADR-0007 将目标从 Agent 扩展为 Agent/Shared Runtime，并增加 Project 继承只读投影。

## 背景

ADR-0005 假设 TUI 应与完整 CLI 命令面一一对应。实际的两栏实现因此偏离了用户最需要的 skill × agent 关系管理，也把 bundle/tag/preset 等未验证需求带进了 TUI 范围。一个使用真实 Ink 交互的 throwaway prototype 已验证 Agent/Skill 双视角、宽屏三栏和窄屏两栏投影。

## 决策

- 产品名为 **SkillsPub**，npm 包和 CLI 命令为 `skillspub`；TTY 中裸命令直接打开 TUI，`skillspub tui` 保留为显式入口。
- TUI 是 matrix-first 的关系管理器，不追求完整 CLI parity。默认 **Agent** tab 显示 agent → 已有 skill relationships；**Skill** tab 显示 skill instance → agents/relationships。被动 summary 不参与焦点移动，窄屏只隐藏 summary。
- skill instance 以可解析的 `realPath` 为身份；同名、不同 `realPath` 的实例是 variants，不得按目录名合并或读取“第一个同名实例”的详情。
- activation (`on`/`off`) 与 resource form (`local`/`link`) 是两个维度。ON/OFF 只移动现有 entry；缺失关系通过 Link 创建 symlink；Unlink 只删除 symlink，绝不删除真实 skill 目录。Link/Unlink 需要确认，ON/OFF 不需要。
- TUI 启动和自身 mutation 后重扫磁盘；外部变化由用户按 `R` 显式刷新，不增加 watcher、polling 或后台进程。
- 继续使用 TypeScript + Ink，并让 CLI 与 TUI 共享 programmatic core；共享的是领域操作，不要求两个入口暴露完全相同的功能。

## 后果

ADR-0005 的“全功能 TUI、与 CLI 一一对应”被本 ADR 取代。bundle/tag/preset、安装、发现、更新、卸载、批量操作、鼠标和真实目录删除不属于本次 TUI build。现有 `skm` 命名和配置数据的兼容迁移由独立 naming/CLI ticket 落实，迁移不得造成用户状态丢失。
