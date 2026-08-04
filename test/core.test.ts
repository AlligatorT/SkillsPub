import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  defaultHome,
  loadAgents,
  matchesSearch,
  scanAgent,
  scanAll,
  sortRows,
  type Row,
} from '../src/core.ts';

function tmpHome(): { configDir: string } {
  return {
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-test-')),
  };
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
  const grilling = rows.filter((r) => r.name === 'grilling');
  assert.equal(grilling.length, 2);
  assert.equal(grilling.find((row) => row.agents.a)?.agents.a?.presence, 'on');
  assert.equal(grilling.find((row) => row.agents.b)?.agents.b?.presence, 'off');
  const onlyB = rows.find((r) => r.name === 'only-b')!;
  assert.equal(onlyB.agents.a, undefined);
  assert.deepEqual(rows.map((r) => r.name), ['grilling', 'grilling', 'only-b']);
});

test('scanAgent: missing skills dir scans empty, does not throw', () => {
  const found = scanAgent({ name: 'a', dir: '/nonexistent/path' });
  assert.equal(found.size, 0);
});

// --- on/off ops + state ---

import {
  setSkill,
  toggleSkill,
  loadState,
  migrateLegacyConfig,
  filterRows,
  untagged,
  buildInventory,
  skillDetail,
  tuiSnapshot,
  linkSkill,
  toggleRelationship,
  unlinkRelationship,
} from '../src/core.ts';

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

test('toggleSkill derives the next state from a fresh disk scan', () => {
  const home = tmpHome();
  const dir = path.join(home.configDir, 'skills');
  mkSkill(dir, 'grilling');
  const agent = { name: 'a', dir };

  assert.equal(toggleSkill(agent, 'grilling'), 'off');
  assert.equal(toggleSkill(agent, 'grilling'), 'on');
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

test('loadState reads metadata from state.json; missing fields are empty', () => {
  const home = tmpHome();
  assert.deepEqual(loadState(home), { bundles: {}, tags: {}, inventory: {} });
  fs.writeFileSync(
    path.join(home.configDir, 'state.json'),
    JSON.stringify({
      bundles: { reviewers: ['code-review'] },
      tags: { 'code-review': ['review', 'backend'] },
      inventory: { 'code-review': { source: 'owner/repo' } },
    }),
  );
  assert.deepEqual(loadState(home), {
    bundles: { reviewers: ['code-review'] },
    tags: { 'code-review': ['review', 'backend'] },
    inventory: { 'code-review': { source: 'owner/repo' } },
  });
});

test('legacy configuration migrates into SkillsPub without removing its source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-migration-'));
  const legacy = path.join(root, 'skm');
  const configDir = path.join(root, 'skillspub');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'agents.conf'), 'legacy = /tmp/skills\n');
  fs.writeFileSync(
    path.join(legacy, 'state.json'),
    JSON.stringify({ tags: { grilling: ['legacy'] } }),
  );

  const previousConfig = process.env.SKILLSPUB_CONFIG_DIR;
  const previousLegacy = process.env.SKM_CONFIG_DIR;
  process.env.SKILLSPUB_CONFIG_DIR = configDir;
  process.env.SKM_CONFIG_DIR = legacy;
  try {
    assert.deepEqual(defaultHome(), { configDir });
  } finally {
    if (previousConfig === undefined) delete process.env.SKILLSPUB_CONFIG_DIR;
    else process.env.SKILLSPUB_CONFIG_DIR = previousConfig;
    if (previousLegacy === undefined) delete process.env.SKM_CONFIG_DIR;
    else process.env.SKM_CONFIG_DIR = previousLegacy;
  }

  assert.deepEqual(loadAgents({ configDir }), [
    { name: 'legacy', dir: '/tmp/skills' },
  ]);
  assert.deepEqual(loadState({ configDir }).tags, { grilling: ['legacy'] });
  assert.ok(fs.existsSync(path.join(legacy, 'state.json')));
});

