import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadRuntimes,
  normalizeManagedSkillName,
  readManagedSkillLock,
  readStateFile,
  scanGlobalInventory,
  scanProjectInventory,
  writeStateFile,
  type InventoryScanReport,
  type ManagedSkill,
  type RuntimeRelationship,
  type ScannedRuntime,
  type SkillProvenance,
} from './inventory.ts';
import type { Home } from './core.ts';

const SKILLS_PACKAGE = 'skills@1.5.21';

export interface FindCandidate {
  source: string;
  name: string;
  installs?: string;
  detailUrl: string;
}

export interface SharedCommandResult {
  actual: string;
  drift: string[];
}

interface Target {
  home: Home;
  projectPath?: string;
  runtime: ScannedRuntime;
  report: InventoryScanReport;
  cwd: string;
  lockFile: string;
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function parseSkillsFindOutput(raw: string): {
  candidates: FindCandidate[];
  complete: boolean;
  raw: string;
} {
  const lines = raw.replace(ANSI, '').split(/\r?\n/);
  const candidates: FindCandidate[] = [];
  const resultLines = lines.filter((line) =>
    /^\S+@\S+(?:\s+.+ installs)?$/.test(line.trim())).length;
  const detailLines = lines.filter((line) =>
    /^└\s+https:\/\/skills\.sh\/\S+$/.test(line.trim())).length;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (index === lines.length - 1) continue;
    const detail = lines[index + 1].trim().match(/^└\s+(https:\/\/skills\.sh\/\S+)$/);
    if (!detail) continue;
    const result = line.match(/^(\S+)@(\S+?)(?:\s+(.+ installs))?$/);
    if (!result) continue;
    candidates.push({
      source: result[1],
      name: result[2],
      ...(result[3] ? { installs: result[3] } : {}),
      detailUrl: detail[1],
    });
    index++;
  }
  const marker = lines.findIndex((line) =>
    line.includes('Install with') && line.includes('npx skills add'));
  const bodyLines = marker < 0 ? [] : lines.slice(marker + 1).filter((line) => line.trim());
  return {
    candidates,
    complete: marker >= 0
      ? bodyLines.length === candidates.length * 2
      : candidates.length === resultLines && candidates.length === detailLines,
    raw,
  };
}

function runSkills(
  args: string[],
  cwd: string,
  capture = false,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['--yes', SKILLS_PACKAGE, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, XDG_STATE_HOME: undefined },
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function scan(home: Home, projectPath?: string, persist = false): InventoryScanReport {
  const runtimes = loadRuntimes(home, { persist });
  return projectPath
    ? scanProjectInventory(home, projectPath, runtimes, { persist })
    : scanGlobalInventory(home, runtimes, { persist });
}

function resolveTarget(home: Home, projectPath?: string): Target {
  const exactProject = projectPath ? fs.realpathSync(projectPath) : undefined;
  const report = scan(home, exactProject);
  const matches = report.runtimes.filter((runtime) =>
    runtime.kind === 'shared' && runtime.key === 'shared' && runtime.writable &&
    (exactProject ? runtime.scope === 'project' : runtime.scope === 'global'));
  if (matches.length !== 1)
    throw new Error(`expected exactly one writable Shared Runtime named "shared"; found ${matches.length}`);
  const runtime = matches[0];
  const canonicalRoot = exactProject
    ? path.join(exactProject, '.agents', 'skills')
    : path.join(os.homedir(), '.agents', 'skills');
  if (path.resolve(runtime.discoveryRoot) !== canonicalRoot)
    throw new Error(`Shared Runtime must use canonical root ${canonicalRoot}`);
  if (!runtime.lockFile) throw new Error('Shared Runtime has no installer lock');
  return {
    home,
    projectPath: exactProject,
    runtime,
    report,
    cwd: exactProject ?? process.cwd(),
    lockFile: runtime.lockFile,
  };
}

function validateName(name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name))
    throw new Error(`invalid skill name: ${name || '(empty)'}`);
  return normalizeManagedSkillName(name);
}

function validateSource(source: string): void {
  if (!source || source.startsWith('-')) throw new Error('source is required');
}

