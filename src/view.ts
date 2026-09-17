import fs from 'node:fs';
import path from 'node:path';
import type { Home } from './core.ts';
import { inspectHarnesses } from './harnesses/registry.ts';
import type { HarnessInspection } from './harnesses/types.ts';
import {
  sharedOutdatedFromInventory,
  type SharedUpdateAvailabilityEntry,
} from './shared.ts';
import {
  readStateFile,
  targetSlotId,
  pendingTargetDefinitions,
  scanGlobalInventory,
  scanProjectInventory,
  type InventoryScanReport,
  type TargetRelationship,
  type TargetScope,
  type ResourceForm,
  type SkillProvenance,
} from './inventory.ts';

// --- view projection: InventoryScanReport -> skill × target matrix rows ---
// The matrix is a projection of the one inventory scan (ADR-0007); target
// columns are Target keys, presence comes from Relationship activation.

export interface Target {
  name: string;
  dir: string;
}

export function harnessStatusBadge(
  harness: Pick<HarnessInspection, 'support' | 'isolation'> & {
    sharedConsumption?: HarnessInspection['sharedConsumption'];
  },
): {text: string; tone: 'success' | 'muted' | 'warning' | 'danger'} {
  const required = projectSharedConsumption(harness).badge;
  if (required) return required;
  if (harness.support !== 'managed') return {text: `[${harness.support}]`, tone: 'muted'};
  if (harness.isolation.status === 'managed' || harness.isolation.status === 'not-required')
    return {text: '[managed]', tone: 'success'};
  if (harness.isolation.status === 'unmanaged') return {text: '[manageable]', tone: 'muted'};
  return harness.isolation.status === 'drift'
    ? {text: '[drift]', tone: 'danger'}
    : {text: '[unknown]', tone: 'warning'};
}

// --- Required Shared consumption (issue #165) ---
// Existing vocabulary only: Shared consumption = required. Isolatable Harnesses unchanged.

export interface SharedConsumptionProjection {
  required: boolean;
  badge?: {text: string; tone: 'warning'};
  /** Compact matrix/info suffix. Empty when isolatable. */
  visibilityNote: string;
  /** Why this Harness will read the Skill, and the isolation boundary. */
  lines: string[];
}

/** Honest matrix/explain presentation for required global Shared consumption. */
export function projectSharedConsumption(
  harness: {
    sharedConsumption?: {status: string; detail: string};
  },
): SharedConsumptionProjection {
  if (harness.sharedConsumption?.status !== 'required')
    return {required: false, visibilityNote: '', lines: []};
  return {
    required: true,
    badge: {text: '[required]', tone: 'warning'},
    visibilityNote: ' · Shared consumption required',
    lines: [
      `Shared consumption: required — ${harness.sharedConsumption.detail}`,
      'Isolation: cannot exclude the global Shared Skill Target',
    ],
  };
}

export type Presence = 'on' | 'off' | 'deadlink';

// --- Source tab information layering (issue #167, spec #164) ---
// 用户态 default layer: decision-useful info only (能否更新、版本差异、来源链接).
// 开发态 developer layer: hash/path-resolution/download/lock-cache detail, shown
// in the TUI detail expansion layer; CLI --json remains the full-fidelity contract.

export interface SourceLayerInput {
  kind: 'candidate' | 'resource';
  name: string;
  /** 来源链接/label shown in the default layer. */
  sourceLabel: string;
  /** Update availability status (能否更新/版本差异), preformatted by the caller. */
  update: string;
  actual: string;
  desired: string;
  drift: string;
  relationships: number;
  effectiveVisibility: string;
  /** 开发态: stable identity (realPath or source@name). */
  identity: string;
  /** 开发态: resolved on-disk path (resources only). */
  realPath?: string;
  /** 开发态: update check error detail. */
  updateError?: string;
  /** 开发态: extra detail lines (Slot/path resolution, installs, per-Relationship paths). */
  details: string[];
}

export interface SourceLayers {
  /** 用户态 status strip (default Source surface bottom block). */
  status: {selected: string; truth: string};
  /** 用户态 panel lines (default Source surface). */
  user: string[];
  /** 开发态 full detail (expansion layer); a superset of the user layer. */
  developer: string[];
}

