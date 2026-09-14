import fs from 'node:fs';
import path from 'node:path';
import type {Home} from './core.ts';
import {explainVisibility, explainVisibilityFromInventory} from './explain.ts';
import {
  hashDirectory,
  scanGlobalInventory,
  scanProjectInventory,
  type InventoryScanReport,
} from './inventory.ts';
import {
  normalizeNpxSkillsName,
  npxSkillsProvenanceLabel,
  readNpxSkillsLock,
  sameNpxSkillsSource,
} from './npx-skills.ts';
import type {NpxSkillsCandidate} from './npx-skills.ts';
import type {
  SharedCommandResult,
  SharedMutationPlan,
  SharedRemovalPlan,
  SharedUpdatePlan,
  SharedUpdateResult,
} from './shared.ts';
import {attachUpdateAvailability, projectRows} from './view.ts';
import type {Row, SkillRelationship, TuiSnapshot} from './view.ts';

export type SourceScope = 'global' | 'project';

/**
 * Source verification: the post-mutation, local, auditable conclusion about a
 * Source operation (add, replace, update, remove). Disk can change after
 * verification, so this is verified evidence at one moment — never a "final
 * truth".
 */
export interface SourceVerification {
  resource: string;
  provenance: string;
  slot: string;
  relationships: string[];
  actual: string;
  desired: string;
  drift: string;
  updateAvailability: string;
  effectiveVisibility: string;
}