test('legacy migration fills missing files without overwriting newer SkillsPub data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-migration-'));
  const legacy = path.join(root, 'skm');
  const configDir = path.join(root, 'skillspub');
  fs.mkdirSync(legacy);
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(legacy, 'agents.conf'), 'legacy = /tmp/skills\n');
  fs.writeFileSync(path.join(legacy, 'state.json'), '{"tags":{"old":[]}}');
  fs.writeFileSync(path.join(configDir, 'state.json'), '{"tags":{"new":[]}}');

  migrateLegacyConfig(configDir, legacy);

  assert.deepEqual(loadState({ configDir }).tags, { new: [] });
  assert.equal(
    fs.readFileSync(path.join(configDir, 'agents.conf'), 'utf8'),
    'legacy = /tmp/skills\n',
  );
  assert.equal(
    fs.readFileSync(path.join(legacy, 'state.json'), 'utf8'),
    '{"tags":{"old":[]}}',
  );
});

test('skillDetail assembles live paths, agent state, metadata, and SKILL.md', () => {
  const home = tmpHome();
  const shared = path.join(home.configDir, 'shared', 'grilling');
  const a = path.join(home.configDir, 'a');
  const b = path.join(home.configDir, 'b');
  mkSkill(path.dirname(shared), path.basename(shared));
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(path.join(b, '.off'), { recursive: true });
  fs.symlinkSync(shared, path.join(a, 'grilling'));
  fs.symlinkSync(shared, path.join(b, '.off', 'grilling'));
  fs.writeFileSync(
    path.join(home.configDir, 'state.json'),
    JSON.stringify({
      bundles: { cooks: ['grilling'], unrelated: ['other'] },
      tags: { [fs.realpathSync(shared)]: ['food'] },
      inventory: { grilling: { source: 'chef/skills' } },
    }),
  );
  const agents = [
    { name: 'a', dir: a },
    { name: 'b', dir: b },
  ];

  const id = buildInventory(home, agents).instances[0].id;
  const detail = skillDetail(home, agents, id)!;
  assert.equal(detail.source, 'chef/skills');
  assert.deepEqual(detail.bundles, ['cooks']);
  assert.deepEqual(detail.tags, ['food']);
  assert.deepEqual(detail.realPaths, [fs.realpathSync(shared)]);
  assert.equal(detail.content, '# grilling');
  assert.equal(detail.agents.a?.linked, true);
  assert.equal(detail.agents.a?.underOff, false);
  assert.equal(detail.agents.b?.underOff, true);
  assert.equal(detail.contentPath, path.join(fs.realpathSync(shared), 'SKILL.md'));
});

test('inventory aggregates shared targets and preserves same-name variants', () => {
  const home = tmpHome();
  const shared = path.join(home.configDir, 'shared', 'same');
  const a = path.join(home.configDir, 'a', 'skills');
  const b = path.join(home.configDir, 'b', 'skills');
  const c = path.join(home.configDir, 'c', 'skills');
  mkSkill(path.dirname(shared), path.basename(shared));
  mkSkill(a, 'same');
  fs.writeFileSync(
    path.join(a, 'same', 'SKILL.md'),
    '---\ndescription: Local variant\n---\n# local',
  );
  fs.mkdirSync(b, {recursive: true});
  fs.mkdirSync(c, {recursive: true});
  fs.symlinkSync(shared, path.join(b, 'same'));
  fs.symlinkSync(shared, path.join(c, 'same'));
  fs.writeFileSync(
    path.join(home.configDir, 'a', '.skill-lock.json'),
    JSON.stringify({skills: {same: {
      source: 'owner/local',
      sourceUrl: 'https://example.test/local.git',
      skillPath: 'skills/local/SKILL.md',
    }}}),
  );
  fs.writeFileSync(
    path.join(home.configDir, 'b', '.skill-lock.json'),
    JSON.stringify({skills: {same: {
      source: 'owner/shared',
      sourceUrl: 'https://example.test/shared.git',
      skillPath: 'skills/shared/SKILL.md',
    }}}),
  );
  const agents = [
    {name: 'a', dir: a},
    {name: 'b', dir: b},
    {name: 'c', dir: c},
  ];

  const instances = buildInventory(home, agents).instances;
  assert.equal(instances.length, 2);
  const local = instances.find((instance) => instance.realPath === fs.realpathSync(path.join(a, 'same')))!;
  const linked = instances.find((instance) => instance.realPath === fs.realpathSync(shared))!;
  assert.equal(local.relationships.length, 1);
  assert.equal(linked.relationships.length, 2);
  assert.equal(local.description, 'Local variant');
  assert.equal(local.provenance.sourceUrl, 'https://example.test/local.git');
  assert.equal(local.provenance.skillPath, 'skills/local/SKILL.md');
  assert.equal(linked.provenance.sourceUrl, 'https://example.test/shared.git');
  assert.match(local.displayName, /owner\/local/);
  assert.match(linked.displayName, /owner\/shared/);
});

