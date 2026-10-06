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

type TestHooks = {after(callback: () => void): void};

function keep(context: TestHooks, directory: string): string {
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function rootSkill(sourceUrl: string, skillFolderHash: string, ref?: string): NpxManagedSkill {
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
    ...(ref ? { ref } : {}),
  };
}

function initRootSkillRepo(
  body: string,
  context: TestHooks,
): { repo: string; commit: string; tree: string } {
  const repo = keep(context, fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-root-skill-')));
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

test('unchanged root GitHub Skill with the installer commit hash is current when the tree SHA differs', (context) => {
  const { repo, commit } = initRootSkillRepo('# skill\n', context);
  const [checked] = checkNpxSkillsSource([rootSkill(repo, commit)]);
  assert.equal(checked.status, 'current');
  assert.equal(checked.slot, 'codebase-to-course');
});

test('a new upstream root revision that differs from the recorded installer hash is available', (context) => {
  const { repo, commit } = initRootSkillRepo('# skill\n', context);
  fs.writeFileSync(path.join(repo, 'SKILL.md'), '# skill\nrevised\n');
  git(repo, ['add', 'SKILL.md']);
  git(repo, ['commit', '-m', 'revise']);
  assert.notEqual(git(repo, ['rev-parse', 'HEAD']), commit);
  const [checked] = checkNpxSkillsSource([rootSkill(repo, commit)]);
  assert.equal(checked.status, 'available');
});

test('an empty upstream commit is available when the root tree SHA is unchanged', (context) => {
  const { repo, commit, tree } = initRootSkillRepo('# skill\n', context);
  git(repo, ['commit', '--allow-empty', '-m', 'empty']);
  assert.notEqual(git(repo, ['rev-parse', 'HEAD']), commit);
  assert.equal(git(repo, ['rev-parse', 'HEAD^{tree}']), tree);
  const [checked] = checkNpxSkillsSource([rootSkill(repo, commit)]);
  assert.equal(checked.status, 'available');
});

test('a pinned ref stays current after main advances', (context) => {
  const { repo, commit } = initRootSkillRepo('# skill\n', context);
  git(repo, ['branch', 'pinned']);
  fs.writeFileSync(path.join(repo, 'SKILL.md'), '# skill\nmain moved\n');
  git(repo, ['add', 'SKILL.md']);
  git(repo, ['commit', '-m', 'advance main']);
  assert.equal(git(repo, ['rev-parse', 'pinned']), commit);
  assert.notEqual(git(repo, ['rev-parse', 'main']), commit);

  const [pinned] = checkNpxSkillsSource([rootSkill(repo, commit, 'pinned')]);
  assert.equal(pinned.status, 'current');
  const [main] = checkNpxSkillsSource([rootSkill(repo, commit)]);
  assert.equal(main.status, 'available');
});

test('normal refresh reports an already-current root Skill as current without rewriting the installer lock', (context) => {
  const { repo, commit } = initRootSkillRepo('# skill\n', context);
  const homeDir = keep(context, fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-root-home-')));
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
