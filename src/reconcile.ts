import fs from 'node:fs';
import path from 'node:path';
import type { Home } from './core.ts';
import {
  normalizeSlotName,
  readStateFile,
  targetSlotId,
  scanGlobalInventory,
  scanProjectInventory,
  writeStateFile,
  type Activation,
  type InventoryResource,
  type InventoryScanReport,
  type TargetRelationship,
  type ScannedTarget,
} from './inventory.ts';
import {
  assertPresetName,
  expandSelector,
  readBundles,
  readPresets,
  readState,
  readTags,
  statePath,
  writeState,
  type CatalogState,
} from './catalog.ts';

export interface PresetScope {
  projectPath?: string;
}

export interface PresetReconcilePlan extends ActivationPlan {
  claims: Record<string, string[]>;
  lastClaims: Record<string, string[]>;
  presetActivations: Record<string, string[]>;
  baseIntentDefaults: Record<string, Activation>;
}

export interface ActivationTarget {
  slotId: string;
  targetId: string;
  targetKey: string;
  slot: string;
  /** Skill resource identity; empty for a broken-link-only target. */
  resourceId: string;
  from: Activation | 'missing';
  intent: Activation;
  to: Activation;
  relationship?: TargetRelationship;
  destination?: string;
  /** remove-link: unlink the symlink Relationship instead of moving it. */
  remove?: boolean;
}

export interface ActivationPlan {
  report: InventoryScanReport;
  targets: ActivationTarget[];
  staleResourceIds: string[];
  /** State file this plan's intents persist to (project scans carry the project state). */
  stateFile: string;
}

function lexists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertWritableParent(file: string): void {
  let directory = path.dirname(file);
  while (!fs.existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`no writable parent for: ${file}`);
    directory = parent;
  }
  try {
    fs.accessSync(directory, fs.constants.W_OK);
  } catch {
    throw new Error(`Target Slot parent is not writable: ${directory}`);
  }
}

function slotConflict(
  slotId: string,
  candidates: Array<{ resourceId?: string; path?: string }>,
): Error {
  return new Error(
    `Target Slot ${slotId.replace('\0', '/')} is ambiguous or occupied:\n${candidates
      .map((candidate) =>
        `  - ${candidate.resourceId ? `skill:${candidate.resourceId}` : 'broken link'}${candidate.path ? `: ${candidate.path}` : ''}`)
      .join('\n')}`,
  );
}

interface ActivationContext {
  report: InventoryScanReport;
  intent: Activation;
  claims: Record<string, string[]>;
}

function selectedRelationship(
  context: ActivationContext,
  resource: InventoryResource,
  target: ScannedTarget,
  slotName: string,
): TargetRelationship | undefined {
  const slotId = `${target.id}\0${slotName}`;
  const relationships = context.report.slots.find((candidate) =>
    candidate.targetId === target.id && candidate.name === slotName)
    ?.relationships ?? [];
  const selected = relationships.find((candidate) => candidate.resourceId === resource.id);
  if (relationships.length === 0 || (relationships.length === 1 && selected)) return selected;
  const candidates = relationships.some((candidate) =>
    candidate.resourceId === resource.id)
    ? relationships
    : [...relationships, { resourceId: resource.id }];
  throw slotConflict(slotId, candidates);
}

function activationDestination({
  relationship,
  from,
  to,
  target,
  slotName,
}: {
  relationship: TargetRelationship | undefined;
  from: Activation | 'missing';
  to: Activation;
  target: ScannedTarget;
  slotName: string;
}): string | undefined {
  if (relationship && from !== to) {
    const root = to === 'on' ? target.discoveryRoot : target.parkingRoot;
    return path.join(root, path.basename(relationship.path));
  }
  return !relationship && to === 'on'
    ? path.join(target.discoveryRoot, slotName)
    : undefined;
}

function preflightTarget(
  relationship: TargetRelationship | undefined,
  from: Activation | 'missing',
  to: Activation,
  destination: string | undefined,
): void {
  if (destination && lexists(destination))
    throw new Error(`Target Slot path already exists: ${destination}`);
  if (relationship && from !== to) {
    if (!lexists(relationship.path))
      throw new Error(`relationship disappeared during preview: ${relationship.path}`);
    assertWritableParent(relationship.path);
  }
  if (destination) assertWritableParent(destination);
}

