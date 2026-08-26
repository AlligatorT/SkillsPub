import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { shouldRunTui } from '../src/cli.ts';

const CLI = path.join(import.meta.dirname, '../src/cli.ts');

function runProcess(args: string[]) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-'));
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
}

function setup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-'));
  const skills = path.join(configDir, 'skills');
  fs.mkdirSync(path.join(skills, 'grilling'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'grilling', 'SKILL.md'), '# grilling');
  fs.writeFileSync(path.join(configDir, 'agents.conf'), `a = ${skills}\n`);
  const run = (args: string[]) =>
    execFileSync('node', [CLI, ...args], {
      env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
      encoding: 'utf8',
    });
  return { run, skills, configDir };
}

test('ls prints matrix, off moves skill, status shows per-agent state', () => {
  const { run, skills, configDir } = setup();
  assert.match(run(['ls']), /grilling\s+on/);

  assert.match(run(['off', 'grilling', 'a']), /global:a\/grilling\ton -> off/);
  assert.ok(fs.existsSync(path.join(configDir, '.skillspub-off', 'skills', 'grilling', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(skills, 'grilling')), false);

  assert.match(run(['status', 'grilling']), /a\s+off/);

  assert.match(run(['on', 'grilling', 'a']), /global:a\/grilling\toff -> on/);
  assert.ok(fs.existsSync(path.join(skills, 'grilling', 'SKILL.md')));
});

test('ls --json returns one versioned document and no stderr', () => {
  const { configDir } = setup();
  const result = spawnSync('node', [CLI, 'ls', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    ok: true,
    data: {
      targets: ['a'],
      rows: [{
        name: 'grilling',
        resourceId: fs.realpathSync(path.join(configDir, 'skills', 'grilling')),
        relationships: [{ target: 'a', slot: 'grilling', presence: 'on', form: 'local' }],
      }],
      deadlinks: [],
      untagged: ['grilling'],
      warnings: [],
    },
  });
});

test('JSON activation previews without changes and applies the same plan with --yes', () => {
  const { configDir, skills } = setup();
  const run = (args: string[]) => spawnSync('node', [CLI, ...args, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });

  const preview = run(['off', 'grilling', 'a']);
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  assert.equal(preview.stderr, '');
  const previewDocument = JSON.parse(preview.stdout);
  assert.equal(previewDocument.schemaVersion, 1);
  assert.equal(previewDocument.ok, true);
  assert.equal(previewDocument.data.applied, false);
  assert.equal(previewDocument.data.plan.operation, 'activation');
  assert.deepEqual(previewDocument.data.plan.targets.map((target: { targetId: string; slot: string; from: string; to: string }) => ({
    targetId: target.targetId,
    slot: target.slot,
    from: target.from,
    to: target.to,
  })), [{ targetId: 'global:a', slot: 'grilling', from: 'on', to: 'off' }]);
  assert.ok(fs.existsSync(path.join(skills, 'grilling', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(configDir, 'state.json')), false);

  const applied = run(['off', 'grilling', 'a', '--yes']);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(applied.stderr, '');
  const appliedDocument = JSON.parse(applied.stdout);
  assert.equal(appliedDocument.data.applied, true);
  assert.deepEqual(appliedDocument.data.plan, previewDocument.data.plan);
  assert.deepEqual(appliedDocument.data.remainingDrift, []);
  assert.ok(fs.existsSync(path.join(configDir, '.skillspub-off', 'skills', 'grilling', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(skills, 'grilling')), false);
});

test('JSON Link/Mirror plans stay dry until --yes and verify remaining Drift', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-json-mirror-'));
  const sharedRoot = path.join(configDir, 'shared', 'skills');
  const grokRoot = path.join(configDir, 'grok', 'skills');
  const source = path.join(sharedRoot, 'example');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# example\n');
  fs.writeFileSync(path.join(configDir, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [
      { key: 'shared', discoveryRoot: sharedRoot, parkingRoot: path.join(configDir, 'shared', 'off') },
      { key: 'grok', discoveryRoot: grokRoot, parkingRoot: path.join(configDir, 'grok', 'off') },
      { key: 'pi', disabled: true },
      { key: 'claude', disabled: true },
    ],
    genericTargets: [],
  }));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
  const sourceId = fs.realpathSync(source);

  const linkPreview = run(['on', `skill:${sourceId}`, 'grok']);
  assert.equal(linkPreview.status, 0, linkPreview.stderr || linkPreview.stdout);
  const linkPreviewDocument = JSON.parse(linkPreview.stdout);
  assert.equal(linkPreviewDocument.data.applied, false);
  assert.equal(linkPreviewDocument.data.plan.targets[0].createForm, 'mirror');
  assert.equal(fs.existsSync(path.join(grokRoot, 'example')), false);

  const linkApplied = run(['on', `skill:${sourceId}`, 'grok', '--yes']);
  assert.equal(linkApplied.status, 0, linkApplied.stderr || linkApplied.stdout);
  assert.deepEqual(JSON.parse(linkApplied.stdout).data.plan, linkPreviewDocument.data.plan);
  const mirrorFile = path.join(grokRoot, 'example', 'SKILL.md');
  assert.equal(fs.readFileSync(mirrorFile, 'utf8'), '# example\n');

  fs.appendFileSync(path.join(source, 'SKILL.md'), 'changed\n');
  const syncPreview = run(['mirror', 'sync', 'global:grok', 'example']);
  assert.equal(syncPreview.status, 0, syncPreview.stderr || syncPreview.stdout);
  const syncPreviewDocument = JSON.parse(syncPreview.stdout);
  assert.equal(syncPreviewDocument.data.applied, false);
  assert.equal(fs.readFileSync(mirrorFile, 'utf8'), '# example\n');

  const syncApplied = run(['mirror', 'sync', 'global:grok', 'example', '--yes']);
  assert.equal(syncApplied.status, 0, syncApplied.stderr || syncApplied.stdout);
  const syncAppliedDocument = JSON.parse(syncApplied.stdout);
  assert.deepEqual(syncAppliedDocument.data.plan, syncPreviewDocument.data.plan);
  assert.deepEqual(syncAppliedDocument.data.remainingDrift, []);
  assert.equal(fs.readFileSync(mirrorFile, 'utf8'), '# example\nchanged\n');
});

test('JSON catalog mutations preview without state writes and apply the same plan', () => {
  const { configDir, skills } = setup();
  const resource = fs.realpathSync(path.join(skills, 'grilling'));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });

  const preview = run(['bundle', 'create', 'tools', `skill:${resource}`]);
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  assert.equal(preview.stderr, '');
  const previewDocument = JSON.parse(preview.stdout);
  assert.equal(previewDocument.data.applied, false);
  assert.equal(previewDocument.data.plan.operation, 'bundle.create');
  assert.equal(fs.existsSync(path.join(configDir, 'state.json')), false);

  const applied = run(['bundle', 'create', 'tools', `skill:${resource}`, '--yes']);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(applied.stderr, '');
  const appliedDocument = JSON.parse(applied.stdout);
  assert.equal(appliedDocument.data.applied, true);
  assert.deepEqual(appliedDocument.data.plan, previewDocument.data.plan);
  assert.deepEqual(appliedDocument.data.remainingDrift, []);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8')).bundles.tools,
    [resource],
  );

  for (const args of [
    ['tag', 'add', `skill:${resource}`, 'backend'],
    ['preset', 'create', 'work', `skill:${resource}`],
  ]) {
    const before = fs.readFileSync(path.join(configDir, 'state.json'), 'utf8');
    const nextPreview = run(args);
    assert.equal(nextPreview.status, 0, nextPreview.stderr || nextPreview.stdout);
    const nextPreviewDocument = JSON.parse(nextPreview.stdout);
    assert.equal(nextPreviewDocument.data.applied, false);
    assert.equal(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'), before);

    const nextApplied = run([...args, '--yes']);
    assert.equal(nextApplied.status, 0, nextApplied.stderr || nextApplied.stdout);
    const nextAppliedDocument = JSON.parse(nextApplied.stdout);
    assert.equal(nextAppliedDocument.data.applied, true);
    assert.deepEqual(nextAppliedDocument.data.plan, nextPreviewDocument.data.plan);
  }
  let state = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.tags[resource], ['backend']);
  assert.deepEqual(state.presets.work.selectors, [`skill:${resource}`]);

  for (const args of [
    ['bundle', 'add', 'tools', `skill:${resource}`],
    ['bundle', 'rm', 'tools', `skill:${resource}`],
    ['tag', 'rm', `skill:${resource}`, 'backend'],
    ['preset', 'add', 'work', `skill:${resource}`],
    ['preset', 'rm', 'work', `skill:${resource}`],
    ['preset', 'delete', 'work'],
  ]) {
    const before = fs.readFileSync(path.join(configDir, 'state.json'), 'utf8');
    const nextPreview = run(args);
    assert.equal(nextPreview.status, 0, nextPreview.stderr || nextPreview.stdout);
    const nextPreviewDocument = JSON.parse(nextPreview.stdout);
    assert.equal(nextPreviewDocument.data.applied, false);
    assert.equal(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'), before);
    const nextApplied = run([...args, '--yes']);
    assert.equal(nextApplied.status, 0, nextApplied.stderr || nextApplied.stdout);
    const nextAppliedDocument = JSON.parse(nextApplied.stdout);
    assert.equal(nextAppliedDocument.data.applied, true);
    assert.deepEqual(nextAppliedDocument.data.plan, nextPreviewDocument.data.plan);
  }
  state = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.bundles.tools, []);
  assert.equal(state.tags[resource], undefined);
  assert.equal(state.presets.work, undefined);
});

