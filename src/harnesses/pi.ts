import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Home } from '../core.ts';
import { readStateFile, writeStateFile, type SkillTarget, type TargetDefinition, type TargetScope } from '../inventory.ts';

export type SupportLevel = 'managed' | 'discoverable' | 'unsupported';
export type SharedConsumption = 'not-consumed' | 'required' | 'enabled' | 'excluded' | 'unknown';

export interface HarnessEvidence {
  url: string;
  verifiedVersion: string;
  detail: string;
}

export interface ResolvedHarnessTarget {
  scope: Extract<TargetScope, 'global' | 'project'>;
  discoveryRoot: string;
}

export interface PiSharedIsolationPlan {
  file: string;
  expected: string | undefined;
  sharedRoot: string;
  exclusion: string;
  change: boolean;
  claim: boolean;
  summary: string;
}

export interface HarnessInspection {
  key: string;
  name: string;
  detected: boolean;
  support: SupportLevel;
  evidence: readonly HarnessEvidence[];
  targets: ResolvedHarnessTarget[];
  sharedConsumption: { status: SharedConsumption; detail: string };
  isolation: { status: 'unmanaged' | 'managed' | 'drift'; detail: string };
  link: { supported: boolean };
}

export interface HarnessAdapter {
  key: string;
  targetDefinition(): TargetDefinition;
  inspect(home: Home, targets: SkillTarget[], projectPath?: string): HarnessInspection;
  planSharedIsolation(home: Home, targets: SkillTarget[]): PiSharedIsolationPlan;
  applySharedIsolation(home: Home, plan: PiSharedIsolationPlan): void;
}

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
    detail: 'Shared Agent Skills discovery and settings exclusions.',
  },
] as const satisfies readonly HarnessEvidence[];

type PiSettings = { value: Record<string, unknown>; skills: string[]; raw?: string };

function piHome(target: SkillTarget): string {
  return path.dirname(path.dirname(target.discoveryRoot));
}

function settingsFile(pi: SkillTarget): string {
  return path.join(piHome(pi), 'agent', 'settings.json');
}

