import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.join(import.meta.dirname, '../src/cli.ts');

function setup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-explain-'));
  const roots = {
    shared: path.join(configDir, 'shared', 'skills'),
    pi: path.join(configDir, 'pi', 'agent', 'skills'),
    claude: path.join(configDir, 'claude', 'skills'),
    grok: path.join(configDir, 'grok', 'skills'),
  };
  fs.writeFileSync(path.join(configDir, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: Object.entries(roots).map(([key, discoveryRoot]) => ({
      key,
      discoveryRoot,
      parkingRoot: path.join(path.dirname(discoveryRoot), '.skillspub-off', 'skills'),
    })),
    genericTargets: [],
  }));
  const resource = path.join(roots.shared, 'demo');
  fs.mkdirSync(resource, { recursive: true });
  fs.writeFileSync(path.join(resource, 'SKILL.md'), '# demo');
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: configDir, SKILLSPUB_CONFIG_DIR: configDir, ...env },
  });
  return { configDir, roots, resource: fs.realpathSync(resource), run };
}

function json(result: ReturnType<ReturnType<typeof setup>['run']>) {
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('explain resolves one installed resource for every built-in Harness without mutation', () => {
  const { configDir, roots, resource, run } = setup();
  fs.mkdirSync(path.dirname(roots.pi), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(roots.pi), 'settings.json'), JSON.stringify({
    skills: [`!${roots.shared}/**`],
  }));
  fs.mkdirSync(roots.pi, { recursive: true });
  fs.symlinkSync(resource, path.join(roots.pi, 'demo'));
  fs.mkdirSync(path.dirname(roots.claude), { recursive: true });
  const before = fs.readdirSync(configDir, { recursive: true }).sort();

  const result = run(['explain', `skill:${resource}`, '--json']);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const document = JSON.parse(result.stdout);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.ok, true);
  assert.equal(document.data.resource.realPath, resource);
  assert.equal(document.data.scope.kind, 'global');
  assert.deepEqual(document.data.harnesses.map((harness: { key: string }) => harness.key).sort(), [
    'claude',
    'grok',
    'pi',
  ]);
  assert.equal(document.data.harnesses.find((harness: { key: string }) => harness.key === 'pi')
    .effectiveVisibility, 'visible');
  assert.equal(document.data.harnesses.find((harness: { key: string }) => harness.key === 'claude')
    .effectiveVisibility, 'not-visible');
  assert.equal(document.data.harnesses.find((harness: { key: string }) => harness.key === 'grok')
    .effectiveVisibility, 'unknown');
  assert.deepEqual(fs.readdirSync(configDir, { recursive: true }).sort(), before);
});

test('explain rejects ambiguous names and reports consumed same-name Variants as conflicted', () => {
  const { roots, resource, run } = setup();
  const other = path.join(roots.claude, 'demo');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'SKILL.md'), '# other demo');
  fs.mkdirSync(path.dirname(roots.claude), { recursive: true });

  const ambiguous = run(['explain', 'demo', '--json']);
  assert.equal(ambiguous.status, 1);
  const error = json(ambiguous).error;
  assert.equal(error.code, 'ambiguous_selector');
  assert.equal(error.details.matches.length, 2);
  assert.ok(error.details.matches.every((match: { selector: string }) => match.selector.startsWith('skill:/')));

  const selected = run(['explain', `skill:${resource}`, '--harness', 'claude', '--json']);
  assert.equal(selected.status, 0, selected.stderr || selected.stdout);
  const claude = json(selected).data.harnesses[0];
  assert.equal(claude.effectiveVisibility, 'conflicted');
  assert.equal(claude.conflicts[0].realPath, fs.realpathSync(other));
});

test('project explain uses the canonical exact Project, applicable ancestors, and Global inheritance', () => {
  const { configDir, roots, resource, run } = setup();
  const parent = path.join(configDir, 'workspace');
  const project = path.join(parent, 'project');
  fs.mkdirSync(path.join(project, '.grok'), { recursive: true });
  const ancestorGrok = path.join(parent, '.grok', 'skills');
  fs.mkdirSync(ancestorGrok, { recursive: true });
  fs.symlinkSync(resource, path.join(ancestorGrok, 'demo'));

  const scoped = run(['project', project, 'explain', `skill:${resource}`, '--harness', 'grok', '--json']);
  assert.equal(scoped.status, 0, scoped.stderr || scoped.stdout);
  const document = json(scoped).data;
  assert.equal(document.scope.projectPath, fs.realpathSync(project));
  assert.equal(document.harnesses[0].effectiveVisibility, 'visible');
  assert.ok(document.harnesses[0].roots.some((root: { scope: string; path: string }) =>
    root.scope === 'parent' && root.path === fs.realpathSync(ancestorGrok)));

  const global = run(['explain', `skill:${resource}`, '--harness', 'grok', '--json']);
  assert.equal(global.status, 0, global.stderr || global.stdout);
  assert.equal(json(global).data.harnesses[0].effectiveVisibility, 'unknown');
  assert.equal(fs.existsSync(path.join(roots.grok, 'demo')), false);
});