test('read-only inventory commands return only successful JSON envelopes', () => {
  const { configDir } = setup();
  const project = path.join(configDir, 'project');
  fs.mkdirSync(project);
  const commands = [
    ['status', 'grilling'],
    ['targets'],
    ['scan'],
    ['doctor'],
    ['harnesses'],
    ['bundle', 'ls'],
    ['tag', 'ls'],
    ['preset', 'ls'],
    ['project', project, 'scan'],
    ['project', project, 'doctor'],
    ['project', project, 'harnesses'],
    ['project', project, 'preset', 'ls'],
  ];

  for (const args of commands) {
    const result = spawnSync('node', [CLI, ...args, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
    });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.stdout}`);
    assert.equal(result.stderr, '', args.join(' '));
    assert.equal(result.stdout.trim().split('\n').length, 1, args.join(' '));
    const document = JSON.parse(result.stdout);
    assert.equal(document.schemaVersion, 1, args.join(' '));
    assert.equal(document.ok, true, args.join(' '));
    assert.notEqual(document.data, undefined, args.join(' '));
  }
});

test('read-only catalog and Harness detail commands return JSON data', () => {
  const { configDir } = setup();
  const project = path.join(configDir, 'project');
  fs.mkdirSync(project);
  const resource = fs.realpathSync(path.join(configDir, 'skills', 'grilling'));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
  for (const args of [
    ['bundle', 'create', 'tools', `skill:${resource}`],
    ['tag', 'add', `skill:${resource}`, 'backend'],
    ['preset', 'create', 'work', `skill:${resource}`],
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  }

  const commands = [
    ['bundle', 'show', 'tools'],
    ['tag', 'ls', '--skill', `skill:${resource}`],
    ['preset', 'show', 'work'],
    ['harnesses', 'pi', 'inspect'],
    ['project', project, 'harnesses', 'pi', 'inspect'],
    ['project', project, 'preset', 'show', 'work'],
  ];
  for (const args of commands) {
    const result = run([...args, '--json']);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.stdout}`);
    assert.equal(result.stderr, '', args.join(' '));
    const document = JSON.parse(result.stdout);
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.ok, true);
    assert.ok(document.data);
  }
});

test('JSON findings and warnings remain successful data', () => {
  const { configDir } = setup();
  fs.symlinkSync('/missing/skill', path.join(configDir, 'skills', 'broken'));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });

  const scan = run(['scan']);
  assert.equal(scan.status, 0, scan.stderr);
  assert.equal(scan.stderr, '');
  const scanDocument = JSON.parse(scan.stdout);
  assert.equal(scanDocument.ok, true);
  assert.ok(scanDocument.data.inventory.findings.some(
    (finding: { category: string }) => finding.category === 'structural',
  ));

  const legacy = run(['ls', '--agent', 'a']);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(legacy.stderr, '');
  assert.deepEqual(JSON.parse(legacy.stdout).data.warnings, [
    '--agent is deprecated; use --target',
  ]);
});

test('JSON mode separates usage, domain, and runtime failures', () => {
  const { configDir } = setup();
  const other = path.join(configDir, 'other');
  fs.mkdirSync(path.join(other, 'grilling'), { recursive: true });
  fs.writeFileSync(path.join(other, 'grilling', 'SKILL.md'), '# other');
  fs.writeFileSync(
    path.join(configDir, 'agents.conf'),
    `a = ${path.join(configDir, 'skills')}\nb = ${other}\n`,
  );
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
  const assertError = (args: string[], status: number, code: string) => {
    const result = run([...args, '--json']);
    assert.equal(result.status, status, `${args.join(' ')}: ${result.stderr || result.stdout}`);
    assert.equal(result.stderr, '', args.join(' '));
    assert.equal(result.stdout.trim().split('\n').length, 1, args.join(' '));
    const document = JSON.parse(result.stdout);
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.ok, false);
    assert.equal(document.error.code, code);
    assert.equal(typeof document.error.message, 'string');
    return document.error;
  };

  const ambiguous = assertError(['status', 'grilling'], 1, 'ambiguous_selector');
  assert.equal(ambiguous.details.matches.length, 2);
  const selected = run(['status', ambiguous.details.matches[0].selector, '--json']);
  assert.equal(selected.status, 0, selected.stderr || selected.stdout);
  assert.equal(JSON.parse(selected.stdout).data.resourceId, ambiguous.details.matches[0].location);
  assertError(['status'], 2, 'usage_error');
  assertError(['status', 'grilling', 'extra'], 2, 'usage_error');
  assertError(['ls', '--bogus'], 2, 'usage_error');
  assertError(['shared', 'describe', '-x'], 2, 'usage_error');
  assertError(['bogus'], 2, 'usage_error');
  assertError([], 2, 'usage_error');
  assertError(['tui'], 2, 'usage_error');
  assertError(['off', 'grilling', 'a'], 1, 'ambiguous_selector');

  fs.writeFileSync(path.join(configDir, 'targets.json'), '{');
  assertError(['targets'], 1, 'runtime_error');
});