function activationTarget(
  context: ActivationContext,
  resource: InventoryResource,
  target: ScannedTarget,
  slotName: string,
): ActivationTarget {
  const slotId = `${target.id}\0${slotName}`;
  const to = context.intent === 'off' && (context.claims[slotId]?.length ?? 0) > 0
    ? 'on'
    : context.intent;
  const relationship = selectedRelationship(context, resource, target, slotName);
  const from = relationship?.activation ?? 'missing';
  const destination = activationDestination({
    relationship,
    from,
    to,
    target,
    slotName,
  });
  preflightTarget(relationship, from, to, destination);
  return {
    slotId,
    targetId: target.id,
    targetKey: target.key,
    slot: slotName,
    resourceId: resource.id,
    from,
    intent: context.intent,
    to,
    relationship,
    destination,
  };
}

function activationTargets(
  context: ActivationContext,
  resource: InventoryResource,
  target: ScannedTarget,
): ActivationTarget[] {
  return resourceSlots(resource, target)
    .map((slot) => activationTarget(context, resource, target, slot));
}

function uniqueTargets(targets: ActivationTarget[]): ActivationTarget[] {
  const unique = new Map<string, ActivationTarget>();
  for (const target of targets) {
    const previous = unique.get(target.slotId);
    if (previous && previous.resourceId !== target.resourceId) {
      throw slotConflict(target.slotId, [previous, target]);
    }
    unique.set(target.slotId, target);
  }
  return [...unique.values()];
}

function preflightDependentLinks(
  report: InventoryScanReport,
  targets: ActivationTarget[],
): void {
  const movingLocalResources = new Set(targets.flatMap((target) =>
    target.relationship?.form === 'local' && target.destination
      ? [target.resourceId]
      : []));
  for (const relationship of report.relationships) {
    if (relationship.form !== 'link' || !relationship.resourceId ||
      !movingLocalResources.has(relationship.resourceId)) continue;
    if (!lexists(relationship.path))
      throw new Error(`dependent Link disappeared during preview: ${relationship.path}`);
    assertWritableParent(relationship.path);
  }
}

function readClaims(state: CatalogState): Record<string, string[]> {
  return readStringListRecord(state.claims, 'claims');
}

/** Resolve a skill selector against the freshly scanned report: disk is the truth (ADR-0001).
 *  Bundle/Tag selectors stay state-based so stale members are reported, not silently dropped. */
function resolvePlanSelector(
  home: Home,
  selector: string,
  report: InventoryScanReport,
): { resourceIds: string[]; staleResourceIds: string[] } {
  if (selector.startsWith('bundle:') || selector.startsWith('tag:'))
    return expandSelector(home, selector, report);
  const value = selector.startsWith('skill:') ? selector.slice('skill:'.length) : selector;
  if (!value) throw new Error(`invalid skill selector: ${selector}`);
  const byId = report.resources.filter((resource) => resource.id === value);
  const matches = byId.length > 0
    ? byId
    : report.resources.filter((resource) => resource.name === value);
  if (matches.length === 0) throw new Error(`skill not found: ${selector}`);
  if (matches.length > 1) {
    throw new Error(
      `skill name "${value}" is ambiguous:\n${matches
        .map((resource) => `  - ${resource.name}: skill:${resource.id}`)
        .join('\n')}\nUse one of the explicit selectors above.`,
    );
  }
  return { resourceIds: [matches[0].id], staleResourceIds: [] };
}

/** Scan for a mutation scope: project scopes see project/parent/global targets. */
function mutationReport(home: Home, scope: PresetScope): InventoryScanReport {
  return scope.projectPath
    ? scanProjectInventory(home, scope.projectPath, undefined, { persist: false })
    : scanGlobalInventory(home, undefined, { persist: false });
}

/** Resolve one writable Target by key or id; project scans prefer the project-scope match. */
function resolveWritableTarget(
  report: InventoryScanReport,
  name: string,
): InventoryScanReport['targets'][number] {
  let matches = report.targets.filter((target) =>
    target.key === name || target.id === name);
  if (matches.length > 1) matches = matches.filter((target) => target.scope === 'project');
  if (matches.length !== 1) throw new Error(`unknown Target: ${name}`);
  const target = matches[0];
  if (!target.writable) throw new Error(`Target is read-only here: ${target.key}`);
  return target;
}

