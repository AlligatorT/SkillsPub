import fs from 'node:fs';
import path from 'node:path';
import type { Home } from './core.ts';
import {
  readStateFile,
  runtimeSlotId,
  scanGlobalInventory,
  scanProjectInventory,
  type InventoryScanReport,
  type RuntimeRelationship,
  type RuntimeScope,
  type SkillProvenance,
} from './inventory.ts';

// --- view projection: InventoryScanReport -> skill × agent matrix rows ---
// The matrix is a projection of the one inventory scan (ADR-0007); agent
// columns are Runtime keys, presence comes from Relationship activation.

export interface Agent {
  name: string;
  dir: string;
}

export type Presence = 'on' | 'off' | 'deadlink';

export interface SkillInfo {
  presence: Presence;
  path: string;
  realPath?: string;
  linked: boolean;
  underOff: boolean;
  /** symlink target, for symlinked skills and dead links */
  target?: string;
  /** Runtime scope this cell comes from (project scans only). */
  scope?: RuntimeScope;
  /** Inherited cells reject mutations (ADR-0007: only the exact project dir is writable). */
  readOnly?: boolean;
}

export interface SkillRelationship {
  agent: string;
  name: string;
  info: SkillInfo;
  runtimeId: string;
  slot: string;
  scope?: RuntimeScope;
  readOnly?: boolean;
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
export type SortOrder = 'name' | 'status' | 'source';

function toInfo(
  relationship: RuntimeRelationship,
  runtime?: InventoryScanReport['runtimes'][number],
): SkillInfo {
  return {
    presence: relationship.realPath ? relationship.activation : 'deadlink',
    path: relationship.path,
    realPath: relationship.realPath,
    linked: relationship.form === 'link',
    underOff: relationship.activation === 'off',
    target: relationship.target,
    scope: runtime?.scope,
    readOnly: runtime ? !runtime.writable : undefined,
  };
}

/** One Skill × Target cell for a project scan: inherited ON wins unless the project is ON. */
function effectiveProjectRelationship(relationships: SkillRelationship[]): SkillRelationship {
  const project = relationships.find((relationship) => relationship.scope === 'project');
  const inheritedOn = relationships.find((relationship) =>
    relationship.scope !== 'project' && relationship.info.presence === 'on');
  if (project?.info.presence === 'on') return project;
  if (inheritedOn) return inheritedOn;
  return project ?? relationships[0];
}

export function viewAgents(report: InventoryScanReport): Agent[] {
  return report.runtimes.map((runtime) => ({
    name: runtime.key,
    dir: runtime.discoveryRoot,
  }));
}

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

/** Project one scan into matrix rows. Pure: no disk or state reads beyond the report. */
export function projectRows(report: InventoryScanReport): Row[] {
  const keys = new Map(report.runtimes.map((runtime) => [runtime.id, runtime.key]));
  const runtimeById = new Map(report.runtimes.map((runtime) => [runtime.id, runtime]));
  const provenanceBySlot = new Map(report.slots.map((slot) => [slot.id, slot.provenance]));
  const grouped = new Map<string, SkillInstance>();
  for (const relationship of report.relationships) {
    const id = relationship.realPath ?? `broken:${relationship.path}`;
    let instance = grouped.get(id);
    if (!instance) {
      instance = {
        id,
        name: relationship.name,
        displayName: relationship.name,
        realPath: relationship.realPath,
        description: readDescription(relationship.realPath),
        provenance: {},
        sourceLabel: 'Source unknown',
        relationships: [],
        agents: {},
      };
      grouped.set(id, instance);
    }
    const agent = keys.get(relationship.runtimeId) ?? relationship.runtimeKey;
    const runtime = runtimeById.get(relationship.runtimeId);
    // Discovery entries scan before parking entries, so ??= prefers ON.
    instance.agents[agent] ??= toInfo(relationship, runtime);
    instance.relationships.push({
      agent,
      name: relationship.name,
      info: toInfo(relationship, runtime),
      runtimeId: relationship.runtimeId,
      slot: relationship.slot,
      scope: runtime?.scope,
      readOnly: runtime ? !runtime.writable : undefined,
    });
  }

  if (report.scope === 'project') {
    for (const instance of grouped.values()) {
      const byAgent = new Map<string, SkillRelationship[]>();
      for (const relationship of instance.relationships) {
        const list = byAgent.get(relationship.agent) ?? [];
        list.push(relationship);
        byAgent.set(relationship.agent, list);
      }
      instance.relationships = [...byAgent.values()].map(effectiveProjectRelationship);
      instance.agents = Object.fromEntries(
        instance.relationships.map((relationship) => [relationship.agent, relationship.info]),
      );
    }
  }

  const instances = [...grouped.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  const counts = new Map<string, number>();
  for (const instance of instances)
    counts.set(instance.name, (counts.get(instance.name) ?? 0) + 1);

  for (const instance of instances) {
    const provenance = instance.relationships
      .map((relationship) =>
        provenanceBySlot.get(runtimeSlotId(relationship.runtimeId, relationship.slot)))
      .find((candidate) => candidate && Object.values(candidate).some(Boolean));
    instance.provenance = provenance ?? {};
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

function sourceSortValue(row: Row): string {
  return row.provenance.sourceUrl
    ?? row.provenance.source
    ?? row.provenance.skillPath
    ?? row.realPath
    ?? row.relationships.map(({ info }) => info.path).sort()[0]
    ?? row.displayName;
}

/** Match only the inventory metadata already loaded for a skill instance. */
export function matchesSearch(row: Row, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    row.name,
    row.displayName,
    row.description,
    row.provenance.source,
    row.provenance.sourceUrl,
    row.provenance.skillPath,
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

export function searchRows(rows: Row[], query: string): Row[] {
  return rows.filter((row) => matchesSearch(row, query));
}

/** Compare rows in a projection; callers provide its active status when needed. */
export function compareRows(
  a: Row,
  b: Row,
  sort: SortOrder,
  statusA = '',
  statusB = '',
): number {
  const primary = sort === 'name'
    ? a.displayName.localeCompare(b.displayName)
    : sort === 'source'
      ? sourceSortValue(a).localeCompare(sourceSortValue(b))
      : statusA.localeCompare(statusB);
  return primary || a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id);
}

export function sortRows(
  rows: Row[],
  sort: SortOrder,
  statusFor: (row: Row) => string = () => '',
): Row[] {
  return [...rows].sort((a, b) =>
    compareRows(a, b, sort, statusFor(a), statusFor(b)));
}

export function filterRows(
  rows: Row[],
  filter: { agent?: string; tag?: string },
  tags: Record<string, string[]>,
): Row[] {
  return rows.filter((r) => {
    if (filter.agent !== undefined && r.agents[filter.agent] === undefined)
      return false;
    if (filter.tag !== undefined && !(tags[r.id] ?? []).includes(filter.tag))
      return false;
    return true;
  });
}

export function untagged(rows: Row[], tags: Record<string, string[]>): string[] {
  return rows
    .filter((row) => (tags[row.id] ?? []).length === 0)
    .map((row) => row.displayName);
}

function stringListRecord(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, members]) =>
        Array.isArray(members) && members.every((member) => typeof member === 'string')),
  ) as Record<string, string[]>;
}