test('ls uses --target and preserves --agent as a deprecated alias', () => {
  const { configDir } = setup();
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });

  const target = run(['ls', '--target', 'a']);
  const legacy = run(['ls', '--agent', 'a']);
  assert.equal(target.status, 0, target.stderr);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(legacy.stdout, target.stdout);
  assert.match(legacy.stderr, /--agent is deprecated; use --target/);
});

test('variants are listed distinctly and ambiguous mutations fail', () => {
  const {run, configDir} = setup();
  const other = path.join(configDir, 'other');
  fs.mkdirSync(path.join(other, 'grilling'), {recursive: true});
  fs.writeFileSync(path.join(other, 'grilling', 'SKILL.md'), '# other');
  fs.writeFileSync(
    path.join(configDir, 'agents.conf'),
    `a = ${path.join(configDir, 'skills')}\nb = ${other}\n`,
  );

  const listing = run(['ls']);
  assert.equal(
    listing.split('\n').filter((line) => line.startsWith('grilling (')).length,
    2,
  );
  assert.throws(
    () => run(['status', 'grilling']),
    (error: unknown) => {
      const stderr = String((error as {stderr?: string}).stderr);
      return /ambiguous/.test(stderr) && /Use skillspub tui/.test(stderr);
    },
  );
  assert.throws(
    () => run(['off', 'grilling', 'a']),
    (error: unknown) => {
      const stderr = String((error as {stderr?: string}).stderr);
      return /ambiguous/.test(stderr) && /Use skillspub tui/.test(stderr);
    },
  );
});

test('entry point routes bare TTY and explicit tui to the TUI', () => {
  assert.equal(shouldRunTui(undefined, true, true), true);
  assert.equal(shouldRunTui(undefined, true, false), false);
  assert.equal(shouldRunTui(undefined, false, true), false);
  assert.equal(shouldRunTui('tui', false, false), true);
});

test('bare non-TTY invocation prints canonical usage without terminal control output', () => {
  const result = runProcess([]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^SkillsPub/);
  assert.match(result.stderr, /skillspub tui/);
  assert.doesNotMatch(result.stderr, /\x1b/);
});

test('installed executable symlink runs the entry point', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-bin-'));
  const executable = path.join(dir, 'skillspub');
  fs.symlinkSync(CLI, executable);
  const result = spawnSync(executable, {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: path.join(dir, 'config') },
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /^SkillsPub/);
});

test('explicit tui rejects non-TTY and unexpected arguments clearly', () => {
  const nonTty = runProcess(['tui']);
  assert.equal(nonTty.status, 1);
  assert.match(
    nonTty.stderr,
    /skillspub: skillspub tui requires an interactive terminal/,
  );
  assert.doesNotMatch(nonTty.stderr, /\x1b/);

  const extra = runProcess(['tui', 'extra']);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /skillspub: usage: skillspub tui/);
});

test('renamed diagnostics use only the canonical identity', () => {
  const result = runProcess(['on']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /skillspub: usage: skillspub on/);
  assert.doesNotMatch(result.stderr, /\bskm\b/);
});

test('unknown command prints usage and exits 2', () => {
  const result = runProcess(['bogus']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^SkillsPub/);
});

test('scan reports live findings without persisting read-only state', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-scan-'));
  const discoveryRoot = path.join(configDir, 'shared', 'skills');
  const parkingRoot = path.join(configDir, 'shared', '.skillspub-off', 'skills');
  fs.mkdirSync(path.join(discoveryRoot, 'example'), { recursive: true });
  fs.writeFileSync(path.join(discoveryRoot, 'example', 'SKILL.md'), '# example');
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1,
    runtimes: [{
      key: 'shared',
      kind: 'shared',
      discoveryRoot,
      parkingRoot,
      projectPath: '.agents/skills',
    }],
  }));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });

  const first = run(['scan']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Structural anomalies:\n {2}none/);
  assert.match(first.stdout, /Uncategorized metadata:\n {2}- untagged resource:/);
  assert.match(first.stdout, /External changes:\n {2}- new resource:/);

  const second = run(['scan']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /External changes:\n {2}- new resource:/);
  assert.equal(fs.existsSync(path.join(configDir, 'state.json')), false);
});

test('target migration previews, confirms, and backs up the legacy Runtime registry', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-targets-'));
  const piRoot = path.join(configDir, 'pi', 'skills');
  const genericRoot = path.join(configDir, 'other', 'skills');
  const legacyFile = path.join(configDir, 'runtimes.json');
  const legacy = JSON.stringify({
    version: 1,
    runtimes: [
      {
        key: 'pi',
        kind: 'agent',
        discoveryRoot: piRoot,
        parkingRoot: path.join(configDir, 'pi', '.skillspub-off', 'skills'),
        projectPath: '.pi/agent/skills',
      },
      {
        key: 'other',
        kind: 'agent',
        discoveryRoot: genericRoot,
        parkingRoot: path.join(configDir, 'other', '.skillspub-off', 'skills'),
        projectPath: '.other/skills',
      },
    ],
  }, null, 2) + '\n';
  fs.writeFileSync(legacyFile, legacy);
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });

  const preview = run(['migrate', 'targets']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Target migration plan:/);
  assert.match(preview.stdout, /override\tpi/);
  assert.match(preview.stdout, /disabled\tclaude/);
  assert.match(preview.stdout, /disabled\tshared/);
  assert.match(preview.stdout, /generic\tother/);
  assert.equal(fs.existsSync(path.join(configDir, 'targets.json')), false);
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), legacy);

  const migrated = run(['migrate', 'targets', '--yes']);
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.match(migrated.stdout, /Migrated Target registry:/);
  assert.equal(fs.existsSync(legacyFile), false);
  assert.equal(
    fs.readFileSync(path.join(configDir, 'runtimes.json.v1.bak'), 'utf8'),
    legacy,
  );
  assert.match(run(['targets']).stdout, /pi\tharness/);
  assert.match(run(['targets']).stdout, /other\tgeneric/);
  assert.match(run(['migrate', 'targets', '--yes']).stdout, /already migrated/);
});

