import fs from 'node:fs';
import path from 'node:path';
import type { Home } from './core.ts';
import {
  normalizeSlotName,
  readStateFile,
  scanGlobalInventory,
  scanProjectInventory,
  writeStateFile,
  type Activation,
  type InventoryResource,
  type InventoryScanReport,
  type RuntimeRelationship,
  type ScannedRuntime,
} from './inventory.ts';

interface ResourceMetadata {
  name: string;
}

interface PresetDefinition {
  selectors: string[];
}

interface CatalogState extends Record<string, unknown> {
  bundles?: Record<string, string[]>;
  presets?: Record<string, PresetDefinition>;
  runtimeInventory?: {
    resources?: Record<string, ResourceMetadata>;
  };
}

export interface PresetScope {
  projectPath?: string;
}

export interface PresetSelector {
  selector: string;
}

export interface PresetReconcilePlan extends ActivationPlan {
  stateFile: string;
  claims: Record<string, string[]>;
  lastClaims: Record<string, string[]>;
  presetActivations: Record<string, string[]>;
  baseIntentDefaults: Record<string, Activation>;
}

export interface BundleMember {
  id: string;
  name?: string;
  stale: boolean;
}

export interface ActivationTarget {
  slotId: string;
  runtimeId: string;
  runtimeKey: string;
  slot: string;
  resourceId: string;
  from: Activation | 'missing';
  intent: Activation;
  to: Activation;
  relationship?: RuntimeRelationship;
  destination?: string;
}

export interface ActivationPlan {
  report: InventoryScanReport;
  targets: ActivationTarget[];
  staleResourceIds: string[];
}

function statePath(home: Home): string {
  return path.join(home.configDir, 'state.json');
}

function readState(home: Home): CatalogState {
  return readStateFile(statePath(home)) as CatalogState;
}

function writeState(home: Home, state: CatalogState): void {
  writeStateFile(statePath(home), state);
}

function readBundles(state: CatalogState): Record<string, string[]> {
  const value = state.bundles ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.values(value).some((members) =>
      !Array.isArray(members) || members.some((member) => typeof member !== 'string')))
    throw new Error('invalid state bundles');
  return value;
}

