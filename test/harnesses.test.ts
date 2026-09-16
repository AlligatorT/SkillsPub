import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectHarnesses, planHarnessOperation } from '../src/harnesses/registry.ts';
import { codexAdapter } from '../src/harnesses/codex.ts';
import { cursorAdapter } from '../src/harnesses/cursor.ts';
import { grokAdapter } from '../src/harnesses/grok.ts';
import { hermesAdapter } from '../src/harnesses/hermes.ts';
import { piAdapter } from '../src/harnesses/pi.ts';
import type { Home } from '../src/core.ts';
import { scanGlobalInventory, type SkillTarget } from '../src/inventory.ts';

function setup(): {
  home: Home;
  targets: SkillTarget[];
  piHome: string;
  claudeHome: string;
  grokHome: string;
  codexHome: string;
  cursorHome: string;
  hermesHome: string;
  shared: string;
} {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-harnesses-'));
  const piHome = path.join(configDir, 'pi');
  const claudeHome = path.join(configDir, 'claude');
  const grokHome = path.join(configDir, 'grok');
  const codexHome = path.join(configDir, 'codex');
  const cursorHome = path.join(configDir, 'cursor');
  const hermesHome = path.join(configDir, 'hermes');
  const shared = path.join(configDir, 'agents', 'skills');
  return {
    home: { configDir },
    piHome,
    claudeHome,
    grokHome,
    codexHome,
    cursorHome,
    hermesHome,
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
      {
        key: 'codex',
        kind: 'harness',
        discoveryRoot: path.join(codexHome, 'skills'),
        parkingRoot: path.join(codexHome, '.skillspub-off', 'skills'),
        projectPath: '.codex/skills',
        relationship: { support: 'discoverable', link: 'supported' },
      },
      {
        key: 'cursor',
        kind: 'harness',
        discoveryRoot: path.join(cursorHome, 'skills'),
        parkingRoot: path.join(cursorHome, '.skillspub-off', 'skills'),
        projectPath: '.cursor/skills',
        relationship: { support: 'discoverable', link: 'supported' },
      },
      {
        key: 'hermes',
        kind: 'harness',
        discoveryRoot: path.join(hermesHome, 'skills'),
        parkingRoot: path.join(hermesHome, '.skillspub-off', 'skills'),
        projectPath: '.hermes/skills',
        relationship: { support: 'discoverable', link: 'supported' },
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
  assert.deepEqual(piAdapter.targetDefinition().relationship, { support: 'managed', link: 'supported' });
  assert.equal(pi?.targets[0]?.discoveryRoot, path.join(piHome, 'agent', 'skills'));
  assert.equal(pi?.targets.some(({ discoveryRoot }) => discoveryRoot === shared), false);
  assert.deepEqual(fs.readdirSync(home.configDir).sort(), before);
});

test('Pi inspection resolves Global and Project Pi Targets and observes Shared exclusion', () => {
  const { home, targets, piHome } = setup();
  const project = path.join(home.configDir, 'project');
  fs.mkdirSync(path.join(piHome, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const canonicalProject = fs.realpathSync(project);
  fs.writeFileSync(
    path.join(piHome, 'agent', 'settings.json'),
    JSON.stringify({ defaultProjectTrust: 'always', skills: [`!${path.join(home.configDir, 'agents', 'skills')}/**`] }),
  );
  fs.writeFileSync(
    path.join(project, '.pi', 'settings.json'),
    JSON.stringify({ skills: [`!${path.join(canonicalProject, '.agents', 'skills')}/**`] }),
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
      { scope: 'project', discoveryRoot: path.join(canonicalProject, '.pi', 'skills') },
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

test('Codex Target honors CODEX_HOME and keeps the deprecated user root as its Skill Target', () => {
  const previous = process.env.CODEX_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-codex-home-'));
  process.env.CODEX_HOME = root;
  try {
    const target = codexAdapter.targetDefinition();
    assert.equal(target.discoveryRoot, path.join(root, 'skills'));
    assert.equal(target.parkingRoot, path.join(root, '.skillspub-off', 'skills'));
    assert.equal(target.projectPath, '.codex/skills');
    assert.deepEqual(target.relationship, { support: 'discoverable', link: 'supported' });
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test('Codex inspection reports required Shared consumption without configuration writes', () => {
  const { home, targets, codexHome, shared } = setup();
  const project = path.join(home.configDir, 'project');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  const skillRoot = path.join(codexHome, 'skills', 'demo');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.copyFileSync(
    path.join(import.meta.dirname, 'fixtures/codex/demo/SKILL.md'),
    path.join(skillRoot, 'SKILL.md'),
  );
  const before = fs.readdirSync(home.configDir, { recursive: true }).sort();

  const codex = inspectHarnesses(home, targets, project).detected
    .find(({ key }) => key === 'codex');

  assert.equal(codex?.name, 'Codex');
  assert.equal(codex?.support, 'discoverable');
  assert.equal(codex?.sharedConsumption.status, 'required');
  assert.match(codex?.sharedConsumption.detail ?? '', /does not invent a block/i);
  assert.equal(codex?.isolation.status, 'unmanaged');
  assert.equal(codex?.link.supported, true);
  assert.deepEqual(codex?.targets, [
    { scope: 'global', discoveryRoot: path.join(codexHome, 'skills') },
    { scope: 'project', discoveryRoot: path.join(project, '.codex', 'skills') },
  ]);
  assert.equal(
    codex?.roots.find(({ kind, scope }) => kind === 'shared' && scope === 'global')?.consumption,
    'consumed',
  );
  assert.equal(
    codex?.roots.find(({ kind, scope }) => kind === 'shared' && scope === 'global')?.discoveryRoot,
    shared,
  );
  assert.ok(codex?.evidence.some(({ url }) => url === 'https://developers.openai.com/codex/skills'));
  assert.ok(codex?.evidence.some(({ url }) =>
    url === 'https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/ext/skills/src/host_roots.rs'));
  assert.ok(codex?.evidence.every(({ verifiedVersion }) => verifiedVersion === '0.154.0'));
  assert.deepEqual(fs.readdirSync(home.configDir, { recursive: true }).sort(), before);

  const scanned = scanGlobalInventory(home, targets, { persist: false });
  assert.ok(scanned.relationships.some((relationship) =>
    relationship.targetKey === 'codex' && relationship.slot === 'demo' && relationship.activation === 'on'));
  assert.deepEqual(fs.readdirSync(home.configDir, { recursive: true }).sort(), before);
});

test('Cursor Target uses ~/.cursor/skills and keeps Link supported', () => {
  const target = cursorAdapter.targetDefinition();
  assert.equal(target.discoveryRoot, path.join(os.homedir(), '.cursor', 'skills'));
  assert.equal(target.parkingRoot, path.join(os.homedir(), '.cursor', '.skillspub-off', 'skills'));
  assert.equal(target.projectPath, '.cursor/skills');
  assert.deepEqual(target.relationship, { support: 'discoverable', link: 'supported' });
});

test('Cursor inspection reports required Shared consumption without configuration writes', () => {
  const { home, targets, cursorHome, shared } = setup();
  const project = path.join(home.configDir, 'project');
  fs.mkdirSync(cursorHome, { recursive: true });
  fs.mkdirSync(path.join(project, '.cursor'), { recursive: true });
  const skillRoot = path.join(cursorHome, 'skills', 'demo');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.copyFileSync(
    path.join(import.meta.dirname, 'fixtures/cursor/demo/SKILL.md'),
    path.join(skillRoot, 'SKILL.md'),
  );
  const before = fs.readdirSync(home.configDir, { recursive: true }).sort();

  const cursor = inspectHarnesses(home, targets, project).detected
    .find(({ key }) => key === 'cursor');

  assert.equal(cursor?.name, 'Cursor');
  assert.equal(cursor?.support, 'discoverable');
  assert.equal(cursor?.sharedConsumption.status, 'required');
  assert.match(cursor?.sharedConsumption.detail ?? '', /does not invent a block/i);
  assert.equal(cursor?.isolation.status, 'unmanaged');
  assert.equal(cursor?.link.supported, true);
  assert.deepEqual(cursor?.targets, [
    { scope: 'global', discoveryRoot: path.join(cursorHome, 'skills') },
    { scope: 'project', discoveryRoot: path.join(project, '.cursor', 'skills') },
  ]);
  assert.equal(
    cursor?.roots.find(({ kind, scope }) => kind === 'shared' && scope === 'global')?.consumption,
    'consumed',
  );
  assert.equal(
    cursor?.roots.find(({ kind, scope }) => kind === 'shared' && scope === 'global')?.discoveryRoot,
    shared,
  );
  assert.ok(cursor?.evidence.some(({ url }) => url === 'https://cursor.com/docs/skills'));
  assert.ok(cursor?.evidence.some(({ url }) => url === 'https://cursor.com/help/customization/skills'));
  assert.ok(cursor?.evidence.every(({ verifiedVersion }) => verifiedVersion === 'docs-2026-09-10'));
  assert.deepEqual(fs.readdirSync(home.configDir, { recursive: true }).sort(), before);

  const scanned = scanGlobalInventory(home, targets, { persist: false });
  assert.ok(scanned.relationships.some((relationship) =>
    relationship.targetKey === 'cursor' && relationship.slot === 'demo' && relationship.activation === 'on'));
  assert.deepEqual(fs.readdirSync(home.configDir, { recursive: true }).sort(), before);
});

test('Hermes Target honors HERMES_HOME and keeps ~/.hermes/skills as its Skill Target', () => {
  const previous = process.env.HERMES_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-hermes-home-'));
  process.env.HERMES_HOME = root;
  try {
    const target = hermesAdapter.targetDefinition();
    assert.equal(target.discoveryRoot, path.join(root, 'skills'));
    assert.equal(target.parkingRoot, path.join(root, '.skillspub-off', 'skills'));
    assert.equal(target.projectPath, '.hermes/skills');
    assert.deepEqual(target.relationship, { support: 'discoverable', link: 'supported' });
  } finally {
    if (previous === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous;
  }
});

test('Hermes inspection reports not-consumed Shared without configuration writes', () => {
  const { home, targets, hermesHome, shared } = setup();
  const project = path.join(home.configDir, 'project');
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.mkdirSync(path.join(project, '.hermes'), { recursive: true });
  const skillRoot = path.join(hermesHome, 'skills', 'demo');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.copyFileSync(
    path.join(import.meta.dirname, 'fixtures/hermes/demo/SKILL.md'),
    path.join(skillRoot, 'SKILL.md'),
  );
  const before = fs.readdirSync(home.configDir, { recursive: true }).sort();

  const hermes = inspectHarnesses(home, targets, project).detected
    .find(({ key }) => key === 'hermes');

  assert.equal(hermes?.name, 'Hermes');
  assert.equal(hermes?.support, 'discoverable');
  assert.equal(hermes?.sharedConsumption.status, 'not-consumed');
  assert.match(hermes?.sharedConsumption.detail ?? '', /does not invent a block/i);
  assert.equal(hermes?.isolation.status, 'not-required');
  assert.equal(hermes?.link.supported, true);
  assert.deepEqual(hermes?.targets, [
    { scope: 'global', discoveryRoot: path.join(hermesHome, 'skills') },
    { scope: 'project', discoveryRoot: path.join(project, '.hermes', 'skills') },
  ]);
  assert.equal(
    hermes?.roots.find(({ kind, scope }) => kind === 'shared' && scope === 'global')?.consumption,
    'excluded',
  );
  assert.equal(
    hermes?.roots.find(({ kind, scope }) => kind === 'shared' && scope === 'global')?.discoveryRoot,
    shared,
  );
  assert.equal(
    hermes?.roots.find(({ kind, scope }) => kind === 'shared' && scope === 'project')?.consumption,
    'unknown',
  );
  assert.ok(hermes?.evidence.some(({ url }) =>
    url === 'https://hermes-agent.nousresearch.com/docs/user-guide/features/skills'));
  assert.ok(hermes?.evidence.some(({ url }) =>
    url === 'https://github.com/NousResearch/hermes-agent/blob/v2026.9.14/agent/skill_utils.py'));
  assert.ok(hermes?.evidence.every(({ verifiedVersion }) => verifiedVersion === '0.21.3'));
  assert.deepEqual(fs.readdirSync(home.configDir, { recursive: true }).sort(), before);

  const scanned = scanGlobalInventory(home, targets, { persist: false });
  assert.ok(scanned.relationships.some((relationship) =>
    relationship.targetKey === 'hermes' && relationship.slot === 'demo' && relationship.activation === 'on'));
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

  const relationships = setup();
  const sharedSkill = path.join(relationships.shared, 'shared-skill');
  const externalSkill = path.join(relationships.home.configDir, 'external', 'ego-browser');
  const grokSkills = path.join(relationships.grokHome, 'skills');
  fs.mkdirSync(sharedSkill, { recursive: true });
  fs.mkdirSync(externalSkill, { recursive: true });
  fs.mkdirSync(grokSkills, { recursive: true });
  fs.writeFileSync(path.join(sharedSkill, 'SKILL.md'), '# shared');
  fs.writeFileSync(path.join(externalSkill, 'SKILL.md'), '# ego-browser');
  fs.symlinkSync(sharedSkill, path.join(grokSkills, 'shared-skill'), 'dir');
  const retainedLink = path.join(grokSkills, 'ego-browser');
  fs.symlinkSync(externalSkill, retainedLink, 'dir');
  const relationshipConfig = path.join(relationships.grokHome, 'config.toml');
  fs.writeFileSync(relationshipConfig, '# original\n');
  const relationshipPlan = planHarnessOperation(
    'grok',
    'setup',
    relationships.home,
    relationships.targets,
  );
  fs.unlinkSync(retainedLink);
  assert.throws(() => relationshipPlan.apply(), /Relationships changed after preview/i);
  assert.equal(fs.readFileSync(relationshipConfig, 'utf8'), '# original\n');
  assert.equal(fs.lstatSync(path.join(grokSkills, 'shared-skill')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(relationships.home.configDir, 'state.json')), false);
  assert.equal(fs.existsSync(path.join(relationships.home.configDir, 'grok-recovery')), false);
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
  fs.mkdirSync(project, { recursive: true });
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
    () => planHarnessOperation('codex', 'setup', home, targets),
    /Codex does not support setup.*no configuration write is required/i,
  );
  assert.throws(
    () => planHarnessOperation('cursor', 'setup', home, targets),
    /Cursor does not support setup.*no configuration write is required/i,
  );
  assert.throws(
    () => planHarnessOperation('hermes', 'setup', home, targets),
    /Hermes does not support setup.*no configuration write is required/i,
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
  const { home, targets, piHome, shared } = setup();
  const settings = path.join(piHome, 'agent', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', skills: ['+local'] }, null, 2));
  const sharedSkill = path.join(shared, 'shared-skill');
  const piLink = path.join(piHome, 'agent', 'skills', 'shared-skill');
  fs.mkdirSync(sharedSkill, { recursive: true });
  fs.mkdirSync(path.dirname(piLink), { recursive: true });
  fs.writeFileSync(path.join(sharedSkill, 'SKILL.md'), '# shared');
  fs.symlinkSync(sharedSkill, piLink, 'dir');

  const plan = planHarnessOperation('pi', 'setup', home, targets);
  assert.match(plan.lines.join('\n'), /stop consuming Shared/i);
  assert.match(plan.lines.join('\n'), new RegExp(settings.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.existsSync(path.join(home.configDir, 'state.json')), false);
  assert.equal(plan.relationshipImpact?.summary.unlinkedRelationships, 0);
  assert.equal(plan.relationshipImpact?.summary.retainedRelationships, 1);
  assert.equal(plan.relationshipImpact?.groups[0]?.relationships[0]?.plannedAction, 'retain');
  assert.equal(plan.relationshipImpact?.groups[0]?.relationships[0]?.targetPath, piLink);
  assert.ok(plan.recovery?.some((line) => /hash/i.test(line)));

  plan.apply();
  const inspection = plan.verify();
  const result = plan.result?.(inspection);
  const applied = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(applied, { theme: 'dark', skills: ['+local', `!${path.resolve(shared)}/**`] });
  assert.doesNotMatch(applied.skills.join('\n'), /^!skills\/\*\*$/m);
  assert.equal(inspectHarnesses(home, targets).detected[0]?.sharedConsumption.status, 'excluded');
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'managed');
  assert.ok(fs.existsSync(piLink));
  assert.equal(result?.actual.retainedRelationships, 1);
  assert.equal(result?.drift.relationships.length, 0);
  assert.equal(result?.recovery.configBackupPreserved, true);
  assert.equal(result?.recovery.manifestPreserved, true);

  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', skills: [] }));
  assert.equal(inspectHarnesses(home, targets).detected[0]?.sharedConsumption.status, 'enabled');
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'drift');
  const reconcile = planHarnessOperation('pi', 'reconcile', home, targets);
  assert.match(reconcile.lines.join('\n'), /add exclusion/);
  reconcile.apply();
  reconcile.verify();
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'managed');
});

test('Pi isolation preserves an unowned equivalent exclusion and rejects unsafe writes', () => {
  const { home, targets, piHome, shared } = setup();
  const settings = path.join(piHome, 'agent', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const safeUnowned = JSON.stringify({ theme: 'dark', skills: [`!${shared}/../skills/**`] });
  fs.writeFileSync(settings, safeUnowned);

  const satisfied = planHarnessOperation('pi', 'setup', home, targets);
  assert.match(satisfied.lines.join('\n'), /already satisfied/);
  satisfied.apply();
  satisfied.verify();
  assert.equal(fs.readFileSync(settings, 'utf8'), safeUnowned);
  assert.equal(fs.existsSync(path.join(home.configDir, 'state.json')), false);
  assert.equal(fs.existsSync(path.join(home.configDir, 'pi-recovery')), false);

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

  fs.writeFileSync(settings, JSON.stringify({ skills: ['!skills/**'] }));
  assert.throws(
    () => planHarnessOperation('pi', 'setup', home, targets),
    /conflicts with the Global Pi Target/,
  );
  assert.equal(fs.existsSync(path.join(home.configDir, 'state.json')), false);

  const exactExclusion = `!${path.resolve(shared)}/**`;
  const sharedForcePath = path.join(shared, 'forced');
  fs.writeFileSync(settings, JSON.stringify({ skills: [exactExclusion, `+${sharedForcePath}`] }));
  assert.equal(inspectHarnesses(home, targets).detected[0]?.sharedConsumption.status, 'enabled');
  assert.throws(
    () => planHarnessOperation('pi', 'setup', home, targets),
    /force-include conflicts with Global Shared isolation/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).skills, [exactExclusion, `+${sharedForcePath}`]);

  fs.writeFileSync(settings, JSON.stringify({
    skills: [exactExclusion, `+${sharedForcePath}`, `-${sharedForcePath}`],
  }));
  assert.equal(inspectHarnesses(home, targets).detected[0]?.sharedConsumption.status, 'excluded');
  const forceExcluded = planHarnessOperation('pi', 'setup', home, targets);
  forceExcluded.apply();
  forceExcluded.verify();
  assert.equal(fs.existsSync(path.join(home.configDir, 'state.json')), false);

  fs.writeFileSync(settings, JSON.stringify({ skills: ['!skills/skillspub-probe/**'] }));
  assert.equal(inspectHarnesses(home, targets).detected[0]?.sharedConsumption.status, 'enabled');
  assert.match(planHarnessOperation('pi', 'setup', home, targets).lines.join('\n'), /add exclusion/);

  fs.writeFileSync(settings, JSON.stringify({ skills: ['!~/.agents/skills/**'] }));
  assert.equal(inspectHarnesses(home, targets).detected[0]?.sharedConsumption.status, 'enabled');
  assert.match(planHarnessOperation('pi', 'setup', home, targets).lines.join('\n'), /add exclusion/);
});

test('Pi reconcile releases stale ownership when a safe equivalent exclusion replaces its exact rule', () => {
  const { home, targets, piHome, shared } = setup();
  const settings = path.join(piHome, 'agent', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ skills: [] }));

  const setupPlan = planHarnessOperation('pi', 'setup', home, targets);
  setupPlan.apply();
  setupPlan.verify();

  const ownedSettings = JSON.parse(fs.readFileSync(settings, 'utf8'));
  const reformattedSettings = JSON.stringify({ ...ownedSettings, theme: 'dark' });
  fs.writeFileSync(settings, reformattedSettings);
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'drift');
  const hashReconcile = planHarnessOperation('pi', 'reconcile', home, targets);
  assert.equal(hashReconcile.relationshipImpact?.configuration.plannedAction, 'retain');
  assert.equal(hashReconcile.relationshipImpact?.ownershipState?.plannedAction, 'write');
  hashReconcile.apply();
  hashReconcile.verify();
  assert.equal(fs.readFileSync(settings, 'utf8'), reformattedSettings);
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'managed');

  const equivalent = `!${shared}/../skills/**`;
  const equivalentSettings = JSON.stringify({ skills: [equivalent] });
  fs.writeFileSync(settings, equivalentSettings);
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'drift');

  const reconcile = planHarnessOperation('pi', 'reconcile', home, targets);
  assert.equal(reconcile.relationshipImpact?.configuration.plannedAction, 'retain');
  assert.equal(reconcile.relationshipImpact?.ownershipState?.plannedAction, 'write');
  reconcile.apply();
  reconcile.verify();

  assert.equal(fs.readFileSync(settings, 'utf8'), equivalentSettings);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8')).piIsolation, undefined);
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'unmanaged');
});

test('Pi exact-Project operation covers trusted ancestor roots and leaves Global truth unchanged', () => {
  const { home, targets, piHome } = setup();
  const globalSettings = path.join(piHome, 'agent', 'settings.json');
  const globalState = path.join(home.configDir, 'state.json');
  const repo = path.join(home.configDir, 'repo');
  const project = path.join(repo, 'nested');
  const projectSettings = path.join(project, '.pi', 'settings.json');
  const projectState = path.join(project, '.skillspub', 'state.json');
  const source = path.join(home.configDir, 'source');
  const projectLink = path.join(project, '.pi', 'skills', 'example');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.dirname(globalSettings), { recursive: true });
  fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.dirname(projectLink), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# example');
  fs.symlinkSync(source, projectLink, 'dir');
  fs.writeFileSync(globalSettings, JSON.stringify({ theme: 'dark' }));
  fs.writeFileSync(globalState, '{"external":true}');
  const canonicalRepo = fs.realpathSync(repo);
  const canonicalProject = fs.realpathSync(project);
  fs.writeFileSync(path.join(piHome, 'agent', 'trust.json'), JSON.stringify({ [canonicalRepo]: true }));
  fs.writeFileSync(projectSettings, JSON.stringify({ theme: 'light', skills: [] }));

  const plan = planHarnessOperation('pi', 'setup', home, targets, project);
  assert.match(plan.lines.join('\n'), /Project only/);
  assert.match(plan.lines.join('\n'), new RegExp(path.join(canonicalProject, '.agents', 'skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(plan.lines.join('\n'), new RegExp(path.join(canonicalRepo, '.agents', 'skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  plan.apply();
  const inspection = plan.verify();

  const skills = JSON.parse(fs.readFileSync(projectSettings, 'utf8')).skills;
  assert.deepEqual(skills, [
    `!${path.join(canonicalProject, '.agents', 'skills')}/**`,
    `!${path.join(canonicalRepo, '.agents', 'skills')}/**`,
  ]);
  assert.equal(inspection.isolation.status, 'managed');
  assert.equal(JSON.parse(fs.readFileSync(projectState, 'utf8')).piIsolation.scope, 'project');
  assert.equal(fs.readFileSync(globalSettings, 'utf8'), JSON.stringify({ theme: 'dark' }));
  assert.equal(fs.readFileSync(globalState, 'utf8'), '{"external":true}');
  assert.ok(fs.existsSync(projectLink));
  assert.ok(fs.readdirSync(path.join(project, '.skillspub', 'pi-recovery')).some((entry) => entry.endsWith('.paths.json')));

  fs.writeFileSync(projectSettings, JSON.stringify({ theme: 'changed', skills }));
  const reconcile = planHarnessOperation('pi', 'reconcile', home, targets, project);
  fs.writeFileSync(projectState, '{"changed":true}');
  assert.throws(() => reconcile.apply(), /state changed after preview/);
});

test('Pi Project inspection and setup conservatively gate unresolved or rejected trust', () => {
  const { home, targets, piHome } = setup();
  const project = path.join(home.configDir, 'project');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
  fs.mkdirSync(path.join(piHome, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(project, '.pi', 'settings.json'), JSON.stringify({ skills: [] }));

  assert.equal(inspectHarnesses(home, targets, project).detected[0]?.isolation.status, 'unknown');
  assert.throws(() => planHarnessOperation('pi', 'setup', home, targets, project), /requires confirmed trust/);
  const canonicalProject = fs.realpathSync(project);
  fs.writeFileSync(path.join(piHome, 'agent', 'trust.json'), JSON.stringify({ [canonicalProject]: false }));
  assert.throws(() => planHarnessOperation('pi', 'setup', home, targets, project), /does not trust/);

  fs.writeFileSync(path.join(piHome, 'agent', 'trust.json'), JSON.stringify({ [canonicalProject]: true }));
  const sharedRoot = path.join(canonicalProject, '.agents', 'skills');
  fs.mkdirSync(path.join(sharedRoot, 'forced'), { recursive: true });
  fs.writeFileSync(path.join(sharedRoot, 'forced', 'SKILL.md'), '# forced');
  fs.writeFileSync(path.join(project, '.pi', 'settings.json'), JSON.stringify({
    skills: [`!${sharedRoot}/**`, '+forced'],
  }));
  const forceIncludedInspection = inspectHarnesses(home, targets, project).detected[0];
  assert.equal(
    forceIncludedInspection?.roots.find((root) => root.kind === 'shared' && root.scope === 'project')?.consumption,
    'consumed',
  );
  assert.throws(
    () => planHarnessOperation('pi', 'setup', home, targets, project),
    /force-include conflicts with Project Shared isolation/,
  );
  fs.writeFileSync(path.join(project, '.pi', 'settings.json'), JSON.stringify({
    skills: [`!${sharedRoot}/**`, '+forced', '-forced'],
  }));
  const forceExcludedInspection = inspectHarnesses(home, targets, project).detected[0];
  assert.equal(
    forceExcludedInspection?.roots.find((root) => root.kind === 'shared' && root.scope === 'project')?.consumption,
    'excluded',
  );
});

test('Pi Project matcher dedupes canonical aliases and blocks competing Variants', () => {
  const { home, targets, piHome } = setup();
  const project = path.join(home.configDir, 'project');
  const canonicalProject = fs.realpathSync(fs.mkdirSync(project, { recursive: true }) ?? project);
  fs.mkdirSync(path.join(piHome, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(piHome, 'agent', 'trust.json'), JSON.stringify({ [canonicalProject]: true }));
  const sharedSkill = path.join(project, '.agents', 'skills', 'variant');
  const piSkill = path.join(project, '.pi', 'skills', 'variant');
  fs.mkdirSync(sharedSkill, { recursive: true });
  fs.mkdirSync(path.dirname(piSkill), { recursive: true });
  fs.writeFileSync(path.join(sharedSkill, 'SKILL.md'), '# shared');
  fs.symlinkSync(sharedSkill, piSkill, 'dir');
  const settings = path.join(project, '.pi', 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({
    skills: [`!${path.join(project, '.agents', 'skills')}/**`, `+${sharedSkill}`],
  }));

  assert.notEqual(inspectHarnesses(home, targets, project).detected[0]?.isolation.status, 'unknown');
  fs.rmSync(piSkill);
  fs.mkdirSync(piSkill, { recursive: true });
  fs.writeFileSync(path.join(piSkill, 'SKILL.md'), '# competing');
  assert.match(inspectHarnesses(home, targets, project).detected[0]?.isolation.detail ?? '', /collision/i);
  assert.throws(() => planHarnessOperation('pi', 'setup', home, targets, project), /competing Variant/i);
});

test('Pi Project Target migration previews, preserves content and state, and refuses conflicts', () => {
  const { home, targets } = setup();
  const project = path.join(home.configDir, 'project');
  const stale = targets.map((target) => target.key === 'pi' ? { ...target, projectPath: '.pi/agent/skills' } : target);
  const source = path.join(project, '.pi', 'agent', 'skills');
  const destination = path.join(project, '.pi', 'skills');
  const relationship = path.join(source, 'example');
  const resource = path.join(home.configDir, 'resource');
  const state = path.join(project, '.skillspub', 'state.json');
  fs.mkdirSync(resource, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(path.join(resource, 'SKILL.md'), '# example');
  fs.symlinkSync(resource, relationship, 'dir');
  fs.writeFileSync(state, '{"baseIntent":{"project:example":"on"}}');
  fs.writeFileSync(path.join(home.configDir, 'targets.json'), `${JSON.stringify({ version: 1, overrides: [{ key: 'pi', projectPath: '.pi/agent/skills' }], genericTargets: [] })}\n`);

  const plan = planHarnessOperation('pi', 'migrate', home, stale, project);
  assert.match(plan.lines.join('\n'), /source content SHA-256/);
  assert.match(plan.lines.join('\n'), /canonical \.pi\/skills/);
  assert.equal(plan.relationshipImpact?.summary.retainedRelationships, 1);
  plan.apply();
  plan.verify();

  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.realpathSync(path.join(destination, 'example')), fs.realpathSync(resource));
  assert.equal(fs.readFileSync(state, 'utf8'), '{"baseIntent":{"project:example":"on"}}');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home.configDir, 'targets.json'), 'utf8')).overrides, []);
  const recoveryEntries = fs.readdirSync(path.join(project, '.skillspub', 'pi-recovery'));
  const manifest = path.join(
    project,
    '.skillspub',
    'pi-recovery',
    recoveryEntries.find((entry) => entry.endsWith('.migration.json'))!,
  );
  const recoveryScript = path.join(
    project,
    '.skillspub',
    'pi-recovery',
    recoveryEntries.find((entry) => entry.endsWith('.recover.mjs'))!,
  );
  const manifestRaw = fs.readFileSync(manifest, 'utf8');
  fs.appendFileSync(manifest, 'tampered');
  assert.throws(() => execFileSync(process.execPath, [recoveryScript]), /Migration manifest hash mismatch/);
  fs.writeFileSync(manifest, manifestRaw);
  fs.writeFileSync(path.join(destination, 'unexpected.txt'), 'preserve me');
  assert.match(execFileSync(process.execPath, [recoveryScript], { encoding: 'utf8' }), /recovery verified/);
  assert.equal(fs.realpathSync(path.join(source, 'example')), fs.realpathSync(resource));
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.readFileSync(`${destination}.recovery-conflict/unexpected.txt`, 'utf8'), 'preserve me');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(home.configDir, 'targets.json'), 'utf8')).overrides[0].projectPath,
    '.pi/agent/skills',
  );
  assert.equal(fs.readFileSync(state, 'utf8'), '{"baseIntent":{"project:example":"on"}}');

  const conflictProject = path.join(home.configDir, 'conflict');
  fs.writeFileSync(path.join(home.configDir, 'targets.json'), `${JSON.stringify({ version: 1, overrides: [{ key: 'pi', projectPath: '.pi/agent/skills' }], genericTargets: [] })}\n`);
  fs.mkdirSync(path.join(conflictProject, '.pi', 'agent', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(conflictProject, '.pi', 'skills'), { recursive: true });
  assert.throws(() => planHarnessOperation('pi', 'migrate', home, stale, conflictProject), /destination conflict/);
});

