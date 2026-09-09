import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Home } from '../core.ts';
import {
  hashDirectory,
  normalizeSlotName,
  readStateFile,
  scanGlobalInventory,
  scanProjectInventory,
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
  scope: 'global' | 'project';
  file: string;
  sharedRoot?: string;
  exclusion?: string;
  sharedRoots?: string[];
  exclusions?: string[];
  projectPath?: string;
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
    url: 'https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/skills.md',
    verifiedVersion: '0.85.1',
    detail: 'Pi discovers global, project, and Shared Agent Skills directories.',
  },
  {
    url: 'https://github.com/earendil-works/pi/releases/tag/v0.85.1',
    verifiedVersion: '0.85.1',
    detail: 'Real-machine release baseline accepted by SkillsPub issue #127.',
  },
  {
    url: 'https://github.com/earendil-works/pi/commit/d981de1229ef899957bbe968bc8dcda02a21f477',
    verifiedVersion: '0.85.1',
    detail: 'Release source revalidated with root-specific Shared exclusions.',
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

function lexicalSkillFiles(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name, 'SKILL.md'))
      .filter((file) => fs.existsSync(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function projectCollision(
  settings: PiSettings,
  piRoot: string,
  sharedRoots: string[],
): string | undefined {
  const baseDir = path.dirname(settings.file);
  const bySlot = new Map<string, { lexicalPath: string; realPath: string }>();
  const canonical = new Set<string>();
  for (const root of [piRoot, ...sharedRoots]) {
    for (const file of lexicalSkillFiles(root)) {
      if (!enabledByMatcher(file, settings.skills, baseDir)) continue;
      const realPath = fs.realpathSync(file);
      if (canonical.has(realPath)) continue;
      canonical.add(realPath);
      const slot = normalizeSlotName(path.basename(path.dirname(file)));
      const previous = bySlot.get(slot);
      if (previous && previous.realPath !== realPath)
        return `Pi Skill collision for ${slot}: ${previous.lexicalPath} conflicts with ${file}`;
      bySlot.set(slot, { lexicalPath: file, realPath });
    }
  }
  return undefined;
}

function inspectMatcher(
  skills: string[],
  settingsPath: string,
  piRoot: string,
  sharedRoot: string,
): MatcherInspection {
  const baseDir = path.dirname(settingsPath);
  const equivalentExclusion = skills.find((entry) => rootSpecificExclusion(entry, sharedRoot, baseDir));
  const forceIncludes = skills.filter((entry) => entry.startsWith('+')).map((entry) => entry.slice(1));
  const forceExcludes = skills.filter((entry) => entry.startsWith('-')).map((entry) => entry.slice(1));
  const sharedFiles = lexicalSkillFiles(sharedRoot);
  const forceInclude = forceIncludes.find((exact) => {
    if (/[*?]/.test(exact)) return false;
    const resolved = resolveMatcherPath(exact, baseDir);
    const targetsSharedRoot = resolved !== undefined && isInside(sharedRoot, resolved);
    const includedFile = sharedFiles.find((file) => matchesExact(file, exact, baseDir));
    if (!targetsSharedRoot && !includedFile) return false;
    const probe = includedFile ?? path.join(resolved!, 'SKILL.md');
    return !forceExcludes.some((entry) => matchesExact(probe, entry, baseDir));
  });
  const piProbe = path.join(piRoot, '__skillspub_probe__', 'SKILL.md');
  const sharedProbe = path.join(sharedRoot, '__skillspub_probe__', 'SKILL.md');
  const piTargetConflict = enabledByMatcher(piProbe, skills, baseDir)
    ? undefined
    : skills.find((entry) => entry.startsWith('!') || entry.startsWith('-'));
  return {
    sharedExcluded: (Boolean(equivalentExclusion) || !enabledByMatcher(sharedProbe, skills, baseDir)) && !forceInclude,
    equivalentExclusion,
    piTargetConflict,
  };
}

function canonicalExclusionRoot(value: string): string {
  const root = path.resolve(value);
  if (/[*?[\]{}()]/.test(root))
    throw new Error(`Shared root cannot be represented safely in Pi matcher: ${root}`);
  return `!${toPosix(root)}/**`;
}

function canonicalExclusion(shared: SkillTarget): string {
  return canonicalExclusionRoot(shared.discoveryRoot);
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

function canonicalProjectPath(selectedPath: string): string {
  const project = fs.realpathSync(selectedPath);
  if (!fs.statSync(project).isDirectory()) throw new Error(`Project path is not a directory: ${selectedPath}`);
  return project;
}

function projectBoundary(project: string): string {
  for (let current = project;; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
  }
}

function projectSharedRoots(project: string, globalSharedRoot: string): string[] {
  const boundary = projectBoundary(project);
  const globalRoot = path.normalize(path.resolve(globalSharedRoot));
  const roots: string[] = [];
  for (let current = project;; current = path.dirname(current)) {
    const candidate = path.join(current, '.agents', 'skills');
    if (path.normalize(path.resolve(candidate)) !== globalRoot) roots.push(candidate);
    if (current === boundary) return roots;
  }
}

function readProjectTrust(pi: SkillTarget, project: string): { trusted?: boolean; detail: string } {
  const trustPath = path.join(piHome(pi), 'agent', 'trust.json');
  try {
    const trust = parseRecord(readSnapshot(trustPath, 'Pi trust store'), 'Pi trust store');
    for (let current = project;; current = path.dirname(current)) {
      const decision = trust[current];
      if (decision === true || decision === false)
        return { trusted: decision, detail: `Pi trust decision ${decision ? 'trusts' : 'does not trust'} ${current}.` };
      if (decision !== undefined && decision !== null)
        throw new Error(`value for ${current} must be true, false, or null`);
      const parent = path.dirname(current);
      if (parent === current) break;
    }
    const global = readSettings(settingsFile(pi)).value.defaultProjectTrust;
    if (global !== undefined && !['ask', 'always', 'never'].includes(String(global)))
      throw new Error('defaultProjectTrust must be ask, always, or never');
    if (global === 'always') return { trusted: true, detail: 'Global defaultProjectTrust always trusts this Project.' };
    if (global === 'never') return { trusted: false, detail: 'Global defaultProjectTrust never trusts this Project.' };
    return { detail: 'Project trust is unresolved (defaultProjectTrust is ask).' };
  } catch (error) {
    return { detail: `Project trust cannot be confirmed: ${(error as Error).message}` };
  }
}

function isPiClaim(value: unknown): value is PiIsolationClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  if (claim.version !== 1 || typeof claim.file !== 'string' || typeof claim.settingsHash !== 'string') return false;
  if (claim.scope === 'global') return typeof claim.sharedRoot === 'string' && typeof claim.exclusion === 'string';
  return claim.scope === 'project' && typeof claim.projectPath === 'string' &&
    Array.isArray(claim.sharedRoots) && claim.sharedRoots.every((item) => typeof item === 'string') &&
    Array.isArray(claim.exclusions) && claim.exclusions.every((item) => typeof item === 'string');
}

function ownership(value: unknown, file: string, sharedRoot: string, exclusion: string): Ownership {
  if (value === undefined) return { status: 'unowned' };
  if (isPiClaim(value)) {
    return value.scope === 'global' && value.file === file &&
      path.resolve(value.sharedRoot!) === path.resolve(sharedRoot) && value.exclusion === exclusion
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

function inspectProjectIsolation(
  pi: SkillTarget,
  shared: SkillTarget,
  project: string,
): HarnessInspection['isolation'] {
  if (pi.projectPath !== '.pi/skills')
    return { status: 'drift', detail: 'Stale Pi Project Target override requires a separate migration to canonical .pi/skills.' };
  const trust = readProjectTrust(pi, project);
  if (trust.trusted !== true) return { status: 'unknown', detail: trust.detail };
  try {
    const settings = readSettings(path.join(project, '.pi', 'settings.json'));
    const roots = projectSharedRoots(project, shared.discoveryRoot);
    const exclusions = roots.map(canonicalExclusionRoot);
    const state = readStateFile(path.join(project, '.skillspub', 'state.json'));
    const owned = projectOwnership(state.piIsolation, settings.file, project, roots, exclusions);
    const piRoot = path.join(project, '.pi', 'skills');
    const excluded = roots.every((root) => inspectMatcher(settings.skills, settings.file, piRoot, root).sharedExcluded);
    const collision = projectCollision(settings, piRoot, roots);
    if (collision) return { status: 'unknown', detail: collision };
    if (owned.status === 'unowned') return { status: 'unmanaged', detail: excluded
      ? 'Equivalent safe Project Shared exclusions are active but not owned by SkillsPub.'
      : 'Project Shared exclusions are not managed by SkillsPub.' };
    return owned.status === 'owned' && excluded && owned.claim?.settingsHash === settings.hash
      ? { status: 'managed', detail: 'SkillsPub-owned exact-Project Shared exclusions are active.' }
      : { status: 'drift', detail: 'SkillsPub-owned exact-Project Shared exclusions are missing or changed; run explicit reconcile.' };
  } catch (error) {
    return { status: 'unknown', detail: (error as Error).message };
  }
}

function rootConsumption(result: ReturnType<typeof inspectSharedRoot>): 'unknown' | 'excluded' | 'consumed' {
  if (result.detail) return 'unknown';
  return result.excluded ? 'excluded' : 'consumed';
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
  project: ReturnType<typeof inspectSharedRoot>[];
  trust?: ReturnType<typeof readProjectTrust>;
} {
  const global = inspectSharedRoot(settingsFile(pi), path.resolve(pi.discoveryRoot), path.resolve(shared.discoveryRoot));
  const entries: Array<{
    scope: 'global' | 'project' | 'parent';
    discoveryRoot: string;
    result: ReturnType<typeof inspectSharedRoot>;
    trustDetail?: string;
  }> = [{ scope: 'global', discoveryRoot: path.resolve(shared.discoveryRoot), result: global }];
  const projectResults: ReturnType<typeof inspectSharedRoot>[] = [];
  let trust: ReturnType<typeof readProjectTrust> | undefined;
  if (projectPath) {
    trust = readProjectTrust(pi, projectPath);
    const roots = projectSharedRoots(projectPath, shared.discoveryRoot);
    for (const [index, discoveryRoot] of roots.entries()) {
      const result = trust.trusted === true
        ? inspectSharedRoot(path.join(projectPath, '.pi', 'settings.json'), path.join(projectPath, '.pi', 'skills'), discoveryRoot)
        : { excluded: false, detail: trust.detail, skills: [] };
      projectResults.push(result);
      entries.push({ scope: index === 0 ? 'project' : 'parent', discoveryRoot, result, trustDetail: trust.detail });
    }
  }
  const unknown = entries.find(({ result }) => result.detail);
  const excluded = entries.filter(({ result }) => result.excluded);
  let summary: HarnessInspection['sharedConsumption'];
  if (unknown) summary = { status: 'unknown', detail: unknown.result.detail! };
  else if (excluded.length === entries.length) {
    summary = { status: 'excluded', detail: `Pi Shared skills are excluded: ${entries.map(({ discoveryRoot }) => discoveryRoot).join(', ')}` };
  } else {
    summary = { status: 'enabled', detail: `Pi discovers Shared skills at ${entries.filter(({ result }) => !result.excluded).map(({ discoveryRoot }) => discoveryRoot).join(', ')}` };
  }
  return {
    summary,
    global,
    project: projectResults,
    trust,
    roots: entries.map(({ scope, discoveryRoot, result, trustDetail }) => ({
      kind: 'shared',
      targetKey: 'shared',
      scope,
      discoveryRoot,
      consumption: rootConsumption(result),
      reason: result.detail ?? (result.excluded
        ? 'Pi settings exclude this lexical Shared root before canonical dedupe.'
        : `Pi settings allow this Shared root. ${trustDetail ?? ''}`.trim()),
    })),
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
  let actualIsolation: 'managed' | 'drift' | 'unmanaged' = 'unmanaged';
  if (plan.ownership.status === 'owned') actualIsolation = 'managed';
  else if (plan.ownership.status === 'drift') actualIsolation = 'drift';
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

interface ProjectIsolationPlan {
  project: string;
  settings: PiSettings;
  state: FileSnapshot;
  piRoot: string;
  sharedRoots: string[];
  exclusions: string[];
  ownership: Ownership;
  change: boolean;
  stateChange: boolean;
  updatedSettings: string;
  updatedSettingsHash: string;
  updatedState: string;
  updatedStateHash: string;
  settingsBackupFile: string;
  stateBackupFile: string;
  manifestFile: string;
  groups: HarnessRelationshipGroup[];
  relationshipImpact: HarnessRelationshipImpact;
}

function projectRelationshipGroups(report: InventoryScanReport, project: string): HarnessRelationshipGroup[] {
  const targetId = `project:${project}:pi`;
  const relationships = report.relationships.filter((entry) => entry.targetId === targetId).map((entry): HarnessRelationshipEffect => ({
    scope: 'project', targetId, targetKey: 'pi',
    resourceId: entry.resourceId ?? entry.realPath ?? entry.target ?? entry.path,
    name: entry.name, slot: entry.slot, form: entry.form, activation: entry.activation,
    sourcePath: entry.realPath ?? entry.target ?? entry.path, targetPath: entry.path,
    plannedAction: 'retain', sourcePreserved: true,
  })).sort((left, right) => left.targetPath.localeCompare(right.targetPath));
  return relationships.length ? [{ scope: 'project', targetId, targetKey: 'pi', relationships }] : [];
}

function projectOwnership(value: unknown, file: string, project: string, roots: string[], exclusions: string[]): Ownership {
  if (value === undefined) return { status: 'unowned' };
  if (!isPiClaim(value)) throw new Error('Project SkillsPub state has unknown Pi isolation ownership');
  const exact = value.scope === 'project' && value.file === file && value.projectPath === project &&
    JSON.stringify(value.sharedRoots?.map((root) => path.resolve(root))) === JSON.stringify(roots.map((root) => path.resolve(root))) &&
    JSON.stringify(value.exclusions) === JSON.stringify(exclusions);
  return exact ? { status: 'owned', claim: value } : { status: 'drift', claim: value };
}

function buildProjectPlan(home: Home, targets: SkillTarget[], operation: HarnessOperation, selectedPath: string): ProjectIsolationPlan {
  const project = canonicalProjectPath(selectedPath);
  const pi = resolvePiTarget(targets);
  if (pi.projectPath !== '.pi/skills')
    throw new Error('Stale Pi Project Target override blocks isolation; approve the separate Pi migrate operation first.');
  const trust = readProjectTrust(pi, project);
  if (trust.trusted !== true) throw new Error(`Pi Project isolation requires confirmed trust: ${trust.detail}`);
  const settings = readSettings(path.join(project, '.pi', 'settings.json'));
  const state = readSnapshot(path.join(project, '.skillspub', 'state.json'), 'Project SkillsPub state');
  const stateValue = parseRecord(state, 'Project SkillsPub state');
  const piRoot = path.join(project, '.pi', 'skills');
  const sharedRoots = projectSharedRoots(project, resolveSharedTarget(targets).discoveryRoot);
  const exclusions = sharedRoots.map(canonicalExclusionRoot);
  let currentOwnership = projectOwnership(stateValue.piIsolation, settings.file, project, sharedRoots, exclusions);
  const inspections = sharedRoots.map((root) => inspectMatcher(settings.skills, settings.file, piRoot, root));
  const canonicalConflict = projectCollision(settings, piRoot, sharedRoots);
  if (canonicalConflict) throw new Error(`${canonicalConflict}; isolation is blocked until the competing Variant is resolved.`);
  const conflict = inspections.find(({ piTargetConflict }) => piTargetConflict)?.piTargetConflict;
  if (conflict) throw new Error(`Pi matcher conflicts with the Project Pi Target: ${conflict}`);
  if (inspections.some(({ equivalentExclusion, sharedExcluded }) => equivalentExclusion && !sharedExcluded))
    throw new Error('Pi force-include conflicts with Project Shared isolation');
  if (currentOwnership.status === 'owned' && (currentOwnership.claim?.settingsHash !== settings.hash ||
    exclusions.some((entry) => !settings.skills.includes(entry)))) currentOwnership = { ...currentOwnership, status: 'drift' };
  if (operation === 'setup' && currentOwnership.status === 'drift')
    throw new Error('Pi Project isolation has drift; use explicit reconcile.');
  const missing = exclusions.filter((_entry, index) => !inspections[index]?.sharedExcluded);
  const change = missing.length > 0;
  const updatedSettings = change
    ? `${JSON.stringify({ ...settings.value, skills: [...settings.skills, ...missing] }, null, 2)}\n`
    : settings.raw ?? '';
  const updatedSettingsHash = hash(updatedSettings);
  const equivalentUnowned = currentOwnership.status === 'unowned' && !change;
  const stateChange = !equivalentUnowned && (currentOwnership.status !== 'owned' || currentOwnership.claim?.settingsHash !== updatedSettingsHash);
  const nextState = { ...stateValue };
  if (equivalentUnowned) delete nextState.piIsolation;
  else nextState.piIsolation = {
    version: 1, scope: 'project', file: settings.file, projectPath: project,
    sharedRoots, exclusions, settingsHash: updatedSettingsHash,
  } satisfies PiIsolationClaim;
  const updatedState = `${JSON.stringify(nextState, null, 2)}\n`;
  const updatedStateHash = hash(updatedState);
  const report = scanProjectInventory(home, project, targets, { persist: false });
  const groups = projectRelationshipGroups(report, project);
  const targetId = `project:${project}:pi`;
  const collision = report.slots.find((slot) => slot.targetId === targetId && slot.relationships.length > 1);
  if (collision) throw new Error(`Pi Target Slot collision blocks isolation: ${collision.id}`);
  const broken = report.relationships.find((entry) => entry.targetId === targetId && entry.inspectionError);
  if (broken) throw new Error(`Pi Relationship cannot be inspected: ${broken.path}`);
  const matcherConflict = groups.flatMap((group) => group.relationships)
    .find((entry) => !enabledByMatcher(path.join(entry.targetPath, 'SKILL.md'), settings.skills, path.dirname(settings.file)));
  if (matcherConflict) throw new Error(`Pi matcher conflicts with Pi Target Relationship: ${matcherConflict.targetPath}`);
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const recoveryDir = path.join(project, '.skillspub', 'pi-recovery');
  const settingsBackupFile = path.join(recoveryDir, `${id}.settings.json`);
  const stateBackupFile = path.join(recoveryDir, `${id}.state.json`);
  const manifestFile = path.join(recoveryDir, `${id}.paths.json`);
  const effects = groups.flatMap((group) => group.relationships);
  const recovery = [
    recoveryCommand('Project Pi settings', settings, settingsBackupFile, updatedSettingsHash),
    recoveryCommand('Project SkillsPub state', state, stateBackupFile, updatedStateHash),
    `Hash-check recovery with the affected-path manifest and SHA-256 values: ${manifestFile}`,
  ];
  let actualIsolation: 'managed' | 'drift' | 'unmanaged' = 'unmanaged';
  if (currentOwnership.status === 'owned') actualIsolation = 'managed';
  else if (currentOwnership.status === 'drift') actualIsolation = 'drift';
  const relationshipImpact: HarnessRelationshipImpact = {
    summary: { affectedRelationships: effects.length, unlinkedRelationships: 0, retainedRelationships: effects.length, preservedSourceResources: new Set(effects.map((entry) => entry.resourceId)).size },
    actual: { relationshipCount: effects.length, isolation: actualIsolation },
    desired: { relationshipCount: effects.length, isolation: equivalentUnowned ? 'unmanaged' : 'managed' },
    drift: { relationships: [], isolation: change || stateChange }, groups,
    configuration: { path: settings.file, plannedAction: change ? 'write' : 'retain', originalHash: settings.hash, backupPath: settingsBackupFile },
    ownershipState: { path: state.file, status: currentOwnership.status, plannedAction: stateChange ? 'write' : 'retain', originalHash: state.hash, backupPath: stateBackupFile },
    expectedTruth: { sharedConsumption: 'excluded', targetRelationships: 'retained', effectiveVisibility: 'unknown' },
    recovery: { manifestPath: manifestFile, instructions: recovery },
  };
  return { project, settings, state, piRoot, sharedRoots, exclusions, ownership: currentOwnership,
    change, stateChange, updatedSettings, updatedSettingsHash, updatedState, updatedStateHash,
    settingsBackupFile, stateBackupFile, manifestFile, groups, relationshipImpact };
}

function applyProjectPlan(home: Home, targets: SkillTarget[], plan: ProjectIsolationPlan): void {
  const trust = readProjectTrust(resolvePiTarget(targets), plan.project);
  if (trust.trusted !== true) throw concurrentModification(`Pi Project trust changed after preview: ${trust.detail}`);
  const currentRoots = projectSharedRoots(plan.project, resolveSharedTarget(targets).discoveryRoot);
  if (JSON.stringify(currentRoots) !== JSON.stringify(plan.sharedRoots))
    throw concurrentModification('Pi Project Git/filesystem boundary changed after preview');
  const settings = readSettings(plan.settings.file);
  const state = readSnapshot(plan.state.file, 'Project SkillsPub state');
  if (settings.hash !== plan.settings.hash || settings.raw !== plan.settings.raw)
    throw concurrentModification(`Pi settings changed after preview: ${plan.settings.file}`);
  if (state.hash !== plan.state.hash || state.raw !== plan.state.raw)
    throw concurrentModification(`Project SkillsPub state changed after preview: ${plan.state.file}`);
  const groups = projectRelationshipGroups(scanProjectInventory(home, plan.project, targets, { persist: false }), plan.project);
  if (stableGroups(groups) !== stableGroups(plan.groups)) throw concurrentModification('Pi Relationships changed after preview');
  const collision = projectCollision(settings, plan.piRoot, plan.sharedRoots);
  if (collision) throw concurrentModification(`${collision}; Project Skill candidates changed after preview`);
  if (!plan.change && !plan.stateChange) return;
  assertWritableFile(plan.settings.file, 'Project Pi settings');
  assertWritableFile(plan.state.file, 'Project SkillsPub state');
  assertWritableFile(plan.manifestFile, 'Pi recovery manifest');
  fs.mkdirSync(path.dirname(plan.manifestFile), { recursive: true });
  fs.writeFileSync(plan.settingsBackupFile, plan.settings.raw ?? '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(plan.stateBackupFile, plan.state.raw ?? '', { flag: 'wx', mode: 0o600 });
  if (readSnapshot(plan.settingsBackupFile, 'Project Pi settings backup').hash !== plan.settings.hash ||
    readSnapshot(plan.stateBackupFile, 'Project SkillsPub state backup').hash !== plan.state.hash)
    throw new Error('Pi Project isolation backup verification failed');
  fs.writeFileSync(plan.manifestFile, `${JSON.stringify({ version: 1, scope: 'project', projectPath: plan.project,
    settings: { path: plan.settings.file, existed: plan.settings.exists, originalHash: plan.settings.hash, expectedAppliedHash: plan.updatedSettingsHash, backupPath: plan.settingsBackupFile },
    state: { path: plan.state.file, existed: plan.state.exists, originalHash: plan.state.hash, expectedAppliedHash: plan.updatedStateHash, backupPath: plan.stateBackupFile },
    resolvedRoots: { pi: plan.piRoot, shared: plan.sharedRoots }, exactExclusions: plan.exclusions, relationships: plan.groups }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  let mutationStarted = false;
  try {
    if (plan.stateChange) { atomicWrite(plan.state.file, plan.updatedState); mutationStarted = true; }
    if (plan.change) { atomicWrite(plan.settings.file, plan.updatedSettings); mutationStarted = true; }
    const verified = readSettings(plan.settings.file);
    if (plan.sharedRoots.some((root) => { const result = inspectMatcher(verified.skills, verified.file, plan.piRoot, root); return !result.sharedExcluded || result.piTargetConflict; }))
      throw new Error(`Pi Project isolation semantic verification failed: ${plan.settings.file}`);
    if (stableGroups(projectRelationshipGroups(scanProjectInventory(home, plan.project, targets, { persist: false }), plan.project)) !== stableGroups(plan.groups))
      throw new Error('Pi Project Relationships changed during verification');
    const verifiedState = readSnapshot(plan.state.file, 'Project SkillsPub state');
    if (verifiedState.hash !== plan.updatedStateHash || verifiedState.raw !== plan.updatedState)
      throw concurrentModification(`Project SkillsPub state changed during apply: ${plan.state.file}`);
  } catch (error) {
    if (mutationStarted && error && typeof error === 'object') Object.assign(error, { partialEffects: 'present' as const });
    throw error;
  }
}

function projectOperation(home: Home, targets: SkillTarget[], operation: HarnessOperation, selectedPath: string): HarnessOperationPlan {
  const plan = buildProjectPlan(home, targets, operation, selectedPath);
  return {
    title: 'Pi exact-Project isolation plan:',
    lines: [
      `scope\tProject only: ${plan.project}; Global Pi settings, state, and Relationships remain read-only`,
      `resolved Pi root\t${plan.piRoot}`,
      ...plan.sharedRoots.map((root, index) => `resolved ${index ? 'ancestor ' : ''}Shared root\t${root}\texclusion=${plan.exclusions[index]}`),
      `${plan.change ? 'write' : 'retain'}\t${plan.settings.file}`,
      `ownership\t${plan.ownership.status}`,
      `settings SHA-256\t${plan.settings.hash}`,
      `Project state SHA-256\t${plan.state.hash}`,
      `settings backup\t${plan.settingsBackupFile}`,
      `state backup\t${plan.stateBackupFile}`,
      `affected-path manifest\t${plan.manifestFile}`,
      `expected truth\tall applicable Project Shared roots excluded; ${plan.groups.flatMap((g) => g.relationships).length} canonical Project Pi Relationships retained`,
    ],
    recovery: plan.relationshipImpact.recovery.instructions,
    relationshipImpact: plan.relationshipImpact,
    apply: () => applyProjectPlan(home, targets, plan),
    verify() {
      const inspection = piAdapter.inspect(home, targets, plan.project);
      const projectRoots = inspection.roots.filter((root) => root.kind === 'shared' && root.scope !== 'global');
      const projectPi = inspection.roots.find((root) => root.kind === 'harness' && root.scope === 'project');
      if (!projectRoots.length || projectRoots.some((root) => root.consumption !== 'excluded') || projectPi?.consumption !== 'consumed')
        throw new Error(`Pi Project isolation verification failed: ${inspection.sharedConsumption.detail}`);
      return inspection;
    },
    result: (inspection) => {
      const effects = plan.groups.flatMap((group) => group.relationships);
      return {
        inspection,
        actual: { unlinkedRelationships: 0, retainedRelationships: effects.length, preservedSourceResources: new Set(effects.map((entry) => entry.resourceId)).size },
        desired: { unlinkedRelationships: 0, retainedRelationships: effects.length, preservedSourceResources: new Set(effects.map((entry) => entry.resourceId)).size },
        drift: { relationships: [], isolation: false }, isolation: inspection.isolation,
        relationshipEffects: effects.map((entry) => ({ ...entry, outcome: 'retained' as const })),
        recovery: { ...plan.relationshipImpact.recovery, configBackupPreserved: !plan.change || fs.existsSync(plan.settingsBackupFile), stateBackupPreserved: !plan.stateChange || fs.existsSync(plan.stateBackupFile), manifestPreserved: (!plan.change && !plan.stateChange) || fs.existsSync(plan.manifestFile) },
        sharedConsumption: inspection.sharedConsumption,
        effectiveVisibility: { status: 'unknown', detail: 'Use resource-specific explain; no running Pi process was reloaded.' },
      };
    },
  };
}

interface PiTargetMigrationPlan {
  project: string;
  registry: FileSnapshot;
  state: FileSnapshot;
  source: string;
  destination: string;
  sourceExists: boolean;
  sourceHash: string;
  updatedRegistry: string;
  updatedRegistryHash: string;
  registryBackup: string;
  stateBackup: string;
  contentBackup: string;
  manifestFile: string;
  recoveryFile: string;
  ownershipStatus: 'owned' | 'unowned';
  groups: HarnessRelationshipGroup[];
  canonicalTargets: SkillTarget[];
}

function buildMigrationPlan(home: Home, targets: SkillTarget[], selectedPath: string): PiTargetMigrationPlan {
  const project = canonicalProjectPath(selectedPath);
  const pi = resolvePiTarget(targets);
  if (pi.projectPath !== '.pi/agent/skills') throw new Error('Pi Project Target is already canonical; no migration is required.');
  const registry = readSnapshot(path.join(home.configDir, 'targets.json'), 'Target registry');
  const value = parseRecord(registry, 'Target registry');
  if (value.version !== 1 || !Array.isArray(value.overrides) || !Array.isArray(value.genericTargets))
    throw new Error(`invalid Target registry: ${registry.file}`);
  const overrides = value.overrides.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`invalid Target Definition override in ${registry.file}`);
    return { ...(entry as Record<string, unknown>) };
  });
  const piOverride = overrides.find((entry) => entry.key === 'pi');
  if (!piOverride || piOverride.projectPath !== '.pi/agent/skills')
    throw new Error('Resolved stale Pi Project Target has no matching registry override; migration is blocked.');
  const nextPi = { ...piOverride };
  delete nextPi.projectPath;
  const updatedOverrides = overrides.flatMap((entry) => {
    if (entry !== piOverride) return [entry];
    return Object.keys(nextPi).length === 1 ? [] : [nextPi];
  });
  const updatedRegistry = `${JSON.stringify({ ...value, overrides: updatedOverrides }, null, 2)}\n`;
  const source = path.join(project, '.pi', 'agent', 'skills');
  const destination = path.join(project, '.pi', 'skills');
  const sourceExists = fs.existsSync(source);
  if (sourceExists) {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Stale Pi Project Target must be a directory: ${source}`);
    if (fs.existsSync(destination)) throw new Error(`Canonical Pi Project Target destination conflict: ${destination}`);
  }
  const state = readSnapshot(path.join(project, '.skillspub', 'state.json'), 'Project SkillsPub state');
  const stateValue = parseRecord(state, 'Project SkillsPub state');
  let ownershipStatus: 'owned' | 'unowned' = 'unowned';
  if (stateValue.piIsolation !== undefined) {
    if (!isPiClaim(stateValue.piIsolation) || stateValue.piIsolation.scope !== 'project' ||
      stateValue.piIsolation.projectPath !== project)
      throw new Error('Project SkillsPub state has conflicting Pi isolation ownership');
    ownershipStatus = 'owned';
  }
  const groups = projectRelationshipGroups(scanProjectInventory(home, project, targets, { persist: false }), project);
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const recoveryDir = path.join(project, '.skillspub', 'pi-recovery');
  const canonicalTargets = targets.map((target) => target.key === 'pi' ? { ...target, projectPath: '.pi/skills' } : target);
  return {
    project, registry, state, source, destination, sourceExists,
    sourceHash: sourceExists ? hashDirectory(source) : hash(undefined),
    updatedRegistry, updatedRegistryHash: hash(updatedRegistry),
    registryBackup: path.join(recoveryDir, `${id}.targets.json`),
    stateBackup: path.join(recoveryDir, `${id}.state.json`),
    contentBackup: path.join(recoveryDir, `${id}.skills`),
    manifestFile: path.join(recoveryDir, `${id}.migration.json`),
    recoveryFile: path.join(recoveryDir, `${id}.recover.mjs`),
    ownershipStatus,
    groups, canonicalTargets,
  };
}

function migrationRecoveryScript(plan: PiTargetMigrationPlan, manifestHash: string): string {
  const evidence = JSON.stringify({
    registry: plan.registry.file,
    registryBackup: plan.registryBackup,
    registryOriginalHash: plan.registry.hash,
    registryAppliedHash: plan.updatedRegistryHash,
    state: plan.state.file,
    stateBackup: plan.stateBackup,
    stateHash: plan.state.hash,
    stateExisted: plan.state.exists,
    source: plan.source,
    destination: plan.destination,
    contentBackup: plan.contentBackup,
    sourceExisted: plan.sourceExists,
    sourceHash: plan.sourceHash,
    manifest: plan.manifestFile,
    manifestHash,
  });
  return `import crypto from 'node:crypto';\nimport fs from 'node:fs';\nimport path from 'node:path';\n` +
    `const evidence = ${evidence};\n` +
    `const sha = (file) => crypto.createHash('sha256').update(fs.existsSync(file) ? fs.readFileSync(file) : '').digest('hex');\n` +
    `const directoryHash = (root) => { const digest = crypto.createHash('sha256'); const update = (value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); const length = Buffer.allocUnsafe(8); length.writeBigUInt64BE(BigInt(bytes.length)); digest.update(length); digest.update(bytes); }; const visit = (dir, prefix) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (entry.name === '.git' || entry.name === 'node_modules') continue; const relative = path.join(prefix, entry.name); const file = path.join(dir, entry.name); const kind = entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : 'file'; update(kind); update(relative); if (entry.isDirectory()) visit(file, relative); else if (entry.isSymbolicLink()) update(fs.readlinkSync(file)); else if (entry.isFile()) update(fs.readFileSync(file)); } }; visit(root, ''); return digest.digest('hex'); };\n` +
    `const check = (condition, message) => { if (!condition) throw new Error(message); };\n` +
    `check(sha(evidence.manifest) === evidence.manifestHash, 'Migration manifest hash mismatch');\n` +
    `check(sha(evidence.registry) === evidence.registryAppliedHash, 'Target registry changed since migration');\n` +
    `check(sha(evidence.registryBackup) === evidence.registryOriginalHash, 'Target registry backup hash mismatch');\n` +
    `check(fs.existsSync(evidence.state) === evidence.stateExisted && sha(evidence.state) === evidence.stateHash, 'Project state changed since migration');\n` +
    `check(sha(evidence.stateBackup) === evidence.stateHash, 'Project state backup hash mismatch');\n` +
    `if (evidence.sourceExisted) { check(!fs.existsSync(evidence.source), 'Stale Target source already exists'); check(fs.existsSync(evidence.contentBackup) && directoryHash(evidence.contentBackup) === evidence.sourceHash, 'Target content backup hash mismatch'); if (fs.existsSync(evidence.destination)) { const currentHash = directoryHash(evidence.destination); if (currentHash === evidence.sourceHash) fs.rmSync(evidence.destination, { recursive: true }); else { const conflict = evidence.destination + '.recovery-conflict'; check(!fs.existsSync(conflict), 'Recovery conflict path already exists'); fs.renameSync(evidence.destination, conflict); } } fs.mkdirSync(path.dirname(evidence.source), { recursive: true }); fs.cpSync(evidence.contentBackup, evidence.source, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true }); check(directoryHash(evidence.source) === evidence.sourceHash, 'Restored Target content hash mismatch'); }\n` +
    `const temporary = evidence.registry + '.recovery-' + process.pid; fs.copyFileSync(evidence.registryBackup, temporary); fs.renameSync(temporary, evidence.registry);\n` +
    `check(sha(evidence.registry) === evidence.registryOriginalHash, 'Restored registry hash mismatch'); check(sha(evidence.state) === evidence.stateHash, 'Restored Project state hash mismatch'); console.log('Pi Project Target recovery verified');\n`;
}

function applyMigrationPlan(home: Home, targets: SkillTarget[], plan: PiTargetMigrationPlan): void {
  const registry = readSnapshot(plan.registry.file, 'Target registry');
  const state = readSnapshot(plan.state.file, 'Project SkillsPub state');
  if (registry.hash !== plan.registry.hash || registry.raw !== plan.registry.raw)
    throw concurrentModification(`Target registry changed after preview: ${plan.registry.file}`);
  if (state.hash !== plan.state.hash || state.raw !== plan.state.raw)
    throw concurrentModification(`Project SkillsPub state changed after preview: ${plan.state.file}`);
  if (fs.existsSync(plan.source) !== plan.sourceExists || (plan.sourceExists && hashDirectory(plan.source) !== plan.sourceHash))
    throw concurrentModification(`Stale Pi Project Target changed after preview: ${plan.source}`);
  if (plan.sourceExists && fs.existsSync(plan.destination))
    throw concurrentModification(`Canonical Pi Project Target destination appeared after preview: ${plan.destination}`);
  const groups = projectRelationshipGroups(scanProjectInventory(home, plan.project, targets, { persist: false }), plan.project);
  if (stableGroups(groups) !== stableGroups(plan.groups)) throw concurrentModification('Pi Project Relationships changed after migration preview');
  assertWritableFile(plan.registry.file, 'Target registry');
  assertWritableFile(plan.manifestFile, 'Pi migration manifest');
  fs.mkdirSync(path.dirname(plan.manifestFile), { recursive: true });
  fs.writeFileSync(plan.registryBackup, plan.registry.raw ?? '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(plan.stateBackup, plan.state.raw ?? '', { flag: 'wx', mode: 0o600 });
  if (plan.sourceExists) fs.cpSync(plan.source, plan.contentBackup, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  if (readSnapshot(plan.registryBackup, 'Target registry backup').hash !== plan.registry.hash ||
    readSnapshot(plan.stateBackup, 'Project SkillsPub state backup').hash !== plan.state.hash ||
    (plan.sourceExists && hashDirectory(plan.contentBackup) !== plan.sourceHash))
    throw new Error('Pi Target migration backup verification failed');
  const manifestRaw = `${JSON.stringify({ version: 1, scope: 'project', projectPath: plan.project,
    registry: { path: plan.registry.file, originalHash: plan.registry.hash, expectedAppliedHash: plan.updatedRegistryHash, backupPath: plan.registryBackup },
    state: { path: plan.state.file, hash: plan.state.hash, backupPath: plan.stateBackup },
    content: { source: plan.source, destination: plan.destination, existed: plan.sourceExists, hash: plan.sourceHash, backupPath: plan.contentBackup },
    recoveryScript: { path: plan.recoveryFile },
    relationships: plan.groups, expectedTruth: { projectTarget: plan.destination, relationships: 'retained', activationAndDesiredState: 'preserved' } }, null, 2)}\n`;
  fs.writeFileSync(plan.manifestFile, manifestRaw, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(plan.recoveryFile, migrationRecoveryScript(plan, hash(manifestRaw)), { flag: 'wx', mode: 0o700 });
  let mutationStarted = false;
  try {
    if (plan.sourceExists) {
      fs.mkdirSync(path.dirname(plan.destination), { recursive: true });
      fs.renameSync(plan.source, plan.destination);
      mutationStarted = true;
    }
    atomicWrite(plan.registry.file, plan.updatedRegistry);
    mutationStarted = true;
    if (readSnapshot(plan.registry.file, 'Target registry').hash !== plan.updatedRegistryHash)
      throw new Error('Pi Target migration registry verification failed');
    if (plan.sourceExists && (!fs.existsSync(plan.destination) || hashDirectory(plan.destination) !== plan.sourceHash || fs.existsSync(plan.source)))
      throw new Error('Pi Target migration content verification failed');
    if (readSnapshot(plan.state.file, 'Project SkillsPub state').hash !== plan.state.hash)
      throw new Error('Pi Target migration changed Project SkillsPub state');
    const after = projectRelationshipGroups(scanProjectInventory(home, plan.project, plan.canonicalTargets, { persist: false }), plan.project);
    const relationshipIdentity = (entry: HarnessRelationshipEffect): string =>
      `${entry.slot}\0${entry.form === 'local' ? '<moved-local>' : entry.resourceId}\0${entry.form}\0${entry.activation}`;
    const beforeResources = plan.groups.flatMap((group) => group.relationships).map(relationshipIdentity).sort();
    const afterResources = after.flatMap((group) => group.relationships).map(relationshipIdentity).sort();
    if (JSON.stringify(beforeResources) !== JSON.stringify(afterResources)) throw new Error('Pi Target migration did not preserve Relationships');
  } catch (error) {
    if (mutationStarted && error && typeof error === 'object') Object.assign(error, { partialEffects: 'present' as const });
    throw error;
  }
}

function migrationOperation(home: Home, targets: SkillTarget[], selectedPath: string): HarnessOperationPlan {
  const plan = buildMigrationPlan(home, targets, selectedPath);
  const effects = plan.groups.flatMap((group) => group.relationships);
  const recovery = [
    `Run hash-checked recovery: node '${plan.recoveryFile}'`,
    `Verify original registry SHA-256 ${plan.registry.hash}, Project state SHA-256 ${plan.state.hash}, and content SHA-256 ${plan.sourceHash} using ${plan.manifestFile}`,
  ];
  const impact: HarnessRelationshipImpact = {
    summary: { affectedRelationships: effects.length, unlinkedRelationships: 0, retainedRelationships: effects.length, preservedSourceResources: new Set(effects.map((entry) => entry.resourceId)).size },
    actual: { relationshipCount: effects.length, isolation: 'drift' },
    desired: { relationshipCount: effects.length, isolation: 'unmanaged' },
    drift: { relationships: [], isolation: false }, groups: plan.groups,
    configuration: { path: plan.registry.file, plannedAction: 'write', originalHash: plan.registry.hash, backupPath: plan.registryBackup },
    ownershipState: { path: plan.state.file, status: plan.ownershipStatus, plannedAction: 'retain', originalHash: plan.state.hash, backupPath: plan.stateBackup },
    expectedTruth: { sharedConsumption: 'unknown', targetRelationships: 'retained', effectiveVisibility: 'unknown' },
    recovery: { manifestPath: plan.manifestFile, instructions: recovery },
  };
  return {
    title: 'Pi exact-Project Target migration plan:',
    lines: [
      `scope\tProject migration only: ${plan.project}; Global Pi settings and Global Pi Target remain unchanged`,
      `source\t${plan.source}`,
      `destination\t${plan.destination}`,
      `source content SHA-256\t${plan.sourceHash}`,
      `Target registry SHA-256\t${plan.registry.hash}`,
      `Project state SHA-256\t${plan.state.hash}`,
      `ownership\t${plan.ownershipStatus}; retained byte-for-byte`,
      `content backup\t${plan.contentBackup}`,
      `registry backup\t${plan.registryBackup}`,
      `state backup\t${plan.stateBackup}`,
      `executable recovery\t${plan.recoveryFile}`,
      `affected-path manifest\t${plan.manifestFile}`,
      `expected truth\tcanonical .pi/skills; ${effects.length} Relationships, Activation, Desired state, ownership, and resources preserved`,
    ], recovery, relationshipImpact: impact,
    apply: () => applyMigrationPlan(home, targets, plan),
    verify: () => piAdapter.inspect(home, plan.canonicalTargets, plan.project),
    result: (inspection) => ({
      inspection,
      actual: { unlinkedRelationships: 0, retainedRelationships: effects.length, preservedSourceResources: new Set(effects.map((entry) => entry.resourceId)).size },
      desired: { unlinkedRelationships: 0, retainedRelationships: effects.length, preservedSourceResources: new Set(effects.map((entry) => entry.resourceId)).size },
      drift: { relationships: [], isolation: inspection.isolation.status === 'drift' }, isolation: inspection.isolation,
      relationshipEffects: effects.map((entry) => ({ ...entry, outcome: 'retained' as const })),
      recovery: { ...impact.recovery, configBackupPreserved: fs.existsSync(plan.registryBackup), stateBackupPreserved: fs.existsSync(plan.stateBackup), manifestPreserved: fs.existsSync(plan.manifestFile) },
      sharedConsumption: inspection.sharedConsumption,
      effectiveVisibility: { status: 'unknown', detail: 'Migration preserves filesystem truth; resource-specific explain determines next-load visibility.' },
    }),
  };
}

function planOperation(
  home: Home,
  targets: SkillTarget[],
  operation: HarnessOperation,
  projectPath?: string,
): HarnessOperationPlan {
  if (projectPath) return operation === 'migrate'
    ? migrationOperation(home, targets, canonicalProjectPath(projectPath))
    : projectOperation(home, targets, operation, canonicalProjectPath(projectPath));
  if (operation === 'migrate') throw new Error('Pi Target migration is exact-Project only.');
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
      relationship: { support: 'managed', link: 'supported' },
    };
  },
  inspect(home, targets, projectPath) {
    const piTarget = resolvePiTarget(targets);
    const sharedTarget = resolveSharedTarget(targets);
    const projectRoot = projectPath ? canonicalProjectPath(projectPath) : undefined;
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
    const projectResult = shared.project[0];
    const projectPiKnown = shared.trust?.trusted === true && projectResult && !projectResult.detail && !projectResult.piTargetConflict;
    const detected = fs.existsSync(piTarget.discoveryRoot) || fs.existsSync(file) ||
      fs.existsSync(piHome(piTarget)) || Boolean(projectRoot && fs.existsSync(path.join(projectRoot, '.pi')));
    return {
      key: 'pi',
      name: 'Pi',
      detected,
      support: 'managed',
      evidence: EVIDENCE,
      targets: [
        { scope: 'global', discoveryRoot: path.resolve(piTarget.discoveryRoot) },
        ...(projectRoot ? [{ scope: 'project' as const, discoveryRoot: path.join(projectRoot, '.pi', 'skills') }] : []),
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
          discoveryRoot: path.join(projectRoot, '.pi', 'skills'),
          consumption: projectPiKnown ? 'consumed' as const : 'unknown' as const,
          reason: projectResult?.detail ?? (projectResult?.piTargetConflict
            ? `Pi matcher may suppress its exact Project Target: ${projectResult.piTargetConflict}`
            : 'Pi discovers the canonical exact Project Skill Target after trust.'),
        }] : []),
        ...shared.roots,
      ],
      sharedConsumption: shared.summary,
      isolation: projectRoot
        ? inspectProjectIsolation(piTarget, sharedTarget, projectRoot)
        : isolation(ownershipResult, exclusion, settings, shared.global.excluded),
      link: { supported: true },
    };
  },
  operations: {
    setup: (home, targets, projectPath) => planOperation(home, targets, 'setup', projectPath),
    reconcile: (home, targets, projectPath) => planOperation(home, targets, 'reconcile', projectPath),
    migrate: (home, targets, projectPath) => planOperation(home, targets, 'migrate', projectPath),
  },
};