export function planActivation(
  home: Home,
  selector: string,
  targetNames: string[],
  intent: Activation,
  scope: PresetScope = {},
): ActivationPlan {
  if (targetNames.length === 0)
    throw new Error(`usage: skillspub ${intent === 'on' ? 'on' : 'off'} <selector> <target...>`);
  const report = mutationReport(home, scope);
  const selected = targetNames.map((name) => resolveWritableTarget(report, name));
  const claims = readClaims(readStateFile(report.stateFile));
  const { resourceIds, staleResourceIds } = resolvePlanSelector(home, selector, report);
  if (staleResourceIds.length > 0) {
    const kind = selector.startsWith('tag:') ? 'Tag' : 'Bundle';
    throw new Error(`stale ${kind} member${staleResourceIds.length === 1 ? '' : 's'}:\n${staleResourceIds
      .map((id) => `  - skill:${id}`)
      .join('\n')}`);
  }
  const context: ActivationContext = { report, intent, claims };
  const resourceById = new Map(report.resources.map((resource) => [resource.id, resource]));
  const targets = resourceIds.flatMap((id) => {
    const resource = resourceById.get(id);
    return resource
      ? selected.flatMap((target) => activationTargets(context, resource, target))
      : [];
  });

  const unique = uniqueTargets(targets);
  preflightDependentLinks(report, unique);
  return { report, targets: unique, staleResourceIds: [], stateFile: report.stateFile };
}

function slotRelationship(
  report: InventoryScanReport,
  targetId: string,
  slot: string,
): TargetRelationship {
  const relationships = report.slots.find((candidate) =>
    candidate.targetId === targetId && candidate.name === slot)
    ?.relationships ?? [];
  if (relationships.length === 0)
    throw new Error(`Target Slot not found: ${targetId.replace('global:', '')}/${slot}`);
  if (relationships.length > 1) throw slotConflict(`${targetId}\0${slot}`, relationships);
  return relationships[0];
}

function selectedTarget(
  report: InventoryScanReport,
  targetId: string,
): ScannedTarget {
  const target = report.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error(`unknown Target: ${targetId}`);
  if (!target.writable) throw new Error(`Target is read-only here: ${target.key}`);
  return target;
}

interface SlotMutation {
  report: InventoryScanReport;
  target: ScannedTarget;
  relationship: TargetRelationship;
  slotId: string;
}

function selectSlotMutation(
  home: Home,
  targetId: string,
  slot: string,
  scope: PresetScope = {},
): SlotMutation {
  const report = mutationReport(home, scope);
  const relationship = slotRelationship(report, targetId, slot);
  if (relationship.readOnly)
    throw new Error(`Target Slot is read-only here: ${targetId}/${slot}`);
  const target = selectedTarget(report, targetId);
  return { report, target, relationship, slotId: targetSlotId(targetId, slot) };
}

/** Flip one existing Relationship, selected by exact Target Slot. Works for broken links too. */
export function planToggle(
  home: Home,
  targetId: string,
  slot: string,
  scope: PresetScope = {},
): ActivationPlan {
  const { report, target, relationship, slotId } = selectSlotMutation(home, targetId, slot, scope);
  const from = relationship.activation;
  const intent: Activation = from === 'off' ? 'on' : 'off';
  const claims = readClaims(readStateFile(report.stateFile));
  const to: Activation = intent === 'off' && (claims[slotId]?.length ?? 0) > 0 ? 'on' : intent;
  // Claimed Slots stay ON: nothing moves, only Base intent is recorded.
  const destination = from !== to
    ? path.join(
        to === 'on' ? target.discoveryRoot : target.parkingRoot,
        path.basename(relationship.path),
      )
    : undefined;
  preflightTarget(relationship, from, to, destination);
  const targets = [{
    slotId,
    targetId,
    targetKey: target.key,
    slot,
    resourceId: relationship.resourceId ?? '',
    from,
    intent,
    to,
    relationship,
    destination,
  }];
  preflightDependentLinks(report, targets);
  return { report, targets, staleResourceIds: [], stateFile: report.stateFile };
}

/** Create the missing Link from one existing skill resource into a Target Slot. */
export function planLink(
  home: Home,
  resourceId: string,
  targetName: string,
  scope: PresetScope = {},
): ActivationPlan {
  const report = mutationReport(home, scope);
  const target = resolveWritableTarget(report, targetName);
  const resource = report.resources.find((candidate) => candidate.id === resourceId);
  if (!resource) throw new Error(`skill not found on disk: ${resourceId}`);
  const context: ActivationContext = {
    report,
    intent: 'on',
    claims: readClaims(readStateFile(report.stateFile)),
  };
  const targets = uniqueTargets(activationTargets(context, resource, target));
  preflightDependentLinks(report, targets);
  return { report, targets, staleResourceIds: [], stateFile: report.stateFile };
}

