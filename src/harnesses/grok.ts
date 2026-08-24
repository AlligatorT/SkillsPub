import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import type { Home } from '../core.ts';
import {
  readStateFile,
  scanGlobalInventory,
  scanProjectInventory,
  writeStateFile,
  type InventoryScanReport,
  type SkillTarget,
} from '../inventory.ts';
import { sharedTargetDefinition } from '../targets/shared.ts';
import { resolveHarnessTarget } from './target.ts';
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessOperation,
  HarnessOperationPlan,
} from './types.ts';

interface GrokConfig {
  raw?: string;
  ignore: string[];
  paths: string[];
  disabled: string[];
  claudeSkills: boolean;
  cursorSkills: boolean;
}

interface AffectedLink {
  path: string;
  target: string;
  targetId: string;
  slot: string;
}

interface GrokPlan {
  file: string;
  expected?: string;
  expectedHash: string;
  updated: string;
  rootsToAdd: string[];
  affectedRoots: string[];
  targetRoots: string[];
  affectedLinks: AffectedLink[];
  projectPath?: string;
  backupFile: string;
  manifestFile: string;
  change: boolean;
}

const VERIFIED_REVISION = '19d42e35c07a9c9244f03f6df0c4c353f970d4f9';
const EVIDENCE = [
  {
    url: 'https://docs.x.ai/build/settings/reference',
    verifiedVersion: VERIFIED_REVISION,
    detail: 'GROK_HOME, Skills configuration, and Claude/Cursor compatibility settings.',
  },
  {
    url: 'https://docs.x.ai/build/features/skills-plugins-marketplaces',
    verifiedVersion: VERIFIED_REVISION,
    detail: 'Grok Build Global, Project, Shared, and vendor-compatible Skill discovery roots.',
  },
  {
    url: `https://github.com/xai-org/grok-build/blob/${VERIFIED_REVISION}/crates/codegen/xai-grok-agent/src/prompt/skills.rs`,
    verifiedVersion: VERIFIED_REVISION,
    detail: 'Canonical ignore-prefix filtering and compatibility discovery behavior.',
  },
] as const;

function grokHome(target: SkillTarget): string {
  return path.dirname(target.discoveryRoot);
}

function configFile(target: SkillTarget): string {
  return path.join(grokHome(target), 'config.toml');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new Error(`Grok config ${field} must be an array of strings`);
  return value as string[];
}

function compatibilitySkills(value: unknown, field: string): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new Error(`Grok config ${field} must be a boolean`);
  return value;
}

function readRawConfig(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`cannot read Grok config at ${file}: ${(error as Error).message}`);
  }
}

function parseConfig(raw: string | undefined, file: string): Record<string, unknown> {
  try {
    const value: unknown = parse(raw ?? '');
    if (!isRecord(value)) throw new Error('must be a TOML table');
    return value;
  } catch (error) {
    throw new Error(`cannot parse Grok config at ${file}: ${(error as Error).message}`);
  }
}

