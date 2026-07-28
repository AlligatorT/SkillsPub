## Review

- **Correct**: Domain alignment is solid — scan derives everything from disk (ADR-0001), `off = move into .off/` with `关 ≠ 删`, SKILL.md gate in `scanDir` (ADR-0004, core.ts:103-104). `lexists`/`lstat` correctly distinguishes dead symlinks from missing entries. `tsc --noEmit` clean, all `node:test` tests pass (fail 0). Tests cover seeding, parsing, symlinks, deadlinks, matrix, and (in cli.test.ts) CLI behavior. No `progress.md`/`plan.md` present — nothing to maintain.

- **Fixed**: nothing (review-only).

- **Blocker**: none.

- **Note (judgement call — Primitive Obsession, mild)**: `setSkill` (core.ts:132) returns a stringly-typed sentinel: `/** @returns 'on' | 'off' | 'already' */ export function setSkill(...): string`. The JSDoc is doing the type system's job; a `type SetResult = 'on' | 'off' | 'already'` union would let tsc enforce it. Cheap fix, low stakes — skip if you prefer the minimal diff.

- **Note (judgement call — Duplicated Code, trivial)**: unknown-agent validation appears twice in cli.ts — `agents.some((a) => a.name === values.agent)` (cmdLs:48) and `agents.find(...)` + throw (cmdOnOff:78-79). Two call sites isn't worth a helper yet; flag only if a third command appears.

- **Note (not a baseline smell — robustness)**: `loadAgents` (core.ts:48) doesn't validate malformed lines: a line without `=` yields `dir === undefined`, and `expandHome(undefined)` throws `TypeError` at runtime instead of a clear config error. One guard (`if (!dir) throw new Error(\`bad line in agents.conf: ${l}\`)`) closes it. Your call whether user-edited config counts as a trust boundary worth the line.

- **Note (Mysterious Name, borderline)**: magic column width `pad(a, 9)` (cli.ts:32,38) and the `'·'` fallback glyph are unexplained literals; fine for a CLI table, would matter only if column layout grows.

No Shotgun Surgery, Divergent Change, Speculative Generality, or other baseline smells observed; `Home`/`State` interfaces are minimal and earned. Ship it.