function relationship(target: Target, slot: string): RuntimeRelationship | undefined {
  const relationships = target.report.relationships.filter((item) =>
    item.runtimeId === target.runtime.id && item.slot === slot);
  if (relationships.length > 1)
    throw new Error(`Runtime Slot ${target.runtime.id}/${slot} has ON/OFF or normalized-name conflicts`);
  const found = relationships[0];
  if (found?.form === 'link' && !found.realPath)
    throw new Error(`Runtime Slot ${target.runtime.id}/${slot} is a broken link`);
  return found;
}

function sourceParts(value: string): { source: string; skill?: string } {
  let source = value.trim();
  const at = source.lastIndexOf('@');
  const skill = at > source.indexOf('/') ? source.slice(at + 1) : undefined;
  if (skill) source = source.slice(0, at);
  source = source.replace(/\.git$/, '');
  const github = source.match(/github\.com[/:]([^/]+\/[^/]+)$/i);
  return { source: (github?.[1] ?? source).toLowerCase(), skill };
}

function provenanceSkillName(skillPath: string): string {
  const normalized = skillPath.replaceAll('\\', '/').replace(/\/$/, '');
  const parts = normalized.split('/');
  return parts.at(-1)?.toLowerCase() === 'skill.md'
    ? parts.at(-2) ?? ''
    : parts.at(-1) ?? '';
}

function provenanceLabel(provenance?: SkillProvenance): string {
  return provenance?.source ?? provenance?.sourceUrl ?? provenance?.skillPath ?? 'Source unknown';
}

function sameSource(
  source: string,
  skillName: string,
  provenance?: SkillProvenance,
): boolean {
  if (!provenance) return false;
  const requested = sourceParts(source);
  const sourceMatches = [provenance.source, provenance.sourceUrl]
    .some((value) => value && sourceParts(value).source === requested.source);
  if (!sourceMatches) return false;
  if (!provenance.skillPath) return requested.skill === undefined;
  const requestedSkill = normalizeManagedSkillName(requested.skill ?? skillName);
  return normalizeManagedSkillName(provenanceSkillName(provenance.skillPath)) === requestedSkill;
}