export function sourceMirrorState(truth: SourceVerification): string {
  if (/mirror-diverged|diverged mirror/i.test(truth.drift)) return 'diverged';
  if (/mirror-sync/i.test(truth.drift)) return 'mirror-sync required';
  return truth.relationships.some((relationship) => /\smirror\//i.test(relationship))
    ? 'current'
    : 'none';
}

function sourceRelationshipActual(relationship: SkillRelationship): string {
  if (relationship.info.presence === 'deadlink') return 'broken';
  return relationship.info.underOff ? 'off' : 'on';
}

export function relationshipStatusText(info: SkillRelationship['info']): string {
  return `${info.presence === 'deadlink' ? 'BROKEN' : info.underOff ? 'OFF' : 'ON'} ${info.form}`;
}

export function sourceRelationships(row: Row | undefined): SkillRelationship[] {
  return (row?.observedRelationships ?? row?.relationships ?? [])
    .filter(({target}) => target === 'shared');
}

export function sourceInventoryRows(snapshot: TuiSnapshot): Row[] {
  return snapshot.rows.filter((row) => sourceRelationships(row).length > 0);
}

export function sourceDesiredTruth(
  home: Home,
  row: Row | undefined,
  scope: SourceScope,
  projectPath: string,
): {desired: string; drift: string} {
  if (!row) return {desired: 'not applicable', drift: 'not applicable'};
  const relationships = sourceRelationships(row);
  let state: Record<string, unknown> = {};
  try {
    const file = scope === 'global'
      ? path.join(home.configDir, 'state.json')
      : path.join(projectPath, '.skillspub', 'state.json');
    if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {desired: 'unknown', drift: 'unknown'};
  }
  const baseIntent = state.baseIntent && typeof state.baseIntent === 'object' && !Array.isArray(state.baseIntent)
    ? state.baseIntent as Record<string, unknown>
    : {};
  const claims = state.claims && typeof state.claims === 'object' && !Array.isArray(state.claims)
    ? state.claims as Record<string, unknown>
    : {};
  let observedDrift = false;
  const desired = relationships.map((relationship) => {
    const actual = relationship.info.underOff ? 'OFF' : 'ON';
    if (relationship.info.presence === 'deadlink' || relationship.info.diverged)
      observedDrift = true;
    if (relationship.readOnly) return `read-only ${actual}`;
    const slotId = `${relationship.targetId}\0${relationship.slot}`;
    let activation = actual;
    if (Array.isArray(claims[slotId]) && claims[slotId].length > 0) activation = 'ON';
    else if (baseIntent[slotId] === 'off') activation = 'OFF';
    else if (baseIntent[slotId] === 'on') activation = 'ON';
    if (activation !== actual) observedDrift = true;
    return activation;
  });
  return {
    desired: [...new Set(desired)].join('/') || 'unknown',
    drift: observedDrift ? 'observed' : 'none observed',
  };
}

function sourceVisibility(home: Home, row: Row | undefined, projectPath?: string): string {
  if (!row?.realPath) return 'unknown';
  try {
    const visibility = explainVisibility(home, `skill:${row.id}`, {projectPath});
    return [...new Set(visibility.harnesses.map(({effectiveVisibility}) => effectiveVisibility))].join('/');
  } catch {
    return 'unknown';
  }
}

/** Effective visibility derived from the same inventory evidence — no second scan. */
function sourceVisibilityFromInventory(
  home: Home,
  report: InventoryScanReport,
  row: Row | undefined,
  projectPath?: string,
): string {
  if (!row?.realPath) return 'unknown';
  try {
    const visibility = explainVisibilityFromInventory(home, report, `skill:${row.id}`, {projectPath});
    return [...new Set(visibility.harnesses.map(({effectiveVisibility}) => effectiveVisibility))].join('/');
  } catch {
    return 'unknown';
  }
}

type VisibilityOf = (row: Row | undefined) => string;

function deriveSourceVerification(
  home: Home,
  rows: Row[],
  plan: SharedMutationPlan | SharedRemovalPlan,
  scope: SourceScope,
  projectPath: string,
  visibilityOf: VisibilityOf,
): SourceVerification {
  const slot = plan.operation === 'shared.remove'
    ? plan.source.slot
    : plan.candidate?.normalizedSlot ?? plan.slots[0] ?? 'unknown';
  const row = rows.find((candidate) =>
    sourceRelationships(candidate).some((relationship) =>
      relationship.targetId === plan.targetId && relationship.slot === slot));
  const relationships = row?.observedRelationships ?? row?.relationships ?? [];
  const removalLockRemains = plan.operation === 'shared.remove' &&
    readNpxSkillsLock(plan.target.lockFile).some(({slot: lockSlot}) => lockSlot === slot);
  const removalDependenciesRemain = plan.operation === 'shared.remove'
    ? plan.dependencies.filter(({path: dependencyPath}) => fs.lstatSync(dependencyPath, {throwIfNoEntry: false}))
    : [];
  const removalSourceRemains = plan.operation === 'shared.remove' && Boolean(row);
  const desiredTruth = plan.operation === 'shared.remove'
    ? {
        desired: 'removed',
        drift: removalSourceRemains || removalLockRemains || removalDependenciesRemain.length > 0
          ? 'observed'
          : 'none',
      }
    : sourceDesiredTruth(home, row, scope, projectPath);
  const actual = relationships.map((relationship) =>
    `${relationship.targetId}/${relationship.slot}=${sourceRelationshipActual(relationship)}/${relationship.info.form}`);
  const driftEvidence = relationships.flatMap(({targetId, slot: relationshipSlot, info}) => {
    if (info.presence === 'deadlink') return [`${targetId}/${relationshipSlot}: broken`];
    if (info.diverged) return [`${targetId}/${relationshipSlot}: diverged mirror`];
    if (info.mirrored && row?.realPath) {
      try {
        if (hashDirectory(info.path) !== hashDirectory(row.realPath))
          return [`${targetId}/${relationshipSlot}: mirror-sync required`];
      } catch {
        return [`${targetId}/${relationshipSlot}: mirror truth unreadable`];
      }
    }
    return [];
  });
  if (plan.operation === 'shared.remove') {
    if (removalSourceRemains) driftEvidence.push('Shared source remains');
    if (removalLockRemains) driftEvidence.push('Vercel skills lock entry remains');
    for (const dependency of removalDependenciesRemain)
      driftEvidence.push(`dependent Relationship remains: ${dependency.targetId}/${dependency.slot}`);
  } else if (desiredTruth.drift === 'observed') driftEvidence.push('Actual differs from Desired');
  const mirrorDrift = driftEvidence.filter((item) => item.includes('mirror')).length;
  return {
    resource: row?.realPath ?? 'missing',
    provenance: row?.sourceLabel ?? (plan.operation === 'shared.remove'
      ? plan.source.provenance
      : 'Source unknown'),
    slot,
    relationships: relationships.map(({targetId, slot: relationshipSlot, info}) =>
      `${targetId}/${relationshipSlot} ${info.form}/${info.underOff ? 'off' : 'on'} ${info.path}`),
    actual: actual.join(', ') || `${plan.targetId}/${slot}=missing`,
    desired: desiredTruth.desired,
    drift: mirrorDrift > 0
      ? `mirror-sync required (${mirrorDrift}); ${driftEvidence.join(', ')}`
      : driftEvidence.join(', ') || 'none observed',
    updateAvailability: row?.updateAvailability?.status ?? 'unknown',
    effectiveVisibility: visibilityOf(row),
  };
}

export type CatalogCandidateState = 'installed' | 'replace' | 'occupied-unknown' | 'not-installed';

export interface CatalogCandidateTruth {
  state: CatalogCandidateState;
  actual: string;
  desired: string;
  drift: string;
  updateAvailability: string;
  relationships: number;
  effectiveVisibility: string;
}

/**
 * Current scope-local truth for a remote Catalog candidate, matched by its
 * normalized Slot against the latest snapshot. Non-writable (inherited)
 * relationships never count toward installed matching: an installation in one
 * isolated scope must not appear installed in the other.
 */
export function catalogCandidateTruth(
  home: Home,
  snapshot: TuiSnapshot,
  candidate: NpxSkillsCandidate | undefined,
  scope: SourceScope,
  projectPath: string,
): CatalogCandidateTruth | undefined {
  if (!candidate) return undefined;
  const slot = normalizeNpxSkillsName(candidate.name);
  const match = sourceInventoryRows(snapshot)
    .map((row) => ({
      row,
      relationships: sourceRelationships(row).filter((relationship) =>
        !relationship.readOnly && relationship.slot === slot),
    }))
    .find(({relationships}) => relationships.length > 0);
  if (!match) return {
    state: 'not-installed',
    actual: 'not installed',
    desired: 'not applicable',
    drift: 'not applicable',
    updateAvailability: 'unknown',
    relationships: 0,
    effectiveVisibility: 'not applicable',
  };
  const {row, relationships} = match;
  // Desired/Drift stay 'not applicable' for foreign Slots: ownership is not ours to derive.
  const provenanceKnown = npxSkillsProvenanceLabel(row.provenance) !== 'Source unknown';
  if (!provenanceKnown) return {
    state: 'occupied-unknown',
    actual: 'Slot occupied — Source unknown; no ownership assumed',
    desired: 'not applicable',
    drift: 'not applicable',
    updateAvailability: 'unknown',
    relationships: sourceRelationships(row).length,
    effectiveVisibility: 'unknown',
  };
  if (!sameNpxSkillsSource(candidate.source, candidate.name, row.provenance)) return {
    state: 'replace',
    actual: `occupied by ${row.sourceLabel} — Replace required`,
    desired: 'not applicable',
    drift: 'not applicable',
    updateAvailability: row.updateAvailability?.status ?? 'unknown',
    relationships: sourceRelationships(row).length,
    effectiveVisibility: 'unknown',
  };
  const desiredTruth = sourceDesiredTruth(home, row, scope, projectPath);
  return {
    state: 'installed',
    actual: relationships.map(({info}) => relationshipStatusText(info)).join(', '),
    desired: desiredTruth.desired,
    drift: desiredTruth.drift,
    updateAvailability: row.updateAvailability?.status ?? 'unknown',
    relationships: sourceRelationships(row).length,
    effectiveVisibility: sourceVisibility(home, row, scope === 'project' ? projectPath : undefined),
  };
}

function deriveUpdateVerification(
  sourceRows: Row[],
  plan: SharedUpdatePlan,
  result: SharedUpdateResult,
  visibilityOf: VisibilityOf,
): SourceVerification {
  const rows = result.items.map((item) => ({
    item,
    row: sourceRows.find((candidate) =>
      sourceRelationships(candidate).some(({targetId, slot}) =>
        targetId === plan.targetId && slot === item.slot)),
  }));
  const relationshipRows = rows.flatMap(({row}) =>
    (row?.observedRelationships ?? row?.relationships ?? []).map((relationship) => ({row, relationship})));
  const relationships = relationshipRows.map(({relationship}) => relationship);
  const visibility = rows.map(({item, row}) =>
    `${item.name}=${visibilityOf(row)}`);
  const actual = relationships.map((relationship) =>
    `${relationship.targetId}/${relationship.slot}=${sourceRelationshipActual(relationship)}/${relationship.info.form}`);
  const observedDrift = relationshipRows.flatMap(({row, relationship: {targetId, slot, info}}) => {
    if (info.presence === 'deadlink') return [`${targetId}/${slot}: broken`];
    if (info.diverged) return [`${targetId}/${slot}: mirror-diverged`];
    if (info.mirrored && row?.realPath) {
      try {
        if (hashDirectory(info.path) !== hashDirectory(row.realPath))
          return [`${targetId}/${slot}: mirror-sync`];
      } catch {
        return [`${targetId}/${slot}: mirror truth unreadable`];
      }
    }
    return [];
  });
  return {
    resource: rows.map(({row}) => row?.realPath ?? 'missing').join(', '),
    provenance: rows.map(({item, row}) => `${item.name}=${row?.sourceLabel ?? 'Source unknown'}`).join(', '),
    slot: result.items.map(({slot}) => slot).join(', '),
    relationships: relationships.map(({targetId, slot, info}) =>
      `${targetId}/${slot} ${info.form}/${info.underOff ? 'off' : 'on'} ${info.path}`),
    actual: actual.join(', ') || result.actual,
    desired: plan.items.map(({name, desired}) => `${name}=${desired}`).join(', '),
    drift: [...new Set([...result.drift, ...observedDrift])].join(', ') || 'none',
    updateAvailability: rows.map(({item, row}) =>
      `${item.name}=${row?.updateAvailability?.status ?? 'unknown'}${row?.updateAvailability?.checkedAt ? ` @ ${row.updateAvailability.checkedAt}` : ''}`).join(', '),
    effectiveVisibility: visibility.join(', '),
  };
}

/**
 * Verify a Source mutation (add, replace, update, remove) through exactly one
 * fresh post-mutation inventory scan per invocation. Actual state, Desired
 * state, Drift, Update availability, provenance, Relationships, and Effective
 * visibility are all derived from that same inventory evidence. Fail-soft:
 * unavailable evidence is reported as explicit unknown values, never as
 * success.
 */
export function verifySourceMutation(
  home: Home,
  plan: SharedMutationPlan | SharedUpdatePlan | SharedRemovalPlan,
  result: SharedCommandResult | SharedUpdateResult,
  projectPath?: string,
): SourceVerification {
  const scope = plan.scope?.kind ?? 'global';
  const exactProjectPath = projectPath ?? plan.scope?.path ?? process.cwd();
  try {
    const report = scope === 'project'
      ? scanProjectInventory(home, exactProjectPath, undefined, {persist: false})
      : scanGlobalInventory(home, undefined, {persist: false});
    const rows = attachUpdateAvailability(projectRows(report), home, report)
      .filter((row) => sourceRelationships(row).length > 0);
    const visibilityOf: VisibilityOf = (row) =>
      sourceVisibilityFromInventory(home, report, row, scope === 'project' ? exactProjectPath : undefined);
    return 'items' in plan
      ? deriveUpdateVerification(rows, plan, result as SharedUpdateResult, visibilityOf)
      : deriveSourceVerification(home, rows, plan, scope, exactProjectPath, visibilityOf);
  } catch {
    return {
      resource: 'unknown',
      provenance: 'Source unknown',
      slot: 'items' in plan
        ? plan.items.map(({slot}) => slot).join(', ')
        : plan.slots.join(', '),
      relationships: [],
      actual: result.actual,
      desired: 'unknown',
      drift: result.drift.join(', ') || 'rescan unavailable',
      updateAvailability: 'unknown',
      effectiveVisibility: 'unknown',
    };
  }
}
