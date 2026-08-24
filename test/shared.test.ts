import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NPX_SKILLS_PACKAGE,
  parseNpxSkillsFindOutput,
  readNpxSkillsLock,
} from '../src/npx-skills.ts';
import { hashDirectory } from '../src/inventory.ts';

const CLI = path.join(import.meta.dirname, '../src/cli.ts');
const ACTUAL_SKILLS_CLI = path.join(import.meta.dirname, '../node_modules/skills/bin/cli.mjs');
const PACKAGE = NPX_SKILLS_PACKAGE;
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'npx-skills');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-shared-'));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'npx.jsonl');
  const gitLog = path.join(root, 'git.jsonl');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const npx = path.join(bin, 'npx');
  fs.writeFileSync(npx, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPX_LOG, JSON.stringify({ args, cwd: process.cwd(), xdgStateHome: process.env.XDG_STATE_HOME }) + '\\n');
const command = args[2];
const sanitize = (name) => name.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^[.\\-]+|[.\\-]+$/g, '').substring(0, 255) || 'unnamed-skill';
if (command === 'find') {
  process.stdout.write(process.env.NPX_STDOUT || '');
  process.stderr.write(process.env.NPX_STDERR || '');
  process.exit(Number(process.env.NPX_FAIL || 0));
}
if (command === 'add' && args.includes('--list')) {
  process.stdout.write(process.env.NPX_STDOUT || '');
  process.stderr.write(process.env.NPX_STDERR || '');
  process.exit(Number(process.env.NPX_FAIL || 0));
}
const global = args.includes('--global');
const base = global ? process.env.HOME : process.cwd();
const skillsRoot = path.join(base, '.agents', 'skills');
const lockFile = global
  ? path.join(process.env.HOME, '.agents', '.skill-lock.json')
  : path.join(process.cwd(), 'skills-lock.json');
