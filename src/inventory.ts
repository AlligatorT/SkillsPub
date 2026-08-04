import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Home } from './core.ts';

export type RuntimeKind = 'agent' | 'shared';
export type RuntimeScope = 'global' | 'project' | 'parent';
export type Activation = 'on' | 'off';
export type ResourceForm = 'local' | 'link';

export interface Runtime {
  key: string;
  kind: RuntimeKind;
  discoveryRoot: string;
  parkingRoot: string;
  projectPath: string;
  lockFile?: string;
}

export interface ScannedRuntime extends Runtime {
  id: string;
  scope: RuntimeScope;
  writable: boolean;
  sourceDirectory?: string;
}

export interface RuntimeRelationship {
  runtimeId: string;
  runtimeKey: string;
  slot: string;
  name: string;
  activation: Activation;
  form: ResourceForm;
  path: string;
  target?: string;
  realPath?: string;
  resourceId?: string;
  readOnly: boolean;
}

export interface SkillProvenance {
  source?: string;
  sourceUrl?: string;
  skillPath?: string;
}

export interface InventoryResource {
  id: string;
  name: string;
  realPath: string;
  hash: string;
  cliCoupled: boolean;
  relationships: RuntimeRelationship[];
}

export interface InventorySlot {
  id: string;
  runtimeId: string;
  runtimeKey: string;
  name: string;
  relationships: RuntimeRelationship[];
  provenance?: SkillProvenance;
}

export interface MissingRelationship {
  resourceId: string;
  runtimeId: string;
  slot: string;
}

export type FindingCategory = 'structural' | 'metadata' | 'change';

export interface ScanFinding {
  category: FindingCategory;
  code: string;
  message: string;
  resourceId?: string;
  runtimeId?: string;
  slot?: string;
}

export interface RuntimeInventoryMetadata {
  version: 1;
  resources: Record<string, {
    name: string;
    hash: string;
    firstSeenAt: string;
    lastSeenAt: string;
  }>;
  slots: Record<string, {
    resourceIds: string[];
    provenance?: SkillProvenance;
    lastSeenAt: string;
  }>;
}

export interface InventoryScanReport {
  scope: 'global' | 'project';
  projectPath?: string;
  runtimes: ScannedRuntime[];
  resources: InventoryResource[];
  slots: InventorySlot[];
  relationships: RuntimeRelationship[];
  missing: MissingRelationship[];
  findings: ScanFinding[];
  stateFile: string;
}

export interface ScanOptions {
  now?: string;
}

interface RuntimeRegistryFile {
  version: 1;
  runtimes: Runtime[];
}

function expandHome(value: string): string {
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}

function defaultRuntimes(): Runtime[] {
  const home = os.homedir();
  return [
    {
      key: 'claude',
      kind: 'agent',
      discoveryRoot: path.join(home, '.claude', 'skills'),
      parkingRoot: path.join(home, '.claude', '.skillspub-off', 'skills'),
      projectPath: '.claude/skills',
    },
    {
      key: 'shared',
      kind: 'shared',
      discoveryRoot: path.join(home, '.agents', 'skills'),
      parkingRoot: path.join(home, '.agents', '.skillspub-off', 'skills'),
      projectPath: '.agents/skills',
      lockFile: path.join(home, '.agents', '.skill-lock.json'),
    },
    {
      key: 'pi',
      kind: 'agent',
      discoveryRoot: path.join(home, '.pi', 'agent', 'skills'),
      parkingRoot: path.join(home, '.pi', 'agent', '.skillspub-off', 'skills'),
      projectPath: '.pi/agent/skills',
    },
  ];
}

