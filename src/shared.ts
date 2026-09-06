import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  hashDirectory,
  loadTargets,
  readStateFile,
  scanGlobalInventory,
  scanProjectInventory,
  writeStateFile,
  type InventoryScanReport,
  type TargetRelationship,
  type ScannedTarget,
} from './inventory.ts';
import {
  NPX_SKILLS_PACKAGE,
  checkNpxSkillsSource,
  npxSkillsAddArgs,
  npxSkillsDescribeArgs,
  npxSkillsFindArgs,
  npxSkillsProvenanceLabel,
  npxSkillsRemoveArgs,
  npxSkillsUpdateArgs,
  npxSkillsSourceKey,
  normalizeNpxSkillsName,
  parseNpxSkillsFindOutput,
  readNpxSkillsLock,
  runNpxSkills,
  sameNpxSkillsSource,
  type NpxManagedSkill,
  type NpxSkillsCandidate,
  type NpxSkillsRunResult,
} from './npx-skills.ts';
import type { Home } from './core.ts';


export interface SharedCommandResult {
  actual: string;
  drift: string[];
  recoveryManifest?: string;
  completedWork?: string[];
}

export interface SharedFindResult {
  candidates: NpxSkillsCandidate[];
  complete: boolean;
  raw?: string;
  warnings: string[];
}

export interface SharedDescribeResult {
  source: string;
  output: string;
  warnings: string[];
}

export type SharedUpdateAvailabilityStatus =
  'current' | 'available' | 'upstream-missing' | 'check-failed' | 'unknown';

export interface SharedUpdateAvailabilityEntry {
  name: string;
  slot: string;
  source: string;
  skillPath?: string;
  status: SharedUpdateAvailabilityStatus;
  checkedAt?: string;
  error?: string;
}

export interface SharedUpdateAvailabilityResult {
  scope: 'global' | 'project';
  projectPath?: string;
  entries: SharedUpdateAvailabilityEntry[];
}

export interface SharedUpdatePlanItem extends SharedUpdateAvailabilityEntry {
  identity: string;
  included: boolean;
  reason?: string;
  desired: 'on' | 'off';
  temporaryVisibility: boolean;
  currentTruth: {actual: string; hash: string; source: string; relationships: number};
  intentPreservation: {
    baseIntent: 'on' | 'off';
    tags: string[];
    bundles: string[];
    presetClaims: string[];
    presetSelectors: string[];
  };
  relationshipEffects: SharedRelationshipEffect[];
  expectedFinalTruth: {
    actual: string;
    desired: 'on' | 'off';
    drift: 'none' | 'mirror-sync';
    source: string;
    relationships: number;
    effectiveVisibility: 'recompute-after-rescan';
  };
}

export interface SharedUpdatePlan {
  operation: 'shared.update';
  targetId: string;
  scope: {kind: 'global' | 'project'; path: string};
  target: {discoveryRoot: string; parkingRoot: string; stateFile: string; lockFile: string};
  sourceAdapter: {package: string; updateOwner: 'vercel-skills'};
  preconditions: {
    lock: ReturnType<typeof contentFingerprint> & {owner: 'vercel-skills'};
    policy: ReturnType<typeof contentFingerprint>;
    permissions: {target: 'writable' | 'blocked'; lock: 'writable' | 'blocked'};
  };
  blockers: string[];
  items: SharedUpdatePlanItem[];
  recovery: {operationLock: string; evidence: string[]; completedWork: 'preserved'};
}

export interface SharedUpdateResult extends SharedCommandResult {
  items: Array<SharedUpdatePlanItem & {
    outcome: 'updated' | 'skipped' | 'failed';
    actual?: string;
    drift?: string[];
    log?: string;
  }>;
}

interface CachedUpdateAvailabilityEntry {
  identity: string;
  status: Exclude<SharedUpdateAvailabilityStatus, 'unknown'>;
  checkedAt: string;
  error?: string;
}

interface Target {
  home: Home;
  projectPath?: string;
  target: ScannedTarget;
  report: InventoryScanReport;
  cwd: string;
  lockFile: string;
}

export interface SharedRemovalDependency {
  scope: 'global' | 'project' | 'parent';
  targetId: string;
  targetKey: string;
  name: string;
  slot: string;
  form: 'link' | 'mirror';
  activation: 'on' | 'off';
  path: string;
  source: string;
  resourceId: string;
  fingerprint: string;
  plannedAction: 'delete';
}

export interface SharedRemovalPlan {
  operation: 'shared.remove';
  targetId: string;
  slots: string[];
  source: {
    name: string;
    slot: string;
    path: string;
    provenance: string;
    fingerprint: string;
  };
  scope: {kind: 'global' | 'project'; path: string};
  target: {
    discoveryRoot: string;
    parkingRoot: string;
    stateFile: string;
    lockFile: string;
  };
  sourceAdapter: {
    package: string;
    removeOwner: 'vercel-skills';
    proceedOwner: 'vercel-skills';
  };
  preconditions: {
    sourceEntry: {path: string; state: 'missing' | 'present'; hash: string};
    lock: {path: string; hash: string; owner: 'vercel-skills' | 'unknown'};
    policy: {path: string; hash: string};
    permissions: {
      source: 'writable' | 'blocked';
      state: 'writable' | 'blocked';
      lock: 'writable' | 'blocked';
      dependencies: Array<{path: string; status: 'writable' | 'blocked'}>;
    };
  };
  selection: {
    included: Array<{identity: string; reason: string}>;
    excluded: Array<{identity: string; reason: string}>;
  };
  dependencies: SharedRemovalDependency[];
  blockers: string[];
  warnings: string[];
  cascadeConfirmed: boolean;
  recovery: {
    operationLock: string;
    manifest: string;
    evidence: string[];
    completedWork: 'preserved';
  };
  currentTruth: {
    actual: string;
    desired: 'on' | 'off' | 'unknown';
    drift: string;
    source: string;
    relationships: number;
  };
  expectedFinalTruth: {
    actual: string;
    desired: 'removed';
    drift: 'none';
    source: 'removed';
    relationships: 0;
    effectiveVisibility: 'recompute-after-rescan';
  };
}

export interface SharedRelationshipEffect {
  scope: 'global' | 'project' | 'parent';
  targetId: string;
  targetKey: string;
  resourceId: string;
  name: string;
  slot: string;
  form: 'local' | 'link' | 'mirror';
  activation: 'on' | 'off';
  sourcePath: string;
  targetPath: string;
  plannedAction: 'create' | 'replace-content' | 'refresh-content' | 'retain' | 'consume-replacement' | 'consume-refresh' | 'mirror-sync';
  sourcePreserved: true;
}

export interface SharedMutationPlan {
  operation: 'shared.add' | 'shared.update';
  targetId: string;
  slots: string[];
  source?: string;
  replace?: boolean;
  currentSource?: string;
  replacement?: { from: string; to: string };
  scope?: {kind: 'global' | 'project'; path: string};
  target?: {
    discoveryRoot: string;
    parkingRoot: string;
    stateFile: string;
    lockFile: string;
  };
  candidate?: {
    identity: string;
    source: string;
    name: string;
    normalizedSlot: string;
    provenance: {source: string};
  };
  sourceAdapter?: {
    package: string;
    securityAuditOwner: 'vercel-skills';
    proceedOwner: 'vercel-skills';
  };
  preconditions?: {
    sourceEntry: {path: string; state: 'missing' | 'present'; hash: string};
    discoveryEntry: {path: string; state: 'missing' | 'present'; hash: string};
    parkingEntry: {path: string; state: 'missing' | 'present'; hash: string};
    lock: {path: string; hash: string; owner: 'vercel-skills' | 'unclaimed' | 'unknown'};
    policy: {path: string; hash: string};
    permissions: {target: 'writable' | 'blocked'; lock: 'writable' | 'blocked'};
  };
  blockers?: string[];
  intentPreservation?: {
    baseIntent: 'on' | 'off';
    tags: string[];
    bundles: string[];
    presetClaims: string[];
    presetSelectors: string[];
  };
  relationshipEffects?: SharedRelationshipEffect[];
  recovery?: {
    operationLock: string;
    evidence: string[];
    completedWork: 'preserved';
  };
  currentTruth?: {
    actual: string;
    desired: 'on' | 'off';
    drift: string;
    source: string;
    relationships: number;
  };
  expectedFinalTruth?: {
    actual: string;
    desired: 'on' | 'off';
    drift: 'none' | 'mirror-sync';
    source: string;
    relationships: number;
    effectiveVisibility: 'recompute-after-rescan';
  };
}

interface StagedDependencies {
  stagingRoot: string;
  rollback(): void;
  commit(): void;
}


function scan(home: Home, projectPath?: string, persist = false): InventoryScanReport {
  const targets = loadTargets(home);
  return projectPath
    ? scanProjectInventory(home, projectPath, targets, { persist })
    : scanGlobalInventory(home, targets, { persist });
}