const readLock = () => {
  try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); }
  catch { return { version: 3, skills: {} }; }
};
if (command === 'add') {
  if (process.env.NPX_FAIL) process.exit(Number(process.env.NPX_FAIL));
  const requestedName = args[args.indexOf('--skill') + 1];
  const name = sanitize(requestedName);
  const source = args[3];
  fs.mkdirSync(path.join(skillsRoot, name), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, name, 'SKILL.md'), '# ' + source + '\\n');
  if (!process.env.NPX_NO_LOCK) {
    const lock = readLock();
    lock.skills[name] = { source, sourceUrl: 'https://github.com/' + source + '.git', skillPath: 'skills/' + name };
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify(lock));
  }
} else if (command === 'update') {
  const names = args.slice(3).filter((arg) => !arg.startsWith('-'));
  for (const name of names) {
    if (!fs.existsSync(path.join(skillsRoot, sanitize(name), 'SKILL.md'))) process.exit(91);
  }
  if (process.env.NPX_FAIL) process.exit(Number(process.env.NPX_FAIL));
} else if (command === 'remove') {
  const names = args.slice(3, args.indexOf('--agent')).filter((arg) => !arg.startsWith('-'));
  if (process.env.NPX_FAIL) process.exit(Number(process.env.NPX_FAIL));
  const lock = readLock();
  for (const name of names) {
    fs.rmSync(path.join(skillsRoot, sanitize(name)), { recursive: true, force: true });
    delete lock.skills[name];
  }
  fs.writeFileSync(lockFile, JSON.stringify(lock));
}
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GIT_LOG, JSON.stringify({ args }) + '\\n');
const trees = JSON.parse(process.env.GIT_TREES || '{}');
const files = JSON.parse(process.env.GIT_FILES || '{}');
if (args[0] === 'clone') {
  const source = args.at(-2);
  const destination = args.at(-1);
  if (!trees[source]) process.exit(1);
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(destination + '.source', source);
  for (const folder of Object.keys(trees[source]))
    if (folder !== '.') fs.mkdirSync(path.join(destination, folder), { recursive: true });
  for (const [file, content] of Object.entries(files[source] || {})) {
    const destinationFile = path.join(destination, file);
    fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
    fs.writeFileSync(destinationFile, content);
  }
  process.exit(0);
}
if (args[0] === '-C' && args[2] === 'rev-parse') {
  const source = fs.readFileSync(args[1] + '.source', 'utf8');
  const revision = args.at(-1);
  const folder = revision === 'HEAD^{tree}' ? '.' : revision.slice('HEAD:'.length);
  const hash = trees[source]?.[folder];
  if (!hash) process.exit(1);
  process.stdout.write(hash + '\\n');
  process.exit(0);
}
process.exit(2);
`, { mode: 0o755 });

  const env = {
    ...process.env,
    HOME: home,
    SKILLSPUB_CONFIG_DIR: config,
    NPX_LOG: log,
    GIT_LOG: gitLog,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  const calls = () => fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const gitCalls = () => fs.existsSync(gitLog)
    ? fs.readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { root, home, config, log, gitLog, run, calls, gitCalls };
}

function writeSkill(root: string, name: string, body = '# skill') {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), body);
}

function writeLock(file: string, skills: Record<string, object>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 3, skills }));
}

test('pinned skills@1.5.21 writes a local-source Global add only to the Shared Target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-upstream-contract-'));
  const home = path.join(root, 'home');
  const source = path.join(root, 'source', 'actual-contract');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), [
    '---',
    'name: actual-contract',
    'description: pinned contract',
    '---',
    '# Contract',
  ].join('\n'));
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(import.meta.dirname, '../node_modules/skills/package.json'),
    'utf8',
  ));
  assert.equal(packageJson.version, '1.5.21');

  const result = spawnSync('node', [
    ACTUAL_SKILLS_CLI,
    'add', path.dirname(source),
    '--skill', 'actual-contract',
    '--agent', 'codex',
    '--global',
    '--copy',
    '--yes',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_STATE_HOME: undefined },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'actual-contract', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(home, '.agents', '.skill-lock.json')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
  assert.equal(fs.existsSync(path.join(home, '.pi')), false);
});

test('shared find preserves source + name candidates and falls back to raw output', () => {
  const output = fs.readFileSync(path.join(FIXTURES, 'find-output.txt'), 'utf8');
  assert.deepEqual(parseNpxSkillsFindOutput(output).candidates, [
    { source: 'one/repo', name: 'same', installs: '12K installs', detailUrl: 'https://skills.sh/one/repo/same' },
    { source: 'two/repo', name: 'same', installs: '8 installs', detailUrl: 'https://skills.sh/two/repo/same' },
  ]);
  assert.equal(parseNpxSkillsFindOutput('changed upstream output').candidates.length, 0);
  const mixed = `Install with npx skills add <owner/repo@skill>\n${output}\nCHANGED RESULT\nCHANGED DETAIL`;
  assert.equal(parseNpxSkillsFindOutput(mixed).complete, false);

  const lock = readNpxSkillsLock(path.join(FIXTURES, 'lock-v3.json'));
  assert.deepEqual(lock, [{
    name: 'Foo@Bar',
    slot: 'foo-bar',
    provenance: {
      source: 'owner/repo',
      sourceUrl: 'https://github.com/owner/repo.git',
      skillPath: 'skills/foo-bar',
    },
  }]);

  const { run, calls } = setup();
  const result = run(['shared', 'find', 'test query'], { NPX_STDOUT: output });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /one\/repo@same\t12K installs/);
  assert.match(result.stdout, /two\/repo@same\t8 installs/);
  assert.deepEqual(calls()[0].args, ['--yes', PACKAGE, 'find', 'test query']);
});

test('shared read-only commands return structured JSON without stream leakage', () => {
  const { root, run } = setup();
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const output = fs.readFileSync(path.join(FIXTURES, 'find-output.txt'), 'utf8');
  const commands = [
    ['shared', 'find', 'same'],
    ['shared', 'describe', 'owner/repo'],
    ['project', project, 'shared', 'find', 'same'],
    ['project', project, 'shared', 'describe', 'owner/repo'],
  ];

  for (const args of commands) {
    const result = run([...args, '--json'], {
      NPX_STDOUT: args.includes('find') ? `\x1b[31m${output}\x1b[0m` : '\x1b[31mAvailable Skills\x1b[0m\n',
      NPX_STDERR: '\x1b[33mupstream warning\x1b[0m\n',
    });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.stdout}`);
    assert.equal(result.stderr, '', args.join(' '));
    assert.equal(result.stdout.trim().split('\n').length, 1, args.join(' '));
    const document = JSON.parse(result.stdout);
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.ok, true);
    assert.deepEqual(document.data.warnings, ['upstream warning']);
    assert.doesNotMatch(result.stdout, /\x1b/);
    if (args.includes('find')) assert.equal(document.data.candidates.length, 2);
    else assert.equal(document.data.output, 'Available Skills\n');
  }

  const fallback = run(['shared', 'find', 'changed', '--json'], {
    NPX_STDOUT: '\x1b]8;;https://example.com\x07changed upstream output\x1b]8;;\x07',
  });
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(fallback.stderr, '');
  const fallbackData = JSON.parse(fallback.stdout).data;
  assert.deepEqual(fallbackData.candidates, []);
  assert.equal(fallbackData.raw, 'changed upstream output');
  assert.doesNotMatch(fallback.stdout, /\x1b/);
});

