import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Home } from './core.ts';
import { harnessAdapters } from './harnesses/registry.ts';
import {
  readNpxSkillsLock,
  type NpxManagedSkill,
  type NpxSkillsProvenance,
} from './npx-skills.ts';
import { sharedTargetDefinition } from './targets/shared.ts';

export type TargetScope = 'global' | 'project' | 'parent';
export type Activation = 'on' | 'off';
export type ResourceForm = 'local' | 'link' | 'mirror';
export type TargetKind = 'harness' | 'shared' | 'generic';
export interface RelationshipCapability {
  support: 'managed' | 'discoverable' | 'unsupported';
  link: 'supported' | 'unsupported';
}

/** Built-in path rules; user configuration stores only their field overrides. */
export interface TargetDefinition {
  key: string;
  kind: Exclude<TargetKind, 'generic'>;
  discoveryRoot: string;
  parkingRoot: string;
  projectPath: string;
  lockFile?: string;
  relationship?: RelationshipCapability;
}

/** A concrete, resolved root that can hold Skill Target Slots. */
export interface SkillTarget {
  key: string;
  kind: TargetKind;
  discoveryRoot: string;
  parkingRoot: string;
  projectPath: string;
  lockFile?: string;
  relationship?: RelationshipCapability;
}

export interface SharedTarget extends SkillTarget {
  kind: 'shared';
}

export interface GenericTarget extends SkillTarget {
  kind: 'generic';
}

export interface TargetDefinitionOverride {
  key: string;
  disabled?: true;
  discoveryRoot?: string;
  parkingRoot?: string;
  projectPath?: string;
  lockFile?: string;
}

export interface TargetMigrationPlan {
  status: 'ready' | 'already-migrated';
  targetFile: string;
  legacyFile: string;
  backupFile?: string;
  writeTarget: boolean;
  overrides: TargetDefinitionOverride[];
  genericTargets: GenericTarget[];
}

export interface ScannedTarget extends SkillTarget {
  id: string;
  scope: TargetScope;
  writable: boolean;
  sourceDirectory?: string;
}

export interface ManagedMirror {
  sourceId: string;
  hash: string;
}

export interface TargetRelationship {
  targetId: string;
  targetKey: string;
  slot: string;
  name: string;
  activation: Activation;
  form: ResourceForm;
  path: string;
  target?: string;
  realPath?: string;
  resourceId?: string;
  mirror?: ManagedMirror;
  diverged?: boolean;
  inspectionError?: string;
  readOnly: boolean;
}

export type SkillProvenance = NpxSkillsProvenance;

export interface InventoryResource {
  id: string;
  name: string;
  realPath: string;
  hash: string;
  cliCoupled: boolean;
  relationships: TargetRelationship[];
}

export interface InventorySlot {
  id: string;
  targetId: string;
  targetKey: string;
  name: string;
  relationships: TargetRelationship[];
  provenance?: SkillProvenance;
}

export interface MissingRelationship {
  resourceId: string;
  targetId: string;
  slot: string;
}

export type FindingCategory = 'structural' | 'metadata' | 'change';

export interface ScanFinding {
  category: FindingCategory;
  code: string;
  message: string;
  resourceId?: string;
  targetId?: string;
  slot?: string;
}

export interface TargetInventoryMetadata {
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
  targets: ScannedTarget[];
  resources: InventoryResource[];
  slots: InventorySlot[];
  relationships: TargetRelationship[];
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
  targetId: string;
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

/** Compatibility input only: runtimes.json is converted during explicit migration. */
interface LegacyRuntime {
  key: string;
  kind: 'agent' | 'shared';
  discoveryRoot: string;
  parkingRoot: string;
  projectPath: string;
  lockFile?: string;
}

interface RuntimeRegistryFile {
  version: 1;
  runtimes: LegacyRuntime[];
}

interface TargetRegistryFile {
  version: 1;
  overrides: TargetDefinitionOverride[];
  genericTargets: GenericTarget[];
}

function expandHome(value: string): string {
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}

export function defaultTargetDefinitions(): TargetDefinition[] {
  const home = os.homedir();
  return [
    {
      key: 'claude',
      kind: 'harness',
      discoveryRoot: path.join(home, '.claude', 'skills'),
      parkingRoot: path.join(home, '.claude', '.skillspub-off', 'skills'),
      projectPath: '.claude/skills',
    },
    sharedTargetDefinition(),
    ...harnessAdapters().map((adapter) => adapter.targetDefinition()),
  ];
}

function targetFile(home: Home): string {
  return path.join(home.configDir, 'targets.json');
}

function runtimeFile(home: Home): string {
  return path.join(home.configDir, 'runtimes.json');
}

function isTargetKey(value: string): boolean {
  return Boolean(value) && value !== '.' && value !== '..' &&
    !value.includes('/') && !value.includes('\\');
}

function resolveTarget(target: SkillTarget, file: string): SkillTarget {
  if (typeof target.key !== 'string' || !isTargetKey(target.key) ||
    !['harness', 'shared', 'generic'].includes(target.kind) ||
    typeof target.discoveryRoot !== 'string' || !target.discoveryRoot ||
    typeof target.parkingRoot !== 'string' || !target.parkingRoot ||
    typeof target.projectPath !== 'string' || path.isAbsolute(target.projectPath) ||
    target.projectPath.split(path.sep).includes('..') ||
    (target.lockFile !== undefined && typeof target.lockFile !== 'string'))
    throw new Error(`invalid Skill Target entry in ${file}`);
  const discoveryRoot = expandHome(target.discoveryRoot);
  const parkingRoot = expandHome(target.parkingRoot);
  const relative = path.relative(discoveryRoot, parkingRoot);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative)))
    throw new Error(`parking root must be outside discovery root for Skill Target ${target.key}`);
  return {
    ...target,
    discoveryRoot,
    parkingRoot,
    lockFile: target.lockFile
      ? expandHome(target.lockFile)
      : target.kind === 'shared'
        ? path.join(path.dirname(discoveryRoot), '.skill-lock.json')
        : undefined,
  };
}

