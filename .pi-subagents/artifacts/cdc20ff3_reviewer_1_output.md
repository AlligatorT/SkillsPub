## Review

**Correct:**
- Disk-as-source-of-truth (issue #1: "磁盘是唯一真相（ADR-0001)：扫各 agent skills/ 一级目录 = 开，`.off/` = 关") — `scanAgent`/`scanDir` (src/core.ts:110-117) scan live and `.off/`, on/off never persisted; `setSkill` (src/core.ts:128-143) moves dirs via rename, 关 ≠ 删.
- state.json metadata-only ("state file … 只存元数据") — `loadState` (src/core.ts:147-157) reads only `tags`, no on/off ever written, no write path at all.
- agents.conf registry (src/core.ts:31-51) — seeds defaults matching CONTEXT (claude/agents/pi), `~` expansion, comments skipped; tested.
- All four commands implemented: `ls` matrix + 未分类/死链 hints (src/cli.ts:53-80), `on|off`, `status`, `agents`. ADR-0004 SKILL.md requirement honored (src/core.ts:94-95, tested).
- Tests: 14 pass, `tsc --noEmit` clean. No scope creep — no bundle/tag/preset/scan/doctor/tui commands.

**Note (partial):** spec line "`skm ls [--agent A] [--tag T]` … 顺带提示未分类/死链" — untagged hint relies on `state.json` tags, but nothing in this issue creates `state.json`; until the `tag` issue lands every skill prints as 未分类. Acceptable given tags are a later issue, but the hint will be noisy meanwhile.

**Note (fragile):** src/core.ts:47 — `l.split('=', 2)` truncates paths containing `=`; a malformed line without `=` crashes with a raw TypeError (`expandHome(undefined)`) instead of a useful "bad agents.conf line N" error.

**Note (risk):** src/cli.ts:120 — `skm status <skill>` for a skill absent everywhere prints a warning to stderr but exits 0; scripts can't detect "not found". Also deadlink in live dir overwrites an existing `.off/` copy in the scan map (live scanned second, src/core.ts:113-116) — a skill parked in `.off/` with a stale broken symlink live shows as `deadlink`, hiding the recoverable copy.

**Note (distribution):** ADR-0005 says "分发走 npm (`npx skm`)" but `bin` points at raw `src/cli.ts` with `.ts` imports — works only on Node with type-stripping (≥22.6 flag / ≥23.6 default). Fine for dev, needs a build step or engines field before npm publish. Not blocking issue #1.

**No blockers.** Core model, commands, and tests match the spec for issue #1's scope.