test('shared add writes only the Global or exact Project Shared Target', () => {
  const global = setup();
  const added = global.run(
    ['shared', 'add', 'owner/repo', '--skill', 'Example'],
    { XDG_STATE_HOME: path.join(global.root, 'xdg-state') },
  );
  assert.equal(added.status, 0, added.stderr);
  assert.ok(fs.existsSync(path.join(global.home, '.agents', 'skills', 'example', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(global.home, '.claude')), false);
  assert.equal(fs.existsSync(path.join(global.home, '.pi')), false);
  assert.equal(global.calls()[0].xdgStateHome, undefined);
  assert.deepEqual(global.calls()[0].args, [
    '--yes', PACKAGE, 'add', 'owner/repo', '--skill', 'Example',
    '--agent', 'codex', '--global', '--copy',
  ]);

  const projectSetup = setup();
  const project = path.join(projectSetup.root, 'project');
  fs.mkdirSync(project);
  const projectAdded = projectSetup.run([
    'project', project, 'shared', 'add', 'owner/repo', '--skill', 'Example',
  ]);
  assert.equal(projectAdded.status, 0, projectAdded.stderr);
  assert.ok(fs.existsSync(path.join(project, '.agents', 'skills', 'example', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(project, 'skills-lock.json')));
  assert.equal(projectSetup.calls()[0].cwd, fs.realpathSync(project));
  assert.deepEqual(projectSetup.calls()[0].args, [
    '--yes', PACKAGE, 'add', 'owner/repo', '--skill', 'Example',
    '--agent', 'codex', '--copy',
  ]);
});

test('shared describe passes through pinned add --list output', () => {
  const { run, calls } = setup();
  const output = 'Available Skills\nexample\n  Example description\n';
  const result = run(['shared', 'describe', 'owner/repo'], { NPX_STDOUT: output });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, output);
  assert.deepEqual(calls()[0].args, ['--yes', PACKAGE, 'add', 'owner/repo', '--list']);
});

test('shared add uses the upstream normalized Slot name', () => {
  const { home, run } = setup();
  const result = run(['shared', 'add', 'owner/repo', '--skill', 'Foo@Bar']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'foo-bar', 'SKILL.md')));
});

test('managed lock names use upstream normalization and reject Slot collisions', () => {
  const one = setup();
  writeSkill(path.join(one.home, '.agents', 'skills'), 'foo-bar');
  writeLock(path.join(one.home, '.agents', '.skill-lock.json'), {
    'Foo@Bar': { source: 'owner/repo' },
  });
  const removed = one.run(['shared', 'remove', 'Foo@Bar']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(path.join(one.home, '.agents', 'skills', 'foo-bar')), false);

  const collision = setup();
  writeSkill(path.join(collision.home, '.agents', 'skills'), 'foo-bar');
  writeLock(path.join(collision.home, '.agents', '.skill-lock.json'), {
    'Foo@Bar': { source: 'owner/one' },
    'Foo#Bar': { source: 'owner/two' },
  });
  const refused = collision.run(['shared', 'update']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /duplicate normalized lock skill: foo-bar/);
  assert.equal(collision.calls().length, 0);
});

test('shared add accepts direct sources that upstream does not lock', () => {
  const { home, config, run } = setup();
  const result = run(
    ['shared', 'add', 'https://example.test/skill.md', '--skill', 'direct'],
    { NPX_NO_LOCK: '1' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'direct', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(home, '.agents', '.skill-lock.json')), false);
  const state = JSON.parse(fs.readFileSync(path.join(config, 'state.json'), 'utf8'));
  assert.equal(state.baseIntent['global:shared\0direct'], 'on');
});

test('shared add accepts matching root-level lock provenance without replacement', () => {
  const { home, run } = setup();
  const root = path.join(home, '.agents', 'skills');
  writeSkill(root, 'same', '# old');
  writeLock(path.join(home, '.agents', '.skill-lock.json'), {
    same: { source: 'owner/repo', skillPath: 'SKILL.md' },
  });

  const result = run(['shared', 'add', 'owner/repo', '--skill', 'same']);
  assert.equal(result.status, 0, result.stderr);
});

test('shared add previews a source replacement and requires --replace', () => {
  const { home, run, calls } = setup();
  const root = path.join(home, '.agents', 'skills');
  const lock = path.join(home, '.agents', '.skill-lock.json');
  writeSkill(root, 'same', '# old');
  writeLock(lock, { same: { source: 'old/repo', sourceUrl: 'https://github.com/old/repo.git' } });

  const refused = run(['shared', 'add', 'new/repo', '--skill', 'same']);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /Replace: old\/repo -> new\/repo/);
  assert.match(refused.stderr, /requires --replace/);
  assert.equal(calls().length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'same', 'SKILL.md'), 'utf8'), '# old');

  const replaced = run(['shared', 'add', 'new/repo', '--skill', 'same', '--replace']);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.doesNotMatch(JSON.stringify(calls()[0].args), /--replace/);
  assert.equal(calls()[0].args.slice(3).includes('--yes'), false);
});

