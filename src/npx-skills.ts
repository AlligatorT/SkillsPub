import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

export const NPX_SKILLS_PACKAGE = 'skills@1.5.21';

export interface NpxSkillsCandidate {
  source: string;
  name: string;
  installs?: string;
  detailUrl: string;
}

export interface NpxSkillsProvenance {
  source?: string;
  sourceUrl?: string;
  skillPath?: string;
}

export interface NpxManagedSkill {
  name: string;
  slot: string;
  provenance: NpxSkillsProvenance;
}

export interface NpxSkillsRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

const SHARED_TARGET_TRANSPORT = ['--agent', 'codex'];

export function normalizeNpxSkillsName(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .substring(0, 255) || 'unnamed-skill';
}

export function parseNpxSkillsFindOutput(raw: string): {
  candidates: NpxSkillsCandidate[];
  complete: boolean;
  raw: string;
} {
  const lines = stripVTControlCharacters(raw).split(/\r?\n/);
  const candidates: NpxSkillsCandidate[] = [];
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

export function runNpxSkills(
  args: string[],
  cwd: string,
  capture = false,
): NpxSkillsRunResult {
  const result = spawnSync('npx', ['--yes', NPX_SKILLS_PACKAGE, ...args], {
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

export function npxSkillsFindArgs(query: string[]): string[] {
  return ['find', ...query];
}

export function npxSkillsDescribeArgs(source: string): string[] {
  return ['add', source, '--list'];
}

export function npxSkillsAddArgs(source: string, name: string, global: boolean): string[] {
  return ['add', source, '--skill', name, ...SHARED_TARGET_TRANSPORT, ...(global ? ['--global'] : []), '--copy'];
}

export function npxSkillsUpdateArgs(names: string[], global: boolean): string[] {
  return ['update', ...names, ...(global ? ['--global'] : [])];
}

export function npxSkillsRemoveArgs(names: string[], global: boolean): string[] {
  return ['remove', ...names, ...SHARED_TARGET_TRANSPORT, ...(global ? ['--global'] : [])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readNpxSkillsLock(file: string): NpxManagedSkill[] {
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
    const slot = normalizeNpxSkillsName(name);
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

export function npxSkillsProvenanceLabel(provenance?: NpxSkillsProvenance): string {
  return provenance?.source ?? provenance?.sourceUrl ?? provenance?.skillPath ?? 'Source unknown';
}

export function sameNpxSkillsSource(
  source: string,
  skillName: string,
  provenance?: NpxSkillsProvenance,
): boolean {
  if (!provenance) return false;
  const requested = sourceParts(source);
  const sourceMatches = [provenance.source, provenance.sourceUrl]
    .some((value) => value && sourceParts(value).source === requested.source);
  if (!sourceMatches) return false;
  if (!provenance.skillPath) return requested.skill === undefined;
  const storedSkill = provenanceSkillName(provenance.skillPath);
  if (!storedSkill) return requested.skill === undefined;
  const requestedSkill = normalizeNpxSkillsName(requested.skill ?? skillName);
  return normalizeNpxSkillsName(storedSkill) === requestedSkill;
}
