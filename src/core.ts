import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Home {
  configDir: string;
}

export function defaultHome(): Home {
  return {
    configDir:
      process.env.SKM_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'skm'),
  };
}

// --- agent registry (~/.config/skm/agents.conf) ---

export interface Agent {
  name: string;
  dir: string;
}

const DEFAULT_AGENTS: Array<[string, string]> = [
  ['claude', '~/.claude/skills'],
  ['agents', '~/.agents/skills'],
  ['pi', '~/.pi/agent/skills'],
];

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadAgents(home: Home): Agent[] {
  const file = path.join(home.configDir, 'agents.conf');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(home.configDir, { recursive: true });
    fs.writeFileSync(
      file,
      DEFAULT_AGENTS.map(([n, d]) => `${n} = ${d}`).join('\n') + '\n',
    );
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => {
      const [name, dir] = l.split('=', 2).map((s) => s.trim());
      return { name, dir: expandHome(dir) };
    });
}

// --- disk scan (ADR-0001: 磁盘是唯一真相) ---

export type Presence = 'on' | 'off' | 'deadlink';

export interface SkillInfo {
  presence: Presence;
  /** symlink target, for symlinked skills and dead links */
  target?: string;
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function scanDir(
  dir: string,
  presence: Presence,
  out: Map<string, SkillInfo>,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(p);
    } catch {
      out.set(e.name, { presence: 'deadlink', target: readlinkOr(p) });
      continue;
    }
    if (!stat.isDirectory()) continue;
    // ADR-0004: 管理单元 = 自包含 SKILL.md 目录
    if (!fs.existsSync(path.join(p, 'SKILL.md'))) continue;
    out.set(e.name, {
      presence,
      target: e.isSymbolicLink() ? readlinkOr(p) : undefined,
    });
  }
}

function readlinkOr(p: string): string | undefined {
  try {
    return fs.readlinkSync(p);
  } catch {
    return undefined;
  }
}

export function scanAgent(agent: Agent): Map<string, SkillInfo> {
  const out = new Map<string, SkillInfo>();
  // off first so a live entry wins if a skill somehow exists in both
  scanDir(path.join(agent.dir, '.off'), 'off', out);
  scanDir(agent.dir, 'on', out);
  return out;
}

export interface Row {
  name: string;
  agents: Record<string, SkillInfo | undefined>;
}

export function scanAll(agents: Agent[]): Row[] {
  const scanned = agents.map((a) => [a.name, scanAgent(a)] as const);
  const names = new Set<string>();
  for (const [, m] of scanned) for (const n of m.keys()) names.add(n);
  return [...names].sort().map((name) => ({
    name,
    agents: Object.fromEntries(scanned.map(([a, m]) => [a, m.get(name)])),
  }));
}

// --- on/off ops (off = 挪进 .off/,关 ≠ 删) ---

/** @returns 'on' | 'off' | 'already' */
export function setSkill(agent: Agent, name: string, on: boolean): string {
  const live = path.join(agent.dir, name);
  const offDir = path.join(agent.dir, '.off');
  const parked = path.join(offDir, name);
  const [src, dst] = on ? [parked, live] : [live, parked];

  if (!lexists(src)) {
    if (lexists(dst)) return 'already';
    throw new Error(`${name} not found for agent ${agent.name}`);
  }
  if (lexists(dst)) throw new Error(`${dst} already exists`);
  if (!on) fs.mkdirSync(offDir, { recursive: true });
  fs.renameSync(src, dst);
  return on ? 'on' : 'off';
}

// --- state file: metadata only (ADR-0001), tags read for ls --tag/未分类 ---

export interface State {
  tags: Record<string, string[]>;
}

export function loadState(home: Home): State {
  try {
    const s = JSON.parse(
      fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8'),
    );
    return { tags: s.tags ?? {} };
  } catch {
    return { tags: {} };
  }
}

export function filterRows(
  rows: Row[],
  filter: { agent?: string; tag?: string },
  tags: Record<string, string[]>,
): Row[] {
  return rows.filter((r) => {
    if (filter.agent !== undefined && r.agents[filter.agent] === undefined)
      return false;
    if (filter.tag !== undefined && !(tags[r.name] ?? []).includes(filter.tag))
      return false;
    return true;
  });
}

export function untagged(rows: Row[], tags: Record<string, string[]>): string[] {
  return rows.filter((r) => (tags[r.name] ?? []).length === 0).map((r) => r.name);
}
