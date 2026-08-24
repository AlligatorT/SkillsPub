import fs from 'node:fs';
import path from 'node:path';
import type { Home } from './core.ts';
import {
  readStateFile,
  writeStateFile,
  type InventoryScanReport,
} from './inventory.ts';

interface ResourceMetadata {
  name: string;
}

interface PresetDefinition {
  selectors: string[];
}

export interface CatalogState extends Record<string, unknown> {
  bundles?: Record<string, string[]>;
  presets?: Record<string, PresetDefinition>;
  targetInventory?: {
    resources?: Record<string, ResourceMetadata>;
  };
}


export interface PresetSelector {
  selector: string;
}


export interface BundleMember {
  id: string;
  name?: string;
  stale: boolean;
}



export function statePath(home: Home): string {
  return path.join(home.configDir, 'state.json');
}

export function readState(home: Home): CatalogState {
  return readStateFile(statePath(home)) as CatalogState;
}

export function writeState(home: Home, state: CatalogState): void {
  writeStateFile(statePath(home), state);
}

export function readBundles(state: CatalogState): Record<string, string[]> {
  const value = state.bundles ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.values(value).some((members) =>
      !Array.isArray(members) || members.some((member) => typeof member !== 'string')))
    throw new Error('invalid state bundles');
  return value;
}

export function readTags(state: CatalogState): Record<string, string[]> {
  const value = state.tags ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.values(value).some((tags) =>
      !Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')))
    throw new Error('invalid state tags');
  return value as Record<string, string[]>;
}

function resources(state: CatalogState): Record<string, ResourceMetadata> {
  return state.targetInventory?.resources ?? {};
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
    stale: current[id] === undefined || !fs.existsSync(id),
  }));
}

export function createBundle(home: Home, name: string, selectors: string[]): number {
  const plan = planCatalogMutation(home, undefined, {
    operation: 'bundle.create', name, selectors,
  });
  applyCatalogMutation(home, plan);
  return plan.changed;
}

export function addBundleMembers(home: Home, name: string, selectors: string[]): number {
  const plan = planCatalogMutation(home, undefined, {
    operation: 'bundle.add', name, selectors,
  });
  applyCatalogMutation(home, plan);
  return plan.changed;
}

export function removeBundleMembers(
  home: Home,
  name: string,
  selectors?: string[],
): number | undefined {
  const plan = planCatalogMutation(home, undefined, {
    operation: 'bundle.rm', name, selectors: selectors ?? [],
  });
  applyCatalogMutation(home, plan);
  return selectors?.length ? plan.changed : undefined;
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
  const plan = planCatalogMutation(home, undefined, {
    operation: 'tag.add', resource: selector, names,
  });
  applyCatalogMutation(home, plan);
  return plan.changed;
}

