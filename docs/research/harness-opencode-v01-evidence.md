# Research: Can OpenCode qualify as a v0.1 Managed Harness?

## Summary

**Recommendation: `discoverable`, not `managed`, for v0.1.** OpenCode v1.18.8 has well-evidenced native Global/Project roots and also consumes Shared (`.agents/skills`) and Claude-compatible roots by default. The only complete upstream control over those external roots is a **process environment flag**; SkillsPub intentionally does not launch Harnesses, so it cannot persistently establish or verify isolation for every OpenCode entry point. That fails the repository's Managed Harness requirement to independently control and explain Effective visibility.

OpenCode is suitable for a read-only Discoverable Adapter pinned to v1.18.8 after real-machine fixtures confirm path, symlink, and duplicate-name behavior. It should remain out of the v0.1 **managed** set unless SkillsPub explicitly adds launcher/process-environment ownership or OpenCode adds a persistent, schema-backed exclusion mechanism.

## Scope and decision bar

Issue [Determine whether OpenCode can qualify as a v0.1 Managed Harness](https://github.com/AlligatorT/SkillsPub/issues/104) asks for identity/version, installation and detection, roots, schema, Shared/vendor consumption, precedence, isolation, next-load behavior, recovery, constraints, adoption, and real-product validation. Under [`docs/spec/harnesses.md`](../../docs/spec/harnesses.md), `managed` requires verified paths/config plus an Adapter that can independently control and explain Effective visibility; `required` or `unknown` Shared consumption prevents that. ADR-0013 limits the product proof to what a Harness should discover on its next load, not live process state ([ADR-0013](../../docs/adr/0013-effective-visibility-is-the-v0.1-product-proof.md)).

The upstream code baseline used below is the immutable first-party [v1.18.8 release](https://github.com/anomalyco/opencode/releases/tag/v1.18.8), published 2026-07-28. Its package declares version `1.18.8` and binary `opencode` ([pinned package.json](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/package.json)).

## Proven facts

### 1. Identity, version, installation, and detection

- **Identity/version:** the product is `anomalyco/opencode`; the pinned CLI package is version `1.18.8`, with executable name `opencode` ([release](https://github.com/anomalyco/opencode/releases/tag/v1.18.8), [package](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/package.json)).
- **Official installs:** OpenCode documents its install script, npm package `opencode-ai`, Homebrew tap, Arch packages, Chocolatey, Scoop, Mise, Docker, and release binaries ([official install docs](https://opencode.ai/docs/)). The pinned installer puts its binary at `$HOME/.opencode/bin/opencode`, recognizes Linux x64/arm64, macOS x64/arm64, and Windows x64, and checks an existing binary with `opencode --version` ([pinned installer](https://github.com/anomalyco/opencode/blob/v1.18.8/install)).
- **Safe detection contract:** locate `opencode` on `PATH`, then run `opencode --version`; `--version`/`-v` is an officially documented global flag ([CLI docs](https://opencode.ai/docs/cli/)). Detection must not infer installation merely from `~/.opencode` because that is also an installer/data location and does not prove an executable is usable.
- **No account needed for filesystem discovery evidence:** installation and root documentation do not require an OpenCode account. Actual model-backed use requires credentials for a chosen LLM provider; OpenCode documents provider API keys as a prerequisite and offers OpenCode Zen as only one option ([intro](https://opencode.ai/docs/)).

### 2. Global, Project, ancestor, Shared, and vendor roots

OpenCode officially documents six skill locations ([Agent Skills](https://opencode.ai/docs/skills/)):

| Classification | Root |
| --- | --- |
| OpenCode Global | `~/.config/opencode/skills/<name>/SKILL.md` |
| OpenCode Project | `.opencode/skills/<name>/SKILL.md` |
| Claude-compatible Global | `~/.claude/skills/<name>/SKILL.md` |
| Claude-compatible Project/ancestor | `.claude/skills/<name>/SKILL.md` |
| Shared/agent-compatible Global | `~/.agents/skills/<name>/SKILL.md` |
| Shared/agent-compatible Project/ancestor | `.agents/skills/<name>/SKILL.md` |

For project-local roots, OpenCode walks upward from the current working directory to the git worktree and loads matching roots along the path. It also loads all three Global roots ([skills discovery docs](https://opencode.ai/docs/skills/)). The pinned implementation confirms global `.claude`/`.agents`, upward project discovery, and OpenCode config directories; scans follow symlinks (`symlink: true`) ([pinned discovery source](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/src/skill/index.ts)).

**Adapter interpretation:** `.agents/skills` is the SkillsPub Shared Target; `.claude/skills` is vendor-compatible consumption, not an OpenCode-owned writable Target. Only `.opencode/skills` and `~/.config/opencode/skills` should be exposed as ordinary OpenCode Targets. Ancestor roots must be evidence inputs/read-only inherited projections, consistent with the project domain model.

### 3. Skill and config schemas

- A skill needs `SKILL.md` with YAML frontmatter. Officially recognized fields are `name`, `description`, optional `license`, `compatibility`, and string-to-string `metadata`; unknown fields are ignored. Names must match their containing directory, be 1–64 lowercase alphanumeric/hyphen characters, and descriptions must be 1–1024 characters ([Agent Skills](https://opencode.ai/docs/skills/)).
- OpenCode config accepts JSON and JSONC. Global config is under `~/.config/opencode/`; project config is `opencode.json` found from the current directory upward to the nearest git directory. The first-party schema URL is [`https://opencode.ai/config.json`](https://opencode.ai/config.json) ([config docs](https://opencode.ai/docs/config/)).
- v1.18.8's pinned config schema has `skills.paths` (additional filesystem roots) and `skills.urls` (remote skill sources), both arrays of strings ([pinned skills schema](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/core/src/v1/config/skills.ts)). These **add** roots; they do not replace or exclude the six defaults. Remote URL consumption is outside SkillsPub's ordinary Target ownership and must be reported as an external/unknown contributor if configured.
- Skill permissions are name-pattern based (`allow`, `ask`, `deny`), may be global or agent-specific, and `deny` hides matching skills. An agent can also disable the whole `skill` tool ([Agent Skills](https://opencode.ai/docs/skills/)). These controls address names/tool access, not source roots or resource identity, so they cannot safely isolate one same-name Variant from another.

### 4. Config precedence and duplicate-name precedence

- Config is merged rather than replaced. The documented low-to-high order is remote organization config, Global config, `OPENCODE_CONFIG`, Project config, `.opencode` directories, `OPENCODE_CONFIG_CONTENT`, system managed config, then macOS managed preferences ([config precedence](https://opencode.ai/docs/config/)). An Adapter inspecting permission or `skills.paths` must resolve every applicable layer, including managed layers it may not be able to modify.
- **No reliable skill-root precedence is proven.** Official troubleshooting says skill names should be unique across locations ([Agent Skills](https://opencode.ai/docs/skills/)). In pinned source, discovery gathers matches from multiple roots into a set, parses them concurrently with unbounded concurrency, warns on a duplicate, and assigns the later completing parse into a name-keyed record ([pinned source](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/src/skill/index.ts)). Therefore SkillsPub must report different-resource same-name visibility as `conflicted`, not invent a Global/Project/vendor winner.

### 5. Shared/vendor consumption and isolation/control

Pinned v1.18.8 source exposes these process flags ([runtime flags](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/src/effect/runtime-flags.ts), [discovery](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/src/skill/index.ts)):

- `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` (or broad `OPENCODE_DISABLE_CLAUDE_CODE=1`) suppresses `.claude/skills` only.
- `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` suppresses both `.claude/skills` and `.agents/skills`.
- Neither suppresses native OpenCode config-directory skills or additional `skills.paths`/`skills.urls`.

This yields the current consumption states:

- Shared `.agents/skills`: **`enabled` by default**, technically excludable only for a process via `OPENCODE_DISABLE_EXTERNAL_SKILLS`.
- Claude-compatible `.claude/skills`: **enabled by default**, excludable alone by the Claude flag or together with Shared by the external flag.
- Additional `skills.paths` and `skills.urls`: consumed when present in effective merged config and must be inspected as extra contributors.

**Managed blocker (severity: blocker):** SkillsPub does not own OpenCode process launch. An environment variable set in SkillsPub's own process cannot prove what the TUI, desktop app, IDE extension, `opencode run`, `serve`, ACP, or another shell will inherit. There is no v1.18.8 persistent config field that excludes default `.agents`/`.claude` roots. Consequently an Adapter cannot independently establish and verify isolation across entry points, and `hidden` cannot be guaranteed when a resource remains in Shared/vendor roots.

`permission.skill` is not a substitute: it denies by skill name across every root and agent scope, can be overridden/forced through config precedence, and cannot distinguish Variants. `tools.skill=false` disables all skills for an agent. Both introduce broader cross-skill behavior than a Relationship operation ([permissions docs](https://opencode.ai/docs/skills/)).

### 6. Next-load behavior

The pinned service initializes discovered matches and the name-keyed skill state through instance state, and exposes the resulting list/content to the `skill` tool ([pinned source](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/src/skill/index.ts)). Process flags are read through the runtime-flags service ([pinned flags](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/src/effect/runtime-flags.ts)). This proves a newly created OpenCode instance/process evaluates roots and flags; it does **not** prove that an already-running session immediately refreshes after filesystem/config changes.

SkillsPub should therefore claim only **next OpenCode load/new instance**, matching ADR-0013. Exact boundaries for TUI restart, attached clients, long-running `serve`, desktop backend reuse, and IDE integration remain real-machine validation items.

### 7. Backup and recovery

- A Discoverable Adapter needs no upstream config write, hence no OpenCode-config backup path.
- Native Target ON/OFF can use SkillsPub's existing Relationship/parking behavior; that protects only OpenCode-native roots. It cannot recover or neutralize contributing Shared/vendor entries.
- A future Managed implementation based on config or launcher ownership would need the repository-standard read/hash/plan/confirm/recheck/atomic-write/verify sequence and an owned backup/manifest. v1.18.8 provides no persistent isolation claim to back up or restore. Environment changes have no intrinsic file backup, and shell-profile/desktop-launch configuration ownership is unspecified.

### 8. Platform and account constraints

- The pinned official installer supports Linux x64/arm64, macOS x64/arm64, and Windows x64; the broader docs list native/package-manager paths for those platforms and note Windows Bun installation is still in progress ([installer](https://github.com/anomalyco/opencode/blob/v1.18.8/install), [install docs](https://opencode.ai/docs/)).
- Global paths use XDG-style `~/.config/opencode` in docs, but Windows path resolution and desktop sandbox/environment inheritance are not sufficiently established by the documentation for Adapter fixtures.
- Organization-authenticated remote config may add effective configuration and system/MDM managed config has highest precedence ([config docs](https://opencode.ai/docs/config/)). This can affect permissions and extra paths even though basic skill discovery itself is account-independent.

### 9. Primary-source adoption evidence

As of the research snapshot (2026-08-30), GitHub's first-party repository API reported **202,567 stars and 26,345 forks** for `anomalyco/opencode` ([GitHub repository API](https://api.github.com/repos/anomalyco/opencode)). The immutable v1.18.8 release includes CLI binaries and desktop assets across macOS/Linux/Windows families ([release assets](https://api.github.com/repos/anomalyco/opencode/releases/tags/v1.18.8)). These are strong adoption/distribution signals but do not lower the Managed evidence bar; counts are time-varying snapshots, not product semantics.

## Unknowns and blockers

1. **Blocker — no persistent root isolation:** no schema-backed setting excludes `.agents/skills`; only `OPENCODE_DISABLE_EXTERNAL_SKILLS` at process start does so.
2. **Blocker — no launch ownership:** SkillsPub has no launcher/wrapper and cannot verify environment inheritance across CLI, desktop, IDE, attached, or server entry points.
3. **Blocker — duplicate precedence:** no supported deterministic winning rule for same-name skills across roots; conflicts must remain `conflicted`.
4. **High — effective config completeness:** remote config, custom config, project/ancestor config, inline content, managed files, and macOS MDM may contribute `skills.paths`, `skills.urls`, permissions, or tool policy. A read-only Adapter must either resolve them all or return `unknown`.
5. **High — unverified installed product:** this research environment provided no executable/system-inspection tool, so no local `opencode` binary, config, environment, desktop installation, or actual skill-tool output was observed.
6. **Medium — symlink contract:** pinned implementation requests symlink following, but official user docs do not explicitly promise symlink compatibility across platforms and worktrees.
7. **Medium — refresh boundary:** source proves initialization behavior, not whether every long-running backend invalidates skill state after disk/config changes.
8. **Medium — Windows roots/environment:** exact home/config resolution, junction handling, and desktop environment inheritance need a Windows fixture.

## Exact real-machine validation required

Run these against an official **v1.18.8** binary first; repeat the discovery/isolation subset against the release chosen for shipping.

1. **Identity/detection:** record OS/architecture, install method, `command -v -a opencode` (or Windows `Get-Command -All opencode`), resolved executable realpath, checksum against the official release asset, and `opencode --version`. Confirm detection rejects stale/shadowed binaries and unsupported output.
2. **Hermetic roots:** with an isolated home and a temporary git worktree containing a nested working directory, create valid uniquely named canary skills in all six documented roots, plus `.opencode`/`.claude`/`.agents` ancestor roots at multiple levels. Start from the nested directory and capture the `skill` tool's available list and successful load location/content. Confirm traversal stops at the worktree boundary.
3. **Resource forms:** repeat native Global/Project canaries as real directories and symlinks; on Windows include junctions. Move each between discovery root and SkillsPub parking, start a fresh instance, and verify visible/not-visible without touching source resources.
4. **Isolation truth table:** launch fresh processes with (a) no flags, (b) `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`, (c) `OPENCODE_DISABLE_CLAUDE_CODE=1`, and (d) `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`. Verify exact contribution of `.opencode`, `.claude`, `.agents`, `skills.paths`, and `skills.urls`. Confirm flags must be present in the actual OpenCode process environment.
5. **Entry-point inheritance:** perform the isolation test through TUI, `opencode run`, `opencode serve` plus attached client, desktop app, and IDE extension. Record which launcher/environment each inherits. Any uncontrolled entry point confirms `discoverable` only.
6. **Config resolution:** construct non-conflicting and conflicting `permission.skill`, `agent.*.permission.skill`, `agent.*.tools.skill`, `skills.paths`, and `skills.urls` in Global, custom (`OPENCODE_CONFIG`), Project/ancestor, `.opencode`, inline (`OPENCODE_CONFIG_CONTENT`), system managed, and (macOS) MDM layers. Compare against `opencode debug config`; malformed/type-changed/unreadable/unknown layers must force read-only `unknown`.
7. **Duplicates:** place different-content same-frontmatter-name skills in every pair of roots and run at least 20 fresh processes. Capture warnings, list output, and loaded content. Do not encode any observed order unless upstream documents and tests it as a stable contract; Adapter output remains `conflicted` meanwhile.
8. **Validation failures:** test malformed YAML, missing/invalid names, directory/name mismatch, duplicate names, broken symlinks, unreadable directories, and additional remote URL failure. Record whether failures are omitted, warned, or fatal.
9. **Next-load boundary:** after initial listing, ON/OFF a canary while TUI and `serve` remain running; query again, then create a new session/client, then restart the backend. Define “next load” from observed instance boundaries and keep live-process claims out.
10. **Recovery/concurrency (only if management scope expands):** test config hash recheck, concurrent edit rejection, atomic write, semantic reread, backup restoration, unknown ownership preservation, and interrupted launcher/config changes. Until such an owned persistent mechanism exists, do not ship setup/reconcile for OpenCode.

## Recommendation

**Ship OpenCode as `discoverable` only, pinned to v1.18.8 evidence (or a newly pinned release after repeating fixtures).** Resolve its two native Targets and expose all Shared/vendor/additional roots as consumed-root evidence. Return Effective visibility `unknown` when process flags, effective merged config, remote URLs, managed layers, or same-name competition cannot be confirmed; return `conflicted` for different-resource same-name matches.

Do **not** add OpenCode to the v0.1 Managed Harness set. Reconsider only if one of these becomes true:

1. OpenCode adds a persistent, documented, schema-backed exclusion for default `.agents` and `.claude` roots that SkillsPub can safely plan/apply/verify; or
2. SkillsPub deliberately expands scope to own an OpenCode launcher for every supported entry point, with explicit environment, backup/recovery, and real-machine fixtures.

## Sources

- Kept: [OpenCode Agent Skills](https://opencode.ai/docs/skills/) — official roots, traversal, frontmatter, permissions, and uniqueness guidance.
- Kept: [OpenCode Config](https://opencode.ai/docs/config/) — official format, locations, precedence, schema, remote and managed layers.
- Kept: [OpenCode CLI](https://opencode.ai/docs/cli/) — official version detection, interfaces, and environment documentation.
- Kept: [OpenCode install/intro](https://opencode.ai/docs/) — official install, platforms, and provider prerequisites.
- Kept: [v1.18.8 release](https://github.com/anomalyco/opencode/releases/tag/v1.18.8) and [release API](https://api.github.com/repos/anomalyco/opencode/releases/tags/v1.18.8) — first-party immutable version/release assets.
- Kept: [v1.18.8 skill discovery source](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/src/skill/index.ts) — pinned consumed roots, traversal, symlink request, duplicate handling, and initialization.
- Kept: [v1.18.8 runtime flags](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/src/effect/runtime-flags.ts) — pinned isolation controls.
- Kept: [v1.18.8 skills schema](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/core/src/v1/config/skills.ts) — pinned additive paths/URLs schema.
- Kept: [v1.18.8 package](https://github.com/anomalyco/opencode/blob/v1.18.8/packages/opencode/package.json) and [installer](https://github.com/anomalyco/opencode/blob/v1.18.8/install) — first-party identity, binary, detection, and platform logic.
- Kept: [GitHub repository API](https://api.github.com/repos/anomalyco/opencode) — first-party time-stamped adoption snapshot.
- Dropped: community posts, third-party package indexes, search summaries, and user-reported issues — excluded by the primary-source-only requirement; issues were not needed to establish the recommendation.

## Gaps

No real installed-product execution was possible in this research runtime. The recommendation is therefore decisive against `managed` based on an architectural blocker, while `discoverable` remains conditional on the exact fixture plan above. No GitHub issue was mutated and no implementation code was changed.
