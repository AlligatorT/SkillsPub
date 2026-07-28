import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadAgents, scanAgent, scanAll } from '../src/core.ts';

function tmpHome(): { configDir: string } {
  return { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'skm-test-')) };
}

function mkSkill(dir: string, name: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `# ${name}`);
}

test('loadAgents seeds default registry when agents.conf is missing', () => {
  const home = tmpHome();
  const agents = loadAgents(home);
  assert.deepEqual(
    agents.map((a) => a.name),
    ['claude', 'agents', 'pi'],
  );
  assert.ok(fs.existsSync(path.join(home.configDir, 'agents.conf')));
});

test('loadAgents parses name = path lines, expands ~, skips comments', () => {
  const home = tmpHome();
  fs.writeFileSync(
    path.join(home.configDir, 'agents.conf'),
    '# comment\n\nclaude = ~/.claude/skills\ngrok = /tmp/grok-skills\n',
  );
  const agents = loadAgents(home);
  assert.deepEqual(agents, [
    { name: 'claude', dir: path.join(os.homedir(), '.claude/skills') },
    { name: 'grok', dir: '/tmp/grok-skills' },
  ]);
});

test('scanAgent: dir with SKILL.md = on, dir under .off/ = off', () => {
  const home = tmpHome();
  const dir = path.join(home.configDir, 'skills');
  mkSkill(dir, 'grilling');
  mkSkill(path.join(dir, '.off'), 'code-review');
  const found = scanAgent({ name: 'a', dir });
  assert.equal(found.get('grilling')?.presence, 'on');
  assert.equal(found.get('code-review')?.presence, 'off');
});

test('scanAgent: symlink to real skill resolves on; broken symlink = deadlink', () => {
  const home = tmpHome();
  const dir = path.join(home.configDir, 'skills');
  const shared = path.join(home.configDir, 'shared');
  mkSkill(shared, 'real-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.join(shared, 'real-skill'), path.join(dir, 'linked'));
  fs.symlinkSync(path.join(shared, 'gone'), path.join(dir, 'broken'));
  const found = scanAgent({ name: 'a', dir });
  assert.equal(found.get('linked')?.presence, 'on');
  assert.equal(found.get('broken')?.presence, 'deadlink');
});

test('scanAgent: directories without SKILL.md are not skills (ADR-0004)', () => {
  const home = tmpHome();
  const dir = path.join(home.configDir, 'skills');
  fs.mkdirSync(path.join(dir, 'random-dir'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'loose-file.md'), 'x');
  const found = scanAgent({ name: 'a', dir });
  assert.equal(found.size, 0);
});

test('scanAll builds skill × agent matrix, absent agents undefined', () => {
  const home = tmpHome();
  const dirA = path.join(home.configDir, 'a');
  const dirB = path.join(home.configDir, 'b');
  mkSkill(dirA, 'grilling');
  mkSkill(path.join(dirB, '.off'), 'grilling');
  mkSkill(dirB, 'only-b');
  const rows = scanAll([
    { name: 'a', dir: dirA },
    { name: 'b', dir: dirB },
  ]);
  const grilling = rows.find((r) => r.name === 'grilling')!;
  assert.equal(grilling.agents.a?.presence, 'on');
  assert.equal(grilling.agents.b?.presence, 'off');
  const onlyB = rows.find((r) => r.name === 'only-b')!;
  assert.equal(onlyB.agents.a, undefined);
  assert.deepEqual(rows.map((r) => r.name), ['grilling', 'only-b']);
});

test('scanAgent: missing skills dir scans empty, does not throw', () => {
  const found = scanAgent({ name: 'a', dir: '/nonexistent/path' });
  assert.equal(found.size, 0);
});

// --- on/off ops + state ---

import { setSkill, loadState, filterRows, untagged } from '../src/core.ts';

test('setSkill off moves skill into .off/, on moves it back', () => {
  const home = tmpHome();
  const dir = path.join(home.configDir, 'skills');
  mkSkill(dir, 'grilling');
  const agent = { name: 'a', dir };

  setSkill(agent, 'grilling', false);
  assert.ok(!fs.existsSync(path.join(dir, 'grilling')));
  assert.ok(fs.existsSync(path.join(dir, '.off', 'grilling', 'SKILL.md')));
  assert.equal(scanAgent(agent).get('grilling')?.presence, 'off');

  setSkill(agent, 'grilling', true);
  assert.ok(fs.existsSync(path.join(dir, 'grilling', 'SKILL.md')));
  assert.equal(scanAgent(agent).get('grilling')?.presence, 'on');
});

test('setSkill errors when skill is absent; no-op when already in target state', () => {
  const home = tmpHome();
  const dir = path.join(home.configDir, 'skills');
  mkSkill(dir, 'grilling');
  const agent = { name: 'a', dir };

  assert.throws(() => setSkill(agent, 'nope', true), /not found/);
  assert.equal(setSkill(agent, 'grilling', true), 'already');
});

test('setSkill off moves a dead symlink into .off/ too', () => {
  const home = tmpHome();
  const dir = path.join(home.configDir, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync('/gone/target', path.join(dir, 'broken'));
  const agent = { name: 'a', dir };

  setSkill(agent, 'broken', false);
  assert.ok(!fs.existsSync(path.join(dir, 'broken')));
  assert.equal(scanAgent(agent).get('broken')?.presence, 'deadlink');
  assert.equal(scanAgent(agent).get('broken')?.target, '/gone/target');
});

test('loadState reads tags from state.json; missing file = empty', () => {
  const home = tmpHome();
  assert.deepEqual(loadState(home).tags, {});
  fs.writeFileSync(
    path.join(home.configDir, 'state.json'),
    JSON.stringify({ tags: { 'code-review': ['review', 'backend'] } }),
  );
  assert.deepEqual(loadState(home).tags, { 'code-review': ['review', 'backend'] });
});

test('filterRows --agent/--tag; untagged lists skills with no tags', () => {
  const home = tmpHome();
  const dirA = path.join(home.configDir, 'a');
  const dirB = path.join(home.configDir, 'b');
  mkSkill(dirA, 'grilling');
  mkSkill(dirB, 'code-review');
  mkSkill(dirB, 'only-b');
  const rows = scanAll([
    { name: 'a', dir: dirA },
    { name: 'b', dir: dirB },
  ]);
  const tags = { 'code-review': ['review'] };

  assert.deepEqual(filterRows(rows, { tag: 'review' }, tags).map((r) => r.name), ['code-review']);
  assert.deepEqual(filterRows(rows, { agent: 'a' }, tags).map((r) => r.name), ['grilling']);
  assert.deepEqual(untagged(rows, tags), ['grilling', 'only-b']);
});
