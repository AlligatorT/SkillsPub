import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkNpxSkillsSource, type NpxManagedSkill } from '../src/npx-skills.ts';
import { sharedRefresh } from '../src/shared.ts';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function rootSkill(sourceUrl: string, skillFolderHash: string): NpxManagedSkill {
  return {
    name: 'codebase-to-course',
    slot: 'codebase-to-course',
    provenance: {
      source: 'zarazhangrui/codebase-to-course',
      sourceUrl,
      skillPath: 'SKILL.md',
    },
    sourceType: 'github',
    skillFolderHash,
  };
}

function initRootSkillRepo(body: string): { repo: string; commit: string; tree: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-root-skill-'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, 'SKILL.md'), body);
  git(repo, ['add', 'SKILL.md']);
  git(repo, ['commit', '-m', 'skill']);
  const commit = git(repo, ['rev-parse', 'HEAD']);
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
  assert.notEqual(commit, tree);
  return { repo, commit, tree };
}

test('unchanged root GitHub Skill with the installer commit hash is current when the tree SHA differs', () => {
  const { repo, commit } = initRootSkillRepo('# skill\n');
  const [checked] = checkNpxSkillsSource([rootSkill(repo, commit)]);
  assert.equal(checked.status, 'current');
  assert.equal(checked.slot, 'codebase-to-course');
});

test('a new upstream root revision that differs from the recorded installer hash is available', () => {
  const { repo, commit } = initRootSkillRepo('# skill\n');
  fs.writeFileSync(path.join(repo, 'SKILL.md'), '# skill\nrevised\n');
  git(repo, ['add', 'SKILL.md']);
  git(repo, ['commit', '-m', 'revise']);
  assert.notEqual(git(repo, ['rev-parse', 'HEAD']), commit);
  const [checked] = checkNpxSkillsSource([rootSkill(repo, commit)]);
  assert.equal(checked.status, 'available');
});

test('normal refresh reports an already-current root Skill as current without rewriting the installer lock', (context) => {
  const { repo, commit } = initRootSkillRepo('# skill\n');
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-root-home-'));
  const configDir = path.join(homeDir, 'config');
  const skillDir = path.join(homeDir, '.agents', 'skills', 'codebase-to-course');
  const lockFile = path.join(homeDir, '.agents', '.skill-lock.json');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# skill\n');
  fs.writeFileSync(lockFile, JSON.stringify({
    version: 3,
    skills: {
      'codebase-to-course': {
        source: 'zarazhangrui/codebase-to-course',
        sourceType: 'github',
        sourceUrl: repo,
        skillPath: 'SKILL.md',
        skillFolderHash: commit,
      },
    },
  }));
  const before = fs.readFileSync(lockFile);
  const previous = {
    HOME: process.env.HOME,
    SKILLSPUB_CONFIG_DIR: process.env.SKILLSPUB_CONFIG_DIR,
  };
  process.env.HOME = homeDir;
  process.env.SKILLSPUB_CONFIG_DIR = configDir;
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const refreshed = sharedRefresh({ configDir });
  assert.equal(refreshed.entries.find((entry) => entry.slot === 'codebase-to-course')?.status, 'current');
  assert.deepEqual(fs.readFileSync(lockFile), before);
});