function assertUniqueTargets(targets: SkillTarget[], _file: string): void {
  const keys = new Set<string>();
  const roots = new Set<string>();
  for (const target of targets) {
    if (keys.has(target.key)) throw new Error(`duplicate Skill Target key: ${target.key}`);
    keys.add(target.key);
    const root = rootIdentity(target.discoveryRoot);
    if (roots.has(root)) throw new Error(`ambiguous Skill Target discovery root: ${target.discoveryRoot}`);
    roots.add(root);
  }
}

function targetsFromRegistry(registry: TargetRegistryFile, file: string): SkillTarget[] {
  const definitions = defaultTargetDefinitions();
  const known = new Map(definitions.map((definition) => [definition.key, definition]));
  const overrides = new Map<string, TargetDefinitionOverride>();
  for (const override of registry.overrides) {
    if (!known.has(override.key))
      throw new Error(`unknown Target Definition override: ${override.key}`);
    if (overrides.has(override.key))
      throw new Error(`duplicate Target Definition override: ${override.key}`);
    overrides.set(override.key, override);
  }
  const targets: SkillTarget[] = [];
  for (const definition of definitions) {
    const override = overrides.get(definition.key);
    if (override?.disabled) continue;
    const { disabled: _, ...fields } = override ?? {};
    targets.push(resolveTarget({ ...definition, ...fields }, file));
  }
  const generics = registry.genericTargets.map((target) =>
    resolveTarget(target, file));
  if (generics.some((target) => target.kind !== 'generic'))
    throw new Error(`invalid Generic Target entry in ${file}`);
  assertUniqueTargets([...targets, ...generics], file);
  return [...targets, ...generics];
}

function readTargetRegistry(file: string): TargetRegistryFile | undefined {
  if (!fs.existsSync(file)) return undefined;
  let parsed: Partial<TargetRegistryFile>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TargetRegistryFile>;
  } catch (error) {
    throw new Error(`cannot read Target registry ${file}: ${(error as Error).message}`);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.overrides) || !Array.isArray(parsed.genericTargets))
    throw new Error(`invalid Target registry: ${file}`);
  const overrides = parsed.overrides.map((override) => {
    if (!isRecord(override) || typeof override.key !== 'string')
      throw new Error(`invalid Target Definition override in ${file}`);
    const result: TargetDefinitionOverride = { key: override.key };
    if (override.disabled !== undefined) {
      if (override.disabled !== true)
        throw new Error(`invalid Target Definition override in ${file}`);
      result.disabled = true;
    }
    for (const field of ['discoveryRoot', 'parkingRoot', 'projectPath', 'lockFile'] as const) {
      if (override[field] === undefined) continue;
      if (typeof override[field] !== 'string')
        throw new Error(`invalid Target Definition override in ${file}`);
      result[field] = override[field];
    }
    if (Object.keys(result).length === 1)
      throw new Error(`empty Target Definition override in ${file}`);
    return result;
  });
  const genericTargets = parsed.genericTargets.map((target) => {
    if (!isRecord(target) || target.kind !== 'generic' || typeof target.key !== 'string' ||
      typeof target.discoveryRoot !== 'string' || typeof target.parkingRoot !== 'string' ||
      typeof target.projectPath !== 'string' ||
      (target.lockFile !== undefined && typeof target.lockFile !== 'string'))
      throw new Error(`invalid Generic Target entry in ${file}`);
    return {
      key: target.key,
      kind: 'generic' as const,
      discoveryRoot: target.discoveryRoot,
      parkingRoot: target.parkingRoot,
      projectPath: target.projectPath,
      ...(typeof target.lockFile === 'string' ? { lockFile: target.lockFile } : {}),
    };
  });
  const registry = { version: 1 as const, overrides, genericTargets };
  targetsFromRegistry(registry, file);
  return registry;
}

