# ADR-0002: 分组模型 = 自动 bundle + 手动 bundle + tag + preset

状态: partially superseded by ADR-0007 (2026-08-01)

Bundle 与 Tag 仍是选择器；ADR-0007 将 Preset 改为 persistent positive-claim policy，而不是一次性 apply/off 组。

## 背景

需要三种不同性质的分组诉求:同源 skill 天然成组(零配置)、跨源自由组合、按主题批量操作。调研中没有产品把这三件套和薄 skill 路由组合好(见 ADR-0001)。

## 决策

三层分组,各管一件事:

1. **自动 bundle(`repo:<owner>/<name>`)**:inventory 从可靠 installer lock 读取当前 provenance；同 repo 的 skill 自动归入 `repo:*` bundle。无法确认来源时保持 `Source unknown`，不读取第三方 manager DB。
2. **手动 bundle**:`skillspub bundle create/add/rm` 自由组合。bundle 是"展开即执行"的对象,不是常驻激活态。
3. **tag**:纯手动标签,用于过滤(`skillspub ls --tag`)和批量操作(`skillspub off tag:backend`)。**不做智能分类**(用户明确不需要)。
4. **preset** = selectors + Runtime targets 的 persistent positive-claim policy。Activate/deactivate/reconcile 语义由 ADR-0007 定义。

## 后果

- 同源 skill(如 Matt Pocock 那套)天然成组,装新 skill 时 `skillspub scan` 自动归位。
- Preset 可显式、幂等 reconcile；Bundle 与 Tag 仍保持一次性 selector 语义。
- 三类引用(`skill`、`bundle:X`、`tag:Y`)统一作为 on/off 的操作对象。
