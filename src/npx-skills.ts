import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  sourceType?: string;
  ref?: string;
  skillFolderHash?: string;
  computedHash?: string;
}

export type NpxSkillsUpdateStatus = 'current' | 'available' | 'upstream-missing';

export interface NpxSkillsUpdateCheck {
  slot: string;
  status: NpxSkillsUpdateStatus | 'check-failed';
  error?: string;
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
    for (const field of [
      'source', 'sourceUrl', 'skillPath', 'sourceType', 'ref', 'skillFolderHash', 'computedHash',
    ] as const) {
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
      ...(entry.sourceType ? { sourceType: entry.sourceType as string } : {}),
      ...(entry.ref ? { ref: entry.ref as string } : {}),
      ...(entry.skillFolderHash ? { skillFolderHash: entry.skillFolderHash as string } : {}),
      ...(entry.computedHash ? { computedHash: entry.computedHash as string } : {}),
    };
  });
}

function sourceLocation(skill: NpxManagedSkill): string | undefined {
  if (skill.provenance.sourceUrl) return skill.provenance.sourceUrl;
  const source = skill.provenance.source;
  if ((!skill.sourceType || skill.sourceType === 'github') && source &&
      /^[^/\s]+\/[^/\s]+$/.test(source))
    return `https://github.com/${source}.git`;
  return undefined;
}

export function npxSkillsSourceKey(skill: NpxManagedSkill): string | undefined {
  const location = sourceLocation(skill);
  return location ? JSON.stringify([location, skill.ref ?? '']) : undefined;
}

function skillFolder(skillPath: string): string {
  const normalized = skillPath.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || normalized.includes('\0') ||
      normalized.split('/').some((part) => part === '..') || normalized.includes(':') ||
      path.posix.basename(normalized).toLowerCase() !== 'skill.md')
    throw new Error(`unsafe installer skillPath: ${skillPath}`);
  return path.posix.dirname(normalized);
}

function computeNpxSkillsFolderHash(root: string): string {
  const files: Array<{ relativePath: string; content: Buffer }> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push({
        relativePath: path.relative(root, file).split(path.sep).join('/'),
        content: fs.readFileSync(file),
      });
    }
  };
  visit(root);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(file.relativePath).update(file.content);
  return hash.digest('hex');
}

export function checkNpxSkillsSource(skills: NpxManagedSkill[]): NpxSkillsUpdateCheck[] {
  if (skills.length === 0) return [];
  const source = sourceLocation(skills[0]);
  const key = npxSkillsSourceKey(skills[0]);
  if (!source || !key || skills.some((skill) => npxSkillsSourceKey(skill) !== key))
    throw new Error('installer lock has no consistent remote source');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-refresh-'));
  const checkout = path.join(temporary, 'source');
  try {
    const args = ['clone', '--quiet', '--depth', '1'];
    if (skills[0].ref) args.push('--branch', skills[0].ref);
    args.push('--', source, checkout);
    const cloned = spawnSync('git', args, {
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: 'pipe',
      timeout: 30_000,
    });
    if (cloned.error) throw cloned.error;
    if (cloned.status !== 0)
      throw new Error(`git clone failed: ${(cloned.stderr || `exit ${cloned.status ?? 1}`).trim()}`);
    return skills.map((skill) => {
      try {
        const expectedHash = skill.computedHash ?? skill.skillFolderHash;
        if (!skill.provenance.skillPath || !expectedHash)
          throw new Error(`${skill.name}: installer lock lacks skillPath or content hash`);
        const folder = skillFolder(skill.provenance.skillPath);
        const directory = path.join(checkout, folder);
        if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory())
          return { slot: skill.slot, status: 'upstream-missing' };
        let latestHash: string;
        if (!skill.computedHash && (!skill.sourceType || skill.sourceType === 'github')) {
          const revision = folder === '.' ? 'HEAD^{tree}' : `HEAD:${folder}`;
          const result = spawnSync('git', ['-C', checkout, 'rev-parse', '--verify', revision], {
            encoding: 'utf8',
            stdio: 'pipe',
          });
          if (result.error) throw result.error;
          if (result.status !== 0) return { slot: skill.slot, status: 'upstream-missing' };
          latestHash = result.stdout.trim();
        } else latestHash = computeNpxSkillsFolderHash(directory);
        return {
          slot: skill.slot,
          status: latestHash === expectedHash ? 'current' : 'available',
        };
      } catch (error) {
        return { slot: skill.slot, status: 'check-failed', error: (error as Error).message };
      }
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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