/** Split Source tab information into 用户态/开发态 layers. Pure projection. */
export function projectSourceLayers(input: SourceLayerInput): SourceLayers {
  return {
    status: {
      selected: `Selected: ${input.name} · ${input.sourceLabel}  Actual: ${input.actual}  Desired: ${input.desired}`,
      truth: `Drift: ${input.drift}  Update: ${input.update}  Relationship: ${input.relationships}  Effective Visibility: ${input.effectiveVisibility}`,
    },
    user: [
      `Name: ${input.name}`,
      `Source: ${input.sourceLabel}`,
      `Update: ${input.update}`,
      `State: ${input.actual} · desired: ${input.desired} · drift: ${input.drift}`,
      `Visibility: ${input.effectiveVisibility}`,
    ],
    developer: [
      `Identity: ${input.identity}`,
      `Name: ${input.name}`,
      `Provenance: ${input.sourceLabel}`,
      ...(input.kind === 'resource' ? [`Real path: ${input.realPath ?? 'unresolved'}`] : []),
      `Update availability: ${input.update}`,
      ...(input.updateError ? [`Update check: ${input.updateError}`] : []),
      `State: ${input.actual} · desired: ${input.desired} · drift: ${input.drift}`,
      `Effective visibility: ${input.effectiveVisibility}`,
      `Relationships: ${input.relationships}`,
      ...input.details,
    ],
  };
}

export interface SkillInfo {
  presence: Presence;
  path: string;
  realPath?: string;
  form: ResourceForm;
  linked: boolean;
  mirrored: boolean;
  diverged: boolean;
  underOff: boolean;
  /** symlink target, for symlinked skills and dead links */
  target?: string;
  /** Target scope this cell comes from (project scans only). */
  scope?: TargetScope;
  /** Inherited cells reject mutations (ADR-0007: only the exact project dir is writable). */
  readOnly?: boolean;
}

export interface SkillRelationship {
  target: string;
  name: string;
  info: SkillInfo;
  targetId: string;
  slot: string;
  scope?: TargetScope;
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
  updateAvailability?: SharedUpdateAvailabilityEntry;
  relationships: SkillRelationship[];
  /** Every scanned Relationship, before the Project matrix collapses inherited cells. */
  observedRelationships?: SkillRelationship[];
  targets: Record<string, SkillInfo | undefined>;
}

export type Row = SkillInstance;
export type SortOrder = 'name' | 'status' | 'source';

