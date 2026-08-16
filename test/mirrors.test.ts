import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanGlobalInventory,
  type SkillTarget,
} from '../src/inventory.ts';
import {
  activatePreset,
  applyActivationPlan,
  applyPresetReconcile,
  planActivation,
  planMirrorAction,
  planPresetReconcile,
} from '../src/reconcile.ts';

function setup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-mirror-'));
  const sourceRoot = path.join(configDir, 'source', 'skills');
  const targetRoot = path.join(configDir, 'copy-only', 'skills');
  const source = path.join(sourceRoot, 'example');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# example\n');
  const targets: SkillTarget[] = [
    {
      key: 'source',
      kind: 'shared',
      discoveryRoot: sourceRoot,
      parkingRoot: path.join(configDir, 'source', 'off'),
      projectPath: '.agents/source/skills',
    },
    {
      key: 'copy-only',
      kind: 'harness',
      discoveryRoot: targetRoot,
      parkingRoot: path.join(configDir, 'copy-only', 'off'),
      projectPath: '.copy-only/skills',
      relationship: { support: 'managed', link: 'unsupported' },
    },
  ];
  return { home: { configDir }, source, targetRoot, targets };
}

test('managed copy-only Targets create, scan, reconcile, park, and restore Mirrors', () => {
  const { home, source, targetRoot, targets } = setup();
  const sourceId = fs.realpathSync(source);

  const scope = { targets };
  const create = planActivation(home, `skill:${sourceId}`, ['copy-only'], 'on', scope);
  assert.equal(create.targets[0]?.createForm, 'mirror');
  applyActivationPlan(home, create);

  const mirror = path.join(targetRoot, 'example');
  let report = scanGlobalInventory(home, targets, { persist: false });
  const relationship = report.relationships.find(({ path: entry }) => entry === mirror);
  assert.equal(relationship?.form, 'mirror');
  assert.equal(relationship?.resourceId, sourceId);
  assert.equal(fs.lstatSync(mirror).isSymbolicLink(), false);
  const state = JSON.parse(fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8'));
  assert.equal(state.mirrors['global:copy-only\0example'].sourceId, sourceId);
  assert.equal(state.mirrors['global:copy-only\0example'].hash, report.resources.find(({ id }) => id === sourceId)?.hash);

  fs.appendFileSync(path.join(source, 'SKILL.md'), 'changed\n');
  report = scanGlobalInventory(home, targets, { persist: false });
  assert.equal(report.findings.some(({ code }) => code === 'mirror-drift'), true);
  assert.equal(fs.readFileSync(path.join(mirror, 'SKILL.md'), 'utf8'), '# example\n');

  assert.doesNotThrow(() => applyActivationPlan(
    home,
    planMirrorAction(home, 'global:copy-only', 'example', 'sync', scope),
  ));
  assert.equal(fs.readFileSync(path.join(mirror, 'SKILL.md'), 'utf8'), '# example\nchanged\n');

  applyActivationPlan(home, planActivation(home, `skill:${sourceId}`, ['copy-only'], 'off', scope));
  const parked = path.join(home.configDir, 'copy-only', 'off', 'example');
  assert.ok(fs.existsSync(path.join(parked, 'SKILL.md')));
  applyActivationPlan(home, planActivation(home, `skill:${sourceId}`, ['copy-only'], 'on', scope));
  assert.ok(fs.existsSync(path.join(mirror, 'SKILL.md')));
});

test('Preset reconciliation creates and synchronizes managed Mirrors', () => {
  const { home, source, targetRoot, targets } = setup();
  const sourceId = fs.realpathSync(source);
  const scope = { targets };
  scanGlobalInventory(home, targets);
  const state = JSON.parse(fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8'));
  state.presets = { managed: { selectors: [`skill:${sourceId}`] } };
  fs.writeFileSync(path.join(home.configDir, 'state.json'), JSON.stringify(state));

  const activate = activatePreset(home, 'managed', ['copy-only'], scope);
  assert.equal(activate.targets[0]?.createForm, 'mirror');
  applyPresetReconcile(home, activate, scope);

  fs.appendFileSync(path.join(source, 'SKILL.md'), 'changed\n');
  const reconcile = planPresetReconcile(home, 'managed', ['copy-only'], scope);
  assert.equal(reconcile.targets[0]?.mirrorAction, 'sync');
  applyPresetReconcile(home, reconcile, scope);
  assert.equal(fs.readFileSync(path.join(targetRoot, 'example', 'SKILL.md'), 'utf8'), '# example\nchanged\n');
});

test('diverged Mirrors require overwrite or conversion before replacement', () => {
  const { home, source, targetRoot, targets } = setup();
  const sourceId = fs.realpathSync(source);
  const scope = { targets };
  applyActivationPlan(home, planActivation(home, `skill:${sourceId}`, ['copy-only'], 'on', scope));
  const mirror = path.join(targetRoot, 'example');

  fs.appendFileSync(path.join(mirror, 'SKILL.md'), 'local edit\n');
  let report = scanGlobalInventory(home, targets, { persist: false });
  assert.equal(report.findings.some(({ code }) => code === 'mirror-diverged'), true);
  assert.throws(
    () => planMirrorAction(home, 'global:copy-only', 'example', 'sync', scope),
    /diverged/i,
  );

  applyActivationPlan(home, planMirrorAction(home, 'global:copy-only', 'example', 'overwrite', scope));
  assert.equal(fs.readFileSync(path.join(mirror, 'SKILL.md'), 'utf8'), '# example\n');

  fs.appendFileSync(path.join(mirror, 'SKILL.md'), 'local edit\n');
  applyActivationPlan(home, planMirrorAction(home, 'global:copy-only', 'example', 'convert', scope));
  report = scanGlobalInventory(home, targets, { persist: false });
  const converted = report.relationships.find(({ path: entry }) => entry === mirror);
  assert.equal(converted?.form, 'local');
  assert.equal(converted?.resourceId, fs.realpathSync(mirror));
});