/** Remove exactly one symlink Relationship. Local skill directories are never deleted. */
export function planUnlink(
  home: Home,
  targetId: string,
  slot: string,
  scope: PresetScope = {},
): ActivationPlan {
  const { report, target, relationship, slotId } = selectSlotMutation(home, targetId, slot, scope);
  if (relationship.form !== 'link')
    throw new Error(`cannot unlink ${relationship.path}: local skill directories are never deleted`);
  assertUnlinkAllowed(report.stateFile, slotId);
  if (!lexists(relationship.path))
    throw new Error(`relationship disappeared during preview: ${relationship.path}`);
  assertWritableParent(relationship.path);
  return {
    report,
    targets: [{
      slotId,
      targetId,
      targetKey: target.key,
      slot,
      resourceId: relationship.resourceId ?? '',
      from: relationship.activation,
      intent: relationship.activation,
      to: relationship.activation,
      relationship,
      remove: true,
    }],
    staleResourceIds: [],
    stateFile: report.stateFile,
  };
}

function readBaseIntent(state: CatalogState): Record<string, Activation> {
  const value = state.baseIntent ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.values(value).some((activation) => activation !== 'on' && activation !== 'off'))
    throw new Error('invalid state baseIntent');
  return value as Record<string, Activation>;
}

type MovedLocals = Map<string, string>;

function replaceSymlink(link: string, target: string): void {
  const temporary = `${link}.skillspub-${process.pid}.tmp`;
  if (lexists(temporary)) throw new Error(`temporary Link path already exists: ${temporary}`);
  fs.symlinkSync(target, temporary, 'dir');
  try {
    fs.renameSync(temporary, link);
  } catch (error) {
    fs.unlinkSync(temporary);
    throw error;
  }
}

function moveRelationships(home: Home, plan: ActivationPlan): {
  movedLinks: Map<string, string>;
  movedLocals: MovedLocals;
} {
  const movedLinks = new Map<string, string>();
  const movedLocals: MovedLocals = new Map();
  const moves = plan.targets
    .filter((target) => target.relationship && target.destination)
    .sort((a, b) => Number(b.relationship?.form === 'local') - Number(a.relationship?.form === 'local'));
  for (const target of moves) {
    const { relationship, destination } = target;
    if (!relationship || !destination) continue;
    const originalTarget = relationship.target;
    const absoluteTarget = originalTarget && !path.isAbsolute(originalTarget)
      ? path.resolve(path.dirname(relationship.path), originalTarget)
      : originalTarget;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(relationship.path, destination);
    if (relationship.form === 'local') {
      const moved = fs.realpathSync(destination);
      movedLocals.set(target.resourceId, moved);
      preserveMovedResourceReferences(home, target.resourceId, moved);
    } else {
      movedLinks.set(relationship.path, destination);
      const movedTarget = movedLocals.get(target.resourceId);
      if (originalTarget && absoluteTarget && (!path.isAbsolute(originalTarget) || movedTarget)) {
        const nextTarget = movedTarget ?? absoluteTarget;
        replaceSymlink(
          destination,
          path.isAbsolute(originalTarget)
            ? nextTarget
            : path.relative(path.dirname(destination), nextTarget),
        );
      }
    }
  }
  return { movedLinks, movedLocals };
}

function createMissingLinks(plan: ActivationPlan, movedLocals: MovedLocals): void {
  for (const target of plan.targets) {
    if (target.from !== 'missing' || target.to !== 'on' || !target.destination) continue;
    const source = movedLocals.get(target.resourceId) ?? target.resourceId;
    fs.mkdirSync(path.dirname(target.destination), { recursive: true });
    fs.symlinkSync(source, target.destination, 'dir');
  }
}

function retargetMovedLinks(
  plan: ActivationPlan,
  movedLinks: Map<string, string>,
  movedLocals: MovedLocals,
): void {
  for (const relationship of plan.report.relationships) {
    if (relationship.form !== 'link' || !relationship.resourceId) continue;
    const moved = movedLocals.get(relationship.resourceId);
    if (!moved || !relationship.target) continue;
    const link = movedLinks.get(relationship.path) ?? relationship.path;
    if (!lexists(link)) continue;
    replaceSymlink(
      link,
      path.isAbsolute(relationship.target)
        ? moved
        : path.relative(path.dirname(link), moved),
    );
  }
}

