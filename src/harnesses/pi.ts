import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Home } from '../core.ts';
import {
  readStateFile,
  scanGlobalInventory,
  type InventoryScanReport,
  type SkillTarget,
} from '../inventory.ts';
import type {
  HarnessAdapter,
  HarnessEvidence,
  HarnessInspection,
  HarnessOperation,
  HarnessOperationPlan,
  HarnessOperationResult,
  HarnessRelationshipEffect,
  HarnessRelationshipGroup,
  HarnessRelationshipImpact,
} from './types.ts';
import { resolveHarnessTarget } from './target.ts';

interface FileSnapshot {
  file: string;
  exists: boolean;
  raw?: string;
  hash: string;
}

interface PiSettings extends FileSnapshot {
  value: Record<string, unknown>;
  skills: string[];
}

interface PiIsolationClaim {
  version: 1;
  scope: 'global';
  file: string;
  sharedRoot: string;
  exclusion: string;
  settingsHash: string;
}

interface Ownership {
  status: 'owned' | 'unowned' | 'drift';
  legacyExclusion?: string;
  claim?: PiIsolationClaim;
}

interface MatcherInspection {
  sharedExcluded: boolean;
  equivalentExclusion?: string;
  piTargetConflict?: string;
}

interface PiSharedIsolationPlan {
  settings: PiSettings;
  state: FileSnapshot;
  piRoot: string;
  sharedRoot: string;
  exclusion: string;
  ownership: Ownership;
  change: boolean;
  claim: boolean;
  stateChange: boolean;
  managedAfter: boolean;
  updatedSettings: string;
  updatedSettingsHash: string;
  updatedState: string;
  updatedStateHash: string;
  settingsBackupFile: string;
  stateBackupFile: string;
  manifestFile: string;
  relationshipImpact: HarnessRelationshipImpact;
  groups: HarnessRelationshipGroup[];
}

type PiSharedIsolationDraft = Omit<PiSharedIsolationPlan, 'relationshipImpact'>;

const EVIDENCE = [
  {
    url: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md',
    verifiedVersion: '0.54.0',
    detail: 'Pi discovers global, project, and Shared Agent Skills directories.',
  },
  {
    url: 'https://github.com/earendil-works/pi/releases/tag/v0.54.0',
    verifiedVersion: '0.54.0',
    detail: 'Verified release baseline for this adapter.',
  },
  {
    url: 'https://github.com/earendil-works/pi/commit/39cbf47e42433ce301dabcec398cac6fe5f0fa22',
    verifiedVersion: '0.54.0',
    detail: 'Shared Agent Skills discovery and settings matcher semantics.',
  },
] as const satisfies readonly HarnessEvidence[];

function hash(value: string | undefined): string {
  return crypto.createHash('sha256').update(value ?? '').digest('hex');
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function piHome(target: SkillTarget): string {
  return path.dirname(path.dirname(target.discoveryRoot));
}

function settingsFile(pi: SkillTarget): string {
  return path.join(piHome(pi), 'agent', 'settings.json');
}

function stateFile(home: Home): string {
  return path.join(home.configDir, 'state.json');
}

function readSnapshot(file: string, label: string): FileSnapshot {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`${label} path must be a regular file: ${file}`);
    const raw = fs.readFileSync(file, 'utf8');
    return { file, exists: true, raw, hash: hash(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { file, exists: false, hash: hash(undefined) };
    if ((error as Error).message.includes('path must be a regular file')) throw error;
    throw new Error(`cannot read ${label} at ${file}: ${(error as Error).message}`);
  }
}

function parseRecord(snapshot: FileSnapshot, label: string): Record<string, unknown> {
  if (!snapshot.exists) return {};
  try {
    const value: unknown = JSON.parse(snapshot.raw ?? '');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('must be an object');
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`cannot read ${label} at ${snapshot.file}: ${(error as Error).message}`);
  }
}

function validateMatcherEntry(entry: string, file: string): void {
  if (!entry || entry.includes('\0'))
    throw new Error(`Pi settings at ${file} contain an invalid skills entry`);
  const prefix = entry[0];
  if (!['!', '+', '-'].includes(prefix ?? '')) return;
  const pattern = entry.slice(1);
  if (!pattern || /[[\]{}()\\]/.test(pattern))
    throw new Error(`Pi settings at ${file} contain unsupported matcher semantics: ${entry}`);
}

function readSettings(file: string): PiSettings {
  const snapshot = readSnapshot(file, 'Pi settings');
  const value = parseRecord(snapshot, 'Pi settings');
  const skills = value.skills;
  if (skills !== undefined && (!Array.isArray(skills) || skills.some((item) => typeof item !== 'string')))
    throw new Error(`Pi settings at ${file} have unsupported skills configuration`);
  const result = (skills ?? []) as string[];
  for (const entry of result) validateMatcherEntry(entry, file);
  return { ...snapshot, value, skills: result };
}

function resolveMatcherPath(value: string, baseDir: string): string | undefined {
  if (value === '~' || value.startsWith('~/')) return undefined;
  return path.resolve(baseDir, value);
}