test('inventory preserves on/off same-name variants within one agent', () => {
  const home = tmpHome();
  const dir = path.join(home.configDir, 'skills');
  mkSkill(dir, 'same');
  mkSkill(path.join(dir, '.off'), 'same');
  const instances = buildInventory(home, [{name: 'a', dir}]).instances;

  assert.equal(instances.length, 2);
  assert.deepEqual(
    instances.map((instance) => instance.relationships[0].info.presence).sort(),
    ['off', 'on'],
  );
});

test('inventory keeps broken links separate and detail uses explicit identity', () => {
  const home = tmpHome();
  const a = path.join(home.configDir, 'a');
  const b = path.join(home.configDir, 'b');
  mkSkill(a, 'same');
  mkSkill(b, 'same');
  fs.writeFileSync(path.join(a, 'same', 'SKILL.md'), '# first');
  fs.writeFileSync(path.join(b, 'same', 'SKILL.md'), '# second');
  fs.symlinkSync('/missing/target', path.join(a, 'broken'));
  const agents = [{name: 'a', dir: a}, {name: 'b', dir: b}];

  const instances = buildInventory(home, agents).instances;
  const broken = instances.find((instance) => instance.name === 'broken')!;
  assert.equal(broken.realPath, undefined);
  assert.equal(broken.relationships[0].info.target, '/missing/target');
  assert.equal(broken.sourceLabel, 'Source unknown');

  const second = instances.find((instance) => instance.realPath === fs.realpathSync(path.join(b, 'same')))!;
  fs.writeFileSync(path.join(home.configDir, 'state.json'), JSON.stringify({
    bundles: { selected: [second.id], legacy: ['same'] },
    tags: {},
  }));
  const detail = skillDetail(home, agents, second.id)!;
  assert.equal(detail.content, '# second');
  assert.equal(detail.sourceLabel, 'Source unknown');
  assert.deepEqual(detail.realPaths, [fs.realpathSync(path.join(b, 'same'))]);
  assert.deepEqual(detail.bundles, ['selected']);
  assert.equal(skillDetail(home, agents, 'same'), undefined);
});

test('unambiguous inventory labels do not gain a source suffix', () => {
  const home = tmpHome();
  const dir = path.join(home.configDir, 'skills');
  mkSkill(dir, 'only');
  const [instance] = buildInventory(home, [{name: 'a', dir}]).instances;
  assert.equal(instance.displayName, 'only');
});

test('tuiSnapshot rescans disk instead of caching on/off state', () => {
  const home = tmpHome();
  const dir = path.join(home.configDir, 'skills');
  mkSkill(dir, 'grilling');
  fs.writeFileSync(path.join(home.configDir, 'agents.conf'), `a = ${dir}\n`);

  assert.equal(tuiSnapshot(home).rows[0].agents.a?.presence, 'on');
  setSkill({ name: 'a', dir }, 'grilling', false);
  assert.equal(tuiSnapshot(home).rows[0].agents.a?.presence, 'off');
});

test('search matches loaded metadata but not SKILL.md body content', () => {
  const home = tmpHome();
  const dir = path.join(home.configDir, 'skills');
  mkSkill(dir, 'grilling');
  fs.writeFileSync(
    path.join(dir, 'grilling', 'SKILL.md'),
    '---\ndescription: Grill with charcoal\n---\nbody-only-needle',
  );
  fs.writeFileSync(
    path.join(home.configDir, 'state.json'),
    JSON.stringify({inventory: {grilling: {source: 'Chef/Skills'}}}),
  );
  const [row] = buildInventory(home, [{name: 'a', dir}]).instances;

  assert.equal(matchesSearch(row, 'CHARCOAL'), true);
  assert.equal(matchesSearch(row, 'chef/skills'), true);
  assert.equal(matchesSearch(row, 'body-only-needle'), false);
});