test('failed shared update restores desired OFF entries and releases the operation lock', () => {
  const { home, config, run, calls } = setup();
  const discovery = path.join(home, '.agents', 'skills');
  const parking = path.join(home, '.agents', '.skillspub-off', 'skills');
  const lock = path.join(home, '.agents', '.skill-lock.json');
  writeSkill(parking, 'off-skill');
  writeLock(lock, { 'off-skill': { source: 'owner/repo' } });
  fs.mkdirSync(config, { recursive: true });
  const slot = 'global:shared\0off-skill';
  const stateFile = path.join(config, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ baseIntent: { [slot]: 'off' }, claims: {} }));
  const before = fs.readFileSync(stateFile, 'utf8');

  const result = run(['shared', 'update', 'off-skill'], { NPX_FAIL: '7' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skills update failed/);
  assert.match(result.stderr, /Remaining drift:/);
  assert.ok(fs.existsSync(path.join(parking, 'off-skill', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(discovery, 'off-skill')), false);
  assert.equal(fs.existsSync(`${lock}.skillspub-operation-lock`), false);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).baseIntent[slot], JSON.parse(before).baseIntent[slot]);
  assert.deepEqual(calls()[0].args, ['--yes', PACKAGE, 'update', 'off-skill', '--global']);
});

test('spawn errors still restore desired OFF entries and report Actual state', () => {
  const { root, home, config, run } = setup();
  const discovery = path.join(home, '.agents', 'skills');
  const parking = path.join(home, '.agents', '.skillspub-off', 'skills');
  const lock = path.join(home, '.agents', '.skill-lock.json');
  writeSkill(parking, 'off-skill');
  writeLock(lock, { 'off-skill': { source: 'owner/repo' } });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({
    baseIntent: { ['global:shared\0off-skill']: 'off' },
    claims: {},
  }));
  const bin = path.join(root, 'bin');
  fs.chmodSync(path.join(bin, 'npx'), 0o644);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));

  const result = run(['shared', 'update', 'off-skill'], { PATH: bin });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skills update failed/);
  assert.match(result.stderr, /Actual: off-skill=off\/local/);
  assert.ok(fs.existsSync(path.join(parking, 'off-skill', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(discovery, 'off-skill')), false);
  assert.equal(fs.existsSync(`${lock}.skillspub-operation-lock`), false);
});

test('Project shared update uses the exact directory and reparks OFF entries', () => {
  const { root, run, calls } = setup();
  const project = path.join(root, 'project');
  const discovery = path.join(project, '.agents', 'skills');
  const parking = path.join(project, '.skillspub', 'off', 'shared');
  writeSkill(parking, 'off-skill');
  writeLock(path.join(project, 'skills-lock.json'), { 'off-skill': { source: 'owner/repo' } });
  fs.mkdirSync(path.join(project, '.skillspub'), { recursive: true });
  fs.writeFileSync(path.join(project, '.skillspub', 'state.json'), JSON.stringify({
    baseIntent: { [`project:${fs.realpathSync(project)}:shared\0off-skill`]: 'off' },
    claims: {},
  }));

  const result = run(['project', project, 'shared', 'update']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(parking, 'off-skill', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(discovery, 'off-skill')), false);
  assert.equal(calls()[0].cwd, fs.realpathSync(project));
  assert.deepEqual(calls()[0].args, ['--yes', PACKAGE, 'update', 'off-skill']);
});

test('mutation preflight rejects malformed policy state and non-v3 installer locks', () => {
  const malformedState = setup();
  fs.mkdirSync(malformedState.config, { recursive: true });
  fs.writeFileSync(path.join(malformedState.config, 'state.json'), JSON.stringify({ baseIntent: [] }));
  const add = malformedState.run(['shared', 'add', 'owner/repo', '--skill', 'example']);
  assert.equal(add.status, 1);
  assert.match(add.stderr, /invalid state baseIntent/);
  assert.equal(malformedState.calls().length, 0);

  const staleLock = setup();
  writeSkill(path.join(staleLock.home, '.agents', 'skills'), 'managed');
  const lock = path.join(staleLock.home, '.agents', '.skill-lock.json');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ skills: { managed: { source: 'owner/repo' } } }));
  const remove = staleLock.run(['shared', 'remove', 'managed']);
  assert.equal(remove.status, 1);
  assert.match(remove.stderr, /lock\.version must be 3/);
  assert.equal(staleLock.calls().length, 0);
  assert.ok(fs.existsSync(path.join(staleLock.home, '.agents', 'skills', 'managed', 'SKILL.md')));
});

test('Shared Target operation lock prevents concurrent mutation or refresh', () => {
  const { home, run, calls, gitCalls } = setup();
  const lock = path.join(home, '.agents', '.skill-lock.json');
  writeSkill(path.join(home, '.agents', 'skills'), 'managed');
  writeLock(lock, { managed: { source: 'owner/repo' } });
  fs.writeFileSync(`${lock}.skillspub-operation-lock`, 'busy\n');

  const result = run(['shared', 'update', 'managed']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /operation already in progress/);
  const refresh = run(['shared', 'refresh']);
  assert.equal(refresh.status, 1);
  assert.match(refresh.stderr, /operation already in progress/);
  assert.equal(calls().length, 0);
  assert.equal(gitCalls().length, 0);
});

