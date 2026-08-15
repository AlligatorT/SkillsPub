import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyDoctorRepairs,
  doctorGlobalInventory,
  doctorProjectInventory,
  loadTargets,
  scanGlobalInventory,
  type SkillTarget,
} from '../src/inventory.ts';
import type { Home } from '../src/core.ts';

function setup(): { home: Home; runtime: SkillTarget } {
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

test('read-only Target loading does not create a registry', () => {
  const home = { configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-doctor-config-')) };

  assert.ok(loadTargets(home).length > 0);
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
    targetId: 'global:shared',
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

test('Doctor reads legacy runtime inventory metadata', () => {
  const { home, runtime } = setup();
  const slot = `global:${runtime.key}\0parked`;
  fs.writeFileSync(path.join(home.configDir, 'state.json'), JSON.stringify({
    baseIntent: { [slot]: 'off' },
    runtimeInventory: { slots: { [slot]: { resourceIds: ['/missing/parked'] } } },
  }));

  const report = doctorGlobalInventory(home, [runtime]);

  assert.equal(report.findings.some(({ code }) => code === 'parking-entry-missing'), true);
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

test('Doctor preflights write permissions before the first repair', () => {
  const { home, runtime } = setup();
  const first = path.join(runtime.discoveryRoot, 'a-first');
  const second = path.join(runtime.discoveryRoot, 'b-second');
  fs.symlinkSync('/missing/first', first);
  fs.symlinkSync('/missing/second', second);
  const repairs = doctorGlobalInventory(home, [runtime]).repairs;
  const access = fs.accessSync;
  let calls = 0;
  fs.accessSync = ((entry: fs.PathLike, mode?: number) => {
    calls += 1;
    if (calls === 2) throw new Error('simulated unwritable directory');
    return access(entry, mode);
  }) as typeof fs.accessSync;

  try {
    assert.throws(() => applyDoctorRepairs(repairs), /unwritable/);
  } finally {
    fs.accessSync = access;
  }
  assert.equal(fs.lstatSync(first).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(second).isSymbolicLink(), true);
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
  consumer.kind = 'harness';
  const source: SkillTarget = {
    key: 'source',
    kind: 'harness',
    discoveryRoot: path.join(home.configDir, 'source', 'skills'),
    parkingRoot: path.join(home.configDir, 'source', '.skillspub-off', 'skills'),
    projectPath: '.source/skills',
  };
  const oldTarget = path.join(source.discoveryRoot, 'shared');
  fs.mkdirSync(oldTarget, { recursive: true });
  fs.writeFileSync(path.join(oldTarget, 'SKILL.md'), '# shared');
  const link = path.join(consumer.discoveryRoot, 'shared');
  fs.symlinkSync(oldTarget, link);
  scanGlobalInventory(home, [consumer, source]);
  const parked = path.join(source.parkingRoot, 'shared');
  fs.mkdirSync(path.dirname(parked), { recursive: true });
  fs.renameSync(oldTarget, parked);

  const report = doctorGlobalInventory(home, [consumer, source]);

  const [repair] = report.repairs;
  assert.equal(repair.id, `retarget-link:${link}`);
  assert.equal(repair.kind, 'retarget-link');
  assert.equal(repair.from, oldTarget);
  assert.equal(repair.to, parked);
  assert.equal(repair.targetResourceId, fs.realpathSync(parked));
  assert.equal(typeof repair.targetHash, 'string');
  assert.deepEqual(applyDoctorRepairs(report.repairs).completed, report.repairs);
  assert.equal(fs.realpathSync(link), fs.realpathSync(parked));
});

test('Doctor rejects a managed Link repair when the target changes after preview', () => {
  const { home, runtime: consumer } = setup();
  consumer.key = 'consumer';
  const source: SkillTarget = {
    key: 'source',
    kind: 'harness',
    discoveryRoot: path.join(home.configDir, 'source', 'skills'),
    parkingRoot: path.join(home.configDir, 'source', '.skillspub-off', 'skills'),
    projectPath: '.source/skills',
  };
  const oldTarget = path.join(source.discoveryRoot, 'shared');
  fs.mkdirSync(oldTarget, { recursive: true });
  fs.writeFileSync(path.join(oldTarget, 'SKILL.md'), '# original');
  const link = path.join(consumer.discoveryRoot, 'shared');
  fs.symlinkSync(oldTarget, link);
  scanGlobalInventory(home, [consumer, source]);
  const parked = path.join(source.parkingRoot, 'shared');
  fs.mkdirSync(path.dirname(parked), { recursive: true });
  fs.renameSync(oldTarget, parked);
  const report = doctorGlobalInventory(home, [consumer, source]);
  fs.rmSync(parked, { recursive: true });
  fs.mkdirSync(parked);
  fs.writeFileSync(path.join(parked, 'SKILL.md'), '# substituted after preview');

  assert.throws(() => applyDoctorRepairs(report.repairs), /target .*changed/);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(parked, 'SKILL.md'), 'utf8'), '# substituted after preview');
});

test('Doctor does not retarget to a different resource placed in the matching parking Slot', () => {
  const { home, runtime: consumer } = setup();
  consumer.key = 'consumer';
  const source: SkillTarget = {
    key: 'source',
    kind: 'harness',
    discoveryRoot: path.join(home.configDir, 'source', 'skills'),
    parkingRoot: path.join(home.configDir, 'source', '.skillspub-off', 'skills'),
    projectPath: '.source/skills',
  };
  const oldTarget = path.join(source.discoveryRoot, 'shared');
  fs.mkdirSync(oldTarget, { recursive: true });
  fs.writeFileSync(path.join(oldTarget, 'SKILL.md'), '# original');
  const link = path.join(consumer.discoveryRoot, 'shared');
  fs.symlinkSync(oldTarget, link);
  scanGlobalInventory(home, [consumer, source]);
  fs.rmSync(oldTarget, { recursive: true });
  const replacement = path.join(source.parkingRoot, 'shared');
  fs.mkdirSync(replacement, { recursive: true });
  fs.writeFileSync(path.join(replacement, 'SKILL.md'), '# unrelated replacement');

  const [repair] = doctorGlobalInventory(home, [consumer, source]).repairs;

  assert.equal(repair.kind, 'remove-broken-link');
  assert.equal(repair.to, undefined);
});

test('Doctor does not retarget an untracked external Link', () => {
  const { home, runtime: consumer } = setup();
  consumer.key = 'consumer';
  const source: SkillTarget = {
    key: 'source',
    kind: 'harness',
    discoveryRoot: path.join(home.configDir, 'source', 'skills'),
    parkingRoot: path.join(home.configDir, 'source', '.skillspub-off', 'skills'),
    projectPath: '.source/skills',
  };
  const parked = path.join(source.parkingRoot, 'shared');
  fs.mkdirSync(parked, { recursive: true });
  fs.writeFileSync(path.join(parked, 'SKILL.md'), '# shared');
  const link = path.join(consumer.discoveryRoot, 'shared');
  fs.symlinkSync(path.join(source.discoveryRoot, 'shared'), link);

  const [repair] = doctorGlobalInventory(home, [consumer, source]).repairs;

  assert.equal(repair.kind, 'remove-broken-link');
  assert.equal(repair.to, undefined);
});

test('Doctor reports both sides of a known npx lock/file mismatch', () => {
  const { home, runtime } = setup();
  const managed = path.join(runtime.discoveryRoot, 'managed');
  fs.mkdirSync(managed);
  fs.writeFileSync(path.join(managed, 'SKILL.md'), '# managed');
  runtime.lockFile = path.join(home.configDir, '.skill-lock.json');
  fs.writeFileSync(runtime.lockFile, JSON.stringify({
    version: 3,
    skills: { ghost: { source: 'owner/repo' } },
  }));
  const slotId = 'global:shared\0managed';
  fs.writeFileSync(path.join(home.configDir, 'state.json'), JSON.stringify({
    targetInventory: {
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
  const unlinked = path.join(home.configDir, 'unlinked-resource');
  fs.mkdirSync(path.dirname(projectStateFile), { recursive: true });
  fs.mkdirSync(unlinked);
  fs.writeFileSync(path.join(unlinked, 'SKILL.md'), '# valid but unlinked');
  fs.writeFileSync(path.join(home.configDir, 'state.json'), JSON.stringify({
    bundles: { manual: ['/missing/bundle-resource', unlinked] },
    tags: { '/missing/tag-resource': ['stale'], [unlinked]: ['kept'] },
    presets: { kept: { selectors: ['skill:/missing/preset-resource', `skill:${unlinked}`] } },
  }));
  const targetId = `project:${fs.realpathSync(project)}:${runtime.key}`;
  const parkedId = `${targetId}\0parked`;
  const claimedId = `${targetId}\0claimed`;
  const projectState = JSON.stringify({
    baseIntent: { [parkedId]: 'off', [claimedId]: 'off' },
    presetActivations: ['deleted'],
    lastClaims: { deleted: [claimedId] },
    targetInventory: { slots: { [parkedId]: { resourceIds: ['/missing/parked'] } } },
  });
  fs.writeFileSync(projectStateFile, projectState);

  const report = doctorProjectInventory(home, project, [runtime]);

  assert.deepEqual(
    [...new Set(report.findings.map(({ code }) => code))].sort(),
    ['orphaned-preset-activation', 'parking-entry-missing', 'stale-reference'],
  );
  assert.deepEqual(
    report.findings.filter(({ code }) => code === 'parking-entry-missing').map(({ slot }) => slot),
    ['parked'],
  );
  assert.equal(
    report.findings.some(({ code, resourceId }) => code === 'stale-reference' && resourceId === unlinked),
    false,
  );
  assert.equal(fs.readFileSync(projectStateFile, 'utf8'), projectState);
});

test('doctor migrates legacy .off parking into the parking area', () => {
  const { home, runtime } = setup();
  const parked = path.join(runtime.discoveryRoot, '.off', 'parked');
  fs.mkdirSync(parked, { recursive: true });
  fs.writeFileSync(path.join(parked, 'SKILL.md'), '# parked');

  const report = doctorGlobalInventory(home, [runtime]);

  const legacyOffPath = path.join(runtime.discoveryRoot, '.off', 'parked');
  assert.equal(report.findings.some(({ code }) => code === 'legacy-off'), true);
  const repair = report.repairs.find(({ kind }) => kind === 'migrate-legacy-off');
  assert.ok(repair, 'expected a migrate-legacy-off repair');
  assert.equal(repair.path, legacyOffPath);
  assert.equal(repair.to, path.join(runtime.parkingRoot, 'parked'));

  const result = applyDoctorRepairs(report.repairs);
  assert.deepEqual(result.completed, report.repairs);
  assert.equal(result.failed, undefined);
  assert.equal(fs.existsSync(path.join(runtime.parkingRoot, 'parked', 'SKILL.md')), true);
  assert.equal(fs.existsSync(legacyOffPath), false);
});

test('doctor reports legacy .off but skips repair when parking destination already exists', () => {
  const { home, runtime } = setup();
  const legacy = path.join(runtime.discoveryRoot, '.off', 'parked');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'SKILL.md'), '# legacy');
  const conflicting = path.join(runtime.parkingRoot, 'parked');
  fs.mkdirSync(conflicting, { recursive: true });
  fs.writeFileSync(path.join(conflicting, 'SKILL.md'), '# conflicting');

  const report = doctorGlobalInventory(home, [runtime]);

  assert.equal(report.findings.some(({ code }) => code === 'legacy-off'), true);
  assert.equal(report.repairs.some(({ kind }) => kind === 'migrate-legacy-off'), false);
  // conflicting content untouched
  assert.equal(fs.readFileSync(path.join(conflicting, 'SKILL.md'), 'utf8'), '# conflicting');
  assert.equal(fs.existsSync(path.join(legacy, 'SKILL.md')), true);
});