test('sortRows uses display labels and deterministic status/source fallbacks', () => {
  const rows = [
    {id: 'z', name: 'z', displayName: 'Zulu', provenance: {}, relationships: [], agents: {}, sourceLabel: ''},
    {id: 'a', name: 'a', displayName: 'Alpha', provenance: {source: 'source-z'}, relationships: [], agents: {}, sourceLabel: ''},
    {id: 'b', name: 'b', displayName: 'Bravo', provenance: {source: 'source-a'}, relationships: [], agents: {}, sourceLabel: ''},
  ] satisfies Row[];

  assert.deepEqual(sortRows(rows, 'name').map((row) => row.id), ['a', 'b', 'z']);
  assert.deepEqual(sortRows(rows, 'source').map((row) => row.id), ['b', 'a', 'z']);
  assert.deepEqual(
    sortRows(rows, 'status', (row) => row.id === 'z' ? '0:on' : '1:off').map((row) => row.id),
    ['z', 'a', 'b'],
  );
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
  const codeReview = rows.find((row) => row.name === 'code-review')!;
  const tags = { [codeReview.id]: ['review'] };

  assert.deepEqual(filterRows(rows, { tag: 'review' }, tags).map((r) => r.name), ['code-review']);
  assert.deepEqual(filterRows(rows, { tag: 'review' }, { 'code-review': ['review'] }), []);
  assert.deepEqual(filterRows(rows, { agent: 'a' }, tags).map((r) => r.name), ['grilling']);
  assert.deepEqual(untagged(rows, tags), ['grilling', 'only-b']);
});

test('relationship mutations preserve links and never delete local skill directories', () => {
  const home = tmpHome();
  const shared = path.join(home.configDir, 'shared');
  const sourceDir = path.join(home.configDir, 'source');
  const targetDir = path.join(home.configDir, 'target');
  mkSkill(shared, 'shared');
  mkSkill(sourceDir, 'local');
  fs.mkdirSync(targetDir, {recursive: true});
  const source = scanAgent({name: 'source', dir: sourceDir}).get('local')!;
  const target = {name: 'target', dir: targetDir};

  linkSkill(target, 'local', source.realPath!);
  const linked = scanAgent(target).get('local')!;
  assert.equal(linked.linked, true);
  assert.equal(linked.target, source.realPath);
  assert.throws(() => linkSkill(target, 'local', source.realPath!), /relationship already exists/);

  unlinkRelationship(target, linked);
  assert.equal(scanAgent(target).has('local'), false);
  assert.ok(fs.existsSync(path.join(sourceDir, 'local', 'SKILL.md')));

  mkSkill(targetDir, 'local');
  const local = scanAgent(target).get('local')!;
  assert.throws(() => unlinkRelationship(target, local), /never deleted/);
  assert.ok(fs.existsSync(path.join(targetDir, 'local', 'SKILL.md')));
});

test('selected relationship operations move broken links without dereferencing', () => {
  const home = tmpHome();
  const dir = path.join(home.configDir, 'skills');
  const agent = {name: 'a', dir};
  fs.mkdirSync(dir, {recursive: true});
  fs.symlinkSync('/gone/target', path.join(dir, 'broken'));

  const on = scanAgent(agent).get('broken')!;
  assert.equal(toggleRelationship(agent, on), 'off');
  const off = scanAgent(agent).get('broken')!;
  assert.equal(off.path, path.join(dir, '.off', 'broken'));
  assert.equal(off.target, '/gone/target');
  assert.equal(toggleRelationship(agent, off), 'on');
  const restored = scanAgent(agent).get('broken')!;
  assert.equal(restored.target, '/gone/target');

  unlinkRelationship(agent, restored);
  assert.throws(() => fs.lstatSync(path.join(dir, 'broken')));
});

test('loadAgents throws a clear error on malformed lines, keeps paths containing =', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home.configDir, 'agents.conf'), 'no-equals-here\n');
  assert.throws(() => loadAgents(home), /bad line in agents.conf/);
  fs.writeFileSync(path.join(home.configDir, 'agents.conf'), 'x = /tmp/a=b\n');
  assert.equal(loadAgents(home)[0].dir, '/tmp/a=b');
});
