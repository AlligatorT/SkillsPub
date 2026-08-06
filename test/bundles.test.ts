import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addBundleMembers,
  addResourceTags,
  createBundle,
  expandSelector,
  removeBundleMembers,
  removeResourceTags,
} from '../src/catalog.ts';
import {
  applyActivationPlan,
  planActivation,
  remainingDrift,
} from '../src/reconcile.ts';
import { scanGlobalInventory, type Runtime } from '../src/inventory.ts';

function setup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-bundles-'));
  const discoveryRoot = path.join(configDir, 'shared', 'skills');
  const parkingRoot = path.join(configDir, 'shared', '.skillspub-off', 'skills');
  for (const name of ['one', 'two']) {
    fs.mkdirSync(path.join(discoveryRoot, name), { recursive: true });
    fs.writeFileSync(path.join(discoveryRoot, name, 'SKILL.md'), `# ${name}`);
  }
  const runtime: Runtime = {
    key: 'shared',
    kind: 'shared',
    discoveryRoot,
    parkingRoot,
    projectPath: '.agents/skills',
  };
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1,
    runtimes: [runtime],
  }));
  return { home: { configDir }, runtime, discoveryRoot, parkingRoot };
}

test('selector expansion reads current Bundle membership every time', () => {
  const { home, runtime } = setup();
  const report = scanGlobalInventory(home, [runtime]);
  const ids = Object.fromEntries(report.resources.map(({ name, id }) => [name, id]));
  assert.doesNotThrow(() => createBundle(home, 'tools', ['skill:one']));

  assert.deepEqual(expandSelector(home, 'bundle:tools', report).resourceIds, [ids.one]);

  assert.doesNotThrow(() => addBundleMembers(home, 'tools', ['skill:two']));
  assert.deepEqual(
    expandSelector(home, 'bundle:tools', report).resourceIds.sort((a, b) => a.localeCompare(b)),
    [ids.one, ids.two].sort((a, b) => a.localeCompare(b)),
  );

  assert.doesNotThrow(() => removeBundleMembers(home, 'tools', ['skill:one']));
  assert.deepEqual(expandSelector(home, 'bundle:tools', report).resourceIds, [ids.two]);
});

test('Tag selectors expand current resource membership and retain stale references', () => {
  const { home, runtime } = setup();
  const report = scanGlobalInventory(home, [runtime]);
  const ids = Object.fromEntries(report.resources.map(({ name, id }) => [name, id]));

  let changed = 0;
  assert.doesNotThrow(() => {
    changed = addResourceTags(home, 'skill:one', ['backend']);
  });
  assert.equal(changed, 1);
  assert.deepEqual(expandSelector(home, 'tag:backend', report).resourceIds, [ids.one]);
  assert.doesNotThrow(() => {
    changed = addResourceTags(home, 'skill:two', ['backend']);
  });
  assert.equal(changed, 1);
  assert.deepEqual(
    expandSelector(home, 'tag:backend', report).resourceIds.sort((a, b) => a.localeCompare(b)),
    [ids.one, ids.two].sort((a, b) => a.localeCompare(b)),
  );

  fs.rmSync(ids.one, { recursive: true });
  const rescanned = scanGlobalInventory(home, [runtime]);
  assert.deepEqual(expandSelector(home, 'tag:backend', rescanned).staleResourceIds, [ids.one]);
  assert.doesNotThrow(() => {
    changed = removeResourceTags(home, `skill:${ids.one}`, ['backend']);
  });
  assert.equal(changed, 1);
  assert.deepEqual(expandSelector(home, 'tag:backend', rescanned).resourceIds, [ids.two]);
});