function regexEscape(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globMatches(value: string, pattern: string): boolean {
  let expression = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        expression += '.*';
        index++;
      } else expression += '[^/]*';
    } else if (character === '?') expression += '[^/]';
    else expression += regexEscape(character ?? '');
  }
  return new RegExp(`^${expression}$`).test(value);
}

function patternCandidates(filePath: string, baseDir: string): string[] {
  const absolute = toPosix(path.resolve(filePath));
  const relative = toPosix(path.relative(baseDir, filePath));
  const name = path.basename(filePath);
  const isSkillFile = name === 'SKILL.md';
  if (!isSkillFile) return [relative, name, absolute];
  const parent = path.dirname(filePath);
  return [
    relative,
    name,
    absolute,
    toPosix(path.relative(baseDir, parent)),
    path.basename(parent),
    toPosix(path.resolve(parent)),
  ];
}

function matchesPattern(filePath: string, pattern: string, baseDir: string): boolean {
  return patternCandidates(filePath, baseDir).some((candidate) => globMatches(candidate, toPosix(pattern)));
}

function normalizeExactPattern(pattern: string): string {
  return pattern.startsWith('./') || pattern.startsWith('.\\') ? pattern.slice(2) : pattern;
}

function matchesExact(filePath: string, pattern: string, baseDir: string): boolean {
  const normalized = normalizeExactPattern(toPosix(pattern));
  const candidates = patternCandidates(filePath, baseDir);
  return candidates.some((candidate, index) => index !== 1 && candidate === normalized);
}

function enabledByMatcher(filePath: string, skills: string[], baseDir: string): boolean {
  const overrides = skills.filter((entry) => ['!', '+', '-'].includes(entry[0] ?? ''));
  let enabled = !overrides
    .filter((entry) => entry.startsWith('!'))
    .some((entry) => matchesPattern(filePath, entry.slice(1), baseDir));
  if (overrides.filter((entry) => entry.startsWith('+'))
    .some((entry) => matchesExact(filePath, entry.slice(1), baseDir))) enabled = true;
  if (overrides.filter((entry) => entry.startsWith('-'))
    .some((entry) => matchesExact(filePath, entry.slice(1), baseDir))) enabled = false;
  return enabled;
}

function rootSpecificExclusion(entry: string, root: string, baseDir: string): boolean {
  if (!entry.startsWith('!') || !entry.endsWith('/**')) return false;
  const rootPattern = entry.slice(1, -3);
  if (/[*?]/.test(rootPattern)) return false;
  const resolved = resolveMatcherPath(rootPattern, baseDir);
  return resolved !== undefined && path.normalize(resolved) === path.normalize(path.resolve(root));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function inspectMatcher(
  skills: string[],
  settingsPath: string,
  piRoot: string,
  sharedRoot: string,
): MatcherInspection {
  const baseDir = path.dirname(settingsPath);
  const equivalentExclusion = skills.find((entry) => rootSpecificExclusion(entry, sharedRoot, baseDir));
  const forceExcludes = new Set(skills.flatMap((entry) => {
    if (!entry.startsWith('-')) return [];
    const exact = entry.slice(1);
    if (/[*?]/.test(exact)) return [];
    const resolved = resolveMatcherPath(exact, baseDir);
    return resolved === undefined ? [] : [path.normalize(resolved)];
  }));
  const forceInclude = skills.find((entry) => {
    if (!entry.startsWith('+')) return false;
    const exact = entry.slice(1);
    if (/[*?]/.test(exact)) return false;
    const resolved = resolveMatcherPath(exact, baseDir);
    if (resolved === undefined) return false;
    const normalized = path.normalize(resolved);
    return isInside(sharedRoot, normalized) && !forceExcludes.has(normalized);
  });
  const piProbe = path.join(piRoot, '__skillspub_probe__', 'SKILL.md');
  const piTargetConflict = enabledByMatcher(piProbe, skills, baseDir)
    ? undefined
    : skills.find((entry) => entry.startsWith('!') || entry.startsWith('-'));
  return {
    sharedExcluded: Boolean(equivalentExclusion) && !forceInclude,
    equivalentExclusion,
    piTargetConflict,
  };
}

function canonicalExclusion(shared: SkillTarget): string {
  const root = path.resolve(shared.discoveryRoot);
  if (/[*?[\]{}()]/.test(root))
    throw new Error(`Shared root cannot be represented safely in Pi matcher: ${root}`);
  return `!${toPosix(root)}/**`;
}

function resolvePiTarget(targets: SkillTarget[]): SkillTarget {
  return resolveHarnessTarget(targets, 'pi', () => piAdapter.targetDefinition());
}

function resolveSharedTarget(targets: SkillTarget[]): SkillTarget {
  return resolveHarnessTarget(targets, 'shared', () => ({
    key: 'shared',
    kind: 'shared',
    discoveryRoot: path.join(os.homedir(), '.agents', 'skills'),
    parkingRoot: path.join(os.homedir(), '.agents', '.skillspub-off', 'skills'),
    projectPath: '.agents/skills',
  }));
}

function isPiClaim(value: unknown): value is PiIsolationClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return claim.version === 1 && claim.scope === 'global' &&
    ['file', 'sharedRoot', 'exclusion', 'settingsHash']
      .every((field) => typeof claim[field] === 'string');
}