function legacyRuntimes(file: string): Runtime[] | undefined {
  if (!fs.existsSync(file)) return undefined;
  const defaults = new Map(defaultRuntimes().map((runtime) => [runtime.key, runtime]));
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      if (separator === -1) throw new Error(`bad line in agents.conf: ${line}`);
      const legacyKey = line.slice(0, separator).trim();
      const key = legacyKey === 'agents' ? 'shared' : legacyKey;
      const discoveryRoot = expandHome(line.slice(separator + 1).trim());
      const known = defaults.get(key);
      const kind = known?.kind ?? 'agent';
      return {
        key,
        kind,
        discoveryRoot,
        parkingRoot: path.join(
          path.dirname(discoveryRoot),
          '.skillspub-off',
          path.basename(discoveryRoot),
        ),
        projectPath: known?.projectPath ?? path.join(`.${key}`, 'skills'),
        lockFile: kind === 'shared'
          ? path.join(path.dirname(discoveryRoot), '.skill-lock.json')
          : undefined,
      };
    });
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function loadRuntimes(home: Home): Runtime[] {
  const file = path.join(home.configDir, 'runtimes.json');
  if (!fs.existsSync(file)) {
    const runtimes = legacyRuntimes(path.join(home.configDir, 'agents.conf')) ?? defaultRuntimes();
    writeJson(file, { version: 1, runtimes } satisfies RuntimeRegistryFile);
    return runtimes;
  }

  let parsed: Partial<RuntimeRegistryFile>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RuntimeRegistryFile>;
  } catch (error) {
    throw new Error(`cannot read Runtime registry ${file}: ${(error as Error).message}`);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.runtimes))
    throw new Error(`invalid Runtime registry: ${file}`);
  const keys = new Set<string>();
  return parsed.runtimes.map((runtime) => {
    if (!runtime || typeof runtime.key !== 'string' ||
      (runtime.kind !== 'agent' && runtime.kind !== 'shared') ||
      typeof runtime.discoveryRoot !== 'string' ||
      typeof runtime.parkingRoot !== 'string' ||
      typeof runtime.projectPath !== 'string' || path.isAbsolute(runtime.projectPath) ||
      runtime.projectPath.split(path.sep).includes('..'))
      throw new Error(`invalid Runtime entry in ${file}`);
    if (keys.has(runtime.key)) throw new Error(`duplicate Runtime key: ${runtime.key}`);
    keys.add(runtime.key);
    const discoveryRoot = expandHome(runtime.discoveryRoot);
    let lockFile: string | undefined;
    if (runtime.lockFile) lockFile = expandHome(runtime.lockFile);
    else if (runtime.kind === 'shared')
      lockFile = path.join(path.dirname(discoveryRoot), '.skill-lock.json');
    return {
      ...runtime,
      discoveryRoot,
      parkingRoot: expandHome(runtime.parkingRoot),
      lockFile,
    };
  });
}

export function normalizeSlotName(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/[\s_]+/g, '-');
}

function runtimeSlotId(runtimeId: string, slot: string): string {
  return `${runtimeId}\0${slot}`;
}

function displayRuntimeSlot(id: string): string {
  return id.replace('\0', '/');
}

function targetOf(entryPath: string): string | undefined {
  try {
    return fs.readlinkSync(entryPath);
  } catch {
    return undefined;
  }
}

function scanRoot(
  runtime: ScannedRuntime,
  root: string,
  activation: Activation,
): RuntimeRelationship[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const relationships: RuntimeRelationship[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(root, entry.name);
    const form: ResourceForm = entry.isSymbolicLink() ? 'link' : 'local';
    let realPath: string | undefined;
    try {
      const stat = fs.statSync(entryPath);
      if (!stat.isDirectory() || !fs.existsSync(path.join(entryPath, 'SKILL.md'))) continue;
      realPath = fs.realpathSync(entryPath);
    } catch (error) {
      if (form !== 'link') throw error;
    }
    relationships.push({
      runtimeId: runtime.id,
      runtimeKey: runtime.key,
      slot: normalizeSlotName(entry.name),
      name: entry.name,
      activation,
      form,
      path: entryPath,
      target: form === 'link' ? targetOf(entryPath) : undefined,
      realPath,
      resourceId: realPath,
      readOnly: !runtime.writable,
    });
  }
  return relationships;
}

function assertExternalParking(runtime: Runtime): void {
  const relative = path.relative(runtime.discoveryRoot, runtime.parkingRoot);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))
    throw new Error(`parking root must be outside discovery root for Runtime ${runtime.key}`);
}

