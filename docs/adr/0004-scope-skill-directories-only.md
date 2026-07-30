# ADR-0004: 管理范围 = 自包含 SKILL.md 目录,不碰 plugin 和 MCP

状态: accepted (2026-07-27)

## 背景

agent 生态里"能力包"有多种形态:纯 skill 目录、CLI 耦合型 skill、各家私有格式的 plugin 包、MCP 配置。想全管会陷入各家私有格式的泥潭。

## 决策

**唯一管理单元 = 自包含的 SKILL.md 目录,位于各 agent 的全局 skills 根目录**(`~/.claude/skills/`、`~/.agents/skills/`、`~/.pi/agent/skills/` 等)。这是生态里唯一跨 agent 通用的原语。

明确不碰:

| 形态 | 例子 | 为什么不碰 |
| --- | --- | --- |
| cli-coupled skill 的配套 CLI | lark-*(离了 lark-cli 没用)、agent-browser | skill 本体只是文档,能力在配套 CLI。开关 skill 可以(挪目录而已),CLI 不管。SKILL.md 里声明了 `allowed-tools`/`Bash(...cli...)` 的视为这类,scan 时打 `cli-coupled` 标提醒 |
| plugin 包 | Claude Code plugins(`~/.claude/plugins/`)、codex/pi/opencode 各自格式 | skill + hooks + scripts + commands 打包,格式各家私有;要开关只能用各 agent 自己的 plugin 管理机制 |
| MCP 配置 | 各 agent 的 mcp.json / config.toml | MCP 是通用原语,但每个 agent 的配置文件格式/位置都不同,是另一个工具的事 |

**转换(可选,后做)**:`skillspub import <path>` 把 plugin 里纯粹的 skills/ 子目录抽出来变成普通 shared skill;hooks/scripts 部分直接丢弃并警告。

## 后果

- 管理面收敛到一个跨 agent 通用原语,实现简单、语义清晰。
- cli-coupled skill 被关掉后 agent 看不到文档但 CLI 还在,靠 `cli-coupled` 标签让用户知情。