function toInfo(
  relationship: TargetRelationship,
  target?: InventoryScanReport['targets'][number],
): SkillInfo {
  return {
    presence: relationship.realPath ? relationship.activation : 'deadlink',
    path: relationship.path,
    realPath: relationship.realPath,
    form: relationship.form,
    linked: relationship.form === 'link',
    mirrored: relationship.form === 'mirror',
    diverged: relationship.diverged === true,
    underOff: relationship.activation === 'off',
    target: relationship.target,
    scope: target?.scope,
    readOnly: target ? !target.writable : undefined,
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

export function viewTargets(report: InventoryScanReport): Target[] {
  return report.targets.map((target) => ({
    name: target.key,
    dir: target.discoveryRoot,
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
  const keys = new Map(report.targets.map((target) => [target.id, target.key]));
  const targetById = new Map(report.targets.map((target) => [target.id, target]));
  const provenanceBySlot = new Map(report.slots.map((slot) => [slot.id, slot.provenance]));
  const grouped = new Map<string, SkillInstance>();
  for (const relationship of report.relationships) {
    const id = relationship.resourceId ?? relationship.realPath ?? `broken:${relationship.path}`;
    let instance = grouped.get(id);
    if (!instance) {
      instance = {
        id,
        name: relationship.name,
        displayName: relationship.name,
        realPath: relationship.resourceId ?? relationship.realPath,
        description: readDescription(relationship.realPath),
        provenance: {},
        sourceLabel: 'Source unknown',
        relationships: [],
        targets: {},
      };
      grouped.set(id, instance);
    }
    const targetName = keys.get(relationship.targetId) ?? relationship.targetKey;
    const target = targetById.get(relationship.targetId);
    // Discovery entries scan before parking entries, so ??= prefers ON.
    instance.targets[targetName] ??= toInfo(relationship, target);
    instance.relationships.push({
      target: targetName,
      name: relationship.name,
      info: toInfo(relationship, target),
      targetId: relationship.targetId,
      slot: relationship.slot,
      scope: target?.scope,
      readOnly: target ? !target.writable : undefined,
    });
  }

  if (report.scope === 'project') {
    for (const instance of grouped.values()) {
      instance.observedRelationships = instance.relationships;
      const byTarget = new Map<string, SkillRelationship[]>();
      for (const relationship of instance.relationships) {
        const list = byTarget.get(relationship.target) ?? [];
        list.push(relationship);
        byTarget.set(relationship.target, list);
      }
      instance.relationships = [...byTarget.values()].map(effectiveProjectRelationship);
      instance.targets = Object.fromEntries(
        instance.relationships.map((relationship) => [relationship.target, relationship.info]),
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
        provenanceBySlot.get(targetSlotId(relationship.targetId, relationship.slot)))
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
  filter: { target?: string; tag?: string },
  tags: Record<string, string[]>,
): Row[] {
  return rows.filter((r) => {
    if (filter.target !== undefined && r.targets[filter.target] === undefined)
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
  targets: Record<string, SkillInfo | undefined>;
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
  targets: Target[];
  harnesses: ReturnType<typeof inspectHarnesses>;
  pendingTargetKeys: string[];
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

const snapshotInventories = new WeakMap<TuiSnapshot, InventoryScanReport>();

/** Reuse the exact inventory evidence that produced a TUI snapshot. */
export function tuiSnapshotInventory(snapshot: TuiSnapshot): InventoryScanReport | undefined {
  return snapshotInventories.get(snapshot);
}

function rememberInventory(snapshot: TuiSnapshot, report: InventoryScanReport): TuiSnapshot {
  snapshotInventories.set(snapshot, report);
  return snapshot;
}

export function attachUpdateAvailability(
  rows: Row[],
  home: Home,
  report: InventoryScanReport,
): Row[] {
  try {
    const bySlot = new Map(sharedOutdatedFromInventory(home, report).entries.map((entry) => [entry.slot, entry]));
    for (const row of rows) {
      const shared = row.relationships.find((relationship) =>
        relationship.target === 'shared' &&
        relationship.scope === report.scope);
      row.updateAvailability = shared ? bySlot.get(shared.slot) : undefined;
    }
  } catch {
    // A missing/unreadable installer lock is not an Inventory failure.
  }
  return rows;
}

function visibleTargets(
  report: InventoryScanReport,
  harnesses: ReturnType<typeof inspectHarnesses>,
): Target[] {
  const detected = new Set(harnesses.detected.map(({ key }) => key));
  return report.targets
    .filter(({ kind, key }) => kind !== 'harness' || detected.has(key))
    .map((target) => ({ name: target.key, dir: target.discoveryRoot }));
}

/** Read the live disk state. Call again after every mutation (ADR-0001). */
export function tuiSnapshot(home: Home): TuiSnapshot {
  const report = scanGlobalInventory(home, undefined, { persist: false });
  const harnesses = inspectHarnesses(home, report.targets);
  return rememberInventory({
    targets: visibleTargets(report, harnesses),
    harnesses,
    pendingTargetKeys: pendingTargetDefinitions(home).map(({ key }) => key),
    rows: attachUpdateAvailability(projectRows(report), home, report),
    catalog: readViewState(home),
  }, report);
}

/** Project-scope snapshot (ADR-0010): target columns are the project targets only;
 *  rows are the project + parent + global union, inherited cells marked read-only. */
export function projectTuiSnapshot(home: Home, projectPath: string): TuiSnapshot {
  const report = scanProjectInventory(home, projectPath, undefined, { persist: false });
  const harnesses = inspectHarnesses(home, report.targets, report.projectPath);
  return rememberInventory({
    targets: visibleTargets(
      { ...report, targets: report.targets.filter((target) => target.scope === 'project') },
      harnesses,
    ),
    harnesses,
    pendingTargetKeys: pendingTargetDefinitions(home).map(({ key }) => key),
    rows: attachUpdateAvailability(projectRows(report), home, report),
    catalog: readViewState(home),
    project: report.projectPath,
  }, report);
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
    targets: instance.targets,
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