function legacyRuntimeFromTarget(target: SkillTarget): LegacyRuntime {
  return {
    key: target.key,
    kind: target.kind === 'shared' ? 'shared' : 'agent',
    discoveryRoot: target.discoveryRoot,
    parkingRoot: target.parkingRoot,
    projectPath: target.projectPath,
    lockFile: target.lockFile,
  };
}

function defaultLegacyRuntimes(): LegacyRuntime[] {
  return defaultTargetDefinitions().map(legacyRuntimeFromTarget);
}

function resolveLegacyRuntime(runtime: LegacyRuntime, file: string): LegacyRuntime {
  if (!runtime || typeof runtime.key !== 'string' || !isTargetKey(runtime.key) ||
    (runtime.kind !== 'agent' && runtime.kind !== 'shared') ||
    typeof runtime.discoveryRoot !== 'string' ||
    typeof runtime.parkingRoot !== 'string' ||
    typeof runtime.projectPath !== 'string' || path.isAbsolute(runtime.projectPath) ||
    runtime.projectPath.split(path.sep).includes('..'))
    throw new Error(`invalid Runtime entry in ${file}`);
  const discoveryRoot = expandHome(runtime.discoveryRoot);
  const parkingRoot = expandHome(runtime.parkingRoot);
  const relative = path.relative(discoveryRoot, parkingRoot);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative)))
    throw new Error(`parking root must be outside discovery root for Runtime ${runtime.key}`);
  return {
    ...runtime,
    discoveryRoot,
    parkingRoot,
    lockFile: runtime.lockFile
      ? expandHome(runtime.lockFile)
      : runtime.kind === 'shared'
        ? path.join(path.dirname(discoveryRoot), '.skill-lock.json')
        : undefined,
  };
}

function readRuntimeRegistry(file: string): LegacyRuntime[] | undefined {
  if (!fs.existsSync(file)) return undefined;
  let parsed: Partial<RuntimeRegistryFile>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RuntimeRegistryFile>;
  } catch (error) {
    throw new Error(`cannot read Runtime registry ${file}: ${(error as Error).message}`);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.runtimes))
    throw new Error(`invalid Runtime registry: ${file}`);
  const runtimes = parsed.runtimes.map((runtime) => resolveLegacyRuntime(runtime, file));
  const keys = new Set<string>();
  for (const runtime of runtimes) {
    if (keys.has(runtime.key)) throw new Error(`duplicate Runtime key: ${runtime.key}`);
    keys.add(runtime.key);
  }
  return runtimes;
}

function legacyRuntimes(file: string): LegacyRuntime[] | undefined {
  if (!fs.existsSync(file)) return undefined;
  const defaults = new Map(defaultLegacyRuntimes().map((runtime) => [runtime.key, runtime]));
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
      return resolveLegacyRuntime({
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
      }, file);
    });
}

function targetFromLegacyRuntime(runtime: LegacyRuntime, file: string): SkillTarget {
  const definition = defaultTargetDefinitions().find(({ key }) => key === runtime.key);
  if (!definition) {
    return resolveTarget({
      key: runtime.key,
      kind: 'generic',
      discoveryRoot: runtime.discoveryRoot,
      parkingRoot: runtime.parkingRoot,
      projectPath: runtime.projectPath,
      lockFile: runtime.lockFile,
    }, file);
  }
  const expectedKind = definition.kind === 'shared' ? 'shared' : 'agent';
  if (runtime.kind !== expectedKind)
    throw new Error(`ambiguous Runtime kind for known Target Definition: ${runtime.key}`);
  return resolveTarget({
    key: runtime.key,
    kind: definition.kind,
    discoveryRoot: runtime.discoveryRoot,
    parkingRoot: runtime.parkingRoot,
    projectPath: runtime.projectPath,
    lockFile: runtime.lockFile,
  }, file);
}

function targetRegistryFromLegacy(runtimes: LegacyRuntime[], file: string): TargetRegistryFile {
  const definitions = new Map(defaultTargetDefinitions().map((definition) => [definition.key, definition]));
  const overrides: TargetDefinitionOverride[] = [];
  const genericTargets: GenericTarget[] = [];
  for (const runtime of runtimes) {
    const target = targetFromLegacyRuntime(runtime, file);
    const definition = definitions.get(target.key);
    if (!definition) {
      genericTargets.push(target as GenericTarget);
      continue;
    }
    definitions.delete(target.key);
    const base = resolveTarget(definition, file);
    const override: TargetDefinitionOverride = { key: target.key };
    for (const field of ['discoveryRoot', 'parkingRoot', 'projectPath', 'lockFile'] as const) {
      if (target[field] !== base[field]) override[field] = target[field];
    }
    if (Object.keys(override).length > 1) overrides.push(override);
  }
  overrides.push(...[...definitions.keys()].map((key) => ({ key, disabled: true as const })));
  const registry = { version: 1 as const, overrides, genericTargets };
  targetsFromRegistry(registry, file);
  return registry;
}