function targetFromInventory(home: Home, report: InventoryScanReport): Target {
  const exactProject = report.scope === 'project' ? report.projectPath : undefined;
  const matches = report.targets.filter((target) =>
    target.kind === 'shared' && target.key === 'shared' && target.writable &&
    (exactProject ? target.scope === 'project' : target.scope === 'global'));
  if (matches.length !== 1)
    throw new Error(`expected exactly one writable Shared Target named "shared"; found ${matches.length}`);
  const target = matches[0];
  const canonicalRoot = exactProject
    ? path.join(exactProject, '.agents', 'skills')
    : path.join(os.homedir(), '.agents', 'skills');
  if (path.resolve(target.discoveryRoot) !== canonicalRoot)
    throw new Error(`Shared Target must use canonical root ${canonicalRoot}`);
  if (!target.lockFile) throw new Error('Shared Target has no installer lock');
  return {
    home,
    projectPath: exactProject,
    target,
    report,
    cwd: exactProject ?? process.cwd(),
    lockFile: target.lockFile,
  };
}

function resolveTarget(home: Home, projectPath?: string): Target {
  const exactProject = projectPath ? fs.realpathSync(projectPath) : undefined;
  return targetFromInventory(home, scan(home, exactProject));
}

function validateName(name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name))
    throw new Error(`invalid skill name: ${name || '(empty)'}`);
  return normalizeNpxSkillsName(name);
}

function validateSource(source: string): void {
  if (!source || source.startsWith('-')) throw new Error('source is required');
}

function relationship(target: Target, slot: string): TargetRelationship | undefined {
  const relationships = target.report.relationships.filter((item) =>
    item.targetId === target.target.id && item.slot === slot);
  if (relationships.length > 1)
    throw new Error(`Target Slot ${target.target.id}/${slot} has ON/OFF or normalized-name conflicts`);
  const found = relationships[0];
  if (found?.form === 'link' && !found.realPath)
    throw new Error(`Target Slot ${target.target.id}/${slot} is a broken link`);
  return found;
}


function concurrentModification(message: string): Error {
  return Object.assign(new Error(message), { code: 'concurrent_modification' });
}

function assertNoOperationLock(target: Target): void {
  const lock = `${target.lockFile}.skillspub-operation-lock`;
  if (fs.existsSync(lock))
    throw concurrentModification(`Shared Target operation already in progress: ${lock}`);
}

