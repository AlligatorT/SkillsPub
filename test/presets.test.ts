import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addPresetSelectors,
  createPreset,
  listPresets,
  removePresetSelectors,
  showPreset,
} from '../src/catalog.ts';
import {
  applyPresetReconcile,
  deactivatePreset,
  deletePreset,
  planPresetReconcile,
  activatePreset,
} from '../src/reconcile.ts';
import { scanGlobalInventory, scanProjectInventory, type Runtime } from '../src/inventory.ts';

function setup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-presets-'));
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
  const home = { configDir };
  scanGlobalInventory(home, [runtime]);
  return { home, runtime, discoveryRoot, parkingRoot, configDir };
}

test('preset create/add/rm/ls/show keep dynamic selectors', () => {
  const { home } = setup();
  assert.equal(createPreset(home, 'tools', ['skill:one', 'tag:backend']), 2);
  assert.deepEqual(listPresets(home), [{ name: 'tools', selectors: 2 }]);
  const shown = showPreset(home, 'tools').map((s) => s.selector);
  assert.ok(shown.some((s) => s === 'tag:backend'));
  assert.ok(shown.some((s) => s.startsWith('skill:')));

  assert.equal(addPresetSelectors(home, 'tools', ['bundle:dev']), 1);
  assert.equal(showPreset(home, 'tools').length, 3);
  assert.equal(removePresetSelectors(home, 'tools', ['tag:backend']), 1);
  assert.equal(showPreset(home, 'tools').length, 2);
  assert.throws(() => removePresetSelectors(home, 'tools'), /preset delete/);
  deletePreset(home, 'tools', { yes: true });
  assert.deepEqual(listPresets(home), []);
});

test('activate expands selectors, writes claims, and turns Slots ON', () => {
  const { home, runtime, discoveryRoot, parkingRoot, configDir } = setup();
  fs.mkdirSync(parkingRoot, { recursive: true });
  fs.renameSync(path.join(discoveryRoot, 'one'), path.join(parkingRoot, 'one'));
  scanGlobalInventory(home, [runtime]);
  createPreset(home, 'tools', ['skill:one']);

  const plan = activatePreset(home, 'tools', ['shared']);
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].to, 'on');
  assert.doesNotThrow(() => applyPresetReconcile(home, plan));

  assert.ok(fs.existsSync(path.join(discoveryRoot, 'one', 'SKILL.md')));
  const state = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.ok(state.presetActivations.tools.includes('shared'));
  assert.deepEqual(state.claims['global:shared\0one'], ['preset:tools']);
  assert.deepEqual(state.lastClaims.tools, ['global:shared\0one']);
});

test('duplicate selector paths claim a Slot once', () => {
  const { home, configDir } = setup();
  createPreset(home, 'tools', ['skill:one', 'skill:one']);
  const plan = activatePreset(home, 'tools', ['shared']);
  applyPresetReconcile(home, plan);
  const state = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.claims['global:shared\0one'], ['preset:tools']);
});

test('deactivate drops claims and applies latent Base intent OFF', () => {
  const { home, runtime, discoveryRoot, parkingRoot, configDir } = setup();
  fs.mkdirSync(parkingRoot, { recursive: true });
  fs.renameSync(path.join(discoveryRoot, 'one'), path.join(parkingRoot, 'one'));
  scanGlobalInventory(home, [runtime]);
  createPreset(home, 'tools', ['skill:one']);
  applyPresetReconcile(home, activatePreset(home, 'tools', ['shared']));
  assert.ok(fs.existsSync(path.join(discoveryRoot, 'one', 'SKILL.md')));

  const plan = deactivatePreset(home, 'tools', ['shared']);
  applyPresetReconcile(home, plan);

  assert.ok(fs.existsSync(path.join(parkingRoot, 'one', 'SKILL.md')));
  const updated = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.equal(updated.baseIntent['global:shared\0one'], 'off');
  assert.equal(updated.presetActivations.tools, undefined);
  assert.equal(updated.claims['global:shared\0one'], undefined);
  assert.equal(updated.lastClaims.tools, undefined);
});

test('membership change is only applied by explicit reconcile', () => {
  const { home, runtime, discoveryRoot, parkingRoot, configDir } = setup();
  createPreset(home, 'tools', ['skill:one']);
  applyPresetReconcile(home, activatePreset(home, 'tools', ['shared']));
  fs.mkdirSync(parkingRoot, { recursive: true });
  fs.renameSync(path.join(discoveryRoot, 'two'), path.join(parkingRoot, 'two'));
  scanGlobalInventory(home, [runtime]);
  addPresetSelectors(home, 'tools', ['skill:two']);

  assert.ok(fs.existsSync(path.join(parkingRoot, 'two', 'SKILL.md')));
  const before = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.equal(before.claims['global:shared\0two'], undefined);

  const plan = planPresetReconcile(home, 'tools', ['shared']);
  applyPresetReconcile(home, plan);
  assert.ok(fs.existsSync(path.join(discoveryRoot, 'two', 'SKILL.md')));
  const after = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.deepEqual(after.claims['global:shared\0two'], ['preset:tools']);
});

