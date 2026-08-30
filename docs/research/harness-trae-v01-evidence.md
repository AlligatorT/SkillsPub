# Research: Can Trae qualify as a v0.1 Managed Harness?

## Summary

**Recommendation: `discoverable`, and therefore out of the v0.1 Managed Harness set.** International **TraeCode** has official Agent Skills support, documented native Global and Project roots, opt-in Project `.agents/skills` consumption, and one documented collision rule. It does **not** yet meet SkillsPub's `managed` bar because the official sources do not document a machine-readable schema/location for the Shared-root toggle or global disable state, complete consumed-root/precedence behavior, symlink behavior, reload timing, or recovery; no installed TraeCode was available here for real-machine validation.

This answers the requirements in issue #107 as supplied in an authenticated export by the supervisor; this research run did not itself obtain authenticated GitHub issue access. The issue asks for exact product/version, detection, roots, schema, Shared/vendor consumption, precedence, isolation, next-load behavior, recovery, constraints, adoption evidence, and real-product validation.

## Decision against the SkillsPub bar

The repository defines `managed` as independently controlling and explaining Effective visibility through verified consumed-root, configuration, isolation, and version evidence; `discoverable` means roots can be reliably resolved and scanned but Effective visibility cannot be guaranteed (../spec/harnesses.md), [ADR-0013](../adr/0013-effective-visibility-is-the-v0.1-product-proof.md)). TraeCode clears the root-discovery bar but not the full-chain Effective Visibility bar.

