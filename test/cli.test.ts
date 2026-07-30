import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLI = path.join(import.meta.dirname, '../src/cli.ts');

function setup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-cli-'));
  const skills = path.join(configDir, 'skills');
  fs.mkdirSync(path.join(skills, 'grilling'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'grilling', 'SKILL.md'), '# grilling');
  fs.writeFileSync(path.join(configDir, 'agents.conf'), `a = ${skills}\n`);
  const run = (args: string[]) =>
    execFileSync('node', [CLI, ...args], {
      env: { ...process.env, SKM_CONFIG_DIR: configDir },
      encoding: 'utf8',
    });
  return { run, skills, configDir };
}

test('ls prints matrix, off moves skill, status shows per-agent state', () => {
  const { run, skills } = setup();
  assert.match(run(['ls']), /grilling\s+on/);

  assert.match(run(['off', 'grilling', 'a']), /grilling @ a: off/);
  assert.ok(fs.existsSync(path.join(skills, '.off', 'grilling', 'SKILL.md')));

  assert.match(run(['status', 'grilling']), /a\s+off/);
  assert.match(run(['agents']), /a\t.*ok/);
});

test('variants are listed distinctly and ambiguous mutations fail', () => {
  const {run, configDir} = setup();
  const other = path.join(configDir, 'other');
  fs.mkdirSync(path.join(other, 'grilling'), {recursive: true});
  fs.writeFileSync(path.join(other, 'grilling', 'SKILL.md'), '# other');
  fs.writeFileSync(
    path.join(configDir, 'agents.conf'),
    `a = ${path.join(configDir, 'skills')}\nb = ${other}\n`,
  );

  const listing = run(['ls']);
  assert.equal(
    listing.split('\n').filter((line) => line.startsWith('grilling (')).length,
    2,
  );
  const status = run(['status', 'grilling']);
  assert.match(status, new RegExp(path.join(configDir, 'skills', 'grilling')));
  assert.match(status, new RegExp(path.join(other, 'grilling')));
  assert.throws(
    () => run(['off', 'grilling', 'a']),
    (error: unknown) => {
      const stderr = String((error as {stderr?: string}).stderr);
      return /ambiguous/.test(stderr) && /Use skm tui/.test(stderr);
    },
  );
});

test('unknown command prints usage and exits 1', () => {
  const { run } = setup();
  assert.throws(() => run(['bogus']));
});
