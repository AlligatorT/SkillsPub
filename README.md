# SkillsPub

SkillsPub is an auditable relationship and visibility manager for Agent Skills. Disk records Actual state; SkillsPub records human intent and persistent Preset claims, then explains why a skill will or will not be discovered on the next Harness load.

The v0.1 built-in Harnesses are Pi (`managed`, with Global/exact-Project Shared isolation), Claude Code (`managed`, Shared `not-consumed`), and Grok Build (`managed/excluded`). Codex, OpenCode, Kimi Code, and TraeCode remain `discoverable` compatibility candidates; WorkBuddy remains `unsupported`.

## Requirements

- Node.js 22.20 or newer

## Install

```sh
npm install --global skillspub
skillspub targets
```

You can also run it without a global install:

```sh
npx skillspub targets
```

## Start safely

Inspect before changing anything:

```sh
skillspub scan
skillspub status <skill>
skillspub explain <skill>
skillspub targets --json
```

Run `skillspub` in a terminal to open the TUI. Source add, replace, and update commands print an immutable plan first; rerun the same command with `--yes` to apply it. Source removal separately confirms the Relationship cascade and named source deletion. SkillsPub does not inspect running Harness process memory; Effective visibility describes the next Harness load from local evidence.

The bundled [`SKILL.md`](SKILL.md) is the thin router for agents. It requires all Skill Target operations to go through the CLI rather than direct filesystem edits.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run audit:release
npm run check:package
npm pack --ignore-scripts
npm run check:package -- ./skillspub-0.1.0.tgz
npm pack --dry-run --ignore-scripts
```

`check:package` packs twice, verifies byte-for-byte deterministic tarballs and the exact file allowlist, installs one tarball into a clean temporary prefix, then runs the installed CLI and a read-only JSON command. Pass a candidate tarball path to require a byte-for-byte match with the verified package.

Release prerequisites and the cutover checklist are in [`docs/releasing.md`](docs/releasing.md).

## License

MIT © 2026 AlligatorT