test('Pi failed writes preserve recovery evidence and retry from fresh inspection', () => {
  const { home, targets, piHome } = setup();
  const settings = path.join(piHome, 'agent', 'settings.json');
  const state = path.join(home.configDir, 'state.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark' }));

  const failed = planHarnessOperation('pi', 'setup', home, targets);
  const renameSync = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === settings) throw new Error('simulated settings rename failure');
    return renameSync(from, to);
  }) as typeof fs.renameSync;
  try {
    assert.throws(() => failed.apply(), (error: unknown) => {
      assert.match((error as Error).message, /simulated settings rename failure/);
      assert.equal((error as Error & { partialEffects?: string }).partialEffects, 'present');
      return true;
    });
  } finally {
    fs.renameSync = renameSync;
  }

  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { theme: 'dark' });
  assert.ok(JSON.parse(fs.readFileSync(state, 'utf8')).piIsolation);
  const recoveryDir = path.join(home.configDir, 'pi-recovery');
  const manifestPath = path.join(recoveryDir, fs.readdirSync(recoveryDir).find((entry) => entry.endsWith('.paths.json'))!);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.settings.backupHash, manifest.settings.originalHash);
  assert.equal(manifest.state.backupHash, manifest.state.originalHash);

  const retry = planHarnessOperation('pi', 'reconcile', home, targets);
  retry.apply();
  retry.verify();
  assert.equal(inspectHarnesses(home, targets).detected[0]?.isolation.status, 'managed');
});