test('legacy migration previews and adds built-in Targets introduced after runtimes.json', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-legacy-built-ins-'));
  const userHome = path.join(configDir, 'home');
  const grokHome = path.join(userHome, '.grok');
  const legacyFile = path.join(configDir, 'runtimes.json');
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(path.join(grokHome, 'config.toml'), '# detected\n');
  fs.writeFileSync(legacyFile, JSON.stringify({
    version: 1,
    runtimes: ['claude', 'shared', 'pi'].map((key) => ({
      key,
      kind: key === 'shared' ? 'shared' : 'agent',
      discoveryRoot: path.join(userHome, `.${key}`, 'skills'),
      parkingRoot: path.join(userHome, `.${key}`, '.skillspub-off', 'skills'),
      projectPath: `.${key}/skills`,
    })),
  }, null, 2) + '\n');
  const before = fs.readFileSync(legacyFile, 'utf8');
  const run = (args: string[]) => spawnSync('node', [CLI, ...args, '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: userHome,
      GROK_HOME: grokHome,
      SKILLSPUB_CONFIG_DIR: configDir,
    },
  });

  const beforeTargets = run(['targets']);
  assert.equal(beforeTargets.status, 0, beforeTargets.stderr || beforeTargets.stdout);
  assert.deepEqual(JSON.parse(beforeTargets.stdout).data.map(({ key }: { key: string }) => key), [
    'claude', 'shared', 'pi',
  ]);

  const preview = run(['migrate', 'targets']);
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  const previewData = JSON.parse(preview.stdout).data;
  assert.equal(previewData.applied, false);
  assert.deepEqual(previewData.plan.introducedDefinitions, [{
    key: 'grok',
    kind: 'harness',
    discoveryRoot: path.join(grokHome, 'skills'),
    parkingRoot: path.join(grokHome, '.skillspub-off', 'skills'),
    projectPath: '.grok/skills',
    relationship: { support: 'managed', link: 'unsupported' },
  }]);
  assert.equal(previewData.plan.overrides.some(({ key, disabled }: { key: string; disabled?: true }) =>
    key === 'grok' && disabled), false);
  assert.equal(fs.existsSync(path.join(configDir, 'targets.json')), false);
  assert.equal(fs.existsSync(`${legacyFile}.v1.bak`), false);
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), before);

  const applied = run(['migrate', 'targets', '--yes']);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  const appliedData = JSON.parse(applied.stdout).data;
  assert.deepEqual(appliedData.plan, previewData.plan);
  assert.deepEqual(appliedData.result.targets.map(({ key }: { key: string }) => key), [
    'claude', 'shared', 'grok', 'pi',
  ]);
  const registry = JSON.parse(fs.readFileSync(path.join(configDir, 'targets.json'), 'utf8'));
  assert.equal(registry.overrides.some(({ key }: { key: string }) => key === 'grok'), false);
  assert.equal(fs.readFileSync(`${legacyFile}.v1.bak`, 'utf8'), before);
});

test('JSON migration and repair preview safely and apply the same plan with --yes', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-json-maintenance-'));
  const discoveryRoot = path.join(configDir, 'shared', 'skills');
  const parkingRoot = path.join(configDir, 'shared', 'off');
  const legacyFile = path.join(configDir, 'runtimes.json');
  fs.mkdirSync(discoveryRoot, { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify({
    version: 1,
    runtimes: [{
      key: 'shared',
      kind: 'shared',
      discoveryRoot,
      parkingRoot,
      projectPath: '.agents/skills',
    }],
  }));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });

  const migrationPreview = run(['migrate', 'targets']);
  assert.equal(migrationPreview.status, 0, migrationPreview.stderr || migrationPreview.stdout);
  const migrationPreviewDocument = JSON.parse(migrationPreview.stdout);
  assert.equal(migrationPreviewDocument.data.applied, false);
  assert.equal(fs.existsSync(path.join(configDir, 'targets.json')), false);
  assert.ok(fs.existsSync(legacyFile));

  const migrationApplied = run(['migrate', 'targets', '--yes']);
  assert.equal(migrationApplied.status, 0, migrationApplied.stderr || migrationApplied.stdout);
  const migrationAppliedDocument = JSON.parse(migrationApplied.stdout);
  assert.equal(migrationAppliedDocument.data.applied, true);
  assert.deepEqual(migrationAppliedDocument.data.plan, migrationPreviewDocument.data.plan);
  assert.equal(fs.existsSync(legacyFile), false);

  const broken = path.join(discoveryRoot, 'broken');
  fs.symlinkSync('/missing/skill', broken);
  const repairPreview = run(['doctor', '--repair']);
  assert.equal(repairPreview.status, 0, repairPreview.stderr || repairPreview.stdout);
  const repairPreviewDocument = JSON.parse(repairPreview.stdout);
  assert.equal(repairPreviewDocument.data.applied, false);
  assert.equal(fs.lstatSync(broken).isSymbolicLink(), true);

  const repairApplied = run(['doctor', '--repair', '--yes']);
  assert.equal(repairApplied.status, 0, repairApplied.stderr || repairApplied.stdout);
  const repairAppliedDocument = JSON.parse(repairApplied.stdout);
  assert.equal(repairAppliedDocument.data.applied, true);
  assert.deepEqual(repairAppliedDocument.data.plan, repairPreviewDocument.data.plan);
  assert.throws(() => fs.lstatSync(broken), /ENOENT/);
});

test('read-only CLI surfaces merge a detected built-in missing from an older Target registry', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-forward-targets-'));
  const userHome = path.join(configDir, 'home');
  const grokHome = path.join(userHome, '.grok');
  const targetFile = path.join(configDir, 'targets.json');
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(path.join(grokHome, 'config.toml'), '# detected\n');
  fs.writeFileSync(targetFile, JSON.stringify({
    version: 1,
    overrides: ['claude', 'shared', 'pi'].map((key) => ({
      key,
      discoveryRoot: path.join(userHome, `.${key}`, 'skills'),
      parkingRoot: path.join(userHome, `.${key}`, '.skillspub-off', 'skills'),
      projectPath: `.${key}/skills`,
    })),
    genericTargets: [{
      key: 'custom',
      kind: 'generic',
      discoveryRoot: path.join(userHome, '.custom', 'skills'),
      parkingRoot: path.join(userHome, '.custom', '.skillspub-off', 'skills'),
      projectPath: '.custom/skills',
    }],
  }, null, 2) + '\n');
  const before = fs.readFileSync(targetFile, 'utf8');
  const beforeEntries = fs.readdirSync(configDir, { recursive: true }).sort();
  const run = (command: string) => {
    const result = spawnSync('node', [CLI, command, '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: userHome,
        GROK_HOME: grokHome,
        SKILLSPUB_CONFIG_DIR: configDir,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout).data;
  };

  assert.deepEqual(run('targets').map(({ key }: { key: string }) => key), [
    'claude', 'shared', 'grok', 'pi', 'custom',
  ]);
  assert.ok(run('scan').inventory.targets.some(({ key }: { key: string }) => key === 'grok'));
  assert.ok(run('harnesses').detected.some(({ key }: { key: string }) => key === 'grok'));
  assert.equal(fs.readFileSync(targetFile, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(configDir, { recursive: true }).sort(), beforeEntries);
});

test('read-only Target commands do not migrate a legacy registry', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-read-only-targets-'));
  const discoveryRoot = path.join(configDir, 'shared', 'skills');
  const legacyFile = path.join(configDir, 'runtimes.json');
  fs.writeFileSync(legacyFile, JSON.stringify({
    version: 1,
    runtimes: [{
      key: 'shared',
      kind: 'shared',
      discoveryRoot,
      parkingRoot: path.join(configDir, 'shared', '.skillspub-off', 'skills'),
      projectPath: '.agents/skills',
    }],
  }));
  const before = fs.readFileSync(legacyFile, 'utf8');
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });

  for (const args of [['ls'], ['scan'], ['targets'], ['migrate', 'targets']]) {
    const result = run(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  }
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(configDir, 'targets.json')), false);
  assert.equal(fs.existsSync(path.join(configDir, 'runtimes.json.v1.bak')), false);
  assert.equal(fs.existsSync(path.join(configDir, 'state.json')), false);
});

