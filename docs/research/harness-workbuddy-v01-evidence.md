# Research: Can Tencent WorkBuddy qualify as a v0.1 Managed Harness?

## Summary

**Recommendation: out (`unsupported`), not `managed` or `discoverable`, for v0.1.** The exact product is **Tencent WorkBuddy**, Tencent's account-backed macOS/Windows “full-scenario AI agent desktop workstation,” documented under the official `/docs/workbuddy/` product section. It demonstrably has a Skill marketplace and local-file capabilities, but official primary evidence does not define filesystem discovery roots, shared/vendor consumption, precedence, symlink behavior, next-load semantics, or a controllable isolation mechanism. Those gaps prevent both reliable Target discovery and the complete consumed-root proof required by `docs/spec/harnesses.md` and ADR-0013.

## Product identity (do not substitute)

1. **In scope: Tencent WorkBuddy desktop.** Tencent's official overview calls the product “Tencent WorkBuddy” and a “full-scenario AI agent desktop workstation.” Official installation docs distribute native Windows and macOS applications; login uses Google or GitHub OAuth. [Overview](https://www.workbuddy.ai/docs/workbuddy/Overview) · [macOS installation](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Mac-Guide) · [Windows installation](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Win-Guide)
2. **Not CodeBuddy Code CLI or CodeBuddy IDE.** The same official site separately documents “CodeBuddy Code” under `/docs/cli/skills`, with `.codebuddy/skills` and `~/.codebuddy/skills`. Those are primary facts about CodeBuddy Code, not proof of Tencent WorkBuddy's roots. The CLI installation page explicitly describes coexistence with “other applications using the CodeBuddy engine (such as WorkBuddy),” confirming related implementation lineage but distinct product identities. [CodeBuddy Code skills](https://www.workbuddy.ai/docs/cli/skills) · [CodeBuddy Code installation](https://www.workbuddy.ai/docs/cli/installation)
3. **Not Qoder, KadenMc/work-buddy, YJYAA/workbuddy, or a generic Buddy-named product.** None is the Tencent WorkBuddy product identified by the official product section, so none supplies admissible behavior evidence here.

## Findings