function preserveMovedResourceReferences(home: Home, previous: string, moved: string): void {
  const state = readState(home);
  state.bundles = Object.fromEntries(
    Object.entries(readBundles(state)).map(([name, members]) => [
      name,
      [...new Set(members.map((member) => member === previous ? moved : member))]
        .sort((a, b) => a.localeCompare(b)),
    ]),
  );
  const tags = readTags(state);
  if (tags[previous]) {
    const { [previous]: previousTags, ...remaining } = tags;
    state.tags = {
      ...remaining,
      [moved]: [...new Set([...(remaining[moved] ?? []), ...previousTags])]
        .sort((a, b) => a.localeCompare(b)),
    };
  }
  const presets = readPresets(state);
  const previousSelector = `skill:${previous}`;
  const movedSelector = `skill:${moved}`;
  state.presets = Object.fromEntries(
    Object.entries(presets).map(([name, preset]) => [
      name,
      {
        selectors: [...new Set(preset.selectors.map((selector) =>
          selector === previousSelector ? movedSelector : selector))]
          .sort((a, b) => a.localeCompare(b)),
      },
    ]),
  );
  writeState(home, state);
}

function movedResourceIds(plan: ActivationPlan): Map<string, string> {
  const moved = new Map<string, string>();
  for (const target of plan.targets) {
    if (target.relationship?.form !== 'local' || !target.destination ||
      lexists(target.relationship.path) || !lexists(target.destination)) continue;
    moved.set(target.resourceId, fs.realpathSync(target.destination));
  }
  return moved;
}

function targetSatisfied(
  target: ActivationTarget,
  actual: InventoryScanReport,
  moved: Map<string, string>,
): boolean {
  const relationships = actual.slots.find((candidate) =>
    candidate.targetId === target.targetId && candidate.name === target.slot)
    ?.relationships ?? [];
  if (target.remove)
    return !relationships.some((relationship) =>
      relationship.path === target.relationship?.path);
  if (relationships.length === 0)
    return target.to === 'off' && target.from === 'missing';
  const relationship = relationships[0];
  return relationships.length === 1 &&
    relationship.activation === target.to &&
    (!target.resourceId ||
      relationship.resourceId === (moved.get(target.resourceId) ?? target.resourceId));
}

export function remainingDrift(
  plan: ActivationPlan,
  actual: InventoryScanReport,
): string[] {
  const moved = movedResourceIds(plan);
  return plan.targets.flatMap((target) =>
    targetSatisfied(target, actual, moved)
      ? []
      : [`${target.targetId}/${target.slot}`]);
}

function removePlanLinks(plan: ActivationPlan): void {
  for (const target of plan.targets) {
    if (!target.remove || !target.relationship) continue;
    if (!fs.lstatSync(target.relationship.path).isSymbolicLink())
      throw new Error(`cannot unlink ${target.relationship.path}: not a symlink`);
    fs.unlinkSync(target.relationship.path);
  }
}

export function applyActivationPlan(home: Home, plan: ActivationPlan): void {
  const state = readStateFile(plan.stateFile);
  const baseIntent = { ...readBaseIntent(state as CatalogState) };
  for (const target of plan.targets) {
    if (target.remove) delete baseIntent[target.slotId];
    else baseIntent[target.slotId] = target.intent;
  }
  state.baseIntent = baseIntent;
  writeStateFile(plan.stateFile, state);

  removePlanLinks(plan);
  const { movedLinks, movedLocals } = moveRelationships(home, plan);
  createMissingLinks(plan, movedLocals);
  retargetMovedLinks(plan, movedLinks, movedLocals);
}

function claimId(preset: string): string {
  return `preset:${preset}`;
}

function readStringListRecord(value: unknown, field: string): Record<string, string[]> {
  const record = value ?? {};
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
    Object.values(record).some((items) =>
      !Array.isArray(items) || items.some((item) => typeof item !== 'string')))
    throw new Error(`invalid state ${field}`);
  return record as Record<string, string[]>;
}

function readPresetActivations(state: Record<string, unknown>): Record<string, string[]> {
  const value = state.presetActivations;
  if (value === undefined) return {};
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item !== 'string'))
      throw new Error('invalid state presetActivations');
    return Object.fromEntries(value.map((name) => [name, []] as const));
  }
  return readStringListRecord(value, 'presetActivations');
}

function scopeScan(home: Home, scope: PresetScope = {}): {
  report: InventoryScanReport;
  stateFile: string;
  catalogState: CatalogState;
  policyState: Record<string, unknown>;
} {
  if (scope.projectPath) {
    const report = scanProjectInventory(home, scope.projectPath, undefined, { persist: false });
    return {
      report,
      stateFile: report.stateFile,
      catalogState: readState(home),
      policyState: readStateFile(report.stateFile),
    };
  }
  const report = scanGlobalInventory(home, undefined, { persist: false });
  const stateFile = statePath(home);
  const catalogState = readStateFile(stateFile) as CatalogState;
  return { report, stateFile, catalogState, policyState: catalogState };
}