test('active Preset claims keep updated skills ON and block remove', () => {
  const { home, config, run } = setup();
  const discovery = path.join(home, '.agents', 'skills');
  const parking = path.join(home, '.agents', '.skillspub-off', 'skills');
  writeSkill(parking, 'claimed');
  writeLock(path.join(home, '.agents', '.skill-lock.json'), { claimed: { source: 'owner/repo' } });
  fs.mkdirSync(config, { recursive: true });
  const slot = 'global:shared\0claimed';
  fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({
    baseIntent: { [slot]: 'off' },
    claims: { [slot]: ['preset:tools'] },
  }));

  const updated = run(['shared', 'update', 'claimed']);
  assert.equal(updated.status, 0, updated.stderr);
  assert.ok(fs.existsSync(path.join(discovery, 'claimed', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(parking, 'claimed')), false);

  const removed = run(['shared', 'remove', 'claimed']);
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /cannot remove claimed Target Slot/);
  assert.ok(fs.existsSync(path.join(discovery, 'claimed', 'SKILL.md')));
});

test('orphaned Preset lastClaims also keep updated skills ON and block remove', () => {
  const { home, config, run } = setup();
  const discovery = path.join(home, '.agents', 'skills');
  const parking = path.join(home, '.agents', '.skillspub-off', 'skills');
  writeSkill(parking, 'orphaned');
  writeLock(path.join(home, '.agents', '.skill-lock.json'), { orphaned: { source: 'owner/repo' } });
  fs.mkdirSync(config, { recursive: true });
  const slot = 'global:shared\0orphaned';
  fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({
    baseIntent: { [slot]: 'off' },
    claims: {},
    lastClaims: { deleted: [slot] },
  }));

  const updated = run(['shared', 'update', 'orphaned']);
  assert.equal(updated.status, 0, updated.stderr);
  assert.ok(fs.existsSync(path.join(discovery, 'orphaned', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(parking, 'orphaned')), false);

  const removed = run(['shared', 'remove', 'orphaned']);
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /cannot remove claimed Target Slot/);
});

test('shared remove previews and confirms dependent Link and Mirror cascades', () => {
  const { home, config, run, calls } = setup();
  const discovery = path.join(home, '.agents', 'skills');
  const source = path.join(discovery, 'managed');
  const consumer = path.join(config, 'consumer');
  const mirror = path.join(consumer, 'mirror');
  const linked = path.join(consumer, 'linked');
  writeSkill(discovery, 'managed');
  writeLock(path.join(home, '.agents', '.skill-lock.json'), { managed: { source: 'owner/repo' } });
  fs.mkdirSync(consumer, { recursive: true });
  fs.symlinkSync(source, linked, 'dir');
  writeSkill(consumer, 'mirror');
  fs.writeFileSync(path.join(config, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [],
    genericTargets: [{
      key: 'consumer',
      kind: 'generic',
      discoveryRoot: consumer,
      parkingRoot: path.join(config, 'consumer-off'),
      projectPath: '.consumer',
    }],
  }));
  fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({
    mirrors: {
      'global:consumer\0mirror': { sourceId: fs.realpathSync(source), hash: hashDirectory(source) },
    },
  }));

  const preview = run(['shared', 'remove', 'managed']);
  assert.equal(preview.status, 1);
  assert.match(preview.stdout, /Removal plan:/);
  assert.match(preview.stdout, /global:consumer.*linked/);
  assert.match(preview.stdout, /global:consumer.*mirror/);
  assert.match(preview.stdout, /projects outside this scan may retain broken Links/);
  assert.match(preview.stderr, /dependent Relationships will also be deleted.*--yes/);
  assert.ok(fs.existsSync(source));
  assert.ok(fs.lstatSync(linked).isSymbolicLink());
  assert.ok(fs.existsSync(mirror));
  assert.equal(calls().length, 0);

  const removed = run(['shared', 'remove', 'managed', '--yes']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(linked), false);
  assert.equal(fs.existsSync(mirror), false);
  const state = JSON.parse(fs.readFileSync(path.join(config, 'state.json'), 'utf8'));
  assert.equal(state.mirrors, undefined);
});

test('shared remove cascades dependencies while the Shared source is OFF', () => {
  const { home, config, run } = setup();
  const parking = path.join(home, '.agents', '.skillspub-off', 'skills');
  const source = path.join(parking, 'managed');
  const consumer = path.join(config, 'consumer');
  writeSkill(parking, 'managed');
  writeLock(path.join(home, '.agents', '.skill-lock.json'), { managed: { source: 'owner/repo' } });
  fs.mkdirSync(consumer, { recursive: true });
  const linked = path.join(consumer, 'linked');
  fs.symlinkSync(source, linked, 'dir');
  fs.writeFileSync(path.join(config, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [],
    genericTargets: [{
      key: 'consumer',
      kind: 'generic',
      discoveryRoot: consumer,
      parkingRoot: path.join(config, 'consumer-off'),
      projectPath: '.consumer',
    }],
  }));
  fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({
    baseIntent: { 'global:shared\0managed': 'off' },
  }));

  const removed = run(['shared', 'remove', 'managed', '--yes']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(linked), false);
});