function optionalTable(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Grok config ${field} must be a table`);
  return value;
}

function readConfig(file: string): GrokConfig {
  const raw = readRawConfig(file);
  const parsed = parseConfig(raw, file);
  const skills = optionalTable(parsed.skills, 'skills');
  const compat = optionalTable(parsed.compat, 'compat');
  const claude = optionalTable(compat?.claude, 'compat.claude');
  const cursor = optionalTable(compat?.cursor, 'compat.cursor');
  return {
    raw,
    ignore: stringList(skills?.ignore, 'skills.ignore'),
    paths: stringList(skills?.paths, 'skills.paths'),
    disabled: stringList(skills?.disabled, 'skills.disabled'),
    claudeSkills: compatibilitySkills(claude?.skills, 'compat.claude.skills'),
    cursorSkills: compatibilitySkills(cursor?.skills, 'compat.cursor.skills'),
  };
}

function expandConfiguredPath(value: string): string {
  const expanded = value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(2))
    : value;
  const absolute = path.resolve(expanded);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(expandConfiguredPath(root), expandConfiguredPath(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function uniquePaths(values: string[]): string[] {
  return [...new Map(values.map((value) => [expandConfiguredPath(value), value])).values()];
}

function coversRoot(ignore: string[], root: string): boolean {
  return ignore.some((entry) => contains(entry, root));
}

function resolveGrokTarget(targets: SkillTarget[]): SkillTarget {
  return resolveHarnessTarget(targets, 'grok', () => grokAdapter.targetDefinition());
}

function resolveSharedTarget(targets: SkillTarget[]): SkillTarget {
  return resolveHarnessTarget(targets, 'shared', sharedTargetDefinition);
}

function operationReport(
  home: Home,
  targets: SkillTarget[],
  projectPath?: string,
): InventoryScanReport {
  return projectPath
    ? scanProjectInventory(home, projectPath, targets, { persist: false })
    : scanGlobalInventory(home, targets, { persist: false });
}

function projectCeiling(projectPath: string): string {
  for (let directory = projectPath;;) {
    if (fs.existsSync(path.join(directory, '.git'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return directory;
    directory = parent;
  }
}

function ancestorRoots(target: SkillTarget, projectPath: string): string[] {
  if (!fs.existsSync(projectPath)) return [];
  const roots: string[] = [];
  const ceiling = projectCeiling(projectPath);
  for (let directory = path.dirname(projectPath); contains(ceiling, directory); directory = path.dirname(directory)) {
    const root = path.join(directory, target.projectPath);
    if (fs.existsSync(root)) roots.push(root);
    if (directory === ceiling) break;
  }
  return roots;
}

function projectedRoots(target: SkillTarget, projectPath?: string): string[] {
  if (!projectPath) return [target.discoveryRoot];
  return uniquePaths([
    path.join(projectPath, target.projectPath),
    ...ancestorRoots(target, projectPath),
    target.discoveryRoot,
  ]);
}

function scopedRoots(target: SkillTarget, projectPath?: string): Array<{
  scope: 'global' | 'project' | 'parent';
  discoveryRoot: string;
}> {
  const roots = projectedRoots(target, projectPath);
  if (!projectPath) return [{ scope: 'global', discoveryRoot: roots[0] }];
  return roots.map((discoveryRoot, index) => ({
    scope: index === 0 ? 'project' : index === roots.length - 1 ? 'global' : 'parent',
    discoveryRoot,
  }));
}

function requiredSharedRoots(
  _home: Home,
  targets: SkillTarget[],
  projectPath?: string,
): string[] {
  return projectedRoots(resolveSharedTarget(targets), projectPath);
}

function operationGrokRoots(targets: SkillTarget[], projectPath?: string): string[] {
  return projectedRoots(resolveGrokTarget(targets), projectPath);
}

function claimStateFile(home: Home, projectPath?: string): string {
  return projectPath
    ? path.join(projectPath, '.skillspub', 'state.json')
    : path.join(home.configDir, 'state.json');
}

function managedClaim(
  home: Home,
  file: string,
  roots: string[],
  projectPath?: string,
): 'none' | 'managed' | 'drift' {
  const claim = readStateFile(claimStateFile(home, projectPath)).grokIsolation;
  if (claim === undefined) return 'none';
  if (!isRecord(claim) || claim.file !== file || !Array.isArray(claim.roots)) return 'drift';
  return claim.roots.length === roots.length &&
    claim.roots.every((root, index) => root === roots[index])
    ? 'managed'
    : 'drift';
}

function isolationStatus({
  home,
  file,
  roots,
  isolated,
  projectPath,
}: {
  home: Home;
  file: string;
  roots: string[];
  isolated: boolean;
  projectPath?: string;
}): HarnessInspection['isolation'] {
  const claim = managedClaim(home, file, roots, projectPath);
  if (claim === 'none')
    return { status: 'unmanaged', detail: 'Grok Build isolation is not managed by SkillsPub.' };
  return claim === 'managed' && isolated
    ? { status: 'managed', detail: 'SkillsPub-managed Grok Build isolation is active.' }
    : { status: 'drift', detail: 'SkillsPub-managed Grok Build isolation has changed; run explicit reconcile.' };
}

function affectedLinks(
  report: InventoryScanReport,
  roots: string[],
  targetRoots: string[],
): AffectedLink[] {
  return report.relationships.flatMap((relationship) => {
    const target = relationship.realPath;
    if (relationship.targetKey !== 'grok' || relationship.form !== 'link' || !target ||
      !targetRoots.some((root) => containsPath(root, relationship.path)) ||
      !roots.some((root) => contains(root, target))) return [];
    return [{
      path: relationship.path,
      target,
      targetId: relationship.targetId,
      slot: relationship.slot,
    }];
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function hash(value: string | undefined): string {
  return crypto.createHash('sha256').update(value ?? '').digest('hex');
}

function tomlValue(value: boolean | string[]): string {
  return typeof value === 'boolean'
    ? String(value)
    : `[${value.map((entry) => JSON.stringify(entry)).join(', ')}]`;
}

function assignment(line: string): { indent: string; key: string } | undefined {
  const match = line.match(/^(\s*)([A-Za-z0-9_-]+)\s*=/);
  return match?.[2] ? { indent: match[1] ?? '', key: match[2] } : undefined;
}

function sectionEnd(lines: string[], start: number): number {
  const offset = lines.slice(start + 1).findIndex((line) => /^\s*\[/.test(line));
  return offset < 0 ? lines.length : start + offset + 1;
}

function scanTomlLine(line: string): {
  comment?: string;
  delta: number;
  opened: boolean;
} {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let delta = 0;
  let opened = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (quote === '"' && character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '#') return { comment: line.slice(index), delta, opened };
    else if (character === '[') {
      delta++;
      opened = true;
    } else if (character === ']') delta--;
  }
  return { delta, opened };
}

function tomlComment(line: string): string | undefined {
  return scanTomlLine(line).comment;
}

function arrayAssignmentEnd(lines: string[], start: number, end: number): number {
  let depth = 0;
  let opened = false;
  for (let index = start; index < end; index++) {
    const change = scanTomlLine(lines[index] ?? '');
    depth += change.delta;
    opened ||= change.opened;
    if (opened && depth <= 0) return index + 1;
  }
  return start + 1;
}

function setTomlKey(raw: string, section: string, key: string, value: boolean | string[]): string {
  const lines = raw.split('\n');
  const header = `[${section}]`;
  const start = lines.findIndex((line) => line.trim().replace(/\s+#.*$/, '') === header);
  if (start < 0) {
    const prefix = raw && !raw.endsWith('\n') ? '\n' : '';
    const separator = raw && !raw.endsWith('\n\n') ? '\n' : '';
    return `${raw}${prefix}${separator}${header}\n${key} = ${tomlValue(value)}\n`;
  }
  const end = sectionEnd(lines, start);
  const existing = lines.findIndex((line, index) =>
    index > start && index < end && assignment(line)?.key === key);
  if (existing < 0) lines.splice(end, 0, `${key} = ${tomlValue(value)}`);
  else {
    const existingLine = lines[existing] ?? '';
    const indent = assignment(existingLine)?.indent ?? '';
    const comment = tomlComment(existingLine);
    const replacement = `${indent}${key} = ${tomlValue(value)}${comment ? ` ${comment}` : ''}`;
    const replacementEnd = Array.isArray(value) ? arrayAssignmentEnd(lines, existing, end) : existing + 1;
    lines.splice(existing, replacementEnd - existing, replacement);
  }
  return lines.join('\n');
}

function updatedConfig(config: GrokConfig, ignore: string[]): string {
  let raw = config.raw ?? '';
  raw = setTomlKey(raw, 'skills', 'ignore', ignore);
  raw = setTomlKey(raw, 'compat.claude', 'skills', false);
  raw = setTomlKey(raw, 'compat.cursor', 'skills', false);
  readConfigText(raw);
  return raw;
}

function readConfigText(raw: string): void {
  try {
    parse(raw);
  } catch (error) {
    throw new Error(`generated Grok config is invalid: ${(error as Error).message}`);
  }
}

function atomicWrite(file: string, raw: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, raw);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function assertSafeConfig(config: GrokConfig, grokRoots: string[]): void {
  if (config.paths.length) throw new Error('Grok setup requires skills.paths to be empty');
  if (config.disabled.length) throw new Error('Grok setup requires skills.disabled to be empty');
  const conflict = config.ignore.find((entry) => grokRoots.some((root) => contains(entry, root)));
  if (conflict) throw new Error(`Grok skills.ignore conflicts with a managed Grok Target: ${conflict}`);
}

function buildPlan(
  home: Home,
  targets: SkillTarget[],
  operation: HarnessOperation,
  selectedProject?: string,
): GrokPlan {
  const projectPath = selectedProject ? fs.realpathSync(selectedProject) : undefined;
  const grokTarget = resolveGrokTarget(targets);
  const file = configFile(grokTarget);
  const config = readConfig(file);
  const roots = requiredSharedRoots(home, targets, projectPath);
  const inspection = grokAdapter.inspect(home, targets, projectPath);
  if (operation === 'setup' && inspection.isolation.status === 'drift')
    throw new Error('Grok Build isolation has drift; use explicit reconcile.');
  const targetRoots = operationGrokRoots(targets, projectPath);
  assertSafeConfig(config, targetRoots);
  const rootsToAdd = roots.filter((root) => !coversRoot(config.ignore, root));
  const ignore = uniquePaths([...config.ignore, ...rootsToAdd]);
  const affectedRoots = operation === 'reconcile' ? roots : rootsToAdd;
  const links = affectedLinks(operationReport(home, targets, projectPath), affectedRoots, targetRoots);
  const updated = updatedConfig(config, ignore);
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const recoveryDir = projectPath
    ? path.join(projectPath, '.skillspub', 'grok-recovery')
    : path.join(home.configDir, 'grok-recovery');
  return {
    file,
    expected: config.raw,
    expectedHash: hash(config.raw),
    updated,
    rootsToAdd,
    affectedRoots,
    targetRoots,
    affectedLinks: links,
    projectPath,
    backupFile: path.join(recoveryDir, `${id}.toml`),
    manifestFile: path.join(recoveryDir, `${id}.links.json`),
    change: rootsToAdd.length > 0 || config.claudeSkills || config.cursorSkills,
  };
}

function sameLinks(left: AffectedLink[], right: AffectedLink[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function preflightApply(home: Home, targets: SkillTarget[], plan: GrokPlan): void {
  const current = readConfig(plan.file);
  if (current.raw !== plan.expected || hash(current.raw) !== plan.expectedHash)
    throw new Error(`Grok config changed after preview: ${plan.file}`);
  assertSafeConfig(current, operationGrokRoots(targets, plan.projectPath));
  const currentLinks = affectedLinks(
    operationReport(home, targets, plan.projectPath),
    plan.affectedRoots,
    plan.targetRoots,
  );
  if (!sameLinks(currentLinks, plan.affectedLinks))
    throw new Error('Grok affected Links changed after preview');
  for (const link of plan.affectedLinks) {
    const stat = fs.lstatSync(link.path);
    if (!stat.isSymbolicLink() || fs.realpathSync(link.path) !== link.target)
      throw new Error(`Grok Link changed after preview: ${link.path}`);
  }
}

function writeRecovery(plan: GrokPlan): void {
  fs.mkdirSync(path.dirname(plan.backupFile), { recursive: true });
  fs.writeFileSync(plan.backupFile, plan.expected ?? '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(plan.manifestFile, JSON.stringify({
    config: plan.file,
    originalHash: plan.expectedHash,
    links: plan.affectedLinks,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

function saveClaim(home: Home, targets: SkillTarget[], plan: GrokPlan): void {
  const stateFile = claimStateFile(home, plan.projectPath);
  const state = readStateFile(stateFile);
  state.grokIsolation = {
    file: plan.file,
    roots: requiredSharedRoots(home, targets, plan.projectPath),
    backupFile: plan.backupFile,
    manifestFile: plan.manifestFile,
  };
  writeStateFile(stateFile, state);
}

function applyPlan(home: Home, targets: SkillTarget[], plan: GrokPlan): void {
  preflightApply(home, targets, plan);
  writeRecovery(plan);
  if (plan.change) atomicWrite(plan.file, plan.updated);
  for (const link of plan.affectedLinks) fs.unlinkSync(link.path);
  saveClaim(home, targets, plan);
}

function planOperation(
  home: Home,
  targets: SkillTarget[],
  operation: HarnessOperation,
  projectPath?: string,
): HarnessOperationPlan {
  const plan = buildPlan(home, targets, operation, projectPath);
  const lines = [
    `write\t${plan.file}`,
    ...plan.rootsToAdd.map((root) => `Shared ignore\t${root}`),
    'compat.claude.skills\tfalse',
    'compat.cursor.skills\tfalse',
    ...plan.affectedLinks.map((link) => `Unlink\t${link.path} -> ${link.target}`),
    `backup\t${plan.backupFile}`,
    `affected-Link manifest\t${plan.manifestFile}`,
    'verify\tShared and vendor-compatible Skill isolation',
  ];
  return {
    title: 'Grok Build isolation plan:',
    lines,
    recovery: [
      `Restore config: cp ${plan.backupFile} ${plan.file}`,
      `Review removed Links: ${plan.manifestFile}`,
      'Recreate only the Links you still want; source Skill resources were not deleted.',
    ],
    apply: () => applyPlan(home, targets, plan),
    verify() {
      const inspection = grokAdapter.inspect(home, targets, plan.projectPath);
      if (inspection.sharedConsumption.status !== 'excluded' || inspection.isolation.status !== 'managed')
        throw new Error(`Grok isolation verification failed: ${inspection.sharedConsumption.detail}`);
      return inspection;
    },
  };
}

export const grokAdapter: HarnessAdapter = {
  key: 'grok',
  name: 'Grok Build',
  targetDefinition() {
    const root = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
    return {
      key: 'grok',
      kind: 'harness',
      discoveryRoot: path.join(root, 'skills'),
      parkingRoot: path.join(root, '.skillspub-off', 'skills'),
      projectPath: '.grok/skills',
      relationship: { support: 'managed', link: 'unsupported' },
    };
  },
  inspect(home, targets, projectPath) {
    const grokTarget = resolveGrokTarget(targets);
    const sharedTarget = resolveSharedTarget(targets);
    const claudeTarget = targets.find(({ key }) => key === 'claude');
    const cursorRoot = path.join(os.homedir(), '.cursor');
    const cursorTarget: SkillTarget = {
      key: 'cursor',
      kind: 'harness',
      discoveryRoot: path.join(cursorRoot, 'skills'),
      parkingRoot: path.join(cursorRoot, '.skillspub-off', 'skills'),
      projectPath: '.cursor/skills',
    };
    const root = grokHome(grokTarget);
    const selectedProject = projectPath ? path.resolve(projectPath) : undefined;
    const file = configFile(grokTarget);
    const detected = fs.existsSync(root) || Boolean(selectedProject && fs.existsSync(path.join(selectedProject, '.grok')));
    const sharedRootPaths = requiredSharedRoots(home, targets, selectedProject);
    const grokRoots = scopedRoots(grokTarget, selectedProject);
    const sharedRoots = scopedRoots(sharedTarget, selectedProject);
    const compatibilityRoots = [
      ...(claudeTarget ? scopedRoots(claudeTarget, selectedProject).map((entry) => ({
        ...entry,
        targetKey: 'claude',
      })) : []),
      ...scopedRoots(cursorTarget, selectedProject).map((entry) => ({
        ...entry,
        targetKey: 'cursor',
      })),
    ];
    let sharedConsumption: HarnessInspection['sharedConsumption'];
    let isolation: HarnessInspection['isolation'];
    let discoveryRoots: HarnessInspection['roots'];
    try {
      const config = readConfig(file);
      assertSafeConfig(config, grokRoots.map(({ discoveryRoot }) => discoveryRoot));
      const sharedExcluded = sharedRootPaths.every((sharedRoot) => coversRoot(config.ignore, sharedRoot));
      const compatibilityExcluded = compatibilityRoots.every(({ discoveryRoot, targetKey }) =>
        coversRoot(config.ignore, discoveryRoot) ||
        (targetKey === 'claude' ? !config.claudeSkills : !config.cursorSkills));
      const isolated = sharedExcluded && compatibilityExcluded;
      sharedConsumption = sharedExcluded
        ? { status: 'excluded', detail: `Grok Build excludes Shared skills at ${sharedRootPaths.join(', ')}.` }
        : { status: 'enabled', detail: `Grok Build still discovers Shared skills at ${sharedRootPaths.join(', ')}.` };
      isolation = isolationStatus({
        home,
        file,
        roots: sharedRootPaths,
        isolated,
        projectPath: selectedProject,
      });
      discoveryRoots = [
        ...grokRoots.map((entry) => ({
          kind: 'harness' as const,
          targetKey: 'grok',
          ...entry,
          consumption: 'consumed' as const,
          reason: 'Grok Build discovers this native Skill Target.',
        })),
        ...sharedRoots.map((entry) => {
          const excluded = coversRoot(config.ignore, entry.discoveryRoot);
          return {
            kind: 'shared' as const,
            targetKey: 'shared',
            ...entry,
            consumption: excluded ? 'excluded' as const : 'consumed' as const,
            reason: excluded
              ? 'Grok Build settings ignore this Shared root.'
              : 'Grok Build settings allow this Shared root.',
          };
        }),
        ...compatibilityRoots.map((entry) => {
          const enabled = entry.targetKey === 'claude' ? config.claudeSkills : config.cursorSkills;
          const excluded = !enabled || coversRoot(config.ignore, entry.discoveryRoot);
          return {
            kind: 'compatibility' as const,
            ...entry,
            consumption: excluded ? 'excluded' as const : 'consumed' as const,
            reason: excluded
              ? `Grok Build excludes ${entry.targetKey} compatibility Skills here.`
              : `Grok Build consumes ${entry.targetKey} compatibility Skills here.`,
          };
        }),
      ];
    } catch (error) {
      const detail = (error as Error).message;
      sharedConsumption = { status: 'unknown', detail };
      isolation = { status: 'unknown', detail };
      discoveryRoots = [
        ...grokRoots.map((entry) => ({ kind: 'harness' as const, targetKey: 'grok', ...entry })),
        ...sharedRoots.map((entry) => ({ kind: 'shared' as const, targetKey: 'shared', ...entry })),
        ...compatibilityRoots.map((entry) => ({ kind: 'compatibility' as const, ...entry })),
      ].map((entry) => ({ ...entry, consumption: 'unknown' as const, reason: detail }));
    }
    return {
      key: 'grok',
      name: 'Grok Build',
      detected,
      support: 'managed',
      evidence: EVIDENCE,
      targets: [
        { scope: 'global', discoveryRoot: grokTarget.discoveryRoot },
        ...(selectedProject ? [{
          scope: 'project' as const,
          discoveryRoot: path.join(selectedProject, grokTarget.projectPath),
        }] : []),
      ],
      roots: discoveryRoots,
      sharedConsumption,
      isolation,
      link: { supported: false },
      mirror: { supported: true },
    };
  },
  operations: {
    setup: (home, targets, projectPath) => planOperation(home, targets, 'setup', projectPath),
    reconcile: (home, targets, projectPath) => planOperation(home, targets, 'reconcile', projectPath),
  },
};
