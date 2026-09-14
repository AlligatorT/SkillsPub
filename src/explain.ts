import fs from 'node:fs';
import path from 'node:path';
import type { Home } from './core.ts';
import {
  loadTargets,
  normalizeSlotName,
  scanGlobalInventory,
  scanProjectInventory,
  readStateFile,
  type InventoryResource,
  type InventoryScanReport,
  type TargetRelationship,
  type TargetScope,
} from './inventory.ts';
import { inspectHarnesses } from './harnesses/registry.ts';
import type { HarnessInspection } from './harnesses/types.ts';

export type EffectiveVisibility = 'visible' | 'not-visible' | 'unknown' | 'conflicted';
export type WantedVisibility = 'visible' | 'hidden';

type RootConsumption = 'consumed' | 'excluded' | 'unknown';
type RootKind = 'harness' | 'shared' | 'compatibility';

export interface ExplainMessage {
  code: string;
  message: string;
}

export interface ExplainRelationship {
  resourceId?: string;
  realPath?: string;
  slot: string;
  activation: TargetRelationship['activation'];
  form: TargetRelationship['form'];
  path: string;
  selected: boolean;
}

export interface ExplainRoot {
  id: string;
  targetKey: string;
  scope: TargetScope;
  kind: RootKind;
  path: string;
  consumption: RootConsumption;
  reason: string;
  relationships: ExplainRelationship[];
}

export interface ExplainStep {
  operation: 'activate' | 'create-link' | 'create-mirror' | 'deactivate';
  targetId: string;
  targetKey: string;
  slot: string;
  from: 'on' | 'off' | 'missing';
  to: 'on' | 'off';
  form?: TargetRelationship['form'];
  path?: string;
  preconditions: ExplainMessage[];
}

export interface ExplainPlan {
  executable: boolean;
  steps: ExplainStep[];
  blockers: ExplainMessage[];
}

export interface HarnessVisibilityExplanation {
  key: string;
  name: string;
  detected: boolean;
  support: HarnessInspection['support'];
  evidence: HarnessInspection['evidence'];
  sharedConsumption: HarnessInspection['sharedConsumption'];
  isolation: HarnessInspection['isolation'];
  effectiveVisibility: EffectiveVisibility;
  roots: ExplainRoot[];
  reasons: ExplainMessage[];
  warnings: ExplainMessage[];
  conflicts: Array<ExplainMessage & { resourceId: string; realPath: string }>;
  plan?: ExplainPlan;
}

export interface VisibilityExplanation {
  resource: { id: string; name: string; realPath: string };
  scope: { kind: InventoryScanReport['scope']; projectPath?: string };
  wanted?: WantedVisibility;
  harnesses: HarnessVisibilityExplanation[];
}

export class ExplainError extends Error {
  readonly code: 'ambiguous_selector' | 'installed_resource_not_found' | 'unknown_harness';
  readonly details: Record<string, unknown>;