function withOperationLock<T>(target: Target, operation: () => T): T {
  const lock = `${target.lockFile}.skillspub-operation-lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let descriptor: number;
  try {
    descriptor = fs.openSync(lock, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw concurrentModification(`Shared Target operation already in progress: ${lock}`);
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, `${process.pid}\n`);
    return operation();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lock, { force: true });
  }
}

function managedIdentity(target: Target, skill: NpxManagedSkill): {
  identity: string;
  installed: boolean;
} {
  const current = relationship(target, skill.slot);
  let installedHash = 'missing';
  if (current) {
    try {
      installedHash = hashDirectory(current.path);
    } catch {
      installedHash = 'unreadable';
    }
  }
  return {
    identity: JSON.stringify({
      name: skill.name,
      source: skill.provenance.source,
      sourceUrl: skill.provenance.sourceUrl,
      sourceType: skill.sourceType,
      ref: skill.ref,
      skillPath: skill.provenance.skillPath,
      skillFolderHash: skill.skillFolderHash,
      computedHash: skill.computedHash,
      installedHash,
    }),
    installed: installedHash !== 'missing' && installedHash !== 'unreadable',
  };
}

function isCachedUpdateStatus(
  value: unknown,
): value is CachedUpdateAvailabilityEntry['status'] {
  return typeof value === 'string' &&
    ['current', 'available', 'upstream-missing', 'check-failed'].includes(value);
}

function updateAvailabilityCache(target: Target): Map<string, CachedUpdateAvailabilityEntry> {
  const raw = readStateFile(target.report.stateFile).updateAvailability;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      (raw as { version?: unknown }).version !== 1) return new Map();
  const entries = (raw as { entries?: unknown }).entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return new Map();
  const result = new Map<string, CachedUpdateAvailabilityEntry>();
  for (const [slot, value] of Object.entries(entries)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.identity !== 'string' || !isCachedUpdateStatus(entry.status) ||
        typeof entry.checkedAt !== 'string' ||
        (entry.error !== undefined && typeof entry.error !== 'string')) continue;
    result.set(slot, {
      identity: entry.identity,
      status: entry.status,
      checkedAt: entry.checkedAt,
      ...(entry.error ? { error: entry.error } : {}),
    });
  }
  return result;
}

function availabilityResult(
  target: Target,
  skills: NpxManagedSkill[],
  entries: Map<string, CachedUpdateAvailabilityEntry>,
): SharedUpdateAvailabilityResult {
  return {
    scope: target.projectPath ? 'project' : 'global',
    ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    entries: skills.map((skill) => {
      const cached = entries.get(skill.slot);
      const currentIdentity = managedIdentity(target, skill).identity;
      const current = cached?.identity === currentIdentity ? cached : undefined;
      return {
        name: skill.name,
        slot: skill.slot,
        source: npxSkillsProvenanceLabel(skill.provenance),
        ...(skill.provenance.skillPath ? { skillPath: skill.provenance.skillPath } : {}),
        status: current?.status ?? 'unknown',
        ...(current ? { checkedAt: current.checkedAt } : {}),
        ...(current?.error ? { error: current.error } : {}),
      };
    }),
  };
}

function managedSelection(target: Target, requested: string[]): NpxManagedSkill[] {
  const managed = readNpxSkillsLock(target.lockFile);
  const bySlot = new Map(managed.map((skill) => [skill.slot, skill]));
  const selected = requested.length > 0
    ? requested.map((name) => {
        const found = bySlot.get(validateName(name));
        if (!found) throw new Error(`${name} is not managed by ${NPX_SKILLS_PACKAGE}`);
        return found;
      })
    : managed;
  if (selected.length === 0) throw new Error(`no skills managed by ${NPX_SKILLS_PACKAGE}`);
  return [...new Map(selected.map((skill) => [skill.slot, skill])).values()];
}

function stringLists(value: unknown, field: string): Record<string, string[]> {
  const lists = value ?? {};
  if (!lists || typeof lists !== 'object' || Array.isArray(lists) ||
    Object.values(lists).some((items) =>
      !Array.isArray(items) || items.some((item) => typeof item !== 'string')))
    throw new Error(`invalid state ${field}`);
  return lists as Record<string, string[]>;
}

function claimedSlots(state: Record<string, unknown>): Set<string> {
  const claims = stringLists(state.claims, 'claims');
  const lastClaims = stringLists(state.lastClaims, 'lastClaims');
  return new Set([
    ...Object.entries(claims)
      .filter(([, claimIds]) => claimIds.length > 0)
      .map(([slotId]) => slotId),
    ...Object.values(lastClaims).flat(),
  ]);
}

function baseIntents(state: Record<string, unknown>): Record<string, 'on' | 'off'> {
  const intents = state.baseIntent ?? {};
  if (!intents || typeof intents !== 'object' || Array.isArray(intents) ||
    Object.values(intents).some((intent) => intent !== 'on' && intent !== 'off'))
    throw new Error('invalid state baseIntent');
  return intents as Record<string, 'on' | 'off'>;
}

function desiredActivation(
  target: Target,
  skill: NpxManagedSkill,
  current: TargetRelationship,
): 'on' | 'off' {
  const state = readStateFile(target.report.stateFile);
  const id = `${target.target.id}\0${skill.slot}`;
  const claims = claimedSlots(state);
  const intents = baseIntents(state);
  if (claims.has(id)) return 'on';
  return intents[id] ?? current.activation;
}

function validatePolicyState(target: Target): void {
  const state = readStateFile(target.report.stateFile);
  claimedSlots(state);
  baseIntents(state);
}

function move(relationship: TargetRelationship, destinationRoot: string): void {
  const destination = path.join(destinationRoot, relationship.name);
  if (fs.existsSync(destination) || fs.lstatSync(destination, { throwIfNoEntry: false }))
    throw new Error(`path conflict: ${destination}`);
  fs.mkdirSync(destinationRoot, { recursive: true });
  fs.renameSync(relationship.path, destination);
}

function desiredFor(target: Target, skills: NpxManagedSkill[]): Map<string, 'on' | 'off'> {
  const desired = new Map<string, 'on' | 'off'>();
  for (const skill of skills) {
    const current = relationship(target, skill.slot);
    if (!current) throw new Error(`installer lock/file mismatch: ${skill.name}`);
    desired.set(skill.slot, desiredActivation(target, skill, current));
  }
  return desired;
}

function dependencyFingerprint(
  form: SharedRemovalDependency['form'],
  entryPath: string,
): string {
  const stat = fs.lstatSync(entryPath, {throwIfNoEntry: false});
  if (!stat || (form === 'link' && !stat.isSymbolicLink()))
    throw new Error(`relationship disappeared during preview: ${entryPath}`);
  return form === 'link' ? fs.readlinkSync(entryPath) : hashDirectory(entryPath);
}

function pathIsWithin(root: string, entryPath: string): boolean {
  const relative = path.relative(root, entryPath);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function removalManifestPath(target: Target, slot: string): string {
  const id = crypto.createHash('sha256').update(`${target.target.id}\0${slot}`).digest('hex').slice(0, 12);
  return `${target.lockFile}.skillspub-remove-${id}.json`;
}

function removalDependencies(
  target: Target,
  source: TargetRelationship,
): SharedRemovalDependency[] {
  if (!source.resourceId) return [];
  return target.report.relationships
    .filter((item) => item.path !== source.path &&
      (item.form === 'link' || item.form === 'mirror') && item.resourceId === source.resourceId)
    .map((item): SharedRemovalDependency => ({
      scope: target.report.targets.find(({id}) => id === item.targetId)?.scope ?? 'global',
      targetId: item.targetId,
      targetKey: item.targetKey,
      name: item.name,
      slot: item.slot,
      form: item.form as 'link' | 'mirror',
      activation: item.activation,
      path: item.path,
      source: source.path,
      resourceId: item.resourceId!,
      fingerprint: dependencyFingerprint(item.form as 'link' | 'mirror', item.path),
      plannedAction: 'delete',
    }))
    .sort((left, right) =>
      left.scope.localeCompare(right.scope) ||
      left.targetId.localeCompare(right.targetId) ||
      left.path.localeCompare(right.path));
}

function sameDependencies(
  expected: SharedRemovalDependency[],
  actual: SharedRemovalDependency[],
): boolean {
  return expected.length === actual.length && expected.every((dependency, index) =>
    JSON.stringify(dependency) === JSON.stringify(actual[index]));
}

function removalBlockers(
  target: Target,
  skill: NpxManagedSkill,
  source: TargetRelationship | undefined,
  sourceRelationships: TargetRelationship[],
  dependencies: SharedRemovalDependency[],
): string[] {
  const claims = claimedSlots(readStateFile(target.report.stateFile));
  const blockers: string[] = [];
  if (sourceRelationships.length !== 1)
    blockers.push(`Target Slot ${target.target.id}/${skill.slot} has unresolved same-name or ON/OFF conflicts.`);
  if (source) {
    if (source.form !== 'local' || !source.resourceId)
      blockers.push('Shared source ownership is unknown; expected one local Vercel-managed resource.');
    if (!pathIsWithin(target.target.discoveryRoot, source.path) &&
      !pathIsWithin(target.target.parkingRoot, source.path))
      blockers.push(`unsafe Shared source path: ${source.path}`);
  } else {
    blockers.push(`installer lock/file mismatch: ${skill.name}`);
  }
  if (!skill.provenance.source && !skill.provenance.sourceUrl)
    blockers.push('Shared source ownership is not proven by the Vercel skills lock.');
  if (source && writableAt(path.dirname(source.path)) === 'blocked')
    blockers.push(`Shared source parent is not writable: ${path.dirname(source.path)}`);
  if (writableAt(path.dirname(target.lockFile)) === 'blocked')
    blockers.push(`Source lock directory is not writable: ${path.dirname(target.lockFile)}`);
  if (writableAt(path.dirname(target.report.stateFile)) === 'blocked')
    blockers.push(`policy state directory is not writable: ${path.dirname(target.report.stateFile)}`);
  const sourceSlotId = `${target.target.id}\0${skill.slot}`;
  if (claims.has(sourceSlotId))
    blockers.push(`cannot remove claimed Target Slot ${sourceSlotId.replace('\0', '/')}`);
  for (const dependency of dependencies) {
    const slotId = `${dependency.targetId}\0${dependency.slot}`;
    if (claims.has(slotId))
      blockers.push(`cannot remove claimed Target Slot ${slotId.replace('\0', '/')}`);
    const dependencyTarget = target.report.targets.find(({id}) => id === dependency.targetId);
    if (dependencyTarget && !pathIsWithin(dependencyTarget.discoveryRoot, dependency.path) &&
      !pathIsWithin(dependencyTarget.parkingRoot, dependency.path))
      blockers.push(`unsafe dependent Relationship path: ${dependency.path}`);
    if (target.report.relationships.find((item) => item.path === dependency.path)?.readOnly)
      blockers.push(`cannot remove Shared source with read-only dependent Relationship: ${dependency.path}`);
    if (writableAt(path.dirname(dependency.path)) === 'blocked')
      blockers.push(`dependent Relationship parent is not writable: ${path.dirname(dependency.path)}`);
  }
  return [...new Set(blockers)];
}

function assertRemovalDependenciesAllowed(target: Target, dependencies: SharedRemovalDependency[]): void {
  const claims = claimedSlots(readStateFile(target.report.stateFile));
  for (const dependency of dependencies) {
    const slotId = `${dependency.targetId}\0${dependency.slot}`;
    if (claims.has(slotId))
      throw new Error(`cannot remove claimed Target Slot ${slotId.replace('\0', '/')}`);
    if (dependencyFingerprint(dependency.form, dependency.path) !== dependency.fingerprint)
      throw concurrentModification(`dependent Relationship changed after preview: ${dependency.path}`);
  }
}

function stageDependencies(target: Target, dependencies: SharedRemovalDependency[]): StagedDependencies | undefined {
  if (dependencies.length === 0) return undefined;
  assertRemovalDependenciesAllowed(target, dependencies);
  const root = fs.mkdtempSync(path.join(path.dirname(target.lockFile), '.skillspub-remove-'));
  const staged: Array<{from: string; to: string}> = [];
  const rollback = (): void => {
    for (const item of staged.toReversed()) fs.renameSync(item.to, item.from);
    fs.rmSync(root, {recursive: true, force: true});
  };
  try {
    for (const [index, dependency] of dependencies.entries()) {
      assertRemovalDependenciesAllowed(target, [dependency]);
      const destination = path.join(root, String(index));
      fs.renameSync(dependency.path, destination);
      staged.push({from: dependency.path, to: destination});
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return {
    stagingRoot: root,
    rollback,
    commit: () => fs.rmSync(root, {recursive: true, force: true}),
  };
}

function removeDependencyState(target: Target, dependencies: SharedRemovalDependency[]): void {
  if (dependencies.length === 0) return;
  const state = readStateFile(target.report.stateFile);
  const baseIntent = {...baseIntents(state)};
  const mirrors = {...(state.mirrors as Record<string, unknown> | undefined)};
  for (const {targetId, slot} of dependencies) {
    const slotId = `${targetId}\0${slot}`;
    delete baseIntent[slotId];
    delete mirrors[slotId];
  }
  const {baseIntent: _baseIntent, mirrors: _mirrors, ...remaining} = state;
  writeStateFile(target.report.stateFile, {
    ...remaining,
    ...(Object.keys(baseIntent).length > 0 ? {baseIntent} : {}),
    ...(Object.keys(mirrors).length > 0 ? {mirrors} : {}),
  });
}

function manifestMatches(
  manifestPath: string,
  targetId: string,
  slot: string,
  sourceFingerprint: string,
  lockFingerprint: string,
): boolean {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      targetId?: string;
      slot?: string;
      sourceFingerprint?: string;
      lockFingerprint?: string;
    };
    return manifest.targetId === targetId && manifest.slot === slot &&
      manifest.sourceFingerprint === sourceFingerprint &&
      manifest.lockFingerprint === lockFingerprint;
  } catch {
    return false;
  }
}

function assertRemovalPlan(expected: SharedRemovalPlan, fresh: SharedRemovalPlan): void {
  if (expected.targetId !== fresh.targetId || expected.source.slot !== fresh.source.slot ||
    expected.source.path !== fresh.source.path || expected.source.fingerprint !== fresh.source.fingerprint ||
    expected.preconditions.lock.hash !== fresh.preconditions.lock.hash ||
    expected.preconditions.policy.hash !== fresh.preconditions.policy.hash ||
    !sameDependencies(expected.dependencies, fresh.dependencies))
    throw concurrentModification('Shared source or dependent Relationships changed after preview');
}

function assertRemovalUnblocked(plan: SharedRemovalPlan): void {
  if (plan.blockers.length > 0) throw new Error(plan.blockers.join('; '));
}

export function planSharedRemove(
  home: Home,
  names: string[],
  projectPath?: string,
): SharedRemovalPlan {
  if (names.length !== 1) throw new Error('usage: skillspub shared remove <managed-name>');
  const target = resolveTarget(home, projectPath);
  validatePolicyState(target);
  assertNoOperationLock(target);
  const skill = managedSelection(target, names)[0]!;
  const sourceRelationships = target.report.relationships.filter((item) =>
    item.targetId === target.target.id && item.slot === skill.slot);
  const source = sourceRelationships.length === 1 ? sourceRelationships[0] : undefined;
  const dependencies = source ? removalDependencies(target, source) : [];
  const blockers = removalBlockers(target, skill, source, sourceRelationships, dependencies);
  const sourcePath = source?.path ?? path.join(target.target.discoveryRoot, skill.slot);
  const sourceEntry = contentFingerprint(sourcePath);
  const desired = source ? desiredActivation(target, skill, source) : 'unknown';
  const manifest = removalManifestPath(target, skill.slot);
  const provenance = npxSkillsProvenanceLabel(skill.provenance);
  return {
    operation: 'shared.remove',
    targetId: target.target.id,
    slots: [skill.slot],
    source: {
      name: skill.name,
      slot: skill.slot,
      path: sourcePath,
      provenance,
      fingerprint: sourceEntry.hash,
    },
    scope: {
      kind: target.projectPath ? 'project' : 'global',
      path: target.projectPath ?? path.dirname(path.dirname(target.target.discoveryRoot)),
    },
    target: {
      discoveryRoot: target.target.discoveryRoot,
      parkingRoot: target.target.parkingRoot,
      stateFile: target.report.stateFile,
      lockFile: target.lockFile,
    },
    sourceAdapter: {
      package: NPX_SKILLS_PACKAGE,
      removeOwner: 'vercel-skills',
      proceedOwner: 'vercel-skills',
    },
    preconditions: {
      sourceEntry,
      lock: {
        path: target.lockFile,
        hash: contentFingerprint(target.lockFile).hash,
        owner: skill.provenance.source || skill.provenance.sourceUrl ? 'vercel-skills' : 'unknown',
      },
      policy: {
        path: target.report.stateFile,
        hash: contentFingerprint(target.report.stateFile).hash,
      },
      permissions: {
        source: writableAt(path.dirname(sourcePath)),
        state: writableAt(path.dirname(target.report.stateFile)),
        lock: writableAt(path.dirname(target.lockFile)),
        dependencies: dependencies.map(({path: dependencyPath}) => ({
          path: dependencyPath,
          status: writableAt(path.dirname(dependencyPath)),
        })),
      },
    },
    selection: {
      included: [
        {identity: `${provenance}\0${skill.name}`, reason: 'proven Vercel-managed local Shared source'},
        ...dependencies.map(({targetId, slot}) => ({
          identity: `${targetId}\0${slot}`,
          reason: 'known dependent Link or Mirror',
        })),
      ],
      excluded: [],
    },
    dependencies,
    blockers,
    warnings: target.projectPath ? [] : [
      'SkillsPub has no central project index; projects outside this scan may retain broken Links when unopened.',
    ],
    cascadeConfirmed: manifestMatches(
      manifest,
      target.target.id,
      skill.slot,
      sourceEntry.hash,
      contentFingerprint(target.lockFile).hash,
    ),
    recovery: {
      operationLock: `${target.lockFile}.skillspub-operation-lock`,
      manifest,
      evidence: [target.lockFile, target.report.stateFile, manifest, 'final filesystem rescan'],
      completedWork: 'preserved',
    },
    currentTruth: {
      actual: actualSummary(target.report, target.target.id, [skill.slot]),
      desired,
      drift: source && desired !== 'unknown' && source.activation === desired ? 'none' : 'observed',
      source: provenance,
      relationships: dependencies.length,
    },
    expectedFinalTruth: {
      actual: `${skill.slot}=missing`,
      desired: 'removed',
      drift: 'none',
      source: 'removed',
      relationships: 0,
      effectiveVisibility: 'recompute-after-rescan',
    },
  };
}

function contentFingerprint(entryPath: string): {path: string; state: 'missing' | 'present'; hash: string} {
  const stat = fs.lstatSync(entryPath, {throwIfNoEntry: false});
  if (!stat) return {path: entryPath, state: 'missing', hash: 'missing'};
  const hash = stat.isDirectory() || stat.isSymbolicLink()
    ? hashDirectory(entryPath)
    : crypto.createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex');
  return {path: entryPath, state: 'present', hash};
}

function writableAt(entryPath: string): 'writable' | 'blocked' {
  let current = entryPath;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return 'blocked';
    current = parent;
  }
  try {
    fs.accessSync(current, fs.constants.W_OK);
    return 'writable';
  } catch {
    return 'blocked';
  }
}

function policyIntent(
  target: Target,
  slot: string,
  resourceId: string | undefined,
  fallback: 'on' | 'off',
) {
  const policy = readStateFile(target.report.stateFile);
  const catalog = readStateFile(path.join(target.home.configDir, 'state.json'));
  const slotId = `${target.target.id}\0${slot}`;
  const claims = stringLists(policy.claims, 'claims')[slotId] ?? [];
  const lastClaims = Object.entries(stringLists(policy.lastClaims, 'lastClaims'))
    .filter(([, slots]) => slots.includes(slotId))
    .map(([preset]) => `preset:${preset}`);
  const baseIntent = baseIntents(policy)[slotId] ?? fallback;
  const tags = resourceId
    ? stringLists(catalog.tags, 'tags')[resourceId] ?? []
    : [];
  const bundles = resourceId
    ? Object.entries(stringLists(catalog.bundles, 'bundles'))
        .filter(([, members]) => members.includes(resourceId))
        .map(([bundle]) => bundle)
        .sort()
    : [];
  const presets = catalog.presets && typeof catalog.presets === 'object' && !Array.isArray(catalog.presets)
    ? catalog.presets as Record<string, {selectors?: unknown}>
    : {};
  const presetSelectors = resourceId
    ? Object.entries(presets)
        .filter(([, preset]) =>
          Array.isArray(preset.selectors) && preset.selectors.includes(`skill:${resourceId}`))
        .map(([preset]) => preset)
        .sort()
    : [];
  return {
    baseIntent,
    tags: [...tags],
    bundles,
    presetClaims: [...new Set([...claims, ...lastClaims])].sort(),
    presetSelectors,
  };
}

function addRelationshipEffects(
  target: Target,
  slot: string,
  existing: TargetRelationship | undefined,
  replacement: boolean,
): SharedRelationshipEffect[] {
  if (!existing) return [{
    scope: target.target.scope,
    targetId: target.target.id,
    targetKey: target.target.key,
    resourceId: path.join(target.target.discoveryRoot, slot),
    name: slot,
    slot,
    form: 'local',
    activation: 'on',
    sourcePath: path.join(target.target.discoveryRoot, slot),
    targetPath: path.join(target.target.discoveryRoot, slot),
    plannedAction: 'create',
    sourcePreserved: true,
  }];
  const resourceId = existing.resourceId ?? existing.realPath ?? existing.path;
  return target.report.relationships
    .filter((item) => item.resourceId === resourceId)
    .map((item): SharedRelationshipEffect => ({
      scope: item.targetId === target.target.id ? target.target.scope :
        target.report.targets.find(({id}) => id === item.targetId)?.scope ?? 'global',
      targetId: item.targetId,
      targetKey: item.targetKey,
      resourceId,
      name: item.name,
      slot: item.slot,
      form: item.form,
      activation: item.activation,
      sourcePath: existing.path,
      targetPath: item.path,
      plannedAction: item.targetId === target.target.id
        ? replacement ? 'replace-content' : 'refresh-content'
        : item.form === 'mirror'
          ? 'mirror-sync'
          : replacement ? 'consume-replacement' : 'consume-refresh',
      sourcePreserved: true,
    }))
    .sort((left, right) =>
      left.scope.localeCompare(right.scope) ||
      left.targetId.localeCompare(right.targetId) ||
      left.targetPath.localeCompare(right.targetPath));
}

function buildSharedAddPlan(
  target: Target,
  source: string,
  name: string,
  replace: boolean,
): SharedMutationPlan {
  const slot = validateName(name);
  const existing = relationship(target, slot);
  const slotInfo = target.report.slots.find((item) =>
    item.targetId === target.target.id && item.name === slot);
  const managed = readNpxSkillsLock(target.lockFile).find((skill) => skill.slot === slot);
  const currentSource = existing ? npxSkillsProvenanceLabel(slotInfo?.provenance) : undefined;
  const replacement = existing && !sameNpxSkillsSource(source, name, slotInfo?.provenance)
    ? {from: currentSource!, to: source}
    : undefined;
  if (existing)
    desiredFor(target, [{name: existing.name, slot, provenance: slotInfo?.provenance ?? {}}]);
  const discoveryEntry = path.join(target.target.discoveryRoot, slot);
  const parkingEntry = path.join(target.target.parkingRoot, slot);
  const sourceEntry = existing?.path ?? discoveryEntry;
  const sourceFingerprint = contentFingerprint(sourceEntry);
  const discoveryFingerprint = contentFingerprint(discoveryEntry);
  const parkingFingerprint = contentFingerprint(parkingEntry);
  const lockOwner = managed
    ? 'vercel-skills' as const
    : existing ? 'unknown' as const : 'unclaimed' as const;
  const intentPreservation = policyIntent(
    target,
    slot,
    existing?.resourceId ?? existing?.realPath ?? existing?.path,
    existing?.activation ?? 'on',
  );
  const desired = intentPreservation.presetClaims.length > 0 ? 'on' : intentPreservation.baseIntent;
  const relationshipEffects = addRelationshipEffects(target, slot, existing, Boolean(replacement));
  const pathConflicts = [discoveryFingerprint, parkingFingerprint].flatMap((entry) => {
    const isExpectedExisting = existing && entry.path === existing.path;
    return entry.state === 'present' && !isExpectedExisting
      ? [`Shared Slot path conflict: ${entry.path}`]
      : [];
  });
  const blockers = [
    ...pathConflicts,
    ...(replacement && !replace ? ['source replacement requires --replace'] : []),
    ...(existing && lockOwner === 'unknown'
      ? ['Shared Slot ownership is not proven by the Vercel skills lock.']
      : []),
    ...(writableAt(target.target.discoveryRoot) === 'blocked' ? ['Shared Target is not writable.'] : []),
    ...(writableAt(path.dirname(target.lockFile)) === 'blocked' ? ['Source lock directory is not writable.'] : []),
  ];
  return {
    operation: 'shared.add',
    targetId: target.target.id,
    slots: [slot],
    source,
    replace,
    ...(currentSource ? {currentSource} : {}),
    ...(replacement ? {replacement} : {}),
    scope: {
      kind: target.projectPath ? 'project' : 'global',
      path: target.projectPath ?? path.dirname(path.dirname(target.target.discoveryRoot)),
    },
    target: {
      discoveryRoot: target.target.discoveryRoot,
      parkingRoot: target.target.parkingRoot,
      stateFile: target.report.stateFile,
      lockFile: target.lockFile,
    },
    candidate: {
      identity: `${source}\0${name}`,
      source,
      name,
      normalizedSlot: slot,
      provenance: {source},
    },
    sourceAdapter: {
      package: NPX_SKILLS_PACKAGE,
      securityAuditOwner: 'vercel-skills',
      proceedOwner: 'vercel-skills',
    },
    preconditions: {
      sourceEntry: sourceFingerprint,
      discoveryEntry: discoveryFingerprint,
      parkingEntry: parkingFingerprint,
      lock: {
        path: target.lockFile,
        hash: contentFingerprint(target.lockFile).hash,
        owner: lockOwner,
      },
      policy: {
        path: target.report.stateFile,
        hash: contentFingerprint(target.report.stateFile).hash,
      },
      permissions: {
        target: writableAt(target.target.discoveryRoot),
        lock: writableAt(path.dirname(target.lockFile)),
      },
    },
    blockers,
    intentPreservation,
    relationshipEffects,
    recovery: {
      operationLock: `${target.lockFile}.skillspub-operation-lock`,
      evidence: [target.lockFile, target.report.stateFile, 'final filesystem rescan'],
      completedWork: 'preserved',
    },
    currentTruth: {
      actual: actualSummary(target.report, target.target.id, [slot]),
      desired,
      drift: existing && existing.activation === desired ? 'none' : existing ? 'activation' : 'missing',
      source: currentSource ?? 'Source unknown',
      relationships: relationshipEffects.length,
    },
    expectedFinalTruth: {
      actual: `${slot}=${desired}/local`,
      desired,
      drift: relationshipEffects.some(({plannedAction}) => plannedAction === 'mirror-sync')
        ? 'mirror-sync'
        : 'none',
      source,
      relationships: relationshipEffects.length,
      effectiveVisibility: 'recompute-after-rescan',
    },
  };
}

export function planSharedAdd(
  home: Home,
  source: string,
  name: string,
  replace: boolean,
  projectPath?: string,
): SharedMutationPlan {
  validateSource(source);
  const target = resolveTarget(home, projectPath);
  validatePolicyState(target);
  assertNoOperationLock(target);
  return buildSharedAddPlan(target, source, name, replace);
}

function buildSharedUpdatePlan(
  target: Target,
  names: string[],
  consideredNames: string[] = names,
): SharedUpdatePlan {
  const managed = readNpxSkillsLock(target.lockFile);
  const bySlot = new Map(managed.map((skill) => [skill.slot, skill]));
  const requested = new Set((names.length > 0 ? names : managed.map(({slot}) => slot)).map(validateName));
  const considered = [...new Set((consideredNames.length > 0
    ? consideredNames
    : [...requested]).map(validateName))];
  if (considered.length === 0) throw new Error(`no skills managed by ${NPX_SKILLS_PACKAGE}`);
  const cache = updateAvailabilityCache(target);
  const items = considered.map((slot): SharedUpdatePlanItem => {
    const skill = bySlot.get(slot);
    if (!skill) return {
      name: slot,
      slot,
      source: 'Source unknown',
      status: 'unknown',
      identity: `unmanaged:${slot}`,
      included: false,
      reason: `not managed by ${NPX_SKILLS_PACKAGE}`,
      desired: 'off',
      temporaryVisibility: false,
      currentTruth: {actual: 'unmanaged', hash: 'unknown', source: 'Source unknown', relationships: 0},
      intentPreservation: {
        baseIntent: 'off', tags: [], bundles: [], presetClaims: [], presetSelectors: [],
      },
      relationshipEffects: [],
      expectedFinalTruth: {
        actual: 'unmanaged', desired: 'off', drift: 'none', source: 'Source unknown',
        relationships: 0, effectiveVisibility: 'recompute-after-rescan',
      },
    };
    const current = relationship(target, slot);
    if (!current) throw new Error(`installer lock/file mismatch: ${skill.name}`);
    const identity = managedIdentity(target, skill).identity;
    const cached = cache.get(slot);
    const observation = cached?.identity === identity ? cached : undefined;
    const status = observation?.status ?? 'unknown';
    const intentPreservation = policyIntent(
      target,
      slot,
      current.resourceId ?? current.realPath ?? current.path,
      current.activation,
    );
    const desired = intentPreservation.presetClaims.length > 0
      ? 'on'
      : intentPreservation.baseIntent;
    const marked = requested.has(slot);
    const relationshipEffects = addRelationshipEffects(target, slot, current, false);
    const expectedDrift = relationshipEffects.some(({plannedAction}) => plannedAction === 'mirror-sync')
      ? 'mirror-sync' as const
      : 'none' as const;
    return {
      name: skill.name,
      slot,
      source: npxSkillsProvenanceLabel(skill.provenance),
      ...(skill.provenance.skillPath ? {skillPath: skill.provenance.skillPath} : {}),
      status,
      ...(observation ? {checkedAt: observation.checkedAt} : {}),
      ...(observation?.error ? {error: observation.error} : {}),
      identity,
      included: marked && status === 'available',
      ...(marked ? status === 'available' ? {} : {reason: status} : {reason: 'unmarked'}),
      desired,
      temporaryVisibility: desired === 'off',
      currentTruth: {
        actual: `${current.activation}/${current.form}`,
        hash: hashDirectory(current.path),
        source: npxSkillsProvenanceLabel(skill.provenance),
        relationships: relationshipEffects.length,
      },
      intentPreservation,
      relationshipEffects,
      expectedFinalTruth: {
        actual: `${slot}=${desired}/local`,
        desired,
        drift: expectedDrift,
        source: npxSkillsProvenanceLabel(skill.provenance),
        relationships: relationshipEffects.length,
        effectiveVisibility: 'recompute-after-rescan',
      },
    };
  });
  return {
    operation: 'shared.update',
    targetId: target.target.id,
    scope: {
      kind: target.projectPath ? 'project' : 'global',
      path: target.projectPath ?? path.dirname(path.dirname(target.target.discoveryRoot)),
    },
    target: {
      discoveryRoot: target.target.discoveryRoot,
      parkingRoot: target.target.parkingRoot,
      stateFile: target.report.stateFile,
      lockFile: target.lockFile,
    },
    sourceAdapter: {package: NPX_SKILLS_PACKAGE, updateOwner: 'vercel-skills'},
    preconditions: {
      lock: {...contentFingerprint(target.lockFile), owner: 'vercel-skills'},
      policy: contentFingerprint(target.report.stateFile),
      permissions: {
        target: writableAt(target.target.discoveryRoot),
        lock: writableAt(path.dirname(target.lockFile)),
      },
    },
    blockers: [
      ...(writableAt(target.target.discoveryRoot) === 'blocked' ? ['Shared Target is not writable.'] : []),
      ...(writableAt(path.dirname(target.lockFile)) === 'blocked' ? ['Source lock directory is not writable.'] : []),
    ],
    items,
    recovery: {
      operationLock: `${target.lockFile}.skillspub-operation-lock`,
      evidence: [target.lockFile, target.report.stateFile, 'final filesystem rescan'],
      completedWork: 'preserved',
    },
  };
}

export function planSharedUpdate(
  home: Home,
  names: string[],
  projectPath?: string,
  consideredNames: string[] = names,
): SharedUpdatePlan {
  const target = resolveTarget(home, projectPath);
  validatePolicyState(target);
  assertNoOperationLock(target);
  return buildSharedUpdatePlan(target, names, consideredNames);
}

function ensureVisible(target: Target, skills: NpxManagedSkill[]): void {
  for (const skill of skills) {
    const current = relationship(target, skill.slot);
    if (!current) throw new Error(`installer lock/file mismatch: ${skill.name}`);
    if (current.activation === 'off') {
      move(current, target.target.discoveryRoot);
      target.report = scan(target.home, target.projectPath);
    }
  }
}

function restoreDesired(target: Target, desired: Map<string, 'on' | 'off'>): string[] {
  const drift: string[] = [];
  for (const [slot, activation] of desired) {
    let current: TargetRelationship | undefined;
    try {
      target.report = scan(target.home, target.projectPath);
      current = relationship(target, slot);
      if (!current) {
        drift.push(`${target.target.id}/${slot}: missing`);
        continue;
      }
      if (current.activation !== activation)
        move(current, activation === 'on' ? target.target.discoveryRoot : target.target.parkingRoot);
    } catch (error) {
      drift.push(`${target.target.id}/${slot}: ${(error as Error).message}`);
    }
  }
  return drift;
}

function finalActual(target: Target, slots: string[], drift: string[]): string {
  try {
    target.report = scan(target.home, target.projectPath, true);
    return actualSummary(target.report, target.target.id, slots);
  } catch (error) {
    drift.push(`final rescan: ${(error as Error).message}`);
    return 'unavailable';
  }
}

function actualSummary(report: InventoryScanReport, targetId: string, slots: string[]): string {
  return slots.map((slot) => {
    const states = report.relationships
      .filter((item) => item.targetId === targetId && item.slot === slot)
      .map((item) => `${item.activation}/${item.form}`);
    return `${slot}=${states.join('+') || 'missing'}`;
  }).join(', ');
}

function updateBaseIntent(target: Target, slots: string[], value?: 'on'): void {
  const state = readStateFile(target.report.stateFile);
  const baseIntent = { ...baseIntents(state) };
  for (const slot of slots) {
    const id = `${target.target.id}\0${slot}`;
    if (value) baseIntent[id] = value;
    else delete baseIntent[id];
  }
  writeStateFile(target.report.stateFile, { ...state, baseIntent });
}

function cleanOutput(output: string): string {
  return stripVTControlCharacters(output);
}

function outputWarnings(stderr: string): string[] {
  return cleanOutput(stderr).split(/\r?\n/).filter(Boolean);
}

export function sharedFind(
  home: Home,
  query: string[],
  projectPath?: string,
  write = true,
): SharedFindResult {
  if (query.length === 0) throw new Error('usage: skillspub shared find <query>');
  const target = resolveTarget(home, projectPath);
  const result = runNpxSkills(npxSkillsFindArgs(query), target.cwd, true);
  if (write && result.stderr) process.stderr.write(result.stderr);
  const parsed = parseNpxSkillsFindOutput(result.stdout);
  if (write) {
    if (!parsed.complete || parsed.candidates.length === 0) process.stdout.write(result.stdout);
    else for (const candidate of parsed.candidates)
      console.log(`${candidate.source}@${candidate.name}\t${candidate.installs ?? ''}\t${candidate.detailUrl}`);
  }
  if (result.status !== 0) throw new Error(`skills find failed (exit ${result.status})`);
  return {
    candidates: parsed.candidates,
    complete: parsed.complete,
    ...(!parsed.complete || parsed.candidates.length === 0
      ? { raw: cleanOutput(parsed.raw) }
      : {}),
    warnings: outputWarnings(result.stderr),
  };
}

export function sharedDescribe(
  home: Home,
  source: string,
  projectPath?: string,
  write = true,
): SharedDescribeResult {
  validateSource(source);
  const target = resolveTarget(home, projectPath);
  const result = runNpxSkills(npxSkillsDescribeArgs(source), target.cwd, true);
  if (write && result.stdout) process.stdout.write(result.stdout);
  if (write && result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`skills description lookup failed (exit ${result.status})`);
  return {
    source,
    output: cleanOutput(result.stdout),
    warnings: outputWarnings(result.stderr),
  };
}

function refreshTarget(target: Target): SharedUpdateAvailabilityResult {
  const skills = readNpxSkillsLock(target.lockFile);
  const checkedAt = new Date().toISOString();
  const cached = new Map<string, CachedUpdateAvailabilityEntry>();
  const groups = new Map<string, NpxManagedSkill[]>();
  const failed = (skill: NpxManagedSkill, error: string): void => {
    cached.set(skill.slot, {
      identity: managedIdentity(target, skill).identity,
      status: 'check-failed',
      checkedAt,
      error,
    });
  };
  for (const skill of skills) {
    const installed = managedIdentity(target, skill);
    if (!installed.installed) {
      failed(skill, 'installed Skill is missing or unreadable');
      continue;
    }
    if (!skill.provenance.skillPath || (!skill.skillFolderHash && !skill.computedHash)) {
      failed(skill, 'installer lock lacks skillPath or content hash');
      continue;
    }
    const key = npxSkillsSourceKey(skill);
    if (!key) {
      failed(skill, 'installer lock has no supported remote source');
      continue;
    }
    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }
  for (const group of groups.values()) {
    try {
      const results = new Map(checkNpxSkillsSource(group).map((entry) => [entry.slot, entry]));
      for (const skill of group) {
        const result = results.get(skill.slot);
        cached.set(skill.slot, {
          identity: managedIdentity(target, skill).identity,
          status: result?.status ?? 'check-failed',
          checkedAt,
          ...(result ? {} : { error: 'source check returned no result' }),
          ...(result?.error ? { error: result.error } : {}),
        });
      }
    } catch (error) {
      for (const skill of group) failed(skill, (error as Error).message);
    }
  }
  const state = readStateFile(target.report.stateFile);
  state.updateAvailability = {
    version: 1,
    entries: Object.fromEntries(cached),
  };
  writeStateFile(target.report.stateFile, state);
  return availabilityResult(target, skills, cached);
}

export function sharedRefresh(
  home: Home,
  projectPath?: string,
): SharedUpdateAvailabilityResult {
  const initial = resolveTarget(home, projectPath);
  return withOperationLock(initial, () => refreshTarget(resolveTarget(home, projectPath)));
}

export function sharedOutdatedFromInventory(
  home: Home,
  report: InventoryScanReport,
): SharedUpdateAvailabilityResult {
  const target = targetFromInventory(home, report);
  const skills = readNpxSkillsLock(target.lockFile);
  return availabilityResult(target, skills, updateAvailabilityCache(target));
}

export function sharedOutdated(
  home: Home,
  projectPath?: string,
): SharedUpdateAvailabilityResult {
  const target = resolveTarget(home, projectPath);
  return sharedOutdatedFromInventory(home, target.report);
}

/** One guarded Shared Target operation: snapshot Desired state, make Slots visible,
 *  run the skills CLI under the operation lock, restore Desired state, report Drift.
 *  add/update/remove below are only select/args/check/after over this template. */
interface SharedOp {
  name: 'add' | 'update' | 'remove';
  capture?: boolean | 'output';
  select(target: Target): NpxManagedSkill[];
  args(selected: NpxManagedSkill[], global: boolean): string[];
  /** Slots reported by finalActual when the selection is empty (fresh add). */
  slots?(selected: NpxManagedSkill[]): string[];
  /** restoreDesired only when something failed (remove: success means the Slots are gone). */
  restoreOnFailureOnly?: boolean;
  /** Ops-specific post-run check; throws on failure. May rescan and push into drift.
   *  Runs after the finalActual rescan for always-restore ops (report is fresh),
   *  before the conditional restore for restoreOnFailureOnly ops (must mid-scan).
   *  `outcome` carries the run result so check errors can mirror the generic reason. */
  check?(target: Target, selected: NpxManagedSkill[], drift: string[], outcome: {
    result?: NpxSkillsRunResult;
    failure?: Error;
    actual?: string;
  }): void;
  /** Stages operation-specific filesystem changes after all generic preflight passes. */
  before?(target: Target, selected: NpxManagedSkill[]): StagedDependencies | undefined;
  /** Runs only on success; a throw here propagates unwrapped. */
  after?(target: Target, selected: NpxManagedSkill[], actual: string): void;
}

function sharedApplyFailure(
  operation: SharedOp['name'],
  reason: string,
  actual: string,
  drift: string[],
  partialEffects: 'present' | 'none-detected' | 'unknown',
  stage: 'upstream' | 'verify',
): Error {
  return Object.assign(
    new Error(`skills ${operation} failed (${reason})\nActual: ${actual}\nRemaining drift: ${drift.join(', ') || 'none'}`),
    { code: 'apply_failed', details: { actual, remainingDrift: drift, partialEffects, stage } },
  );
}

function guardedSkillsOp(
  home: Home,
  projectPath: string | undefined,
  op: SharedOp,
): SharedCommandResult {
  const initial = resolveTarget(home, projectPath);
  return withOperationLock(initial, () => {
    const target = resolveTarget(home, projectPath);
    validatePolicyState(target);
    const selected = op.select(target);
    const desired = desiredFor(target, selected);
    const args = op.args(selected, !projectPath);
    let result: NpxSkillsRunResult | undefined;
    let failure: Error | undefined;
    let staged: StagedDependencies | undefined;
    let drift: string[] = [];
    const restore = (): void => {
      if (desired.size > 0) drift = restoreDesired(target, desired);
    };
    try {
      staged = op.before?.(target, selected);
      ensureVisible(target, selected);
      result = runNpxSkills(args, target.cwd, op.capture);
    } catch (error) {
      failure = error as Error;
    }
    const runFailed = Boolean(failure || !result || result.status !== 0);
    const slots = op.slots?.(selected) ?? selected.map(({ slot }) => slot);
    let checkError: Error | undefined;
    let actual: string;
    if (op.restoreOnFailureOnly) {
      try {
        op.check?.(target, selected, drift, { result, failure });
      } catch (error) {
        checkError = error as Error;
      }
      if (runFailed || checkError) {
        restore();
        staged?.rollback();
      }
      actual = finalActual(target, slots, drift);
    } else {
      restore();
      actual = finalActual(target, slots, drift);
      try {
        op.check?.(target, selected, drift, { result, failure, actual });
      } catch (error) {
        checkError = error as Error;
      }
    }
    if (runFailed || checkError) {
      const reason = failure?.message ?? checkError?.message ?? `exit ${result?.status ?? 1}`;
      throw sharedApplyFailure(
        op.name,
        reason,
        actual,
        drift,
        drift.length > 0 ? 'present' : 'none-detected',
        checkError ? 'verify' : 'upstream',
      );
    }
    try {
      op.after?.(target, selected, actual);
      staged?.commit();
    } catch (error) {
      actual = finalActual(target, slots, drift);
      throw sharedApplyFailure(op.name, (error as Error).message, actual, drift, 'unknown', 'verify');
    }
    return { actual, drift };
  });
}

export function sharedAdd(
  home: Home,
  source: string,
  name: string,
  replace: boolean,
  projectPath?: string,
  expectedPlan?: SharedMutationPlan,
  nonInteractive = false,
): SharedCommandResult {
  validateSource(source);
  const slot = validateName(name);
  const preview = expectedPlan ?? planSharedAdd(home, source, name, replace, projectPath);
  const preflight = resolveTarget(home, projectPath);
  validatePolicyState(preflight);
  const currentPreview = buildSharedAddPlan(preflight, source, name, replace);
  if (JSON.stringify(currentPreview) !== JSON.stringify(preview))
    throw concurrentModification('Source add plan changed after preview; create a new preview.');
  const blockers = currentPreview.blockers ?? [];
  if (blockers.length > 0) throw new Error(blockers.join('\n'));
  return guardedSkillsOp(home, projectPath, {
    name: 'add',
    capture: nonInteractive,
    select(target) {
      const currentPlan = buildSharedAddPlan(target, source, name, replace);
      if (JSON.stringify(currentPlan) !== JSON.stringify(preview))
        throw concurrentModification('Source add plan changed after preview; create a new preview.');
      const currentBlockers = currentPlan.blockers ?? [];
      if (currentBlockers.length > 0) throw new Error(currentBlockers.join('\n'));
      const existing = relationship(target, slot);
      const slotInfo = target.report.slots.find((item) =>
        item.targetId === target.target.id && item.name === slot);
      return existing
        ? [{ name: existing.name, slot, provenance: slotInfo?.provenance ?? {} }]
        : [];
    },
    args: (_selected, global) => npxSkillsAddArgs(source, name, global),
    slots: () => [slot],
    check(target, selected, drift, { result, failure, actual }) {
      const installed = actual !== 'unavailable' && target.report.relationships.some((item) =>
        item.targetId === target.target.id && item.slot === slot);
      const runFailed = failure || !result || result.status !== 0;
      if (runFailed && selected.length === 0 && installed)
        drift.push(`${target.target.id}/${slot}: expected missing`);
      if (!runFailed && !installed) throw new Error(`exit ${result?.status ?? 1}`);
    },
    after(target, selected, actual) {
      const managed = readNpxSkillsLock(target.lockFile)
        .find((skill) => skill.slot === slot);
      const expectsManagedProvenance = /^[^/@\s]+\/[^/@\s]+(?:@[^/\s]+)?$/.test(source);
      if ((expectsManagedProvenance && !managed) ||
          (managed && !sameNpxSkillsSource(source, name, managed.provenance)))
        throw new Error(`skills add failed (installer lock source changed or missing)\nActual: ${actual}\nRemaining drift: ${target.target.id}/${slot}: unverified provenance`);
      if (selected.length === 0) updateBaseIntent(target, [slot], 'on');
    },
  });
}

export function sharedUpdate(
  home: Home,
  names: string[],
  projectPath?: string,
  expectedPlan?: SharedUpdatePlan,
  nonInteractive = false,
): SharedUpdateResult {
  const preview = expectedPlan ?? planSharedUpdate(home, names, projectPath);
  const initial = resolveTarget(home, projectPath);
  return withOperationLock(initial, () => {
    const target = resolveTarget(home, projectPath);
    validatePolicyState(target);
    const currentPlan = buildSharedUpdatePlan(
      target,
      names,
      expectedPlan?.items.map(({name}) => name) ?? names,
    );
    if (JSON.stringify(currentPlan) !== JSON.stringify(preview))
      throw concurrentModification('Source update plan changed after preview; create a new preview.');
    if (currentPlan.blockers.length > 0) throw new Error(currentPlan.blockers.join('\n'));
    const includedNames = currentPlan.items.filter(({included}) => included).map(({name}) => name);
    if (includedNames.length === 0) {
      const excluded = currentPlan.items.map(({name, reason}) => `${reason ?? 'ineligible'} Skill: ${name}`);
      throw new Error(`cannot update ${excluded.join(', ')}`);
    }
    const selected = managedSelection(target, includedNames);
    const selectedBySlot = new Map(selected.map((skill) => [skill.slot, skill]));
    const desired = desiredFor(target, selected);
    const allDrift: string[] = [];
    const results: SharedUpdateResult['items'] = [];
    for (const item of currentPlan.items) {
      if (!item.included) {
        results.push({...item, outcome: 'skipped'});
        continue;
      }
      const skill = selectedBySlot.get(item.slot);
      if (!skill) {
        results.push({...item, outcome: 'skipped', reason: 'selection changed'});
        continue;
      }
      let result: NpxSkillsRunResult | undefined;
      let failure: Error | undefined;
      try {
        ensureVisible(target, [skill]);
        result = runNpxSkills(
          npxSkillsUpdateArgs([skill.name], !projectPath),
          target.cwd,
          nonInteractive ? true : 'output',
        );
      } catch (error) {
        failure = error as Error;
      }
      const itemDrift = restoreDesired(target, new Map([[skill.slot, desired.get(skill.slot)!]]));
      const actual = finalActual(target, [skill.slot], itemDrift);
      let verificationFailure: string | undefined;
      if (!failure && result?.status === 0) {
        const updated = readNpxSkillsLock(target.lockFile).find(({slot}) => slot === skill.slot);
        if (!updated || npxSkillsSourceKey(updated) !== npxSkillsSourceKey(skill))
          verificationFailure = 'installer lock provenance changed or disappeared';
        else if (managedIdentity(target, updated).identity === item.identity)
          verificationFailure = 'updater reported success without a verified local change';
      }
      const failed = failure || !result || result.status !== 0 || verificationFailure;
      for (const effect of item.relationshipEffects) {
        if (effect.plannedAction !== 'mirror-sync') continue;
        const mirrorFindings = target.report.findings.filter((finding) =>
          finding.targetId === effect.targetId && finding.slot === effect.slot &&
          (finding.code === 'mirror-drift' || finding.code === 'mirror-diverged'));
        if (mirrorFindings.some(({code}) => code === 'mirror-drift'))
          itemDrift.push(`${effect.targetId}/${effect.slot}: mirror-sync`);
        if (mirrorFindings.some(({code}) => code === 'mirror-diverged'))
          itemDrift.push(`${effect.targetId}/${effect.slot}: mirror-diverged (explicit overwrite or convert required)`);
      }
      allDrift.push(...itemDrift);
      const reason = failure?.message ?? verificationFailure ??
        (result?.stderr.trim() || `exit ${result?.status ?? 1}`);
      const log = [
        `$ npx --yes ${NPX_SKILLS_PACKAGE} ${npxSkillsUpdateArgs([skill.name], !projectPath).join(' ')}`,
        result?.stdout.trim(),
        result?.stderr.trim(),
        failure?.message,
        `exit ${result?.status ?? 1}`,
      ].filter(Boolean).join('\n');
      results.push({
        ...item,
        outcome: failed ? 'failed' : 'updated',
        ...(failed ? {reason} : {}),
        actual,
        drift: itemDrift,
        log,
      });
    }
    return {
      actual: finalActual(target, currentPlan.items.map(({slot}) => slot), allDrift),
      drift: [...new Set(allDrift)],
      items: results,
    };
  });
}

export function sharedRemoveCascade(
  home: Home,
  names: string[],
  expected: SharedRemovalPlan,
  projectPath?: string,
): SharedCommandResult {
  const preview = planSharedRemove(home, names, projectPath);
  assertRemovalPlan(expected, preview);
  assertRemovalUnblocked(preview);
  const initial = resolveTarget(home, projectPath);
  try {
    return withOperationLock(initial, () => {
      const target = resolveTarget(home, projectPath);
    const skill = managedSelection(target, names)[0];
    if (!skill) throw new Error('managed Shared source disappeared');
    const sourceRelationships = target.report.relationships.filter((item) =>
      item.targetId === target.target.id && item.slot === preview.source.slot);
    const source = sourceRelationships.length === 1 ? sourceRelationships[0] : undefined;
    const dependencies = source ? removalDependencies(target, source) : [];
    const blockers = removalBlockers(target, skill, source, sourceRelationships, dependencies);
    if (blockers.length > 0) throw new Error(blockers.join('; '));
    if (contentFingerprint(preview.source.path).hash !== preview.source.fingerprint ||
      contentFingerprint(target.lockFile).hash !== preview.preconditions.lock.hash ||
      contentFingerprint(target.report.stateFile).hash !== preview.preconditions.policy.hash ||
      !sameDependencies(preview.dependencies, dependencies))
      throw concurrentModification('Shared source or dependent Relationships changed after preview');
    assertRemovalDependenciesAllowed(target, dependencies);
    const staged = stageDependencies(target, dependencies);
    const temporaryManifest = `${preview.recovery.manifest}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(preview.recovery.manifest), {recursive: true});
      fs.writeFileSync(temporaryManifest, JSON.stringify({
        version: 1,
        targetId: preview.targetId,
        slot: preview.source.slot,
        sourcePath: preview.source.path,
        sourceFingerprint: preview.source.fingerprint,
        lockFingerprint: preview.preconditions.lock.hash,
        provenance: preview.source.provenance,
        dependencies: preview.dependencies,
        stagingRoot: staged?.stagingRoot,
      }, null, 2) + '\n');
      fs.renameSync(temporaryManifest, preview.recovery.manifest);
      removeDependencyState(target, dependencies);
    } catch (error) {
      fs.rmSync(temporaryManifest, {force: true});
      fs.rmSync(preview.recovery.manifest, {force: true});
      staged?.rollback();
      throw error;
    }
    try {
      staged?.commit();
    } catch (error) {
      throw Object.assign(
        new Error(`Relationship cascade cleanup failed: ${(error as Error).message}`),
        {
          code: 'apply_failed',
          details: {
            completedWork: dependencies.map(({targetId, slot}) => `deleted ${targetId}/${slot}`),
            recovery: preview.recovery,
            stagingRoot: staged?.stagingRoot,
          },
        },
      );
    }
      const final = scan(home, projectPath);
      return {
        actual: actualSummary(final, target.target.id, [preview.source.slot]),
        drift: [],
        recoveryManifest: preview.recovery.manifest,
        completedWork: dependencies.map(({targetId, slot}) => `deleted ${targetId}/${slot}`),
      };
    });
  } catch (error) {
    const failure = error as Error & {details?: Record<string, unknown>};
    let actual = 'rescan unavailable';
    let remainingDependencies = preview.dependencies.map(({targetId, slot}) => `${targetId}/${slot}`);
    try {
      const final = scan(home, projectPath);
      actual = actualSummary(final, preview.targetId, [preview.source.slot]);
      const paths = new Set(final.relationships.map(({path: relationshipPath}) => relationshipPath));
      remainingDependencies = preview.dependencies
        .filter(({path: dependencyPath}) => paths.has(dependencyPath))
        .map(({targetId, slot}) => `${targetId}/${slot}`);
    } catch {
      // Keep the original failure primary and report that the rescan was unavailable.
    }
    failure.details = {
      ...failure.details,
      actual,
      desired: preview.currentTruth.desired,
      source: preview.source,
      remainingDependencies,
      recovery: preview.recovery,
      completedWork: preview.dependencies
        .filter(({targetId, slot}) => !remainingDependencies.includes(`${targetId}/${slot}`))
        .map(({targetId, slot}) => `deleted ${targetId}/${slot}`),
    };
    throw failure;
  }
}