function canonicalTargetRegistry(registry: TargetRegistryFile): string {
  return JSON.stringify({
    version: 1,
    overrides: [...registry.overrides]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ key, disabled, discoveryRoot, parkingRoot, projectPath, lockFile }) => ({
        key,
        ...(disabled ? { disabled: true } : {}),
        ...(discoveryRoot === undefined ? {} : { discoveryRoot }),
        ...(parkingRoot === undefined ? {} : { parkingRoot }),
        ...(projectPath === undefined ? {} : { projectPath }),
        ...(lockFile === undefined ? {} : { lockFile }),
      })),
    genericTargets: [...registry.genericTargets]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(({ key, discoveryRoot, parkingRoot, projectPath, lockFile }) => ({
        key,
        kind: 'generic',
        discoveryRoot,
        parkingRoot,
        projectPath,
        ...(lockFile === undefined ? {} : { lockFile }),
      })),
  });
}

export function loadTargets(home: Home): SkillTarget[] {
  const file = targetFile(home);
  const registry = readTargetRegistry(file);
  if (registry) return targetsFromRegistry(registry, file);
  const legacy = readRuntimeRegistry(runtimeFile(home))
    ?? legacyRuntimes(path.join(home.configDir, 'agents.conf'));
  if (!legacy) return defaultTargetDefinitions().map((definition) =>
    resolveTarget(definition, targetFile(home)));
  const targets = legacy.map((runtime) => targetFromLegacyRuntime(runtime, runtimeFile(home)));
  assertUniqueTargets(targets, runtimeFile(home));
  return targets;
}

export function planTargetMigration(home: Home): TargetMigrationPlan {
  const legacyFile = runtimeFile(home);
  const targetPath = targetFile(home);
  const legacy = readRuntimeRegistry(legacyFile);
  const existing = readTargetRegistry(targetPath);
  if (!legacy) {
    if (existing) {
      return {
        status: 'already-migrated',
        targetFile: targetPath,
        legacyFile,
        writeTarget: false,
        overrides: existing.overrides,
        genericTargets: existing.genericTargets,
      };
    }
    throw new Error(`no legacy Runtime registry: ${legacyFile}`);
  }
  const registry = targetRegistryFromLegacy(legacy, legacyFile);
  if (existing && canonicalTargetRegistry(existing) !== canonicalTargetRegistry(registry))
    throw new Error(`Target registry already exists and differs from legacy Runtime registry: ${targetPath}`);
  const backupFile = `${legacyFile}.v1.bak`;
  if (fs.existsSync(backupFile))
    throw new Error(`legacy Runtime backup already exists: ${backupFile}`);
  return {
    status: 'ready',
    targetFile: targetPath,
    legacyFile,
    backupFile,
    writeTarget: !existing,
    overrides: registry.overrides,
    genericTargets: registry.genericTargets,
  };
}

function registryFromPlan(plan: TargetMigrationPlan): TargetRegistryFile {
  return {
    version: 1,
    overrides: plan.overrides,
    genericTargets: plan.genericTargets,
  };
}

function sameMigrationPlan(left: TargetMigrationPlan, right: TargetMigrationPlan): boolean {
  return left.status === right.status &&
    left.targetFile === right.targetFile &&
    left.legacyFile === right.legacyFile &&
    left.backupFile === right.backupFile &&
    left.writeTarget === right.writeTarget &&
    canonicalTargetRegistry(registryFromPlan(left)) === canonicalTargetRegistry(registryFromPlan(right));
}

function writeTargetRegistry(file: string, registry: TargetRegistryFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function applyTargetMigration(home: Home, plan: TargetMigrationPlan): void {
  if (plan.status === 'already-migrated') return;
  const fresh = planTargetMigration(home);
  if (!sameMigrationPlan(plan, fresh))
    throw new Error('Target migration changed after preview; preview again');
  const registry = registryFromPlan(fresh);
  if (fresh.writeTarget) writeTargetRegistry(fresh.targetFile, registry);
  try {
    const written = readTargetRegistry(fresh.targetFile);
    if (!written || canonicalTargetRegistry(written) !== canonicalTargetRegistry(registry))
      throw new Error(`Target registry validation failed: ${fresh.targetFile}`);
    fs.renameSync(fresh.legacyFile, fresh.backupFile!);
  } catch (error) {
    if (fresh.writeTarget) fs.unlinkSync(fresh.targetFile);
    throw error;
  }
}

export function normalizeSlotName(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/[\s_]+/g, '-');
}


export function targetSlotId(targetId: string, slot: string): string {
  return `${targetId}\0${slot}`;
}

