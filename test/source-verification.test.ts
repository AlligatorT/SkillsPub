import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planSharedAdd,
  planSharedRemove,
  planSharedUpdate,
  sharedAdd,
  sharedRefresh,
  sharedRemove,
  sharedRemoveCascade,
  sharedUpdate,
} from '../src/shared.ts';
import { verifySourceMutation } from '../src/source-verification.ts';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-verification-'));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npx'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const command = args[2];
const sanitize = (name) => name.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^[.\\-]+|[.\\-]+$/g, '').substring(0, 255) || 'unnamed-skill';
if (command === 'find') process.exit(Number(process.env.NPX_FAIL || 0));
if (command === 'add' && args.includes('--list')) process.exit(Number(process.env.NPX_FAIL || 0));
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
  const lock = readLock();
  lock.skills[name] = { source, sourceUrl: 'https://github.com/' + source + '.git', skillPath: 'skills/' + name };
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify(lock));
} else if (command === 'update') {
  const names = args.slice(3).filter((arg) => !arg.startsWith('-'));
  for (const name of names) {
    if (!fs.existsSync(path.join(skillsRoot, sanitize(name), 'SKILL.md'))) process.exit(91);
  }
  const failedNames = new Set(JSON.parse(process.env.NPX_FAIL_NAMES || '[]'));
  for (const name of names)
    if (!failedNames.has(name))
      fs.appendFileSync(path.join(skillsRoot, sanitize(name), 'SKILL.md'), '\\n# updated');
  if (names.some((name) => failedNames.has(name))) process.exit(7);
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
    NPX_LOG: path.join(root, 'npx.jsonl'),
    GIT_LOG: path.join(root, 'git.jsonl'),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  return { root, home, config, env };
}

function useFixtureEnv(
  context: {after(callback: () => void): void},
  env: Record<string, string>,
): void {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function writeSkill(root: string, name: string, body = '# skill') {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), body);
}

function writeLock(file: string, skills: Record<string, object>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 3, skills }));
}

test('Source verification derives every field from one post-mutation scan after add', (context) => {
  const fixture = setup();
  useFixtureEnv(context, fixture.env);
  const home = {configDir: fixture.config};
  const plan = planSharedAdd(home, 'owner/repo', 'Example', false);
  const result = sharedAdd(home, 'owner/repo', 'Example', false, undefined, plan);

  const verification = verifySourceMutation(home, plan, result);
  const resource = fs.realpathSync(path.join(fixture.home, '.agents', 'skills', 'example'));
  const entry = path.join(fixture.home, '.agents', 'skills', 'example');
  assert.equal(verification.resource, resource);
  assert.equal(verification.provenance, 'https://github.com/owner/repo.git');
  assert.equal(verification.slot, 'example');
  assert.deepEqual(verification.relationships, [
    `global:shared/example local/on ${entry}`,
  ]);
  assert.equal(verification.actual, 'global:shared/example=on/local');
  assert.equal(verification.desired, 'ON');
  assert.equal(verification.drift, 'none observed');
  assert.equal(verification.updateAvailability, 'unknown');
  assert.equal(verification.effectiveVisibility, 'unknown');
});

test('Source verification reports replacement provenance after replace', (context) => {
  const fixture = setup();
  useFixtureEnv(context, fixture.env);
  const home = {configDir: fixture.config};
  const sharedRoot = path.join(fixture.home, '.agents', 'skills');
  writeSkill(sharedRoot, 'same', '# old');
  writeLock(path.join(fixture.home, '.agents', '.skill-lock.json'), {
    same: {
      source: 'old/repo',
      sourceUrl: 'https://github.com/old/repo.git',
      skillPath: 'skills/same',
    },
  });
  fs.mkdirSync(fixture.config, {recursive: true});

  const plan = planSharedAdd(home, 'new/repo', 'same', true);
  assert.deepEqual(plan.replacement, {from: 'old/repo', to: 'new/repo'});
  const result = sharedAdd(home, 'new/repo', 'same', true, undefined, plan);
  const verification = verifySourceMutation(home, plan, result);
  assert.equal(verification.provenance, 'https://github.com/new/repo.git');
  assert.equal(verification.slot, 'same');
  assert.equal(verification.actual, 'global:shared/same=on/local');
  assert.equal(verification.desired, 'ON');
  assert.equal(verification.drift, 'none observed');
});