function readSettings(file: string): PiSettings {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: {}, skills: [] };
    throw new Error(`cannot read Pi settings at ${file}: ${(error as Error).message}`);
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('must be an object');
    const skills = (value as { skills?: unknown }).skills;
    if (skills !== undefined && (!Array.isArray(skills) || skills.some((item) => typeof item !== 'string')))
      throw new Error('has unsupported skills configuration');
    return { value: value as Record<string, unknown>, skills: (skills ?? []) as string[], raw };
  } catch (error) {
    const message = (error as Error).message;
    throw new Error(message === 'must be an object' || message === 'has unsupported skills configuration'
      ? `Pi settings at ${file} ${message}`
      : `cannot read Pi settings at ${file}: ${message}`);
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** Pi evaluates Shared auto-discovery overrides relative to the Shared root's parent. */
function sharedExcluded(root: string, skills: string[]): boolean {
  const base = path.dirname(root);
  const relativeRoot = toPosix(path.relative(base, root));
  const absoluteRoot = toPosix(root);
  const candidates = [relativeRoot, absoluteRoot];
  const rootPatterns = new Set([`${relativeRoot}/**`, `${absoluteRoot}/**`, '**']);
  let globExcluded = false;
  let forceIncluded = false;
  let forceExcluded = false;
  for (const entry of skills) {
    const prefix = entry[0];
    const value = entry.slice(1);
    if (!value) continue;
    if (prefix === '!') globExcluded ||= rootPatterns.has(value);
    if (prefix === '+') forceIncluded ||= candidates.includes(value);
    if (prefix === '-') forceExcluded ||= candidates.includes(value);
  }
  return forceExcluded || (!forceIncluded && globExcluded);
}

function canonicalExclusion(shared: SkillTarget): string {
  return `!${toPosix(path.relative(path.dirname(shared.discoveryRoot), shared.discoveryRoot))}/**`;
}

function resolvePi(targets: SkillTarget[]): SkillTarget {
  return targets.find(({ key }) => key === 'pi') ?? piAdapter.targetDefinition();
}

function resolveShared(targets: SkillTarget[]): SkillTarget {
  return targets.find(({ key, kind }) => key === 'shared' && kind === 'shared') ?? {
    key: 'shared',
    kind: 'shared',
    discoveryRoot: path.join(os.homedir(), '.agents', 'skills'),
    parkingRoot: path.join(os.homedir(), '.agents', '.skillspub-off', 'skills'),
    projectPath: '.agents/skills',
  };
}

function managedClaim(home: Home, file: string, exclusion: string): boolean {
  const claim = readStateFile(path.join(home.configDir, 'state.json')).piIsolation;
  return Boolean(claim && typeof claim === 'object' && !Array.isArray(claim) &&
    (claim as { file?: unknown }).file === file &&
    (claim as { exclusion?: unknown }).exclusion === exclusion);
}

function isolation(
  home: Home,
  file: string,
  exclusion: string,
  skills: string[],
  excluded: boolean,
): HarnessInspection['isolation'] {
  if (!managedClaim(home, file, exclusion))
    return { status: 'unmanaged', detail: 'Shared exclusion is not managed by SkillsPub.' };
  return excluded && skills.includes(exclusion)
    ? { status: 'managed', detail: 'SkillsPub-managed Shared exclusion is active.' }
    : { status: 'drift', detail: 'SkillsPub-managed Shared exclusion is missing or changed; run explicit reconcile.' };
}

function inspectShared(
  pi: SkillTarget,
  shared: SkillTarget,
  projectPath?: string,
): HarnessInspection['sharedConsumption'] {
  const global = readSettings(settingsFile(pi));
  const roots = [shared.discoveryRoot];
  const exclusions = [sharedExcluded(shared.discoveryRoot, global.skills)];
  if (projectPath) {
    const projectRoot = path.join(projectPath, shared.projectPath);
    const projectSettings = readSettings(path.join(projectPath, '.pi', 'settings.json'));
    roots.push(projectRoot);
    exclusions.push(sharedExcluded(projectRoot, projectSettings.skills));
  }
  if (exclusions.every(Boolean))
    return { status: 'excluded', detail: `Pi Shared skills are excluded: ${roots.join(', ')}` };
  const excluded = roots.filter((_, index) => exclusions[index]);
  return {
    status: 'enabled',
    detail: `Pi discovers Shared skills at ${roots.join(', ')}${excluded.length ? `; excludes ${excluded.join(', ')}` : ''}`,
  };
}

function atomicWrite(file: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export const piAdapter: HarnessAdapter = {
  key: 'pi',
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
    const pi = resolvePi(targets);
    const shared = resolveShared(targets);
    const projectRoot = projectPath ? path.resolve(projectPath) : undefined;
    const file = settingsFile(pi);
    let sharedConsumption: HarnessInspection['sharedConsumption'];
    let skills: string[] = [];
    try {
      skills = readSettings(file).skills;
      sharedConsumption = inspectShared(pi, shared, projectRoot);
    } catch (error) {
      sharedConsumption = { status: 'unknown', detail: (error as Error).message };
    }
    const detected = fs.existsSync(pi.discoveryRoot) || fs.existsSync(file) ||
      fs.existsSync(piHome(pi)) || Boolean(projectRoot && fs.existsSync(path.join(projectRoot, '.pi')));
    return {
      key: 'pi',
      name: 'Pi',
      detected,
      support: 'managed',
      evidence: EVIDENCE,
      targets: [
        { scope: 'global', discoveryRoot: pi.discoveryRoot },
        ...(projectRoot ? [{ scope: 'project' as const, discoveryRoot: path.join(projectRoot, pi.projectPath) }] : []),
      ],
      sharedConsumption,
      isolation: isolation(
        home,
        file,
        canonicalExclusion(shared),
        skills,
        sharedConsumption.status === 'excluded',
      ),
      link: { supported: true },
    };
  },
  planSharedIsolation(home, targets) {
    const pi = resolvePi(targets);
    const shared = resolveShared(targets);
    const file = settingsFile(pi);
    const exclusion = canonicalExclusion(shared);
    const settings = readSettings(file);
    const excluded = sharedExcluded(shared.discoveryRoot, settings.skills);
    const claim = managedClaim(home, file, exclusion);
    const change = !excluded || (claim && !settings.skills.includes(exclusion));
    return {
      file,
      expected: settings.raw,
      sharedRoot: shared.discoveryRoot,
      exclusion,
      change,
      claim: claim || !excluded,
      summary: `Pi will stop consuming Shared skills while Pi Targets remain independently managed.`,
    };
  },
  applySharedIsolation(home, plan) {
    const current = readSettings(plan.file);
    if (current.raw !== plan.expected)
      throw new Error(`Pi settings changed after preview: ${plan.file}`);
    if (plan.change) {
      atomicWrite(plan.file, {
        ...current.value,
        skills: current.skills.includes(plan.exclusion)
          ? current.skills
          : [...current.skills, plan.exclusion],
      });
      const verified = readSettings(plan.file);
      // The plan's canonical exclusion is relative to the Shared root parent; verify its semantics directly.
      if (!sharedExcluded(plan.sharedRoot, verified.skills))
        throw new Error(`Pi isolation was written but semantic verification failed: ${plan.file}`);
    }
    if (plan.claim) {
      const stateFile = path.join(home.configDir, 'state.json');
      const state = readStateFile(stateFile);
      state.piIsolation = { file: plan.file, exclusion: plan.exclusion };
      writeStateFile(stateFile, state);
    }
  },
};
