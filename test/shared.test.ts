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
  process.exit(Number(process.env.NPX_FAIL || 0));
}
if (command === 'add' && args.includes('--list')) {
  process.stdout.write(process.env.NPX_STDOUT || '');
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

  const env = {
    ...process.env,
    HOME: home,
    SKILLSPUB_CONFIG_DIR: config,
    NPX_LOG: log,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
  const calls = () => fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { root, home, config, log, run, calls };
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

test('Shared Target operation lock prevents concurrent mutation', () => {
  const { home, run, calls } = setup();
  const lock = path.join(home, '.agents', '.skill-lock.json');
  writeSkill(path.join(home, '.agents', 'skills'), 'managed');
  writeLock(lock, { managed: { source: 'owner/repo' } });
  fs.writeFileSync(`${lock}.skillspub-operation-lock`, 'busy\n');

  const result = run(['shared', 'update', 'managed']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /operation already in progress/);
  assert.equal(calls().length, 0);
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
