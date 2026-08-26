import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyTargetMigration,
  defaultTargetDefinitions,
  loadTargets,
  normalizeSlotName,
  planTargetMigration,
  scanGlobalInventory,
  scanProjectInventory,
  type GenericTarget,
  type SkillTarget,
  type TargetDefinitionOverride,
} from '../src/inventory.ts';
import type { Home } from '../src/core.ts';

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

test('global scan records Target Relationships without moving disk state', () => {
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
  const runtimes: SkillTarget[] = [{
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
  assert.equal(state.targetInventory.version, 1);
  assert.equal(state.runtimeInventory, undefined);
  assert.equal(Object.keys(state.targetInventory.resources).length, 4);
  const resourceId = fs.realpathSync(path.join(discoveryRoot, 'local'));
  assert.doesNotThrow(() =>
    scanGlobalInventory(home, runtimes, { now: '2026-08-04T00:00:00.000Z' }));
  const repeated = JSON.parse(fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8'));
  assert.equal(repeated.targetInventory.resources[resourceId].firstSeenAt, '2026-08-03T00:00:00.000Z');
  assert.equal(repeated.targetInventory.resources[resourceId].lastSeenAt, '2026-08-04T00:00:00.000Z');
});

test('scan rewrites legacy runtime inventory metadata as Target metadata', () => {
  const home = tmpHome();
  const discoveryRoot = path.join(home.configDir, 'shared', 'skills');
  const parkingRoot = path.join(home.configDir, 'shared', '.skillspub-off', 'skills');
  const resource = mkSkill(discoveryRoot, 'example');
  const resourceId = fs.realpathSync(resource);
  fs.writeFileSync(path.join(home.configDir, 'state.json'), JSON.stringify({
    runtimeInventory: {
      version: 1,
      resources: {
        [resourceId]: {
          name: 'example',
          hash: 'stale',
          firstSeenAt: '2026-08-01T00:00:00.000Z',
          lastSeenAt: '2026-08-02T00:00:00.000Z',
        },
      },
      slots: {},
    },
  }));

  scanGlobalInventory(home, [{
    key: 'shared',
    kind: 'shared',
    discoveryRoot,
    parkingRoot,
    projectPath: '.agents/skills',
  }], { now: '2026-08-03T00:00:00.000Z' });

  const state = readJson(path.join(home.configDir, 'state.json')) as {
    runtimeInventory?: unknown;
    targetInventory: { resources: Record<string, { firstSeenAt: string }> };
  };
  assert.equal(state.runtimeInventory, undefined);
  assert.equal(state.targetInventory.resources[resourceId].firstSeenAt, '2026-08-01T00:00:00.000Z');
});

test('normalized entry names compete for one Target Slot without merging Variants', () => {
  const home = tmpHome();
  const discoveryRoot = path.join(home.configDir, 'runtime', 'skills');
  const parkingRoot = path.join(home.configDir, 'runtime', '.skillspub-off', 'skills');
  assert.doesNotThrow(() => mkSkill(discoveryRoot, 'Foo_Bar'));
  assert.doesNotThrow(() => mkSkill(parkingRoot, 'foo bar'));
  const lockFile = path.join(home.configDir, 'runtime', '.skill-lock.json');
  fs.writeFileSync(lockFile, JSON.stringify({
    version: 3,
    skills: { Foo_Bar: { source: 'owner/repo' } },
  }));

  const report = scanGlobalInventory(home, [{
    key: 'agent',
    kind: 'harness',
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
  const runtime: SkillTarget = {
    key: 'agent',
    kind: 'harness',
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
  fs.writeFileSync(lockFile, JSON.stringify({ version: 3, skills: {
    locked: {
      source: 'owner/repo',
      sourceUrl: 'https://github.com/owner/repo.git',
      skillPath: 'skills/locked',
    },
    ghost: { source: 'owner/repo', skillPath: 'skills/ghost' },
  } }));
  const runtime: SkillTarget = {
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
  const runtimes = loadTargets(home);
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
    report.targets.map(({ scope, writable, sourceDirectory }) => ({ scope, writable, sourceDirectory })),
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
  assert.ok(report.missing.some(({ targetId }) => targetId.startsWith('global:')));
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

test('one resource keeps independent provenance for each occupied Target Slot', () => {
  const home = tmpHome();
  const source = mkSkill(path.join(home.configDir, 'sources'), 'shared');
  const runtimes = ['one', 'two'].map((key) => {
    const root = path.join(home.configDir, key, 'skills');
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(source, path.join(root, 'shared'));
    const lockFile = path.join(home.configDir, key, '.skill-lock.json');
    fs.writeFileSync(lockFile, JSON.stringify({
      version: 3,
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
  const runtime: SkillTarget = {
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
    report.targets.filter(({ discoveryRoot }) => discoveryRoot === globalRoot).length,
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
    version: 3,
    skills: { example: { source: 'owner/repo' } },
  }));
  const runtime: SkillTarget = {
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
    targetInventory: {
      slots: Record<string, { provenance?: { source?: string } }>;
    };
  };
  assert.deepEqual(invalidState.bundles['repo:owner/repo'], [
    fs.realpathSync(path.join(discoveryRoot, 'example')),
  ]);
  assert.equal(
    Object.values(invalidState.targetInventory.slots)
      .some((slot) => slot.provenance?.source === 'owner/repo'),
    true,
  );

  fs.writeFileSync(lockFile, JSON.stringify({
    version: 3,
    skills: { example: { source: 'owner/repo' } },
  }));
  const restored = scanGlobalInventory(home, [runtime], {
    now: '2026-08-05T00:00:00.000Z',
  });
  assert.equal(restored.findings.some(({ code }) => code === 'source-changed'), false);

  fs.writeFileSync(lockFile, JSON.stringify({ version: 3, skills: [] }));
  const invalidSchema = scanGlobalInventory(home, [runtime], {
    now: '2026-08-06T00:00:00.000Z',
  });
  assert.equal(
    invalidSchema.findings.find(({ code }) => code === 'invalid-lock')?.category,
    'structural',
  );
  assert.equal(invalidSchema.findings.some(({ code }) => code === 'source-changed'), false);

  fs.writeFileSync(lockFile, JSON.stringify({
    version: 3,
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

test('existing Target registries merge later built-ins without mutation', () => {
  const home = tmpHome();
  const file = path.join(home.configDir, 'targets.json');
  const genericRoot = path.join(home.configDir, 'generic', 'skills');
  const project = path.join(home.configDir, 'project');
  fs.mkdirSync(project);
  const previousGrokHome = process.env.GROK_HOME;
  process.env.GROK_HOME = path.join(home.configDir, 'grok');
  try {
    const definitions = defaultTargetDefinitions();
    const oldKeys = new Set(['claude', 'shared', 'pi']);
    const overrides = definitions
      .filter(({ key }) => oldKeys.has(key))
      .map(({ key, projectPath }): TargetDefinitionOverride => {
        if (key === 'claude') return { key, disabled: true };
        return {
          key,
          discoveryRoot: path.join(home.configDir, key, 'skills'),
          parkingRoot: path.join(home.configDir, key, '.skillspub-off', 'skills'),
          projectPath,
          ...(key === 'shared'
            ? { lockFile: path.join(home.configDir, key, 'custom-lock.json') }
            : {}),
        };
      });
    const genericTarget: GenericTarget = {
      key: 'custom',
      kind: 'generic',
      discoveryRoot: genericRoot,
      parkingRoot: path.join(home.configDir, 'generic', '.skillspub-off', 'skills'),
      projectPath: '.custom/skills',
      lockFile: path.join(home.configDir, 'generic', 'custom-lock.json'),
    };
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      overrides,
      genericTargets: [genericTarget],
    }, null, 2) + '\n');
    const before = fs.readFileSync(file, 'utf8');
    const beforeEntries = fs.readdirSync(home.configDir, { recursive: true }).sort();

    const targets = loadTargets(home);

    assert.deepEqual(
      targets.map(({ key }) => key),
      [...definitions.filter(({ key }) => key !== 'claude').map(({ key }) => key), 'custom'],
    );
    for (const override of overrides) {
      const target = targets.find(({ key }) => key === override.key);
      if (override.disabled) {
        assert.equal(target, undefined);
        continue;
      }
      assert.deepEqual(target && {
        key: target.key,
        discoveryRoot: target.discoveryRoot,
        parkingRoot: target.parkingRoot,
        projectPath: target.projectPath,
        ...(target.lockFile ? { lockFile: target.lockFile } : {}),
      }, override);
    }
    const custom = targets.find(({ key }) => key === 'custom');
    assert.deepEqual(custom && {
      key: custom.key,
      kind: custom.kind,
      discoveryRoot: custom.discoveryRoot,
      parkingRoot: custom.parkingRoot,
      projectPath: custom.projectPath,
      lockFile: custom.lockFile,
    }, genericTarget);
    const canonicalProject = fs.realpathSync(project);
    const projectGrok = scanProjectInventory(home, project, undefined, { persist: false }).targets
      .find(({ key, scope }) => key === 'grok' && scope === 'project');
    assert.equal(projectGrok?.discoveryRoot, path.join(canonicalProject, '.grok', 'skills'));
    assert.equal(projectGrok?.parkingRoot, path.join(canonicalProject, '.skillspub', 'off', 'grok'));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(home.configDir, { recursive: true }).sort(), beforeEntries);
  } finally {
    if (previousGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousGrokHome;
  }
});

test('new built-ins reject conflicting Generic Target identities', () => {
  const previousGrokHome = process.env.GROK_HOME;
  try {
    for (const conflict of ['key', 'root'] as const) {
      const home = tmpHome();
      const grokRoot = path.join(home.configDir, 'grok', 'skills');
      process.env.GROK_HOME = path.dirname(grokRoot);
      let genericRoot = path.join(home.configDir, 'generic', 'skills');
      if (conflict === 'root') {
        fs.mkdirSync(grokRoot, { recursive: true });
        genericRoot = path.join(home.configDir, 'grok-alias');
        fs.symlinkSync(grokRoot, genericRoot, 'dir');
      }
      const file = path.join(home.configDir, 'targets.json');
      fs.writeFileSync(file, JSON.stringify({
        version: 1,
        overrides: [],
        genericTargets: [{
          key: conflict === 'key' ? 'grok' : 'custom',
          kind: 'generic',
          discoveryRoot: genericRoot,
          parkingRoot: path.join(home.configDir, 'generic', '.skillspub-off', 'skills'),
          projectPath: '.custom/skills',
        }],
      }));
      const before = fs.readFileSync(file, 'utf8');

      assert.throws(
        () => loadTargets(home),
        conflict === 'key' ? /duplicate Skill Target key: grok/ : /ambiguous Skill Target discovery root/,
      );
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
  } finally {
    if (previousGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previousGrokHome;
  }
});

test('Target migration previews legacy Runtime overrides and Generic Targets without side effects', () => {
  const home = tmpHome();
  const piRoot = path.join(home.configDir, 'custom-pi', 'skills');
  const genericRoot = path.join(home.configDir, 'other', 'skills');
  const legacyFile = path.join(home.configDir, 'runtimes.json');
  const legacy = {
    version: 1,
    runtimes: [
      {
        key: 'pi',
        kind: 'agent',
        discoveryRoot: piRoot,
        parkingRoot: path.join(home.configDir, 'custom-pi', '.skillspub-off', 'skills'),
        projectPath: '.pi/agent/skills',
      },
      {
        key: 'other',
        kind: 'agent',
        discoveryRoot: genericRoot,
        parkingRoot: path.join(home.configDir, 'other', '.skillspub-off', 'skills'),
        projectPath: '.other/skills',
      },
    ],
  };
  fs.writeFileSync(legacyFile, JSON.stringify(legacy, null, 2) + '\n');
  const stateFile = path.join(home.configDir, 'state.json');
  fs.writeFileSync(stateFile, '{"baseIntent":{"kept":"off"}}\n');
  const before = fs.readFileSync(legacyFile, 'utf8');

  const expectedTargets = [
    { key: 'pi', kind: 'harness', discoveryRoot: piRoot },
    { key: 'other', kind: 'generic', discoveryRoot: genericRoot },
  ];
  assert.deepEqual(
    loadTargets(home).map(({ key, kind, discoveryRoot }) => ({ key, kind, discoveryRoot })),
    expectedTargets,
  );
  const plan = planTargetMigration(home);
  assert.deepEqual(plan.overrides, [
    {
      key: 'pi',
      discoveryRoot: piRoot,
      parkingRoot: path.join(home.configDir, 'custom-pi', '.skillspub-off', 'skills'),
      projectPath: '.pi/agent/skills',
    },
    { key: 'claude', disabled: true },
    { key: 'shared', disabled: true },
  ]);
  assert.deepEqual(plan.introducedDefinitions.map(({ key, kind }) => ({ key, kind })), [
    { key: 'grok', kind: 'harness' },
  ]);
  assert.deepEqual(plan.genericTargets.map(({ key, kind, discoveryRoot }) => ({ key, kind, discoveryRoot })), [
    { key: 'other', kind: 'generic', discoveryRoot: genericRoot },
  ]);
  assert.equal(fs.existsSync(path.join(home.configDir, 'targets.json')), false);
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), before);

  applyTargetMigration(home, plan);

  assert.equal(fs.existsSync(legacyFile), false);
  assert.equal(fs.readFileSync(plan.backupFile!, 'utf8'), before);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{"baseIntent":{"kept":"off"}}\n');
  assert.deepEqual(
    loadTargets(home).map(({ key, kind, discoveryRoot }) => ({ key, kind, discoveryRoot })),
    [
      {
        key: 'grok',
        kind: 'harness',
        discoveryRoot: defaultTargetDefinitions().find(({ key }) => key === 'grok')!.discoveryRoot,
      },
      ...expectedTargets,
    ],
  );
  assert.equal(planTargetMigration(home).status, 'already-migrated');
});

test('Target migration rolls back only a newly written registry when the legacy backup fails', () => {
  const writeLegacy = (home: ReturnType<typeof tmpHome>) => {
    const root = path.join(home.configDir, 'pi', 'skills');
    fs.writeFileSync(path.join(home.configDir, 'runtimes.json'), JSON.stringify({
      version: 1,
      runtimes: [{
        key: 'pi', kind: 'agent', discoveryRoot: root,
        parkingRoot: path.join(home.configDir, 'pi', '.skillspub-off', 'skills'),
        projectPath: '.pi/agent/skills',
      }],
    }));
  };
  const failBackup = (plan: ReturnType<typeof planTargetMigration>) => {
    const rename = fs.renameSync;
    fs.renameSync = ((from, to) => {
      if (from === plan.legacyFile) throw new Error('injected legacy backup failure');
      return rename(from, to);
    }) as typeof fs.renameSync;
    try {
      assert.throws(() => applyTargetMigration({ configDir: path.dirname(plan.targetFile) }, plan),
        /injected legacy backup failure/);
    } finally {
      fs.renameSync = rename;
    }
  };

  const fresh = tmpHome();
  writeLegacy(fresh);
  const freshPlan = planTargetMigration(fresh);
  failBackup(freshPlan);
  assert.equal(fs.existsSync(freshPlan.targetFile), false);
  assert.equal(fs.existsSync(freshPlan.backupFile!), false);

  const existing = tmpHome();
  writeLegacy(existing);
  const initialPlan = planTargetMigration(existing);
  fs.writeFileSync(initialPlan.targetFile, JSON.stringify({
    version: 1,
    overrides: initialPlan.overrides,
    genericTargets: initialPlan.genericTargets,
  }));
  const existingPlan = planTargetMigration(existing);
  assert.equal(existingPlan.writeTarget, false);
  const before = fs.readFileSync(existingPlan.targetFile, 'utf8');
  failBackup(existingPlan);
  assert.equal(fs.readFileSync(existingPlan.targetFile, 'utf8'), before);
  assert.equal(fs.existsSync(existingPlan.backupFile!), false);
});

test('Target migration rejects concurrent legacy changes before mutation', () => {
  const home = tmpHome();
  const legacyFile = path.join(home.configDir, 'runtimes.json');
  fs.writeFileSync(legacyFile, JSON.stringify({
    version: 1,
    runtimes: [{
      key: 'pi',
      kind: 'agent',
      discoveryRoot: path.join(home.configDir, 'pi', 'skills'),
      parkingRoot: path.join(home.configDir, 'pi', '.skillspub-off', 'skills'),
      projectPath: '.pi/agent/skills',
    }],
  }));
  const plan = planTargetMigration(home);
  fs.appendFileSync(legacyFile, '\n');

  assert.throws(
    () => applyTargetMigration(home, plan),
    (error: Error & { code?: string }) => error.code === 'concurrent_modification',
  );
  assert.equal(fs.existsSync(plan.targetFile), false);
  assert.equal(fs.existsSync(plan.backupFile!), false);
});

test('Target migration preflights write permissions without partial writes', () => {
  const home = tmpHome();
  const legacyFile = path.join(home.configDir, 'runtimes.json');
  fs.writeFileSync(legacyFile, JSON.stringify({
    version: 1,
    runtimes: [{
      key: 'pi',
      kind: 'agent',
      discoveryRoot: path.join(home.configDir, 'pi', 'skills'),
      parkingRoot: path.join(home.configDir, 'pi', '.skillspub-off', 'skills'),
      projectPath: '.pi/agent/skills',
    }],
  }));
  const access = fs.accessSync;
  fs.accessSync = ((file, mode) => {
    if (file === home.configDir) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return access(file, mode);
  }) as typeof fs.accessSync;
  try {
    assert.throws(() => planTargetMigration(home), /permission denied/);
  } finally {
    fs.accessSync = access;
  }

  assert.equal(fs.existsSync(path.join(home.configDir, 'targets.json')), false);
  assert.equal(fs.existsSync(`${legacyFile}.v1.bak`), false);
  assert.ok(fs.existsSync(legacyFile));
});

test('Target migration refuses malformed or ambiguous legacy data without partial writes', () => {
  const malformed = tmpHome();
  const malformedFile = path.join(malformed.configDir, 'runtimes.json');
  fs.writeFileSync(malformedFile, '{broken');

  assert.throws(() => planTargetMigration(malformed), /cannot read Runtime registry/);
  assert.equal(fs.readFileSync(malformedFile, 'utf8'), '{broken');
  assert.equal(fs.existsSync(path.join(malformed.configDir, 'targets.json')), false);
  assert.equal(fs.existsSync(`${malformedFile}.v1.bak`), false);

  const ambiguous = tmpHome();
  const root = path.join(ambiguous.configDir, 'shared', 'skills');
  const ambiguousFile = path.join(ambiguous.configDir, 'runtimes.json');
  const content = JSON.stringify({
    version: 1,
    runtimes: [
      {
        key: 'pi', kind: 'agent', discoveryRoot: root,
        parkingRoot: path.join(ambiguous.configDir, 'shared', '.skillspub-off', 'skills'),
        projectPath: '.pi/agent/skills',
      },
      {
        key: 'custom', kind: 'agent', discoveryRoot: root,
        parkingRoot: path.join(ambiguous.configDir, 'custom', '.skillspub-off', 'skills'),
        projectPath: '.custom/skills',
      },
    ],
  });
  fs.writeFileSync(ambiguousFile, content);

  assert.throws(() => planTargetMigration(ambiguous), /ambiguous Skill Target discovery root/);
  assert.equal(fs.readFileSync(ambiguousFile, 'utf8'), content);
  assert.equal(fs.existsSync(path.join(ambiguous.configDir, 'targets.json')), false);
  assert.equal(fs.existsSync(`${ambiguousFile}.v1.bak`), false);

  const unsafe = tmpHome();
  const unsafeFile = path.join(unsafe.configDir, 'runtimes.json');
  fs.writeFileSync(unsafeFile, JSON.stringify({
    version: 1,
    runtimes: [{
      key: '../outside', kind: 'agent',
      discoveryRoot: path.join(unsafe.configDir, 'custom', 'skills'),
      parkingRoot: path.join(unsafe.configDir, 'custom', '.skillspub-off', 'skills'),
      projectPath: '.custom/skills',
    }],
  }));

  assert.throws(() => planTargetMigration(unsafe), /invalid Runtime entry/);
  assert.equal(fs.existsSync(path.join(unsafe.configDir, 'targets.json')), false);
  assert.equal(fs.existsSync(`${unsafeFile}.v1.bak`), false);

  const aliases = tmpHome();
  const actualRoot = path.join(aliases.configDir, 'actual', 'skills');
  const aliasRoot = path.join(aliases.configDir, 'alias-skills');
  fs.mkdirSync(actualRoot, { recursive: true });
  fs.symlinkSync(actualRoot, aliasRoot, 'dir');
  const aliasFile = path.join(aliases.configDir, 'runtimes.json');
  fs.writeFileSync(aliasFile, JSON.stringify({
    version: 1,
    runtimes: [
      {
        key: 'pi', kind: 'agent', discoveryRoot: actualRoot,
        parkingRoot: path.join(aliases.configDir, 'actual', '.skillspub-off', 'skills'),
        projectPath: '.pi/agent/skills',
      },
      {
        key: 'custom', kind: 'agent', discoveryRoot: aliasRoot,
        parkingRoot: path.join(aliases.configDir, 'custom', '.skillspub-off', 'skills'),
        projectPath: '.custom/skills',
      },
    ],
  }));

  assert.throws(() => planTargetMigration(aliases), /ambiguous Skill Target discovery root/);
  assert.equal(fs.existsSync(path.join(aliases.configDir, 'targets.json')), false);
  assert.equal(fs.existsSync(`${aliasFile}.v1.bak`), false);
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
      kind: 'harness',
      discoveryRoot,
      parkingRoot,
      projectPath: '.agent/skills',
    }]),
    /cannot read state/,
  );
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{broken');
});
