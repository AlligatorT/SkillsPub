# SkillsPub

SkillsPub is an auditable relationship and visibility manager for Agent Skills. Disk records Actual state; SkillsPub records human intent and persistent Preset claims, then explains why a skill will or will not be discovered on the next Harness load.

The v0.1 built-in Harnesses are Pi, Claude Code, and Grok Build.

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

Run `skillspub` in a terminal to open the TUI. Mutating commands preview their plan and require explicit confirmation where applicable. SkillsPub does not inspect running Harness process memory; Effective visibility describes the next Harness load from local evidence.

The bundled [`SKILL.md`](SKILL.md) is the thin router for agents. It requires all Skill Target operations to go through the CLI rather than direct filesystem edits.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run audit:release
npm run check:package
```

`check:package` packs twice, verifies byte-for-byte deterministic tarballs and the exact file allowlist, installs one tarball into a clean temporary prefix, then runs the installed CLI and a read-only JSON command.

Release prerequisites and the cutover checklist are in [`docs/releasing.md`](docs/releasing.md).

## License

MIT © 2026 AlligatorT
