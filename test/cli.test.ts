import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { shouldRunTui } from '../src/cli.ts';

const CLI = path.join(import.meta.dirname, '../src/cli.ts');

function runProcess(args: string[]) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-'));
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
}

function setup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-'));
  const skills = path.join(configDir, 'skills');
  fs.mkdirSync(path.join(skills, 'grilling'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'grilling', 'SKILL.md'), '# grilling');
  fs.writeFileSync(path.join(configDir, 'agents.conf'), `a = ${skills}\n`);
  const run = (args: string[]) =>
    execFileSync('node', [CLI, ...args], {
      env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
      encoding: 'utf8',
    });
  return { run, skills };
}

test('ls prints matrix, off moves skill, status shows per-agent state', () => {
  const { run, skills } = setup();
  assert.match(run(['ls']), /grilling\s+on/);

  assert.match(run(['off', 'grilling', 'a']), /grilling @ a: off/);
  assert.ok(fs.existsSync(path.join(skills, '.off', 'grilling', 'SKILL.md')));

  assert.match(run(['status', 'grilling']), /a\s+off/);
  assert.match(run(['agents']), /a\t.*ok/);
});

test('entry point routes bare TTY and explicit tui to the TUI', () => {
  assert.equal(shouldRunTui(undefined, true, true), true);
  assert.equal(shouldRunTui(undefined, true, false), false);
  assert.equal(shouldRunTui(undefined, false, true), false);
  assert.equal(shouldRunTui('tui', false, false), true);
});

test('bare non-TTY invocation prints canonical usage without terminal control output', () => {
  const result = runProcess([]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^SkillsPub/);
  assert.match(result.stderr, /skillspub tui/);
  assert.doesNotMatch(result.stderr, /\x1b/);
});

test('installed executable symlink runs the entry point', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-bin-'));
  const executable = path.join(dir, 'skillspub');
  fs.symlinkSync(CLI, executable);
  const result = spawnSync(executable, {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: path.join(dir, 'config') },
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /^SkillsPub/);
});

test('explicit tui rejects non-TTY and unexpected arguments clearly', () => {
  const nonTty = runProcess(['tui']);
  assert.equal(nonTty.status, 1);
  assert.match(
    nonTty.stderr,
    /skillspub: skillspub tui requires an interactive terminal/,
  );
  assert.doesNotMatch(nonTty.stderr, /\x1b/);

  const extra = runProcess(['tui', 'extra']);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /skillspub: usage: skillspub tui/);
});

test('renamed diagnostics use only the canonical identity', () => {
  const result = runProcess(['on']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skillspub: usage: skillspub on/);
  assert.doesNotMatch(result.stderr, /\bskm\b/);
});

test('unknown command prints usage and exits 1', () => {
  const { run } = setup();
  assert.throws(() => run(['bogus']));
});
