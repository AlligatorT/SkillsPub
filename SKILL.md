---
name: skillspub
description: Route SkillsPub Runtime, Preset, and Shared Runtime requests through the `skillspub` CLI. Use for enabling, disabling, inspecting, grouping, applying Presets, or discovering and managing Shared Skills.
---

# SkillsPub Runtime Router

Use only `skillspub`. Do not inspect or mutate Runtime roots, parking areas, symlinks, lock files, `.skillspub/state.json`, `skills.sh`, or `npx skills` directly. The CLI owns scanning, state, previews, confirmation, and reconciliation.

Use the terms **Runtime**, **Agent Runtime**, **Shared Runtime**, **Runtime Slot**, **Actual state**, **Desired state**, and **Drift**. A Shared Runtime is one Runtime shared by all of its consumers: it cannot be turned OFF for just one Agent.

## Resolve before changing

1. For a Global operation, run `skillspub scan`; for a Project operation, require the exact directory and run `skillspub project <exact-directory> scan`. Never infer a Project root or read a Project state file yourself.
2. Report the selected Runtime, its discovery/parking root, and the CLI's Actual state. Always also label the Desired state: use `unchanged (no command requested)` for a status-only query, or `pending CLI Plan` for a mutation. In a Project scan, inherited entries are read-only; only the exact Project directory is writable.
3. Treat the CLI's printed `Plan:` target and claim as the only authoritative Desired state. It can differ from a requested manual ON/OFF when an active Preset claim requires ON; do not calculate claims or Drift from state files.
4. If same-name Variants or a Shared Runtime Slot's source are ambiguous, stop and ask the user to choose. Never choose a name, path, Runtime, or source by guesswork.

After every mutation, rerun the matching `scan` and report the completed CLI operation(s) and final Actual state. For operations with a CLI `Plan:`, report its Desired state; Shared mutations do not emit a Plan, so mark Desired state `not reported`. Report remaining Drift only from the CLI's `Remaining drift:` output; if a command does not emit it, mark it `not reported` rather than deriving it from a scan or repairing automatically.

## Runtime Relationships

For an existing Global Runtime Relationship, use an explicit selector and Runtime key:

```text
skillspub on  skill:<instance>|bundle:<name>|tag:<name> <runtime...>
skillspub off skill:<instance>|bundle:<name>|tag:<name> <runtime...>
```

`on` that would create a missing Relationship prints a plan and requires `--yes`. Show that plan, obtain confirmation, then rerun the same `skillspub on ... --yes` command. Do not bypass the confirmation or create symlinks manually.

Do not promise unsupported per-Agent toggles for a Shared Runtime. For an individual Project Relationship toggle that the CLI does not expose, explain that there is no CLI operation and do not fall back to disk changes.

## One-time selectors versus persistent policy

**Bundle** and **Tag** requests are one-time selectors. Manage them with `skillspub bundle ...` or `skillspub tag ...`, then use `bundle:<name>` or `tag:<name>` in an explicit `on`/`off` operation. Do not create a Preset for a one-time request.

**Preset** requests are persistent positive-ON policy. Use only:

```text
skillspub preset create|add|rm|ls|show ...
skillspub preset activate <name> <runtime...>
skillspub preset deactivate <name> <runtime...>
skillspub preset reconcile [<name>] [<runtime...>]
skillspub preset delete <name> [--yes]
```

Preset definitions are Global. For a Project Preset activation, deactivation, explicit reconciliation, or deletion, use `skillspub project <exact-directory> preset activate|deactivate|reconcile|delete ...`; a Project delete deactivates and reconciles that target before deleting the Global definition. Do not project-prefix create/add/rm/ls/show definition management. Presets do not force OFF, and there is no watcher, daemon, polling, hook, or background reconciliation. Activate/deactivate reconcile immediately; later membership or disk Drift is reconciled only when explicitly requested. Before a delete, obtain confirmation and retain the CLI's `--yes` requirement.

## Shared Runtime discovery and lifecycle

Route every Shared operation through its wrapper:

```text
skillspub shared find <query>
skillspub shared describe <source>
skillspub shared add <source> --skill <name> [--replace]
skillspub shared update [<managed-name>...]
skillspub shared remove <managed-name...>

skillspub project <exact-directory> shared find <query>
skillspub project <exact-directory> shared describe <source>
skillspub project <exact-directory> shared add <source> --skill <name> [--replace]
skillspub project <exact-directory> shared update [<managed-name>...]
skillspub project <exact-directory> shared remove <managed-name...>
```

The wrapper is the only route to the pinned `skills@1.5.21` integration. Never call a skills.sh API or `npx skills` yourself. Do not redirect or hide its security audit and final `Proceed` prompt.

If `shared add` reports a source replacement, show the old and new sources and ask for confirmation before rerunning with `--replace`. Do not pass `--yes` through to the wrapped installer. For update/remove, use only the exact managed name accepted by the CLI; never use a broad removal command.

## Safety

Keep all CLI previews and confirmations visible. Do not unlink or delete Runtime files manually. For safe structural repairs, use `skillspub doctor` first; run `skillspub doctor --repair --yes` only after the user approves the displayed repair plan.