test('shared remove preflights dependent claims before changing disk', () => {
  const { home, config, run, calls } = setup();
  const discovery = path.join(home, '.agents', 'skills');
  const source = path.join(discovery, 'managed');
  const consumer = path.join(config, 'consumer');
  writeSkill(discovery, 'managed');
  writeLock(path.join(home, '.agents', '.skill-lock.json'), { managed: { source: 'owner/repo' } });
  fs.mkdirSync(consumer, { recursive: true });
  const linked = path.join(consumer, 'linked');
  fs.symlinkSync(source, linked, 'dir');
  fs.writeFileSync(path.join(config, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [],
    genericTargets: [{
      key: 'consumer',
      kind: 'generic',
      discoveryRoot: consumer,
      parkingRoot: path.join(config, 'consumer-off'),
      projectPath: '.consumer',
    }],
  }));
  fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({
    claims: { 'global:consumer\0linked': ['preset:keep'] },
  }));

  const refused = run(['shared', 'remove', 'managed', '--yes']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cannot remove claimed Target Slot global:consumer\/linked/);
  assert.ok(fs.existsSync(source));
  assert.ok(fs.lstatSync(linked).isSymbolicLink());
  assert.equal(calls().length, 0);
});

test('project Shared removal refuses read-only dependent Relationships', () => {
  const { root, config, run, calls } = setup();
  const project = path.join(root, 'project');
  const source = path.join(project, '.agents', 'skills', 'managed');
  const consumer = path.join(config, 'consumer');
  writeSkill(path.join(project, '.agents', 'skills'), 'managed');
  writeLock(path.join(project, 'skills-lock.json'), { managed: { source: 'owner/repo' } });
  fs.mkdirSync(consumer, { recursive: true });
  const linked = path.join(consumer, 'linked');
  fs.symlinkSync(source, linked, 'dir');
  fs.writeFileSync(path.join(config, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [],
    genericTargets: [{
      key: 'consumer',
      kind: 'generic',
      discoveryRoot: consumer,
      parkingRoot: path.join(config, 'consumer-off'),
      projectPath: '.consumer',
    }],
  }));

  const refused = run(['project', project, 'shared', 'remove', 'managed', '--yes']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /read-only dependent Relationship/);
  assert.ok(fs.existsSync(source));
  assert.ok(fs.lstatSync(linked).isSymbolicLink());
  assert.equal(calls().length, 0);
});

test('failed shared remove restores staged dependent Relationships', () => {
  const { home, config, run, calls } = setup();
  const discovery = path.join(home, '.agents', 'skills');
  const source = path.join(discovery, 'managed');
  const consumer = path.join(config, 'consumer');
  writeSkill(discovery, 'managed');
  writeLock(path.join(home, '.agents', '.skill-lock.json'), { managed: { source: 'owner/repo' } });
  fs.mkdirSync(consumer, { recursive: true });
  const linked = path.join(consumer, 'linked');
  fs.symlinkSync(source, linked, 'dir');
  fs.writeFileSync(path.join(config, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [],
    genericTargets: [{
      key: 'consumer',
      kind: 'generic',
      discoveryRoot: consumer,
      parkingRoot: path.join(config, 'consumer-off'),
      projectPath: '.consumer',
    }],
  }));

  const failed = run(['shared', 'remove', 'managed', '--yes'], { NPX_FAIL: '7' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /skills remove failed/);
  assert.ok(fs.existsSync(source));
  assert.ok(fs.lstatSync(linked).isSymbolicLink());
  assert.equal(calls().length, 1);
});

test('shared remove passes only managed names and leaves external entries untouched', () => {
  const { home, run, calls } = setup();
  const discovery = path.join(home, '.agents', 'skills');
  const lock = path.join(home, '.agents', '.skill-lock.json');
  writeSkill(discovery, 'managed');
  writeSkill(discovery, 'external');
  writeLock(lock, { managed: { source: 'owner/repo' } });

  const unknown = run(['shared', 'remove', 'external']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /not managed by skills@1\.5\.21/);
  assert.equal(calls().length, 0);

  const removed = run(['shared', 'remove', 'managed']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(path.join(discovery, 'managed')), false);
  assert.ok(fs.existsSync(path.join(discovery, 'external', 'SKILL.md')));
  assert.deepEqual(calls()[0].args, [
    '--yes', PACKAGE, 'remove', 'managed', '--agent', 'codex', '--global',
  ]);
  assert.equal(calls()[0].args.includes('--all'), false);
});