test('harnesses reports detected Pi support and Shared consumption without writes', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-harnesses-'));
  const piHome = path.join(configDir, 'pi');
  const shared = path.join(configDir, 'agents', 'skills');
  fs.mkdirSync(path.join(piHome, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [
      {
        key: 'pi',
        discoveryRoot: path.join(piHome, 'agent', 'skills'),
        parkingRoot: path.join(piHome, 'agent', '.skillspub-off', 'skills'),
      },
      {
        key: 'claude',
        discoveryRoot: path.join(configDir, 'claude', 'skills'),
        parkingRoot: path.join(configDir, 'claude', '.skillspub-off', 'skills'),
      },
      {
        key: 'shared',
        discoveryRoot: shared,
        parkingRoot: path.join(configDir, 'agents', '.skillspub-off', 'skills'),
        lockFile: path.join(configDir, 'agents', '.skill-lock.json'),
      },
    ],
    genericTargets: [],
  }));
  const before = fs.readdirSync(configDir).sort();
  const result = spawnSync('node', [CLI, 'harnesses'], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Detected Harnesses:/);
  assert.match(result.stdout, /pi\s+managed\s+Shared enabled\s+Isolation unmanaged\s+Link supported/);
  assert.match(result.stdout, /evidence\s+v0\.54\.0/);
  assert.match(result.stdout, /Available Harnesses:\nclaude\s+managed\s+Shared not-consumed\s+Isolation not-required\s+Link supported/);
  assert.deepEqual(fs.readdirSync(configDir).sort(), before);
});

test('Pi setup previews, confirms, and explicitly reconciles its managed Shared exclusion', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-pi-isolation-'));
  const piHome = path.join(configDir, 'pi');
  const shared = path.join(configDir, 'agents', 'skills');
  fs.mkdirSync(path.join(piHome, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(piHome, 'agent', 'settings.json'), JSON.stringify({ theme: 'dark' }));
  fs.writeFileSync(path.join(configDir, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [
      {
        key: 'pi',
        discoveryRoot: path.join(piHome, 'agent', 'skills'),
        parkingRoot: path.join(piHome, 'agent', '.skillspub-off', 'skills'),
      },
      {
        key: 'shared',
        discoveryRoot: shared,
        parkingRoot: path.join(configDir, 'agents', '.skillspub-off', 'skills'),
      },
    ],
    genericTargets: [],
  }));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });

  const preview = run(['harnesses', 'pi', 'setup']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Pi isolation plan:/);
  assert.match(preview.stdout, /stop consuming Shared/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(piHome, 'agent', 'settings.json'), 'utf8')), { theme: 'dark' });

  const applied = run(['harnesses', 'pi', 'setup', '--yes']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /verified/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(piHome, 'agent', 'settings.json'), 'utf8')), {
    theme: 'dark',
    skills: ['!skills/**'],
  });

  fs.writeFileSync(path.join(piHome, 'agent', 'settings.json'), JSON.stringify({ theme: 'dark' }));
  const drift = run(['scan']);
  assert.equal(drift.status, 0, drift.stderr);
  assert.match(drift.stdout, /Harness drift:[\s\S]*Pi Shared isolation/);

  const setup = run(['harnesses', 'pi', 'setup', '--yes']);
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /explicit reconcile/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(piHome, 'agent', 'settings.json'), 'utf8')), { theme: 'dark' });

  const settingsFile = path.join(piHome, 'agent', 'settings.json');
  const beforeJsonPreview = fs.readFileSync(settingsFile, 'utf8');
  const reconcilePreview = run(['harnesses', 'pi', 'reconcile', '--json']);
  assert.equal(reconcilePreview.status, 0, reconcilePreview.stderr || reconcilePreview.stdout);
  assert.equal(reconcilePreview.stderr, '');
  const reconcilePreviewDocument = JSON.parse(reconcilePreview.stdout);
  assert.equal(reconcilePreviewDocument.data.applied, false);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), beforeJsonPreview);

  const reconciled = run(['harnesses', 'pi', 'reconcile', '--yes', '--json']);
  assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
  assert.equal(reconciled.stderr, '');
  const reconciledDocument = JSON.parse(reconciled.stdout);
  assert.equal(reconciledDocument.data.applied, true);
  assert.deepEqual(reconciledDocument.data.plan, reconcilePreviewDocument.data.plan);
  assert.equal(reconciledDocument.data.result.inspection.isolation.status, 'managed');
});

test('Claude Code inspect is read-only and setup reports its unsupported optional capability', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-claude-'));
  const claudeHome = path.join(configDir, 'claude');
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [
      {
        key: 'claude',
        discoveryRoot: path.join(claudeHome, 'skills'),
        parkingRoot: path.join(claudeHome, '.skillspub-off', 'skills'),
      },
      { key: 'pi', disabled: true },
      { key: 'shared', disabled: true },
    ],
    genericTargets: [],
  }));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
  const before = fs.readdirSync(configDir, { recursive: true }).sort();

  const inspected = run(['harnesses', 'claude', 'inspect']);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.match(
    inspected.stdout,
    /claude\s+managed\s+Shared not-consumed\s+Isolation not-required\s+Link supported/,
  );
  assert.deepEqual(fs.readdirSync(configDir, { recursive: true }).sort(), before);

  const unsupported = run(['harnesses', 'claude', 'setup']);
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /does not support setup.*no configuration write is required/i);
  assert.deepEqual(fs.readdirSync(configDir, { recursive: true }).sort(), before);
});