function displayTargetSlot(id: string): string {
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
  target: ScannedTarget,
  root: string,
  activation: Activation,
  mirrors: Map<string, ManagedMirror>,
): TargetRelationship[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const relationships: TargetRelationship[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(root, entry.name);
    const slot = normalizeSlotName(entry.name);
    const mirror = entry.isSymbolicLink()
      ? undefined
      : mirrors.get(targetSlotId(target.id, slot));
    const form: ResourceForm = entry.isSymbolicLink() ? 'link' : mirror ? 'mirror' : 'local';
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
      targetId: target.id,
      targetKey: target.key,
      slot,
      name: entry.name,
      activation,
      form,
      path: entryPath,
      target: form === 'link' ? targetOf(entryPath) : undefined,
      realPath,
      resourceId: mirror?.sourceId ?? realPath,
      mirror,
      inspectionError,
      readOnly: !target.writable,
    });
  }
  return relationships;
}

function assertExternalParking(target: SkillTarget): void {
  const relative = path.relative(target.discoveryRoot, target.parkingRoot);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))
    throw new Error(`parking root must be outside discovery root for Target ${target.key}`);
}

interface ProvenanceRead {
  entries: Map<string, SkillProvenance>;
  error?: string;
}

export type ManagedSkill = NpxManagedSkill;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readProvenance(file: string | undefined): ProvenanceRead {
  if (!file) return { entries: new Map() };
  try {
    const entries = readNpxSkillsLock(file)
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

export function hashDirectory(root: string): string {
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
  targets: ScannedTarget[];
  options: ScanOptions;
  projectPath?: string;
}

type RelationshipsBySlot = Map<string, TargetRelationship[]>;

function groupTargetSlots(relationships: TargetRelationship[]): {
  bySlot: RelationshipsBySlot;
  findings: ScanFinding[];
} {
  const bySlot: RelationshipsBySlot = new Map();
  const findings: ScanFinding[] = [];
  for (const relationship of relationships) {
    const key = targetSlotId(relationship.targetId, relationship.slot);
    const groupedRelationships = bySlot.get(key) ?? [];
    groupedRelationships.push(relationship);
    bySlot.set(key, groupedRelationships);
    if (!relationship.realPath) findings.push({
      category: 'structural',
      code: relationship.inspectionError ? 'unreadable-link' : 'broken-link',
      message: relationship.inspectionError
        ? `cannot inspect link: ${relationship.path}: ${relationship.inspectionError}`
        : `broken link: ${relationship.path} -> ${relationship.target ?? '?'}`,
      targetId: relationship.targetId,
      slot: relationship.slot,
    });
  }
  return { bySlot, findings };
}

function scanSlotProvenance(
  targets: ScannedTarget[],
  bySlot: RelationshipsBySlot,
  previous: TargetInventoryMetadata | undefined,
): {
  provenanceBySlot: Map<string, SkillProvenance>;
  invalidLockTargets: Set<string>;
  findings: ScanFinding[];
} {
  const provenanceBySlot = new Map<string, SkillProvenance>();
  const invalidLockTargets = new Set<string>();
  const findings: ScanFinding[] = [];
  for (const target of targets) {
    const lock = readProvenance(target.lockFile);
    if (lock.error) {
      invalidLockTargets.add(target.id);
      findings.push({
        category: 'structural',
        code: 'invalid-lock',
        message: `cannot read installer lock: ${lock.error}`,
        targetId: target.id,
      });
      for (const [key, occupants] of bySlot) {
        if (occupants[0].targetId !== target.id) continue;
        const prior = previous?.slots?.[key]?.provenance;
        if (prior) provenanceBySlot.set(key, prior);
      }
      continue;
    }
    for (const [slot, provenance] of lock.entries) {
      const key = targetSlotId(target.id, slot);
      const occupants = bySlot.get(key) ?? [];
      if (occupants.length === 0) findings.push({
        category: 'structural',
        code: 'lock-file-missing',
        message: `lock entry has no Target Slot file: ${target.key}/${slot}`,
        targetId: target.id,
        slot,
      });
      provenanceBySlot.set(key, provenance);
    }
  }
  return { provenanceBySlot, invalidLockTargets, findings };
}

function findTargetSlotIssues(
  bySlot: RelationshipsBySlot,
  provenanceBySlot: Map<string, SkillProvenance>,
  invalidLockTargets: Set<string>,
  previous: TargetInventoryMetadata | undefined,
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const [key, occupants] of bySlot) {
    const oldSlot = previous?.slots?.[key];
    if (oldSlot && !invalidLockTargets.has(occupants[0].targetId) &&
      !sameProvenance(oldSlot.provenance, provenanceBySlot.get(key)))
      findings.push({
        category: 'change',
        code: 'source-changed',
        message: `Target Slot provenance changed: ${displayTargetSlot(key)}`,
        targetId: occupants[0].targetId,
        slot: occupants[0].slot,
      });
    const activations = new Set(occupants.map(({ activation }) => activation));
    if (activations.size > 1) findings.push({
      category: 'structural',
      code: 'on-off-conflict',
      message: `Target Slot is present in ON and OFF roots: ${displayTargetSlot(key)}`,
      targetId: occupants[0].targetId,
      slot: occupants[0].slot,
    });
    if (new Set(occupants.map(({ name }) => name)).size > 1) findings.push({
      category: 'structural',
      code: 'slot-conflict',
      message: `multiple entry names normalize to Target Slot: ${displayTargetSlot(key)}`,
      targetId: occupants[0].targetId,
      slot: occupants[0].slot,
    });
  }
  return findings;
}

function scanTargetSlots(
  relationships: TargetRelationship[],
  targets: ScannedTarget[],
  previous: TargetInventoryMetadata | undefined,
): { slots: InventorySlot[]; findings: ScanFinding[] } {
  const grouped = groupTargetSlots(relationships);
  const provenance = scanSlotProvenance(targets, grouped.bySlot, previous);
  const slots: InventorySlot[] = [...grouped.bySlot].map(([id, occupants]) => ({
    id,
    targetId: occupants[0].targetId,
    targetKey: occupants[0].targetKey,
    name: occupants[0].slot,
    relationships: occupants,
    provenance: provenance.provenanceBySlot.get(id),
  }));
  return {
    slots,
    findings: [
      ...grouped.findings,
      ...provenance.findings,
      ...findTargetSlotIssues(
        grouped.bySlot,
        provenance.provenanceBySlot,
        provenance.invalidLockTargets,
        previous,
      ),
    ],
  };
}

function scanInventoryResources(
  relationships: TargetRelationship[],
  targets: ScannedTarget[],
): { resources: InventoryResource[]; missing: MissingRelationship[] } {
  const grouped = new Map<string, InventoryResource>();
  for (const relationship of relationships) {
    if (!relationship.realPath || !relationship.resourceId) continue;
    let resource = grouped.get(relationship.resourceId);
    if (!resource) {
      const source = relationships.find((candidate) =>
        candidate.resourceId === relationship.resourceId &&
        candidate.realPath === relationship.resourceId)?.realPath ?? relationship.realPath;
      resource = {
        id: relationship.resourceId,
        name: relationship.name,
        realPath: source,
        hash: hashDirectory(source),
        cliCoupled: isCliCoupled(source),
        relationships: [],
      };
      grouped.set(resource.id, resource);
    }
    resource.relationships.push(relationship);
  }
  const resources = [...grouped.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const missing = resources.flatMap((resource) => targets
    .filter((target) => !resource.relationships.some((relationship) =>
      relationship.targetId === target.id && relationship.slot === normalizeSlotName(resource.name)))
    .map((target) => ({
      resourceId: resource.id,
      targetId: target.id,
      slot: normalizeSlotName(resource.name),
    })));
  return { resources, missing };
}

function readMirrors(value: unknown): Map<string, ManagedMirror> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) throw new Error('invalid state mirrors');
  const mirrors = new Map<string, ManagedMirror>();
  for (const [slotId, mirror] of Object.entries(value)) {
    if (!isRecord(mirror) || typeof mirror.sourceId !== 'string' || typeof mirror.hash !== 'string')
      throw new Error('invalid state mirrors');
    mirrors.set(slotId, { sourceId: mirror.sourceId, hash: mirror.hash });
  }
  return mirrors;
}