function ownership(value: unknown, file: string, sharedRoot: string, exclusion: string): Ownership {
  if (value === undefined) return { status: 'unowned' };
  if (isPiClaim(value)) {
    return value.file === file && path.resolve(value.sharedRoot) === path.resolve(sharedRoot) &&
      value.exclusion === exclusion
      ? { status: 'owned', claim: value }
      : { status: 'drift', claim: value };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const legacy = value as { file?: unknown; exclusion?: unknown };
    if (legacy.file === file && typeof legacy.exclusion === 'string')
      return { status: 'drift', legacyExclusion: legacy.exclusion };
  }
  throw new Error('Global SkillsPub state has unknown Pi isolation ownership');
}

function inspectOwnership(home: Home, file: string, sharedRoot: string, exclusion: string): Ownership | Error {
  try {
    const value = readStateFile(stateFile(home)).piIsolation;
    return ownership(value, file, sharedRoot, exclusion);
  } catch (error) {
    return error as Error;
  }
}

function isolation(
  ownershipResult: Ownership | Error,
  exclusion: string,
  settings: PiSettings,
  excluded: boolean,
): HarnessInspection['isolation'] {
  if (ownershipResult instanceof Error) return { status: 'unknown', detail: ownershipResult.message };
  if (ownershipResult.status === 'unowned')
    return { status: 'unmanaged', detail: excluded
      ? 'An equivalent safe Shared exclusion is active but is not owned by SkillsPub.'
      : 'Shared exclusion is not managed by SkillsPub.' };
  return ownershipResult.status === 'owned' && excluded && settings.skills.includes(exclusion) &&
    ownershipResult.claim?.settingsHash === settings.hash
    ? { status: 'managed', detail: 'SkillsPub-owned Global Shared exclusion is active.' }
    : { status: 'drift', detail: 'SkillsPub-owned Global Shared exclusion is missing or changed; run explicit reconcile.' };
}

function inspectSharedRoot(
  settingsPath: string,
  piRoot: string,
  sharedRoot: string,
): { excluded: boolean; piTargetConflict?: string; detail?: string; skills: string[] } {
  try {
    const settings = readSettings(settingsPath);
    const matcher = inspectMatcher(settings.skills, settingsPath, piRoot, sharedRoot);
    return { excluded: matcher.sharedExcluded, piTargetConflict: matcher.piTargetConflict, skills: settings.skills };
  } catch (error) {
    return { excluded: false, detail: (error as Error).message, skills: [] };
  }
}

function inspectShared(
  pi: SkillTarget,
  shared: SkillTarget,
  projectPath?: string,
): {
  summary: HarnessInspection['sharedConsumption'];
  roots: HarnessInspection['roots'];
  global: ReturnType<typeof inspectSharedRoot>;
  project?: ReturnType<typeof inspectSharedRoot>;
} {
  const global = inspectSharedRoot(
    settingsFile(pi),
    path.resolve(pi.discoveryRoot),
    path.resolve(shared.discoveryRoot),
  );
  const entries: Array<{
    scope: 'global' | 'project';
    discoveryRoot: string;
    result: ReturnType<typeof inspectSharedRoot>;
  }> = [{ scope: 'global', discoveryRoot: path.resolve(shared.discoveryRoot), result: global }];
  let project: ReturnType<typeof inspectSharedRoot> | undefined;
  if (projectPath) {
    const projectPiRoot = path.join(projectPath, pi.projectPath);
    const projectSharedRoot = path.join(projectPath, shared.projectPath);
    project = inspectSharedRoot(path.join(projectPath, '.pi', 'settings.json'), projectPiRoot, projectSharedRoot);
    entries.push({ scope: 'project', discoveryRoot: projectSharedRoot, result: project });
  }
  const unknown = entries.find(({ result }) => result.detail);
  const excluded = entries.filter(({ result }) => result.excluded);
  let summary: HarnessInspection['sharedConsumption'];
  if (unknown) summary = { status: 'unknown', detail: unknown.result.detail! };
  else if (excluded.length === entries.length) {
    summary = {
      status: 'excluded',
      detail: `Pi Shared skills are excluded: ${entries.map(({ discoveryRoot }) => discoveryRoot).join(', ')}`,
    };
  } else {
    summary = {
      status: 'enabled',
      detail: `Pi discovers Shared skills at ${entries.filter(({ result }) => !result.excluded).map(({ discoveryRoot }) => discoveryRoot).join(', ')}`,
    };
  }
  return {
    summary,
    global,
    project,
    roots: entries.map(({ scope, discoveryRoot, result }) => {
      let consumption: 'unknown' | 'excluded' | 'consumed' = 'consumed';
      if (result.detail) consumption = 'unknown';
      else if (result.excluded) consumption = 'excluded';
      return {
        kind: 'shared',
        targetKey: 'shared',
        scope,
        discoveryRoot,
        consumption,
        reason: result.detail ?? (result.excluded
          ? 'Pi settings exclude this lexical Shared root before canonical dedupe.'
          : 'Pi settings allow this Shared root.'),
      };
    }),
  };
}