| Requirement | Proven fact | Unknown/blocker | Consequence |
| --- | --- | --- | --- |
| Exact product | The evidence is for the international desktop IDE now documented as **TraeCode**, not TraeWork, TraeCode Plugin, the open-source `bytedance/trae-agent` CLI, or a China-region build. The official download page separates TraeCode and TraeWork ([Download Center](https://www.trae.ai/download)); the official GitHub repository only identifies itself as TRAE official and does not publish IDE source ([Trae-AI/TRAE](https://github.com/Trae-AI/TRAE)). | Product bundle IDs, executable names, command-line version output, and China/international coexistence are not documented. | Adapter detection cannot yet be fixture-backed. |
| Version | The official changelog records TraeCode **v3.5.89–3.5.91** on 2026-08-19; the Skills page itself was published/updated in August 2026 and is therefore evidence compatible with that release line ([Changelog](https://docs.trae.ai/ide/changelog?_lang=en), [Skills](https://docs.trae.ai/ide/skills)). | The first version containing every currently documented Skills behavior is not established by the English changelog. | Pin a candidate validation baseline to international TraeCode 3.5.91, but do not claim older-version support. |
| Install/platform | Official setup supports macOS 12+ (Apple Silicon and Intel), Windows 10/11 x64, and specified Linux x64/ARM64 distributions; installation is by official package download. Setup includes login ([Quickstart](https://docs.trae.ai/ide/set-up-trae?_lang=en), [Download Center](https://www.trae.ai/download)). | Silent installers, stable application identifiers, and portable installs are undocumented. | Detect only after real-machine inventory establishes stable identifiers. |
| Agent Skills | Skills are directories centered on `SKILL.md`; TraeCode first scans brief descriptions, then loads full skill content on demand when relevant. Skills can also be invoked manually ([Skills](https://docs.trae.ai/ide/skills)). | Complete parser constraints, malformed-skill behavior, recursive depth, symlink behavior, and refresh timing are undocumented. | The format is supported, but link/mirror capability is unknown. |
| Native roots | Project: `<project>/.trae/skills/`. Global: `~/.trae/skills` on macOS/Linux and `%userprofile%/.trae/skills` on Windows ([Skills](https://docs.trae.ai/ide/skills)). | Ancestor traversal, multi-root workspaces, Remote SSH/WSL root ownership, and profile-specific homes are undocumented. | These two roots are safe `discoverable` Target definitions only for the exact project/home. |
| Config schema | Disabling a project skill creates `<project>/.trae/skill-config.json`, described as listing disabled project skills ([Skills](https://docs.trae.ai/ide/skills)). | The JSON shape, versioning, unknown-field policy, atomicity, and malformed-file behavior are not documented. Disabled global skills explicitly do **not** appear there; their state location/schema is unknown. | No safe config writer or complete inspector can be designed from official evidence alone. |
| Shared/vendor consumption | Project `.agents/skills/` is officially supported as an Agent Skills convention. The user must enable it at **Settings → Skills & Commands → Import Settings → Enable .agents Skills Directory**; at runtime the agent can discover/load skills in the project directory ([Skills](https://docs.trae.ai/ide/skills)). | The toggle's default, persistence file/key, scope, remote behavior, and whether `~/.agents/skills`, ancestor `.agents/skills`, `.claude/skills`, `.cursor/skills`, or other vendor roots are consumed are not documented. | Shared consumption is `unknown` unless the installed product's effective state can be read and verified. |
| Precedence | If same-named skills exist in `.trae/skills/` and `.agents/skills/`, TraeCode prioritizes `.trae/skills/` ([Skills](https://docs.trae.ai/ide/skills)). | The docs do not distinguish Global-vs-Project native collision behavior, Global-vs-Project Shared behavior, case normalization, duplicate `name` frontmatter, or malformed candidates. | Only native-over-Shared precedence is known; other collisions must return `conflicted`/`unknown`. |
| Isolation/control | UI per-skill switches exist. Project disables are represented by `skill-config.json`. Shared Project consumption has an official UI toggle ([Skills](https://docs.trae.ai/ide/skills)). | There is no official machine-readable control contract for the Shared toggle or global disables. It is not proven that moving every native entry OFF plus turning Shared off excludes every contributing root. | A SkillsPub adapter cannot independently apply/verify isolation; this is the primary Managed blocker. |
| Next-load behavior | The docs say `.agents/skills` skills are discovered/loaded “at runtime” and native skills are dynamically loaded on demand ([Skills](https://docs.trae.ai/ide/skills)). | It is not stated whether filesystem/config changes apply to the next message, new chat, workspace reload, or process restart. | Effective visibility for “next Harness load” cannot be asserted without product tests. |
| Backup/recovery | Official UI supports edit/delete and converting a Project skill to Global ([Skills](https://docs.trae.ai/ide/skills)). | No Skills-specific backup location, Trash behavior, rollback, export fidelity, config recovery, or state-loss semantics are documented. | Any future writer must create and verify its own backup/manifest; recovery behavior remains a blocker until tested. |
| Account/region | Official setup requires login, and TRAE publishes an explicit supported-country/region list ([Quickstart](https://docs.trae.ai/ide/set-up-trae?_lang=en), [Supported countries and regions](https://docs.trae.ai/ide/supported-countries-and-regions), [Plans & billing](https://docs.trae.ai/ide/new-plans-and-billing)). | Skills availability by plan, enterprise policy, account type, geography, and China/international build is not documented on the Skills page. | Validation must record region, account/plan, edition, and service endpoint; results must not be generalized across variants. |

## Findings

1. **TraeCode is a credible discoverable Harness.** Its native Global and Project roots and `SKILL.md` model are explicit enough to define read-only Targets and scan them. [Skills](https://docs.trae.ai/ide/skills)
2. **Shared consumption is opt-in but not programmatically inspectable from published evidence.** The documented UI toggle is useful product control, but SkillsPub requires an auditable local schema and verify path; neither is official. [Skills](https://docs.trae.ai/ide/skills)
3. **Per-project disabling is only partially specified.** The existence and purpose of `.trae/skill-config.json` are official, but its actual schema is absent and global-disable storage is explicitly elsewhere/unknown. [Skills](https://docs.trae.ai/ide/skills)
4. **Precedence evidence is incomplete.** Native `.trae/skills` beats `.agents/skills` for the same name, but no complete ordering across Global, Project, ancestors, or other compatibility roots is published. [Skills](https://docs.trae.ai/ide/skills)
5. **The exact candidate is international TraeCode 3.5.91.** This avoids accidentally conflating the IDE with TraeWork, the plugin, the separate open-source Trae Agent CLI, or a China-region product. [Changelog](https://docs.trae.ai/ide/changelog?_lang=en) [Download Center](https://www.trae.ai/download)
6. **No defensible primary-source adoption count was found.** The official GitHub repository is a support shell rather than the IDE source and exposes mutable stars/issues, not installations or active users. Official download/user counts were not published in the reviewed sources. [Trae-AI/TRAE](https://github.com/Trae-AI/TRAE)

## Exact real-machine validation required

Use a fresh, supported-region account and record account plan, country/region, TraeCode edition, exact `Help/About` version, OS/architecture, install source, remote/local mode, and hashes/paths of all observed state before and after each action. At minimum:

1. **Detection:** on macOS, Windows, and one supported Linux distribution, capture app bundle/package IDs, executable names, version resources, user-data directories, CLI availability, and behavior with TraeCode absent, running, upgraded, and co-installed with a China build/plugin.
2. **Root matrix:** place uniquely named probe skills in native Global, native Project, Project `.agents`, `~/.agents`, ancestor `.agents`, `.claude`, and `.cursor`; test local project, nested project, multi-root workspace, Remote SSH, and WSL where supported. Confirm which appear in the Skills UI and which are invocable in a **new chat/new window/fresh process**.
3. **Precedence:** create different-content same-name probes across every consumed root; vary directory casing, frontmatter `name`, malformed `SKILL.md`, and project/global combinations. Record the winner or conflict from observable invocations rather than UI presence alone.
4. **Shared toggle contract:** toggle **Enable .agents Skills Directory** off/on while tracing changed files/databases. Identify its key, schema, scope, default, ownership, atomic-write behavior, concurrent modification behavior, and whether it excludes all Shared/ancestor roots. Reboot/relogin and upgrade to confirm persistence.
5. **Disable schema:** toggle native Project and Global skills. Capture exact `skill-config.json` schema and the global state store; test unknown fields, missing file, malformed JSON, manual edits, concurrent UI edits, same-name skills, and whether disable applies immediately, next chat, reload, or restart.
6. **Resource form:** test directory symlinks and file symlinks for both native roots and `.agents`; test links pointing inside/outside Shared, broken links, canonical-path collision, and updates while TraeCode is open. If links are not stable, validate mirror behavior.
7. **Lifecycle:** with an open conversation, add/remove/disable/rename a probe and test current turn, next turn, new chat, workspace reload, window reload, and full restart. Establish the precise boundary corresponding to SkillsPub “next load.”
8. **Recovery:** use UI edit/delete/Apply to Global and forced interruption. Observe Trash, backups, partial moves, config recovery, unknown ownership, reinstall/upgrade preservation, and rollback after restoring original files/state.
9. **Region/edition:** repeat the minimum visibility/isolation test on Personal and any available Enterprise account, and do not reuse international findings for `.trae-cn` or other regional builds without separate evidence.
10. **Fixture gate:** only promote after pinning the verified version and saving redacted fixtures for detection, roots, config states, toggle on/off, malformed/unknown schema, precedence, symlink capability, backup/apply/verify, and next-load behavior.

A promotion to `managed` requires all consumed roots to be enumerable, Shared state to be safely inspectable and controllable, native/global disables to have validated schemas, isolation to survive restart, and hidden/visible probe outcomes to match the resolver. Until then, an adapter should remain read-only and report Effective visibility `unknown` whenever compatibility roots, config state, version, or collisions matter.

## Local installed-product evidence

A narrow path probe found no `/Applications/Trae.app`, `/Applications/TraeCode.app`, `~/.trae/skill-config.json`, or obvious `~/Library/Application Support/{Trae,TraeCode}/User/settings.json` on this macOS host. This is **not** a complete absence proof because directory enumeration and package-manager inspection were unavailable; it only means no installed-product evidence was available for validation in this run.

## Sources

### Kept

- [TraeCode Skills documentation](https://docs.trae.ai/ide/skills) — primary contract for format, native roots, `.agents` opt-in, precedence, disable behavior, and runtime loading.
- [TraeCode Changelog](https://docs.trae.ai/ide/changelog?_lang=en) — first-party release/version evidence; latest reviewed line is 3.5.89–3.5.91.
- [TraeCode Quickstart](https://docs.trae.ai/ide/set-up-trae?_lang=en) — first-party install, platform, and login constraints.
- [TRAE Download Center](https://www.trae.ai/download) — first-party product separation and packages.
- [Supported countries and regions](https://docs.trae.ai/ide/supported-countries-and-regions) — first-party availability constraint.
- [Plans & billing](https://docs.trae.ai/ide/new-plans-and-billing) — first-party account/plan context.
- [Trae-AI/TRAE](https://github.com/Trae-AI/TRAE) — official repository identity; also shows why no inspectable IDE source was available.

### Dropped

- Community repositories, blogs, forum posts, third-party integration guides, and user-authored issues — excluded because the task allows only owner-controlled primary evidence for product behavior.
- `bytedance/trae-agent` — official source, but it is a separate CLI agent and not evidence for TraeCode IDE discovery/configuration.
- Search-result claims about when `.agents/skills` first shipped — not used because the reviewed English changelog did not directly establish the first supporting version.

## Gaps

The decisive gaps are the Shared-toggle persistence schema, global-disable state, full root set and precedence, symlink support, exact next-load boundary, backup/recovery semantics, stable detection identifiers, and any actual-machine observation. These are blockers to `managed`, not invitations to infer behavior from the VS Code base or third-party reports.