test('Grok CLI supports read-only inspection and confirmed Global and Project setup', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-grok-'));
  const grokHome = path.join(configDir, 'grok-home');
  const shared = path.join(configDir, 'global-agents', 'skills');
  const parent = path.join(configDir, 'workspace');
  const project = path.join(parent, 'project');
  const selectedShared = path.join(project, '.agents', 'skills');
  const ancestorShared = path.join(parent, '.agents', 'skills');
  fs.mkdirSync(grokHome, { recursive: true });
  fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
  fs.mkdirSync(selectedShared, { recursive: true });
  fs.mkdirSync(ancestorShared, { recursive: true });
  fs.writeFileSync(path.join(grokHome, 'config.toml'), '# preserve\n');
  fs.writeFileSync(path.join(configDir, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [
      {
        key: 'grok',
        discoveryRoot: path.join(grokHome, 'skills'),
        parkingRoot: path.join(grokHome, '.skillspub-off', 'skills'),
      },
      {
        key: 'shared',
        discoveryRoot: shared,
        parkingRoot: path.join(configDir, 'global-agents', '.skillspub-off', 'skills'),
      },
      { key: 'pi', disabled: true },
      { key: 'claude', disabled: true },
    ],
    genericTargets: [],
  }));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });

  const before = fs.readdirSync(configDir, { recursive: true }).sort();
  const inspected = run(['harnesses', 'grok', 'inspect']);
  const projectInspected = run(['project', project, 'harnesses', 'grok', 'inspect']);
  const globalPreview = run(['harnesses', 'grok', 'setup']);
  const preview = run(['project', project, 'harnesses', 'grok', 'setup']);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(projectInspected.status, 0, projectInspected.stderr);
  assert.equal(globalPreview.status, 0, globalPreview.stderr);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(inspected.stdout, /grok\s+managed\s+Shared enabled\s+Isolation unmanaged\s+Link unsupported\s+Mirror supported/);
  assert.match(projectInspected.stdout, new RegExp(path.join(project, '.grok', 'skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(globalPreview.stdout, new RegExp(shared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(preview.stdout, new RegExp(selectedShared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(preview.stdout, new RegExp(ancestorShared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(fs.readdirSync(configDir, { recursive: true }).sort(), before);

  const globalJsonPreview = run(['harnesses', 'grok', 'setup', '--json']);
  assert.equal(globalJsonPreview.status, 0, globalJsonPreview.stderr || globalJsonPreview.stdout);
  const globalJsonPreviewDocument = JSON.parse(globalJsonPreview.stdout);
  assert.equal(globalJsonPreviewDocument.data.applied, false);
  assert.doesNotMatch(JSON.stringify(globalJsonPreviewDocument.data.plan), /[0-9a-f]{8}-[0-9a-f-]{27}/i);

  const globalApplied = run(['harnesses', 'grok', 'setup', '--yes', '--json']);
  assert.equal(globalApplied.status, 0, globalApplied.stderr || globalApplied.stdout);
  const globalAppliedDocument = JSON.parse(globalApplied.stdout);
  assert.equal(globalAppliedDocument.data.applied, true);
  assert.deepEqual(globalAppliedDocument.data.plan, globalJsonPreviewDocument.data.plan);
  fs.writeFileSync(
    path.join(grokHome, 'config.toml'),
    fs.readFileSync(path.join(grokHome, 'config.toml'), 'utf8')
      .replace('[compat.cursor]\nskills = false', '[compat.cursor]\nskills = true'),
  );
  const globalReconciled = run(['harnesses', 'grok', 'reconcile', '--yes']);
  assert.equal(globalReconciled.status, 0, globalReconciled.stderr);
  assert.match(globalReconciled.stdout, /Grok Build reconcile verified/);

  const applied = run(['project', project, 'harnesses', 'grok', 'setup', '--yes']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Manual recovery:/);
  assert.match(applied.stdout, /Grok Build setup verified/);
  const written = fs.readFileSync(path.join(grokHome, 'config.toml'), 'utf8');
  assert.match(written, /# preserve/);
  assert.match(written, new RegExp(selectedShared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(written, new RegExp(ancestorShared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  fs.writeFileSync(
    path.join(grokHome, 'config.toml'),
    written.replace('[compat.claude]\nskills = false', '[compat.claude]\nskills = true'),
  );
  const projectReconciled = run(['project', project, 'harnesses', 'grok', 'reconcile', '--yes']);
  assert.equal(projectReconciled.status, 0, projectReconciled.stderr);
  assert.match(projectReconciled.stdout, /Grok Build reconcile verified/);
});

test('project scan does not create Project state', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-project-'));
  const project = path.join(configDir, 'project');
  fs.mkdirSync(path.join(project, '.agents', 'skills', 'example'), { recursive: true });
  fs.writeFileSync(path.join(project, '.agents', 'skills', 'example', 'SKILL.md'), '# example');
  fs.mkdirSync(path.join(configDir, '.agents', 'skills', 'parent-example'), { recursive: true });
  fs.writeFileSync(path.join(configDir, '.agents', 'skills', 'parent-example', 'SKILL.md'), '# parent');
  fs.mkdirSync(path.join(configDir, 'global', 'skills', 'global-example'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'global', 'skills', 'global-example', 'SKILL.md'), '# global');
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1,
    runtimes: [{
      key: 'shared',
      kind: 'shared',
      discoveryRoot: path.join(configDir, 'global', 'skills'),
      parkingRoot: path.join(configDir, 'global', '.skillspub-off', 'skills'),
      projectPath: '.agents/skills',
    }],
  }));

  const result = spawnSync('node', [CLI, 'project', project, 'scan'], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
  assert.equal(result.status, 0, result.stderr);
  const realProject = fs.realpathSync(project);
  assert.match(result.stdout, new RegExp(`Project scan: ${realProject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, /parent-example.*read-only/);
  assert.match(result.stdout, /global-example.*read-only/);
  assert.equal(fs.existsSync(path.join(realProject, '.skillspub', 'state.json')), false);
  assert.equal(fs.existsSync(path.join(configDir, 'state.json')), false);
});

test('bundle commands persist explicit resource members and show stale references', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-bundle-'));
  const discoveryRoot = path.join(configDir, 'shared', 'skills');
  const parkingRoot = path.join(configDir, 'shared', '.skillspub-off', 'skills');
  const skill = path.join(discoveryRoot, 'example');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# example');
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1,
    runtimes: [{
      key: 'shared',
      kind: 'shared',
      discoveryRoot,
      parkingRoot,
      projectPath: '.agents/skills',
    }],
  }));
  const run = (args: string[]) => execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
  assert.match(run(['scan']), /Global scan/);
  const resourceId = fs.realpathSync(skill);

  assert.match(run(['bundle', 'create', 'tools', 'skill:example']), /created bundle tools/);
  assert.match(run(['bundle', 'ls']), /tools\t1/);
  assert.match(run(['bundle', 'show', 'tools']), new RegExp(resourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  fs.rmSync(skill, { recursive: true });
  assert.match(run(['scan']), /Global scan/);
  assert.match(run(['bundle', 'show', 'tools']), /stale/);
  assert.match(run(['bundle', 'rm', 'tools', `skill:${resourceId}`]), /removed 1 member/);
  assert.match(run(['bundle', 'rm', 'tools']), /removed bundle tools/);
  const state = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.equal(state.bundles.tools, undefined);
});

test('bundle membership never merges same-name resource variants', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-bundle-variants-'));
  const runtimes = ['one', 'two'].map((key) => {
    const discoveryRoot = path.join(configDir, key, 'skills');
    const skill = path.join(discoveryRoot, 'same');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), `# ${key}`);
    return {
      key,
      kind: 'shared',
      discoveryRoot,
      parkingRoot: path.join(configDir, key, '.skillspub-off', 'skills'),
      projectPath: `.agents/${key}/skills`,
      skill,
    };
  });
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1,
    runtimes: runtimes.map(({ skill: _, ...runtime }) => runtime),
  }));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
  assert.equal(run(['scan']).status, 0);
  const ambiguous = run(['bundle', 'create', 'tools', 'skill:same']);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /ambiguous/);
  for (const runtime of runtimes) {
    assert.match(ambiguous.stderr, new RegExp(`skill:${fs.realpathSync(runtime.skill).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  const stateAfterFailure = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.equal(stateAfterFailure.bundles.tools, undefined);

  const first = `skill:${fs.realpathSync(runtimes[0].skill)}`;
  const second = `skill:${fs.realpathSync(runtimes[1].skill)}`;
  assert.equal(run(['bundle', 'create', 'tools', first]).status, 0);
  assert.equal(run(['bundle', 'add', 'tools', second]).status, 0);
  assert.match(run(['bundle', 'show', 'tools']).stdout, /same[\s\S]*same/);
});

test('bundle selectors preview Target Slots, move relationships, and update Base intent', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-bundle-toggle-'));
  const discoveryRoot = path.join(configDir, 'shared', 'skills');
  const parkingRoot = path.join(configDir, 'shared', '.skillspub-off', 'skills');
  for (const name of ['one', 'two']) {
    fs.mkdirSync(path.join(discoveryRoot, name), { recursive: true });
    fs.writeFileSync(path.join(discoveryRoot, name, 'SKILL.md'), `# ${name}`);
  }
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1,
    runtimes: [{
      key: 'shared',
      kind: 'shared',
      discoveryRoot,
      parkingRoot,
      projectPath: '.agents/skills',
    }],
  }));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
  assert.equal(run(['scan']).status, 0);
  assert.equal(
    run(['bundle', 'create', 'tools', 'skill:one', 'skill:two']).status,
    0,
  );

  const disabled = run(['off', 'bundle:tools', 'shared']);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /Plan:/);
  assert.match(disabled.stdout, /global:shared\/one\s+on -> off/);
  assert.match(disabled.stdout, /global:shared\/two\s+on -> off/);
  assert.ok(fs.existsSync(path.join(parkingRoot, 'one', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(parkingRoot, 'two', 'SKILL.md')));
  const state = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.equal(state.baseIntent['global:shared\0one'], 'off');
  assert.equal(state.baseIntent['global:shared\0two'], 'off');

  const repeated = run(['off', 'bundle:tools', 'shared']);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /off -> off/);

  const enabled = run(['on', 'bundle:tools', 'shared']);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.stdout, /global:shared\/one\s+off -> on/);
  assert.ok(fs.existsSync(path.join(discoveryRoot, 'one', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(discoveryRoot, 'two', 'SKILL.md')));
});

