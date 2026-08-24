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
  npxSkillsAddArgs,
  npxSkillsDescribeArgs,
  npxSkillsFindArgs,
  npxSkillsProvenanceLabel,
  npxSkillsRemoveArgs,
  npxSkillsUpdateArgs,
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

interface Target {
  home: Home;
  projectPath?: string;
  target: ScannedTarget;
  report: InventoryScanReport;
  cwd: string;
  lockFile: string;
}

export interface SharedRemovalDependency {
  targetId: string;
  slot: string;
  form: 'link' | 'mirror';
  path: string;
  resourceId: string;
  fingerprint: string;
}

export interface SharedRemovalPlan {
  dependencies: SharedRemovalDependency[];
}

interface StagedDependencies {
  rollback(): void;
  commit(): void;
}


function scan(home: Home, projectPath?: string, persist = false): InventoryScanReport {
  const targets = loadTargets(home);
  return projectPath
    ? scanProjectInventory(home, projectPath, targets, { persist })
    : scanGlobalInventory(home, targets, { persist });
}

function resolveTarget(home: Home, projectPath?: string): Target {
  const exactProject = projectPath ? fs.realpathSync(projectPath) : undefined;
  const report = scan(home, exactProject);
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


function withOperationLock<T>(target: Target, operation: () => T): T {
  const lock = `${target.lockFile}.skillspub-operation-lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let descriptor: number;
  try {
    descriptor = fs.openSync(lock, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`Shared Target operation already in progress: ${lock}`);
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
  const stat = fs.lstatSync(entryPath, { throwIfNoEntry: false });
  if (!stat || (form === 'link' && !stat.isSymbolicLink()))
    throw new Error(`relationship disappeared during preview: ${entryPath}`);
  return form === 'link' ? fs.readlinkSync(entryPath) : hashDirectory(entryPath);
}

function removalDependencies(target: Target, selected: NpxManagedSkill[]): SharedRemovalDependency[] {
  const sourceIds = new Set(selected.map((skill) => {
    const current = relationship(target, skill.slot);
    if (!current?.resourceId) throw new Error(`installer lock/file mismatch: ${skill.name}`);
    return current.resourceId;
  }));
  const relationships = target.report.relationships.filter((item) =>
    item.targetId !== target.target.id &&
    (item.form === 'link' || item.form === 'mirror') && item.resourceId &&
    sourceIds.has(item.resourceId));
  const readOnly = relationships.find((item) => item.readOnly);
  if (readOnly)
    throw new Error(`cannot remove Shared source with read-only dependent Relationship: ${readOnly.path}`);
  return relationships
    .map(({ targetId, slot, form, path: entryPath, resourceId }) => {
      if (!resourceId) throw new Error(`relationship disappeared during preview: ${entryPath}`);
      const dependencyForm = form as 'link' | 'mirror';
      return {
        targetId,
        slot,
        form: dependencyForm,
        path: entryPath,
        resourceId,
        fingerprint: dependencyFingerprint(dependencyForm, entryPath),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function sameDependencies(
  expected: SharedRemovalDependency[],
  actual: SharedRemovalDependency[],
): boolean {
  return expected.length === actual.length && expected.every((dependency, index) =>
    JSON.stringify(dependency) === JSON.stringify(actual[index]));
}

function assertRemovalDependenciesAllowed(target: Target, dependencies: SharedRemovalDependency[]): void {
  const claims = claimedSlots(readStateFile(target.report.stateFile));
  for (const dependency of dependencies) {
    const slotId = `${dependency.targetId}\0${dependency.slot}`;
    if (claims.has(slotId))
      throw new Error(`cannot remove claimed Target Slot ${slotId.replace('\0', '/')}`);
    if (dependencyFingerprint(dependency.form, dependency.path) !== dependency.fingerprint)
      throw new Error(`relationship changed during preview: ${dependency.path}`);
  }
}

function stageDependencies(target: Target, dependencies: SharedRemovalDependency[]): StagedDependencies | undefined {
  if (dependencies.length === 0) return undefined;
  assertRemovalDependenciesAllowed(target, dependencies);
  const root = fs.mkdtempSync(path.join(path.dirname(target.lockFile), '.skillspub-remove-'));
  const staged: Array<{ from: string; to: string }> = [];
  const rollback = (): void => {
    for (const item of staged.toReversed()) fs.renameSync(item.to, item.from);
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    for (const [index, dependency] of dependencies.entries()) {
      assertRemovalDependenciesAllowed(target, [dependency]);
      const destination = path.join(root, String(index));
      fs.renameSync(dependency.path, destination);
      staged.push({ from: dependency.path, to: destination });
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return {
    rollback,
    commit: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function removeDependencyState(target: Target, dependencies: SharedRemovalDependency[]): void {
  if (dependencies.length === 0) return;
  const state = readStateFile(target.report.stateFile);
  const baseIntent = { ...baseIntents(state) };
  const mirrors = { ...(state.mirrors as Record<string, unknown> | undefined) };
  for (const { targetId, slot } of dependencies) {
    const slotId = `${targetId}\0${slot}`;
    delete baseIntent[slotId];
    delete mirrors[slotId];
  }
  const { baseIntent: _baseIntent, mirrors: _mirrors, ...remaining } = state;
  writeStateFile(target.report.stateFile, {
    ...remaining,
    ...(Object.keys(baseIntent).length > 0 ? { baseIntent } : {}),
    ...(Object.keys(mirrors).length > 0 ? { mirrors } : {}),
  });
}

export function planSharedRemove(
  home: Home,
  names: string[],
  projectPath?: string,
): SharedRemovalPlan {
  if (names.length === 0) throw new Error('usage: skillspub shared remove <managed-name...>');
  const target = resolveTarget(home, projectPath);
  validatePolicyState(target);
  const selected = managedSelection(target, names);
  const claims = claimedSlots(readStateFile(target.report.stateFile));
  for (const skill of selected) {
    const slotId = `${target.target.id}\0${skill.slot}`;
    if (claims.has(slotId)) throw new Error(`cannot remove claimed Target Slot ${slotId.replace('\0', '/')}`);
  }
  desiredFor(target, selected);
  const dependencies = removalDependencies(target, selected);
  assertRemovalDependenciesAllowed(target, dependencies);
  return { dependencies };
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

/** One guarded Shared Target operation: snapshot Desired state, make Slots visible,
 *  run the skills CLI under the operation lock, restore Desired state, report Drift.
 *  add/update/remove below are only select/args/check/after over this template. */
interface SharedOp {
  name: 'add' | 'update' | 'remove';
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
      result = runNpxSkills(args, target.cwd);
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
      throw new Error(`skills ${op.name} failed (${reason})\nActual: ${actual}\nRemaining drift: ${drift.join(', ') || 'none'}`);
    }
    op.after?.(target, selected, actual);
    staged?.commit();
    return { actual, drift };
  });
}

export function sharedAdd(
  home: Home,
  source: string,
  name: string,
  replace: boolean,
  projectPath?: string,
): SharedCommandResult {
  validateSource(source);
  const slot = validateName(name);
  return guardedSkillsOp(home, projectPath, {
    name: 'add',
    select(target) {
      const existing = relationship(target, slot);
      const slotInfo = target.report.slots.find((item) =>
        item.targetId === target.target.id && item.name === slot);
      if (existing) {
        const current = npxSkillsProvenanceLabel(slotInfo?.provenance);
        if (!sameNpxSkillsSource(source, name, slotInfo?.provenance)) {
          console.log(`Replace: ${current} -> ${source}`);
          if (!replace) throw new Error('source replacement requires --replace');
        }
      } else {
        for (const root of [target.target.discoveryRoot, target.target.parkingRoot]) {
          const candidate = path.join(root, slot);
          if (fs.lstatSync(candidate, { throwIfNoEntry: false }))
            throw new Error(`path conflict: ${candidate}`);
        }
      }
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
      if (managed && !sameNpxSkillsSource(source, name, managed.provenance))
        throw new Error(`skills add failed (installer lock source changed)\nActual: ${actual}\nRemaining drift: ${target.target.id}/${slot}: unverified provenance`);
      if (selected.length === 0) updateBaseIntent(target, [slot], 'on');
    },
  });
}

export function sharedUpdate(
  home: Home,
  names: string[],
  projectPath?: string,
): SharedCommandResult {
  return guardedSkillsOp(home, projectPath, {
    name: 'update',
    select: (target) => managedSelection(target, names),
    args: (selected, global) =>
      npxSkillsUpdateArgs(selected.map(({ name }) => name), global),
  });
}

export function sharedRemove(
  home: Home,
  names: string[],
  options: { cascadeConfirmed?: boolean; projectPath?: string; expected?: SharedRemovalPlan } = {},
): SharedCommandResult {
  const { cascadeConfirmed = false, projectPath, expected } = options;
  const preview = planSharedRemove(home, names, projectPath);
  if (expected && !sameDependencies(expected.dependencies, preview.dependencies))
    throw new Error('dependent Relationships changed after preview');
  if (preview.dependencies.length > 0 && !cascadeConfirmed)
    throw new Error('dependent Relationships will also be deleted; rerun with --yes');
  let dependencies: SharedRemovalDependency[] = [];
  return guardedSkillsOp(home, projectPath, {
    name: 'remove',
    restoreOnFailureOnly: true,
    select(target) {
      const selected = managedSelection(target, names);
      const claims = claimedSlots(readStateFile(target.report.stateFile));
      for (const skill of selected) {
        const slotId = `${target.target.id}\0${skill.slot}`;
        if (claims.has(slotId)) throw new Error(`cannot remove claimed Target Slot ${slotId.replace('\0', '/')}`);
      }
      return selected;
    },
    args: (selected, global) =>
      npxSkillsRemoveArgs(selected.map(({ name }) => name), global),
    before(target, selected) {
      dependencies = removalDependencies(target, selected);
      if (!sameDependencies(preview.dependencies, dependencies))
        throw new Error('dependent Relationships changed after preview');
      assertRemovalDependenciesAllowed(target, dependencies);
      return stageDependencies(target, dependencies);
    },
    check(target, selected, _drift, { result, failure }) {
      target.report = scan(home, projectPath);
      const remaining = selected.filter((skill) => target.report.relationships.some((item) =>
        item.targetId === target.target.id && item.slot === skill.slot));
      const runFailed = failure || !result || result.status !== 0;
      if (!runFailed && remaining.length > 0) throw new Error(`exit ${result?.status ?? 1}`);
    },
    after(target, selected) {
      updateBaseIntent(target, selected.map(({ slot }) => slot));
      removeDependencyState(target, dependencies);
    },
  });
}