function atomicWrite(file: string, raw: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, raw);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function nearestExistingParent(file: string): string {
  let current = path.dirname(file);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function assertWritableFile(file: string, label: string): void {
  try {
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error(`${label} path must be a regular file: ${file}`);
      fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
      fs.accessSync(path.dirname(file), fs.constants.W_OK);
    } else {
      const parent = nearestExistingParent(file);
      if (!fs.statSync(parent).isDirectory()) throw new Error(`${label} parent is not a directory: ${parent}`);
      fs.accessSync(parent, fs.constants.W_OK);
    }
  } catch (error) {
    throw new Error(`cannot safely write ${label} at ${file}: ${(error as Error).message}`);
  }
}

function relationshipGroups(report: InventoryScanReport): HarnessRelationshipGroup[] {
  const effects: HarnessRelationshipEffect[] = report.relationships
    .filter(({ targetId, targetKey }) => targetId === 'global:pi' && targetKey === 'pi')
    .map((relationship): HarnessRelationshipEffect => ({
      scope: 'global',
      targetId: relationship.targetId,
      targetKey: relationship.targetKey,
      resourceId: relationship.resourceId ?? relationship.realPath ?? relationship.target ?? relationship.path,
      name: relationship.name,
      slot: relationship.slot,
      form: relationship.form,
      activation: relationship.activation,
      sourcePath: relationship.realPath ?? relationship.target ?? relationship.path,
      targetPath: relationship.path,
      plannedAction: 'retain',
      sourcePreserved: true,
    }))
    .sort((left, right) => left.targetPath.localeCompare(right.targetPath));
  return effects.length ? [{ scope: 'global', targetId: 'global:pi', targetKey: 'pi', relationships: effects }] : [];
}

function assertSafeRelationships(
  report: InventoryScanReport,
  groups: HarnessRelationshipGroup[],
  settings: PiSettings,
  ignoredEntry?: string,
): void {
  const piSlots = report.slots.filter(({ targetId }) => targetId === 'global:pi');
  const collision = piSlots.find(({ relationships }) => relationships.length > 1);
  if (collision) throw new Error(`Pi Target Slot collision blocks isolation: ${collision.id}`);
  const broken = report.relationships.find(({ targetId, inspectionError }) => targetId === 'global:pi' && inspectionError);
  if (broken) throw new Error(`Pi Relationship cannot be inspected: ${broken.path}`);
  const entries = ignoredEntry ? settings.skills.filter((entry) => entry !== ignoredEntry) : settings.skills;
  const baseDir = path.dirname(settings.file);
  const conflict = groups.flatMap(({ relationships }) => relationships)
    .find(({ targetPath }) => !enabledByMatcher(path.join(targetPath, 'SKILL.md'), entries, baseDir));
  if (conflict) throw new Error(`Pi matcher conflicts with Pi Target Relationship: ${conflict.targetPath}`);
}

function stableGroups(groups: HarnessRelationshipGroup[]): string {
  return JSON.stringify(groups);
}

function concurrentModification(message: string): Error & { code: 'concurrent_modification' } {
  return Object.assign(new Error(message), { code: 'concurrent_modification' as const });
}

function recoveryCommand(label: string, snapshot: FileSnapshot, backup: string, appliedHash: string): string {
  const currentHash = `test "$(shasum -a 256 '${snapshot.file}' | awk '{print $1}')" = "${appliedHash}"`;
  const backupHash = `test "$(shasum -a 256 '${backup}' | awk '{print $1}')" = "${snapshot.hash}"`;
  return snapshot.exists
    ? `Restore ${label}: ${currentHash} && ${backupHash} && cp '${backup}' '${snapshot.file}' && test "$(shasum -a 256 '${snapshot.file}' | awk '{print $1}')" = "${snapshot.hash}"`
    : `Restore absent ${label}: ${currentHash} && ${backupHash} && rm '${snapshot.file}' && test ! -e '${snapshot.file}'`;
}

function recoveryInstructions(plan: Pick<PiSharedIsolationDraft,
  'settings' | 'state' | 'settingsBackupFile' | 'stateBackupFile' | 'manifestFile' |
  'updatedSettingsHash' | 'updatedStateHash'>): string[] {
  return [
    recoveryCommand('Global Pi settings', plan.settings, plan.settingsBackupFile, plan.updatedSettingsHash),
    recoveryCommand('Global SkillsPub state', plan.state, plan.stateBackupFile, plan.updatedStateHash),
    `Hash-check recovery with the affected-path manifest and SHA-256 values: ${plan.manifestFile}`,
    'Start a fresh Pi process to observe next-load visibility; this operation does not reload a running process.',
  ];
}