test('Source verification covers update with per-item evidence', (context) => {
  const fixture = setup();
  useFixtureEnv(context, fixture.env);
  const home = {configDir: fixture.config};
  const discovery = path.join(fixture.home, '.agents', 'skills');
  const sourceUrl = 'https://github.com/owner/repo.git';
  writeSkill(discovery, 'managed', '# old');
  writeLock(path.join(fixture.home, '.agents', '.skill-lock.json'), {
    managed: {source: 'owner/repo', sourceType: 'github', sourceUrl, skillPath: 'skills/managed/SKILL.md', skillFolderHash: 'old-hash'},
  });
  fs.mkdirSync(fixture.config, {recursive: true});
  fs.writeFileSync(path.join(fixture.config, 'state.json'), JSON.stringify({baseIntent: {}, claims: {}}));
  process.env.GIT_TREES = JSON.stringify({[sourceUrl]: {'skills/managed': 'new-hash'}});
  context.after(() => delete process.env.GIT_TREES);
  sharedRefresh(home);

  const plan = planSharedUpdate(home, ['managed']);
  const result = sharedUpdate(home, ['managed'], undefined, plan);
  const verification = verifySourceMutation(home, plan, result);
  assert.equal(verification.slot, 'managed');
  assert.equal(verification.actual, 'global:shared/managed=on/local');
  assert.equal(verification.desired, 'managed=on');
  assert.equal(verification.drift, 'none');
  assert.equal(verification.provenance, `managed=${sourceUrl}`);
  assert.match(verification.updateAvailability, /^managed=/);
  assert.equal(verification.effectiveVisibility, 'managed=unknown');
  assert.equal(verification.relationships.length, 1);
});

test('Source verification reports removed source, remaining evidence, and drift after remove', (context) => {
  const fixture = setup();
  useFixtureEnv(context, fixture.env);
  const home = {configDir: fixture.config};
  const sharedRoot = path.join(fixture.home, '.agents', 'skills');
  writeSkill(sharedRoot, 'managed', '# managed');
  writeLock(path.join(fixture.home, '.agents', '.skill-lock.json'), {
    managed: {
      source: 'owner/repo',
      sourceUrl: 'https://github.com/owner/repo.git',
      skillPath: 'skills/managed',
    },
  });
  fs.mkdirSync(fixture.config, {recursive: true});

  const plan = planSharedRemove(home, ['managed'], undefined);
  sharedRemoveCascade(home, ['managed'], plan);
  const result = sharedRemove(home, ['managed'], {sourceConfirmed: true, expected: plan});
  const verification = verifySourceMutation(home, plan, result);
  assert.equal(verification.slot, 'managed');
  assert.equal(verification.resource, 'missing');
  assert.equal(verification.desired, 'removed');
  assert.equal(verification.drift, 'none observed');
  assert.equal(verification.actual, 'global:shared/managed=missing');
  assert.deepEqual(verification.relationships, []);

  // Incomplete removal evidence: source entry and lock remain on disk.
  writeSkill(sharedRoot, 'managed', '# managed');
  writeLock(path.join(fixture.home, '.agents', '.skill-lock.json'), {
    managed: {
      source: 'owner/repo',
      sourceUrl: 'https://github.com/owner/repo.git',
      skillPath: 'skills/managed',
    },
  });
  const incomplete = planSharedRemove(home, ['managed'], undefined);
  const incompleteVerification = verifySourceMutation(home, incomplete, {
    actual: 'rescan unavailable',
    drift: ['cascade incomplete'],
  });
  assert.equal(incompleteVerification.desired, 'removed');
  assert.equal(incompleteVerification.actual, 'global:shared/managed=on/local');
  assert.equal(
    incompleteVerification.drift,
    'Shared source remains, Vercel skills lock entry remains',
  );
});