test('delete active Preset deactivates, reconciles, then removes definition', () => {
  const { home, parkingRoot, configDir } = setup();
  createPreset(home, 'tools', ['skill:one']);
  applyPresetReconcile(home, activatePreset(home, 'tools', ['shared']));
  const stateFile = path.join(configDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.baseIntent = { 'global:shared\0one': 'off' };
  fs.writeFileSync(stateFile, JSON.stringify(state));

  deletePreset(home, 'tools', { yes: true });
  assert.equal(listPresets(home).length, 0);
  assert.ok(fs.existsSync(path.join(parkingRoot, 'one', 'SKILL.md')));
  const updated = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(updated.presets?.tools, undefined);
  assert.equal(updated.presetActivations?.tools, undefined);
});

test('project delete removes Project claims even with a Global activation', () => {
  const { home, configDir } = setup();
  const project = path.join(configDir, 'proj');
  fs.mkdirSync(path.join(project, '.agents', 'skills'), { recursive: true });
  createPreset(home, 'tools', ['skill:one']);
  applyPresetReconcile(home, activatePreset(home, 'tools', ['shared']));
  applyPresetReconcile(home, activatePreset(home, 'tools', ['shared'], { projectPath: project }), {
    projectPath: project,
  });

  deletePreset(home, 'tools', { yes: true, projectPath: project });

  const projectState = JSON.parse(
    fs.readFileSync(path.join(project, '.skillspub', 'state.json'), 'utf8'),
  );
  assert.equal(listPresets(home).length, 0);
  assert.equal(projectState.presetActivations?.tools, undefined);
  assert.equal(projectState.claims?.[`project:${fs.realpathSync(project)}:shared\0one`], undefined);
});

test('project activate stores claims in project state only', () => {
  const { home, runtime, configDir, discoveryRoot } = setup();
  const project = path.join(configDir, 'proj');
  fs.mkdirSync(path.join(project, '.agents', 'skills'), { recursive: true });
  createPreset(home, 'tools', ['skill:one']);

  const plan = activatePreset(home, 'tools', ['shared'], { projectPath: project });
  applyPresetReconcile(home, plan, { projectPath: project });

  const projectState = JSON.parse(
    fs.readFileSync(path.join(project, '.skillspub', 'state.json'), 'utf8'),
  );
  const globalState = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  const runtimeId = `project:${fs.realpathSync(project)}:shared`;
  assert.ok(projectState.presetActivations.tools.includes('shared'));
  assert.deepEqual(projectState.claims[`${runtimeId}\0one`], ['preset:tools']);
  assert.equal(globalState.claims?.[`${runtimeId}\0one`], undefined);
  assert.equal(globalState.presetActivations?.tools, undefined);
  assert.equal(
    fs.realpathSync(path.join(project, '.agents', 'skills', 'one')),
    fs.realpathSync(path.join(discoveryRoot, 'one')),
  );
  scanProjectInventory(home, project, [runtime]);
});

test('preflight failure leaves Desired state and disk untouched', () => {
  const { home, discoveryRoot, configDir } = setup();
  createPreset(home, 'tools', ['skill:one', 'skill:two']);
  const blocked = path.join(configDir, 'shared', '.skillspub-off', 'skills', 'one');
  fs.mkdirSync(blocked, { recursive: true });
  fs.writeFileSync(path.join(blocked, 'occupied'), 'x');

  // Force OFF desired for both while one destination is blocked — plan/apply off path
  const stateFile = path.join(configDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.baseIntent = {
    'global:shared\0one': 'off',
    'global:shared\0two': 'off',
  };
  state.presetActivations = { tools: ['shared'] };
  state.claims = {
    'global:shared\0one': ['preset:tools'],
    'global:shared\0two': ['preset:tools'],
  };
  fs.writeFileSync(stateFile, JSON.stringify(state));

  assert.throws(() => {
    const plan = deactivatePreset(home, 'tools', ['shared']);
    // preflight should fail before apply when destination exists
    applyPresetReconcile(home, plan);
  });
  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  // activation removal is part of Desired; if preflight fails at plan time, activations stay
  assert.ok(fs.existsSync(path.join(discoveryRoot, 'one', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(discoveryRoot, 'two', 'SKILL.md')));
  assert.ok(after.presetActivations?.tools || after.claims?.['global:shared\0one']);
});
