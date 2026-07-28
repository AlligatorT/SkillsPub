# ADR-0003: scan/doctor 显式同步,不做后台监听和 hook

状态: accepted (2026-07-27)

## 背景

外部世界会变化:npx skills 装新 skill、skill 被更新/删除、用户装新 agent、上游 repo 发新 skill。需要一个策略让 CLI 与磁盘/外部世界保持同步。

## 决策

**scan/doctor 是显式命令,不做后台监听、不做 hook。**

- `skm scan`:发现新 skill、从 lock 文件读来源 repo 自动入 `repo:*` bundle、更新 inventory hash、发现"同源但未安装"的上游新 skill(提示,不自动装)、标记 untagged 提醒分类。
- `skm doctor`:清理死链;被删 skill 的 bundle/tag/preset 成员关系标 **missing**(不自动删配置,skill 重装回来时配置自动复活)。
- `skm ls` 顺带提示("有 3 个新 skill 未分类、1 个死链"),用户自己决定何时 scan/doctor。
- 新 agent 不自动铺开 preset;`preset apply` 时提示。

可选增强(后做):包装 `skills add` 的 shell alias,装完自动 `skm scan --quiet`(skilltags 的 auto-sync 思路)。

各事件的具体行为见 [docs/spec/cli.md](../spec/cli.md) 的同步规则表。

## 后果

- 无后台进程、无文件系统监听,CLI 本身零常驻成本,行为可预测。
- 代价:同步靠用户记得跑;用 `ls` 的提示和可选 alias 缓解。