function presetRecord(value: unknown): Record<string, { selectors: string[] }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, preset]) =>
        Boolean(preset) && typeof preset === 'object' && !Array.isArray(preset) &&
        Array.isArray((preset as { selectors?: unknown }).selectors) &&
        (preset as { selectors: unknown[] }).selectors.every((s) => typeof s === 'string')),
  ) as Record<string, { selectors: string[] }>;
}

/** Tags, bundles, claims and preset definitions are catalog/policy metadata;
 *  unreadable or invalid state projects as empty. */
export function readViewState(home: Home): {
  bundles: Record<string, string[]>;
  tags: Record<string, string[]>;
  claims: Record<string, string[]>;
  presets: Record<string, { selectors: string[] }>;
} {
  try {
    const state = readStateFile(path.join(home.configDir, 'state.json'));
    return {
      bundles: stringListRecord(state.bundles),
      tags: stringListRecord(state.tags),
      claims: stringListRecord(state.claims),
      presets: presetRecord(state.presets),
    };
  } catch {
    return { bundles: {}, tags: {}, claims: {}, presets: {} };
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
  /** Project root when this is a project-scope snapshot (ADR-0010). */
  project?: string;
  catalog: {
    bundles: Record<string, string[]>;
    tags: Record<string, string[]>;
    claims: Record<string, string[]>;
    presets: Record<string, { selectors: string[] }>;
  };
}

/** Read the live disk state. Call again after every mutation (ADR-0001). */
export function tuiSnapshot(home: Home): TuiSnapshot {
  const report = scanGlobalInventory(home);
  return {
    agents: viewAgents(report),
    rows: projectRows(report),
    catalog: readViewState(home),
  };
}

/** Project-scope snapshot (ADR-0010): agent columns are the project runtimes only;
 *  rows are the project + parent + global union, inherited cells marked read-only. */
export function projectTuiSnapshot(home: Home, projectPath: string): TuiSnapshot {
  const report = scanProjectInventory(home, projectPath);
  return {
    agents: report.runtimes
      .filter((runtime) => runtime.scope === 'project')
      .map((runtime) => ({ name: runtime.key, dir: runtime.discoveryRoot })),
    rows: projectRows(report),
    catalog: readViewState(home),
    project: report.projectPath,
  };
}

/** Assemble detail for one explicit instance identity. */
export function skillDetail(
  home: Home,
  instanceId: string,
  projectPath?: string,
): SkillDetail | undefined {
  const report = projectPath
    ? scanProjectInventory(home, projectPath, undefined, { persist: false })
    : scanGlobalInventory(home, undefined, { persist: false });
  const rows = projectRows(report);
  const instance = rows.find(
    (candidate) => candidate.id === instanceId,
  );
  if (!instance) return undefined;

  const state = readViewState(home);
  const unambiguousName = rows.filter(
    (candidate) => candidate.name === instance.name,
  ).length === 1;
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
      .filter(([, members]) =>
        members.includes(instance.id) ||
        (unambiguousName && members.includes(instance.name)))
      .map(([bundle]) => bundle)
      .sort((a, b) => a.localeCompare(b)),
    tags: state.tags[instance.id] ?? [],
    content: contentPath ? fs.readFileSync(contentPath, 'utf8') : undefined,
    contentPath,
  };
}
