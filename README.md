# SkillsPub

SkillsPub switches Agent Skills on and off across AI coding harnesses — Pi, Claude Code, and Grok Build — from one place. It reads the disk as the source of truth, shows what each harness will pick up on its next load, and prints an immutable preview before any change is written.

## Requirements

- Node.js 22.20 or newer

## Compatibility

Remote Source operations go through one pinned Vercel `skills` release (`skills@1.5.21`), so release behavior does not drift with upstream `latest`.

Harness support levels are enforced by `npm run audit:release`. The verified-version evidence each adapter was accepted against:

| Harness | Support | Verified against |
| --- | --- | --- |
| Pi | `managed` | v0.85.1 |
| Claude Code | `managed` | docs snapshot 2026-08-12 |
| Grok Build | `managed/excluded` | settings reference @ `19d42e35` |

`discoverable` candidates (Codex, OpenCode, Kimi Code, TraeCode) are observed only and carry no verified-version claim.

## Install

```sh
npm install --global skillspub
```

Or without a global install: `npx skillspub targets`.

## First run

There is no setup step. SkillsPub discovers installed skills and harnesses by scanning the disk, so open the TUI and everything is already there:

```sh
skillspub
```

All browsing is read-only; nothing changes without an explicit confirmed plan. One optional configuration exists: Pi's Shared-skills isolation, applied only when you ask for it:

```sh
skillspub harnesses pi setup   # prints a preview; rerun with --yes to apply
```

Claude Code and Grok Build need no setup.

## TUI

`skillspub` in a terminal opens the full-screen browser (same as `skillspub tui`; add `--project [path]` for a project-scope view). It is keyboard-driven: browse the skill × Target matrix, toggle skills, manage Tags, Bundles, and Presets, and run the Source lifecycle (find, add, update, remove) with preview → confirm → verify for every mutation.

## CLI

Everything the TUI does is also a scriptable command:

| Group | Commands |
| --- | --- |
| Inspect | `scan` · `ls` · `status <skill>` · `explain <skill>` · `targets` · `doctor` |
| Toggle | `on\|off <selector> <target...> [--yes]` |
| Organize | `tag` · `bundle` · `preset` (persistent always-on policy) |
| Sources | `shared find\|describe\|refresh\|outdated\|add\|update\|remove` |
| Harnesses | `harnesses [name inspect\|setup\|reconcile [--yes]]` |
| Project scope | prefix any of the above with `project <exact-path>` |

Every mutation prints its plan first and applies only with `--yes`.

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
