# ADR-0002: 分组模型 = 自动 bundle + 手动 bundle + tag + preset

状态: accepted (2026-07-27)

## 背景

需要三种不同性质的分组诉求:同源 skill 天然成组(零配置)、跨源自由组合、按主题批量操作。调研中没有产品把这三件套和薄 skill 路由组合好(见 ADR-0001)。

## 决策

三层分组,各管一件事:

1. **自动 bundle(`repo:<owner>/<name>`)**:inventory 记录每个 skill 的来源 repo(解析 `~/.agents/.skill-lock.json` 的 `source` 字段 + skills-manager DB 的 `source_ref`),同 repo 的 skill 自动归入 `repo:*` bundle,零配置。
2. **手动 bundle**:`skm bundle create/add/rm` 自由组合。bundle 是"展开即执行"的对象,不是常驻激活态。
3. **tag**:纯手动标签,用于过滤(`skm ls --tag`)和批量操作(`skm off tag:backend`)。**不做智能分类**(用户明确不需要)。
4. **preset** = bundles + skills + 目标 agents 的命名组合。`preset apply` 是**幂等的收敛操作**(preset 内的开,其他已管 skill 不动),不是一次性拷贝;`preset off` 只关 preset 里的,可恢复。

## 后果

- 同源 skill(如 Matt Pocock 那套)天然成组,装新 skill 时 `skm scan` 自动归位。
- preset 可反复 apply,不产生漂移;区别于 skills-manager 的一次性拷贝。
- 三类引用(`skill`、`bundle:X`、`tag:Y`)统一作为 on/off 的操作对象。