test('OFF intent stays latent while an active Preset claim requires ON', () => {
  const { home, runtime, discoveryRoot, parkingRoot } = setup();
  assert.doesNotThrow(() => scanGlobalInventory(home, [runtime]));
  assert.doesNotThrow(() => createBundle(home, 'tools', ['skill:one']));
  const stateFile = path.join(home.configDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.claims = { 'global:shared\0one': ['always-on'] };
  fs.writeFileSync(stateFile, JSON.stringify(state));

  const plan = planActivation(home, 'bundle:tools', ['shared'], 'off');

  assert.equal(plan.targets[0].intent, 'off');
  assert.equal(plan.targets[0].to, 'on');
  assert.doesNotThrow(() => applyActivationPlan(home, plan));
  const updated = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(updated.baseIntent['global:shared\0one'], 'off');
  assert.ok(fs.existsSync(path.join(discoveryRoot, 'one', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(parkingRoot, 'one')), false);
});

test('moving a local resource retargets dependent Links and can link a missing Slot', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-bundle-links-'));
  const sourceRoot = path.join(configDir, 'source', 'skills');
  const sourceParking = path.join(configDir, 'source', 'off');
  const consumerRoot = path.join(configDir, 'consumer', 'skills');
  const targetRoot = path.join(configDir, 'target', 'skills');
  const source = path.join(sourceRoot, 'example');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# example');
  fs.mkdirSync(consumerRoot, { recursive: true });
  fs.symlinkSync(source, path.join(consumerRoot, 'example'), 'dir');
  const runtimes: Runtime[] = [
    {
      key: 'source', kind: 'shared', discoveryRoot: sourceRoot,
      parkingRoot: sourceParking, projectPath: '.agents/source/skills',
    },
    {
      key: 'consumer', kind: 'shared', discoveryRoot: consumerRoot,
      parkingRoot: path.join(configDir, 'consumer', 'off'),
      projectPath: '.agents/consumer/skills',
    },
    {
      key: 'target', kind: 'shared', discoveryRoot: targetRoot,
      parkingRoot: path.join(configDir, 'target', 'off'),
      projectPath: '.agents/target/skills',
    },
  ];
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({ version: 1, runtimes }));
  const home = { configDir };
  assert.doesNotThrow(() => scanGlobalInventory(home, runtimes));
  assert.doesNotThrow(() => createBundle(home, 'tools', ['skill:example']));

  assert.doesNotThrow(() =>
    applyActivationPlan(home, planActivation(home, 'bundle:tools', ['source'], 'off')));

  const parked = path.join(sourceParking, 'example');
  assert.equal(fs.realpathSync(path.join(consumerRoot, 'example')), fs.realpathSync(parked));

  assert.doesNotThrow(() =>
    applyActivationPlan(home, planActivation(home, 'bundle:tools', ['target'], 'on')));
  assert.equal(fs.realpathSync(path.join(targetRoot, 'example')), fs.realpathSync(parked));
});

test('a partial I/O failure preserves moved Bundle identities for an idempotent retry', () => {
  const { home, runtime, discoveryRoot, parkingRoot } = setup();
  assert.doesNotThrow(() => scanGlobalInventory(home, [runtime]));
  assert.doesNotThrow(() => createBundle(home, 'tools', ['skill:one', 'skill:two']));
  const plan = planActivation(home, 'bundle:tools', ['shared'], 'off');
  const blocked = path.join(parkingRoot, 'two');
  fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(path.join(blocked, 'occupied'), 'blocked');

  assert.throws(() => applyActivationPlan(home, plan));
  assert.ok(fs.existsSync(path.join(parkingRoot, 'one', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(discoveryRoot, 'two', 'SKILL.md')));
  const actual = scanGlobalInventory(home, [runtime], { persist: false });
  assert.deepEqual(remainingDrift(plan, actual), ['global:shared/two']);

  fs.rmSync(blocked, { recursive: true });
  const retry = planActivation(home, 'bundle:tools', ['shared'], 'off');
  assert.doesNotThrow(() => applyActivationPlan(home, retry));
  assert.ok(fs.existsSync(path.join(parkingRoot, 'two', 'SKILL.md')));
});

test('moving a relative Link preserves its target across differently nested roots', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-relative-link-'));
  const source = path.join(configDir, 'resources', 'example');
  const discoveryRoot = path.join(configDir, 'runtime', 'skills');
  const parkingRoot = path.join(configDir, 'runtime', 'deep', 'off', 'skills');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# example');
  fs.mkdirSync(discoveryRoot, { recursive: true });
  fs.symlinkSync(path.relative(discoveryRoot, source), path.join(discoveryRoot, 'example'), 'dir');
  const runtime: Runtime = {
    key: 'shared', kind: 'shared', discoveryRoot, parkingRoot,
    projectPath: '.agents/skills',
  };
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1, runtimes: [runtime],
  }));
  const home = { configDir };
  assert.doesNotThrow(() => scanGlobalInventory(home, [runtime]));
  assert.doesNotThrow(() => createBundle(home, 'tools', ['skill:example']));

  assert.doesNotThrow(() =>
    applyActivationPlan(home, planActivation(home, 'bundle:tools', ['shared'], 'off')));

  const parked = path.join(parkingRoot, 'example');
  assert.equal(fs.realpathSync(parked), fs.realpathSync(source));
});

