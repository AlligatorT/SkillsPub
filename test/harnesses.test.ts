import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectHarnesses, planHarnessOperation } from '../src/harnesses/registry.ts';
import type { Home } from '../src/core.ts';
import type { SkillTarget } from '../src/inventory.ts';

function setup(): { home: Home; targets: SkillTarget[]; piHome: string; claudeHome: string; shared: string } {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-harnesses-'));
  const piHome = path.join(configDir, 'pi');
  const claudeHome = path.join(configDir, 'claude');
  const shared = path.join(configDir, 'agents', 'skills');
  return {
    home: { configDir },
    piHome,
    claudeHome,
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
      {
        key: 'claude',
        kind: 'harness',
        discoveryRoot: path.join(claudeHome, 'skills'),
        parkingRoot: path.join(claudeHome, '.skillspub-off', 'skills'),
        projectPath: '.claude/skills',
      },
    ],
  };
}

test('Harness registry keeps an undetected Pi in setup and does not write state', () => {
  const { home, targets, piHome, shared } = setup();
  const before = fs.readdirSync(home.configDir).sort();

  const report = inspectHarnesses(home, targets);

  assert.deepEqual(report.detected, []);
  const pi = report.available.find(({ key }) => key === 'pi');
  assert.equal(pi?.support, 'managed');
  assert.equal(pi?.sharedConsumption.status, 'enabled');
  assert.equal(pi?.link.supported, true);
  assert.equal(pi?.targets[0]?.discoveryRoot, path.join(piHome, 'agent', 'skills'));
  assert.equal(pi?.targets.some(({ discoveryRoot }) => discoveryRoot === shared), false);
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

test('Claude Code inspection resolves official Targets without configuration writes', () => {
  const { home, targets, claudeHome } = setup();
  const project = path.join(home.configDir, 'project');
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const before = fs.readdirSync(home.configDir, { recursive: true }).sort();

  const claude = inspectHarnesses(home, targets, project).detected
    .find(({ key }) => key === 'claude');

  assert.equal(claude?.name, 'Claude Code');
  assert.equal(claude?.support, 'managed');
  assert.equal(claude?.sharedConsumption.status, 'not-consumed');
  assert.equal(claude?.isolation.status, 'not-required');
  assert.equal(claude?.link.supported, true);
  assert.deepEqual(claude?.targets, [
    { scope: 'global', discoveryRoot: path.join(claudeHome, 'skills') },
    { scope: 'project', discoveryRoot: path.join(project, '.claude', 'skills') },
  ]);
  assert.ok(claude?.evidence.every(({ url }) => url.startsWith('https://docs.anthropic.com/')));
  assert.deepEqual(fs.readdirSync(home.configDir, { recursive: true }).sort(), before);
});

test('Harness inspection resolves Global Targets from a multi-scope project inventory', () => {
  const { home, targets, piHome, claudeHome } = setup();
  const project = path.join(home.configDir, 'project');
  fs.mkdirSync(path.join(piHome, 'agent'), { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  const scopedTargets = targets.flatMap((target) => [
    {
      ...target,
      id: `project:${target.key}`,
      scope: 'project' as const,
      discoveryRoot: path.join(project, target.projectPath),
    },
    { ...target, id: `global:${target.key}`, scope: 'global' as const },
  ]);

  const report = inspectHarnesses(home, scopedTargets, project);
  const claude = report.detected.find(({ key }) => key === 'claude');
  const pi = report.detected.find(({ key }) => key === 'pi');

  assert.equal(claude?.targets[0]?.discoveryRoot, path.join(claudeHome, 'skills'));
  assert.equal(pi?.targets[0]?.discoveryRoot, path.join(piHome, 'agent', 'skills'));
});

test('Harness operation dispatch reports unsupported optional capabilities', () => {
  const { home, targets } = setup();

  assert.throws(
    () => planHarnessOperation('claude', 'setup', home, targets),
    /Claude Code does not support setup.*no configuration write is required/i,
  );
  assert.throws(
    () => planHarnessOperation('missing', 'setup', home, targets),
    /unknown Harness: missing/i,
  );
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

  const plan = planHarnessOperation('pi', 'setup', home, targets);
  assert.match(plan.lines.join('\n'), /stop consuming Shared/i);
  assert.match(plan.lines.join('\n'), new RegExp(settings.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.existsSync(path.join(home.configDir, 'state.json')), false);

  plan.apply();
  plan.verify();
  const applied = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(applied, { theme: 'dark', skills: ['+local', '!skills/**'] });
  assert.equal(inspectHarnesses(home, targets).detected[0]?.sharedConsumption.status, 'excluded');
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'managed');

  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', skills: ['!**'] }));
  assert.equal(inspectHarnesses(home, targets).detected[0]?.sharedConsumption.status, 'excluded');
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'drift');
  const reconcile = planHarnessOperation('pi', 'reconcile', home, targets);
  assert.match(reconcile.lines.join('\n'), /add exclusion/);
  reconcile.apply();
  reconcile.verify();
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'managed');
});

test('Pi isolation preserves an unowned equivalent exclusion and rejects unsafe writes', () => {
  const { home, targets, piHome } = setup();
  const settings = path.join(piHome, 'agent', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', skills: ['!skills/**'] }));

  const satisfied = planHarnessOperation('pi', 'setup', home, targets);
  assert.match(satisfied.lines.join('\n'), /already satisfied/);
  satisfied.apply();
  satisfied.verify();
  assert.equal(fs.existsSync(path.join(home.configDir, 'state.json')), false);

  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', skills: [] }));
  const plan = planHarnessOperation('pi', 'setup', home, targets);
  fs.writeFileSync(settings, JSON.stringify({ theme: 'light', skills: [] }));
  assert.throws(() => plan.apply(), /changed after preview/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { theme: 'light', skills: [] });

  fs.writeFileSync(settings, JSON.stringify({ skills: {} }));
  assert.throws(
    () => planHarnessOperation('pi', 'setup', home, targets),
    /unsupported skills configuration/,
  );
  assert.equal(fs.readFileSync(settings, 'utf8'), JSON.stringify({ skills: {} }));

  fs.writeFileSync(settings, JSON.stringify({ skills: ['!skills/skillspub-probe/**'] }));
  assert.equal(inspectHarnesses(home, targets).detected[0]?.sharedConsumption.status, 'enabled');
  assert.match(planHarnessOperation('pi', 'setup', home, targets).lines.join('\n'), /add exclusion/);
});