1. **Agent Skills support exists, but the documented contract is UI/marketplace-oriented.** Tencent's WorkBuddy Skill Marketplace says users can install community and official Skills, view installed Skills, enable/disable them, update them, and uninstall them; installation is preceded by an automatic security scan. This is sufficient to establish that WorkBuddy supports a product feature named Skills, but not that arbitrary Agent Skills directories are scanned. [Official Skill Marketplace](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)
2. **Identity/version evidence is obtainable, but no pinned Skill-discovery version exists.** Official docs say the app version is visible in Settings/About, and the official changelog currently exposes 5.x releases (including 5.2.3 and 5.2.7). No cited release note defines local Skill discovery. Any adapter would therefore need to pin the exact installed build used in validation rather than infer behavior from the current docs. [Help & Feedback](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Feedback) · [Changelog](https://www.workbuddy.ai/docs/workbuddy/Changelog)
3. **Install and coarse detection are documented; stable machine detection is not.** Official installation evidence supports native app installation on macOS 12+ and Windows 10/11, plus an account and internet requirement. It does not document a stable executable name, bundle identifier, registry key, installation path, home/state directory, or command that reports a machine-readable version. [FAQ](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/FAQ) · [Quick Start](https://www.workbuddy.ai/docs/workbuddy/Quickstart)
4. **Global and Project filesystem roots are unknown.** Official WorkBuddy docs describe an installed personal Skill library and cloud-backed Project Skills. The Project page states that project configuration (including Skills) is stored in the cloud and shared with members, and that web/client personal Skill libraries are separate while project Skills are cloud-unified. It does **not** specify `~/.workbuddy/skills`, `.workbuddy/skills`, `.codebuddy/skills`, or any filesystem root as a WorkBuddy discovery contract. [Official Project documentation](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project) · [Official Skill documentation](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)
5. **The commonly asserted `.workbuddy/skills` roots are not verified primary product evidence.** An open, unmerged Vercel `skills` PR proposes `.workbuddy/skills`, `~/.workbuddy/skills`, and `.workbuddy` detection, but its author association is `NONE`, manual install/discovery checks remain unchecked, and its cited Tencent page does not state those paths. It is useful as adoption/research evidence, not as an authoritative WorkBuddy contract. [vercel-labs/skills issue #1353](https://github.com/vercel-labs/skills/issues/1353) · [open PR #1354](https://github.com/vercel-labs/skills/pull/1354)
6. **Configuration for filesystem visibility is unknown.** WorkBuddy's UI can enable or disable installed Skills. Official docs do not identify the backing config file/schema, whether UI state is local or cloud state, whether it applies by Skill identity/name/version, or whether SkillsPub could safely read or write it. [Official Skill Marketplace](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)
7. **Shared/vendor consumption and precedence are unknown.** No official WorkBuddy source found defines consumption of `~/.agents/skills`, `.agents/skills`, `.claude/skills`, `.codebuddy/skills`, plugin/vendor directories, ancestor roots, or imported directories. No official source defines precedence for same-name Skills across personal, project, marketplace, cloud, or local sources. The Project page's “project Skill placed first” UI sorting is not a runtime same-slot precedence contract. [Official Project documentation](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project)
8. **Isolation/control is insufficient for `managed`.** UI enable/disable establishes that WorkBuddy itself can control marketplace-installed Skill availability. There is no official, machine-readable isolation mechanism proving that all other consumed roots can be excluded, nor ownership semantics that let SkillsPub remove only its own claims. Under `docs/spec/harnesses.md`, unknown/required Shared consumption and incomplete roots make deterministic Effective visibility impossible.
9. **Next-load behavior is unknown.** Official docs do not say whether a filesystem addition/removal is noticed immediately, on task creation, on conversation creation, on app restart, after explicit reload, or after cloud synchronization. ADR-0013 requires a conclusion about the Harness's **next load**, not merely directory presence.
10. **Backup/recovery is unknown for Skill visibility.** Official docs explain update/uninstall through the product UI but do not document export, config backup, rollback, trash, transactional writes, or restoration of local/cloud Skill state. A SkillsPub adapter cannot yet meet inspect → plan → apply → verify or safe recovery requirements.
11. **Access constraints complicate reproducible validation.** Official docs require a registered/logged-in account and internet access; the desktop supports macOS and Windows. Project Skills may be cloud-managed and account/organization dependent. Tests therefore need an authorized non-production account and cannot be reduced to a hermetic filesystem fixture until the local/cloud boundary is known. [Quick Start](https://www.workbuddy.ai/docs/workbuddy/Quickstart) · [FAQ](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/FAQ)
12. **Primary-source adoption evidence is limited but real.** Tencent ships an official Skill marketplace and official docs describe community/official install, enable/disable, update, uninstall, and built-in/third-party Skills. The Vercel project has an open request and unmerged patch for WorkBuddy, but it is neither accepted adoption nor validated product behavior. No primary product telemetry, install count, or public WorkBuddy source implementation was found. [Official Skill Marketplace](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market) · [vercel-labs open PR #1354](https://github.com/vercel-labs/skills/pull/1354)

## Facts vs unknowns matrix

| Required surface | Verified fact | Unknown/blocker | Consequence |
| --- | --- | --- | --- |
| Agent Skills | Marketplace Skills can be installed and managed | Compatibility with directory-based Agent Skills contract | Feature exists; adapter contract does not |
| Identity/version | Tencent WorkBuddy desktop; version shown in app; 5.x changelog | Stable programmatic version/detection and pinned discovery build | Cannot fixture version semantics |
| Install/detection | Native macOS/Windows installers; login required | Bundle ID, executable/state path, registry key, CLI version output | Cannot reliably detect |
| Global root | Personal installed Skill library exists | Filesystem path and whether direct entries are consumed | No Global Target Definition |
| Project root | Project Skills exist and are cloud-shared | Filesystem path; workspace mapping; ancestor behavior | No Project Target Definition |
| Config | UI enable/disable exists | Backing file/schema/cloud API and ownership | Cannot safely inspect/apply |
| Shared/vendor | Marketplace and project/personal sources exist | `.agents`, `.claude`, `.codebuddy`, plugin/import roots | Effective visibility incomplete |
| Precedence | Project Skills are presented first in selection UI | Runtime duplicate-name resolution | Conflicts cannot be resolved |
| Isolation/control | UI can disable installed Skills | Reliable exclusion of every alternate root/source | Cannot be `managed` |
| Next load | None documented | Reload/restart/new-task/cloud-sync boundary | Cannot prove next-load visibility |
| Backup/recovery | UI update/uninstall exists | Export/rollback/transaction/restore contract | Unsafe writes |
| Access | Account + internet + supported desktop OS required | Enterprise policy/region/entitlement effects | Real-machine matrix required |
| Adoption | Official marketplace; open Vercel request | Product telemetry or accepted third-party adapter | No quantitative claim |

## Exact real-machine validation required before reconsideration

Run this against **each supported OS family** (at minimum current macOS and Windows), recording exact app version from Settings/About, installer URL/hash, account type/region, timestamps, screenshots, logs, and a before/after filesystem snapshot outside credential/token contents.

1. Install Tencent WorkBuddy from the official installer into a fresh OS account; record executable/bundle/registry identifiers, process image, version, home/state directories, and whether detection remains stable after upgrades.
2. With a dedicated test workspace, create uniquely named canary Skills through every official route: marketplace install, local upload/import, natural-language creation, personal library, and Project Skill. Record actual files, manifests/databases, cloud calls/state, permissions, IDs, hashes, and symlink treatment.
3. Place valid, uniquely named `SKILL.md` canaries (and invalid controls) separately in proposed roots: `~/.workbuddy/skills`, `<project>/.workbuddy/skills`, `~/.codebuddy/skills`, `<project>/.codebuddy/skills`, `~/.agents/skills`, `<project>/.agents/skills`, `.claude/skills`, every existing ancestor candidate, and plugin/marketplace directories. Change one root at a time.
4. For every mutation, test these load boundaries independently: current conversation, new task/conversation, explicit UI refresh/reload if present, app restart, logout/login, and second-device/web synchronization. Evidence must show the first boundary at which the canary becomes visible and invocable.
5. Create same-name/different-content canaries in every pair and then all roots. Invoke by exact name and automatic matching; record the selected canonical path/content or conflict behavior. Repeat with personal/project/cloud/plugin enable states to establish precedence.
6. Test real directories, file symlinks, directory symlinks, broken links, links outside the workspace, junctions on Windows, and mirrors. Record whether WorkBuddy follows/canonicalizes/rejects them.
7. Toggle each Skill in WorkBuddy. Diff filesystem/config/cloud state and verify whether direct filesystem additions, marketplace copies, Project Skills, vendor roots, and Shared roots can each be excluded. Determine whether there is one documented, durable mechanism that isolates all non-WorkBuddy-specific roots without disabling unrelated features.
8. Verify config schema, precedence, malformed/type-changed handling, concurrent edit behavior, and exact version migration. Do not write until ownership and atomic replacement are demonstrable.
9. Exercise install/update/disable/enable/uninstall, crash during each operation, app upgrade, config deletion, state deletion, and restore from backup. Confirm no source Skill or unrelated user state is lost and document manual recovery.
10. Repeat with an unentitled/offline account and, if available, enterprise-managed account to characterize login, network, region, organization policy, and cloud Project constraints.
11. Only after the above passes, pin the validated app build and retain sanitized fixtures/logs. Re-run on a newer version; downgrade to read-only/unknown whenever schema or discovery semantics cannot be confirmed.

## Recommendation

- **v0.1 classification: `unsupported` / out.** Do not create a built-in WorkBuddy Adapter and do not advertise `.workbuddy/skills` as a Target based on an unmerged third-party patch.
- **Not `discoverable`:** no reliable official Global or Project filesystem Target is established.
- **Not `managed`:** complete consumed roots, precedence, isolation, config ownership, next-load semantics, and recovery are all unverified.
- A user may declare a **Generic Target** for a personally verified directory, but SkillsPub must make no WorkBuddy Effective visibility claim.
- Reconsider `discoverable` only after official documentation/source or reproducible pinned-machine evidence establishes roots and load semantics. Reconsider `managed` only after all consumed roots and a durable isolation/control path satisfy the Harness Adapter contract.

## Sources

### Kept (primary or clearly scoped ecosystem evidence)

- [Tencent WorkBuddy Overview](https://www.workbuddy.ai/docs/workbuddy/Overview) — official product identity.
- [Tencent WorkBuddy Skill Marketplace](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market) — official Skill lifecycle/UI claims.
- [Tencent WorkBuddy Project](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Project) — official cloud/project/personal-library boundary.
- [Tencent WorkBuddy Quick Start](https://www.workbuddy.ai/docs/workbuddy/Quickstart) and [FAQ](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/FAQ) — official access/platform constraints.
- [Tencent WorkBuddy Changelog](https://www.workbuddy.ai/docs/workbuddy/Changelog) — official visible version line.
- [CodeBuddy Code Skills](https://www.workbuddy.ai/docs/cli/skills) and [installation](https://www.workbuddy.ai/docs/cli/installation) — official negative identity comparison only; not used as WorkBuddy behavior proof.
- [vercel-labs/skills issue #1353](https://github.com/vercel-labs/skills/issues/1353) and [PR #1354](https://github.com/vercel-labs/skills/pull/1354) — primary records of that project's unaccepted WorkBuddy proposal; used only for adoption status and to reject the proposed paths as proof.

### Dropped

- QoderAI Better Harness WorkBuddy adapter — third-party observation, not product-owner evidence.
- Community WorkBuddy Skill repositories and tutorials — useful leads but not authoritative discovery contracts.
- `learn-workbuddy` teaching code — explicitly a teaching approximation.
- KadenMc/work-buddy and YJYAA/workbuddy — different products.
- CodeBuddy Code/Qoder behavior as affirmative WorkBuddy evidence — identity substitution prohibited.

## Gaps

The private SkillsPub issue body/comments could not be independently retrieved through available web endpoints, so the research follows the supplied issue title/task acceptance surface. No public product source code or official filesystem discovery specification was found. The decisive next step is the controlled real-machine protocol above plus a request to Tencent for a versioned discovery/config contract.

## Delivery note

The required repository note and commit could not be created from this research worker because its available tools can write only the authoritative artifact path and cannot execute Git or mutate the worktree. Intended repository destination: `docs/research/harness-workbuddy-v01-evidence.md`. Commit SHA: unavailable.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings, blocker severity, exact validation plan, and intended repository path are recorded in workbuddy-evidence.md."
    }
  ],
  "changedFiles": [
    "/Users/wangyitao/.pi/agent/sessions/--Users-wangyitao-Projects-SkillsPub--/subagent-artifacts/outputs/c42842a3-859a-453a-8b55-6a861abea5a6/workbuddy-evidence.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Read research skill, CONTEXT.md, docs/spec/harnesses.md, ADR-0013, and issue-tracker guidance",
      "result": "passed",
      "summary": "Established primary-source policy and Managed Harness acceptance contract."
    },
    {
      "command": "Focused web research and full-content fetches of official Tencent WorkBuddy/CodeBuddy documentation and vercel-labs primary records",
      "result": "passed",
      "summary": "Confirmed product identity and Skill UI support; found no authoritative filesystem discovery/isolation contract."
    },
    {
      "command": "git commit docs/research/harness-workbuddy-v01-evidence.md",
      "result": "not-run",
      "summary": "No shell/Git or worktree-edit capability is available to this child worker; authoritative artifact written instead."
    }
  ],
  "validationOutput": [
    "Recommendation: unsupported/out for v0.1; neither discoverable nor managed.",
    "Blockers: official roots, detection/version, config schema, shared/vendor consumption, precedence, isolation, next-load behavior, and recovery are unknown.",
    "Exact macOS/Windows real-machine validation matrix is included."
  ],
  "residualRisks": [
    "blocker: private issue #106 body/comments were not retrievable through available web endpoints.",
    "blocker: no real Tencent WorkBuddy machine was available for the required discovery and next-load experiments.",
    "blocker: repository file and commit SHA remain to be produced by the parent/worktree-capable session."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added one research artifact separating verified Tencent WorkBuddy facts from unknowns and recommending unsupported/out.",
  "reviewFindings": [
    "blocker: docs/research/harness-workbuddy-v01-evidence.md - repository copy and commit are not possible in this worker.",
    "blocker: WorkBuddy adapter - insufficient primary evidence for reliable Targets or Effective visibility."
  ],
  "manualNotes": "Copy this artifact to docs/research/harness-workbuddy-v01-evidence.md, review, and commit from a worktree-capable session."
}
```