function resolveTargetKeys(
  report: InventoryScanReport,
  targetNames: string[],
): ScannedTarget[] {
  if (targetNames.length === 0) throw new Error('at least one Target is required');
  return targetNames.map((name) => {
    const matches = report.targets.filter((target) => {
      if (target.key !== name && target.id !== name) return false;
      if (report.scope === 'project') return target.scope === 'project';
      return target.scope === 'global';
    });
    if (matches.length !== 1) throw new Error(`unknown Target: ${name}`);
    return matches[0];
  });
}

function resourceSlots(
  resource: InventoryResource,
  target: ScannedTarget,
): string[] {
  const existing = [...new Set(resource.relationships.flatMap((relationship) =>
    relationship.targetId === target.id ? [relationship.slot] : []))];
  return existing.length > 0 ? existing : [normalizeSlotName(resource.name)];
}

function expandPresetClaims(
  home: Home,
  report: InventoryScanReport,
  catalogState: CatalogState,
  activations: Record<string, string[]>,
  previousLastClaims: Record<string, string[]>,
): {
  claims: Record<string, string[]>;
  lastClaims: Record<string, string[]>;
  resourcesBySlot: Map<string, string>;
  staleResourceIds: string[];
} {
  const presets = readPresets(catalogState);
  const claims = new Map<string, Set<string>>();
  const lastClaims: Record<string, string[]> = {};
  const resourcesBySlot = new Map<string, string>();
  const staleResourceIds = new Set<string>();
  const resourceById = new Map(report.resources.map((resource) => [resource.id, resource]));

  for (const [preset, targetKeys] of Object.entries(activations)) {
    const definition = presets[preset];
    if (!definition) {
      if (previousLastClaims[preset]) lastClaims[preset] = [...previousLastClaims[preset]];
      continue;
    }
    const targets = targetKeys.length > 0
      ? resolveTargetKeys(report, targetKeys)
      : report.targets.filter((target) =>
        report.scope === 'project' ? target.scope === 'project' : target.scope === 'global');
    const slots = new Set<string>();
    for (const selector of definition.selectors) {
      const expanded = expandSelector(home, selector, report);
      for (const id of expanded.staleResourceIds) staleResourceIds.add(id);
      for (const resourceId of expanded.resourceIds) {
        const resource = resourceById.get(resourceId);
        if (!resource) {
          staleResourceIds.add(resourceId);
          continue;
        }
        for (const target of targets) {
          for (const slot of resourceSlots(resource, target)) {
            const slotId = `${target.id}\0${slot}`;
            const set = claims.get(slotId) ?? new Set<string>();
            set.add(claimId(preset));
            claims.set(slotId, set);
            resourcesBySlot.set(slotId, resourceId);
            slots.add(slotId);
          }
        }
      }
    }
    lastClaims[preset] = [...slots].sort((a, b) => a.localeCompare(b));
  }

  return {
    claims: Object.fromEntries(
      [...claims].map(([slotId, ids]) => [
        slotId,
        [...ids].sort((a, b) => a.localeCompare(b)),
      ]),
    ),
    lastClaims,
    resourcesBySlot,
    staleResourceIds: [...staleResourceIds],
  };
}

function frozenClaimSlots(lastClaims: Record<string, string[]>): Set<string> {
  return new Set(Object.values(lastClaims).flat());
}