  constructor(
    code: 'ambiguous_selector' | 'installed_resource_not_found' | 'unknown_harness',
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function resolveResource(report: InventoryScanReport, selector: string): InventoryResource {
  const matches = selector.startsWith('skill:')
    ? report.resources.filter(({ realPath }) => realPath === selector.slice('skill:'.length))
    : report.resources.filter(({ name }) => name === selector);
  if (matches.length === 0)
    throw new ExplainError(
      'installed_resource_not_found',
      `installed Skill resource not found: ${selector}`,
      { selector },
    );
  if (matches.length > 1) {
    const variants = matches.map(({ id, name, realPath }) => ({
      name,
      resourceId: id,
      realPath,
      selector: `skill:${realPath}`,
    }));
    throw new ExplainError(
      'ambiguous_selector',
      `skill name "${selector}" is ambiguous; use an explicit skill:<realPath> selector`,
      { name: selector, matches: variants },
    );
  }
  return matches[0];
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function directRelationship(
  root: string,
  resource: InventoryResource,
): { relationships: ExplainRelationship[]; error?: string } {
  const entry = path.join(root, normalizeSlotName(resource.name));
  try {
    const stat = fs.lstatSync(entry);
    const realPath = fs.realpathSync(entry);
    if (!fs.existsSync(path.join(realPath, 'SKILL.md'))) return { relationships: [] };
    return { relationships: [{
      resourceId: realPath,
      realPath,
      slot: normalizeSlotName(resource.name),
      activation: 'on',
      form: stat.isSymbolicLink() ? 'link' : 'local',
      path: entry,
      selected: realPath === resource.realPath,
    }] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { relationships: [] };
    return { relationships: [], error: (error as Error).message };
  }
}

function explainRoots(
  report: InventoryScanReport,
  resource: InventoryResource,
  harness: HarnessInspection,
): ExplainRoot[] {
  return harness.roots.map((root) => {
    const target = report.targets.find((candidate) =>
      candidate.key === root.targetKey && candidate.scope === root.scope &&
      canonicalPath(candidate.discoveryRoot) === canonicalPath(root.discoveryRoot));
    const direct = target ? undefined : directRelationship(root.discoveryRoot, resource);
    const relationships = target
      ? report.relationships
        .filter(({ targetId, slot }) =>
          targetId === target.id && slot === normalizeSlotName(resource.name))
        .map((relationship) => ({
          resourceId: relationship.resourceId,
          realPath: relationship.realPath,
          slot: relationship.slot,
          activation: relationship.activation,
          form: relationship.form,
          path: relationship.path,
          selected: relationship.resourceId === resource.id,
        }))
      : direct?.relationships ?? [];
    return {
      id: target?.id ?? `external:${harness.key}:${root.targetKey}:${root.scope}:${root.discoveryRoot}`,
      targetKey: root.targetKey,
      scope: root.scope,
      kind: root.kind,
      path: root.discoveryRoot,
      consumption: direct?.error ? 'unknown' : root.consumption,
      reason: direct?.error ? `${root.reason} Inspection failed: ${direct.error}` : root.reason,
      relationships,
    };
  });
}

function stateFileForTarget(
  home: Home,
  report: InventoryScanReport,
  targetId: string,
): string {
  const target = report.targets.find(({ id }) => id === targetId);
  if (!target || target.scope === 'global') return path.join(home.configDir, 'state.json');
  if (target.scope === 'project') return report.stateFile;
  return path.join(target.sourceDirectory ?? '', '.skillspub', 'state.json');
}

function presetClaimStatus(
  home: Home,
  report: InventoryScanReport,
  targetId: string,
  slot: string,
): 'claimed' | 'unclaimed' | 'unknown' {
  const claims = readStateFile(stateFileForTarget(home, report, targetId)).claims;
  if (claims === undefined) return 'unclaimed';
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return 'unknown';
  const value = (claims as Record<string, unknown>)[`${targetId}\0${slot}`];
  if (value === undefined) return 'unclaimed';
  if (!Array.isArray(value) || value.some((claim) => typeof claim !== 'string')) return 'unknown';
  return value.length > 0 ? 'claimed' : 'unclaimed';
}

function planVisibility(
  home: Home,
  report: InventoryScanReport,
  resource: InventoryResource,
  harness: HarnessInspection,
  explanation: HarnessVisibilityExplanation,
  wanted: WantedVisibility,
): ExplainPlan {
  const blockers: ExplainMessage[] = [];
  if (!harness.detected)
    blockers.push({ code: 'harness_not_detected', message: `${harness.name} is not detected.` });
  if (harness.support !== 'managed')
    blockers.push({ code: 'support_incomplete', message: `${harness.name} support is not managed.` });
  if (explanation.effectiveVisibility === 'unknown')
    blockers.push({ code: 'visibility_unknown', message: 'Effective visibility is unknown; no safe plan can be produced.' });
  if (explanation.conflicts.length > 0)
    blockers.push({ code: 'unresolved_variant', message: 'Resolve same-name Variants before changing visibility.' });
  if (blockers.length > 0) return { executable: false, steps: [], blockers };

  if (wanted === 'visible') {
    if (explanation.effectiveVisibility === 'visible')
      return { executable: true, steps: [], blockers: [] };
    const target = report.targets.find((candidate) =>
      candidate.key === harness.key && candidate.writable &&
      (report.scope === 'global' ? candidate.scope === 'global' : candidate.scope === 'project'));
    if (!target)
      return {
        executable: false,
        steps: [],
        blockers: [{ code: 'no_writable_target', message: `No writable ${harness.name} Target exists in this scope.` }],
      };
    const slotName = normalizeSlotName(resource.name);
    const relationships = report.relationships.filter(({ targetId, slot }) =>
      targetId === target.id && slot === slotName);
    const selected = relationships.find(({ resourceId }) => resourceId === resource.id);
    if (!selected && relationships.length > 0)
      return {
        executable: false,
        steps: [],
        blockers: [{ code: 'target_slot_occupied', message: `${target.id}/${resource.name} is occupied by another Variant.` }],
      };
    const form = harness.link.supported ? 'link' : harness.mirror?.supported ? 'mirror' : undefined;
    if (!selected && !form)
      return {
        executable: false,
        steps: [],
        blockers: [{ code: 'unsupported_resource_form', message: `${harness.name} cannot safely create this Relationship.` }],
      };
    let operation: ExplainStep['operation'] = 'activate';
    if (!selected) operation = form === 'mirror' ? 'create-mirror' : 'create-link';
    const from = selected?.activation ?? 'missing';
    const step: ExplainStep = {
      operation,
      targetId: target.id,
      targetKey: target.key,
      slot: slotName,
      from,
      to: 'on',
      preconditions: [
        { code: 'resource_identity', message: `Resource must remain ${resource.realPath}.` },
        { code: 'target_slot_state', message: `${target.id}/${slotName} must remain ${from}.` },
      ],
    };
    const stepForm = selected?.form ?? form;
    if (stepForm) step.form = stepForm;
    if (selected) step.path = selected.path;
    return { executable: true, steps: [step], blockers: [] };
  }

  if (explanation.effectiveVisibility === 'not-visible')
    return { executable: true, steps: [], blockers: [] };
  const steps: ExplainStep[] = [];
  for (const root of explanation.roots.filter(({ consumption }) => consumption === 'consumed')) {
    for (const relationship of root.relationships.filter(({ selected, activation }) => selected && activation === 'on')) {
      if (root.kind !== 'harness') {
        blockers.push({
          code: 'cross_harness_side_effect',
          message: `Hiding ${root.path}/${relationship.slot} would affect other consumers of this ${root.kind} root.`,
        });
        continue;
      }
      const target = report.targets.find(({ id }) => id === root.id);
      if (!target?.writable) {
        blockers.push({
          code: 'read_only_contributing_root',
          message: `${root.path} is inherited and read-only in this scope.`,
        });
        continue;
      }
      const claimStatus = presetClaimStatus(home, report, root.id, relationship.slot);
      if (claimStatus === 'unknown') {
        blockers.push({
          code: 'unknown_preset_claims',
          message: `Preset claims for ${root.id}/${relationship.slot} cannot be confirmed.`,
        });
        continue;
      }
      if (claimStatus === 'claimed') {
        blockers.push({
          code: 'active_preset_claim',
          message: `An active Preset claims ${root.id}/${relationship.slot} ON.`,
        });
        continue;
      }
      steps.push({
        operation: 'deactivate',
        targetId: root.id,
        targetKey: root.targetKey,
        slot: relationship.slot,
        from: 'on',
        to: 'off',
        form: relationship.form,
        path: relationship.path,
        preconditions: [
          { code: 'resource_identity', message: `Resource must remain ${resource.realPath}.` },
          { code: 'target_slot_state', message: `${root.id}/${relationship.slot} must remain on.` },
          { code: 'preset_claims_absent', message: `${root.id}/${relationship.slot} must remain free of Preset claims.` },
        ],
      });
    }
  }
  return { executable: blockers.length === 0, steps: blockers.length === 0 ? steps : [], blockers };
}

function explainHarness(
  home: Home,
  report: InventoryScanReport,
  resource: InventoryResource,
  harness: HarnessInspection,
  wanted?: WantedVisibility,
): HarnessVisibilityExplanation {
  const roots = explainRoots(report, resource, harness);
  const consumed = roots.filter(({ consumption }) => consumption === 'consumed');
  const unknownRoots = roots.filter(({ consumption }) => consumption === 'unknown');
  const conflicts = consumed.flatMap((root) => root.relationships
    .filter((relationship) =>
      relationship.slot === normalizeSlotName(resource.name) &&
      relationship.resourceId !== resource.id && relationship.activation === 'on')
    .map((relationship) => ({
      code: 'same_name_variant',
      message: `${relationship.realPath} competes in consumed root ${root.path}.`,
      resourceId: relationship.resourceId ?? relationship.realPath ?? relationship.path,
      realPath: relationship.realPath ?? relationship.path,
    })));
  const selectedRoots = consumed.filter((root) => root.relationships.some((relationship) =>
    relationship.selected && relationship.activation === 'on'));
  let effectiveVisibility: EffectiveVisibility;
  if (!harness.detected || harness.support !== 'managed') effectiveVisibility = 'unknown';
  else if (conflicts.length > 0) effectiveVisibility = 'conflicted';
  else if (unknownRoots.length > 0) effectiveVisibility = 'unknown';
  else effectiveVisibility = selectedRoots.length > 0 ? 'visible' : 'not-visible';

  const reasons: ExplainMessage[] = [];
  if (!harness.detected)
    reasons.push({ code: 'harness_not_detected', message: `${harness.name} was not detected locally.` });
  if (harness.support !== 'managed')
    reasons.push({ code: 'support_incomplete', message: `${harness.name} support is ${harness.support}.` });
  for (const root of selectedRoots)
    reasons.push({ code: 'relationship_consumed', message: `Selected resource is ON in ${root.path}.` });
  for (const root of unknownRoots)
    reasons.push({ code: 'root_unknown', message: `Consumption cannot be confirmed for ${root.path}.` });
  if (effectiveVisibility === 'not-visible')
    reasons.push({ code: 'no_consumed_relationship', message: 'No consumed root has an ON Relationship to the selected resource.' });

  const explanation: HarnessVisibilityExplanation = {
    key: harness.key,
    name: harness.name,
    detected: harness.detected,
    support: harness.support,
    evidence: harness.evidence,
    sharedConsumption: harness.sharedConsumption,
    isolation: harness.isolation,
    effectiveVisibility,
    roots,
    reasons,
    warnings: harness.detected ? [{
      code: 'local_version_unknown',
      message: `Local ${harness.name} version was not confirmed; discovery semantics use the Adapter's verified evidence.`,
    }] : [],
    conflicts,
  };
  if (wanted)
    explanation.plan = planVisibility(home, report, resource, harness, explanation, wanted);
  return explanation;
}

export function explainVisibilityFromInventory(
  home: Home,
  report: InventoryScanReport,
  selector: string,
  options: { projectPath?: string; harness?: string; want?: WantedVisibility } = {},
  inspected = inspectHarnesses(home, report.targets, report.projectPath),
): VisibilityExplanation {
  const resource = resolveResource(report, selector);
  let harnesses = [...inspected.detected, ...inspected.available];
  if (options.harness) {
    harnesses = harnesses.filter(({ key }) => key === options.harness);
    if (harnesses.length === 0)
      throw new ExplainError('unknown_harness', `unknown Harness: ${options.harness}`, {
        harness: options.harness,
      });
  }
  return {
    resource: { id: resource.id, name: resource.name, realPath: resource.realPath },
    scope: { kind: report.scope, ...(report.projectPath ? { projectPath: report.projectPath } : {}) },
    ...(options.want ? { wanted: options.want } : {}),
    harnesses: harnesses.map((harness) => explainHarness(home, report, resource, harness, options.want)),
  };
}

export function explainVisibility(
  home: Home,
  selector: string,
  options: { projectPath?: string; harness?: string; want?: WantedVisibility } = {},
): VisibilityExplanation {
  const targets = loadTargets(home);
  const report = options.projectPath
    ? scanProjectInventory(home, options.projectPath, targets, { persist: false })
    : scanGlobalInventory(home, targets, { persist: false });
  return explainVisibilityFromInventory(home, report, selector, options);
}