function relationshipImpact(
  plan: PiSharedIsolationDraft,
): HarnessRelationshipImpact {
  const effects = plan.groups.flatMap(({ relationships }) => relationships);
  const preserved = new Set(effects.map(({ resourceId }) => resourceId));
  const actualIsolation = plan.ownership.status === 'owned'
    ? 'managed'
    : plan.ownership.status === 'drift' ? 'drift' : 'unmanaged';
  const desiredIsolation = plan.managedAfter ? 'managed' : 'unmanaged';
  const instructions = recoveryInstructions(plan);
  return {
    summary: {
      affectedRelationships: effects.length,
      unlinkedRelationships: 0,
      retainedRelationships: effects.length,
      preservedSourceResources: preserved.size,
    },
    actual: {
      relationshipCount: effects.length,
      isolation: actualIsolation,
    },
    desired: { relationshipCount: effects.length, isolation: desiredIsolation },
    drift: { relationships: [], isolation: plan.change || plan.stateChange },
    groups: plan.groups,
    configuration: {
      path: plan.settings.file,
      plannedAction: plan.change ? 'write' : 'retain',
      originalHash: plan.settings.hash,
      backupPath: plan.settingsBackupFile,
    },
    ownershipState: {
      path: plan.state.file,
      status: plan.ownership.status,
      plannedAction: plan.stateChange ? 'write' : 'retain',
      originalHash: plan.state.hash,
      backupPath: plan.stateBackupFile,
    },
    expectedTruth: {
      sharedConsumption: 'excluded',
      targetRelationships: 'retained',
      effectiveVisibility: 'unknown',
    },
    recovery: { manifestPath: plan.manifestFile, instructions },
  };
}

function buildPlan(home: Home, targets: SkillTarget[], operation: HarnessOperation): PiSharedIsolationPlan {
  const piTarget = resolvePiTarget(targets);
  const sharedTarget = resolveSharedTarget(targets);
  const file = settingsFile(piTarget);
  const globalStateFile = stateFile(home);
  const exclusion = canonicalExclusion(sharedTarget);
  const settings = readSettings(file);
  const state = readSnapshot(globalStateFile, 'Global SkillsPub state');
  const stateValue = parseRecord(state, 'Global SkillsPub state');
  let currentOwnership = ownership(stateValue.piIsolation, file, sharedTarget.discoveryRoot, exclusion);
  if (currentOwnership.status === 'drift' && currentOwnership.claim)
    throw new Error('Global SkillsPub Pi ownership conflicts with the resolved Global settings or Shared path');
  if (currentOwnership.legacyExclusion &&
    !['!skills/**', exclusion].includes(currentOwnership.legacyExclusion))
    throw new Error('Global SkillsPub Pi ownership contains an unsupported legacy exclusion');
  const removeLegacy = currentOwnership.legacyExclusion === '!skills/**'
    ? currentOwnership.legacyExclusion
    : undefined;
  const matcherEntries = removeLegacy
    ? settings.skills.filter((entry) => entry !== removeLegacy)
    : settings.skills;
  const matcher = inspectMatcher(matcherEntries, file, piTarget.discoveryRoot, sharedTarget.discoveryRoot);
  if (matcher.piTargetConflict)
    throw new Error(`Pi matcher conflicts with the Global Pi Target: ${matcher.piTargetConflict}`);
  if (matcher.equivalentExclusion && !matcher.sharedExcluded)
    throw new Error('Pi force-include conflicts with Global Shared isolation');
  if (currentOwnership.status === 'owned' &&
    (!settings.skills.includes(exclusion) || currentOwnership.claim?.settingsHash !== settings.hash)) {
    currentOwnership = { ...currentOwnership, status: 'drift' };
  }
  if (operation === 'setup' && currentOwnership.status === 'drift')
    throw new Error('Pi Shared isolation has drift; use explicit reconcile.');
  const releaseClaim = currentOwnership.status !== 'unowned' && matcher.sharedExcluded &&
    !matcherEntries.includes(exclusion) && !removeLegacy;
  const change = Boolean(removeLegacy) || !matcher.sharedExcluded;
  const updatedSkills = matcher.sharedExcluded
    ? matcherEntries
    : [...matcherEntries, exclusion];
  const updatedSettings = change
    ? `${JSON.stringify({ ...settings.value, skills: updatedSkills }, null, 2)}\n`
    : settings.raw ?? '';
  const updatedSettingsHash = hash(updatedSettings);
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const recoveryDir = path.join(home.configDir, 'pi-recovery');
  const settingsBackupFile = path.join(recoveryDir, `${id}.settings.json`);
  const stateBackupFile = path.join(recoveryDir, `${id}.state.json`);
  const manifestFile = path.join(recoveryDir, `${id}.paths.json`);
  const claimValue: PiIsolationClaim = {
    version: 1,
    scope: 'global',
    file,
    sharedRoot: path.resolve(sharedTarget.discoveryRoot),
    exclusion,
    settingsHash: updatedSettingsHash,
  };
  const managedAfter = !releaseClaim && (currentOwnership.status !== 'unowned' || !matcher.sharedExcluded);
  const claim = managedAfter && (currentOwnership.status !== 'owned' || change ||
    currentOwnership.claim?.settingsHash !== updatedSettingsHash);
  const stateChange = claim || releaseClaim;
  const nextState = { ...stateValue };
  if (releaseClaim) delete nextState.piIsolation;
  else if (claim) nextState.piIsolation = claimValue;
  const updatedState = `${JSON.stringify(nextState, null, 2)}\n`;
  const updatedStateHash = hash(updatedState);
  const report = scanGlobalInventory(home, targets, { persist: false });
  const groups = relationshipGroups(report);
  assertSafeRelationships(report, groups, settings, removeLegacy);
  const draft: PiSharedIsolationDraft = {
    settings,
    state,
    piRoot: path.resolve(piTarget.discoveryRoot),
    sharedRoot: path.resolve(sharedTarget.discoveryRoot),
    exclusion,
    ownership: currentOwnership,
    change,
    claim,
    stateChange,
    managedAfter,
    updatedSettings,
    updatedSettingsHash,
    updatedState,
    updatedStateHash,
    settingsBackupFile,
    stateBackupFile,
    manifestFile,
    groups,
  };
  return { ...draft, relationshipImpact: relationshipImpact(draft) };
}

