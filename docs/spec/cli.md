# Spec: SkillsPub CLI

命令名 `skillspub`。设计决策见 `docs/adr/`,术语见 `CONTEXT.md`。

## State file

`~/.config/skillspub/state.json`,只存元数据(ADR-0001):

```json
{
  "bundles":   { "matt-pocock": ["grilling", "batch-grill-me"] },
  "tags":      { "code-review": ["review", "backend"] },
  "presets":   { "frontend": { "bundles": ["matt-pocock"], "skills": ["..."], "agents": ["claude", "pi"] } },
  "inventory": { "code-review": { "source": "owner/repo", "hash": "...", "seen_at": "..." } }
}
```

on/off 状态不入此文件,每次现场扫磁盘。agent 注册表在 `~/.config/skillspub/agents.conf`。

首次运行时,SkillsPub 会把旧配置目录里目标位置尚不存在的文件复制到新目录;已有 SkillsPub 文件优先,旧文件不会被删除或覆盖。

## 命令面

```text
skillspub ls [--agent A] [--tag T]     # skill × agent 开关矩阵(扫磁盘);顺带提示未分类/死链
skillspub on|off <skill|bundle:X|tag:Y> <agent...>
skillspub status <skill>
skillspub agents                       # agent 注册表
skillspub bundle ls|show|create|add|rm
skillspub tag add|rm|ls
skillspub preset create|add|apply|off|ls
skillspub scan                         # 发现新 skill,更新 inventory
skillspub doctor                       # 清理死链,标 missing
skillspub tui                          # 全功能 TUI(ADR-0005)
```

裸 `skillspub` 在 stdin/stdout 都是 TTY 时进入 TUI;其他环境只打印 usage。`skillspub tui` 显式进入同一 TUI,不接受额外参数。

### bundle

```bash
skillspub bundle ls                    # 所有 bundle(自动 repo:* + 手动)
skillspub bundle show repo:ai-hero     # 看成员
skillspub on  bundle:matt-pocock pi    # 整组开
skillspub off bundle:matt-pocock claude
```

### tag

```bash
skillspub tag add code-review backend review
skillspub tag ls [--skill code-review]
skillspub ls --tag backend             # 过滤视图
skillspub off tag:backend grok         # 按 tag 批量关
```

### preset

```bash
skillspub preset create frontend
skillspub preset add frontend bundle:matt-pocock tag:ui code-review
skillspub preset agents frontend claude pi
skillspub preset apply frontend        # 幂等收敛:preset 内的开,其他已管 skill 不动
skillspub preset off frontend          # 只关 preset 里的,可恢复
```

## 同步规则(ADR-0003)

| 事件 | 来源 | CLI 行为 | 命令 |
| --- | --- | --- | --- |
| 新 skill 装入 | npx skills / gh skill / 手动 | 发现它;从 lock 文件读来源 repo → 自动入 `repo:*` bundle;标 untagged 提醒分类 | `skillspub scan` |
| skill 被更新 | npx skills update | symlink 场景 agent 自动看到最新版,什么都不用做;只更新 inventory 的 hash(用于检测"本地被手改过") | `skillspub scan` |
| skill 被删除 | skills remove / 手动 rm | 死链 → doctor 清理;bundle/tag/preset 成员关系标 missing,不自动删(重装回来自动复活) | `skillspub doctor` |
| 新 agent 装了 | 用户装新工具 | agents.conf 加一行;preset 里 `agents: [all]` 不自动铺开,apply 时提示 | 手动 + apply |
| 上游 repo 加了新 skill | 上游发布 | scan 对比 `repo:*` bundle 成员和 lock 文件,发现"同源但未安装" → 提示可安装(不自动装) | `skillspub scan` |

## TUI

`skillspub tui`:全功能交互管理(ADR-0005)。skill × agent 开关矩阵 + on/off,bundle/tag/preset 的创建、成员管理、apply,与 CLI 命令面一一对应。TUI 是纯壳,业务逻辑在 core library,与 CLI、薄 skill 层共用。

## 薄 skill 层

`~/.agents/skills/skillspub/SKILL.md`,只写路由规则:

- 用户说"开/关/禁用某个 skill/某组 skills" → 跑 `skillspub on/off`
- 用户问"某某 skill 在哪些 agent 上" → 跑 `skillspub status` / `skillspub ls`
- 执行前先 `skillspub ls` 展示现状,执行后复述变更
- bundle/tag/preset 相关话术 → 对应子命令