test('activation targets the selected Runtime existing alias Slot', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-alias-slot-'));
  const sourceRoot = path.join(configDir, 'source', 'skills');
  const aliasRoot = path.join(configDir, 'alias', 'skills');
  const source = path.join(sourceRoot, 'canonical');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# canonical');
  fs.mkdirSync(aliasRoot, { recursive: true });
  fs.symlinkSync(source, path.join(aliasRoot, 'alias'), 'dir');
  const runtimes: Runtime[] = [
    {
      key: 'source', kind: 'shared', discoveryRoot: sourceRoot,
      parkingRoot: path.join(configDir, 'source', 'off'), projectPath: '.agents/source',
    },
    {
      key: 'alias', kind: 'shared', discoveryRoot: aliasRoot,
      parkingRoot: path.join(configDir, 'alias', 'off'), projectPath: '.agents/alias',
    },
  ];
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1, runtimes,
  }));
  const home = { configDir };
  assert.doesNotThrow(() => scanGlobalInventory(home, runtimes));
  assert.doesNotThrow(() => createBundle(home, 'tools', ['skill:canonical']));

  const plan = planActivation(home, 'bundle:tools', ['alias'], 'off');

  assert.deepEqual(plan.targets.map(({ slot }) => slot), ['alias']);
  assert.doesNotThrow(() => applyActivationPlan(home, plan));
  assert.ok(fs.existsSync(path.join(configDir, 'alias', 'off', 'alias')));
});

test('remaining drift rejects the wrong Variant in the requested Slot', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-drift-variant-'));
  const sourceRoot = path.join(configDir, 'source', 'skills');
  const targetRoot = path.join(configDir, 'target', 'skills');
  const desired = path.join(sourceRoot, 'example');
  fs.mkdirSync(desired, { recursive: true });
  fs.writeFileSync(path.join(desired, 'SKILL.md'), '# desired');
  const runtimes: Runtime[] = [
    {
      key: 'source', kind: 'shared', discoveryRoot: sourceRoot,
      parkingRoot: path.join(configDir, 'source', 'off'), projectPath: '.agents/source',
    },
    {
      key: 'target', kind: 'shared', discoveryRoot: targetRoot,
      parkingRoot: path.join(configDir, 'target', 'off'), projectPath: '.agents/target',
    },
  ];
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1, runtimes,
  }));
  const home = { configDir };
  assert.doesNotThrow(() => scanGlobalInventory(home, runtimes));
  assert.doesNotThrow(() => createBundle(home, 'tools', ['skill:example']));
  const plan = planActivation(home, 'bundle:tools', ['target'], 'on');
  fs.mkdirSync(path.join(targetRoot, 'example'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'example', 'SKILL.md'), '# wrong variant');
  const actual = scanGlobalInventory(home, runtimes, { persist: false });

  assert.deepEqual(remainingDrift(plan, actual), ['global:target/example']);
});
