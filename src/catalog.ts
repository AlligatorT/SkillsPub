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
  runtimeInventory?: {
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
    stale: current[id] === undefined || !fs.existsSync(id),
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
    throw new Error('removing a Preset definition requires: skillspub preset delete <name> [--yes]');
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