test('Source verification keeps failed and updated items visible together in a partial batch', (context) => {
  const fixture = setup();
  useFixtureEnv(context, fixture.env);
  const home = {configDir: fixture.config};
  const discovery = path.join(fixture.home, '.agents', 'skills');
  const sourceUrl = 'https://github.com/owner/repo.git';
  writeSkill(discovery, 'a-success', '# a');
  writeSkill(discovery, 'b-fail', '# b');
  writeLock(path.join(fixture.home, '.agents', '.skill-lock.json'), {
    'a-success': {source: 'owner/repo', sourceType: 'github', sourceUrl, skillPath: 'skills/a-success/SKILL.md', skillFolderHash: 'a-old'},
    'b-fail': {source: 'owner/repo', sourceType: 'github', sourceUrl, skillPath: 'skills/b-fail/SKILL.md', skillFolderHash: 'b-old'},
  });
  fs.mkdirSync(fixture.config, {recursive: true});
  fs.writeFileSync(path.join(fixture.config, 'state.json'), JSON.stringify({baseIntent: {}, claims: {}}));
  process.env.GIT_TREES = JSON.stringify({[sourceUrl]: {
    'skills/a-success': 'a-new',
    'skills/b-fail': 'b-new',
  }});
  context.after(() => delete process.env.GIT_TREES);
  sharedRefresh(home);

  const plan = planSharedUpdate(home, ['a-success', 'b-fail']);
  process.env.NPX_FAIL_NAMES = JSON.stringify(['b-fail']);
  context.after(() => delete process.env.NPX_FAIL_NAMES);
  const result = sharedUpdate(home, ['a-success', 'b-fail'], undefined, plan);
  assert.deepEqual(result.items.map(({name, outcome}) => [name, outcome]), [
    ['a-success', 'updated'],
    ['b-fail', 'failed'],
  ]);

  const verification = verifySourceMutation(home, plan, result);
  assert.equal(verification.slot, 'a-success, b-fail');
  assert.equal(verification.provenance, `a-success=${sourceUrl}, b-fail=${sourceUrl}`);
  assert.equal(verification.desired, 'a-success=on, b-fail=on');
  assert.match(verification.actual, /a-success=on\/local/);
  assert.match(verification.actual, /b-fail=on\/local/);
  assert.match(verification.updateAvailability, /a-success=/);
  assert.match(verification.updateAvailability, /b-fail=/);
  assert.equal(verification.effectiveVisibility, 'a-success=unknown, b-fail=unknown');
});

test('Source verification fails soft when the post-mutation scan is unavailable', (context) => {
  const fixture = setup();
  useFixtureEnv(context, fixture.env);
  const home = {configDir: fixture.config};
  const missingProject = path.join(fixture.root, 'missing-project');
  const plan = {
    ...planSharedAdd(home, 'owner/repo', 'Example', false),
    scope: {kind: 'project' as const, path: missingProject},
  };
  const result = {actual: 'rescan unavailable', drift: []};

  const verification = verifySourceMutation(home, plan, result);
  assert.equal(verification.resource, 'unknown');
  assert.equal(verification.provenance, 'Source unknown');
  assert.equal(verification.slot, 'example');
  assert.deepEqual(verification.relationships, []);
  assert.equal(verification.actual, 'rescan unavailable');
  assert.equal(verification.desired, 'unknown');
  assert.equal(verification.drift, 'rescan unavailable');
  assert.equal(verification.updateAvailability, 'unknown');
  assert.equal(verification.effectiveVisibility, 'unknown');
});
