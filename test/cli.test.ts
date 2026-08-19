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
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /skillspub: usage: skillspub tui/);
});

test('renamed diagnostics use only the canonical identity', () => {
  const result = runProcess(['on']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skillspub: usage: skillspub on/);
  assert.doesNotMatch(result.stderr, /\bskm\b/);
});

test('unknown command prints usage and exits 1', () => {
  const { run } = setup();
  assert.throws(() => run(['bogus']));
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

  const reconciled = run(['harnesses', 'pi', 'reconcile', '--yes']);
  assert.equal(reconciled.status, 0, reconciled.stderr);
  assert.match(reconciled.stdout, /verified/i);
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

  const activated = run(['preset', 'activate', 'tools', 'shared']);
  assert.equal(activated.status, 0, activated.stderr);
  assert.match(activated.stdout, /Plan:/);
  let state = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.claims['global:shared\0one'], ['preset:tools']);
  assert.ok(state.presetActivations.tools.includes('shared'));

  state.baseIntent = { 'global:shared\0one': 'off' };
  fs.writeFileSync(path.join(configDir, 'state.json'), JSON.stringify(state));
  const deactivated = run(['preset', 'deactivate', 'tools', 'shared']);
  assert.equal(deactivated.status, 0, deactivated.stderr);
  assert.ok(fs.existsSync(path.join(parkingRoot, 'one', 'SKILL.md')));
  state = JSON.parse(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'));
  assert.equal(state.claims['global:shared\0one'], undefined);

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