function preflightApply(home: Home, targets: SkillTarget[], plan: PiSharedIsolationPlan): void {
  const currentSettings = readSettings(plan.settings.file);
  if (currentSettings.exists !== plan.settings.exists || currentSettings.hash !== plan.settings.hash ||
    currentSettings.raw !== plan.settings.raw)
    throw concurrentModification(`Pi settings changed after preview: ${plan.settings.file}`);
  const currentState = readSnapshot(plan.state.file, 'Global SkillsPub state');
  if (currentState.exists !== plan.state.exists || currentState.hash !== plan.state.hash || currentState.raw !== plan.state.raw)
    throw concurrentModification(`Global SkillsPub state changed after preview: ${plan.state.file}`);
  parseRecord(currentState, 'Global SkillsPub state');
  const matcher = inspectMatcher(currentSettings.skills, currentSettings.file, plan.piRoot, plan.sharedRoot);
  const ignored = plan.ownership.legacyExclusion === '!skills/**' ? plan.ownership.legacyExclusion : undefined;
  if (matcher.piTargetConflict && !ignored)
    throw concurrentModification(`Pi matcher now conflicts with the Global Pi Target: ${matcher.piTargetConflict}`);
  const report = scanGlobalInventory(home, targets, { persist: false });
  const groups = relationshipGroups(report);
  try {
    assertSafeRelationships(report, groups, currentSettings, ignored);
  } catch (error) {
    throw concurrentModification((error as Error).message);
  }
  if (stableGroups(groups) !== stableGroups(plan.groups))
    throw concurrentModification('Pi Relationships changed after preview');
  if (plan.change || plan.stateChange) {
    assertWritableFile(plan.settings.file, 'Global Pi settings');
    assertWritableFile(plan.state.file, 'Global SkillsPub state');
    assertWritableFile(plan.manifestFile, 'Pi recovery manifest');
  }
}

