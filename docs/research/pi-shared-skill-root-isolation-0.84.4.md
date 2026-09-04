# Pi 0.84.4 Shared Skill root isolation（Issue #115）

**检索日期：2026-09-04（UTC）。** 本文只把 Pi `v0.84.4` 的官方文档、固定 commit 源码与测试，以及 SkillsPub #109 的 tools-enabled real-machine artifacts 当作行为证据。#109 里的 `--no-tools` probes 已明确失效，不参与结论。

## 结论先行

Pi **有**受支持的持久隔离 seam：在对应 scope 的 `skills` array 中，用**展开后的、root-specific absolute exclusion glob** `!<absolute-shared-root>/**` 排除 Shared auto-discovery。它只匹配从该 Shared root 发现的 lexical path，不匹配 Pi-specific root 下的 Relationship path；因此可以保留 Global Pi `~/.pi/agent/skills`、Project Pi `.pi/skills` 及其中的 symlink Relationships。[Pi settings](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/docs/settings.md#L277-L292) · [matcher source](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L655-L729)

对当前机器与 exact Project `/Users/wangyitao/Projects/SkillsPub`，candidate configuration 是：

```jsonc
// ~/.pi/agent/settings.json — merge into the existing object
{
  "skills": [
    "!/Users/wangyitao/.agents/skills/**"
  ]
}
```

```jsonc
// /Users/wangyitao/Projects/SkillsPub/.pi/settings.json
{
  "skills": [
    "!/Users/wangyitao/Projects/SkillsPub/.agents/skills/**"
  ]
}
```

该 Project 本身就是 Git root，所以没有额外 Project ancestor pattern。若 selected cwd 位于 Git repo 子目录，Project array 必须再包含 cwd 到 Git root（含）每一个 applicable `<ancestor>/.agents/skills/**` 的 absolute exclusion；非 Git 目录则一直到 filesystem root。只排 exact cwd root 会留下 ancestor bypass。[Pi locations](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/docs/skills.md#L24-L42) · [ancestor traversal](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L448-L481)

这证明了 configuration seam，但**没有让当前 SkillsPub Pi Adapter 继续保有 release-quality `managed` claim**。生产 Adapter 仍写错的 `!skills/**`、Project operation 仍写 Global file、inspection 仍会把被同一 pattern 排除的 Pi root 报成 consumed，而且 recovery 未暴露。Pi 必须暂时降为 `discoverable`/non-managed；只有实现下述改动，并在当时实际安装的 Pi 版本上完成一次新的 real-machine Global + Project apply、tools-enabled next-load、Relationship preservation 与 recovery 验证后，才可恢复 `managed`。[#109 resolution](https://github.com/AlligatorT/SkillsPub/issues/109#issuecomment-5532175662) · [current Adapter at accepted commit](https://github.com/AlligatorT/SkillsPub/blob/00529c5b918e73f39fb961a9550356578b0611e4/src/harnesses/pi.ts#L209-L274)

## 1. 官方 roots 与 trust boundary

Pi 0.84.4 的官方 Skill roots 是：

| Scope | Pi-specific | Shared |
| --- | --- | --- |
| Global | `~/.pi/agent/skills/` | `~/.agents/skills/` |
| Project | `.pi/skills/` | cwd 与 ancestor 的 `.agents/skills/` |

Project `.agents/skills` 向上扫描到 Git root；没有 Git repo 时到 filesystem root。`~/.pi/skills` 不是官方 Global root，`.pi/agent/skills` 也不是官方 Project root。[official Skills docs](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/docs/skills.md#L20-L42)

Project resources 只在 Project trusted 时加载。交互启动可读取保存于 `~/.pi/agent/trust.json` 的当前/parent decision；非交互模式在没有 decision 时由 Global `defaultProjectTrust` 决定，`ask`/`never` 都忽略 Project resources，`--approve`/`--no-approve` 可单次覆盖。[official trust docs](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/docs/settings.md#L12-L22)

源码对应行为是：untrusted 时不读取 `.pi/settings.json`，也不枚举 Project/ancestor `.agents/skills`; Global roots 仍照常解析。[SettingsManager](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/settings-manager.ts#L393-L408) · [auto-discovery trust gate](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L2397-L2451)

因此 Project inspect 不能无条件声称 `.pi/skills` 或 Project Shared 被消费：

- trusted：Project settings、Project Pi root 与全部 applicable Project/ancestor Shared roots一起生效；
- untrusted：三者都不生效；
- trust decision/extension/one-run override 无法从本地静态证据确定时：Project Effective Visibility 应为 `unknown`，不能猜。

## 2. `!skills/**` 为什么同时杀掉两个 Global roots

`DefaultPackageManager.addAutoDiscoveredResources` 用同一份 Global `skills` overrides 分别过滤两组文件，但换了各自的 base directory：

- `~/.pi/agent/skills/...` 相对于 `~/.pi/agent`；
- `~/.agents/skills/...` 相对于 `~/.agents`。

两者的相对 candidate 都是 `skills/<name>/SKILL.md`。`matchesAnyPattern` 同时尝试 relative path、basename、absolute path；对 Skill 还尝试 parent relative/name/absolute path。因此 `!skills/**` 在两次过滤里都成立。[auto-discovery source](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L2352-L2500) · [matching source](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L655-L729)

这正好解释 #109 的 valid tools-enabled observations：baseline 有 Pi-only `prototype` 与 Shared-only `agent-reach`/`composio-cli`；写入 `!skills/**` 后三者全部消失；恢复 Global settings/state 后三者全部回来。[#109 resolution](https://github.com/AlligatorT/SkillsPub/issues/109#issuecomment-5532175662) · local artifacts `pi-baseline-tools-enabled-output.json`, `pi-isolation-tools-enabled-output.json`, `pi-final-recovery-output.json`

当时 SkillsPub 的 false positive 来自自己的简化模型：`canonicalExclusion()` 生成 `!skills/**`，`sharedExcluded()` 只问 Shared root 是否命中，verify 也只要求 `sharedConsumption === excluded`；它从未用同一个 pattern 检查 Pi-specific root 是否同时被排除。[current source](https://github.com/AlligatorT/SkillsPub/blob/00529c5b918e73f39fb961a9550356578b0611e4/src/harnesses/pi.ts#L82-L105) · [plan/verify](https://github.com/AlligatorT/SkillsPub/blob/00529c5b918e73f39fb961a9550356578b0611e4/src/harnesses/pi.ts#L209-L274)

## 3. 为什么 absolute root glob 正确

对 `!/Users/wangyitao/.agents/skills/**`，Pi 会把 glob 与每个 discovered file 的 absolute lexical path（以及 Skill parent absolute path）比较：

- `/Users/wangyitao/.agents/skills/foo/SKILL.md`：匹配，disabled；
- `/Users/wangyitao/.pi/agent/skills/foo/SKILL.md`：不匹配，enabled；
- `/repo/.pi/skills/foo/SKILL.md`：不匹配，enabled。

匹配发生在 canonical-path dedupe **之前**。collector 会跟随 symlink directory，但保留入口的 lexical path；所以 `.pi/skills/foo -> ~/.agents/skills/foo` 仍以 `.pi/skills/foo/SKILL.md` 参与 override，不会因 target realpath 位于 Shared root 而被该 absolute glob 排除。之后 canonical dedupe 才把同一 source 的 Shared alias 去掉并保留 precedence 较高的 Pi Relationship。[symlink traversal](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L365-L442) · [sort/dedupe](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L2576-L2602)

配置必须使用展开后的 absolute path，不写 `~/.agents/...`。文档说 resource paths 支持 `~`，但 override matcher 对 `!` pattern 只做 slash normalization，没有调用 path/tilde expansion；0.84.4 的可证明写法因此是 absolute glob。[settings wording](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/docs/settings.md#L277-L292) · [matcher implementation](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L655-L706)

### Symlink 和 collision 的边界

- 同一个 canonical `SKILL.md` 经多个 symlink 被发现时静默 dedupe；不同 realpath 但同名时 warning，并保留第一个。[skill loader](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/skills.ts#L407-L447)
- precedence 是 Project settings entry → Project auto-discovery → Global settings entry → Global auto-discovery → package。相同 rank 内保持 discovery insertion order；Project `.pi/skills` 先于 cwd→ancestor `.agents/skills`，Global Pi root 先于 Global Shared root。[precedence](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L180-L192) · [discovery order](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L2417-L2500)
- absolute Shared exclusions 在 collision resolution 前移除 Shared candidates；Pi-specific Relationship 因此仍可获胜。
- package resources 使用各 package 自己的 filter，位于 auto-discovery 之外且 precedence 最低；top-level Shared-root exclusion 不会自动排除 package 提供的同名 Skill。inspect 仍须把 package 或 explicit settings path 视为可能的其他 contributing source。[package filtering](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/docs/packages.md#L190-L224)
- 显式 `--skill <path>` 是 additive，甚至能绕过 `--no-skills`；它属于用户单次 launch override，不是 persistent auto-discovery isolation 的承诺范围。[official Skills docs](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/docs/skills.md#L24-L42)

## 4. Arrays、glob、exact override 与 precedence

顶层 Global 与 Project resource arrays 的实际 loader 行为比普通“Project overrides Global”更具体：PackageManager 同时读取两个 scope，Global entries/patterns 只用于 Global roots，Project entries/patterns 只用于 Project roots；Project explicit resources precedence 更高，但不会自动抹掉不同的 Global resources。[resolve source](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L912-L963)

对每一个 auto-discovered candidate，override precedence 固定为：

1. `!glob` 排除；
2. `+path` exact force-include；
3. `-path` exact force-exclude（最终获胜）。

源码先按 prefix 分 bucket，再按上述顺序执行，所以 JSON array 中三类项目的文本顺序不改变 precedence。`+`/`-` 只 exact-match 一个 file 或一个 Skill parent directory；`-<shared-root>` **不会递归排除整个 root**，root isolation 必须使用 `!<absolute-root>/**`。[override source](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L683-L729) · [documented syntax](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/docs/settings.md#L277-L292)

现有 array 不能盲目替换：setup 应保留 unrelated plain paths/patterns，并拒绝或显式规划会破坏 isolation 的 `+<Shared skill>`，以及会继续抑制 Pi roots 的 broad `!skills/**`、`!**` 或 Pi-specific exact `-path`。

单个 `!**/.agents/skills/**` 在 0.84.4 matcher 中也能排除所有 Project/ancestor Shared lexical paths并保留 `.pi/skills`，isolated probe 已证实。但它会同时影响用户显式添加的任何其他 `.agents/skills` path；为满足 SkillsPub “Global 与 exact Project roots”而不扩大 ownership，Adapter 应生成 root-specific absolute patterns，而不是采用这个更宽的 shorthand。

## 5. Project/ancestor roots 的完整 contract

Pi 对 trusted Project 调用 `collectAncestorAgentsSkillDirs(cwd)`；有 Git 时在 repo root 停止，没有 Git 时到 filesystem root。Global `~/.agents/skills` 会从 Project list 中单独过滤，再由 Global settings 控制。[source](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L448-L481) · [scope split](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts#L2397-L2451)

所以 Project setup/reconcile 要按 Pi 相同算法生成**全部 applicable lexical roots**，包括目前不存在的 candidate directories；否则稍后新建 ancestor `.agents/skills` 会绕过 isolation。Project 移动、Git boundary 改变或 selected cwd 改变时，absolute patterns 可能过期，应报告 Drift 并由显式 reconcile 重算。

若某个 Shared root 或其 child 是 symlink，pattern 仍应针对 Pi 构造并扫描的 lexical root，而不是 `realpath` target；canonical target 只用于后续 dedupe。官方测试也覆盖了 ancestor boundary 以及 `~/.pi/agent/skills` 整体 symlink 到 `~/.agents/skills` 时的 canonical dedupe。[upstream tests](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/test/package-manager.test.ts#L388-L545)

## 6. 当前 SkillsPub `projectPath` mismatch

Accepted SkillsPub source 的 Pi default 已是正确的 `.pi/skills`。[Pi target definition](https://github.com/AlligatorT/SkillsPub/blob/00529c5b918e73f39fb961a9550356578b0611e4/src/harnesses/pi.ts#L277-L289) 但当前 real machine 的 `~/.config/skillspub/targets.json` 仍含迁移生成的 override：

```json
{"key":"pi","projectPath":".pi/agent/skills"}
```

Target registry 会把 override spread 到新的 built-in definition 上，因此 stale value 持续获胜；legacy migration 的设计又会把任何与当时 default 不同的 `projectPath` 永久保存为 override。[override resolution](https://github.com/AlligatorT/SkillsPub/blob/00529c5b918e73f39fb961a9550356578b0611e4/src/inventory.ts#L275-L299) · [legacy migration](https://github.com/AlligatorT/SkillsPub/blob/00529c5b918e73f39fb961a9550356578b0611e4/src/inventory.ts#L468-L497)

这解释了 #109 Project inspection 为什么报告 `/Users/wangyitao/Projects/SkillsPub/.pi/agent/skills`。该目录现在还有一个 Relationship：`git-guardrails-claude-code -> /Users/wangyitao/.agents/skills/git-guardrails-claude-code`；Pi 0.84.4 不消费这个 Project root。

后续实现必须用 previewed Target migration：

1. 删除 Pi override 中 obsolete `projectPath` 字段，使 built-in `.pi/skills` 重新成为 authority；
2. collision/precondition 检查后，把 `.pi/agent/skills` 中的现有 Relationships retarget 到 `.pi/skills`；
3. 记录原 registry、原路径/Link target 与 hash，verify 新 root，保留可执行 recovery；
4. 不把这个迁移伪装成普通 Shared isolation reconcile。

本文没有改动该 registry 或任一 real Target。

## 7. SkillsPub 必须改变什么

### setup

- Global setup 只写 `~/.pi/agent/settings.json`，把 owned `!skills/**` 安全替换为 expanded Global Shared absolute glob；保留 unrelated settings。
- Project setup 必须接收 canonical selected Project，写 `<project>/.pi/settings.json`，并写 exact + applicable ancestor absolute globs。当前 Project command 仍调用不含 `projectPath` 的 Global plan，#109 preview 也明确显示它准备写 Global file。[current operations](https://github.com/AlligatorT/SkillsPub/blob/00529c5b918e73f39fb961a9550356578b0611e4/src/harnesses/pi.ts#L252-L274) · local artifact `pi-project-setup-preview.json`
- 写前处理 trust、stale target override、contradictory `+/-/!` 与 glob metacharacter escaping；未知 schema 或 unknown ownership 保持零变更。

### inspect / Effective Visibility

- 用 Pi 0.84.4 的 matcher semantics 检查**每个 discovered Skill candidate/root**，不能只做少量字符串 equality。
- 同时报告 Global/Project Pi roots 和每个 Shared ancestor root 的 `consumed`/`excluded`；若 broad pattern 也排除 Pi root，Isolation 必须是 drift/invalid，不能是 `managed`。
- Project roots 受 trust gate；force-included Shared Skill、explicit settings/package/CLI bypass、同名不同 realpath collision 分别进入 partial/unknown/warning，而不是折叠成 root-level `excluded`。

### reconcile

- claim 从单个 `{file, exclusion}` 改为按 Global / canonical Project scope 保存 file、完整 root-pattern set 与 ownership。
- 每次重算 ancestor set、trust 与 canonical Target；移除的 owned broad pattern、增加的新 exact pattern、过期 absolute Project path 都进入同一 atomic preview/recheck/verify 流程。
- 用户原有的等价 root-specific pattern只视为 satisfied，不取得 ownership；用户原有的 broad harmful pattern需 blocker 或独立确认，不能静默删除。

### recovery

- #109 的 Pi apply result 返回 `recovery: []`，实际恢复依赖外部 fresh backup。生产操作必须在 apply 前保存原 Global/Project settings bytes、SkillsPub claim state，以及 Target migration 的 Relationship manifest；apply 后打印 restore path/commands并验证 byte/hash recovery。
- recovery 必须覆盖“替换 owned `!skills/**`”“Project settings write”“obsolete Target override/Relationship retarget”三类变更；不得删除 Shared source resource。

## 8. Isolated 0.84.4 probe

源码证明 matcher 后，研究在临时 `HOME`、临时 `agentDir` 与临时 Git workspace 中直接调用 0.84.4 `DefaultPackageManager.resolve()`；没有读取或写入真实 settings/roots。fixture 同时包含五类 roots和两个 Pi-root → Shared-source symlink Relationships。

| Scenario | Global Pi | Global Shared | Project Pi | Exact Project Shared | Ancestor Shared | Pi Relationships |
| --- | --- | --- | --- | --- | --- | --- |
| `!skills/**` | excluded | excluded | excluded | excluded | excluded | excluded |
| root-specific absolute globs | enabled | excluded | enabled | excluded | excluded | preserved |
| 只排 exact Project root | enabled | excluded | enabled | excluded | **enabled** | preserved |
| Shared `+skill` | enabled | **re-enabled** | enabled | excluded | excluded | preserved |
| 同 Skill 再加 `-skill` | enabled | excluded | enabled | excluded | excluded | preserved |
| Project untrusted | Global only | excluded | not discovered | not discovered | not discovered | Global preserved |

所有 assertions passed；重复执行仍通过。下面的 check 全部写入 `mktemp`，可直接重跑：

```bash
set -euo pipefail
work="$(mktemp -d)"
npm pack @earendil-works/pi-coding-agent@0.84.4 --pack-destination "$work"
tar -xzf "$work"/*.tgz -C "$work"
cd "$work/package"
npm install --ignore-scripts --omit=dev
cat > "$work/probe.mjs" <<'EOF'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = process.cwd();
const { DefaultPackageManager } = await import(
  pathToFileURL(path.join(pkg, 'dist/core/package-manager.js')),
);
const { SettingsManager } = await import(
  pathToFileURL(path.join(pkg, 'dist/core/settings-manager.js')),
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-0844-115-'));
const home = path.join(root, 'home');
const agentDir = path.join(home, '.pi', 'agent');
const repo = path.join(root, 'repo');
const project = path.join(repo, 'project');
process.env.HOME = home;
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

function skill(dir, name) {
  const file = path.join(dir, name, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${name}\n---\n`);
  return file;
}
const roots = {
  globalPi: path.join(agentDir, 'skills'),
  globalShared: path.join(home, '.agents', 'skills'),
  projectPi: path.join(project, '.pi', 'skills'),
  projectShared: path.join(project, '.agents', 'skills'),
  ancestorShared: path.join(repo, '.agents', 'skills'),
};
const files = Object.fromEntries(Object.entries(roots).map(([key, dir]) =>
  [key, skill(dir, key)]));
const linkedSource = skill(roots.globalShared, 'linked');
const linkedPi = path.join(roots.globalPi, 'linked', 'SKILL.md');
fs.symlinkSync(path.dirname(linkedSource), path.dirname(linkedPi), 'dir');

async function resolve(globalSkills, projectSkills, trusted = true) {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'settings.json'),
    JSON.stringify({ skills: globalSkills }));
  fs.writeFileSync(path.join(project, '.pi', 'settings.json'),
    JSON.stringify({ skills: projectSkills }));
  const settingsManager = SettingsManager.create(project, agentDir,
    { projectTrusted: trusted });
  return (await new DefaultPackageManager({ cwd: project, agentDir,
    settingsManager }).resolve()).skills;
}
const state = (rows, file) => rows.find((row) => row.path === file)?.enabled;
const broad = await resolve(['!skills/**'], ['!skills/**']);
assert.ok(broad.length && broad.every(({ enabled }) => !enabled));

const global = `!${roots.globalShared}/**`;
const exactProject = `!${roots.projectShared}/**`;
const ancestor = `!${roots.ancestorShared}/**`;
const exact = await resolve([global], [exactProject, ancestor]);
assert.equal(state(exact, files.globalPi), true);
assert.equal(state(exact, files.globalShared), false);
assert.equal(state(exact, files.projectPi), true);
assert.equal(state(exact, files.projectShared), false);
assert.equal(state(exact, files.ancestorShared), false);
assert.equal(state(exact, linkedPi), true);
assert.equal(exact.some(({ path: value }) => value === linkedSource), false);
assert.equal(state(await resolve([global], [exactProject]), files.ancestorShared), true);

const sharedDir = path.dirname(files.globalShared);
assert.equal(state(await resolve([global, `+${sharedDir}`],
  [exactProject, ancestor]), files.globalShared), true);
assert.equal(state(await resolve([global, `+${sharedDir}`, `-${sharedDir}`],
  [exactProject, ancestor]), files.globalShared), false);
const untrusted = await resolve([global], [exactProject, ancestor], false);
assert.equal(state(untrusted, files.globalPi), true);
assert.equal(state(untrusted, files.projectPi), undefined);
console.log('Pi 0.84.4 root-filter assertions passed');
fs.rmSync(root, { recursive: true, force: true });
EOF
node "$work/probe.mjs"
```

本次 npm tarball version 是 `0.84.4`，SHA-256 是 `5bce766d19c3ceba18f3fbaad91c449c9f9d73981f9e3400ecef932006f06968`，源码 tag commit 是 [`b79e4cc834970cca69daebffab7df1da7d1e52c4`](https://github.com/earendil-works/pi/tree/b79e4cc834970cca69daebffab7df1da7d1e52c4)。

## 9. Real-machine apply gate 与当前状态

Issue #109 的 tools-enabled baseline/apply/recovery 是有效的 failure evidence；`--no-tools` probes 明确无效。它证明旧 pattern 错、恢复成功，但没有验证本研究的新 absolute patterns、Project file、canonical `.pi/skills` Relationship 或新的 recovery UX。[#109](https://github.com/AlligatorT/SkillsPub/issues/109#issuecomment-5532175662) · local evidence `.acceptance/0002-v010-pi-grok-isolation/README.md`

因此：

1. **新的 real-machine apply 仍是恢复 `managed` 的必要条件。** 必须先 preview，再获明确 human approval，分别执行 Global 和 exact Project；用 tools-enabled fresh Pi 验证 Pi-only Relationships 保留、Global/Project/ancestor Shared-only Skills 消失，并实际恢复一次。
2. **在该 apply 之前，Pi 保持 non-managed（建议 `discoverable`）。** isolated loader proof 足以决定 implementation contract，不足以达到 #102 的 full-chain evidence bar。[parent map #102](https://github.com/AlligatorT/SkillsPub/issues/102)
3. 研究期间安装路径从最初观察到的 0.84.4 被外部更新为 0.85.0；本文改用 npm 0.84.4 tarball + exact tag 固定证据。两版 `dist/core/package-manager.js` byte-identical，`packages.md` identical，`settings.md`/`skills.md` 的差异与 Skill discovery/filtering 无关；但未来 apply 仍须按 apply 当时实际版本重新验证。

## 研究限制

- 没有改动真实 `~/.pi/agent/settings.json`、Global/Project Skill roots、Project `.pi/settings.json` 或 SkillsPub Targets，也没有运行任何 real `setup/reconcile --yes`。
- absolute patterns 是 lexical-path contract；跨机器 home/project path 与 Project move 必须由 setup/reconcile 重算，不能复制本机字符串。
- persistent isolation 不阻止用户显式 `--skill`、改变 trust 或手工添加 contradictory force-include；inspect 必须把这些边界写进 evidence。
- `!**/.agents/skills/**` 可工作但比 exact-root ownership 更宽，因此不是推荐配置。

## 主要来源

- [Pi v0.84.4 Skills documentation](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/docs/skills.md)
- [Pi v0.84.4 Settings documentation](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/docs/settings.md)
- [Pi v0.84.4 Packages documentation](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/docs/packages.md)
- [Pi v0.84.4 PackageManager source](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/package-manager.ts)
- [Pi v0.84.4 Skill loader source](https://github.com/earendil-works/pi/blob/b79e4cc834970cca69daebffab7df1da7d1e52c4/packages/coding-agent/src/core/skills.ts)
- [Issue #115 and evidence comment](https://github.com/AlligatorT/SkillsPub/issues/115)
- [Issue #109 resolution](https://github.com/AlligatorT/SkillsPub/issues/109#issuecomment-5532175662)
- [SkillsPub Pi Adapter at accepted commit](https://github.com/AlligatorT/SkillsPub/blob/00529c5b918e73f39fb961a9550356578b0611e4/src/harnesses/pi.ts)