function findMirrorIssues(
  relationships: TargetRelationship[],
  resources: InventoryResource[],
): ScanFinding[] {
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
  const findings: ScanFinding[] = [];
  for (const relationship of relationships) {
    if (relationship.form !== 'mirror' || !relationship.mirror || !relationship.realPath) continue;
    const source = resourcesById.get(relationship.mirror.sourceId);
    if (!source || source.realPath !== relationship.mirror.sourceId) {
      findings.push({
        category: 'structural',
        code: 'mirror-source-missing',
        message: `Mirror source is missing: ${relationship.path} -> ${relationship.mirror.sourceId}`,
        targetId: relationship.targetId,
        slot: relationship.slot,
      });
      continue;
    }
    if (hashDirectory(relationship.realPath) !== relationship.mirror.hash) {
      relationship.diverged = true;
      findings.push({
        category: 'structural',
        code: 'mirror-diverged',
        message: `Mirror diverged: ${relationship.path}`,
        resourceId: relationship.mirror.sourceId,
        targetId: relationship.targetId,
        slot: relationship.slot,
      });
    }
    if (source.hash !== relationship.mirror.hash) {
      findings.push({
        category: 'change',
        code: 'mirror-drift',
        message: `Mirror drift: ${relationship.path} is behind ${source.realPath}`,
        resourceId: source.id,
        targetId: relationship.targetId,
        slot: relationship.slot,
      });
    }
  }
  return findings;
}