function buildReconcileTargets(
  report: InventoryScanReport,
  claims: Record<string, string[]>,
  lastClaims: Record<string, string[]>,
  baseIntent: Record<string, Activation>,
  resourcesBySlot: Map<string, string>,
  previousClaims: Record<string, string[]>,
): { targets: ActivationTarget[]; baseIntentDefaults: Record<string, Activation> } {
  const frozen = frozenClaimSlots(lastClaims);
  const slotIds = new Set([
    ...Object.keys(claims),
    ...Object.keys(previousClaims),
    ...frozen,
  ]);
  const targets: ActivationTarget[] = [];
  const baseIntentDefaults: Record<string, Activation> = {};
  const resourceById = new Map(report.resources.map((resource) => [resource.id, resource]));

  for (const slotId of slotIds) {
    const separator = slotId.indexOf('\0');
    if (separator < 0) continue;
    const targetId = slotId.slice(0, separator);
    const slot = slotId.slice(separator + 1);
    const target = report.targets.find((candidate) => candidate.id === targetId);
    if (!target) continue;
    const claimed = (claims[slotId]?.length ?? 0) > 0 || frozen.has(slotId);
    const intent = baseIntent[slotId];
    // no claim and no base intent: leave Actual alone unless we previously claimed it
    if (!claimed && intent === undefined && !previousClaims[slotId]?.length) continue;

    const relationships = report.slots.find((candidate) =>
      candidate.targetId === targetId && candidate.name === slot)?.relationships ?? [];
    if (relationships.length > 1) throw slotConflict(slotId, relationships);

    const desired: Activation = claimed
      ? 'on'
      : (intent ?? relationships[0]?.activation ?? 'off');

    const resourceId = resourcesBySlot.get(slotId) ?? relationships[0]?.resourceId;
    if (!resourceId) continue;
    const resource = resourceById.get(resourceId);
    const relationship = relationships.find((candidate) => candidate.resourceId === resourceId)
      ?? relationships[0];
    if (relationship && relationships.length === 1 && relationship.resourceId &&
      relationship.resourceId !== resourceId && desired === 'on')
      throw slotConflict(slotId, relationships);

    if (!relationship) {
      if (desired === 'off') continue;
      baseIntentDefaults[slotId] = 'off';
      const destination = path.join(target.discoveryRoot, slot);
      preflightTarget(undefined, 'missing', desired, destination);
      targets.push({
        slotId,
        targetId,
        targetKey: target.key,
        slot,
        resourceId: resource?.id ?? resourceId,
        from: 'missing',
        intent: intent ?? 'off',
        to: desired,
        destination,
      });
      continue;
    }

    const from = relationship.activation;
    if (claimed && intent === undefined) baseIntentDefaults[slotId] = from;
    if (from === desired) continue;

    const destination = activationDestination({
      relationship,
      from,
      to: desired,
      target,
      slotName: slot,
    });
    preflightTarget(relationship, from, desired, destination);
    targets.push({
      slotId,
      targetId,
      targetKey: target.key,
      slot,
      resourceId: resource?.id ?? resourceId,
      from,
      intent: intent ?? desired,
      to: desired,
      relationship,
      destination,
    });
  }

  preflightDependentLinks(report, targets);
  return { targets, baseIntentDefaults };
}

function planFromActivations(
  home: Home,
  activations: Record<string, string[]>,
  scope: PresetScope = {},
): PresetReconcilePlan {
  const { report, stateFile, catalogState, policyState } = scopeScan(home, scope);
  const previousClaims = readStringListRecord(policyState.claims, 'claims');
  const previousLastClaims = readStringListRecord(policyState.lastClaims, 'lastClaims');
  const baseIntent = readBaseIntent(policyState as CatalogState);
  const expanded = expandPresetClaims(
    home, report, catalogState, activations, previousLastClaims,
  );
  const { targets, baseIntentDefaults } = buildReconcileTargets(
    report,
    expanded.claims,
    expanded.lastClaims,
    baseIntent,
    expanded.resourcesBySlot,
    previousClaims,
  );
  return {
    report,
    targets,
    staleResourceIds: expanded.staleResourceIds,
    stateFile,
    claims: expanded.claims,
    lastClaims: expanded.lastClaims,
    presetActivations: Object.fromEntries(
      Object.entries(activations).map(([name, targets]) => [
        name,
        [...targets].sort((a, b) => a.localeCompare(b)),
      ]),
    ),
    baseIntentDefaults,
  };
}

export function planPresetReconcile(
  home: Home,
  name?: string,
  targetNames?: string[],
  scope: PresetScope = {},
): PresetReconcilePlan {
  const { policyState, catalogState } = scopeScan(home, scope);
  const activations = readPresetActivations(policyState);
  if (name) {
    if (!readPresets(catalogState)[name] && !activations[name] &&
      !readStringListRecord(policyState.lastClaims, 'lastClaims')[name])
      throw new Error(`unknown preset: ${name}`);
    if (!activations[name])
      throw new Error(`preset is not active: ${name}`);
    if (targetNames && targetNames.length > 0) {
      const active = new Set(activations[name]);
      for (const target of targetNames)
        if (!active.has(target)) throw new Error(`preset is not active on Target: ${target}`);
    }
  }
  // Always recompute claims from every active Preset so multi-preset Slots stay correct.
  return planFromActivations(home, activations, scope);
}

