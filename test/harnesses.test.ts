import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectHarnesses } from '../src/harnesses/registry.ts';
import { piAdapter } from '../src/harnesses/pi.ts';
import type { Home } from '../src/core.ts';
import type { SkillTarget } from '../src/inventory.ts';

function setup(): { home: Home; targets: SkillTarget[]; piHome: string; shared: string } {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-harnesses-'));
  const piHome = path.join(configDir, 'pi');
  const shared = path.join(configDir, 'agents', 'skills');
  return {
    home: { configDir },
    piHome,
    shared,
    targets: [
      {
        key: 'shared',
        kind: 'shared',
        discoveryRoot: shared,
        parkingRoot: path.join(configDir, 'agents', '.skillspub-off', 'skills'),
        projectPath: '.agents/skills',
      },
      {
        key: 'pi',
        kind: 'harness',
        discoveryRoot: path.join(piHome, 'agent', 'skills'),
        parkingRoot: path.join(piHome, 'agent', '.skillspub-off', 'skills'),
        projectPath: '.pi/skills',
      },
    ],
  };
}

test('Harness registry keeps an undetected Pi in setup and does not write state', () => {
  const { home, targets, piHome, shared } = setup();
  const before = fs.readdirSync(home.configDir).sort();

  const report = inspectHarnesses(home, targets);

  assert.deepEqual(report.detected, []);
  assert.equal(report.setup[0]?.key, 'pi');
  assert.equal(report.setup[0]?.support, 'managed');
  assert.equal(report.setup[0]?.sharedConsumption.status, 'enabled');
  assert.equal(report.setup[0]?.link.supported, true);
  assert.equal(report.setup[0]?.targets[0]?.discoveryRoot, path.join(piHome, 'agent', 'skills'));
  assert.equal(report.setup[0]?.targets.some(({ discoveryRoot }) => discoveryRoot === shared), false);
  assert.deepEqual(fs.readdirSync(home.configDir).sort(), before);
});

test('Pi inspection resolves Global and Project Pi Targets and observes Shared exclusion', () => {
  const { home, targets, piHome } = setup();
  const project = path.join(home.configDir, 'project');
  fs.mkdirSync(path.join(piHome, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
  fs.writeFileSync(
    path.join(piHome, 'agent', 'settings.json'),
    JSON.stringify({ skills: ['!skills/**'] }),
  );
  fs.writeFileSync(
    path.join(project, '.pi', 'settings.json'),
    JSON.stringify({ skills: ['!skills/**'] }),
  );

  const report = inspectHarnesses(home, targets, project);
  const pi = report.detected[0];

  assert.equal(pi?.key, 'pi');
  assert.equal(pi?.sharedConsumption.status, 'excluded');
  assert.match(pi?.sharedConsumption.detail ?? '', /excluded/i);
  assert.deepEqual(
    pi?.targets.map(({ scope, discoveryRoot }) => ({ scope, discoveryRoot })),
    [
      { scope: 'global', discoveryRoot: path.join(piHome, 'agent', 'skills') },
      { scope: 'project', discoveryRoot: path.join(project, '.pi', 'skills') },
    ],
  );
  assert.equal(pi?.evidence.length, 3);
});

test('Pi reports an unknown Shared relationship for unrecognised settings', () => {
  const { home, targets, piHome } = setup();
  fs.mkdirSync(path.join(piHome, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(piHome, 'agent', 'settings.json'), '{"skills":{}}');

  const pi = inspectHarnesses(home, targets).detected[0];

  assert.equal(pi?.sharedConsumption.status, 'unknown');
  assert.match(pi?.sharedConsumption.detail ?? '', /unsupported skills configuration/i);
});

test('Pi isolation plans, applies, verifies, and reconciles only its own Shared exclusion', () => {
  const { home, targets, piHome } = setup();
  const settings = path.join(piHome, 'agent', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', skills: ['+local'] }, null, 2));

  const plan = piAdapter.planSharedIsolation(home, targets);
  assert.match(plan.summary, /stop consuming Shared/i);
  assert.equal(plan.file, settings);
  assert.equal(fs.existsSync(path.join(home.configDir, 'state.json')), false);

  piAdapter.applySharedIsolation(home, plan);
  const applied = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(applied, { theme: 'dark', skills: ['+local', '!skills/**'] });
  assert.equal(inspectHarnesses(home, targets).detected[0]?.sharedConsumption.status, 'excluded');
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'managed');

  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', skills: ['!**'] }));
  assert.equal(inspectHarnesses(home, targets).detected[0]?.sharedConsumption.status, 'excluded');
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'drift');
  const reconcile = piAdapter.planSharedIsolation(home, targets);
  assert.equal(reconcile.change, true);
  piAdapter.applySharedIsolation(home, reconcile);
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'managed');
});

test('Pi isolation preserves an unowned equivalent exclusion and rejects unsafe writes', () => {
  const { home, targets, piHome } = setup();
  const settings = path.join(piHome, 'agent', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', skills: ['!skills/**'] }));

  const satisfied = piAdapter.planSharedIsolation(home, targets);
  assert.equal(satisfied.change, false);
  piAdapter.applySharedIsolation(home, satisfied);
  assert.equal(fs.existsSync(path.join(home.configDir, 'state.json')), false);

  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', skills: [] }));
  const plan = piAdapter.planSharedIsolation(home, targets);
  fs.writeFileSync(settings, JSON.stringify({ theme: 'light', skills: [] }));
  assert.throws(() => piAdapter.applySharedIsolation(home, plan), /changed after preview/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { theme: 'light', skills: [] });

  fs.writeFileSync(settings, JSON.stringify({ skills: {} }));
  assert.throws(() => piAdapter.planSharedIsolation(home, targets), /unsupported skills configuration/);
  assert.equal(fs.readFileSync(settings, 'utf8'), JSON.stringify({ skills: {} }));

  fs.writeFileSync(settings, JSON.stringify({ skills: ['!skills/skillspub-probe/**'] }));
  assert.equal(inspectHarnesses(home, targets).detected[0]?.sharedConsumption.status, 'enabled');
  assert.equal(piAdapter.planSharedIsolation(home, targets).change, true);
});
