# Research: Can Codex qualify as a v0.1 Managed Harness?

Research date: 2026-08-30  
Issue: [Determine whether Codex can qualify as a v0.1 Managed Harness](https://github.com/AlligatorT/SkillsPub/issues/103)  
Evidence baseline: OpenAI Codex CLI `0.151.0`, tag `rust-v0.151.0`, commit `78c290807ce710180111df227df3b7a4fe845452`.

## Summary

**Recommendation: `discoverable`, not `managed`, for v0.1 unless the real-machine matrix below passes and a safe configuration-ownership/restore design is approved.** Codex has strong official evidence for deterministic discovery roots, symlink support, automatic skill-change detection, and a path-addressed enable/disable mechanism. The remaining gap is the full managed chain: release `0.151.0` source limits `skills.config` rules to user and session layers, the native global/project roots are the shared `.agents/skills` roots themselves, duplicate names intentionally coexist, and no real installed-product validation was available in this research run.

Codex is therefore straightforward to detect and inventory, but SkillsPub cannot yet claim that it can independently control and explain every contributing root on a real machine without first proving config mutation, canonical path behavior, live reload/restart behavior, duplicate-name conflicts, and recovery.

## Findings

1. **Identity and pinned version are proven.** The product is OpenAI Codex CLI from the first-party `openai/codex` repository. Stable release `0.151.0` was published 2026-08-29; its annotated tag points to commit `78c290807ce710180111df227df3b7a4fe845452`. Official distribution includes standalone installers, npm package `@openai/codex`, Homebrew, and release binaries. [Release](https://github.com/openai/codex/releases/tag/rust-v0.151.0) · [tag API](https://api.github.com/repos/openai/codex/git/tags/d8673cb68e349c208659b986697773d3145dbb14) · [official repository](https://github.com/openai/codex)

2. **Installation is broad; detection should be executable plus exact version.** Official instructions install with the macOS/Linux shell installer, Windows PowerShell installer, `npm install -g @openai/codex`, `brew install --cask codex`, or a release artifact. A future adapter should detect `codex` on `PATH`, record the resolved executable path, and parse `codex --version`; filesystem residue under `~/.codex` alone is insufficient proof that the harness is installed. [Official repository quickstart](https://github.com/openai/codex#installing-and-running-codex-cli) · [CLI docs](https://developers.openai.com/codex/cli)

3. **The documented user/global and repository roots are shared-standard roots.** Codex reads user skills from `$HOME/.agents/skills`. In a repository it scans `.agents/skills` in every directory from the project root through the launch CWD. It also reads admin skills from `/etc/codex/skills` and OpenAI-bundled system skills. [Agent Skills docs](https://developers.openai.com/codex/skills) · [pinned root resolver](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/ext/skills/src/host_roots.rs)

4. **Pinned source exposes additional consumed roots that the concise docs do not fully foreground.** At `0.151.0`, user config contributes deprecated `$CODEX_HOME/skills` (normally `~/.codex/skills`), `$HOME/.agents/skills`, and the system cache; project configuration folders contribute `<config-folder>/skills`; plugin roots and explicit extra roots are appended; `/etc/codex/skills` is admin scope. Roots are deduplicated by path. These plugin/system/extra roots are external ownership and must not be treated as ordinary writable Skill Targets. [Pinned root resolver](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/ext/skills/src/host_roots.rs)

5. **Shared consumption is `required` unless per-skill config is accepted as isolation.** `$HOME/.agents/skills` and repository/ancestor `.agents/skills` are native Codex discovery roots; there is no documented root-level exclusion switch. `[[skills.config]]` can disable a selected skill, but that is a per-skill visibility claim, not exclusion of the Shared Target. Under the current SkillsPub definition, Codex consumes Shared by design; a managed adapter would have to own verified per-skill overrides for every affected path rather than isolate the root once. [Agent Skills docs](https://developers.openai.com/codex/skills) · [SkillsPub harness contract](../../docs/spec/harnesses.md)

6. **The config schema is narrow but has an important layer constraint.** `SkillConfig` has optional absolute `path`, optional `name`, and required boolean `enabled`; unknown fields are denied. Exactly one selector is meaningful. Paths are canonicalized when possible. Later matching rules override earlier rules. Crucially, release source resolves skill enablement rules only from `User` and `SessionFlags` layers—not project, system, MDM, or enterprise-managed layers. Thus writing `.codex/config.toml` in a project is not a proven control operation for skill enablement even though general project config exists. [Pinned schema and resolver](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/config/src/skills_config.rs) · [general config precedence](https://developers.openai.com/codex/config-basic) · [config sample](https://developers.openai.com/codex/config-sample)

7. **General config precedence must not be mistaken for skill-rule precedence.** General configuration precedence is CLI/session overrides, trusted project layers from root to CWD, selected profile, user config, system config, then defaults. For `skills.config`, pinned source narrows effective rules to user and session layers. An adapter must inspect `~/.codex/config.toml` plus active session overrides when evidence is available, preserve entry order, and block rather than guess when a name rule overlaps a managed path rule. [Config basics](https://developers.openai.com/codex/config-basic) · [pinned skill config source](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/config/src/skills_config.rs)

8. **Duplicate-name behavior prevents a guessed winner.** Official docs state that if two skills share the same frontmatter `name`, Codex does not merge them and both can appear in selectors. SkillsPub must therefore report different same-name resources as `conflicted`; it must not invent project-over-user precedence. A name selector can affect every discovered skill with that name, while a path selector addresses a canonical document path. [Agent Skills docs](https://developers.openai.com/codex/skills) · [pinned skill config source](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/config/src/skills_config.rs)

9. **Symlinks are officially supported, but canonical-path control needs validation.** Codex officially follows symlinked skill folders. Because path selectors are canonicalized when possible, a Shared source and a Codex-specific symlink to that source may collapse to the same config identity. SkillsPub should not claim that a symlink creates an independently controllable Codex relationship until the matrix below proves it; a managed mirror may be necessary, but that would require separate product validation. [Agent Skills docs](https://developers.openai.com/codex/skills) · [pinned skill config source](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/config/src/skills_config.rs)

10. **Next-load behavior is documented, but two paths differ.** Codex detects skill filesystem changes automatically; if an update does not appear, official guidance is to restart. After changing `~/.codex/config.toml`, the docs explicitly say to restart Codex. Effective Visibility may therefore promise only the next fresh Codex load after config changes, not mutation of an already-running session. [Agent Skills docs](https://developers.openai.com/codex/skills)

11. **A safe managed operation requires explicit backup and recovery owned by SkillsPub.** OpenAI documents the config location but does not provide a skill-config transaction/rollback command. Any SkillsPub setup/reconcile must follow the repository contract: read and hash `~/.codex/config.toml`, validate TOML and exact `skills.config` types, show the complete semantic plan, recheck the hash, atomically write, reread and verify, and retain a versioned original plus ownership manifest. Recovery is restoring the exact backup atomically and restarting Codex. Unknown existing entries remain user-owned and are never removed. [Config basics](https://developers.openai.com/codex/config-basic) · [SkillsPub harness contract](../../docs/spec/harnesses.md)

12. **Account/platform constraints do not block local discovery, but do affect product access.** Local CLI/IDE/desktop work supports ChatGPT or API-key authentication. ChatGPT sign-in inherits workspace access and controls; API-key use is billed through the Platform account and some cloud/workspace features may be unavailable. Official binaries/installers cover macOS, Linux, and Windows; the current repository documents native Windows installation as well as platform release assets. These constraints belong in detection evidence/warnings, not target identity. [Authentication](https://developers.openai.com/codex/auth) · [official repository](https://github.com/openai/codex)

13. **Primary-source adoption evidence is strong but not a correctness substitute.** As of the research date, the official GitHub API reported about 120,068 stars, 18,345 forks, and 614 subscribers for `openai/codex`. This supports user relevance, but does not lower the full-chain evidence bar. [Official GitHub repository API](https://api.github.com/repos/openai/codex)

## Proven facts versus unknowns

### Proven

- Product/repository identity, stable release `0.151.0`, and pinned commit.
- Official installation channels and a stable CLI executable name.
- User Shared root, repository/ancestor Shared roots, admin root, bundled system skills, legacy `$CODEX_HOME/skills`, project config-folder skill roots, and plugin/extra-root participation in pinned source.
- Symlinked skill folders are followed.
- Duplicate names coexist; there is no documented winner to encode.
- `skills.config` supports `path` or `name` plus `enabled`; path rules canonicalize where possible; later matching rules override earlier rules.
- At the pinned release, enablement rules are read only from user and session layers.
- Filesystem skill changes are auto-detected with restart fallback; config changes require restart.

### Unknown / unproven

- Exact installed Codex identity/version on the target machine; no local shell/product access was available in this run.
- Whether every SkillsPub-supported client surface (CLI, IDE extension, desktop app) uses identical root and config semantics at `0.151.0`.
- Whether a path-disabled skill is absent from `/skills`, `$` mention, implicit invocation, and the initial prompt catalog in all surfaces.
- Whether canonicalization of a symlinked `SKILL.md` always makes source and link share one config identity on macOS, Linux, and Windows.
- Whether config parse/type errors fail closed or silently leave affected skills enabled in the user-visible product path.
- Whether session `-c` overrides are observable by a separately running SkillsPub process; if not, Effective Visibility must be `unknown` for such sessions.
- Whether remote/plugin-provided, bundled, admin, and system skills can be fully enumerated through a stable local interface.
- A first-party global root-level exclusion mechanism for `.agents/skills`; none was found.
- A first-party backup or rollback operation for skill config; SkillsPub must supply its own safe transaction.

## Exact real-machine validation required

Run against a clean fixture account/home and pinned Codex CLI `0.151.0` on macOS and Linux; add native Windows if v0.1 claims it. Record executable path, installer provenance, `codex --version`, OS/architecture, `HOME`, `CODEX_HOME`, resolved repository root, CWD, config hashes, and full before/after `/skills` or equivalent machine-readable evidence.

1. **Detection:** install through at least standalone and npm channels; prove executable resolution and version parsing, including multiple `codex` binaries on `PATH` and a stale `~/.codex` without an executable.
2. **Root matrix:** create uniquely named sentinel skills in `$HOME/.agents/skills`, `$CODEX_HOME/skills`, `/etc/codex/skills` where permitted, repo root `.agents/skills`, an ancestor between repo root and CWD, CWD `.agents/skills`, and a trusted `.codex/skills`. Start from repo root and nested CWD; verify the exact discovered set.
3. **Trust:** repeat with the project untrusted; distinguish `.codex/skills`/project config effects from `.agents/skills` filesystem discovery.
4. **Link behavior:** test directory symlink, `SKILL.md` symlink, broken link, out-of-root target, relative link, and a link into `$HOME/.agents/skills`. Record displayed and canonical paths.
5. **Path control:** put `enabled=false` for each absolute `SKILL.md` path in `~/.codex/config.toml`; restart; prove absence from explicit selector, initial catalog, and implicit use. Re-enable and prove return.
6. **Canonical collision:** place one source in Shared and symlink it into `$CODEX_HOME/skills`; disable source path and link path separately. If they cannot be controlled independently, Links cannot support a managed Codex-specific target.
7. **Name control/conflict:** create two different resources with the same frontmatter name in user and repo roots. Prove both appear, prove a name rule affects both, prove a path rule affects only one, and record rule-order behavior.
8. **Layer behavior:** place identical `skills.config` rules separately in system, user, profile, trusted project, nested project, and CLI `-c` layers. Confirm the pinned-source claim that only user/session rules affect enablement. Determine whether SkillsPub can detect active session overrides; otherwise mark active-session visibility unknown.
9. **Malformed/unknown schema:** test wrong `config` type, missing `enabled`, both/neither selector, relative `path`, unknown field, invalid TOML, and concurrent edit. Confirm an adapter can detect and block before writing without changing effective state.
10. **Next load:** while Codex is running, add/remove/edit a skill and separately edit config. Determine which surfaces refresh automatically and prove that a fresh process always reflects disk/config state.
11. **Transaction/recovery:** exercise inspect → plan → concurrent-hash check → atomic write → semantic reread. Kill between stages, restore the versioned backup, restart Codex, and prove the original visible set returns byte-for-byte and semantically.
12. **External roots:** inventory bundled, plugin, admin, and any explicit extra roots. Verify they are reported as external ownership and that hidden plans block when a same-name external resource remains visible.
13. **Cross-platform paths:** repeat canonicalization and atomic replace on case-sensitive Linux, default macOS filesystem, and Windows path/junction semantics if supported.

## Decision

### Recommendation: `discoverable`

Codex meets the evidence bar for a built-in discoverable adapter: detection/version, root resolution, scope, and symlink capability are documented and pinned in first-party source. It does **not yet meet SkillsPub's `managed` bar** because no real-machine chain was executed, Shared is a required native root rather than cleanly excludable, user/session-only override semantics complicate project control, and canonical symlink identity plus external/session roots can defeat an apparently hidden state.

Promotion to `managed` is reasonable only after all mandatory matrix cases pass and the adapter design:

- models Shared consumption as required unless path overrides provably provide complete per-resource control;
- writes only an owned, exact-path rule in user config and blocks overlapping user name rules/session overrides;
- treats duplicates as `conflicted`, never chooses a winner;
- excludes bundled/plugin/admin/system resources from writable inventory while including them in visibility evidence;
- uses Mirror rather than Link wherever canonicalization prevents independent control;
- implements hash-checked atomic config writes, versioned backup, ownership manifest, semantic verification, and documented manual restore;
- returns `unknown` whenever version/schema/config/session/external-root evidence is incomplete.

## Sources

### Kept

- [OpenAI Codex Agent Skills documentation](https://developers.openai.com/codex/skills) — official discovery, duplicates, symlinks, config, and reload behavior.
- [OpenAI Codex configuration basics](https://developers.openai.com/codex/config-basic) — official config locations, trust, and general precedence.
- [OpenAI Codex config sample](https://developers.openai.com/codex/config-sample) — official `[[skills.config]]` sample.
- [OpenAI Codex authentication](https://developers.openai.com/codex/auth) — official account and auth constraints.
- [OpenAI Codex CLI](https://developers.openai.com/codex/cli) and [official repository](https://github.com/openai/codex) — official product/install identity.
- [Codex `0.151.0` release](https://github.com/openai/codex/releases/tag/rust-v0.151.0) and [tag object](https://api.github.com/repos/openai/codex/git/tags/d8673cb68e349c208659b986697773d3145dbb14) — first-party release/version pin.
- [Pinned `host_roots.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/ext/skills/src/host_roots.rs) — exact consumed roots and deduplication.
- [Pinned `skills_config.rs`](https://github.com/openai/codex/blob/rust-v0.151.0/codex-rs/config/src/skills_config.rs) — exact schema, layer filtering, canonicalization, and rule precedence.
- [Official repository API](https://api.github.com/repos/openai/codex) — first-party adoption snapshot.
- Local [CONTEXT.md](../../CONTEXT.md), [harness specification](../../docs/spec/harnesses.md), and [ADR-0013](../../docs/adr/0013-effective-visibility-is-the-v0.1-product-proof.md) — authoritative project acceptance bar.

### Dropped

- Search-result summaries, third-party compatibility notes, archived documentation mirrors, blog posts, and community handbooks — not primary sources.
- OpenAI Codex issue reports — first-party-hosted but reporter claims are not product documentation or validated source behavior; unnecessary where release source and docs answer the question.
- Unpinned `main` source claims — replaced with release-tagged `0.151.0` source.

## Gaps

The central gap is local installed-product evidence. This environment exposed file reading and web research but no command runner, so it could not execute Codex, inspect the target machine, mutate a disposable config, run tests, inspect Git status, write the requested repository note, or create a commit. The complete note is therefore stored at the runtime-authoritative artifact path for the parent to apply as `docs/research/harness-codex-v01-evidence.md`, validate, and commit.
