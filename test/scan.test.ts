import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadRuntimes,
  normalizeSlotName,
  scanGlobalInventory,
  scanProjectInventory,
  type Home,
  type Runtime,
} from '../src/core.ts';

function tmpHome(): Home {
  return { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-scan-')) };
}

function mkSkill(root: string, name: string, content = `# ${name}`): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  return dir;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    assert.fail(`cannot read test JSON ${file}: ${(error as Error).message}`);
  }
}

test('global scan records Runtime Relationships without moving disk state', () => {
  const home = tmpHome();
  const discoveryRoot = path.join(home.configDir, 'runtime', 'skills');
  const parkingRoot = path.join(home.configDir, 'runtime', '.skillspub-off', 'skills');
  const source = mkSkill(path.join(home.configDir, 'sources'), 'linked');
  const sourceOn = mkSkill(path.join(home.configDir, 'sources'), 'linked-on');
  fs.mkdirSync(discoveryRoot, { recursive: true });
  assert.doesNotThrow(() =>
    fs.symlinkSync(sourceOn, path.join(discoveryRoot, 'linked-on')));
  mkSkill(discoveryRoot, 'local');
  fs.mkdirSync(parkingRoot, { recursive: true });
  assert.doesNotThrow(() =>
    fs.symlinkSync(source, path.join(parkingRoot, 'linked')));
  mkSkill(parkingRoot, 'local-off');
  const runtimes: Runtime[] = [{
    key: 'shared',
    kind: 'shared',
    discoveryRoot,
    parkingRoot,
    projectPath: '.agents/skills',
  }];

  const report = scanGlobalInventory(home, runtimes, { now: '2026-08-03T00:00:00.000Z' });

  assert.deepEqual(
    report.relationships.map(({ activation, form, name }) => ({ activation, form, name })),
    [
      { activation: 'on', form: 'link', name: 'linked-on' },
      { activation: 'on', form: 'local', name: 'local' },
      { activation: 'off', form: 'link', name: 'linked' },
      { activation: 'off', form: 'local', name: 'local-off' },
    ],
  );
  assert.equal(report.resources.length, 4);
  assert.ok(fs.existsSync(path.join(discoveryRoot, 'local', 'SKILL.md')));
  assert.ok(fs.lstatSync(path.join(parkingRoot, 'linked')).isSymbolicLink());

  const state = JSON.parse(fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8'));
  assert.equal(state.runtimeInventory.version, 1);
  assert.equal(Object.keys(state.runtimeInventory.resources).length, 4);
  const resourceId = fs.realpathSync(path.join(discoveryRoot, 'local'));
  assert.doesNotThrow(() =>
    scanGlobalInventory(home, runtimes, { now: '2026-08-04T00:00:00.000Z' }));
  const repeated = JSON.parse(fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8'));
  assert.equal(repeated.runtimeInventory.resources[resourceId].firstSeenAt, '2026-08-03T00:00:00.000Z');
  assert.equal(repeated.runtimeInventory.resources[resourceId].lastSeenAt, '2026-08-04T00:00:00.000Z');
});

test('normalized entry names compete for one Runtime Slot without merging Variants', () => {
  const home = tmpHome();
  const discoveryRoot = path.join(home.configDir, 'runtime', 'skills');
  const parkingRoot = path.join(home.configDir, 'runtime', '.skillspub-off', 'skills');
  assert.doesNotThrow(() => mkSkill(discoveryRoot, 'Foo_Bar'));
  assert.doesNotThrow(() => mkSkill(parkingRoot, 'foo bar'));
  const lockFile = path.join(home.configDir, 'runtime', '.skill-lock.json');
  fs.writeFileSync(lockFile, JSON.stringify({
    skills: { Foo_Bar: { source: 'owner/repo' } },
  }));

  const report = scanGlobalInventory(home, [{
    key: 'agent',
    kind: 'agent',
    discoveryRoot,
    parkingRoot,
    projectPath: '.agent/skills',
    lockFile,
  }], { now: '2026-08-03T00:00:00.000Z' });

  assert.equal(normalizeSlotName(' Foo_Bar '), 'foo-bar');
  assert.equal(report.resources.length, 2);
  assert.deepEqual(
    report.findings
      .filter(({ code }) => code === 'on-off-conflict' || code === 'slot-conflict')
      .map(({ code, slot }) => ({ code, slot }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    [
      { code: 'on-off-conflict', slot: 'foo-bar' },
      { code: 'slot-conflict', slot: 'foo-bar' },
    ],
  );
  const state = readJson(report.stateFile) as { bundles: Record<string, string[]> };
  assert.equal(state.bundles['repo:owner/repo'], undefined);
});

test('resource hash frames paths and bytes so distinct directory states differ', () => {
  const home = tmpHome();
  const discoveryRoot = path.join(home.configDir, 'runtime', 'skills');
  const parkingRoot = path.join(home.configDir, 'runtime', '.skillspub-off', 'skills');
  const resource = mkSkill(discoveryRoot, 'example');
  fs.writeFileSync(path.join(resource, 'x'), 'bc');
  const runtime: Runtime = {
    key: 'agent',
    kind: 'agent',
    discoveryRoot,
    parkingRoot,
    projectPath: '.agent/skills',
  };
  scanGlobalInventory(home, [runtime], { now: '2026-08-03T00:00:00.000Z' });
  fs.renameSync(path.join(resource, 'x'), path.join(resource, 'xb'));
  fs.writeFileSync(path.join(resource, 'xb'), 'c');

  const changed = scanGlobalInventory(home, [runtime], { now: '2026-08-04T00:00:00.000Z' });

  assert.equal(changed.findings.some(({ code }) => code === 'changed-resource'), true);
});

test('scan separates structural anomalies, metadata flags, and external changes', () => {
  const home = tmpHome();
  const discoveryRoot = path.join(home.configDir, 'shared', 'skills');
  const parkingRoot = path.join(home.configDir, 'shared', '.skillspub-off', 'skills');
  const lockFile = path.join(home.configDir, 'shared', '.skill-lock.json');
  const locked = mkSkill(
    discoveryRoot,
    'locked',
    '---\nallowed-tools: Bash(example-cli:*)\n---\n# locked',
  );
  mkSkill(discoveryRoot, 'collision', '# on');
  mkSkill(parkingRoot, 'collision', '# off');
  fs.symlinkSync('/missing/skill', path.join(discoveryRoot, 'broken'));
  fs.writeFileSync(lockFile, JSON.stringify({ skills: {
    locked: {
      source: 'owner/repo',
      sourceUrl: 'https://github.com/owner/repo.git',
      skillPath: 'skills/locked',
    },
    ghost: { source: 'owner/repo', skillPath: 'skills/ghost' },
  } }));
  const runtime: Runtime = {
    key: 'shared',
    kind: 'shared',
    discoveryRoot,
    parkingRoot,
    projectPath: '.agents/skills',
    lockFile,
  };
  fs.writeFileSync(path.join(home.configDir, 'state.json'), JSON.stringify({
    bundles: { manual: ['kept'] },
    tags: {},
    baseIntent: { kept: 'off' },
  }));

  const first = scanGlobalInventory(home, [runtime], { now: '2026-08-03T00:00:00.000Z' });
  const codes = new Set(first.findings.map(({ code }) => code));
  assert.deepEqual(
    [...codes].sort(),
    [
      'broken-link',
      'cli-coupled',
      'lock-file-missing',
      'new-resource',
      'on-off-conflict',
      'untagged',
    ],
  );
  assert.equal(first.findings.find(({ code }) => code === 'broken-link')?.category, 'structural');
  assert.equal(first.findings.find(({ code }) => code === 'untagged')?.category, 'metadata');
  assert.equal(first.findings.find(({ code }) => code === 'new-resource')?.category, 'change');
  assert.equal(first.slots.find(({ name }) => name === 'locked')?.provenance?.source, 'owner/repo');
  assert.equal(first.resources.find(({ name }) => name === 'locked')?.cliCoupled, true);

  const unchanged = scanGlobalInventory(home, [runtime], { now: '2026-08-04T00:00:00.000Z' });
  assert.equal(unchanged.findings.some(({ code }) => code === 'new-resource'), false);
  assert.equal(unchanged.findings.some(({ code }) => code === 'changed-resource'), false);

  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.skills.locked.source = 'other/repo';
  lock.skills.locked.sourceUrl = 'https://github.com/other/repo.git';
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  const replaced = scanGlobalInventory(home, [runtime], { now: '2026-08-05T00:00:00.000Z' });
  assert.equal(replaced.findings.find(({ code }) => code === 'source-changed')?.category, 'change');

  fs.appendFileSync(path.join(locked, 'SKILL.md'), '\nchanged');
  const changed = scanGlobalInventory(home, [runtime], { now: '2026-08-06T00:00:00.000Z' });
  assert.equal(changed.findings.some(({ code }) => code === 'changed-resource'), true);
  const state = JSON.parse(fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.bundles['repo:other/repo'], [fs.realpathSync(locked)]);
  assert.deepEqual(state.bundles.manual, ['kept']);
  assert.deepEqual(state.baseIntent, { kept: 'off' });

  fs.rmSync(locked, { recursive: true });
  const removed = scanGlobalInventory(home, [runtime], { now: '2026-08-07T00:00:00.000Z' });
  assert.equal(removed.findings.some(({ code }) => code === 'removed-resource'), true);
  const afterRemoval = JSON.parse(fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8'));
  assert.deepEqual(afterRemoval.bundles['repo:other/repo'], [fs.realpathSync(path.dirname(locked)) + '/locked']);
});

test('Project scan reads current, parent, and Global roots but writes only exact Project state', () => {
  const home = tmpHome();
  const globalRoot = path.join(home.configDir, 'global', '.agents', 'skills');
  const globalParking = path.join(home.configDir, 'global', '.agents', '.skillspub-off', 'skills');
  const projectParent = path.join(home.configDir, 'workspace', 'team');
  const project = path.join(projectParent, 'app');
  const alias = path.join(home.configDir, 'project-alias');
  fs.mkdirSync(project, { recursive: true });
  fs.symlinkSync(project, alias, 'dir');
  mkSkill(globalRoot, 'global-skill');
  mkSkill(path.join(projectParent, '.agents', 'skills'), 'parent-skill');
  const projectSkill = mkSkill(path.join(project, '.agents', 'skills'), 'project-skill');
  mkSkill(path.join(project, '.skillspub', 'off', 'shared'), 'parked-skill');
  fs.writeFileSync(
    path.join(home.configDir, 'runtimes.json'),
    JSON.stringify({ version: 1, runtimes: [{
      key: 'shared',
      kind: 'shared',
      discoveryRoot: globalRoot,
      parkingRoot: globalParking,
      projectPath: '.agents/skills',
    }] }),
  );

  fs.writeFileSync(path.join(home.configDir, 'state.json'), JSON.stringify({
    tags: { [fs.realpathSync(projectSkill)]: ['project'] },
    bundles: { manual: ['kept'] },
  }));
  const runtimes = loadRuntimes(home);
  assert.equal(
    runtimes[0].lockFile,
    path.join(path.dirname(globalRoot), '.skill-lock.json'),
  );
  const report = scanProjectInventory(home, alias, runtimes, {
    now: '2026-08-03T00:00:00.000Z',
  });
  const exact = fs.realpathSync(project);

  assert.equal(report.projectPath, exact);
  assert.equal(report.stateFile, path.join(exact, '.skillspub', 'state.json'));
  assert.deepEqual(
    report.runtimes.map(({ scope, writable, sourceDirectory }) => ({ scope, writable, sourceDirectory })),
    [
      { scope: 'project', writable: true, sourceDirectory: exact },
      { scope: 'parent', writable: false, sourceDirectory: fs.realpathSync(projectParent) },
      { scope: 'global', writable: false, sourceDirectory: undefined },
    ],
  );
  assert.deepEqual(
    report.relationships.map(({ name, activation, readOnly }) => ({ name, activation, readOnly })),
    [
      { name: 'project-skill', activation: 'on', readOnly: false },
      { name: 'parked-skill', activation: 'off', readOnly: false },
      { name: 'parent-skill', activation: 'on', readOnly: true },
      { name: 'global-skill', activation: 'on', readOnly: true },
    ],
  );
  assert.ok(report.missing.some(({ runtimeId }) => runtimeId.startsWith('global:')));
  assert.equal(
    report.findings.some(({ code, resourceId }) =>
      code === 'untagged' && resourceId === fs.realpathSync(projectSkill)),
    false,
  );
  const projectState = JSON.parse(fs.readFileSync(report.stateFile, 'utf8'));
  assert.equal('tags' in projectState, false);
  assert.equal('bundles' in projectState, false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8')).bundles,
    { manual: ['kept'] },
  );
});

test('one resource keeps independent provenance for each occupied Runtime Slot', () => {
  const home = tmpHome();
  const source = mkSkill(path.join(home.configDir, 'sources'), 'shared');
  const runtimes = ['one', 'two'].map((key) => {
    const root = path.join(home.configDir, key, 'skills');
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(source, path.join(root, 'shared'));
    const lockFile = path.join(home.configDir, key, '.skill-lock.json');
    fs.writeFileSync(lockFile, JSON.stringify({
      skills: { shared: { source: `owner/${key}` } },
    }));
    return {
      key,
      kind: 'shared' as const,
      discoveryRoot: root,
      parkingRoot: path.join(home.configDir, key, '.skillspub-off', 'skills'),
      projectPath: `.agents/${key}/skills`,
      lockFile,
    };
  });

  const report = scanGlobalInventory(home, runtimes, { now: '2026-08-03T00:00:00.000Z' });

  assert.equal(report.resources.length, 1);
  assert.deepEqual(
    report.slots.map(({ provenance }) => provenance?.source).sort(),
    ['owner/one', 'owner/two'],
  );
  const state = JSON.parse(fs.readFileSync(report.stateFile, 'utf8'));
  assert.deepEqual(state.bundles['repo:owner/one'], [fs.realpathSync(source)]);
  assert.deepEqual(state.bundles['repo:owner/two'], [fs.realpathSync(source)]);
});

test('Project scan does not duplicate a Global root that is also an ancestor root', () => {
  const home = tmpHome();
  const project = path.join(home.configDir, 'project');
  const globalRoot = path.join(home.configDir, '.agents', 'skills');
  const globalParking = path.join(home.configDir, '.agents', '.skillspub-off', 'skills');
  fs.mkdirSync(project, { recursive: true });
  mkSkill(globalRoot, 'global-skill');
  const runtime: Runtime = {
    key: 'shared',
    kind: 'shared',
    discoveryRoot: globalRoot,
    parkingRoot: globalParking,
    projectPath: '.agents/skills',
  };

  const report = scanProjectInventory(home, project, [runtime], {
    now: '2026-08-03T00:00:00.000Z',
  });

  assert.equal(
    report.relationships.filter(({ name }) => name === 'global-skill').length,
    1,
  );
  assert.equal(
    report.runtimes.filter(({ discoveryRoot }) => discoveryRoot === globalRoot).length,
    1,
  );
});

test('malformed installer lock is structural, not an external source replacement', () => {
  const home = tmpHome();
  const discoveryRoot = path.join(home.configDir, 'shared', 'skills');
  const parkingRoot = path.join(home.configDir, 'shared', '.skillspub-off', 'skills');
  const lockFile = path.join(home.configDir, 'shared', '.skill-lock.json');
  mkSkill(discoveryRoot, 'example');
  fs.writeFileSync(lockFile, JSON.stringify({
    skills: { example: { source: 'owner/repo' } },
  }));
  const runtime: Runtime = {
    key: 'shared',
    kind: 'shared',
    discoveryRoot,
    parkingRoot,
    projectPath: '.agents/skills',
    lockFile,
  };
  scanGlobalInventory(home, [runtime], { now: '2026-08-03T00:00:00.000Z' });
  fs.writeFileSync(lockFile, '{broken');

  const report = scanGlobalInventory(home, [runtime], { now: '2026-08-04T00:00:00.000Z' });

  assert.equal(report.findings.find(({ code }) => code === 'invalid-lock')?.category, 'structural');
  assert.equal(report.findings.some(({ code }) => code === 'source-changed'), false);
  const invalidState = readJson(report.stateFile) as {
    bundles: Record<string, string[]>;
    runtimeInventory: {
      slots: Record<string, { provenance?: { source?: string } }>;
    };
  };
  assert.deepEqual(invalidState.bundles['repo:owner/repo'], [
    fs.realpathSync(path.join(discoveryRoot, 'example')),
  ]);
  assert.equal(
    Object.values(invalidState.runtimeInventory.slots)
      .some((slot) => slot.provenance?.source === 'owner/repo'),
    true,
  );

  fs.writeFileSync(lockFile, JSON.stringify({
    skills: { example: { source: 'owner/repo' } },
  }));
  const restored = scanGlobalInventory(home, [runtime], {
    now: '2026-08-05T00:00:00.000Z',
  });
  assert.equal(restored.findings.some(({ code }) => code === 'source-changed'), false);

  fs.writeFileSync(lockFile, JSON.stringify({ skills: [] }));
  const invalidSchema = scanGlobalInventory(home, [runtime], {
    now: '2026-08-06T00:00:00.000Z',
  });
  assert.equal(
    invalidSchema.findings.find(({ code }) => code === 'invalid-lock')?.category,
    'structural',
  );
  assert.equal(invalidSchema.findings.some(({ code }) => code === 'source-changed'), false);

  fs.writeFileSync(lockFile, JSON.stringify({
    skills: { example: { source: 7 } },
  }));
  const invalidField = scanGlobalInventory(home, [runtime], {
    now: '2026-08-07T00:00:00.000Z',
  });
  assert.equal(
    invalidField.findings.find(({ code }) => code === 'invalid-lock')?.category,
    'structural',
  );
  assert.equal(invalidField.findings.some(({ code }) => code === 'source-changed'), false);
});

test('Runtime registry migrates legacy Agent config into JSON with external parking', () => {
  const home = tmpHome();
  const discoveryRoot = path.join(home.configDir, 'legacy', 'skills');
  fs.writeFileSync(
    path.join(home.configDir, 'agents.conf'),
    `agents = ${discoveryRoot}\n`,
  );

  const [runtime] = loadRuntimes(home);

  assert.equal(runtime.key, 'shared');
  assert.equal(runtime.kind, 'shared');
  assert.equal(runtime.discoveryRoot, discoveryRoot);
  assert.equal(
    runtime.parkingRoot,
    path.join(path.dirname(discoveryRoot), '.skillspub-off', 'skills'),
  );
  assert.equal(runtime.lockFile, path.join(path.dirname(discoveryRoot), '.skill-lock.json'));
  assert.ok(fs.existsSync(path.join(home.configDir, 'runtimes.json')));
});

test('scan refuses to overwrite malformed state', () => {
  const home = tmpHome();
  const discoveryRoot = path.join(home.configDir, 'runtime', 'skills');
  const parkingRoot = path.join(home.configDir, 'runtime', '.skillspub-off', 'skills');
  mkSkill(discoveryRoot, 'example');
  const stateFile = path.join(home.configDir, 'state.json');
  fs.writeFileSync(stateFile, '{broken');

  assert.throws(
    () => scanGlobalInventory(home, [{
      key: 'agent',
      kind: 'agent',
      discoveryRoot,
      parkingRoot,
      projectPath: '.agent/skills',
    }]),
    /cannot read state/,
  );
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{broken');
});
