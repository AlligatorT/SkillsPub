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
  inspectionError?: string;
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

export interface DoctorRepair {
  id: string;
  kind: 'remove-broken-link' | 'retarget-link' | 'migrate-legacy-off';
  path: string;
  from: string;
  to?: string;
  targetResourceId?: string;
  targetHash?: string;
  runtimeId: string;
  slot: string;
}

export interface DoctorReport extends InventoryScanReport {
  repairs: DoctorRepair[];
}

export interface DoctorApplyResult {
  completed: DoctorRepair[];
  failed?: { repair: DoctorRepair; error: string };
}

export interface ScanOptions {
  now?: string;
  persist?: boolean;
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

export function loadRuntimes(
  home: Home,
  options: { persist?: boolean } = {},
): Runtime[] {
  const file = path.join(home.configDir, 'runtimes.json');
  if (!fs.existsSync(file)) {
    const runtimes = legacyRuntimes(path.join(home.configDir, 'agents.conf')) ?? defaultRuntimes();
    if (options.persist !== false)
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

export function normalizeManagedSkillName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .substring(0, 255) || 'unnamed-skill';
}

export function runtimeSlotId(runtimeId: string, slot: string): string {
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
    let inspectionError: string | undefined;
    try {
      const stat = fs.statSync(entryPath);
      if (!stat.isDirectory() || !fs.existsSync(path.join(entryPath, 'SKILL.md'))) continue;
      realPath = fs.realpathSync(entryPath);
    } catch (error) {
      if (form !== 'link') throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR')
        inspectionError = `${code ?? 'I/O'}: ${(error as Error).message}`;
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
      inspectionError,
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

export interface ManagedSkill {
  name: string;
  slot: string;
  provenance: SkillProvenance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readManagedSkillLock(file: string): ManagedSkill[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`${file}: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error(`${file}: lock must be a JSON object`);
  if (parsed.version !== 3) throw new Error(`${file}: lock.version must be 3`);
  const skills = parsed.skills;
  if (skills !== undefined && !isRecord(skills))
    throw new Error(`${file}: lock.skills must be a JSON object`);
  const slots = new Set<string>();
  return Object.entries(skills ?? {}).map(([name, entry]) => {
    if (!isRecord(entry)) throw new Error(`${file}: lock skill entry must be an object: ${name}`);
    for (const field of ['source', 'sourceUrl', 'skillPath'] as const) {
      if (entry[field] !== undefined && typeof entry[field] !== 'string')
        throw new Error(`${file}: lock skill ${name}.${field} must be a string`);
    }
    const slot = normalizeSlotName(normalizeManagedSkillName(name));
    if (slots.has(slot)) throw new Error(`${file}: duplicate normalized lock skill: ${slot}`);
    slots.add(slot);
    return {
      name,
      slot,
      provenance: {
        source: entry.source as string | undefined,
        sourceUrl: entry.sourceUrl as string | undefined,
        skillPath: entry.skillPath as string | undefined,
      },
    };
  });
}

function readProvenance(file: string | undefined): ProvenanceRead {
  if (!file) return { entries: new Map() };
  try {
    const entries = readManagedSkillLock(file)
      .filter(({ provenance }) => Object.values(provenance).some(Boolean))
      .map(({ slot, provenance }) => [slot, provenance] as const);
    return { entries: new Map(entries) };
  } catch (error) {
    return { entries: new Map(), error: (error as Error).message };
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

export function readStateFile(file: string): Record<string, unknown> {
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

export function writeStateFile(file: string, state: Record<string, unknown>): void {
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
      code: relationship.inspectionError ? 'unreadable-link' : 'broken-link',
      message: relationship.inspectionError
        ? `cannot inspect link: ${relationship.path}: ${relationship.inspectionError}`
        : `broken link: ${relationship.path} -> ${relationship.target ?? '?'}`,
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
    const resourceIds = [...new Set(slot.relationships.flatMap(({ resourceId }) =>
      resourceId ? [resourceId] : []))];
    if (resourceIds.length !== 1) continue;
    const name = `repo:${repo}`;
    nextBundles[name] = [...new Set([...(nextBundles[name] ?? []), resourceIds[0]])]
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
  const state = readStateFile(stateFile);
  const previous = state.runtimeInventory as RuntimeInventoryMetadata | undefined;
  const slotScan = scanRuntimeSlots(relationships, runtimes, previous);

  const catalogState = catalogStateFile === stateFile
    ? state
    : readStateFile(catalogStateFile);
  const tags = isRecord(catalogState.tags)
    ? catalogState.tags as Record<string, string[]>
    : {};
  const findings = [
    ...slotScan.findings,
    ...findResourceIssues(resources, previous, tags),
  ];
  if (options.persist !== false) {
    const metadata = buildInventoryMetadata(resources, slotScan.slots, previous, now);
    const nextBundles = buildRepoBundles(catalogState.bundles, resources, slotScan.slots);
    writeStateFile(stateFile, scope === 'global'
      ? { ...state, bundles: nextBundles, tags, runtimeInventory: metadata }
      : { ...state, runtimeInventory: metadata });
  }

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

function assertBrokenLink(repair: DoctorRepair): void {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(repair.path);
  } catch (error) {
    throw new Error(`repair path is missing: ${repair.path}: ${(error as Error).message}`);
  }
  if (!entry.isSymbolicLink())
    throw new Error(`repair path is no longer a symlink: ${repair.path}`);
  const target = fs.readlinkSync(repair.path);
  if (target !== repair.from)
    throw new Error(`repair target changed: ${repair.path}: ${target}`);
  try {
    fs.statSync(path.resolve(path.dirname(repair.path), target));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw new Error(`cannot verify repair target: ${repair.path}: ${(error as Error).message}`);
  }
  throw new Error(`repair target is no longer broken: ${repair.path}`);
}

function repairTemporaryPath(repair: DoctorRepair, index: number): string {
  return `${repair.path}.skillspub-repair-${process.pid}-${index}`;
}

function assertRetargetTarget(repair: DoctorRepair): void {
  if (repair.kind === 'remove-broken-link') return;
  if (!repair.to || !repair.targetResourceId || !repair.targetHash)
    throw new Error(`retarget repair has no verified target: ${repair.path}`);
  const target = path.resolve(path.dirname(repair.path), repair.to);
  const stat = fs.statSync(target);
  if (!stat.isDirectory() || !fs.existsSync(path.join(target, 'SKILL.md')))
    throw new Error(`retarget repair target is not a Skill resource: ${target}`);
  if (fs.realpathSync(target) !== repair.targetResourceId)
    throw new Error(`retarget repair target identity changed: ${target}`);
  if (hashDirectory(target) !== repair.targetHash)
    throw new Error(`retarget repair target content changed: ${target}`);
}

function preflightDoctorRepair(repair: DoctorRepair, index: number): void {
  if (repair.kind === 'migrate-legacy-off') {
    if (!fs.lstatSync(repair.path, { throwIfNoEntry: false }))
      throw new Error(`repair path is missing: ${repair.path}`);
    if (!repair.to) throw new Error(`migrate-legacy-off repair has no destination: ${repair.path}`);
    if (fs.lstatSync(repair.to, { throwIfNoEntry: false }))
      throw new Error(`migrate-legacy-off destination already exists: ${repair.to}`);
    fs.accessSync(path.dirname(repair.path), fs.constants.W_OK | fs.constants.X_OK);
    return;
  }
  assertBrokenLink(repair);
  fs.accessSync(path.dirname(repair.path), fs.constants.W_OK | fs.constants.X_OK);
  if (repair.kind === 'remove-broken-link') return;
  assertRetargetTarget(repair);
  const temporary = repairTemporaryPath(repair, index);
  try {
    fs.lstatSync(temporary);
    throw new Error(`temporary repair path already exists: ${temporary}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function applyDoctorRepair(repair: DoctorRepair, index: number): void {
  if (repair.kind === 'migrate-legacy-off') {
    if (!repair.to) throw new Error(`migrate-legacy-off repair has no destination: ${repair.path}`);
    if (fs.lstatSync(repair.to, { throwIfNoEntry: false }))
      throw new Error(`migrate-legacy-off destination already exists: ${repair.to}`);
    fs.mkdirSync(path.dirname(repair.to), { recursive: true });
    fs.renameSync(repair.path, repair.to);
    return;
  }
  assertBrokenLink(repair);
  if (repair.kind === 'remove-broken-link') {
    fs.unlinkSync(repair.path);
    return;
  }
  assertRetargetTarget(repair);
  if (!repair.to) throw new Error(`retarget repair has no target: ${repair.path}`);
  const temporary = repairTemporaryPath(repair, index);
  fs.symlinkSync(repair.to, temporary);
  try {
    fs.renameSync(temporary, repair.path);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      throw new Error(
        `${(error as Error).message}; temporary link remains at ${temporary}: ` +
        (cleanupError as Error).message,
      );
    }
    throw error;
  }
}

export function applyDoctorRepairs(repairs: DoctorRepair[]): DoctorApplyResult {
  const paths = new Set<string>();
  for (const [index, repair] of repairs.entries()) {
    if (paths.has(repair.path)) throw new Error(`duplicate repair path: ${repair.path}`);
    paths.add(repair.path);
    preflightDoctorRepair(repair, index);
  }

  const completed: DoctorRepair[] = [];
  for (const [index, repair] of repairs.entries()) {
    try {
      applyDoctorRepair(repair, index);
      completed.push(repair);
    } catch (error) {
      return {
        completed,
        failed: { repair, error: (error as Error).message },
      };
    }
  }
  return { completed };
}

interface RetargetEvidence {
  occupants: Map<string, string>;
  currentHashes: Map<string, string>;
  priorResourceIds: Set<string>;
  priorResources: Record<string, unknown>;
}

function matchingCounterpart(
  target: string,
  root: string,
  counterpart: string,
  evidence: RetargetEvidence,
): string | undefined {
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return undefined;
  const candidate = path.resolve(counterpart, relative);
  const candidateResourceId = evidence.occupants.get(candidate);
  const priorResourceId = path.resolve(rootIdentity(root), relative);
  const priorResource = evidence.priorResources[priorResourceId];
  if (!candidateResourceId || !evidence.priorResourceIds.has(priorResourceId) ||
    !isRecord(priorResource) || typeof priorResource.hash !== 'string' ||
    evidence.currentHashes.get(candidateResourceId) !== priorResource.hash)
    return undefined;
  return candidate;
}

function replacementTarget(
  relationship: RuntimeRelationship,
  report: InventoryScanReport,
  state: Record<string, unknown>,
): string | undefined {
  const rawTarget = relationship.target;
  if (!rawTarget) return undefined;
  const target = path.resolve(path.dirname(relationship.path), rawTarget);
  const evidence: RetargetEvidence = {
    occupants: new Map(report.relationships.flatMap(({ path: entryPath, realPath }) =>
      realPath ? [[path.resolve(entryPath), realPath] as const] : [])),
    currentHashes: new Map(report.resources.map(({ id, hash }) => [id, hash])),
    priorResourceIds: previousResourceIds(state, relationship),
    priorResources: isRecord(state.runtimeInventory) && isRecord(state.runtimeInventory.resources)
      ? state.runtimeInventory.resources
      : {},
  };
  const candidates = new Set<string>();
  for (const runtime of report.runtimes) {
    for (const [root, counterpart] of [
      [runtime.discoveryRoot, runtime.parkingRoot],
      [runtime.parkingRoot, runtime.discoveryRoot],
    ]) {
      const candidate = matchingCounterpart(target, root, counterpart, evidence);
      if (candidate) candidates.add(candidate);
    }
  }
  if (candidates.size !== 1) return undefined;
  const candidate = [...candidates][0];
  return path.isAbsolute(rawTarget)
    ? candidate
    : path.relative(path.dirname(relationship.path), candidate);
}

function resourceExists(resources: Set<string>, resourceId: string): boolean {
  if (resources.has(resourceId)) return true;
  try {
    return fs.statSync(resourceId).isDirectory() &&
      fs.statSync(path.join(resourceId, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
}

function staleBundleReferences(
  value: unknown,
  resources: Set<string>,
): Array<[string, string]> {
  if (!isRecord(value)) return [];
  const stale: Array<[string, string]> = [];
  for (const [bundle, members] of Object.entries(value)) {
    if (!Array.isArray(members)) continue;
    for (const member of members)
      if (typeof member === 'string' && !resourceExists(resources, member))
        stale.push([`Bundle ${bundle}:${member}`, member]);
  }
  return stale;
}

function staleTagReferences(
  value: unknown,
  resources: Set<string>,
): Array<[string, string]> {
  if (!isRecord(value)) return [];
  return Object.keys(value).flatMap((resourceId) =>
    resourceExists(resources, resourceId) ? [] : [[`Tag:${resourceId}`, resourceId]]);
}

function stalePresetReferences(
  value: unknown,
  resources: Set<string>,
): Array<[string, string]> {
  if (!isRecord(value)) return [];
  const stale: Array<[string, string]> = [];
  for (const preset of Object.values(value)) {
    if (!isRecord(preset) || !Array.isArray(preset.selectors)) continue;
    for (const selector of preset.selectors) {
      if (typeof selector !== 'string' || !selector.startsWith('skill:')) continue;
      const resourceId = selector.slice('skill:'.length);
      if (!resourceExists(resources, resourceId))
        stale.push([`Preset:${selector}`, resourceId]);
    }
  }
  return stale;
}

function staleReferenceFindings(
  report: InventoryScanReport,
  catalog: Record<string, unknown>,
): ScanFinding[] {
  const resources = new Set(report.resources.map(({ id }) => id));
  const stale = new Map([
    ...staleBundleReferences(catalog.bundles, resources),
    ...staleTagReferences(catalog.tags, resources),
    ...stalePresetReferences(catalog.presets, resources),
  ]);
  return [...stale].map(([reference, resourceId]) => ({
    category: 'structural',
    code: 'stale-reference',
    message: `stale reference preserved: ${reference}`,
    resourceId,
  }));
}

function activePresetNames(state: Record<string, unknown>): string[] {
  const value = state.presetActivations;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return isRecord(value) ? Object.keys(value) : [];
}

function orphanedPresetFindings(
  report: InventoryScanReport,
  state: Record<string, unknown>,
  catalog: Record<string, unknown>,
): ScanFinding[] {
  if (report.scope !== 'project') return [];
  const definitions = new Set(isRecord(catalog.presets) ? Object.keys(catalog.presets) : []);
  return activePresetNames(state).flatMap((preset) => definitions.has(preset) ? [] : [{
    category: 'structural',
    code: 'orphaned-preset-activation',
    message: `Orphaned Preset Activation: ${preset}; lastClaims frozen`,
  }]);
}

function baseIntents(state: Record<string, unknown>): Map<string, Activation> {
  const intents = new Map<string, Activation>();
  if (!isRecord(state.baseIntent)) return intents;
  for (const [key, value] of Object.entries(state.baseIntent))
    if (value === 'on' || value === 'off') intents.set(key, value);
  return intents;
}

function collectClaimedSlots(value: unknown, slots: Set<string>): void {
  let lists: unknown[][] = [];
  if (Array.isArray(value)) lists = [value];
  else if (isRecord(value)) lists = Object.values(value).filter(Array.isArray);
  for (const list of lists)
    for (const item of list)
      if (typeof item === 'string' && item.includes('\0')) slots.add(item);
}

function parkingFindings(
  report: InventoryScanReport,
  state: Record<string, unknown>,
): ScanFinding[] {
  const currentSlots = new Set(report.slots.map(({ id }) => id));
  const previousSlots = isRecord(state.runtimeInventory) && isRecord(state.runtimeInventory.slots)
    ? state.runtimeInventory.slots
    : {};
  const claimedSlots = new Set<string>();
  collectClaimedSlots(state.claims, claimedSlots);
  collectClaimedSlots(state.lastClaims, claimedSlots);
  return [...baseIntents(state)].flatMap(([id, intent]) => {
    if (intent !== 'off' || currentSlots.has(id) || claimedSlots.has(id) ||
      !isRecord(previousSlots[id])) return [];
    const separator = id.indexOf('\0');
    return [{
      category: 'structural',
      code: 'parking-entry-missing',
      message: `parking entry missing: ${displayRuntimeSlot(id)}`,
      runtimeId: separator < 0 ? undefined : id.slice(0, separator),
      slot: separator < 0 ? id : id.slice(separator + 1),
    }];
  });
}

function lockMismatchFindings(
  report: InventoryScanReport,
  state: Record<string, unknown>,
): ScanFinding[] {
  const previous = isRecord(state.runtimeInventory) && isRecord(state.runtimeInventory.slots)
    ? state.runtimeInventory.slots
    : {};
  return report.slots.flatMap((slot) => {
    const old = previous[slot.id];
    return isRecord(old) && isRecord(old.provenance) && !slot.provenance ? [{
      category: 'structural',
      code: 'lock-file-mismatch',
      message: `npx-managed Runtime Slot has a file but no lock entry: ${slot.runtimeKey}/${slot.name}`,
      runtimeId: slot.runtimeId,
      slot: slot.name,
    }] : [];
  });
}

interface LegacyOffEntry {
  runtime: ScannedRuntime;
  name: string;
  entryPath: string;
  destination: string;
}

/** Legacy ADR-0007 `.off/` parking inside the discovery root is invisible to the scanner. */
function legacyOffEntries(report: InventoryScanReport): LegacyOffEntry[] {
  if (report.scope !== 'global') return [];
  const entries: LegacyOffEntry[] = [];
  for (const runtime of report.runtimes) {
    if (!runtime.writable) continue;
    const offDir = path.join(runtime.discoveryRoot, '.off');
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(offDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue;
      const entryPath = path.join(offDir, dirent.name);
      const stat = fs.lstatSync(entryPath, { throwIfNoEntry: false });
      if (!stat) continue;
      let keep = false;
      if (stat.isSymbolicLink()) {
        keep = true;
      } else if (stat.isDirectory()) {
        keep = fs.existsSync(path.join(entryPath, 'SKILL.md'));
      }
      if (!keep) continue;
      entries.push({
        runtime,
        name: dirent.name,
        entryPath,
        destination: path.join(runtime.parkingRoot, dirent.name),
      });
    }
  }
  return entries;
}

function legacyOffFindings(entries: LegacyOffEntry[]): ScanFinding[] {
  return entries.map(({ runtime, name, entryPath }) => ({
    category: 'structural',
    code: 'legacy-off',
    message: `legacy OFF location: ${entryPath} (repair moves it to the parking area)`,
    runtimeId: runtime.id,
    slot: normalizeSlotName(name),
  }));
}

function doctorFindings(
  report: InventoryScanReport,
  state: Record<string, unknown>,
  catalog: Record<string, unknown>,
  legacyOff: LegacyOffEntry[],
): ScanFinding[] {
  return [
    ...staleReferenceFindings(report, catalog),
    ...orphanedPresetFindings(report, state, catalog),
    ...parkingFindings(report, state),
    ...lockMismatchFindings(report, state),
    ...legacyOffFindings(legacyOff),
  ];
}

function doctorReport(
  report: InventoryScanReport,
  state: Record<string, unknown>,
  catalog: Record<string, unknown>,
): DoctorReport {
  const legacyOff = legacyOffEntries(report);
  return {
    ...report,
    findings: [...report.findings, ...doctorFindings(report, state, catalog, legacyOff)],
    repairs: doctorRepairs(report, state, legacyOff),
  };
}

function previousResourceIds(
  state: Record<string, unknown>,
  relationship: RuntimeRelationship,
): Set<string> {
  if (!isRecord(state.runtimeInventory) || !isRecord(state.runtimeInventory.slots))
    return new Set();
  const slot = state.runtimeInventory.slots[
    runtimeSlotId(relationship.runtimeId, relationship.slot)
  ];
  if (!isRecord(slot) || !Array.isArray(slot.resourceIds)) return new Set();
  return new Set(slot.resourceIds.filter((id): id is string => typeof id === 'string'));
}

function retargetDetails(
  relationship: RuntimeRelationship,
  report: InventoryScanReport,
  state: Record<string, unknown>,
): Pick<DoctorRepair, 'to' | 'targetResourceId' | 'targetHash'> | undefined {
  const to = replacementTarget(relationship, report, state);
  if (!to) return undefined;
  const targetPath = path.resolve(path.dirname(relationship.path), to);
  const targetResourceId = report.relationships
    .find(({ path: entryPath }) => path.resolve(entryPath) === targetPath)?.realPath;
  if (!targetResourceId) return undefined;
  const targetHash = report.resources.find(({ id }) => id === targetResourceId)?.hash;
  return targetHash ? { to, targetResourceId, targetHash } : undefined;
}

function doctorRepairs(
  report: InventoryScanReport,
  state: Record<string, unknown>,
  legacyOff: LegacyOffEntry[],
): DoctorRepair[] {
  const legacyRepairs = legacyOff.flatMap(
    ({ runtime, name, entryPath, destination }) => {
      if (fs.lstatSync(destination, { throwIfNoEntry: false })) return [];
      return [{
        id: `migrate-legacy-off:${entryPath}`,
        kind: 'migrate-legacy-off' as const,
        path: entryPath,
        from: entryPath,
        to: destination,
        runtimeId: runtime.id,
        slot: normalizeSlotName(name),
      }];
    },
  );
  const conflicted = new Set(report.slots.flatMap(({ id, relationships }) =>
    relationships.length > 1 ? [id] : []));
  const linkRepairs = report.relationships.flatMap((relationship) => {
    const conflict = conflicted.has(runtimeSlotId(relationship.runtimeId, relationship.slot));
    if (relationship.form !== 'link' || relationship.realPath ||
      relationship.inspectionError || relationship.readOnly || !relationship.target || conflict)
      return [];
    const retarget = retargetDetails(relationship, report, state);
    const kind: DoctorRepair['kind'] = retarget ? 'retarget-link' : 'remove-broken-link';
    return [{
      id: `${kind}:${relationship.path}`,
      kind,
      path: relationship.path,
      from: relationship.target,
      ...retarget,
      runtimeId: relationship.runtimeId,
      slot: relationship.slot,
    }];
  });
  return [...legacyRepairs, ...linkRepairs];
}

function globalInventory(
  home: Home,
  runtimes: Runtime[],
  options: ScanOptions,
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

export function scanGlobalInventory(
  home: Home,
  runtimes: Runtime[] = loadRuntimes(home),
  options: ScanOptions = {},
): InventoryScanReport {
  return globalInventory(home, runtimes, options);
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

export function doctorGlobalInventory(
  home: Home,
  runtimes: Runtime[] = loadRuntimes(home, { persist: false }),
): DoctorReport {
  const stateFile = path.join(home.configDir, 'state.json');
  const report = globalInventory(home, runtimes, { persist: false });
  const state = readStateFile(stateFile);
  return doctorReport(report, state, state);
}

function projectInventory({
  home,
  selectedPath,
  runtimes,
  options,
}: {
  home: Home;
  selectedPath: string;
  runtimes: Runtime[];
  options: ScanOptions;
}): InventoryScanReport {
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

export function scanProjectInventory(
  home: Home,
  selectedPath: string,
  runtimes: Runtime[] = loadRuntimes(home),
  options: ScanOptions = {},
): InventoryScanReport {
  return projectInventory({ home, selectedPath, runtimes, options });
}

export function doctorProjectInventory(
  home: Home,
  selectedPath: string,
  runtimes: Runtime[] = loadRuntimes(home, { persist: false }),
): DoctorReport {
  const report = projectInventory({
    home,
    selectedPath,
    runtimes,
    options: { persist: false },
  });
  return doctorReport(
    report,
    readStateFile(report.stateFile),
    readStateFile(path.join(home.configDir, 'state.json')),
  );
}
