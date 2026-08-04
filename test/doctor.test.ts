import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyDoctorRepairs,
  doctorGlobalInventory,
  doctorProjectInventory,
  loadRuntimes,
  type Home,
  type Runtime,
} from '../src/core.ts';

function setup(): { home: Home; runtime: Runtime } {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-doctor-'));
  const discoveryRoot = path.join(configDir, 'runtime', 'skills');
  const parkingRoot = path.join(configDir, 'runtime', '.skillspub-off', 'skills');
  fs.mkdirSync(discoveryRoot, { recursive: true });
  return {
    home: { configDir },
    runtime: {
      key: 'shared',
      kind: 'shared',
      discoveryRoot,
      parkingRoot,
      projectPath: '.agents/skills',
    },
  };
}

test('read-only Runtime loading does not create a registry', () => {
  const home = { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-doctor-config-')) };

  assert.ok(loadRuntimes(home, { persist: false }).length > 0);
  assert.equal(fs.existsSync(path.join(home.configDir, 'runtimes.json')), false);
});

test('Doctor diagnoses a broken link and plans removal without changing disk or state', () => {
  const { home, runtime } = setup();
  const link = path.join(runtime.discoveryRoot, 'broken');
  const stateFile = path.join(home.configDir, 'state.json');
  fs.symlinkSync('/missing/skill', link);
  fs.writeFileSync(stateFile, '{"bundles":{"manual":["missing-resource"]}}\n');
  const before = fs.readFileSync(stateFile, 'utf8');

  const report = doctorGlobalInventory(home, [runtime]);

  assert.equal(report.findings.some(({ code }) => code === 'broken-link'), true);
  assert.deepEqual(report.repairs, [{
    id: `remove-broken-link:${link}`,
    kind: 'remove-broken-link',
    path: link,
    from: '/missing/skill',
    runtimeId: 'global:shared',
    slot: 'broken',
  }]);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
});

test('Project Doctor does not create Project state or parking directories', () => {
  const { home, runtime } = setup();
  const project = path.join(home.configDir, 'project');
  fs.mkdirSync(project);

  const report = doctorProjectInventory(home, project, [runtime]);

  assert.equal(report.projectPath, fs.realpathSync(project));
  assert.equal(fs.existsSync(path.join(project, '.skillspub')), false);
});

test('Doctor removes only explicitly applied broken symlink repairs', () => {
  const { home, runtime } = setup();
  const broken = path.join(runtime.discoveryRoot, 'broken');
  const local = path.join(runtime.discoveryRoot, 'local');
  fs.symlinkSync('/missing/skill', broken);
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'SKILL.md'), '# local');
  const report = doctorGlobalInventory(home, [runtime]);

  const result = applyDoctorRepairs(report.repairs);

  assert.deepEqual(result.completed, report.repairs);
  assert.equal(result.failed, undefined);
  assert.equal(fs.existsSync(broken), false);
  assert.equal(fs.existsSync(path.join(local, 'SKILL.md')), true);
  assert.equal(doctorGlobalInventory(home, [runtime]).repairs.length, 0);
});

test('Doctor preflights every repair before changing any path', () => {
  const { home, runtime } = setup();
  const first = path.join(runtime.discoveryRoot, 'first');
  const stale = path.join(runtime.discoveryRoot, 'stale');
  fs.symlinkSync('/missing/first', first);
  fs.symlinkSync('/missing/stale', stale);
  const report = doctorGlobalInventory(home, [runtime]);
  fs.unlinkSync(stale);
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'SKILL.md'), '# valuable local resource');

  assert.throws(
    () => applyDoctorRepairs(report.repairs),
    /no longer a symlink/,
  );
  assert.equal(fs.lstatSync(first).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(stale, 'SKILL.md'), 'utf8'), '# valuable local resource');
});

test('Doctor preserves completed work and reports the remaining repair after unexpected I/O failure', () => {
  const { home, runtime } = setup();
  const first = path.join(runtime.discoveryRoot, 'a-first');
  const second = path.join(runtime.discoveryRoot, 'b-second');
  fs.symlinkSync('/missing/first', first);
  fs.symlinkSync('/missing/second', second);
  const repairs = doctorGlobalInventory(home, [runtime]).repairs;
  const unlink = fs.unlinkSync;
  let calls = 0;
  fs.unlinkSync = ((entry: fs.PathLike) => {
    calls += 1;
    if (calls === 2) throw new Error('simulated I/O failure');
    return unlink(entry);
  }) as typeof fs.unlinkSync;

  let result;
  try {
    result = applyDoctorRepairs(repairs);
  } finally {
    fs.unlinkSync = unlink;
  }

  assert.deepEqual(result.completed, [repairs[0]]);
  assert.equal(result.failed?.repair.path, second);
  assert.throws(() => fs.lstatSync(first), /ENOENT/);
  assert.equal(fs.lstatSync(second).isSymbolicLink(), true);
  assert.deepEqual(doctorGlobalInventory(home, [runtime]).repairs.map(({ path }) => path), [second]);
});