test('bundle activation preflight rejects same-Slot variants without changing state or disk', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-bundle-conflict-'));
  const runtimes = ['one', 'two'].map((key) => {
    const discoveryRoot = path.join(configDir, key, 'skills');
    const skill = path.join(discoveryRoot, 'same');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), `# ${key}`);
    return {
      key,
      kind: 'shared',
      discoveryRoot,
      parkingRoot: path.join(configDir, key, '.skillspub-off', 'skills'),
      projectPath: `.agents/${key}/skills`,
      skill,
    };
  });
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1,
    runtimes: runtimes.map(({ skill: _, ...runtime }) => runtime),
  }));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
  assert.equal(run(['scan']).status, 0);
  const selectors = runtimes.map(({ skill }) => `skill:${fs.realpathSync(skill)}`);
  assert.equal(run(['bundle', 'create', 'conflict', ...selectors]).status, 0);
  const stateFile = path.join(configDir, 'state.json');
  const before = fs.readFileSync(stateFile, 'utf8');

  const result = run(['off', 'bundle:conflict', 'one']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Target Slot global:one\/same is ambiguous or occupied/);
  for (const selector of selectors) {
    assert.match(result.stderr, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  assert.ok(fs.existsSync(path.join(runtimes[0].skill, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(runtimes[1].skill, 'SKILL.md')));
});

test('bundle activation fails safely when a member is stale', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-bundle-stale-'));
  const discoveryRoot = path.join(configDir, 'shared', 'skills');
  const parkingRoot = path.join(configDir, 'shared', '.skillspub-off', 'skills');
  const skill = path.join(discoveryRoot, 'example');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# example');
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1,
    runtimes: [{
      key: 'shared',
      kind: 'shared',
      discoveryRoot,
      parkingRoot,
      projectPath: '.agents/skills',
    }],
  }));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
  assert.equal(run(['scan']).status, 0);
  assert.equal(run(['bundle', 'create', 'tools', 'skill:example']).status, 0);
  fs.rmSync(skill, { recursive: true });
  assert.equal(run(['scan']).status, 0);
  const stateFile = path.join(configDir, 'state.json');
  const before = fs.readFileSync(stateFile, 'utf8');

  const result = run(['off', 'bundle:tools', 'shared']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale Bundle member/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
});

test('creating a missing Relationship requires explicit confirmation', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-bundle-link-'));
  const sourceRoot = path.join(configDir, 'source', 'skills');
  const targetRoot = path.join(configDir, 'target', 'skills');
  const skill = path.join(sourceRoot, 'example');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# example');
  const runtimes = [
    {
      key: 'source',
      kind: 'shared',
      discoveryRoot: sourceRoot,
      parkingRoot: path.join(configDir, 'source', '.skillspub-off', 'skills'),
      projectPath: '.agents/source/skills',
    },
    {
      key: 'target',
      kind: 'shared',
      discoveryRoot: targetRoot,
      parkingRoot: path.join(configDir, 'target', '.skillspub-off', 'skills'),
      projectPath: '.agents/target/skills',
    },
  ];
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({ version: 1, runtimes }));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
  assert.equal(run(['scan']).status, 0);
  assert.equal(run(['bundle', 'create', 'tools', 'skill:example']).status, 0);
  const stateFile = path.join(configDir, 'state.json');
  const before = fs.readFileSync(stateFile, 'utf8');

  const refused = run(['on', 'bundle:tools', 'target']);

  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /global:target\/example\s+missing -> on/);
  assert.match(refused.stderr, /requires --yes/);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(targetRoot, 'example')), false);

  const confirmed = run(['on', 'bundle:tools', 'target', '--yes']);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.equal(fs.realpathSync(path.join(targetRoot, 'example')), fs.realpathSync(skill));
});

