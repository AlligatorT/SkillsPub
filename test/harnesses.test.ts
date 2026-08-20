import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectHarnesses, planHarnessOperation } from '../src/harnesses/registry.ts';
import { grokAdapter } from '../src/harnesses/grok.ts';
import type { Home } from '../src/core.ts';
import type { SkillTarget } from '../src/inventory.ts';

function setup(): {
  home: Home;
  targets: SkillTarget[];
  piHome: string;
  claudeHome: string;
  grokHome: string;
  shared: string;
} {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-harnesses-'));
  const piHome = path.join(configDir, 'pi');
  const claudeHome = path.join(configDir, 'claude');
  const grokHome = path.join(configDir, 'grok');
  const shared = path.join(configDir, 'agents', 'skills');
  return {
    home: { configDir },
    piHome,
    claudeHome,
    grokHome,
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
      {
        key: 'grok',
        kind: 'harness',
        discoveryRoot: path.join(grokHome, 'skills'),
        parkingRoot: path.join(grokHome, '.skillspub-off', 'skills'),
        projectPath: '.grok/skills',
        relationship: { support: 'managed', link: 'unsupported' },
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

test('Grok Target honors GROK_HOME and defaults to the managed Mirror policy', () => {
  const previous = process.env.GROK_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-grok-home-'));
  process.env.GROK_HOME = root;
  try {
    const target = grokAdapter.targetDefinition();
    assert.equal(target.discoveryRoot, path.join(root, 'skills'));
    assert.equal(target.parkingRoot, path.join(root, '.skillspub-off', 'skills'));
    assert.equal(target.projectPath, '.grok/skills');
    assert.deepEqual(target.relationship, { support: 'managed', link: 'unsupported' });
  } finally {
    if (previous === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = previous;
  }
});

test('Grok inspection resolves managed Mirror Targets without writing during inspection', () => {
  const { home, targets, grokHome } = setup();
  const project = path.join(home.configDir, 'project');
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(path.join(grokHome, 'config.toml'), '# untouched\n[ui]\ntheme = "dark"\n');
  fs.mkdirSync(path.join(project, '.grok'), { recursive: true });
  const before = fs.readdirSync(home.configDir, { recursive: true }).sort();

  const grok = inspectHarnesses(home, targets, project).detected
    .find(({ key }) => key === 'grok');

  assert.equal(grok?.name, 'Grok Build');
  assert.equal(grok?.support, 'managed');
  assert.equal(grok?.sharedConsumption.status, 'enabled');
  assert.equal(grok?.isolation.status, 'unmanaged');
  assert.equal(grok?.link.supported, false);
  assert.equal(grok?.mirror?.supported, true);
  assert.deepEqual(grok?.targets, [
    { scope: 'global', discoveryRoot: path.join(grokHome, 'skills') },
    { scope: 'project', discoveryRoot: path.join(project, '.grok', 'skills') },
  ]);
  assert.ok(grok?.evidence.length);
  assert.deepEqual(fs.readdirSync(home.configDir, { recursive: true }).sort(), before);
});

test('Grok global setup preserves TOML, records recovery data, and unlinks only affected Links', () => {
  const { home, targets, grokHome, shared } = setup();
  const config = path.join(grokHome, 'config.toml');
  const sharedSkill = path.join(shared, 'shared-skill');
  const externalSkill = path.join(home.configDir, 'external', 'external-skill');
  const affectedLink = path.join(grokHome, 'skills', 'shared-skill');
  const unrelatedLink = path.join(grokHome, 'skills', 'external-skill');
  fs.mkdirSync(sharedSkill, { recursive: true });
  fs.mkdirSync(externalSkill, { recursive: true });
  fs.mkdirSync(path.dirname(affectedLink), { recursive: true });
  fs.writeFileSync(path.join(sharedSkill, 'SKILL.md'), '# shared');
  fs.writeFileSync(path.join(externalSkill, 'SKILL.md'), '# external');
  fs.symlinkSync(sharedSkill, affectedLink, 'dir');
  fs.symlinkSync(externalSkill, unrelatedLink, 'dir');
  fs.writeFileSync(config, [
    '# keep this comment',
    '[ui]',
    'theme = "dark"',
    '',
    '[compat.cursor]',
    'rules = true # preserve non-Skill cells',
    '',
  ].join('\n'));

  const plan = planHarnessOperation('grok', 'setup', home, targets);
  const preview = plan.lines.join('\n');
  assert.match(preview, /Shared ignore/i);
  assert.match(preview, /compat\.claude.*skills.*false/i);
  assert.match(preview, /compat\.cursor.*skills.*false/i);
  assert.match(preview, new RegExp(affectedLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(preview, /backup/i);
  assert.match(preview, /verify/i);
  assert.equal(fs.lstatSync(affectedLink).isSymbolicLink(), true);

  plan.apply();
  const inspection = plan.verify();
  const written = fs.readFileSync(config, 'utf8');
  assert.equal(inspection.sharedConsumption.status, 'excluded');
  assert.equal(inspection.isolation.status, 'managed');
  assert.match(written, /# keep this comment/);
  assert.match(written, /\[ui\]\ntheme = "dark"/);
  assert.match(written, /rules = true # preserve non-Skill cells/);
  assert.match(written, /\[skills\][\s\S]*ignore\s*=\s*\[/);
  assert.match(written, new RegExp(shared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(written, /\[compat\.claude\][\s\S]*skills\s*=\s*false/);
  assert.match(written, /\[compat\.cursor\][\s\S]*skills\s*=\s*false/);
  assert.equal(fs.existsSync(affectedLink), false);
  assert.equal(fs.existsSync(sharedSkill), true);
  assert.equal(fs.lstatSync(unrelatedLink).isSymbolicLink(), true);

  const recovery = fs.readdirSync(path.join(home.configDir, 'grok-recovery'), { recursive: true })
    .map(String);
  assert.ok(recovery.some((entry) => entry.endsWith('.toml')));
  assert.ok(recovery.some((entry) => entry.endsWith('.links.json')));
});

test('Grok setup updates multiline ignore arrays while preserving surrounding comments', () => {
  const { home, targets, grokHome } = setup();
  const config = path.join(grokHome, 'config.toml');
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(config, [
    '[skills]',
    'ignore = [ # keep ignore note',
    '  "/tmp/already-ignored]",',
    ']',
    '# keep following comment',
    '[compat.claude]',
    'skills = false',
    '[compat.cursor]',
    'skills = false',
    '',
  ].join('\n'));

  const plan = planHarnessOperation('grok', 'setup', home, targets);
  plan.apply();
  plan.verify();

  const written = fs.readFileSync(config, 'utf8');
  assert.match(written, /ignore = \[.*\] # keep ignore note/);
  assert.match(written, /# keep following comment/);
  assert.doesNotMatch(written, /"\/tmp\/already-ignored\]",\n\]/);
});

test('Grok reconcile retries Links already invalidated by configured ignores', () => {
  const { home, targets, grokHome, shared } = setup();
  const source = path.join(shared, 'example');
  const link = path.join(grokHome, 'skills', 'example');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# example');
  fs.symlinkSync(source, link, 'dir');
  fs.writeFileSync(path.join(grokHome, 'config.toml'), [
    '[skills]',
    `ignore = [${JSON.stringify(shared)}]`,
    '[compat.claude]',
    'skills = false',
    '[compat.cursor]',
    'skills = false',
    '',
  ].join('\n'));

  const reconcile = planHarnessOperation('grok', 'reconcile', home, targets);
  assert.match(reconcile.lines.join('\n'), new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  reconcile.apply();
  reconcile.verify();
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.existsSync(source), true);
});

test('Grok project setup adds Shared roots through the Git root without a central project registry', () => {
  const { home, targets, grokHome, shared } = setup();
  const parent = path.join(home.configDir, 'workspace');
  const project = path.join(parent, 'project');
  const selectedShared = path.join(project, '.agents', 'skills');
  const ancestorShared = path.join(parent, '.agents', 'skills');
  const outsideGitShared = path.join(home.configDir, '.agents', 'skills');
  const outsideGrokLink = path.join(home.configDir, '.grok', 'skills', 'outside-link');
  fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
  fs.mkdirSync(selectedShared, { recursive: true });
  fs.mkdirSync(path.join(ancestorShared, 'ancestor-skill'), { recursive: true });
  fs.mkdirSync(outsideGitShared, { recursive: true });
  fs.mkdirSync(path.join(project, '.grok', 'skills'), { recursive: true });
  fs.mkdirSync(path.dirname(outsideGrokLink), { recursive: true });
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(path.join(ancestorShared, 'ancestor-skill', 'SKILL.md'), '# ancestor');
  fs.symlinkSync(path.join(ancestorShared, 'ancestor-skill'), outsideGrokLink, 'dir');
  fs.symlinkSync(
    path.join(ancestorShared, 'ancestor-skill'),
    path.join(project, '.grok', 'skills', 'ancestor-skill'),
    'dir',
  );
  fs.writeFileSync(path.join(grokHome, 'config.toml'), [
    '[skills]',
    `ignore = [${JSON.stringify(shared)}]`,
    '[compat.claude]',
    'skills = false',
    '[compat.cursor]',
    'skills = false',
    '',
  ].join('\n'));

  const plan = planHarnessOperation('grok', 'setup', home, targets, project);
  assert.match(plan.lines.join('\n'), new RegExp(selectedShared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(plan.lines.join('\n'), new RegExp(ancestorShared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(plan.lines.join('\n'), new RegExp(outsideGitShared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(plan.lines.join('\n'), new RegExp(outsideGrokLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  plan.apply();
  const inspection = plan.verify();
  const written = fs.readFileSync(path.join(grokHome, 'config.toml'), 'utf8');
  assert.equal(inspection.sharedConsumption.status, 'excluded');
  assert.match(written, new RegExp(selectedShared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(written, new RegExp(ancestorShared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.existsSync(path.join(project, '.grok', 'skills', 'ancestor-skill')), false);
  assert.equal(fs.existsSync(path.join(ancestorShared, 'ancestor-skill')), true);
  assert.equal(fs.lstatSync(outsideGrokLink).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(home.configDir, 'state.json')), false);
  assert.equal(fs.existsSync(path.join(project, '.skillspub', 'state.json')), true);
  assert.equal(fs.existsSync(path.join(project, '.skillspub', 'grok-recovery')), true);
});

test('Grok setup rejects unsafe TOML and concurrent changes before mutation', () => {
  const fixtures = [
    { raw: '[skills]\npaths = ["/tmp/extra"]\n', error: /skills\.paths.*empty/i },
    { raw: '[skills]\ndisabled = ["blocked"]\n', error: /skills\.disabled.*empty/i },
    { raw: '[skills]\nignore = ["GROK_ROOT"]\n', error: /conflicts with.*Grok Target/i },
    { raw: '[skills]\nignore = "wrong"\n', error: /skills\.ignore.*array of strings/i },
    { raw: '[skills\nignore = []\n', error: /cannot parse Grok config/i },
  ];
  for (const fixture of fixtures) {
    const { home, targets, grokHome } = setup();
    const config = path.join(grokHome, 'config.toml');
    fs.mkdirSync(grokHome, { recursive: true });
    const raw = fixture.raw.replace('GROK_ROOT', path.join(grokHome, 'skills'));
    fs.writeFileSync(config, raw);
    const before = fs.readFileSync(config, 'utf8');
    assert.throws(() => planHarnessOperation('grok', 'setup', home, targets), fixture.error);
    const inspection = inspectHarnesses(home, targets).detected.find(({ key }) => key === 'grok');
    assert.equal(inspection?.sharedConsumption.status, 'unknown');
    assert.equal(inspection?.isolation.status, 'unknown');
    assert.equal(fs.readFileSync(config, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(home.configDir, 'state.json')), false);
    assert.equal(fs.existsSync(path.join(home.configDir, 'grok-recovery')), false);
  }

  const { home, targets, grokHome } = setup();
  const config = path.join(grokHome, 'config.toml');
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(config, '# original\n');
  const plan = planHarnessOperation('grok', 'setup', home, targets);
  fs.writeFileSync(config, '# changed\n');
  assert.throws(() => plan.apply(), /changed after preview/i);
  assert.equal(fs.readFileSync(config, 'utf8'), '# changed\n');
  assert.equal(fs.existsSync(path.join(home.configDir, 'state.json')), false);
  assert.equal(fs.existsSync(path.join(home.configDir, 'grok-recovery')), false);
});

test('Grok reports managed drift and requires explicit reconcile', () => {
  const { home, targets, grokHome } = setup();
  fs.mkdirSync(grokHome, { recursive: true });
  const config = path.join(grokHome, 'config.toml');
  fs.writeFileSync(config, '');
  const setupPlan = planHarnessOperation('grok', 'setup', home, targets);
  setupPlan.apply();
  setupPlan.verify();

  const drifted = fs.readFileSync(config, 'utf8')
    .replace('[compat.claude]\nskills = false', '[compat.claude]\nskills = true');
  fs.writeFileSync(config, drifted);
  const inspection = inspectHarnesses(home, targets).detected.find(({ key }) => key === 'grok');
  assert.equal(inspection?.sharedConsumption.status, 'excluded');
  assert.equal(inspection?.isolation.status, 'drift');
  assert.throws(
    () => planHarnessOperation('grok', 'setup', home, targets),
    /explicit reconcile/i,
  );

  const reconcile = planHarnessOperation('grok', 'reconcile', home, targets);
  reconcile.apply();
  assert.equal(reconcile.verify().isolation.status, 'managed');
});

test('Grok inspection reports malformed configuration as unconfirmable', () => {
  const { home, targets, grokHome } = setup();
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(path.join(grokHome, 'config.toml'), '[skills\nignore = []\n');

  const grok = inspectHarnesses(home, targets).detected.find(({ key }) => key === 'grok');

  assert.equal(grok?.sharedConsumption.status, 'unknown');
  assert.equal(grok?.isolation.status, 'unknown');
  assert.match(grok?.sharedConsumption.detail ?? '', /cannot parse Grok config/i);
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