test('managed wants return safe plans for Claude and Pi without applying them', () => {
  const { configDir, roots, resource, run } = setup();
  fs.mkdirSync(path.dirname(roots.claude), { recursive: true });
  const visible = run(['explain', `skill:${resource}`, '--harness', 'claude', '--want', 'visible', '--json']);
  assert.equal(visible.status, 0, visible.stderr || visible.stdout);
  const visibleData = json(visible).data;
  assert.equal(visibleData.wanted, 'visible');
  assert.deepEqual(visibleData.harnesses[0].plan, {
    executable: true,
    steps: [{
      operation: 'create-link',
      targetId: 'global:claude',
      targetKey: 'claude',
      slot: 'demo',
      from: 'missing',
      to: 'on',
      form: 'link',
      preconditions: [
        { code: 'resource_identity', message: `Resource must remain ${resource}.` },
        { code: 'target_slot_state', message: 'global:claude/demo must remain missing.' },
      ],
    }],
    blockers: [],
  });
  assert.equal(fs.existsSync(path.join(roots.claude, 'demo')), false);

  fs.mkdirSync(roots.pi, { recursive: true });
  fs.symlinkSync(resource, path.join(roots.pi, 'demo'));
  fs.mkdirSync(path.dirname(roots.pi), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(roots.pi), 'settings.json'), JSON.stringify({
    skills: [`!${roots.shared}/**`],
  }));
  const hidden = run(['explain', `skill:${resource}`, '--harness', 'pi', '--want', 'hidden', '--json']);
  assert.equal(hidden.status, 0, hidden.stderr || hidden.stdout);
  const plan = json(hidden).data.harnesses[0].plan;
  assert.equal(plan.executable, true);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.steps, [{
    operation: 'deactivate',
    targetId: 'global:pi',
    targetKey: 'pi',
    slot: 'demo',
    from: 'on',
    to: 'off',
    form: 'link',
    path: path.join(roots.pi, 'demo'),
    preconditions: [
      { code: 'resource_identity', message: `Resource must remain ${resource}.` },
      { code: 'target_slot_state', message: 'global:pi/demo must remain on.' },
      { code: 'preset_claims_absent', message: 'global:pi/demo must remain free of Preset claims.' },
    ],
  }]);
  assert.ok(fs.existsSync(path.join(roots.pi, 'demo')));
  assert.equal(fs.existsSync(path.join(configDir, 'state.json')), false);
});

test('managed Pi hidden wants remain blocked by Shared side effects or Preset claims', () => {
  const { configDir, roots, resource, run } = setup();
  fs.mkdirSync(path.dirname(roots.pi), { recursive: true });
  const shared = run(['explain', `skill:${resource}`, '--harness', 'pi', '--want', 'hidden', '--json']);
  assert.equal(shared.status, 0, shared.stderr || shared.stdout);
  const sharedPlan = json(shared).data.harnesses[0].plan;
  assert.equal(sharedPlan.executable, false);
  assert.deepEqual(sharedPlan.steps, []);
  assert.ok(sharedPlan.blockers.some((blocker: { code: string }) =>
    blocker.code === 'cross_harness_side_effect'));

  fs.mkdirSync(roots.pi, { recursive: true });
  fs.symlinkSync(resource, path.join(roots.pi, 'demo'));
  fs.mkdirSync(path.dirname(roots.pi), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(roots.pi), 'settings.json'), JSON.stringify({
    skills: [`!${roots.shared}/**`],
  }));
  fs.writeFileSync(path.join(configDir, 'state.json'), JSON.stringify({
    claims: { ['global:pi\0demo']: ['preset:work'] },
  }));
  const claimed = run(['explain', `skill:${resource}`, '--harness', 'pi', '--want', 'hidden', '--json']);
  assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);
  const claimedPlan = json(claimed).data.harnesses[0].plan;
  assert.equal(claimedPlan.executable, false);
  assert.ok(claimedPlan.blockers.some((blocker: { code: string }) =>
    blocker.code === 'active_preset_claim'));
  assert.ok(fs.existsSync(path.join(roots.pi, 'demo')));
});