interface ProvenanceRead {
  entries: Map<string, SkillProvenance>;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readProvenance(file: string | undefined): ProvenanceRead {
  if (!file) return { entries: new Map() };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!isRecord(parsed)) throw new Error('lock must be a JSON object');
    const skills = parsed.skills;
    if (skills !== undefined && !isRecord(skills))
      throw new Error('lock.skills must be a JSON object');
    const entries: Array<[string, SkillProvenance]> = [];
    for (const [name, entry] of Object.entries(skills ?? {})) {
      if (!isRecord(entry)) throw new Error(`lock skill entry must be an object: ${name}`);
      for (const field of ['source', 'sourceUrl', 'skillPath'] as const) {
        if (entry[field] !== undefined && typeof entry[field] !== 'string')
          throw new Error(`lock skill ${name}.${field} must be a string`);
      }
      const provenance = {
        source: entry.source as string | undefined,
        sourceUrl: entry.sourceUrl as string | undefined,
        skillPath: entry.skillPath as string | undefined,
      };
      if (Object.values(provenance).some((value) => typeof value === 'string' && value))
        entries.push([normalizeSlotName(name), provenance]);
    }
    return { entries: new Map(entries) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: new Map() };
    return { entries: new Map(), error: `${file}: ${(error as Error).message}` };
  }
}

function isCliCoupled(root: string): boolean {
  try {
    const content = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    return Boolean(frontmatter && /(?:allowed-tools\s*:|Bash\()[\s\S]*?Bash\(/i.test(frontmatter));
  } catch {
    return false;
  }
}

function sameProvenance(
  left: SkillProvenance | undefined,
  right: SkillProvenance | undefined,
): boolean {
  return left?.source === right?.source &&
    left?.sourceUrl === right?.sourceUrl &&
    left?.skillPath === right?.skillPath;
}

function repoName(provenance: SkillProvenance): string | undefined {
  const raw = provenance.source ?? provenance.sourceUrl;
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/^git\+/, '')
    .replace(/^(?:https?|ssh):\/\/(?:git@)?(?:www\.)?(?:github\.com|gitlab\.com)\//, '')
    .replace(/^git@(?:github\.com|gitlab\.com):/, '')
    .replace(/\.git(?:#.*)?$/, '')
    .replace(/@[^/]+$/, '');
  const match = cleaned.match(/^([^/]+\/[^/]+)$/);
  return match?.[1];
}

function hashDirectory(root: string): string {
  const hash = crypto.createHash('sha256');
  const update = (value: string | Buffer): void => {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  };
  const visit = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const relative = path.join(prefix, entry.name);
      const entryPath = path.join(dir, entry.name);
      let kind = 'file';
      if (entry.isDirectory()) kind = 'directory';
      else if (entry.isSymbolicLink()) kind = 'link';
      update(kind);
      update(relative);
      if (entry.isDirectory()) visit(entryPath, relative);
      else if (entry.isSymbolicLink()) update(fs.readlinkSync(entryPath));
      else if (entry.isFile()) update(fs.readFileSync(entryPath));
    }
  };
  visit(root, '');
  return hash.digest('hex');
}

function readStateForUpdate(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('state must be a JSON object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`cannot read state ${file}: ${(error as Error).message}`);
  }
}

function writeState(file: string, state: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temporary, file);
}

interface ScanInventoryInput {
  scope: 'global' | 'project';
  stateFile: string;
  catalogStateFile: string;
  runtimes: ScannedRuntime[];
  options: ScanOptions;
  projectPath?: string;
}

type RelationshipsBySlot = Map<string, RuntimeRelationship[]>;

function groupRuntimeSlots(relationships: RuntimeRelationship[]): {
  bySlot: RelationshipsBySlot;
  findings: ScanFinding[];
} {
  const bySlot: RelationshipsBySlot = new Map();
  const findings: ScanFinding[] = [];
  for (const relationship of relationships) {
    const key = runtimeSlotId(relationship.runtimeId, relationship.slot);
    const groupedRelationships = bySlot.get(key) ?? [];
    groupedRelationships.push(relationship);
    bySlot.set(key, groupedRelationships);
    if (!relationship.realPath) findings.push({
      category: 'structural',
      code: 'broken-link',
      message: `broken link: ${relationship.path} -> ${relationship.target ?? '?'}`,
      runtimeId: relationship.runtimeId,
      slot: relationship.slot,
    });
  }
  return { bySlot, findings };
}

function scanSlotProvenance(
  runtimes: ScannedRuntime[],
  bySlot: RelationshipsBySlot,
  previous: RuntimeInventoryMetadata | undefined,
): {
  provenanceBySlot: Map<string, SkillProvenance>;
  invalidLockRuntimes: Set<string>;
  findings: ScanFinding[];
} {
  const provenanceBySlot = new Map<string, SkillProvenance>();
  const invalidLockRuntimes = new Set<string>();
  const findings: ScanFinding[] = [];
  for (const runtime of runtimes) {
    const lock = readProvenance(runtime.lockFile);
    if (lock.error) {
      invalidLockRuntimes.add(runtime.id);
      findings.push({
        category: 'structural',
        code: 'invalid-lock',
        message: `cannot read installer lock: ${lock.error}`,
        runtimeId: runtime.id,
      });
      for (const [key, occupants] of bySlot) {
        if (occupants[0].runtimeId !== runtime.id) continue;
        const prior = previous?.slots?.[key]?.provenance;
        if (prior) provenanceBySlot.set(key, prior);
      }
      continue;
    }
    for (const [slot, provenance] of lock.entries) {
      const key = runtimeSlotId(runtime.id, slot);
      const occupants = bySlot.get(key) ?? [];
      if (occupants.length === 0) findings.push({
        category: 'structural',
        code: 'lock-file-missing',
        message: `lock entry has no Runtime Slot file: ${runtime.key}/${slot}`,
        runtimeId: runtime.id,
        slot,
      });
      provenanceBySlot.set(key, provenance);
    }
  }
  return { provenanceBySlot, invalidLockRuntimes, findings };
}

function findRuntimeSlotIssues(
  bySlot: RelationshipsBySlot,
  provenanceBySlot: Map<string, SkillProvenance>,
  invalidLockRuntimes: Set<string>,
  previous: RuntimeInventoryMetadata | undefined,
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const [key, occupants] of bySlot) {
    const oldSlot = previous?.slots?.[key];
    if (oldSlot && !invalidLockRuntimes.has(occupants[0].runtimeId) &&
      !sameProvenance(oldSlot.provenance, provenanceBySlot.get(key)))
      findings.push({
        category: 'change',
        code: 'source-changed',
        message: `Runtime Slot provenance changed: ${displayRuntimeSlot(key)}`,
        runtimeId: occupants[0].runtimeId,
        slot: occupants[0].slot,
      });
    const activations = new Set(occupants.map(({ activation }) => activation));
    if (activations.size > 1) findings.push({
      category: 'structural',
      code: 'on-off-conflict',
      message: `Runtime Slot is present in ON and OFF roots: ${displayRuntimeSlot(key)}`,
      runtimeId: occupants[0].runtimeId,
      slot: occupants[0].slot,
    });
    if (new Set(occupants.map(({ name }) => name)).size > 1) findings.push({
      category: 'structural',
      code: 'slot-conflict',
      message: `multiple entry names normalize to Runtime Slot: ${displayRuntimeSlot(key)}`,
      runtimeId: occupants[0].runtimeId,
      slot: occupants[0].slot,
    });
  }
  return findings;
}