function withOperationLock<T>(target: Target, operation: () => T): T {
  const lock = `${target.lockFile}.skillspub-operation-lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let descriptor: number;
  try {
    descriptor = fs.openSync(lock, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`Shared Runtime operation already in progress: ${lock}`);
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

function managedSelection(target: Target, requested: string[]): ManagedSkill[] {
  const managed = readManagedSkillLock(target.lockFile);
  const bySlot = new Map(managed.map((skill) => [skill.slot, skill]));
  const selected = requested.length > 0
    ? requested.map((name) => {
        const found = bySlot.get(validateName(name));
        if (!found) throw new Error(`${name} is not managed by ${SKILLS_PACKAGE}`);
        return found;
      })
    : managed;
  if (selected.length === 0) throw new Error(`no skills managed by ${SKILLS_PACKAGE}`);
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
  skill: ManagedSkill,
  current: RuntimeRelationship,
): 'on' | 'off' {
  const state = readStateFile(target.report.stateFile);
  const id = `${target.runtime.id}\0${skill.slot}`;
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

function move(relationship: RuntimeRelationship, destinationRoot: string): void {
  const destination = path.join(destinationRoot, relationship.name);
  if (fs.existsSync(destination) || fs.lstatSync(destination, { throwIfNoEntry: false }))
    throw new Error(`path conflict: ${destination}`);
  fs.mkdirSync(destinationRoot, { recursive: true });
  fs.renameSync(relationship.path, destination);
}

function desiredFor(target: Target, skills: ManagedSkill[]): Map<string, 'on' | 'off'> {
  const desired = new Map<string, 'on' | 'off'>();
  for (const skill of skills) {
    const current = relationship(target, skill.slot);
    if (!current) throw new Error(`installer lock/file mismatch: ${skill.name}`);
    desired.set(skill.slot, desiredActivation(target, skill, current));
  }
  return desired;
}

function ensureVisible(target: Target, skills: ManagedSkill[]): void {
  for (const skill of skills) {
    const current = relationship(target, skill.slot);
    if (!current) throw new Error(`installer lock/file mismatch: ${skill.name}`);
    if (current.activation === 'off') {
      move(current, target.runtime.discoveryRoot);
      target.report = scan(target.home, target.projectPath);
    }
  }
}

function restoreDesired(target: Target, desired: Map<string, 'on' | 'off'>): string[] {
  const drift: string[] = [];
  for (const [slot, activation] of desired) {
    let current: RuntimeRelationship | undefined;
    try {
      target.report = scan(target.home, target.projectPath);
      current = relationship(target, slot);
      if (!current) {
        drift.push(`${target.runtime.id}/${slot}: missing`);
        continue;
      }
      if (current.activation !== activation)
        move(current, activation === 'on' ? target.runtime.discoveryRoot : target.runtime.parkingRoot);
    } catch (error) {
      drift.push(`${target.runtime.id}/${slot}: ${(error as Error).message}`);
    }
  }
  return drift;
}

function finalActual(target: Target, slots: string[], drift: string[]): string {
  try {
    target.report = scan(target.home, target.projectPath, true);
    return actualSummary(target.report, target.runtime.id, slots);
  } catch (error) {
    drift.push(`final rescan: ${(error as Error).message}`);
    return 'unavailable';
  }
}

function actualSummary(report: InventoryScanReport, runtimeId: string, slots: string[]): string {
  return slots.map((slot) => {
    const states = report.relationships
      .filter((item) => item.runtimeId === runtimeId && item.slot === slot)
      .map((item) => `${item.activation}/${item.form}`);
    return `${slot}=${states.join('+') || 'missing'}`;
  }).join(', ');
}

function updateBaseIntent(target: Target, slots: string[], value?: 'on'): void {
  const state = readStateFile(target.report.stateFile);
  const baseIntent = { ...baseIntents(state) };
  for (const slot of slots) {
    const id = `${target.runtime.id}\0${slot}`;
    if (value) baseIntent[id] = value;
    else delete baseIntent[id];
  }
  writeStateFile(target.report.stateFile, { ...state, baseIntent });
}

export function sharedFind(home: Home, query: string[], projectPath?: string): void {
  if (query.length === 0) throw new Error('usage: skillspub shared find <query>');
  const target = resolveTarget(home, projectPath);
  const result = runSkills(['find', ...query], target.cwd, true);
  if (result.stderr) process.stderr.write(result.stderr);
  const parsed = parseSkillsFindOutput(result.stdout);
  if (!parsed.complete || parsed.candidates.length === 0) process.stdout.write(result.stdout);
  else for (const candidate of parsed.candidates)
    console.log(`${candidate.source}@${candidate.name}\t${candidate.installs ?? ''}\t${candidate.detailUrl}`);
  if (result.status !== 0) throw new Error(`skills find failed (exit ${result.status})`);
}

export function sharedDescribe(home: Home, source: string, projectPath?: string): void {
  validateSource(source);
  const target = resolveTarget(home, projectPath);
  const result = runSkills(['add', source, '--list'], target.cwd, true);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`skills description lookup failed (exit ${result.status})`);
}

/** One guarded Shared Runtime operation: snapshot Desired state, make Slots visible,
 *  run the skills CLI under the operation lock, restore Desired state, report Drift.
 *  add/update/remove below are only select/args/check/after over this template. */
interface SharedOp {
  name: 'add' | 'update' | 'remove';
  select(target: Target): ManagedSkill[];
  args(selected: ManagedSkill[], globalFlag: string[]): string[];
  /** Slots reported by finalActual when the selection is empty (fresh add). */
  slots?(selected: ManagedSkill[]): string[];
  /** restoreDesired only when something failed (remove: success means the Slots are gone). */
  restoreOnFailureOnly?: boolean;
  /** Ops-specific post-run check; throws on failure. May rescan and push into drift.
   *  Runs after the finalActual rescan for always-restore ops (report is fresh),
   *  before the conditional restore for restoreOnFailureOnly ops (must mid-scan).
   *  `outcome` carries the run result so check errors can mirror the generic reason. */
  check?(target: Target, selected: ManagedSkill[], drift: string[], outcome: {
    result?: ReturnType<typeof runSkills>;
    failure?: Error;
    actual?: string;
  }): void;
  /** Runs only on success; a throw here propagates unwrapped. */
  after?(target: Target, selected: ManagedSkill[], actual: string): void;
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
    const args = op.args(selected, projectPath ? [] : ['--global']);
    let result: ReturnType<typeof runSkills> | undefined;
    let failure: Error | undefined;
    let drift: string[] = [];
    const restore = (): void => {
      if (desired.size > 0) drift = restoreDesired(target, desired);
    };
    try {
      ensureVisible(target, selected);
      result = runSkills(args, target.cwd);
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
      if (runFailed || checkError) restore();
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
        item.runtimeId === target.runtime.id && item.name === slot);
      if (existing) {
        const current = provenanceLabel(slotInfo?.provenance);
        if (!sameSource(source, name, slotInfo?.provenance)) {
          console.log(`Replace: ${current} -> ${source}`);
          if (!replace) throw new Error('source replacement requires --replace');
        }
      } else {
        for (const root of [target.runtime.discoveryRoot, target.runtime.parkingRoot]) {
          const candidate = path.join(root, slot);
          if (fs.lstatSync(candidate, { throwIfNoEntry: false }))
            throw new Error(`path conflict: ${candidate}`);
        }
      }
      return existing
        ? [{ name: existing.name, slot, provenance: slotInfo?.provenance ?? {} }]
        : [];
    },
    args: (_selected, globalFlag) =>
      ['add', source, '--skill', name, '--agent', 'codex', ...globalFlag, '--copy'],
    slots: () => [slot],
    check(target, selected, drift, { result, failure, actual }) {
      const installed = actual !== 'unavailable' && target.report.relationships.some((item) =>
        item.runtimeId === target.runtime.id && item.slot === slot);
      const runFailed = failure || !result || result.status !== 0;
      if (runFailed && selected.length === 0 && installed)
        drift.push(`${target.runtime.id}/${slot}: expected missing`);
      if (!runFailed && !installed) throw new Error(`exit ${result?.status ?? 1}`);
    },
    after(target, selected, actual) {
      const managed = readManagedSkillLock(target.lockFile)
        .find((skill) => skill.slot === slot);
      if (managed && !sameSource(source, name, managed.provenance))
        throw new Error(`skills add failed (installer lock source changed)\nActual: ${actual}\nRemaining drift: ${target.runtime.id}/${slot}: unverified provenance`);
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
    args: (selected, globalFlag) =>
      ['update', ...selected.map(({ name }) => name), ...globalFlag],
  });
}

export function sharedRemove(
  home: Home,
  names: string[],
  projectPath?: string,
): SharedCommandResult {
  if (names.length === 0) throw new Error('usage: skillspub shared remove <managed-name...>');
  return guardedSkillsOp(home, projectPath, {
    name: 'remove',
    restoreOnFailureOnly: true,
    select(target) {
      const selected = managedSelection(target, names);
      const state = readStateFile(target.report.stateFile);
      const claims = claimedSlots(state);
      for (const skill of selected) {
        const id = `${target.runtime.id}\0${skill.slot}`;
        if (claims.has(id)) throw new Error(`cannot remove claimed Runtime Slot ${target.runtime.id}/${skill.slot}`);
      }
      return selected;
    },
    args: (selected, globalFlag) =>
      ['remove', ...selected.map(({ name }) => name), '--agent', 'codex', ...globalFlag],
    check(target, selected, _drift, { result, failure }) {
      target.report = scan(home, projectPath);
      const remaining = selected.filter((skill) => target.report.relationships.some((item) =>
        item.runtimeId === target.runtime.id && item.slot === skill.slot));
      const runFailed = failure || !result || result.status !== 0;
      if (!runFailed && remaining.length > 0) throw new Error(`exit ${result?.status ?? 1}`);
    },
    after(target, selected) {
      updateBaseIntent(target, selected.map(({ slot }) => slot));
    },
  });
}
