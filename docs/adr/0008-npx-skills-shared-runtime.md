# ADR-0008: 用固定兼容的 `skills` CLI 管理 Shared Runtime 来源

状态: accepted (2026-08-01)

## 背景

Vercel `skills` CLI 把 `.agents/skills` 当作 canonical root。其 skills.sh catalog 可以收录不同来源的同名 Skills，但本地路径和 lock 都按规范化 Skill name 占位，后安装者可能覆盖先安装者。

正式 skills.sh `/api/v1` 需要 Vercel OIDC；CLI 的 `find` 使用未文档化的匿名 `/api/search`。SkillsPub 不应重写 Git/GitLab、well-known、archive 和 local source 下载器，也不应要求用户为了本地工具绑定 Vercel 项目。

## 决策

### CLI 版本

- SkillsPub 1.0 使用 npm 当前最新版 `skills@1.5.21`。
- 每个 SkillsPub 发布版本绑定并测试一个明确的 `skills` 版本；维护时跟进上游最新版，但运行时不采用未经测试的动态 latest。
- 固定 CLI 版本不冻结 Skill 内容；`skills update` 仍按 lock 中的 source/ref 获取远程最新内容。

### 发现与详情

- 第一版调用 `npx skills find <query>`，接受非交互输出最多六条结果的限制。
- 搜索候选以 `source + skill name/path` 识别，不按 name 去重。
- 选中候选后可调用 `npx skills add <source> --list` 获取 description 并验证来源；解析失败时显示原始输出，允许手工输入 `owner/repo@skill` 或 URL。
- 不直接依赖匿名 `/api/search`，也不接入需要 Vercel OIDC 的正式 API。

### Shared-only 安装

Global Shared Runtime 安装固定调用：

```text
npx --yes skills@1.5.21 add <source>
  --skill <name>
  --agent codex
  --global
  --copy
```

Project Shared Runtime 在精确项目目录执行同一命令并去掉 `--global`。

- `--agent codex` 是 `skills@1.5.21` 已验证的 Shared-only transport：Codex 在该 CLI 中属于 Universal，目标解析为 `.agents/skills`，不会创建新的非 Universal Agent symlinks。
- 开头的 `npx --yes` 只允许 npx 获取固定 package；不向 `skills add` 传 `--yes`。
- SkillsPub 先完成 Runtime Slot、ON/OFF 和路径冲突预检；`skills add` 再展示来源、覆盖目标与第三方 security audit，并负责最后的 `Proceed` 确认。
- 既有 Agent-specific symlinks 不会被本次安装删除，仍按普通 Relationships 扫描。

### Slot、来源与替换

- skills.sh catalog 可有多个同名候选；同一 Shared Runtime 的规范化名称只有一个 Slot。
- Source 是当前 Slot 的可变 metadata，不是 SkillsPub policy identity。用户在外部手工替换来源后，SkillsPub 下次扫描直接接受 lock 中的新来源，并保留该 Slot 的 Base intent、Tags、Bundles 与 Preset claims。
- SkillsPub 自己发起同名不同来源安装时必须先做一次性 Replace 确认，不能把 `--yes` 交给底层静默覆盖。
- 持久警告只用于真实结构异常，例如 ON 与 OFF 同时存在、broken link、lock 有记录但文件缺失；来源变化本身不是 drift。

### ON/OFF 与更新包装

- Global Shared ON 位于 `~/.agents/skills/<name>`；OFF 位于 `~/.agents/.skillspub-off/skills/<name>`。Project Shared ON 位于 `<project>/.agents/skills/<name>`；OFF 位于 `<project>/.skillspub/off/shared/<name>`。
- Global `skills` lock 保持在 `~/.agents/.skill-lock.json`；Project lock 保持在 `<project>/skills-lock.json`。OFF 不删除 lock。
- 包装 `add/update/remove` 时只向底层传递 lock 中由 npx 管理的名称；SkillsPub Links 与 external entries 不得被 `remove --all` 波及。
- Update 取得操作锁并预检冲突，临时恢复应为 OFF 的 npx-managed entries，执行 `skills update`，随后无论成功失败都按 Desired state 停放并验证。进程级异常依靠下次显式 reconcile。
- 更新期间的短暂可见性可接受；运行中的 Agent 在 reload/restart 后重新读取最终磁盘状态。

## 后果

- SkillsPub 复用上游下载、来源解析、lock、更新和安全审计，而不复制其实现。
- Shared Runtime 只能整体开关，不能据此实现 Codex/Pi 等消费者之间的差异。
- `skills` CLI 输出或行为改变时，需要在 SkillsPub 发布周期升级适配。
- 用户直接绕过 SkillsPub 运行 npx 仍可能产生结构 drift；SkillsPub 在下一次 scan/reconcile 时报告现场异常，而不维护“期望来源”。