test('shared refresh checks each source once and caches per-Skill results without source mutation', () => {
  const { home, config, run, calls, gitCalls } = setup();
  const discovery = path.join(home, '.agents', 'skills');
  const lock = path.join(home, '.agents', '.skill-lock.json');
  const names = ['current', 'available', 'missing', 'invalid'];
  for (const name of names) writeSkill(discovery, name, `# ${name}`);
  const sourceUrl = 'https://github.com/owner/repo.git';
  writeLock(lock, {
    current: {
      source: 'owner/repo', sourceType: 'github', sourceUrl,
      skillPath: 'SKILL.md', skillFolderHash: 'same-hash',
    },
    available: {
      source: 'owner/repo', sourceType: 'github', sourceUrl,
      skillPath: 'skills/available/SKILL.md', skillFolderHash: 'old-hash',
    },
    missing: {
      source: 'owner/repo', sourceType: 'github', sourceUrl,
      skillPath: 'skills/missing/SKILL.md', skillFolderHash: 'missing-hash',
    },
    invalid: {
      source: 'owner/repo', sourceType: 'github', sourceUrl,
      skillPath: '../invalid/SKILL.md', skillFolderHash: 'invalid-hash',
    },
  });
  const before = {
    lock: fs.readFileSync(lock, 'utf8'),
    skills: Object.fromEntries(names.map((name) => [
      name, hashDirectory(path.join(discovery, name)),
    ])),
  };

  const refreshed = run(['shared', 'refresh', '--json'], {
    GIT_TREES: JSON.stringify({
      [sourceUrl]: {
        '.': 'same-hash',
        'skills/available': 'new-hash',
        'skills/unrelated': 'unrelated-change',
      },
    }),
  });
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const result = JSON.parse(refreshed.stdout);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.ok, true);
  assert.equal(result.data.scope, 'global');
  assert.deepEqual(result.data.entries.map(({ name, status }: { name: string; status: string }) =>
    [name, status]), [
    ['current', 'current'],
    ['available', 'available'],
    ['missing', 'upstream-missing'],
    ['invalid', 'check-failed'],
  ]);
  assert.match(result.data.entries[3].error, /unsafe installer skillPath/);
  assert.ok(result.data.entries.every(({ checkedAt }: { checkedAt: string }) =>
    !Number.isNaN(Date.parse(checkedAt))));
  assert.equal(gitCalls().filter(({ args }: { args: string[] }) => args[0] === 'clone').length, 1);
  assert.equal(calls().length, 0);
  assert.equal(fs.readFileSync(lock, 'utf8'), before.lock);
  assert.deepEqual(Object.fromEntries(names.map((name) => [
    name, hashDirectory(path.join(discovery, name)),
  ])), before.skills);
  assert.ok(fs.existsSync(path.join(config, 'state.json')));

  const refreshedAfterUnrelatedChange = run(['shared', 'refresh', '--json'], {
    GIT_TREES: JSON.stringify({
      [sourceUrl]: {
        '.': 'same-hash',
        'skills/available': 'new-hash',
        'skills/unrelated': 'another-unrelated-change',
      },
    }),
  });
  assert.equal(refreshedAfterUnrelatedChange.status, 0, refreshedAfterUnrelatedChange.stderr);
  assert.deepEqual(JSON.parse(refreshedAfterUnrelatedChange.stdout).data.entries.map(
    ({ status }: { status: string }) => status,
  ), ['current', 'available', 'upstream-missing', 'check-failed']);
  assert.equal(gitCalls().filter(({ args }: { args: string[] }) => args[0] === 'clone').length, 2);
});

test('shared outdated is cache-only and invalidates observations after local or provenance changes', () => {
  const { home, config, run, calls, gitCalls } = setup();
  const discovery = path.join(home, '.agents', 'skills');
  const lock = path.join(home, '.agents', '.skill-lock.json');
  const sourceUrl = 'https://github.com/owner/repo.git';
  writeSkill(discovery, 'cached', '# original');
  writeLock(lock, { cached: {
    source: 'owner/repo', sourceType: 'github', sourceUrl,
    skillPath: 'skills/cached/SKILL.md', skillFolderHash: 'same-hash',
  } });
  const trees = JSON.stringify({ [sourceUrl]: { 'skills/cached': 'same-hash' } });
  const refreshed = run(['shared', 'refresh'], { GIT_TREES: trees });
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const stateFile = path.join(config, 'state.json');
  const state = fs.readFileSync(stateFile, 'utf8');
  const gitCount = gitCalls().length;

  const cached = run(['shared', 'outdated', '--json']);
  assert.equal(cached.status, 0, cached.stderr);
  assert.equal(JSON.parse(cached.stdout).data.entries[0].status, 'current');
  assert.equal(gitCalls().length, gitCount);
  assert.equal(calls().length, 0);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), state);

  fs.writeFileSync(path.join(discovery, 'cached', 'SKILL.md'), '# locally changed');
  const localChange = JSON.parse(run(['shared', 'outdated', '--json']).stdout).data.entries[0];
  assert.equal(localChange.status, 'unknown');
  assert.equal(localChange.checkedAt, undefined);
  fs.writeFileSync(path.join(discovery, 'cached', 'SKILL.md'), '# original');
  writeLock(lock, { cached: {
    source: 'owner/repo', sourceType: 'github', sourceUrl,
    skillPath: 'other/cached/SKILL.md', skillFolderHash: 'same-hash',
  } });
  const pathChange = JSON.parse(run(['shared', 'outdated', '--json']).stdout).data.entries[0];
  assert.equal(pathChange.status, 'unknown');
  writeLock(lock, { cached: {
    source: 'owner/other', sourceType: 'github', sourceUrl: 'https://github.com/owner/other.git',
    skillPath: 'skills/cached/SKILL.md', skillFolderHash: 'same-hash',
  } });
  const provenanceChange = JSON.parse(run(['shared', 'outdated', '--json']).stdout).data.entries[0];
  assert.equal(provenanceChange.status, 'unknown');
  assert.equal(gitCalls().length, gitCount);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), state);
});