export function sharedRemove(
  home: Home,
  names: string[],
  options: {
    sourceConfirmed?: boolean;
    projectPath?: string;
    expected?: SharedRemovalPlan;
    nonInteractive?: boolean;
  } = {},
): SharedCommandResult {
  const {sourceConfirmed = false, projectPath, expected, nonInteractive = false} = options;
  const preview = planSharedRemove(home, names, projectPath);
  if (!sourceConfirmed) throw new Error('confirm source deletion separately');
  if (!preview.cascadeConfirmed)
    throw new Error('confirm the Relationship cascade first with --cascade');
  if (preview.dependencies.length > 0)
    throw concurrentModification('new dependent Relationships appeared after cascade confirmation');
  if (expected && (expected.targetId !== preview.targetId ||
    expected.source.slot !== preview.source.slot ||
    expected.source.path !== preview.source.path ||
    expected.source.fingerprint !== preview.source.fingerprint ||
    expected.source.provenance !== preview.source.provenance))
    throw concurrentModification('Shared source changed after preview');
  assertRemovalUnblocked(preview);
  try {
    const result = guardedSkillsOp(home, projectPath, {
      name: 'remove',
      capture: nonInteractive,
      restoreOnFailureOnly: true,
      select(target) {
        const selected = managedSelection(target, names);
        const skill = selected[0];
        if (!skill) throw new Error('managed Shared source disappeared');
        if (contentFingerprint(target.lockFile).hash !== preview.preconditions.lock.hash ||
          contentFingerprint(target.report.stateFile).hash !== preview.preconditions.policy.hash ||
          npxSkillsProvenanceLabel(skill.provenance) !== preview.source.provenance)
          throw concurrentModification('Shared source lock, provenance, or policy changed after preview');
        if (!manifestMatches(
          preview.recovery.manifest,
          preview.targetId,
          preview.source.slot,
          preview.source.fingerprint,
          preview.preconditions.lock.hash,
        )) throw new Error('Relationship cascade confirmation is stale or missing');
        const sourceRelationships = target.report.relationships.filter((item) =>
          item.targetId === target.target.id && item.slot === preview.source.slot);
        const source = sourceRelationships.length === 1 ? sourceRelationships[0] : undefined;
        const dependencies = source ? removalDependencies(target, source) : [];
        if (!source || source.form !== 'local' || source.path !== preview.source.path ||
          contentFingerprint(source.path).hash !== preview.source.fingerprint)
          throw concurrentModification('Shared source changed after preview');
        if (dependencies.length > 0)
          throw concurrentModification('new dependent Relationships appeared after cascade confirmation');
        const blockers = removalBlockers(target, skill, source, sourceRelationships, dependencies);
        if (blockers.length > 0) throw new Error(blockers.join('; '));
        return selected;
      },
      args: (selected, global) => {
        const skill = selected[0];
        if (!skill) throw new Error('managed Shared source disappeared');
        return npxSkillsRemoveArgs([skill.name], global);
      },
      check(target, selected, _drift, {result, failure}) {
        target.report = scan(home, projectPath);
        const skill = selected[0];
        if (!skill) throw new Error('managed Shared source disappeared');
        const remaining = target.report.relationships.some((item) =>
          item.targetId === target.target.id && item.slot === skill.slot);
        const lockRemains = readNpxSkillsLock(target.lockFile).some(({slot}) => slot === skill.slot);
        if (!failure && result?.status === 0 && (remaining || lockRemains))
          throw new Error(`verification failed: source=${remaining ? 'present' : 'missing'} lock=${lockRemains ? 'present' : 'removed'}`);
      },
      after(target, selected) {
        const skill = selected[0];
        if (!skill) throw new Error('managed Shared source disappeared');
        updateBaseIntent(target, [skill.slot]);
        fs.rmSync(preview.recovery.manifest, {force: true});
      },
    });
    return {...result, completedWork: ['Relationship cascade', `deleted ${preview.source.name}`]};
  } catch (error) {
    const failure = error as Error & {details?: Record<string, unknown>};
    failure.details = {
      ...failure.details,
      source: preview.source,
      recovery: preview.recovery,
      completedWork: ['Relationship cascade'],
      remainingWork: [`delete Shared source ${preview.source.name}`],
    };
    throw failure;
  }
}
