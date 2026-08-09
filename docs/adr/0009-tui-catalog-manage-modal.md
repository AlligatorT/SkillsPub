# ADR-0009: TUI catalog 操作 = per-skill 管理弹窗;定义级删除留给列表视图

状态: accepted (2026-08-09)

## 背景

Bundle/Tag/Preset(ADR-0002)此前只有 CLI。进入 matrix-first TUI(ADR-0006)时,操作面的形态有几种选择:新 tab、散快捷键、命令面板、覆盖弹窗。同时,定义级删除(bundle rm / preset delete)的副作用级别差异很大。

## 决策

- **弹窗,不开第三 tab。** 选中 skill 按 `m` 呼出覆盖式管理弹窗(可 esc 退出),主角是"这个 skill 的归属":Tag 增删(可现场新建)、Preset 成员切换(可现场新建 preset)。catalog 操作是动作,不是视图。
- **弹窗内 Bundle 归属只读。** `repo:` bundle 由 provenance 自动计算;手动 bundle 的成员编辑维持 CLI。
- **定义级删除不进弹窗。** Bundle 删除虽零副作用(纯 state 元数据),Preset 删除带副作用链(deactivate → 撤 claims → 批量搬条目),但两者都是定义级操作,影响其他 skill;它们属于将来的列表视图(批量模式或 catalog 视图),配 plan 预览。
- **归属编辑即时生效,无需 plan 预览。** Tag/Preset selector 变化只写 state 元数据,不搬磁盘;claims 在下次显式 activate/reconcile 时才重算(ADR-0007)。plan 预览 modal 留给将来 TUI 里的 preset activate/deactivate/reconcile。
- **批量模式是独立增量。** 组合键进入,多选行,动作为 on/off + tag 增删;与弹窗分两个 ticket 交付。
- **Drift 只展示、不自动修**(ADR-0003)。TUI 暂不显示 drift 标记;将来 preset 列表视图一并考虑。

## 后果

- TUI 保持矩阵单一主角;弹窗层级简单(归属 ≠ 定义)。
- 删除入口短期内只在 CLI;用户删除 preset 前在 CLI 看到 plan 预览,语义不变。
