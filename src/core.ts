import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Home {
  configDir: string;
}

export function migrateLegacyConfig(configDir: string, legacyDir: string): void {
  if (configDir === legacyDir || !fs.existsSync(legacyDir)) return;
  fs.mkdirSync(configDir, { recursive: true });
  for (const entry of fs.readdirSync(legacyDir)) {
    const destination = path.join(configDir, entry);
    if (!lexists(destination))
      fs.cpSync(path.join(legacyDir, entry), destination, { recursive: true });
  }
}

export function defaultHome(): Home {
  const configDir =
    process.env.SKILLSPUB_CONFIG_DIR ??
    path.join(os.homedir(), '.config', 'skillspub');
  // Migration-only: legacy data is copied into canonical config, never used directly.
  if (process.env.SKM_CONFIG_DIR || !process.env.SKILLSPUB_CONFIG_DIR)
    migrateLegacyConfig(
      configDir,
      process.env.SKM_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'skm'),
    );
  return { configDir };
}

// --- agent registry (~/.config/skillspub/agents.conf) ---

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
      const eq = l.indexOf('=');
      if (eq === -1) throw new Error(`bad line in agents.conf: ${l}`);
      return {
        name: l.slice(0, eq).trim(),
        dir: expandHome(l.slice(eq + 1).trim()),
      };
    });
}

// --- disk scan (ADR-0001: 磁盘是唯一真相) ---

export type Presence = 'on' | 'off' | 'deadlink';

export interface SkillInfo {
  presence: Presence;
  path: string;
  realPath?: string;
  linked: boolean;
  underOff: boolean;
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
      out.set(e.name, {
        presence: 'deadlink',
        path: p,
        linked: e.isSymbolicLink(),
        underOff: presence === 'off',
        target: readlinkOr(p),
      });
      continue;
    }
    if (!stat.isDirectory()) continue;
    // ADR-0004: 管理单元 = 自包含 SKILL.md 目录
    if (!fs.existsSync(path.join(p, 'SKILL.md'))) continue;
    out.set(e.name, {
      presence,
      path: p,
      realPath: fs.realpathSync(p),
      linked: e.isSymbolicLink(),
      underOff: presence === 'off',
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

export type SetResult = 'on' | 'off' | 'already';

export function setSkill(agent: Agent, name: string, on: boolean): SetResult {
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

export function toggleSkill(agent: Agent, name: string): SetResult {
  const info = scanAgent(agent).get(name);
  return setSkill(
    agent,
    name,
    info?.underOff === true || info?.presence === 'off',
  );
}

// --- state file: metadata only (ADR-0001), tags read for ls --tag/未分类 ---

export interface InventoryEntry {
  source?: string;
  hash?: string;
  seen_at?: string;
}

export interface State {
  bundles: Record<string, string[]>;
  tags: Record<string, string[]>;
  inventory: Record<string, InventoryEntry>;
}

const EMPTY_STATE: State = { bundles: {}, tags: {}, inventory: {} };

export function loadState(home: Home): State {
  try {
    const s = JSON.parse(
      fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8'),
    ) as Partial<State>;
    return {
      bundles: s.bundles ?? {},
      tags: s.tags ?? {},
      inventory: s.inventory ?? {},
    };
  } catch {
    return EMPTY_STATE;
  }
}

export interface SkillDetail {
  name: string;
  agents: Record<string, SkillInfo | undefined>;
  realPaths: string[];
  source?: string;
  bundles: string[];
  tags: string[];
  content?: string;
  contentPath?: string;
}

export interface TuiSnapshot {
  agents: Agent[];
  rows: Row[];
}

/** Read the live disk state. Call again after every mutation (ADR-0001). */
export function tuiSnapshot(home: Home): TuiSnapshot {
  const agents = loadAgents(home);
  return { agents, rows: scanAll(agents) };
}

/** Assemble read-only detail from live disk plus state-file metadata. */
export function skillDetail(
  home: Home,
  agents: Agent[],
  name: string,
): SkillDetail | undefined {
  const row = scanAll(agents).find((candidate) => candidate.name === name);
  if (!row) return undefined;

  const state = loadState(home);
  const infos = agents.flatMap((agent) => {
    const info = row.agents[agent.name];
    return info ? [info] : [];
  });
  const readable = infos.find((info) => info.realPath !== undefined);
  const contentPath = readable
    ? path.join(readable.realPath as string, 'SKILL.md')
    : undefined;

  return {
    name,
    agents: row.agents,
    realPaths: [...new Set(infos.flatMap((info) => info.realPath ?? []))],
    source: state.inventory[name]?.source,
    bundles: Object.entries(state.bundles)
      .filter(([, members]) => members.includes(name))
      .map(([bundle]) => bundle)
      .sort(),
    tags: state.tags[name] ?? [],
    content: contentPath ? fs.readFileSync(contentPath, 'utf8') : undefined,
    contentPath,
  };
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