function scanRuntimeSlots(
  relationships: RuntimeRelationship[],
  runtimes: ScannedRuntime[],
  previous: RuntimeInventoryMetadata | undefined,
): { slots: InventorySlot[]; findings: ScanFinding[] } {
  const grouped = groupRuntimeSlots(relationships);
  const provenance = scanSlotProvenance(runtimes, grouped.bySlot, previous);
  const slots: InventorySlot[] = [...grouped.bySlot].map(([id, occupants]) => ({
    id,
    runtimeId: occupants[0].runtimeId,
    runtimeKey: occupants[0].runtimeKey,
    name: occupants[0].slot,
    relationships: occupants,
    provenance: provenance.provenanceBySlot.get(id),
  }));
  return {
    slots,
    findings: [
      ...grouped.findings,
      ...provenance.findings,
      ...findRuntimeSlotIssues(
        grouped.bySlot,
        provenance.provenanceBySlot,
        provenance.invalidLockRuntimes,
        previous,
      ),
    ],
  };
}

function scanInventoryResources(
  relationships: RuntimeRelationship[],
  runtimes: ScannedRuntime[],
): { resources: InventoryResource[]; missing: MissingRelationship[] } {
  const grouped = new Map<string, InventoryResource>();
  for (const relationship of relationships) {
    if (!relationship.realPath) continue;
    let resource = grouped.get(relationship.realPath);
    if (!resource) {
      resource = {
        id: relationship.realPath,
        name: relationship.name,
        realPath: relationship.realPath,
        hash: hashDirectory(relationship.realPath),
        cliCoupled: isCliCoupled(relationship.realPath),
        relationships: [],
      };
      grouped.set(resource.id, resource);
    }
    resource.relationships.push(relationship);
  }
  const resources = [...grouped.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const missing = resources.flatMap((resource) => runtimes
    .filter((runtime) => !resource.relationships.some((relationship) =>
      relationship.runtimeId === runtime.id && relationship.slot === normalizeSlotName(resource.name)))
    .map((runtime) => ({
      resourceId: resource.id,
      runtimeId: runtime.id,
      slot: normalizeSlotName(resource.name),
    })));
  return { resources, missing };
}

function findResourceIssues(
  resources: InventoryResource[],
  previous: RuntimeInventoryMetadata | undefined,
  tags: Record<string, string[]>,
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const currentResourceIds = new Set(resources.map(({ id }) => id));
  for (const resource of resources) {
    const old = previous?.resources?.[resource.id];
    if (!old) findings.push({
      category: 'change',
      code: 'new-resource',
      message: `new resource: ${resource.name} (${resource.realPath})`,
      resourceId: resource.id,
    });
    else if (old.hash !== resource.hash) findings.push({
      category: 'change',
      code: 'changed-resource',
      message: `resource content changed: ${resource.name} (${resource.realPath})`,
      resourceId: resource.id,
    });
    if ((tags[resource.id] ?? []).length === 0) findings.push({
      category: 'metadata',
      code: 'untagged',
      message: `untagged resource: ${resource.name} (${resource.realPath})`,
      resourceId: resource.id,
    });
    if (resource.cliCoupled) findings.push({
      category: 'metadata',
      code: 'cli-coupled',
      message: `CLI-coupled resource: ${resource.name} (${resource.realPath})`,
      resourceId: resource.id,
    });
  }
  for (const [resourceId, old] of Object.entries(previous?.resources ?? {})) {
    if (!currentResourceIds.has(resourceId)) findings.push({
      category: 'change',
      code: 'removed-resource',
      message: `resource removed: ${old.name} (${resourceId})`,
      resourceId,
    });
  }
  return findings;
}

function buildInventoryMetadata(
  resources: InventoryResource[],
  slots: InventorySlot[],
  previous: RuntimeInventoryMetadata | undefined,
  now: string,
): RuntimeInventoryMetadata {
  return {
    version: 1,
    resources: Object.fromEntries(resources.map((resource) => [resource.id, {
      name: resource.name,
      hash: resource.hash,
      firstSeenAt: previous?.resources?.[resource.id]?.firstSeenAt ?? now,
      lastSeenAt: now,
    }])),
    slots: Object.fromEntries(slots.map((slot) => [
      slot.id,
      {
        resourceIds: [...new Set(slot.relationships.flatMap(({ resourceId }) =>
          resourceId ? [resourceId] : []))].sort((a, b) => a.localeCompare(b)),
        provenance: slot.provenance,
        lastSeenAt: now,
      },
    ])),
  };
}

function buildRepoBundles(
  value: unknown,
  resources: InventoryResource[],
  slots: InventorySlot[],
): Record<string, string[]> {
  const bundles = isRecord(value) ? value as Record<string, string[]> : {};
  const nextBundles = Object.fromEntries(
    Object.entries(bundles).map(([name, members]) => [name, [...members]]),
  ) as Record<string, string[]>;
  const currentResourceIds = new Set(resources.map(({ id }) => id));
  for (const [name, members] of Object.entries(nextBundles)) {
    if (!name.startsWith('repo:')) continue;
    nextBundles[name] = members.filter((member) => !currentResourceIds.has(member));
    if (nextBundles[name].length === 0) delete nextBundles[name];
  }
  for (const slot of slots) {
    const repo = slot.provenance ? repoName(slot.provenance) : undefined;
    if (!repo) continue;
    const name = `repo:${repo}`;
    const resourceIds = slot.relationships.flatMap(({ resourceId }) =>
      resourceId ? [resourceId] : []);
    nextBundles[name] = [...new Set([...(nextBundles[name] ?? []), ...resourceIds])]
      .sort((a, b) => a.localeCompare(b));
  }
  return nextBundles;
}

function scanInventory({
  scope,
  stateFile,
  catalogStateFile,
  runtimes,
  options,
  projectPath,
}: ScanInventoryInput): InventoryScanReport {
  const now = options.now ?? new Date().toISOString();
  const relationships = runtimes.flatMap((runtime) => {
    assertExternalParking(runtime);
    return [
      ...scanRoot(runtime, runtime.discoveryRoot, 'on'),
      ...scanRoot(runtime, runtime.parkingRoot, 'off'),
    ];
  });
  const { resources, missing } = scanInventoryResources(relationships, runtimes);
  const state = readStateForUpdate(stateFile);
  const previous = state.runtimeInventory as RuntimeInventoryMetadata | undefined;
  const slotScan = scanRuntimeSlots(relationships, runtimes, previous);

  const catalogState = catalogStateFile === stateFile
    ? state
    : readStateForUpdate(catalogStateFile);
  const tags = isRecord(catalogState.tags)
    ? catalogState.tags as Record<string, string[]>
    : {};
  const findings = [
    ...slotScan.findings,
    ...findResourceIssues(resources, previous, tags),
  ];
  const metadata = buildInventoryMetadata(resources, slotScan.slots, previous, now);
  const nextBundles = buildRepoBundles(catalogState.bundles, resources, slotScan.slots);
  writeState(stateFile, scope === 'global'
    ? { ...state, bundles: nextBundles, tags, runtimeInventory: metadata }
    : { ...state, runtimeInventory: metadata });

  return {
    scope,
    projectPath,
    runtimes,
    resources,
    slots: slotScan.slots,
    relationships,
    missing,
    findings,
    stateFile,
  };
}

export function scanGlobalInventory(
  home: Home,
  runtimes: Runtime[] = loadRuntimes(home),
  options: ScanOptions = {},
): InventoryScanReport {
  const stateFile = path.join(home.configDir, 'state.json');
  return scanInventory({
    scope: 'global',
    stateFile,
    catalogStateFile: stateFile,
    runtimes: runtimes.map((runtime) => ({
      ...runtime,
      id: `global:${runtime.key}`,
      scope: 'global',
      writable: true,
    })),
    options,
  });
}

function rootIdentity(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

function projectRuntime(
  runtime: Runtime,
  directory: string,
  scope: 'project' | 'parent',
): ScannedRuntime {
  const runtimeKey = runtime.kind === 'shared' ? 'shared' : runtime.key;
  return {
    ...runtime,
    id: `${scope}:${directory}:${runtime.key}`,
    scope,
    writable: scope === 'project',
    sourceDirectory: directory,
    discoveryRoot: path.join(directory, runtime.projectPath),
    parkingRoot: path.join(directory, '.skillspub', 'off', runtimeKey),
    lockFile: runtime.kind === 'shared'
      ? path.join(directory, 'skills-lock.json')
      : undefined,
  };
}

export function scanProjectInventory(
  home: Home,
  selectedPath: string,
  runtimes: Runtime[] = loadRuntimes(home),
  options: ScanOptions = {},
): InventoryScanReport {
  const projectPath = fs.realpathSync(selectedPath);
  if (!fs.statSync(projectPath).isDirectory())
    throw new Error(`Project path is not a directory: ${selectedPath}`);

  const scanned: ScannedRuntime[] = runtimes.map((runtime) =>
    projectRuntime(runtime, projectPath, 'project'));
  const globalRoots = new Set(runtimes.map((runtime) =>
    rootIdentity(runtime.discoveryRoot)));
  for (let directory = path.dirname(projectPath);;) {
    for (const runtime of runtimes) {
      const inherited = projectRuntime(runtime, directory, 'parent');
      const exists = fs.existsSync(inherited.discoveryRoot) ||
        fs.existsSync(inherited.parkingRoot);
      if (exists && !globalRoots.has(rootIdentity(inherited.discoveryRoot)))
        scanned.push(inherited);
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  scanned.push(...runtimes.map((runtime) => ({
    ...runtime,
    id: `global:${runtime.key}`,
    scope: 'global' as const,
    writable: false,
  })));

  return scanInventory({
    scope: 'project',
    stateFile: path.join(projectPath, '.skillspub', 'state.json'),
    catalogStateFile: path.join(home.configDir, 'state.json'),
    runtimes: scanned,
    options,
    projectPath,
  });
}
