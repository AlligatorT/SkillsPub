import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Home } from '../core.ts';
import type { SkillTarget, TargetDefinition, TargetScope } from '../inventory.ts';

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

export interface HarnessInspection {
  key: string;
  name: string;
  detected: boolean;
  support: SupportLevel;
  evidence: readonly HarnessEvidence[];
  targets: ResolvedHarnessTarget[];
  sharedConsumption: { status: SharedConsumption; detail: string };
  link: { supported: boolean };
}

export interface HarnessAdapter {
  key: string;
  targetDefinition(): TargetDefinition;
  inspect(home: Home, targets: SkillTarget[], projectPath?: string): HarnessInspection;
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

function piHome(target: SkillTarget): string {
  return path.dirname(path.dirname(target.discoveryRoot));
}

function readSettings(file: string): { skills?: string[]; error?: string } {
  if (!fs.existsSync(file)) return {};
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { error: `Pi settings at ${file} must be an object` };
    const skills = (value as { skills?: unknown }).skills;
    if (skills === undefined) return {};
    if (!Array.isArray(skills) || skills.some((item) => typeof item !== 'string'))
      return { error: `Pi settings at ${file} has unsupported skills configuration` };
    return { skills };
  } catch (error) {
    return { error: `cannot read Pi settings at ${file}: ${(error as Error).message}` };
  }
}

function expandHome(value: string): string {
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}

function matches(root: string, pattern: string, base: string): boolean {
  const absolute = path.resolve(pattern.startsWith('~') ? expandHome(pattern) : path.join(base, pattern));
  return path.matchesGlob(path.resolve(root), absolute);
}

function inspectShared(
  pi: SkillTarget,
  shared: SkillTarget | undefined,
  projectPath?: string,
): HarnessInspection['sharedConsumption'] {
  const roots = [shared?.discoveryRoot ?? path.join(os.homedir(), '.agents', 'skills')];
  if (projectPath) roots.push(path.join(projectPath, shared?.projectPath ?? '.agents/skills'));
  const settings = [path.join(piHome(pi), 'agent', 'settings.json')];
  if (projectPath) settings.push(path.join(projectPath, '.pi', 'settings.json'));
  const excluded = new Map<string, string>();
  for (const file of settings) {
    const parsed = readSettings(file);
    if (parsed.error) return { status: 'unknown', detail: parsed.error };
    for (const entry of parsed.skills ?? []) {
      if (!entry.startsWith('!') && !entry.startsWith('-')) continue;
      for (const root of roots) {
        if (matches(root, entry.slice(1), path.dirname(file))) excluded.set(root, `${file}: ${entry}`);
      }
    }
  }
  if (excluded.size === roots.length)
    return { status: 'excluded', detail: `Pi Shared skills are excluded: ${[...excluded.values()].join(', ')}` };
  const exclusions = excluded.size > 0
    ? `; excludes ${[...excluded.keys()].join(', ')}`
    : '';
  return { status: 'enabled', detail: `Pi discovers Shared skills at ${roots.join(', ')}${exclusions}` };
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
    };
  },
  inspect(_home, targets, projectPath) {
    const pi = targets.find(({ key }) => key === 'pi') ?? this.targetDefinition();
    const shared = targets.find(({ key, kind }) => key === 'shared' && kind === 'shared');
    const projectRoot = projectPath ? path.resolve(projectPath) : undefined;
    const settings = path.join(piHome(pi), 'agent', 'settings.json');
    const detected = fs.existsSync(pi.discoveryRoot) || fs.existsSync(settings) ||
      fs.existsSync(piHome(pi)) || Boolean(projectRoot && fs.existsSync(path.join(projectRoot, '.pi')));
    return {
      key: 'pi',
      name: 'Pi',
      detected,
      support: 'discoverable',
      evidence: EVIDENCE,
      targets: [
        { scope: 'global', discoveryRoot: pi.discoveryRoot },
        ...(projectRoot ? [{ scope: 'project' as const, discoveryRoot: path.join(projectRoot, pi.projectPath) }] : []),
      ],
      sharedConsumption: inspectShared(pi, shared, projectRoot),
      link: { supported: true },
    };
  },
};
