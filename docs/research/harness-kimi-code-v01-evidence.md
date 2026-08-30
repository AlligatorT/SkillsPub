# Research: Can Kimi Code qualify as a v0.1 Managed Harness?

## Summary

**Recommendation: `discoverable`, not `managed`, for v0.1.** Current Kimi Code has well-documented Global and Project Skill roots, deterministic precedence, a stable local config location, official schema validation, and symlink-following discovery, so a read-only Adapter can reliably inventory Targets. It cannot qualify as `managed` under `docs/spec/harnesses.md`: Kimi always consumes the generic user/project `.agents/skills` roots during automatic discovery, and the only supported replacement mechanism is the per-launch `--skills-dir` flag; SkillsPub explicitly does not own Harness launch.

The product identity has also changed since the older Kimi CLI evidence recorded in the repository baseline. The current first-party product is the TypeScript/Node package `@moonshot-ai/kimi-code` in `MoonshotAI/kimi-code`, not the legacy Python `MoonshotAI/kimi-cli` implementation.

## Recommendation

| Level | Recommendation | Reason |
|---|---|---|
| Managed | **No** | No persistent, officially supported exclusion/allowlist can stop automatic Shared (`.agents/skills`) consumption. `extra_skill_dirs` is additive; `merge_all_available_skills` does not exclude generic roots; `KIMI_CODE_HOME` deliberately leaves generic roots under the real OS home; `--skills-dir` is launch-scoped. |
| Discoverable | **Yes, after pinned-version fixtures and real-machine probes** | Official docs and source prove roots, project-root resolution, precedence, schema fields, and symlink behavior. |
| Out/unsupported | No | Evidence is sufficient for reliable read-only discovery; the isolation gap blocks `managed`, not discovery. |

## Findings