test('Project refresh isolates its cache and source failures from successful sources', () => {
  const { root, config, run, calls, gitCalls } = setup();
  const project = path.join(root, 'project');
  const sibling = path.join(root, 'sibling');
  const discovery = path.join(project, '.agents', 'skills');
  const goodUrl = 'https://github.com/owner/good.git';
  const offlineUrl = 'https://github.com/owner/offline.git';
  fs.mkdirSync(sibling, { recursive: true });
  writeSkill(discovery, 'good');
  writeSkill(discovery, 'offline');
  writeLock(path.join(project, 'skills-lock.json'), {
    good: {
      source: 'owner/good', sourceType: 'github', sourceUrl: goodUrl,
      skillPath: 'skills/good/SKILL.md',
      computedHash: '59bfce6dee5279c51634686ecc194d945ec527dc12558e6df0364c862e87d371',
    },
    offline: {
      source: 'owner/offline', sourceType: 'github', sourceUrl: offlineUrl,
      skillPath: 'skills/offline/SKILL.md', skillFolderHash: 'offline-hash',
    },
  });
  const refreshed = run(['project', project, 'shared', 'refresh', '--json'], {
    GIT_TREES: JSON.stringify({ [goodUrl]: { 'skills/good': 'git-tree-hash' } }),
    GIT_FILES: JSON.stringify({ [goodUrl]: { 'skills/good/SKILL.md': '# good' } }),
  });
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const data = JSON.parse(refreshed.stdout).data;
  assert.equal(data.scope, 'project');
  assert.equal(data.projectPath, fs.realpathSync(project));
  assert.deepEqual(data.entries.map(({ name, status }: { name: string; status: string }) =>
    [name, status]), [['good', 'current'], ['offline', 'check-failed']]);
  assert.match(data.entries[1].error, /git clone failed/);
  assert.equal(gitCalls().filter(({ args }: { args: string[] }) => args[0] === 'clone').length, 2);
  assert.equal(calls().length, 0);
  assert.ok(fs.existsSync(path.join(project, '.skillspub', 'state.json')));
  assert.equal(fs.existsSync(path.join(config, 'state.json')), false);

  const siblingResult = run(['project', sibling, 'shared', 'outdated', '--json']);
  assert.equal(siblingResult.status, 0, siblingResult.stderr);
  assert.deepEqual(JSON.parse(siblingResult.stdout).data.entries, []);
  assert.equal(fs.existsSync(path.join(sibling, '.skillspub')), false);
  assert.equal(fs.existsSync(path.join(config, 'state.json')), false);
});

test('shared update refuses an identity-matching upstream-missing observation', () => {
  const { home, run, calls } = setup();
  const discovery = path.join(home, '.agents', 'skills');
  const lock = path.join(home, '.agents', '.skill-lock.json');
  const sourceUrl = 'https://github.com/owner/repo.git';
  writeSkill(discovery, 'missing', '# installed');
  writeLock(lock, { missing: {
    source: 'owner/repo', sourceType: 'github', sourceUrl,
    skillPath: 'skills/missing/SKILL.md', skillFolderHash: 'old-hash',
  } });
  const refreshed = run(['shared', 'refresh'], {
    GIT_TREES: JSON.stringify({ [sourceUrl]: { 'skills/other': 'other-hash' } }),
  });
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const before = {
    lock: fs.readFileSync(lock, 'utf8'),
    skill: hashDirectory(path.join(discovery, 'missing')),
  };

  const refused = run(['shared', 'update', 'missing']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cannot update upstream-missing Skill: missing/);
  assert.equal(calls().length, 0);
  assert.equal(fs.readFileSync(lock, 'utf8'), before.lock);
  assert.equal(hashDirectory(path.join(discovery, 'missing')), before.skill);
});

test('shared update refuses an identity-matching check-failed observation', () => {
  const {home, run, calls} = setup();
  const discovery = path.join(home, '.agents', 'skills');
  const lock = path.join(home, '.agents', '.skill-lock.json');
  const sourceUrl = 'https://github.com/owner/offline.git';
  writeSkill(discovery, 'offline', '# installed');
  writeLock(lock, {offline: {
    source: 'owner/offline', sourceType: 'github', sourceUrl,
    skillPath: 'skills/offline/SKILL.md', skillFolderHash: 'old-hash',
  }});
  const refreshed = run(['shared', 'refresh']);
  assert.equal(refreshed.status, 0, refreshed.stderr);

  const refused = run(['shared', 'update', 'offline']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cannot update check-failed Skill: offline/);
  assert.equal(calls().length, 0);
  assert.ok(fs.existsSync(path.join(discovery, 'offline', 'SKILL.md')));
});