function readTags(state: CatalogState): Record<string, string[]> {
  const value = state.tags ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.values(value).some((tags) =>
      !Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')))
    throw new Error('invalid state tags');
  return value as Record<string, string[]>;
}

function resources(state: CatalogState): Record<string, ResourceMetadata> {
  return state.runtimeInventory?.resources ?? {};
}

function assertManualBundle(name: string): void {
  if (!name || name.startsWith('repo:'))
    throw new Error('manual bundle names must be non-empty and cannot start with repo:');
}

function resourceId(
  selector: string,
  state: CatalogState,
  existingMembers: string[] = [],
): string {
  const value = selector.startsWith('skill:') ? selector.slice('skill:'.length) : selector;
  if (!value) throw new Error(`invalid skill selector: ${selector}`);
  if (existingMembers.includes(value)) return value;

  const entries = Object.entries(resources(state));
  if (resources(state)[value]) return value;
  const matches = entries.filter(([, metadata]) => metadata.name === value);
  if (matches.length === 1) return matches[0][0];
  if (matches.length > 1) {
    throw new Error(
      `skill name "${value}" is ambiguous:\n${matches
        .map(([id, metadata]) => `  - ${metadata.name}: skill:${id}`)
        .join('\n')}\nUse one of the explicit selectors above.`,
    );
  }
  throw new Error(`skill not found: ${selector}; run skillspub scan first`);
}

export function listBundles(home: Home): Array<{ name: string; members: number }> {
  const bundles = readBundles(readState(home));
  return Object.entries(bundles)
    .map(([name, members]) => ({ name, members: members.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function showBundle(home: Home, name: string): BundleMember[] {
  const state = readState(home);
  const members = readBundles(state)[name];
  if (!members) throw new Error(`unknown bundle: ${name}`);
  const current = resources(state);
  return members.map((id) => ({
    id,
    name: current[id]?.name,
    stale: current[id] === undefined,
  }));
}

export function createBundle(home: Home, name: string, selectors: string[]): number {
  assertManualBundle(name);
  const state = readState(home);
  const bundles = readBundles(state);
  if (bundles[name]) throw new Error(`bundle already exists: ${name}`);
  const members = selectors.map((selector) => resourceId(selector, state));
  state.bundles = {
    ...bundles,
    [name]: [...new Set(members)].sort((a, b) => a.localeCompare(b)),
  };
  writeState(home, state);
  return state.bundles[name].length;
}

export function addBundleMembers(home: Home, name: string, selectors: string[]): number {
  assertManualBundle(name);
  if (selectors.length === 0) throw new Error('bundle add requires at least one skill selector');
  const state = readState(home);
  const bundles = readBundles(state);
  const current = bundles[name];
  if (!current) throw new Error(`unknown bundle: ${name}`);
  const members = selectors.map((selector) => resourceId(selector, state));
  const next = [...new Set([...current, ...members])]
    .sort((a, b) => a.localeCompare(b));
  state.bundles = { ...bundles, [name]: next };
  writeState(home, state);
  return next.length - current.length;
}

export function removeBundleMembers(
  home: Home,
  name: string,
  selectors?: string[],
): number | undefined {
  assertManualBundle(name);
  const state = readState(home);
  const bundles = readBundles(state);
  const current = bundles[name];
  if (!current) throw new Error(`unknown bundle: ${name}`);
  if (!selectors || selectors.length === 0) {
    const { [name]: _, ...remaining } = bundles;
    state.bundles = remaining;
    writeState(home, state);
    return undefined;
  }
  const removed = new Set(selectors.map((selector) => resourceId(selector, state, current)));
  const next = current.filter((member) => !removed.has(member));
  state.bundles = { ...bundles, [name]: next };
  writeState(home, state);
  return current.length - next.length;
}

export interface TagSummary {
  name: string;
  resources: number;
}

export interface ResourceTags {
  id: string;
  name?: string;
  tags: string[];
  stale: boolean;
}

function assertTagNames(tags: string[]): void {
  if (tags.length === 0 || tags.some((tag) => !tag))
    throw new Error('at least one non-empty tag is required');
}

export function addResourceTags(home: Home, selector: string, names: string[]): number {
  assertTagNames(names);
  const state = readState(home);
  const tags = readTags(state);
  const id = resourceId(selector, state);
  const current = tags[id] ?? [];
  const next = [...new Set([...current, ...names])].sort((a, b) => a.localeCompare(b));
  state.tags = { ...tags, [id]: next };
  writeState(home, state);
  return next.length - current.length;
}

export function removeResourceTags(
  home: Home,
  selector: string,
  names?: string[],
): number {
  const state = readState(home);
  const tags = readTags(state);
  const id = resourceId(selector, state, Object.keys(tags));
  const current = tags[id] ?? [];
  if (names && names.some((tag) => !tag)) throw new Error('tags must be non-empty');
  const removed = names?.length
    ? new Set(names)
    : new Set(current);
  const next = current.filter((tag) => !removed.has(tag));
  const { [id]: _, ...remaining } = tags;
  state.tags = next.length > 0 ? { ...remaining, [id]: next } : remaining;
  writeState(home, state);
  return current.length - next.length;
}

export function listTags(home: Home): TagSummary[] {
  const counts = new Map<string, number>();
  for (const names of Object.values(readTags(readState(home))))
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, resources]) => ({ name, resources }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function tagsForResource(home: Home, selector: string): ResourceTags {
  const state = readState(home);
  const tags = readTags(state);
  const id = resourceId(selector, state, Object.keys(tags));
  return {
    id,
    name: resources(state)[id]?.name,
    tags: tags[id] ?? [],
    stale: resources(state)[id] === undefined,
  };
}

function readPresets(state: CatalogState): Record<string, PresetDefinition> {
  const value = state.presets ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid state presets');
  for (const preset of Object.values(value)) {
    if (!preset || typeof preset !== 'object' || Array.isArray(preset) ||
      !Array.isArray(preset.selectors) ||
      preset.selectors.some((selector) => typeof selector !== 'string'))
      throw new Error('invalid state presets');
  }
  return value as Record<string, PresetDefinition>;
}

function assertPresetName(name: string): void {
  if (!name) throw new Error('preset name must be non-empty');
}

function normalizePresetSelector(selector: string, state: CatalogState): string {
  if (selector.startsWith('bundle:') || selector.startsWith('tag:')) return selector;
  if (selector.startsWith('skill:') || !selector.includes(':'))
    return `skill:${resourceId(selector, state)}`;
  throw new Error(`invalid Preset selector: ${selector}`);
}

export function listPresets(home: Home): Array<{ name: string; selectors: number }> {
  return Object.entries(readPresets(readState(home)))
    .map(([name, preset]) => ({ name, selectors: preset.selectors.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function showPreset(home: Home, name: string): PresetSelector[] {
  const preset = readPresets(readState(home))[name];
  if (!preset) throw new Error(`unknown preset: ${name}`);
  return preset.selectors.map((selector) => ({ selector }));
}

export function createPreset(home: Home, name: string, selectors: string[]): number {
  assertPresetName(name);
  const state = readState(home);
  const presets = readPresets(state);
  if (presets[name]) throw new Error(`preset already exists: ${name}`);
  const normalized = [...new Set(selectors.map((selector) =>
    normalizePresetSelector(selector, state)))].sort((a, b) => a.localeCompare(b));
  state.presets = { ...presets, [name]: { selectors: normalized } };
  writeState(home, state);
  return normalized.length;
}

export function addPresetSelectors(home: Home, name: string, selectors: string[]): number {
  assertPresetName(name);
  if (selectors.length === 0) throw new Error('preset add requires at least one selector');
  const state = readState(home);
  const presets = readPresets(state);
  const current = presets[name];
  if (!current) throw new Error(`unknown preset: ${name}`);
  const added = selectors.map((selector) => normalizePresetSelector(selector, state));
  const next = [...new Set([...current.selectors, ...added])].sort((a, b) => a.localeCompare(b));
  state.presets = { ...presets, [name]: { selectors: next } };
  writeState(home, state);
  return next.length - current.selectors.length;
}

export function removePresetSelectors(
  home: Home,
  name: string,
  selectors?: string[],
): number | undefined {
  assertPresetName(name);
  const state = readState(home);
  const presets = readPresets(state);
  const current = presets[name];
  if (!current) throw new Error(`unknown preset: ${name}`);
  if (!selectors || selectors.length === 0) {
    const { [name]: _, ...remaining } = presets;
    state.presets = remaining;
    writeState(home, state);
    return undefined;
  }
  const removed = new Set(selectors.map((selector) => {
    try {
      return normalizePresetSelector(selector, state);
    } catch {
      return selector;
    }
  }));
  const next = current.selectors.filter((selector) => !removed.has(selector));
  state.presets = { ...presets, [name]: { selectors: next } };
  writeState(home, state);
  return current.selectors.length - next.length;
}

export function expandSelector(
  home: Home,
  selector: string,
  report: InventoryScanReport,
): { resourceIds: string[]; staleResourceIds: string[] } {
  const state = readState(home);
  let resourceIds: string[];
  if (selector.startsWith('bundle:')) {
    const name = selector.slice('bundle:'.length);
    const members = readBundles(state)[name];
    if (!members) throw new Error(`unknown bundle: ${name}`);
    resourceIds = members;
  } else if (selector.startsWith('tag:')) {
    const name = selector.slice('tag:'.length);
    if (!name) throw new Error(`invalid Tag selector: ${selector}`);
    resourceIds = Object.entries(readTags(state))
      .filter(([, tags]) => tags.includes(name))
      .map(([id]) => id);
    if (resourceIds.length === 0) throw new Error(`unknown Tag: ${name}`);
  } else {
    resourceIds = [resourceId(selector, state)];
  }
  const live = new Set(report.resources.map(({ id }) => id));
  return {
    resourceIds: [...new Set(resourceIds)],
    staleResourceIds: resourceIds.filter((id) => !live.has(id)),
  };
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
    throw new Error(`Runtime Slot parent is not writable: ${directory}`);
  }
}

function slotConflict(
  slotId: string,
  candidates: Array<{ resourceId?: string; path?: string }>,
): Error {
  return new Error(
    `Runtime Slot ${slotId.replace('\0', '/')} is ambiguous or occupied:\n${candidates
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
  runtime: ScannedRuntime,
  slotName: string,
): RuntimeRelationship | undefined {
  const slotId = `${runtime.id}\0${slotName}`;
  const relationships = context.report.slots.find((candidate) =>
    candidate.runtimeId === runtime.id && candidate.name === slotName)
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
  runtime,
  slotName,
}: {
  relationship: RuntimeRelationship | undefined;
  from: Activation | 'missing';
  to: Activation;
  runtime: ScannedRuntime;
  slotName: string;
}): string | undefined {
  if (relationship && from !== to) {
    const root = to === 'on' ? runtime.discoveryRoot : runtime.parkingRoot;
    return path.join(root, path.basename(relationship.path));
  }
  return !relationship && to === 'on'
    ? path.join(runtime.discoveryRoot, slotName)
    : undefined;
}

function preflightTarget(
  relationship: RuntimeRelationship | undefined,
  from: Activation | 'missing',
  to: Activation,
  destination: string | undefined,
): void {
  if (destination && lexists(destination))
    throw new Error(`Runtime Slot path already exists: ${destination}`);
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
  runtime: ScannedRuntime,
  slotName: string,
): ActivationTarget {
  const slotId = `${runtime.id}\0${slotName}`;
  const to = context.intent === 'off' && (context.claims[slotId]?.length ?? 0) > 0
    ? 'on'
    : context.intent;
  const relationship = selectedRelationship(context, resource, runtime, slotName);
  const from = relationship?.activation ?? 'missing';
  const destination = activationDestination({
    relationship,
    from,
    to,
    runtime,
    slotName,
  });
  preflightTarget(relationship, from, to, destination);
  return {
    slotId,
    runtimeId: runtime.id,
    runtimeKey: runtime.key,
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
  runtime: ScannedRuntime,
): ActivationTarget[] {
  const existingSlots = [...new Set(resource.relationships.flatMap((relationship) =>
    relationship.runtimeId === runtime.id ? [relationship.slot] : []))];
  const slots = existingSlots.length > 0
    ? existingSlots
    : [normalizeSlotName(resource.name)];
  return slots.map((slot) => activationTarget(context, resource, runtime, slot));
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
  const value = state.claims ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.values(value).some((claims) =>
      !Array.isArray(claims) || claims.some((claim) => typeof claim !== 'string')))
    throw new Error('invalid state claims');
  return value as Record<string, string[]>;
}

export function planActivation(
  home: Home,
  selector: string,
  runtimeNames: string[],
  intent: Activation,
): ActivationPlan {
  if (runtimeNames.length === 0)
    throw new Error(`usage: skillspub ${intent === 'on' ? 'on' : 'off'} <selector> <runtime...>`);
  const report = scanGlobalInventory(home, undefined, { persist: false });
  const selected = runtimeNames.map((name) => {
    const matches = report.runtimes.filter((runtime) =>
      runtime.key === name || runtime.id === name);
    if (matches.length !== 1) throw new Error(`unknown Runtime: ${name}`);
    return matches[0];
  });
  const state = readState(home);
  const claims = readClaims(state);
  const { resourceIds, staleResourceIds } = expandSelector(home, selector, report);
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
      ? selected.flatMap((runtime) => activationTargets(context, resource, runtime))
      : [];
  });

  const unique = uniqueTargets(targets);
  preflightDependentLinks(report, unique);
  return { report, targets: unique, staleResourceIds: [] };
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
    candidate.runtimeId === target.runtimeId && candidate.name === target.slot)
    ?.relationships ?? [];
  if (relationships.length === 0)
    return target.to === 'off' && target.from === 'missing';
  const relationship = relationships[0];
  return relationships.length === 1 &&
    relationship.activation === target.to &&
    relationship.resourceId === (moved.get(target.resourceId) ?? target.resourceId);
}

export function remainingDrift(
  plan: ActivationPlan,
  actual: InventoryScanReport,
): string[] {
  const moved = movedResourceIds(plan);
  return plan.targets.flatMap((target) =>
    targetSatisfied(target, actual, moved)
      ? []
      : [`${target.runtimeId}/${target.slot}`]);
}

export function applyActivationPlan(home: Home, plan: ActivationPlan): void {
  const state = readState(home);
  const baseIntent = { ...readBaseIntent(state) };
  for (const target of plan.targets) baseIntent[target.slotId] = target.intent;
  state.baseIntent = baseIntent;
  writeState(home, state);

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

function resolveRuntimeKeys(
  report: InventoryScanReport,
  runtimeNames: string[],
): ScannedRuntime[] {
  if (runtimeNames.length === 0) throw new Error('at least one Runtime is required');
  return runtimeNames.map((name) => {
    const matches = report.runtimes.filter((runtime) => {
      if (runtime.key !== name && runtime.id !== name) return false;
      if (report.scope === 'project') return runtime.scope === 'project';
      return runtime.scope === 'global';
    });
    if (matches.length !== 1) throw new Error(`unknown Runtime: ${name}`);
    return matches[0];
  });
}

function resourceSlots(
  resource: InventoryResource,
  runtime: ScannedRuntime,
): string[] {
  const existing = [...new Set(resource.relationships.flatMap((relationship) =>
    relationship.runtimeId === runtime.id ? [relationship.slot] : []))];
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

  for (const [preset, runtimeKeys] of Object.entries(activations)) {
    const definition = presets[preset];
    if (!definition) {
      if (previousLastClaims[preset]) lastClaims[preset] = [...previousLastClaims[preset]];
      continue;
    }
    const runtimes = runtimeKeys.length > 0
      ? resolveRuntimeKeys(report, runtimeKeys)
      : report.runtimes.filter((runtime) =>
        report.scope === 'project' ? runtime.scope === 'project' : runtime.scope === 'global');
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
        for (const runtime of runtimes) {
          for (const slot of resourceSlots(resource, runtime)) {
            const slotId = `${runtime.id}\0${slot}`;
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
    const runtimeId = slotId.slice(0, separator);
    const slot = slotId.slice(separator + 1);
    const runtime = report.runtimes.find((candidate) => candidate.id === runtimeId);
    if (!runtime) continue;
    const claimed = (claims[slotId]?.length ?? 0) > 0 || frozen.has(slotId);
    const intent = baseIntent[slotId];
    // no claim and no base intent: leave Actual alone unless we previously claimed it
    if (!claimed && intent === undefined && !previousClaims[slotId]?.length) continue;

    const relationships = report.slots.find((candidate) =>
      candidate.runtimeId === runtimeId && candidate.name === slot)?.relationships ?? [];
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
      const destination = path.join(runtime.discoveryRoot, slot);
      preflightTarget(undefined, 'missing', desired, destination);
      targets.push({
        slotId,
        runtimeId,
        runtimeKey: runtime.key,
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
    if (from === desired) continue;

    const destination = activationDestination({
      relationship,
      from,
      to: desired,
      runtime,
      slotName: slot,
    });
    preflightTarget(relationship, from, desired, destination);
    targets.push({
      slotId,
      runtimeId,
      runtimeKey: runtime.key,
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
      Object.entries(activations).map(([name, runtimes]) => [
        name,
        [...runtimes].sort((a, b) => a.localeCompare(b)),
      ]),
    ),
    baseIntentDefaults,
  };
}

export function planPresetReconcile(
  home: Home,
  name?: string,
  runtimeNames?: string[],
  scope: PresetScope = {},
): PresetReconcilePlan {
  const { policyState, catalogState } = scopeScan(home, scope);
  const activations = readPresetActivations(policyState);
  if (name) {
    if (!readPresets(catalogState)[name] && !activations[name] &&
      !readStringListRecord(policyState.lastClaims, 'lastClaims')[name])
      throw new Error(`unknown preset: ${name}`);
    if (!activations[name] && runtimeNames && runtimeNames.length > 0)
      throw new Error(`preset is not active: ${name}`);
  }
  let next = { ...activations };
  if (name && runtimeNames && runtimeNames.length > 0) {
    // re-reconcile one preset on specific runtimes — keep activation as-is if present
    if (!next[name]) next[name] = [...runtimeNames];
  }
  if (name) {
    next = Object.fromEntries(Object.entries(next).filter(([preset]) => preset === name));
    // still need full claims from ALL activations for correct multi-preset slots
    next = activations;
  }
  return planFromActivations(home, next, scope);
}

export function activatePreset(
  home: Home,
  name: string,
  runtimeNames: string[],
  scope: PresetScope = {},
): PresetReconcilePlan {
  assertPresetName(name);
  const { report, catalogState, policyState } = scopeScan(home, scope);
  if (!readPresets(catalogState)[name]) throw new Error(`unknown preset: ${name}`);
  resolveRuntimeKeys(report, runtimeNames);
  const activations = readPresetActivations(policyState);
  const current = new Set(activations[name] ?? []);
  for (const runtime of runtimeNames) current.add(runtime);
  return planFromActivations(home, {
    ...activations,
    [name]: [...current],
  }, scope);
}

export function deactivatePreset(
  home: Home,
  name: string,
  runtimeNames: string[],
  scope: PresetScope = {},
): PresetReconcilePlan {
  assertPresetName(name);
  const { report, policyState } = scopeScan(home, scope);
  resolveRuntimeKeys(report, runtimeNames);
  const activations = readPresetActivations(policyState);
  if (!(name in activations) &&
    !readStringListRecord(policyState.lastClaims, 'lastClaims')[name])
    throw new Error(`preset is not active: ${name}`);
  const remaining = new Set(activations[name] ?? []);
  for (const runtime of runtimeNames) remaining.delete(runtime);
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
  } else if (options.projectPath) {
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

export function assertUnlinkAllowed(home: Home, slotIdOrName: string): void {
  const state = readStateFile(statePath(home));
  const claims = readStringListRecord(state.claims, 'claims');
  const lastClaims = readStringListRecord(state.lastClaims, 'lastClaims');
  const slotIds = slotIdOrName.includes('\0')
    ? [slotIdOrName]
    : Object.keys(claims).filter((slotId) => slotId.endsWith(`\0${slotIdOrName}`));
  const check = (slotId: string): void => {
    if ((claims[slotId]?.length ?? 0) > 0)
      throw new Error(`cannot unlink claimed Runtime Slot ${slotId.replace('\0', '/')}`);
    for (const [preset, slots] of Object.entries(lastClaims))
      if (slots.includes(slotId))
        throw new Error(
          `cannot unlink claimed Runtime Slot ${slotId.replace('\0', '/')} (${preset})`,
        );
  };
  if (slotIdOrName.includes('\0')) check(slotIdOrName);
  else {
    for (const slotId of slotIds) check(slotId);
    for (const [preset, slots] of Object.entries(lastClaims))
      for (const slotId of slots)
        if (slotId.endsWith(`\0${slotIdOrName}`))
          throw new Error(
            `cannot unlink claimed Runtime Slot ${slotId.replace('\0', '/')} (${preset})`,
          );
  }
}