test('Doctor diagnoses Slot conflicts without selecting a repair winner', () => {
  const { home, runtime } = setup();
  const local = path.join(runtime.discoveryRoot, 'Conflict');
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'SKILL.md'), '# keep');
  fs.mkdirSync(runtime.parkingRoot, { recursive: true });
  fs.symlinkSync('/missing/conflict', path.join(runtime.parkingRoot, 'conflict'));

  const report = doctorGlobalInventory(home, [runtime]);

  assert.equal(report.findings.some(({ code }) => code === 'on-off-conflict'), true);
  assert.equal(report.findings.some(({ code }) => code === 'slot-conflict'), true);
  assert.equal(report.repairs.length, 0);
});

test('Doctor never offers destructive repair for an unreadable symlink target', () => {
  const { home, runtime } = setup();
  const loop = path.join(runtime.discoveryRoot, 'loop');
  fs.symlinkSync('loop', loop);

  const report = doctorGlobalInventory(home, [runtime]);

  assert.equal(report.findings.some(({ code }) => code === 'unreadable-link'), true);
  assert.equal(report.findings.some(({ code }) => code === 'broken-link'), false);
  assert.equal(report.repairs.length, 0);
});

test('Doctor previews and repairs a managed Link whose local source moved to parking', () => {
  const { home, runtime: consumer } = setup();
  consumer.key = 'consumer';
  consumer.kind = 'agent';
  const source: Runtime = {
    key: 'source',
    kind: 'agent',
    discoveryRoot: path.join(home.configDir, 'source', 'skills'),
    parkingRoot: path.join(home.configDir, 'source', '.skillspub-off', 'skills'),
    projectPath: '.source/skills',
  };
  const parked = path.join(source.parkingRoot, 'shared');
  fs.mkdirSync(parked, { recursive: true });
  fs.writeFileSync(path.join(parked, 'SKILL.md'), '# shared');
  const oldTarget = path.join(source.discoveryRoot, 'shared');
  const link = path.join(consumer.discoveryRoot, 'shared');
  fs.symlinkSync(oldTarget, link);

  const report = doctorGlobalInventory(home, [consumer, source]);

  assert.deepEqual(report.repairs, [{
    id: `retarget-link:${link}`,
    kind: 'retarget-link',
    path: link,
    from: oldTarget,
    to: parked,
    runtimeId: 'global:consumer',
    slot: 'shared',
  }]);
  assert.deepEqual(applyDoctorRepairs(report.repairs).completed, report.repairs);
  assert.equal(fs.realpathSync(link), fs.realpathSync(parked));
});

test('Doctor reports both sides of a known npx lock/file mismatch', () => {
  const { home, runtime } = setup();
  const managed = path.join(runtime.discoveryRoot, 'managed');
  fs.mkdirSync(managed);
  fs.writeFileSync(path.join(managed, 'SKILL.md'), '# managed');
  runtime.lockFile = path.join(home.configDir, '.skill-lock.json');
  fs.writeFileSync(runtime.lockFile, JSON.stringify({
    skills: { ghost: { source: 'owner/repo' } },
  }));
  const slotId = 'global:shared\0managed';
  fs.writeFileSync(path.join(home.configDir, 'state.json'), JSON.stringify({
    runtimeInventory: {
      slots: { [slotId]: { provenance: { source: 'owner/repo' } } },
    },
  }));

  const report = doctorGlobalInventory(home, [runtime]);

  assert.equal(report.findings.some(({ code }) => code === 'lock-file-missing'), true);
  assert.equal(report.findings.some(({ code }) => code === 'lock-file-mismatch'), true);
});

test('Project Doctor reports stale references, missing parking, and Orphaned Preset Activation without cleanup', () => {
  const { home, runtime } = setup();
  const project = path.join(home.configDir, 'project');
  const projectStateFile = path.join(project, '.skillspub', 'state.json');
  fs.mkdirSync(path.dirname(projectStateFile), { recursive: true });
  fs.writeFileSync(path.join(home.configDir, 'state.json'), JSON.stringify({
    bundles: { manual: ['/missing/bundle-resource'] },
    tags: { '/missing/tag-resource': ['stale'] },
    presets: { kept: { selectors: ['skill:/missing/preset-resource'] } },
  }));
  const runtimeId = `project:${fs.realpathSync(project)}:${runtime.key}`;
  const projectState = JSON.stringify({
    baseIntent: { [`${runtimeId}\0parked`]: 'off' },
    presetActivations: ['deleted'],
    lastClaims: { deleted: [`${runtimeId}\0parked`] },
  });
  fs.writeFileSync(projectStateFile, projectState);

  const report = doctorProjectInventory(home, project, [runtime]);

  assert.deepEqual(
    [...new Set(report.findings.map(({ code }) => code))].sort(),
    ['orphaned-preset-activation', 'parking-entry-missing', 'stale-reference'],
  );
  assert.equal(fs.readFileSync(projectStateFile, 'utf8'), projectState);
});