export function removeResourceTags(
  home: Home,
  selector: string,
  names?: string[],
): number {
  const plan = planCatalogMutation(home, undefined, {
    operation: 'tag.rm', resource: selector, names: names ?? [],
  });
  applyCatalogMutation(home, plan);
  return plan.changed;
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

export function readPresets(state: CatalogState): Record<string, PresetDefinition> {
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

export function assertPresetName(name: string): void {
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
  const plan = planCatalogMutation(home, undefined, {
    operation: 'preset.create', name, selectors,
  });
  applyCatalogMutation(home, plan);
  return plan.changed;
}

export function addPresetSelectors(home: Home, name: string, selectors: string[]): number {
  const plan = planCatalogMutation(home, undefined, {
    operation: 'preset.add', name, selectors,
  });
  applyCatalogMutation(home, plan);
  return plan.changed;
}

export function removePresetSelectors(
  home: Home,
  name: string,
  selectors?: string[],
): number | undefined {
  const plan = planCatalogMutation(home, undefined, {
    operation: 'preset.rm', name, selectors: selectors ?? [],
  });
  applyCatalogMutation(home, plan);
  return plan.changed;
}

export type CatalogMutation =
  | { operation: 'bundle.create'; name: string; selectors: string[] }
  | { operation: 'bundle.add'; name: string; selectors: string[] }
  | { operation: 'bundle.rm'; name: string; selectors: string[] }
  | { operation: 'tag.add'; resource: string; names: string[] }
  | { operation: 'tag.rm'; resource: string; names: string[] }
  | { operation: 'preset.create'; name: string; selectors: string[] }
  | { operation: 'preset.add'; name: string; selectors: string[] }
  | { operation: 'preset.rm'; name: string; selectors: string[] };

export interface CatalogMutationPlan {
  operation: CatalogMutation['operation'];
  collection: 'bundles' | 'tags' | 'presets';
  expected: Record<string, unknown>;
  next: Record<string, unknown>;
  changed: number;
}

function catalogPlanningState(
  home: Home,
  report?: InventoryScanReport,
): CatalogState {
  const state = readState(home);
  if (!report) return state;
  return {
    ...state,
    targetInventory: {
      resources: Object.fromEntries(report.resources.map(({ id, name }) => [id, { name }])),
    },
  };
}

export function planCatalogMutation(
  home: Home,
  report: InventoryScanReport | undefined,
  mutation: CatalogMutation,
): CatalogMutationPlan {
  const state = catalogPlanningState(home, report);
  if (mutation.operation === 'bundle.create' ||
    mutation.operation === 'bundle.add' || mutation.operation === 'bundle.rm') {
    assertManualBundle(mutation.name);
    const expected = readBundles(state);
    const current = expected[mutation.name];
    let members: string[] | undefined;
    if (mutation.operation === 'bundle.create') {
      if (current) throw new Error(`bundle already exists: ${mutation.name}`);
      members = [...new Set(mutation.selectors.map((selector) => resourceId(selector, state)))]
        .sort((a, b) => a.localeCompare(b));
    } else {
      if (!current) throw new Error(`unknown bundle: ${mutation.name}`);
      if (mutation.operation === 'bundle.add') {
        if (mutation.selectors.length === 0)
          throw new Error('bundle add requires at least one skill selector');
        members = [...new Set([
          ...current,
          ...mutation.selectors.map((selector) => resourceId(selector, state)),
        ])].sort((a, b) => a.localeCompare(b));
      } else if (mutation.selectors.length > 0) {
        const removed = new Set(mutation.selectors.map((selector) =>
          resourceId(selector, state, current)));
        members = current.filter((member) => !removed.has(member));
      }
    }
    const { [mutation.name]: _, ...remaining } = expected;
    const next = members === undefined
      ? remaining
      : { ...expected, [mutation.name]: members };
    return {
      operation: mutation.operation,
      collection: 'bundles',
      expected,
      next,
      changed: current ? Math.abs(current.length - (members?.length ?? 0)) : members?.length ?? 0,
    };
  }

  if (mutation.operation === 'tag.add' || mutation.operation === 'tag.rm') {
    if (mutation.operation === 'tag.add') assertTagNames(mutation.names);
    else if (mutation.names.some((name) => !name)) throw new Error('tags must be non-empty');
    const expected = readTags(state);
    const id = resourceId(mutation.resource, state, Object.keys(expected));
    const current = expected[id] ?? [];
    const names = mutation.operation === 'tag.add'
      ? [...new Set([...current, ...mutation.names])].sort((a, b) => a.localeCompare(b))
      : current.filter((name) => !(mutation.names.length > 0
          ? new Set(mutation.names)
          : new Set(current)).has(name));
    const { [id]: _, ...remaining } = expected;
    const next = names.length > 0 ? { ...remaining, [id]: names } : remaining;
    return {
      operation: mutation.operation,
      collection: 'tags',
      expected,
      next,
      changed: Math.abs(current.length - names.length),
    };
  }

  assertPresetName(mutation.name);
  const expected = readPresets(state);
  const current = expected[mutation.name];
  let selectors: string[];
  if (mutation.operation === 'preset.create') {
    if (current) throw new Error(`preset already exists: ${mutation.name}`);
    selectors = [...new Set(mutation.selectors.map((selector) =>
      normalizePresetSelector(selector, state)))].sort((a, b) => a.localeCompare(b));
  } else {
    if (!current) throw new Error(`unknown preset: ${mutation.name}`);
    if (mutation.operation === 'preset.add') {
      if (mutation.selectors.length === 0)
        throw new Error('preset add requires at least one selector');
      selectors = [...new Set([
        ...current.selectors,
        ...mutation.selectors.map((selector) => normalizePresetSelector(selector, state)),
      ])].sort((a, b) => a.localeCompare(b));
    } else {
      if (mutation.selectors.length === 0)
        throw new Error('removing a Preset definition requires: skillspub preset delete <name> [--yes]');
      const removed = new Set(mutation.selectors.map((selector) => {
        try {
          return normalizePresetSelector(selector, state);
        } catch {
          return selector;
        }
      }));
      selectors = current.selectors.filter((selector) => !removed.has(selector));
    }
  }
  const next = { ...expected, [mutation.name]: { selectors } };
  return {
    operation: mutation.operation,
    collection: 'presets',
    expected,
    next,
    changed: current ? Math.abs(current.selectors.length - selectors.length) : selectors.length,
  };
}

export function applyCatalogMutation(home: Home, plan: CatalogMutationPlan): { changed: number } {
  const state = readState(home);
  const current = plan.collection === 'bundles'
    ? readBundles(state)
    : plan.collection === 'tags'
      ? readTags(state)
      : readPresets(state);
  if (JSON.stringify(current) !== JSON.stringify(plan.expected))
    throw Object.assign(
      new Error(`${plan.collection} changed after preview; preview again`),
      { code: 'concurrent_modification' },
    );
  if (plan.collection === 'bundles') state.bundles = plan.next as Record<string, string[]>;
  else if (plan.collection === 'tags') state.tags = plan.next as Record<string, string[]>;
  else state.presets = plan.next as Record<string, PresetDefinition>;
  writeState(home, state);
  const written = readState(home)[plan.collection] ?? {};
  if (JSON.stringify(written) !== JSON.stringify(plan.next))
    throw Object.assign(
      new Error(`${plan.collection} verification failed`),
      { code: 'apply_failed', details: { partialEffects: 'unknown' } },
    );
  return { changed: plan.changed };
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