1. **Identity, version, and installation are first-party and detectable.** The current product is “Kimi Code CLI,” written in TypeScript, distributed as the public npm package `@moonshot-ai/kimi-code`, with `kimi` as its executable. Official installation is either the checksum-verifying native installer or global npm/pnpm; npm requires Node.js 22.19.0+. Detection should resolve `kimi` on `PATH`, run `kimi --version`, and distinguish this package from legacy `kimi-cli`. The latest first-party GitHub release observed during research was `@moonshot-ai/kimi-code@0.39.1`; the npm registry also reported `0.39.1` with repository provenance. [Getting started](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html) [Release 0.39.1](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%400.39.1) [npm package metadata](https://registry.npmjs.org/%40moonshot-ai%2Fkimi-code/latest)

2. **Local installed-product evidence exists, but executable validation was not run.** `/Users/wangyitao/.kimi-code/bin/kimi` is a native Mach-O/Node SEA binary. `/Users/wangyitao/.kimi-code/updates/install.json` records the last successful install as **0.38.0** at `2026-08-22T15:59:22.895Z`; `updates/latest.json` also records `0.38.0`. This is useful detection evidence, but `kimi --version` remains the authoritative real-machine check because update metadata can be stale or detached from the active binary.

3. **Global and Project roots are explicit and deterministic.** Automatic discovery scans, in order: Project brand `<project>/.kimi-code/skills`, Project Shared `<project>/.agents/skills`, Global brand `$KIMI_CODE_HOME/skills` (default `~/.kimi-code/skills`), Global Shared `~/.agents/skills`, configured Extra roots, plugin roots, then built-ins. The project root is the nearest upward `.git` ancestor, falling back to the working directory. The official user documentation summarizes scope precedence as **Project > User > Extra > Built-in**. [Agent Skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html) [Pinned discovery source](https://github.com/MoonshotAI/kimi-code/blob/cbe0a77f3d771a97b8e03f6048e14bd53d2f0258/packages/agent-core/src/skill/scanner.ts)

4. **Shared consumption is `required` under automatic discovery.** Kimi deliberately reads both `~/.agents/skills` and `<project>/.agents/skills`. `KIMI_CODE_HOME` relocates Kimi-specific data and `$KIMI_CODE_HOME/skills`, but the generic user root stays at the real OS home specifically for cross-tool sharing. No documented persistent config field disables automatic user/project generic roots. Therefore Shared consumption cannot be reported as `excluded`, and a Harness-specific Relationship being OFF cannot prove a Skill is hidden from Kimi. [Data locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html) [Agent Skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html)

5. **Config schema supports addition and merging, not isolation.** The active config is `$KIMI_CODE_HOME/config.toml` (default `~/.kimi-code/config.toml`), with snake_case disk keys. Relevant fields are `merge_all_available_skills: boolean` (default `true`), `extra_skill_dirs: string[]` (additive), and `builtin_product_skills: boolean` (default `true`, only controls Kimi product-help built-ins). `merge_all_available_skills` cannot remove the generic group; in current source each brand group has only one Kimi brand root, and generic roots are pushed independently. `kimi doctor config <candidate>` validates TOML and schema without modifying the file. [Configuration files](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html) [Config overrides](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/overrides.html) [Scanner source](https://github.com/MoonshotAI/kimi-code/blob/cbe0a77f3d771a97b8e03f6048e14bd53d2f0258/packages/agent-core/src/skill/scanner.ts) [kimi command](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)

6. **The current machine confirms the isolation blocker.** `/Users/wangyitao/.kimi-code/config.toml` exists and contains `merge_all_available_skills = false` and `extra_skill_dirs = []`. Even in that state, current source still independently adds Project and Global generic `.agents/skills` roots. Thus `merge_all_available_skills = false` is not a Shared isolation control. The file also contains many unrelated provider/hook settings, making unknown-ownership preservation mandatory for any future writer.

7. **`--skills-dir` is effective control but outside the v0.1 product boundary.** Official docs say repeatable `--skills-dir` replaces automatically discovered user and project roots for that launch only; CLI options outrank config and are discarded at exit. Source tests prove explicit roots suppress automatic user/project roots while Extra/plugin/built-in roots remain. This could support management only if SkillsPub became a launcher/wrapper or managed a durable external launch profile. ADR-0013 expressly avoids launching Harnesses, so v0.1 cannot depend on this flag. [Config overrides](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/overrides.html) [kimi command](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-command.md) [Scanner tests](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core/test/skill/scanner.test.ts)

8. **Precedence is proven and conflicts are explainable.** Discovery is first-wins. Within a scope, Kimi brand precedes generic; across scopes, Project precedes User, which precedes Extra/plugin/built-in. Names are normalized case-insensitively. Official tests prove that a three-scope collision resolves to the Project entry, explicit CLI roots beat Extra roots, directory-form `<name>/SKILL.md` beats flat `<name>.md`, and sibling traversal is sorted for determinism. A discoverable Adapter can therefore report the winning path for verified versions instead of marking every same-name case conflicted. [Registry source](https://github.com/MoonshotAI/kimi-code/blob/cbe0a77f3d771a97b8e03f6048e14bd53d2f0258/packages/agent-core/src/skill/registry.ts) [Scanner source](https://github.com/MoonshotAI/kimi-code/blob/cbe0a77f3d771a97b8e03f6048e14bd53d2f0258/packages/agent-core/src/skill/scanner.ts) [Scanner tests](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core/test/skill/scanner.test.ts)

9. **Links are usable for discovery, but pin the claim to verified versions.** Current scanner uses Node `fs.stat` (follows symlinks) and canonicalizes roots using `fs.realpath`; official tests prove a symlinked configured root is stored by real path and deduplicated with the same physical directory. A first-party engineering note also states Skill discovery uses `node:fs` directly and already follows symlinks. This supports `link` for a pinned Adapter fixture, but it is implementation evidence rather than a stable compatibility promise in end-user docs. [Scanner source](https://github.com/MoonshotAI/kimi-code/blob/cbe0a77f3d771a97b8e03f6048e14bd53d2f0258/packages/agent-core/src/skill/scanner.ts) [Scanner tests](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core/test/skill/scanner.test.ts) [Official PR #1843](https://github.com/MoonshotAI/kimi-code/pull/1843)

10. **Next-load behavior is session-oriented.** Official docs instruct users to start a new session after adding a Skill. Current source builds a per-session registry and also exposes a workspace-scoped listing that mirrors what a new session would scan. A config edit can be applied with `/reload`; otherwise the next new session loads it. SkillsPub should continue to describe “next-load visibility,” not the memory state of an already-running conversation. [Agent Skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html) [Workspace skill service](https://github.com/MoonshotAI/kimi-code/blob/cbe0a77f3d771a97b8e03f6048e14bd53d2f0258/packages/agent-core/src/services/skill/skill.ts) [Official config-edit workflow](https://github.com/MoonshotAI/kimi-code/commit/85338e9f7df5d98234fd42891e9bf2a2e6ad767b)

11. **Backup/recovery is documented, but no v0.1 write is justified.** Kimi’s own official `update-config` workflow copies the original to a candidate, edits only the target key, validates with `kimi doctor`, creates a unique timestamped `.bak`, then replaces the original; recovery uses the latest backup. A future writer must additionally perform SkillsPub’s hash/re-read/concurrent-change checks and preserve unknown fields/comments. For the proposed `discoverable` Adapter, remain read-only and avoid backup complexity entirely. [Official update-config commit](https://github.com/MoonshotAI/kimi-code/commit/85338e9f7df5d98234fd42891e9bf2a2e6ad767b)

12. **Account and platform constraints do not block discovery.** Native releases exist for macOS, Linux, and Windows on arm64/x64; Windows requires Git for Windows for its shell. OAuth or a Kimi Platform API key is required to run model tasks, but filesystem inventory and `kimi doctor` do not require proving account entitlement. Keep authentication state out of Adapter evidence. [Getting started](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html) [Release assets](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%400.39.1)

13. **Primary-source adoption evidence is strong enough to prioritize discovery, not to relax correctness.** At collection time, the official GitHub API reported 7,157 stars and 1,141 forks; the npm downloads API reported 138,553 downloads for `@moonshot-ai/kimi-code` in the prior month. These are mutable popularity signals, not unique active-user counts. [GitHub repository API](https://api.github.com/repos/MoonshotAI/kimi-code) [npm downloads API](https://api.npmjs.org/downloads/point/last-month/%40moonshot-ai%2Fkimi-code)

## Proven facts vs unknowns

### Proven

- Current identity: `MoonshotAI/kimi-code`, package `@moonshot-ai/kimi-code`, executable `kimi`.
- Automatic brand and generic Global/Project roots and nearest-`.git` project-root rule.
- First-wins precedence and deterministic collision behavior on current source/tests.
- `extra_skill_dirs` is additive; `--skills-dir` is launch-only replacement.
- `KIMI_CODE_HOME` does not relocate `~/.agents/skills`.
- Current implementation follows/canonicalizes symlinked Skill roots.
- Local machine has a native Kimi binary and update metadata for 0.38.0.

### Unknown / not proven in this run

- The active binary’s actual `kimi --version` output and whether update metadata matches it.
- End-to-end behavior of version 0.38.0 for every root, collision, symlink, reload, and `--skills-dir` case.
- Whether the shell environment sets `KIMI_CODE_HOME`, `KIMI_CODE_LEGACY_FLAG`, or startup flags that change effective roots/engine.
- Whether a stable first-party command/API lists effective roots (the workspace listing returns skills, not necessarily absent roots).
- Long-term symlink compatibility commitment; current evidence is implementation/test based.
- The complete private GitHub issue #105 body/comments: the unauthenticated repository URL returned 404 and no authenticated fetch profile was available.

## Exact real-machine validation required

Run these without modifying the user’s live Skills. Use a temporary project and temporary `KIMI_CODE_HOME`; preserve the real OS `~/.agents/skills` by using uniquely named probe skills and remove only the probes afterward.

1. **Identity/detection:** capture `command -v kimi`, resolved real path, file type, `kimi --version`, install method if inferable, `KIMI_CODE_HOME`, `KIMI_CODE_LEGACY_FLAG`, and relevant process startup arguments. Confirm version against a pinned official release.
2. **Schema:** copy the live config to a temp candidate and run `kimi doctor config <candidate>`; test accepted types for `merge_all_available_skills`, `extra_skill_dirs`, and `builtin_product_skills`; do not edit live config.
3. **Root matrix:** create unique valid probe Skills in temp equivalents of Kimi Global, Global Shared, Project brand, Project Shared, and Extra. Start a fresh session/workspace listing and verify all expected paths and scopes.
4. **Project root:** launch from a nested subdirectory below a `.git` marker and verify roots resolve at the nearest repository root; separately verify no-`.git` fallback to workdir.
5. **Precedence:** create same-name probes with distinct descriptions in every root and verify winner order: Project brand > Project Shared > Global brand > Global Shared > Extra > plugin/built-in where applicable.
6. **Isolation negative proof:** with `merge_all_available_skills=false` and no extras, verify Shared probes remain visible. Set a separate `KIMI_CODE_HOME` and verify the Kimi Global probe moves while the real-home Shared probe remains visible.
7. **Launch override:** run both interactive and `-p` fresh sessions with repeatable `--skills-dir`; verify automatic Project/Global roots are absent and explicit roots win, while Extra/plugin/built-in behavior matches the pinned source. This demonstrates why a launcher would be required.
8. **Links:** test a symlinked Skill entry and a symlinked explicit/Extra root; verify discovery, canonical path, auxiliary-file access, and broken-link reporting. If any surface diverges, set effective Link capability to unsupported and use Mirror only after a separate design.
9. **Next-load:** add/remove a probe after a session starts; compare current session, `/reload`, `/new`, and a new process. Record only the “next new session/process” contract unless stronger behavior is stable.
10. **Recovery drill (only if a future managed writer exists):** candidate copy → targeted edit → `kimi doctor` → timestamped backup → atomic replace → `/reload` → semantic verify → restore backup and re-verify. Also simulate a concurrent hash change and malformed TOML; both must produce zero mutation.

## Blockers to `managed`

- **blocker (high): Shared roots are mandatory under persistent automatic discovery.** No official persistent exclusion/allowlist for `~/.agents/skills` or `<project>/.agents/skills` was found.
- **blocker (high): the only isolation control is launch-scoped.** `--skills-dir` requires SkillsPub to own or wrap process startup, outside ADR-0013/v0.1.
- **blocker (medium): installed 0.38.0 has not received executable end-to-end probes.** Source/docs were evaluated mostly at pinned current commit `cbe0a77f...` and release 0.39.1.
- **blocker (medium): current config contains extensive unrelated, externally managed hooks/settings.** Any future write requires strict ownership, exact preservation, concurrency guards, backup, validation, and recovery.
- **blocker (process): full private issue #105 content was not retrievable in this tool environment.** The title and repository requirements were available, but issue comments/acceptance detail could not be independently verified.

## Sources

- Kept: [Official Agent Skills docs](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html) — authoritative roots, scopes, format, precedence, next-session behavior.
- Kept: [Pinned scanner source](https://github.com/MoonshotAI/kimi-code/blob/cbe0a77f3d771a97b8e03f6048e14bd53d2f0258/packages/agent-core/src/skill/scanner.ts) — exact root resolution, realpath, ordering, and first-wins discovery implementation.
- Kept: [Official scanner tests](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core/test/skill/scanner.test.ts) — first-party executable evidence for root order, collisions, explicit override, and symlink canonicalization.
- Kept: [Official config/data/CLI docs](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/overrides.html) — config/CLI semantics and product boundary.
- Kept: [Official release and registry evidence](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%400.39.1) — version, platforms, checksums, package identity.
- Kept: local installed files under `/Users/wangyitao/.kimi-code/` — real-machine install/config evidence; secrets/credential files were not read.
- Dropped: third-party Kimi plugins, integration guides, benchmark posts, mirrors, and reverse-engineered runtime notes — excluded by the primary-source-only requirement.
- Dropped: legacy `MoonshotAI/kimi-cli` behavior as qualification evidence — it is a different Python product generation with different roots/config semantics.

## Gaps

The recommendation is confident because the managed blocker is documented and reproduced in current source semantics. Promotion beyond `discoverable` needs an official persistent root exclusion/allowlist or an explicit product decision to add launcher ownership; more filesystem probes alone cannot remove that architectural blocker.
