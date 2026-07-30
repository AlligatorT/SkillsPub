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

interface ScannedEntry {
  name: string;
  info: SkillInfo;
}

function scanDir(
  dir: string,
  presence: Presence,
  out: ScannedEntry[],
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
      out.push({
        name: e.name,
        info: {
          presence: 'deadlink',
          path: p,
          linked: e.isSymbolicLink(),
          underOff: presence === 'off',
          target: readlinkOr(p),
        },
      });
      continue;
    }
    if (!stat.isDirectory()) continue;
    // ADR-0004: 管理单元 = 自包含 SKILL.md 目录
    if (!fs.existsSync(path.join(p, 'SKILL.md'))) continue;
    out.push({
      name: e.name,
      info: {
        presence,
        path: p,
        realPath: fs.realpathSync(p),
        linked: e.isSymbolicLink(),
        underOff: presence === 'off',
        target: e.isSymbolicLink() ? readlinkOr(p) : undefined,
      },
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

function scanAgentEntries(agent: Agent): ScannedEntry[] {
  const out: ScannedEntry[] = [];
  scanDir(path.join(agent.dir, '.off'), 'off', out);
  scanDir(agent.dir, 'on', out);
  return out;
}

export function scanAgent(agent: Agent): Map<string, SkillInfo> {
  const out = new Map<string, SkillInfo>();
  // Entries are scanned off first so a live entry wins for name-based callers.
  for (const {name, info} of scanAgentEntries(agent)) out.set(name, info);
  return out;
}

export interface SkillRelationship {
  agent: string;
  name: string;
  info: SkillInfo;
}

export interface SkillProvenance {
  source?: string;
  sourceUrl?: string;
  skillPath?: string;
}

export interface SkillInstance {
  /** Canonical realPath for a resolved instance; link path for a broken relationship. */
  id: string;
  name: string;
  displayName: string;
  realPath?: string;
  description?: string;
  provenance: SkillProvenance;
  sourceLabel: string;
  relationships: SkillRelationship[];
  agents: Record<string, SkillInfo | undefined>;
}

export type Row = SkillInstance;

function descriptionFrom(content: string): string | undefined {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return undefined;
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex((line) => /^description\s*:/.test(line));
  if (index === -1) return undefined;
  const value = lines[index].replace(/^description\s*:\s*/, '').trim();
  if (value === '|' || value === '>') {
    const parts: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (!/^\s+/.test(line)) break;
      parts.push(line.trim());
    }
    return parts.join(value === '>' ? ' ' : '\n') || undefined;
  }
  return value.replace(/^(['"])(.*)\1$/, '$2') || undefined;
}

function readDescription(realPath?: string): string | undefined {
  if (!realPath) return undefined;
  try {
    return descriptionFrom(fs.readFileSync(path.join(realPath, 'SKILL.md'), 'utf8'));
  } catch {
    return undefined;
  }
}

function readInstallerEntry(file: string, name: string): SkillProvenance | undefined {
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      skills?: Record<string, SkillProvenance>;
    };
    const entry = lock.skills?.[name];
    if (!entry) return undefined;
    const provenance = {
      source: entry.source,
      sourceUrl: entry.sourceUrl,
      skillPath: entry.skillPath,
    };
    return Object.values(provenance).some(Boolean) ? provenance : undefined;
  } catch {
    return undefined;
  }
}

function installerProvenance(
  instance: SkillInstance,
  agents: Agent[],
  relationshipCounts: Map<string, number>,
): SkillProvenance | undefined {
  const agentDirs = new Map(agents.map((agent) => [agent.name, agent.dir]));
  for (const relationship of instance.relationships) {
    const agentLock = path.join(
      path.dirname(agentDirs.get(relationship.agent) as string),
      '.skill-lock.json',
    );
    const realPathLock = instance.realPath
      ? path.join(path.dirname(path.dirname(instance.realPath)), '.skill-lock.json')
      : undefined;
    const uniqueRelationship =
      relationshipCounts.get(`${relationship.agent}\0${relationship.name}`) === 1;
    const candidates = [
      ...(uniqueRelationship ? [agentLock] : []),
      ...(realPathLock && (uniqueRelationship || realPathLock !== agentLock)
        ? [realPathLock]
        : []),
    ];
    for (const file of new Set(candidates)) {
      const provenance = readInstallerEntry(file, relationship.name);
      if (provenance) return provenance;
    }
  }
  return undefined;
}

function assembleInventory(
  agents: Agent[],
  state?: State,
): SkillInstance[] {
  const grouped = new Map<string, SkillInstance>();
  for (const agent of agents) {
    for (const {name, info} of scanAgentEntries(agent)) {
      const id = info.realPath ?? `broken:${info.path}`;
      let instance = grouped.get(id);
      if (!instance) {
        instance = {
          id,
          name,
          displayName: name,
          realPath: info.realPath,
          description: readDescription(info.realPath),
          provenance: {},
          sourceLabel: 'Source unknown',
          relationships: [],
          agents: {},
        };
        grouped.set(id, instance);
      }
      instance.relationships.push({ agent: agent.name, name, info });
      instance.agents[agent.name] ??= info;
    }
  }

  const instances = [...grouped.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const counts = new Map<string, number>();
  const relationshipCounts = new Map<string, number>();
  for (const instance of instances) {
    counts.set(instance.name, (counts.get(instance.name) ?? 0) + 1);
    for (const relationship of instance.relationships) {
      const key = `${relationship.agent}\0${relationship.name}`;
      relationshipCounts.set(key, (relationshipCounts.get(key) ?? 0) + 1);
    }
  }

  for (const instance of instances) {
    const installer = installerProvenance(instance, agents, relationshipCounts);
    const legacy = counts.get(instance.name) === 1
      ? state?.inventory[instance.name]
      : undefined;
    instance.provenance = installer ?? {
      source: legacy?.source,
      sourceUrl: legacy?.sourceUrl,
      skillPath: legacy?.skillPath,
    };
    instance.sourceLabel = instance.provenance.sourceUrl
      ?? instance.provenance.source
      ?? 'Source unknown';
    if ((counts.get(instance.name) ?? 0) > 1) {
      const suffix = instance.provenance.source
        ?? instance.provenance.sourceUrl
        ?? instance.realPath
        ?? instance.relationships[0].info.path;
      instance.displayName = `${instance.name} (${suffix})`;
    }
  }
  return instances;
}

export function scanAll(agents: Agent[]): Row[] {
  return assembleInventory(agents);
}

export interface Inventory {
  agents: Agent[];
  instances: SkillInstance[];
}

/** Build one live, variant-safe view of every skill relationship. */
export function buildInventory(home: Home, agents = loadAgents(home)): Inventory {
  return { agents, instances: assembleInventory(agents, loadState(home)) };
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
  sourceUrl?: string;
  skillPath?: string;
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
  id: string;
  name: string;
  displayName: string;
  description?: string;
  agents: Record<string, SkillInfo | undefined>;
  relationships: SkillRelationship[];
  realPaths: string[];
  source?: string;
  sourceUrl?: string;
  sourceLabel: string;
  skillPath?: string;
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
  const inventory = buildInventory(home);
  return { agents: inventory.agents, rows: inventory.instances };
}

/** Assemble detail for one explicit instance identity. */
export function skillDetail(
  home: Home,
  agents: Agent[],
  instanceId: string,
): SkillDetail | undefined {
  const instance = buildInventory(home, agents).instances.find(
    (candidate) => candidate.id === instanceId,
  );
  if (!instance) return undefined;

  const state = loadState(home);
  const contentPath = instance.realPath
    ? path.join(instance.realPath, 'SKILL.md')
    : undefined;

  return {
    id: instance.id,
    name: instance.name,
    displayName: instance.displayName,
    description: instance.description,
    agents: instance.agents,
    relationships: instance.relationships,
    realPaths: instance.realPath ? [instance.realPath] : [],
    source: instance.provenance.source,
    sourceUrl: instance.provenance.sourceUrl,
    sourceLabel: instance.sourceLabel,
    skillPath: instance.provenance.skillPath,
    bundles: Object.entries(state.bundles)
      .filter(([, members]) => members.includes(instance.name))
      .map(([bundle]) => bundle)
      .sort(),
    tags: state.tags[instance.name] ?? [],
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
  return rows
    .filter((row) => (tags[row.name] ?? []).length === 0)
    .map((row) => row.displayName);
}