function writeRecovery(plan: PiSharedIsolationPlan): void {
  fs.mkdirSync(path.dirname(plan.manifestFile), { recursive: true });
  fs.writeFileSync(plan.settingsBackupFile, plan.settings.raw ?? '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(plan.stateBackupFile, plan.state.raw ?? '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(plan.manifestFile, `${JSON.stringify({
    version: 1,
    scope: 'global',
    settings: {
      path: plan.settings.file,
      existed: plan.settings.exists,
      originalHash: plan.settings.hash,
      expectedAppliedHash: plan.updatedSettingsHash,
      backupPath: plan.settingsBackupFile,
      backupHash: plan.settings.hash,
    },
    state: {
      path: plan.state.file,
      existed: plan.state.exists,
      originalHash: plan.state.hash,
      expectedAppliedHash: plan.updatedStateHash,
      backupPath: plan.stateBackupFile,
      backupHash: plan.state.hash,
    },
    resolvedRoots: { pi: plan.piRoot, shared: plan.sharedRoot },
    exactExclusion: plan.exclusion,
    relationships: plan.groups,
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function applyPlan(home: Home, targets: SkillTarget[], plan: PiSharedIsolationPlan): void {
  preflightApply(home, targets, plan);
  if (!plan.change && !plan.stateChange) return;
  writeRecovery(plan);
  let mutationStarted = false;
  try {
    if (plan.stateChange) {
      atomicWrite(plan.state.file, plan.updatedState);
      mutationStarted = true;
    }
    if (plan.change) {
      atomicWrite(plan.settings.file, plan.updatedSettings);
      mutationStarted = true;
    }
    const verified = readSettings(plan.settings.file);
    const matcher = inspectMatcher(verified.skills, verified.file, plan.piRoot, plan.sharedRoot);
    if (!matcher.sharedExcluded || matcher.piTargetConflict)
      throw new Error(`Pi isolation was written but semantic verification failed: ${plan.settings.file}`);
    const report = scanGlobalInventory(home, targets, { persist: false });
    const groups = relationshipGroups(report);
    if (stableGroups(groups) !== stableGroups(plan.groups))
      throw new Error('Pi isolation was written but Relationships changed during verification');
    const currentState = readSnapshot(plan.state.file, 'Global SkillsPub state');
    if (currentState.hash !== plan.updatedStateHash || currentState.raw !== plan.updatedState)
      throw concurrentModification(`Global SkillsPub state changed during apply: ${plan.state.file}`);
  } catch (error) {
    if (mutationStarted && error && typeof error === 'object')
      Object.assign(error, { partialEffects: 'present' as const });
    throw error;
  }
}

function renderRelationshipImpact(plan: PiSharedIsolationPlan): string[] {
  const impact = plan.relationshipImpact;
  return [
    'scope\tGlobal only; exact-Project Pi settings and state are not read or changed',
    `resolved Pi root\t${plan.piRoot}`,
    `resolved Shared root\t${plan.sharedRoot}`,
    `exact exclusion\t${plan.exclusion}`,
    `settings SHA-256\t${plan.settings.hash}`,
    `Global ownership state SHA-256\t${plan.state.hash}`,
    `ownership\t${plan.ownership.status}`,
    `expected truth\tShared excluded; ${impact.summary.retainedRelationships} Pi Target Relationships retained on next load`,
    `Actual\t${impact.actual.relationshipCount} Relationships; isolation ${impact.actual.isolation}`,
    `Desired\t${impact.desired.relationshipCount} Relationships; isolation ${impact.desired.isolation}`,
    `Drift\t${impact.drift.relationships.length} Relationship actions; isolation ${impact.drift.isolation ? 'yes' : 'no'}`,
    `settings backup\t${plan.settingsBackupFile}`,
    `state backup\t${plan.stateBackupFile}`,
    `affected-path manifest\t${plan.manifestFile}`,
    ...impact.groups.flatMap((group) => [
      `scope ${group.scope}\tSkill Target ${group.targetKey} (${group.targetId})`,
      ...group.relationships.map((effect) =>
        `Retain\tresource=${effect.resourceId}\tname=${effect.name}\tform=${effect.form}\t` +
        `Activation=${effect.activation}\tsource=${effect.sourcePath}\ttarget=${effect.targetPath}\taction=retain`),
    ]),
    'Effective Visibility\tunknown until resource-specific explain; no running process reload is claimed',
  ];
}

function operationResult(
  home: Home,
  targets: SkillTarget[],
  plan: PiSharedIsolationPlan,
  inspection: HarnessInspection,
): HarnessOperationResult {
  const groups = relationshipGroups(scanGlobalInventory(home, targets, { persist: false }));
  const present = new Set(groups.flatMap(({ relationships }) => relationships)
    .map(({ targetId, targetPath }) => `${targetId}\0${targetPath}`));
  const effects = plan.groups.flatMap(({ relationships }) => relationships);
  const relationshipEffects = effects.map((effect) => ({
    ...effect,
    outcome: present.has(`${effect.targetId}\0${effect.targetPath}`) ? 'retained' as const : 'drift' as const,
  }));
  const sources = new Set(effects.map(({ sourcePath }) => sourcePath));
  const actual = {
    unlinkedRelationships: 0,
    retainedRelationships: relationshipEffects.filter(({ outcome }) => outcome === 'retained').length,
    preservedSourceResources: [...sources].filter((sourcePath) => fs.existsSync(sourcePath)).length,
  };
  const desired = {
    unlinkedRelationships: 0,
    retainedRelationships: effects.length,
    preservedSourceResources: sources.size,
  };
  const driftRelationships = relationshipEffects
    .filter(({ outcome }) => outcome === 'drift')
    .map(({ outcome: _outcome, ...effect }) => effect);
  const visibility: NonNullable<HarnessOperationResult['effectiveVisibility']> = driftRelationships.length
    ? { status: 'conflicted', detail: 'A planned Pi Target Relationship is missing after apply.' }
    : {
      status: 'unknown',
      detail: 'Use resource-specific explain for Effective Visibility; running Pi processes were not reloaded.',
    };
  return {
    inspection,
    actual,
    desired,
    drift: {
      relationships: driftRelationships,
      isolation: inspection.sharedConsumption.status !== 'excluded',
    },
    isolation: inspection.isolation,
    relationshipEffects,
    recovery: {
      ...plan.relationshipImpact.recovery,
      configBackupPreserved: !plan.change || fs.existsSync(plan.settingsBackupFile),
      stateBackupPreserved: !plan.stateChange || fs.existsSync(plan.stateBackupFile),
      manifestPreserved: (!plan.change && !plan.stateChange) || fs.existsSync(plan.manifestFile),
    },
    sharedConsumption: inspection.sharedConsumption,
    effectiveVisibility: visibility,
  };
}

function planOperation(
  home: Home,
  targets: SkillTarget[],
  operation: HarnessOperation,
  _projectPath?: string,
): HarnessOperationPlan {
  const plan = buildPlan(home, targets, operation);
  return {
    title: 'Pi Global isolation plan:',
    lines: [
      `${plan.change ? 'write' : 'retain'}\t${plan.settings.file}`,
      `${plan.change ? 'add exclusion (root-specific)' : 'already satisfied'}\tstop consuming Shared without suppressing Pi Targets`,
      ...renderRelationshipImpact(plan),
    ],
    recovery: plan.relationshipImpact.recovery.instructions,
    relationshipImpact: plan.relationshipImpact,
    apply: () => applyPlan(home, targets, plan),
    verify() {
      const inspection = piAdapter.inspect(home, targets);
      const globalShared = inspection.roots.find(({ kind, scope }) => kind === 'shared' && scope === 'global');
      const globalPi = inspection.roots.find(({ kind, scope }) => kind === 'harness' && scope === 'global');
      if (globalShared?.consumption !== 'excluded' || globalPi?.consumption !== 'consumed')
        throw new Error(`Pi Global isolation verification failed: ${inspection.sharedConsumption.detail}`);
      return inspection;
    },
    result: (inspection) => operationResult(home, targets, plan, inspection),
  };
}

export const piAdapter: HarnessAdapter = {
  key: 'pi',
  name: 'Pi',
  targetDefinition() {
    const home = os.homedir();
    return {
      key: 'pi',
      kind: 'harness',
      discoveryRoot: path.join(home, '.pi', 'agent', 'skills'),
      parkingRoot: path.join(home, '.pi', 'agent', '.skillspub-off', 'skills'),
      projectPath: '.pi/skills',
      relationship: { support: 'discoverable', link: 'supported' },
    };
  },
  inspect(home, targets, projectPath) {
    const piTarget = resolvePiTarget(targets);
    const sharedTarget = resolveSharedTarget(targets);
    const projectRoot = projectPath ? path.resolve(projectPath) : undefined;
    const file = settingsFile(piTarget);
    const exclusion = canonicalExclusion(sharedTarget);
    const shared = inspectShared(piTarget, sharedTarget, projectRoot);
    const settings = (() => {
      try {
        return readSettings(file);
      } catch {
        return { file, exists: fs.existsSync(file), hash: '', value: {}, skills: [] } as PiSettings;
      }
    })();
    const ownershipResult = inspectOwnership(home, file, sharedTarget.discoveryRoot, exclusion);
    const configurationKnown = !shared.global.detail;
    const globalPiKnown = configurationKnown && !shared.global.piTargetConflict;
    const projectPiKnown = shared.project && !shared.project.detail && !shared.project.piTargetConflict;
    const detected = fs.existsSync(piTarget.discoveryRoot) || fs.existsSync(file) ||
      fs.existsSync(piHome(piTarget)) || Boolean(projectRoot && fs.existsSync(path.join(projectRoot, '.pi')));
    return {
      key: 'pi',
      name: 'Pi',
      detected,
      support: 'discoverable',
      evidence: EVIDENCE,
      targets: [
        { scope: 'global', discoveryRoot: path.resolve(piTarget.discoveryRoot) },
        ...(projectRoot ? [{ scope: 'project' as const, discoveryRoot: path.join(projectRoot, piTarget.projectPath) }] : []),
      ],
      roots: [
        {
          kind: 'harness',
          targetKey: 'pi',
          scope: 'global',
          discoveryRoot: path.resolve(piTarget.discoveryRoot),
          consumption: globalPiKnown ? 'consumed' : 'unknown',
          reason: shared.global.detail ?? (shared.global.piTargetConflict
            ? `Pi matcher may suppress its Global Target: ${shared.global.piTargetConflict}`
            : 'Pi discovers its Global Skill Target independently before canonical dedupe.'),
        },
        ...(projectRoot ? [{
          kind: 'harness' as const,
          targetKey: 'pi',
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, piTarget.projectPath),
          consumption: projectPiKnown ? 'consumed' as const : 'unknown' as const,
          reason: shared.project?.detail ?? (shared.project?.piTargetConflict
            ? `Pi matcher may suppress its exact Project Target: ${shared.project.piTargetConflict}`
            : 'Pi discovers the exact Project Skill Target; Global operation does not mutate it.'),
        }] : []),
        ...shared.roots,
      ],
      sharedConsumption: shared.summary,
      isolation: isolation(ownershipResult, exclusion, settings, shared.global.excluded),
      link: { supported: true },
    };
  },
  operations: {
    setup: (home, targets, projectPath) => planOperation(home, targets, 'setup', projectPath),
    reconcile: (home, targets, projectPath) => planOperation(home, targets, 'reconcile', projectPath),
  },
};