function findResourceIssues(
  resources: InventoryResource[],
  previous: TargetInventoryMetadata | undefined,
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

function previousTargetInventory(state: Record<string, unknown>): TargetInventoryMetadata | undefined {
  // Compatibility input only: the renamed metadata is rewritten on the next persisted scan.
  return (state.targetInventory ?? state.runtimeInventory) as TargetInventoryMetadata | undefined;
}

function withTargetInventory(
  state: Record<string, unknown>,
  metadata: TargetInventoryMetadata,
): Record<string, unknown> {
  const { runtimeInventory: _, ...current } = state;
  return { ...current, targetInventory: metadata };
}

function buildInventoryMetadata(
  resources: InventoryResource[],
  slots: InventorySlot[],
  previous: TargetInventoryMetadata | undefined,
  now: string,
): TargetInventoryMetadata {
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
  targets,
  options,
  projectPath,
}: ScanInventoryInput): InventoryScanReport {
  const now = options.now ?? new Date().toISOString();
  const state = readStateFile(stateFile);
  const mirrors = readMirrors(state.mirrors);
  const relationships = targets.flatMap((target) => {
    assertExternalParking(target);
    return [
      ...scanRoot(target, target.discoveryRoot, 'on', mirrors),
      ...scanRoot(target, target.parkingRoot, 'off', mirrors),
    ];
  });
  const { resources, missing } = scanInventoryResources(relationships, targets);
  const previous = previousTargetInventory(state);
  const slotScan = scanTargetSlots(relationships, targets, previous);

  const catalogState = catalogStateFile === stateFile
    ? state
    : readStateFile(catalogStateFile);
  const tags = isRecord(catalogState.tags)
    ? catalogState.tags as Record<string, string[]>
    : {};
  const findings = [
    ...slotScan.findings,
    ...findMirrorIssues(relationships, resources),
    ...findResourceIssues(resources, previous, tags),
  ];
  if (options.persist !== false) {
    const metadata = buildInventoryMetadata(resources, slotScan.slots, previous, now);
    const nextBundles = buildRepoBundles(catalogState.bundles, resources, slotScan.slots);
    writeStateFile(stateFile, scope === 'global'
      ? { ...withTargetInventory(state, metadata), bundles: nextBundles, tags }
      : withTargetInventory(state, metadata));
  }

  return {
    scope,
    projectPath,
    targets,
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
  relationship: TargetRelationship,
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
    priorResources: previousTargetInventory(state)?.resources ?? {},
  };
  const candidates = new Set<string>();
  for (const scannedTarget of report.targets) {
    for (const [root, counterpart] of [
      [scannedTarget.discoveryRoot, scannedTarget.parkingRoot],
      [scannedTarget.parkingRoot, scannedTarget.discoveryRoot],
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
  const previousSlots = previousTargetInventory(state)?.slots ?? {};
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
      message: `parking entry missing: ${displayTargetSlot(id)}`,
      targetId: separator < 0 ? undefined : id.slice(0, separator),
      slot: separator < 0 ? id : id.slice(separator + 1),
    }];
  });
}

function lockMismatchFindings(
  report: InventoryScanReport,
  state: Record<string, unknown>,
): ScanFinding[] {
  const previous = previousTargetInventory(state)?.slots ?? {};
  return report.slots.flatMap((slot) => {
    const old = previous[slot.id];
    return isRecord(old) && isRecord(old.provenance) && !slot.provenance ? [{
      category: 'structural',
      code: 'lock-file-mismatch',
      message: `npx-managed Target Slot has a file but no lock entry: ${slot.targetKey}/${slot.name}`,
      targetId: slot.targetId,
      slot: slot.name,
    }] : [];
  });
}

interface LegacyOffEntry {
  target: ScannedTarget;
  name: string;
  entryPath: string;
  destination: string;
}

/** Legacy ADR-0007 `.off/` parking inside the discovery root is invisible to the scanner. */
function legacyOffEntries(report: InventoryScanReport): LegacyOffEntry[] {
  if (report.scope !== 'global') return [];
  const entries: LegacyOffEntry[] = [];
  for (const target of report.targets) {
    if (!target.writable) continue;
    const offDir = path.join(target.discoveryRoot, '.off');
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
        target,
        name: dirent.name,
        entryPath,
        destination: path.join(target.parkingRoot, dirent.name),
      });
    }
  }
  return entries;
}