export function activatePreset(
  home: Home,
  name: string,
  targetNames: string[],
  scope: PresetScope = {},
): PresetReconcilePlan {
  assertPresetName(name);
  const { report, catalogState, policyState } = scopeScan(home, scope);
  if (!readPresets(catalogState)[name]) throw new Error(`unknown preset: ${name}`);
  resolveTargetKeys(report, targetNames);
  const activations = readPresetActivations(policyState);
  const current = new Set(activations[name] ?? []);
  for (const target of targetNames) current.add(target);
  return planFromActivations(home, {
    ...activations,
    [name]: [...current],
  }, scope);
}

export function deactivatePreset(
  home: Home,
  name: string,
  targetNames: string[],
  scope: PresetScope = {},
): PresetReconcilePlan {
  assertPresetName(name);
  const { report, policyState } = scopeScan(home, scope);
  resolveTargetKeys(report, targetNames);
  const activations = readPresetActivations(policyState);
  if (!(name in activations) &&
    !readStringListRecord(policyState.lastClaims, 'lastClaims')[name])
    throw new Error(`preset is not active: ${name}`);
  const remaining = new Set(activations[name] ?? []);
  for (const target of targetNames) remaining.delete(target);
  const next = { ...activations };
  if (remaining.size === 0) delete next[name];
  else next[name] = [...remaining];
  return planFromActivations(home, next, scope);
}

export function applyPresetReconcile(
  home: Home,
  plan: PresetReconcilePlan,
  _scope: PresetScope = {},
): void {
  const state = readStateFile(plan.stateFile);
  const baseIntent = { ...readBaseIntent(state as CatalogState) };
  for (const [slotId, activation] of Object.entries(plan.baseIntentDefaults))
    if (baseIntent[slotId] === undefined) baseIntent[slotId] = activation;
  state.baseIntent = baseIntent;
  state.claims = plan.claims;
  state.lastClaims = plan.lastClaims;
  state.presetActivations = plan.presetActivations;
  writeStateFile(plan.stateFile, state);

  const { movedLinks, movedLocals } = moveRelationships(home, plan);
  createMissingLinks(plan, movedLocals);
  retargetMovedLinks(plan, movedLinks, movedLocals);
}

export function deletePreset(
  home: Home,
  name: string,
  options: { yes?: boolean; projectPath?: string } = {},
): void {
  assertPresetName(name);
  if (!options.yes) throw new Error('deleting a Preset requires --yes');
  const state = readState(home);
  const presets = readPresets(state);
  if (!presets[name]) throw new Error(`unknown preset: ${name}`);

  const globalPolicy = readStateFile(statePath(home));
  const activations = readPresetActivations(globalPolicy);
  if (activations[name]?.length) {
    const plan = deactivatePreset(home, name, activations[name]);
    applyPresetReconcile(home, plan);
  }
  if (options.projectPath) {
    const projectState = readStateFile(
      path.join(path.resolve(options.projectPath), '.skillspub', 'state.json'),
    );
    const projectActivations = readPresetActivations(projectState);
    if (projectActivations[name]?.length) {
      const plan = deactivatePreset(home, name, projectActivations[name], {
        projectPath: options.projectPath,
      });
      applyPresetReconcile(home, plan, { projectPath: options.projectPath });
    }
  }

  const latest = readState(home);
  const { [name]: _, ...remaining } = readPresets(latest);
  latest.presets = remaining;
  writeState(home, latest);
}

function assertUnlinkAllowed(stateFile: string, slotIdOrName: string): void {
  const state = readStateFile(stateFile);
  const claims = readStringListRecord(state.claims, 'claims');
  const lastClaims = readStringListRecord(state.lastClaims, 'lastClaims');
  const slotIds = slotIdOrName.includes('\0')
    ? [slotIdOrName]
    : Object.keys(claims).filter((slotId) => slotId.endsWith(`\0${slotIdOrName}`));
  const check = (slotId: string): void => {
    if ((claims[slotId]?.length ?? 0) > 0)
      throw new Error(`cannot unlink claimed Target Slot ${slotId.replace('\0', '/')}`);
    for (const [preset, slots] of Object.entries(lastClaims))
      if (slots.includes(slotId))
        throw new Error(
          `cannot unlink claimed Target Slot ${slotId.replace('\0', '/')} (${preset})`,
        );
  };
  if (slotIdOrName.includes('\0')) check(slotIdOrName);
  else {
    for (const slotId of slotIds) check(slotId);
    for (const [preset, slots] of Object.entries(lastClaims))
      for (const slotId of slots)
        if (slotId.endsWith(`\0${slotIdOrName}`))
          throw new Error(
            `cannot unlink claimed Target Slot ${slotId.replace('\0', '/')} (${preset})`,
          );
  }
}
