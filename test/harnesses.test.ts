import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectHarnesses } from '../src/harnesses/registry.ts';
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
  assert.equal(report.setup[0]?.support, 'discoverable');
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
    path.join(project, '.pi', 'settings.json'),
    JSON.stringify({ skills: ['!../../a?ents/skills', '!../.[a]gents/skills'] }),
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
