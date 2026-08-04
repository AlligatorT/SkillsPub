import fs from 'node:fs';
import path from 'node:path';
import type { Home } from './core.ts';
import {
  normalizeSlotName,
  readStateFile,
  scanGlobalInventory,
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

interface CatalogState extends Record<string, unknown> {
  bundles?: Record<string, string[]>;
  runtimeInventory?: {
    resources?: Record<string, ResourceMetadata>;
  };
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