test('exact Project Claude Relationships are scoped independently from Global Explain', () => {
  const { configDir, roots, resource, run } = setup();
  const project = path.join(configDir, 'project');
  const projectClaude = path.join(project, '.claude', 'skills');
  fs.mkdirSync(projectClaude, { recursive: true });
  fs.symlinkSync(resource, path.join(projectClaude, 'demo'));

  const scoped = run(['project', project, 'explain', `skill:${resource}`, '--harness', 'claude', '--json']);
  assert.equal(scoped.status, 0, scoped.stderr || scoped.stdout);
  assert.equal(json(scoped).data.harnesses[0].effectiveVisibility, 'visible');

  fs.mkdirSync(path.dirname(roots.claude), { recursive: true });
  const global = run(['explain', `skill:${resource}`, '--harness', 'claude', '--json']);
  assert.equal(global.status, 0, global.stderr || global.stdout);
  assert.equal(json(global).data.harnesses[0].effectiveVisibility, 'not-visible');
});

test('per-root Pi evidence distinguishes excluded Global Shared from consumed Project Shared', () => {
  const { configDir, roots, resource, run } = setup();
  const project = path.join(configDir, 'project');
  fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
  fs.mkdirSync(path.dirname(roots.pi), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(roots.pi), 'settings.json'), JSON.stringify({
    defaultProjectTrust: 'always',
    skills: [`!${roots.shared}/**`],
  }));

  const result = run(['project', project, 'explain', `skill:${resource}`, '--harness', 'pi', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const pi = json(result).data.harnesses[0];
  assert.equal(pi.effectiveVisibility, 'not-visible');
  assert.ok(pi.roots.some((root: { scope: string; kind: string; consumption: string }) =>
    root.scope === 'global' && root.kind === 'shared' && root.consumption === 'excluded'));
  assert.ok(pi.roots.some((root: { scope: string; kind: string; consumption: string }) =>
    root.scope === 'project' && root.kind === 'shared' && root.consumption === 'consumed'));
});

test('unknown Harness configuration stays successful unknown data with a blocker', () => {
  const { roots, resource, run } = setup();
  fs.mkdirSync(path.dirname(roots.pi), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(roots.pi), 'settings.json'), '{');

  const result = run(['explain', `skill:${resource}`, '--harness', 'pi', '--want', 'visible', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const pi = json(result).data.harnesses[0];
  assert.equal(pi.effectiveVisibility, 'unknown');
  assert.ok(pi.roots.every((root: { consumption: string }) => root.consumption === 'unknown'));
  assert.ok(pi.plan.blockers.some((blocker: { code: string }) => blocker.code === 'visibility_unknown'));
  assert.ok(pi.warnings.some((warning: { code: string }) => warning.code === 'local_version_unknown'));
});

test('managed Pi blocks hidden plans before guessing from malformed Preset state', () => {
  const { configDir, roots, resource, run } = setup();
  fs.mkdirSync(roots.pi, { recursive: true });
  fs.symlinkSync(resource, path.join(roots.pi, 'demo'));
  fs.writeFileSync(path.join(path.dirname(roots.pi), 'settings.json'), JSON.stringify({
    skills: [`!${roots.shared}/**`],
  }));
  fs.writeFileSync(path.join(configDir, 'state.json'), JSON.stringify({ claims: [] }));

  const result = run(['explain', `skill:${resource}`, '--harness', 'pi', '--want', 'hidden', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const plan = json(result).data.harnesses[0].plan;
  assert.equal(plan.executable, false);
  assert.ok(plan.blockers.some((blocker: { code: string }) => blocker.code === 'unknown_preset_claims'));
  assert.ok(fs.existsSync(path.join(roots.pi, 'demo')));
});

test('unreadable compatibility roots make Grok visibility unknown', () => {
  const { configDir, roots, resource, run } = setup();
  fs.mkdirSync(path.dirname(roots.grok), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(roots.grok), 'config.toml'), [
    '[skills]',
    `ignore = ["${roots.shared}"]`,
    '[compat.claude]',
    'skills = false',
    '[compat.cursor]',
    'skills = true',
    '',
  ].join('\n'));
  const cursor = path.join(configDir, '.cursor', 'skills');
  fs.mkdirSync(cursor, { recursive: true });
  fs.symlinkSync(path.join(cursor, 'demo'), path.join(cursor, 'demo'));

  const result = run(['explain', `skill:${resource}`, '--harness', 'grok', '--want', 'visible', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const grok = json(result).data.harnesses[0];
  assert.equal(grok.effectiveVisibility, 'unknown');
  assert.ok(grok.roots.some((root: { targetKey: string; consumption: string }) =>
    root.targetKey === 'cursor' && root.consumption === 'unknown'));
});

test('an older registry drives Grok visibility, Mirror, and parking plans without writes', () => {
  const { configDir, roots, resource, run } = setup();
  const grokHome = path.dirname(roots.grok);
  const targetFile = path.join(configDir, 'targets.json');
  const registry = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  registry.overrides = registry.overrides.filter(({ key }: { key: string }) => key !== 'grok');
  fs.writeFileSync(targetFile, JSON.stringify(registry));
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(path.join(grokHome, 'config.toml'), [
    '[skills]',
    `ignore = ["${roots.shared}"]`,
    '[compat.claude]',
    'skills = false',
    '[compat.cursor]',
    'skills = false',
    '',
  ].join('\n'));
  const parked = path.join(roots.grok, 'parked');
  fs.mkdirSync(parked, { recursive: true });
  fs.writeFileSync(path.join(parked, 'SKILL.md'), '# parked');
  const env = { GROK_HOME: grokHome };
  const before = fs.readdirSync(configDir, { recursive: true }).sort();
  const targetBefore = fs.readFileSync(targetFile, 'utf8');

  const result = run(
    ['explain', `skill:${resource}`, '--harness', 'grok', '--want', 'visible', '--json'],
    env,
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const grok = json(result).data.harnesses[0];
  assert.equal(grok.effectiveVisibility, 'not-visible');
  assert.equal(grok.plan.executable, true);
  assert.equal(grok.plan.steps[0].operation, 'create-mirror');
  assert.equal(grok.plan.steps[0].form, 'mirror');

  const off = run(['off', `skill:${fs.realpathSync(parked)}`, 'grok', '--json'], env);
  assert.equal(off.status, 0, off.stderr || off.stdout);
  assert.equal(
    json(off).data.plan.targets[0].destination,
    path.join(grokHome, '.skillspub-off', 'skills', 'parked'),
  );
  assert.equal(fs.readFileSync(targetFile, 'utf8'), targetBefore);
  assert.deepEqual(fs.readdirSync(configDir, { recursive: true }).sort(), before);
});

test('Explain performs no network calls or local writes', () => {
  const { configDir, resource, run } = setup();
  const blocker = path.join(configDir, 'block-network.cjs');
  fs.writeFileSync(blocker, [
    "const fail = () => { throw new Error('network disabled'); };",
    "require('node:http').request = fail;",
    "require('node:https').request = fail;",
    "require('node:net').connect = fail;",
  ].join('\n'));
  const before = fs.readdirSync(configDir, { recursive: true }).sort();

  const result = run(['explain', `skill:${resource}`, '--json'], {
    NODE_OPTIONS: `--require=${blocker}`,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(json(result).ok, true);
  assert.deepEqual(fs.readdirSync(configDir, { recursive: true }).sort(), before);
});

test('explain validates selectors and options through the JSON error contract', () => {
  const { run } = setup();
  for (const [args, status, code] of [
    [['explain', 'catalog-only'], 1, 'installed_resource_not_found'],
    [['explain', 'demo', '--want', 'maybe'], 2, 'usage_error'],
    [['explain', 'demo', '--harness', 'other'], 2, 'unknown_harness'],
  ] as const) {
    const result = run([...args, '--json']);
    assert.equal(result.status, status, result.stderr || result.stdout);
    assert.equal(json(result).error.code, code);
  }
});

test('a consumed Shared Relationship bypasses a Harness-specific OFF Relationship', () => {
  const { roots, resource, run } = setup();
  const piParking = path.join(path.dirname(roots.pi), '.skillspub-off', 'skills');
  fs.mkdirSync(piParking, { recursive: true });
  fs.symlinkSync(resource, path.join(piParking, 'demo'));
  fs.mkdirSync(path.dirname(roots.pi), { recursive: true });

  const result = run(['explain', `skill:${resource}`, '--harness', 'pi', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const pi = json(result).data.harnesses[0];
  assert.equal(pi.effectiveVisibility, 'visible');
  assert.ok(pi.roots.some((root: { kind: string; consumption: string; relationships: Array<{ selected: boolean; activation: string }> }) =>
    root.kind === 'shared' && root.consumption === 'consumed' &&
    root.relationships.some((relationship) => relationship.selected && relationship.activation === 'on')));
  assert.ok(pi.roots.some((root: { kind: string; relationships: Array<{ selected: boolean; activation: string }> }) =>
    root.kind === 'harness' &&
    root.relationships.some((relationship) => relationship.selected && relationship.activation === 'off')));
});