function legacyOffFindings(entries: LegacyOffEntry[]): ScanFinding[] {
  return entries.map(({ target, name, entryPath }) => ({
    category: 'structural',
    code: 'legacy-off',
    message: `legacy OFF location: ${entryPath} (repair moves it to the parking area)`,
    targetId: target.id,
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
  relationship: TargetRelationship,
): Set<string> {
  const slot = previousTargetInventory(state)?.slots[
    targetSlotId(relationship.targetId, relationship.slot)
  ];
  if (!isRecord(slot) || !Array.isArray(slot.resourceIds)) return new Set();
  return new Set(slot.resourceIds.filter((id): id is string => typeof id === 'string'));
}

function retargetDetails(
  relationship: TargetRelationship,
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
    ({ target, name, entryPath, destination }) => {
      if (fs.lstatSync(destination, { throwIfNoEntry: false })) return [];
      return [{
        id: `migrate-legacy-off:${entryPath}`,
        kind: 'migrate-legacy-off' as const,
        path: entryPath,
        from: entryPath,
        to: destination,
        targetId: target.id,
        slot: normalizeSlotName(name),
      }];
    },
  );
  const conflicted = new Set(report.slots.flatMap(({ id, relationships }) =>
    relationships.length > 1 ? [id] : []));
  const linkRepairs = report.relationships.flatMap((relationship) => {
    const conflict = conflicted.has(targetSlotId(relationship.targetId, relationship.slot));
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
      targetId: relationship.targetId,
      slot: relationship.slot,
    }];
  });
  return [...legacyRepairs, ...linkRepairs];
}

function globalInventory(
  home: Home,
  targets: SkillTarget[],
  options: ScanOptions,
): InventoryScanReport {
  const stateFile = path.join(home.configDir, 'state.json');
  return scanInventory({
    scope: 'global',
    stateFile,
    catalogStateFile: stateFile,
    targets: targets.map((target) => ({
      ...target,
      id: `global:${target.key}`,
      scope: 'global',
      writable: true,
    })),
    options,
  });
}

export function scanGlobalInventory(
  home: Home,
  targets: SkillTarget[] = loadTargets(home),
  options: ScanOptions = {},
): InventoryScanReport {
  return globalInventory(home, targets, options);
}

function rootIdentity(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

function projectTarget(
  target: SkillTarget,
  directory: string,
  scope: 'project' | 'parent',
): ScannedTarget {
  const targetKey = target.kind === 'shared' ? 'shared' : target.key;
  return {
    ...target,
    id: `${scope}:${directory}:${target.key}`,
    scope,
    writable: scope === 'project',
    sourceDirectory: directory,
    discoveryRoot: path.join(directory, target.projectPath),
    parkingRoot: path.join(directory, '.skillspub', 'off', targetKey),
    lockFile: target.kind === 'shared'
      ? path.join(directory, 'skills-lock.json')
      : undefined,
  };
}

export function doctorGlobalInventory(
  home: Home,
  targets: SkillTarget[] = loadTargets(home),
): DoctorReport {
  const stateFile = path.join(home.configDir, 'state.json');
  const report = globalInventory(home, targets, { persist: false });
  const state = readStateFile(stateFile);
  return doctorReport(report, state, state);
}

function projectInventory({
  home,
  selectedPath,
  targets,
  options,
}: {
  home: Home;
  selectedPath: string;
  targets: SkillTarget[];
  options: ScanOptions;
}): InventoryScanReport {
  const projectPath = fs.realpathSync(selectedPath);
  if (!fs.statSync(projectPath).isDirectory())
    throw new Error(`Project path is not a directory: ${selectedPath}`);

  const scanned: ScannedTarget[] = targets.map((target) =>
    projectTarget(target, projectPath, 'project'));
  const globalRoots = new Set(targets.map((target) =>
    rootIdentity(target.discoveryRoot)));
  for (let directory = path.dirname(projectPath);;) {
    for (const target of targets) {
      const inherited = projectTarget(target, directory, 'parent');
      const exists = fs.existsSync(inherited.discoveryRoot) ||
        fs.existsSync(inherited.parkingRoot);
      if (exists && !globalRoots.has(rootIdentity(inherited.discoveryRoot)))
        scanned.push(inherited);
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  scanned.push(...targets.map((target) => ({
    ...target,
    id: `global:${target.key}`,
    scope: 'global' as const,
    writable: false,
  })));

  return scanInventory({
    scope: 'project',
    stateFile: path.join(projectPath, '.skillspub', 'state.json'),
    catalogStateFile: path.join(home.configDir, 'state.json'),
    targets: scanned,
    options,
    projectPath,
  });
}

export function scanProjectInventory(
  home: Home,
  selectedPath: string,
  targets: SkillTarget[] = loadTargets(home),
  options: ScanOptions = {},
): InventoryScanReport {
  return projectInventory({ home, selectedPath, targets, options });
}

export function doctorProjectInventory(
  home: Home,
  selectedPath: string,
  targets: SkillTarget[] = loadTargets(home),
): DoctorReport {
  const report = projectInventory({
    home,
    selectedPath,
    targets,
    options: { persist: false },
  });
  return doctorReport(
    report,
    readStateFile(report.stateFile),
    readStateFile(path.join(home.configDir, 'state.json')),
  );
}
