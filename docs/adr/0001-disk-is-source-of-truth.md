# ADR-0001: 磁盘是唯一真相,off = 挪进 `.off/`

状态: accepted (2026-07-27)

## 背景

2026-07-27 调研了做过"分组/分类/preset"的开源项目:

| 项目 | ★ | 分组机制 | 备注 |
| --- | --- | --- | --- |
| luongnv89/agent-skill-manager (`asm`) | 752 | bundle(JSON manifest,可导出分享) | 最接近,有 bundle install/create/export |
| mugpeng/aweskill | 31 | bundle(YAML)+ projection 模型 | 模型最干净:"managed symlink 存在 = 启用",无独立注册表 |
| umutbozdag/agent-skills-manager | 26 | 自动分类(dashboard) | 关 = 重命名 SKILL.md.disabled |
| go165/agent-skill-groups | - | 场景组 + disabled pool | 关 = 挪进 disabled pool |
| steve-piece/skilltags | 1 | 分类 → 生成 slash command | 生成提示文件让 agent 自查 |
| princespaghetti/skset | 3 | group + push | 组推送模型 |
| anthod0/better-skills | 4 | profile(命名快照) | pnpm 式 CAS 存储,过度设计 |
| dkthezero/agk | 0 | profile + vault | 团队分发向,重 |

有 bundle 概念且有一定热度的只有 asm(752★);tag + bundle + preset 三件套 + 薄 skill 路由的组合没有现成产品。值得自己做,但要吸取三条教训:

1. **不要让 CLI 的状态文件和磁盘事实打架**(skills-manager 的 skill_targets 表就是这么废的)
2. **bundle 应该是"展开即执行",不是常驻激活对象**(aweskill 的原话)
3. **关 ≠ 删**,挪进隔离区即可恢复

## 决策

- **磁盘是唯一真相**:开 = symlink/目录存在于 agent 的 skills/ 一级目录;关 = 挪到同目录的 `.off/` 子目录(agent 只扫一级,自动隐身)。
- **state file(`~/.config/skillspub/state.json`)只存元数据**:bundles、tags、presets、inventory。**on/off 状态不入状态文件**,每次 `skillspub ls` 现场扫磁盘。
- 关 ≠ 删:`.off/` 里的 skill 随时可恢复。

## 后果

- 外部工具(npx skills / skills-manager / 手动)怎么动磁盘都不冲突,`skillspub` 永远以现场扫描为准。
- 状态文件可以丢:bundle/tag/preset 配置没了能重建,开关状态本来就活在磁盘上。
- 代价:每次 `ls` 要扫磁盘——skill 数量级下可忽略。