test('Tag commands use resource identity for filtering and planned Target mutations', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-tags-'));
  const runtimes = ['one', 'two'].map((key) => {
    const discoveryRoot = path.join(configDir, key, 'skills');
    const skill = path.join(discoveryRoot, 'same');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), `# ${key}`);
    return {
      key,
      kind: 'shared',
      discoveryRoot,
      parkingRoot: path.join(configDir, key, 'off'),
      projectPath: `.agents/${key}/skills`,
      skill,
    };
  });
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1,
    runtimes: runtimes.map(({ skill: _, ...runtime }) => runtime),
  }));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
  assert.equal(run(['scan']).status, 0);
  const selected = fs.realpathSync(runtimes[0].skill);
  const other = fs.realpathSync(runtimes[1].skill);

  const ambiguous = run(['tag', 'add', 'same', 'backend']);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /ambiguous/);

  const added = run(['tag', 'add', `skill:${selected}`, 'tools', 'backend']);
  assert.equal(added.status, 0, added.stderr);
  assert.match(run(['tag', 'ls']).stdout, /backend\t1[\s\S]*tools\t1/);
  assert.match(run(['tag', 'ls', '--skill', `skill:${selected}`]).stdout, /backend[\s\S]*tools/);
  const filtered = run(['ls', '--tag', 'backend']);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.match(filtered.stdout, new RegExp(selected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(filtered.stdout, new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const disabled = run(['off', 'tag:backend', 'one']);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /Plan:[\s\S]*global:one\/same\s+on -> off/);
  const parked = fs.realpathSync(path.join(runtimes[0].parkingRoot, 'same'));
  let state = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.tags[parked], ['backend', 'tools']);
  assert.equal(state.tags[selected], undefined);
  assert.equal(state.baseIntent['global:one\0same'], 'off');

  const enabled = run(['on', 'tag:backend', 'one']);
  assert.equal(enabled.status, 0, enabled.stderr);
  state = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.tags[selected], ['backend', 'tools']);
  assert.match(run(['tag', 'rm', `skill:${selected}`, 'tools']).stdout, /removed 1 tag/);
  assert.match(run(['tag', 'rm', `skill:${selected}`]).stdout, /removed 1 tag/);
});

test('preset activate/deactivate/reconcile update claims and Desired state', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-preset-'));
  const discoveryRoot = path.join(configDir, 'shared', 'skills');
  const parkingRoot = path.join(configDir, 'shared', '.skillspub-off', 'skills');
  fs.mkdirSync(path.join(discoveryRoot, 'one'), { recursive: true });
  fs.writeFileSync(path.join(discoveryRoot, 'one', 'SKILL.md'), '# one');
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1,
    runtimes: [{
      key: 'shared',
      kind: 'shared',
      discoveryRoot,
      parkingRoot,
      projectPath: '.agents/skills',
    }],
  }));
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });
  assert.equal(run(['scan']).status, 0);
  assert.equal(run(['preset', 'create', 'tools', 'skill:one']).status, 0);

  const activatePreview = run(['preset', 'activate', 'tools', 'shared', '--json']);
  assert.equal(activatePreview.status, 0, activatePreview.stderr || activatePreview.stdout);
  const activatePreviewDocument = JSON.parse(activatePreview.stdout);
  assert.equal(activatePreviewDocument.data.applied, false);
  const beforeActivate = fs.readFileSync(path.join(configDir, 'state.json'), 'utf8');

  const activated = run(['preset', 'activate', 'tools', 'shared', '--yes', '--json']);
  assert.equal(activated.status, 0, activated.stderr || activated.stdout);
  const activatedDocument = JSON.parse(activated.stdout);
  assert.equal(activatedDocument.data.applied, true);
  assert.deepEqual(activatedDocument.data.plan, activatePreviewDocument.data.plan);
  assert.notEqual(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'), beforeActivate);
  let state = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.claims['global:shared\0one'], ['preset:tools']);
  assert.ok(state.presetActivations.tools.includes('shared'));

  state.baseIntent = { 'global:shared\0one': 'off' };
  fs.writeFileSync(path.join(configDir, 'state.json'), JSON.stringify(state));
  const deactivatePreview = run(['preset', 'deactivate', 'tools', 'shared', '--json']);
  assert.equal(deactivatePreview.status, 0, deactivatePreview.stderr || deactivatePreview.stdout);
  const deactivatePreviewDocument = JSON.parse(deactivatePreview.stdout);
  assert.equal(deactivatePreviewDocument.data.applied, false);
  const deactivated = run(['preset', 'deactivate', 'tools', 'shared', '--yes', '--json']);
  assert.equal(deactivated.status, 0, deactivated.stderr || deactivated.stdout);
  assert.deepEqual(JSON.parse(deactivated.stdout).data.plan, deactivatePreviewDocument.data.plan);
  assert.ok(fs.existsSync(path.join(parkingRoot, 'one', 'SKILL.md')));
  state = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.equal(state.claims['global:shared\0one'], undefined);

  const reconcilePreview = run(['preset', 'reconcile', '--json']);
  assert.equal(reconcilePreview.status, 0, reconcilePreview.stderr || reconcilePreview.stdout);
  const reconcilePreviewDocument = JSON.parse(reconcilePreview.stdout);
  assert.equal(reconcilePreviewDocument.data.applied, false);
  const reconciled = run(['preset', 'reconcile', '--yes', '--json']);
  assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
  assert.deepEqual(JSON.parse(reconciled.stdout).data.plan, reconcilePreviewDocument.data.plan);

  assert.equal(run(['preset', 'delete', 'tools', '--yes']).status, 0);
  assert.match(run(['preset', 'ls']).stdout, /no presets found/);
});

test('doctor is read-only by default and repairs only with explicit confirmation', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-cli-doctor-'));
  const discoveryRoot = path.join(configDir, 'shared', 'skills');
  const parkingRoot = path.join(configDir, 'shared', '.skillspub-off', 'skills');
  const broken = path.join(discoveryRoot, 'broken');
  fs.mkdirSync(discoveryRoot, { recursive: true });
  fs.symlinkSync('/missing/skill', broken);
  fs.writeFileSync(path.join(configDir, 'runtimes.json'), JSON.stringify({
    version: 1,
    runtimes: [{
      key: 'shared',
      kind: 'shared',
      discoveryRoot,
      parkingRoot,
      projectPath: '.agents/skills',
    }],
  }));
  const stateFile = path.join(configDir, 'state.json');
  fs.writeFileSync(stateFile, '{"bundles":{}}\n');
  const run = (args: string[]) => spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SKILLSPUB_CONFIG_DIR: configDir },
  });

  const diagnosis = run(['doctor']);
  assert.equal(diagnosis.status, 0, diagnosis.stderr);
  assert.match(diagnosis.stdout, /broken link:/);
  assert.match(diagnosis.stdout, /Safe repair plan:/);
  assert.equal(fs.lstatSync(broken).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{"bundles":{}}\n');

  const unconfirmed = run(['doctor', '--repair']);
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /rerun with --repair --yes/);
  assert.equal(fs.lstatSync(broken).isSymbolicLink(), true);

  const repaired = run(['doctor', '--repair', '--yes']);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /Applied repairs: 1/);
  assert.throws(() => fs.lstatSync(broken), /ENOENT/);
});
