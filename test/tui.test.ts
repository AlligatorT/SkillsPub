import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { createElement as h } from 'react';
import { render } from 'ink';
import { App, HarnessBadge } from '../src/tui.ts';
import { sharedRefresh } from '../src/shared.ts';
import { hashDirectory } from '../src/inventory.ts';

const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][0-9A-B]/g;
const RENDER_CONTROL_PATTERN = /\x1b\[(2K|2J|3J|1A|\d+F)/;
const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, '');

class FakeStdin extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean) {
    this.isRaw = value;
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

class FakeStdout extends PassThrough {
  isTTY = true;
  columns: number;
  rows: number;
  private current = '';
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write(chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
    const s = String(chunk);
    // Each interactive render starts with erase/clear control sequences.
    if (RENDER_CONTROL_PATTERN.test(s)) this.current = s;
    else this.current += s;
    let done: (() => void) | undefined;
    if (typeof encoding === 'function') done = encoding as () => void;
    else if (typeof cb === 'function') done = cb as () => void;
    if (done) queueMicrotask(done);
    return true;
  }
  frame(): string {
    return stripAnsi(this.current);
  }
}

function mkSkill(dir: string, name: string, body?: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), body ?? `# ${name}`);
}

/** Two agents; agent `a` has on-local, on-link, off-local, broken, and two same-name variants. */
function setup() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-tui-'));
  const a = path.join(configDir, 'a-skills');
  const b = path.join(configDir, 'b-skills');
  mkSkill(a, 'grilling', '---\ndescription: Grill the user\n---\n# grilling');
  const shared = path.join(configDir, 'shared');
  mkSkill(shared, 'real-linked');
  fs.mkdirSync(a, { recursive: true });
  fs.symlinkSync(path.join(shared, 'real-linked'), path.join(a, 'linked'));
  mkSkill(path.join(configDir, '.skillspub-off', 'a-skills'), 'parked');
  fs.symlinkSync(path.join(shared, 'gone'), path.join(a, 'broken'));
  // same-name variants at different real paths
  mkSkill(a, 'code-review');
  const other = path.join(configDir, 'other');
  mkSkill(other, 'code-review');
  fs.mkdirSync(b, { recursive: true });
  fs.symlinkSync(path.join(other, 'code-review'), path.join(b, 'code-review'));
  mkSkill(b, 'only-b');
  fs.writeFileSync(
    path.join(configDir, 'agents.conf'),
    `a = ${a}\nb = ${b}\n`,
  );
  return { home: { configDir } };
}

function setupVisibilityTui({grokDetected = true} = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-tui-visibility-'));
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
  mkSkill(roots.shared, 'demo');
  const resource = fs.realpathSync(path.join(roots.shared, 'demo'));
  fs.mkdirSync(roots.pi, {recursive: true});
  fs.symlinkSync(resource, path.join(roots.pi, 'demo'));
  fs.writeFileSync(path.join(path.dirname(roots.pi), 'settings.json'), JSON.stringify({
    skills: [`!${roots.shared}/**`],
  }));
  fs.mkdirSync(path.dirname(roots.claude), {recursive: true});
  if (grokDetected) {
    fs.mkdirSync(path.dirname(roots.grok), {recursive: true});
    fs.writeFileSync(path.join(path.dirname(roots.grok), 'config.toml'), '[');
  }
  return {home: {configDir}, roots, resource};
}

async function renderApp(
  home: { configDir: string },
  columns = 100,
  rows = 30,
  projectPath?: string,
) {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(columns, rows);
  const app = render(h(App, { home, projectPath }), {
    stdin: stdin as never,
    stdout: stdout as never,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const flush = () => app.waitUntilRenderFlush();
  await flush();
  const send = async (input: string) => {
    stdin.write(input);
    // Ink holds a lone ESC for 20ms so it can complete an escape sequence.
    if (input === '\x1b') await new Promise((resolve) => setTimeout(resolve, 25));
    await flush();
  };
  return { stdin, stdout, send, flush, unmount: () => app.unmount() };
}

async function waitForFrame(
  app: {stdout: FakeStdout; flush(): Promise<void>},
  pattern: RegExp,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = app.stdout.frame();
    if (pattern.test(frame)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await app.flush();
  }
  const frame = app.stdout.frame();
  assert.match(frame, pattern);
  return frame;
}

test('Harness badge renderer keeps non-managed support explicit', async () => {
  for (const support of ['discoverable', 'unsupported'] as const) {
    const stdout = new FakeStdout(30, 3);
    const app = render(h(HarnessBadge, {
      harness: {support, isolation: {status: 'managed', detail: ''}},
    }), {stdout: stdout as never, patchConsole: false});
    await app.waitUntilRenderFlush();
    assert.ok(stdout.frame().includes(`[${support}]`));
    app.unmount();
  }
});

interface ManagedTuiSkill {
  name: string;
  source: string;
  hash: string;
  off?: boolean;
}

function setupManagedTui(skills: ManagedTuiSkill[], projectScope = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-tui-updates-'));
  const userHome = path.join(root, 'home');
  const configDir = path.join(root, 'config');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  const npxLog = path.join(root, 'npx.jsonl');
  const gitLog = path.join(root, 'git.jsonl');
  fs.mkdirSync(userHome, {recursive: true});
  fs.mkdirSync(configDir, {recursive: true});
  fs.mkdirSync(project, {recursive: true});
  fs.mkdirSync(bin, {recursive: true});
  fs.writeFileSync(path.join(configDir, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [
      {key: 'claude', disabled: true},
      {key: 'grok', disabled: true},
      {key: 'pi', disabled: true},
      {
        key: 'shared',
        discoveryRoot: path.join(userHome, '.agents', 'skills'),
        parkingRoot: path.join(userHome, '.agents', '.skillspub-off', 'skills'),
        lockFile: path.join(userHome, '.agents', '.skill-lock.json'),
      },
    ],
    genericTargets: [],
  }));
  const scopeRoot = projectScope ? project : userHome;
  const discovery = path.join(scopeRoot, '.agents', 'skills');
  const parking = projectScope
    ? path.join(project, '.skillspub', 'off', 'shared')
    : path.join(userHome, '.agents', '.skillspub-off', 'skills');
  const lockFile = projectScope
    ? path.join(project, 'skills-lock.json')
    : path.join(userHome, '.agents', '.skill-lock.json');
  for (const skill of skills)
    mkSkill(skill.off ? parking : discovery, skill.name, `# ${skill.name}`);
  fs.mkdirSync(path.dirname(lockFile), {recursive: true});
  fs.writeFileSync(lockFile, JSON.stringify({
    version: 3,
    skills: Object.fromEntries(skills.map((skill) => [skill.name, {
      source: skill.source,
      sourceType: 'github',
      sourceUrl: `https://github.com/${skill.source}.git`,
      skillPath: `skills/${skill.name}/SKILL.md`,
      skillFolderHash: skill.hash,
    }])),
  }));
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TUI_GIT_LOG, JSON.stringify(args) + '\\n');
const trees = JSON.parse(process.env.TUI_GIT_TREES || '{}');
if (args[0] === 'clone') {
  const source = args.at(-2);
  const destination = args.at(-1);
  if (!trees[source]) process.exit(1);
  fs.mkdirSync(destination, {recursive: true});
  fs.writeFileSync(destination + '.source', source);
  for (const folder of Object.keys(trees[source]))
    if (folder !== '.') fs.mkdirSync(path.join(destination, folder), {recursive: true});
  process.exit(0);
}
if (args[0] === '-C' && args[2] === 'rev-parse') {
  const source = fs.readFileSync(args[1] + '.source', 'utf8');
  const revision = args.at(-1);
  const folder = revision === 'HEAD^{tree}' ? '.' : revision.slice('HEAD:'.length);
  if (!trees[source]?.[folder]) process.exit(1);
  process.stdout.write(trees[source][folder] + '\\n');
  process.exit(0);
}
process.exit(2);
`, {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'npx'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TUI_NPX_LOG, JSON.stringify({args, cwd: process.cwd()}) + '\\n');
if (args[2] === 'find') {
  process.stdout.write(process.env.TUI_NPX_FIND_OUTPUT || '');
  process.exit(0);
}
const base = args.includes('--global') ? process.env.HOME : process.cwd();
if (args[2] === 'add') {
  if (process.env.TUI_NPX_FAIL_ONCE && !fs.existsSync(process.env.TUI_NPX_FAIL_ONCE)) {
    fs.writeFileSync(process.env.TUI_NPX_FAIL_ONCE, 'failed');
    process.exit(7);
  }
  const source = args[3];
  const requestedName = args[args.indexOf('--skill') + 1];
  const name = requestedName.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^[.\\-]+|[.\\-]+$/g, '') || 'unnamed-skill';
  const skillsRoot = path.join(base, '.agents', 'skills');
  const lockFile = args.includes('--global')
    ? path.join(process.env.HOME, '.agents', '.skill-lock.json')
    : path.join(process.cwd(), 'skills-lock.json');
  fs.mkdirSync(path.join(skillsRoot, name), {recursive: true});
  fs.writeFileSync(path.join(skillsRoot, name, 'SKILL.md'), '# ' + source + '\\n');
  let lock = {version: 3, skills: {}};
  try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch {}
  lock.skills[name] = {source, sourceUrl: 'https://github.com/' + source + '.git', skillPath: 'skills/' + name};
  fs.mkdirSync(path.dirname(lockFile), {recursive: true});
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  process.exit(0);
}
if (args[2] !== 'update') process.exit(2);
const names = args.slice(3).filter((arg) => !arg.startsWith('-'));
const failed = new Set(JSON.parse(process.env.TUI_NPX_FAIL_NAMES || '[]'));
if (names.some((name) => failed.has(name))) process.exit(7);
for (const name of names)
  fs.appendFileSync(path.join(base, '.agents', 'skills', name, 'SKILL.md'), '\\n# updated');
`, {mode: 0o755});
  return {
    home: {configDir},
    project,
    discovery,
    parking,
    npxLog,
    gitLog,
    env: {
      HOME: userHome,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      TUI_GIT_LOG: gitLog,
      TUI_NPX_LOG: npxLog,
    },
  };
}

function useFixtureEnv(
  context: {after(callback: () => void): void},
  env: Record<string, string>,
): void {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.TUI_GIT_TREES;
    delete process.env.TUI_NPX_FAIL_NAMES;
  });
}

test('TUI startup reads legacy configuration without creating a Target registry or state', async () => {
  const { home } = setup();
  const before = fs.readdirSync(home.configDir).sort();

  const t = await renderApp(home);
  t.unmount();

  assert.deepEqual(fs.readdirSync(home.configDir).sort(), before);
  assert.equal(fs.existsSync(path.join(home.configDir, 'targets.json')), false);
  assert.equal(fs.existsSync(path.join(home.configDir, 'runtimes.json')), false);
  assert.equal(fs.existsSync(path.join(home.configDir, 'state.json')), false);
});

test('Source workspace exposes durable read-only scope, lifecycle, inventory, and truth', async () => {
  const {home} = setup();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-source-project-'));
  const before = fs.readdirSync(home.configDir, {recursive: true}).sort();
  const t = await renderApp(home, 120, 32, project);

  await t.send('3');
  let frame = t.stdout.frame();
  assert.match(frame, /Source/);
  assert.match(frame, /Scope: exact Project/);
  assert.match(frame, new RegExp(fs.realpathSync(project).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(frame, /Discover.*Inspect & plan.*Confirm ownership.*Run & maintain.*Verify truth/);
  assert.match(frame, /Catalog/);
  assert.match(frame, /Actual:/);
  assert.match(frame, /Desired:/);
  assert.match(frame, /Drift:/);
  assert.match(frame, /Update:/);
  assert.match(frame, /Relationship:/);
  assert.match(frame, /Effective Visibility:/);

  await t.send('\t');
  frame = t.stdout.frame();
  assert.match(frame, /Inventory/);
  await t.send('g');
  assert.match(t.stdout.frame(), /Scope: Global/);
  await t.send('p');
  assert.match(t.stdout.frame(), /Scope: exact Project/);
  t.unmount();

  assert.deepEqual(fs.readdirSync(home.configDir, {recursive: true}).sort(), before);
  assert.equal(fs.existsSync(path.join(project, '.skillspub')), false);
});

test('Source Inventory keeps inherited and unknown ownership readable in a narrow terminal', async (context) => {
  const fixture = setupManagedTui([{name: 'managed', source: 'owner/repo', hash: 'managed-hash'}]);
  mkSkill(fixture.discovery, 'unknown');
  useFixtureEnv(context, fixture.env);
  const t = await renderApp(fixture.home, 52, 32, fixture.project);

  await t.send('3');
  await t.send('\t');
  let frame = t.stdout.frame();
  assert.match(frame, /Scope: exact Project/);
  assert.match(frame, /Discover/);
  assert.match(frame, /Verify truth/);
  assert.match(frame, /Inventory/);
  assert.match(frame, /managed/);
  assert.match(frame, /Selected resource/);
  assert.match(frame, /Provenance: https:\/\/github\.com\/owner\/repo\.git/);
  assert.match(frame, /Actual:/);
  assert.match(frame, /Effective Visibility:/);

  await t.send('j');
  await t.send('\r');
  frame = t.stdout.frame();
  assert.match(frame, /Resource detail/);
  assert.match(frame, /Provenance: Source unknown/);
  assert.match(frame, /Read-only inherited global/);
  await t.send('\x1b');
  assert.match(t.stdout.frame(), /unknown/);
  t.unmount();
});

test('Source truth derives Desired and Drift from the selected scope state', async (context) => {
  const fixture = setupManagedTui([{name: 'managed', source: 'owner/repo', hash: 'managed-hash'}]);
  fs.writeFileSync(path.join(fixture.home.configDir, 'state.json'), JSON.stringify({
    baseIntent: {'global:shared\0managed': 'off'},
  }));
  useFixtureEnv(context, fixture.env);
  const t = await renderApp(fixture.home, 100, 30);

  await t.send('3');
  await t.send('\t');
  const frame = t.stdout.frame();
  assert.match(frame, /Actual: ON local/);
  assert.match(frame, /Desired: OFF/);
  assert.match(frame, /Drift: observed/);
  t.unmount();
});

test('Source Inventory preserves every observed same-slot Relationship', async (context) => {
  const fixture = setupManagedTui([{name: 'managed', source: 'owner/repo', hash: 'managed-hash'}]);
  const projectTarget = path.join(fixture.project, '.agents', 'skills');
  fs.mkdirSync(projectTarget, {recursive: true});
  fs.symlinkSync(path.join(fixture.discovery, 'managed'), path.join(projectTarget, 'managed'));
  useFixtureEnv(context, fixture.env);
  const t = await renderApp(fixture.home, 100, 30, fixture.project);

  await t.send('3');
  await t.send('\t');
  assert.match(t.stdout.frame(), /Relationship: 2/);
  t.unmount();
});

test('Source Catalog search keeps same-name candidates distinct and traps detail focus', async (context) => {
  const fixture = setupManagedTui([{name: 'installed', source: 'owner/installed', hash: 'installed-hash'}]);
  useFixtureEnv(context, {
    ...fixture.env,
    TUI_NPX_FIND_OUTPUT: [
      'owner/one@shared-name  10 installs',
      '└ https://skills.sh/owner/one/shared-name',
      'owner/two@shared-name  20 installs',
      '└ https://skills.sh/owner/two/shared-name',
    ].join('\n'),
  });
  const t = await renderApp(fixture.home, 120, 32, fixture.project);

  await t.send('3');
  await t.send('/');
  for (const input of 'shared-name') await t.send(input);
  await t.send('\r');
  let frame = t.stdout.frame();
  assert.match(frame, /owner\/one@shared-name/);
  assert.match(frame, /owner\/two@shared-name/);
  assert.match(frame, /Actual: not installed/);

  await t.send('\r');
  frame = t.stdout.frame();
  assert.match(frame, /Candidate detail/);
  assert.match(frame, /https:\/\/skills\.sh\/owner\/one\/shared-name/);
  await t.send('j');
  assert.match(t.stdout.frame(), /owner\/one@shared-name/);
  await t.send('\x1b');
  assert.doesNotMatch(t.stdout.frame(), /Candidate detail/);
  t.unmount();

  const calls = fs.readFileSync(fixture.npxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ['--yes', 'skills@1.5.21', 'find']);
  assert.equal(calls[0].cwd, fs.realpathSync(fixture.project));
});

test('Source Add and explicit Replace run A+C preview, cancellation, confirmation, and Verify truth in both scopes', async (context) => {
  const environmentKeys = ['HOME', 'PATH', 'TUI_GIT_LOG', 'TUI_NPX_LOG', 'TUI_NPX_FIND_OUTPUT'];
  const previousEnv = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  context.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const projectScope of [false, true]) {
    const fixture = setupManagedTui([{name: 'same', source: 'old/repo', hash: 'old-hash'}], projectScope);
    const source = path.join(fixture.discovery, 'same');
    const globalConsumerRoot = path.join(fixture.env.HOME, '.consumer', 'skills');
    const consumerRoot = projectScope
      ? path.join(fixture.project, '.consumer', 'skills')
      : globalConsumerRoot;
    const consumerParking = path.join(fixture.env.HOME, '.consumer', '.skillspub-off', 'skills');
    const consumer = path.join(consumerRoot, 'same');
    const globalMirrorRoot = path.join(fixture.env.HOME, '.mirror-consumer', 'skills');
    const mirrorRoot = projectScope
      ? path.join(fixture.project, '.mirror-consumer', 'skills')
      : globalMirrorRoot;
    const mirror = path.join(mirrorRoot, 'same');
    const targetFile = path.join(fixture.home.configDir, 'targets.json');
    const targets = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    targets.genericTargets.push({
      key: 'consumer',
      kind: 'generic',
      discoveryRoot: globalConsumerRoot,
      parkingRoot: consumerParking,
      projectPath: '.consumer/skills',
      relationship: {support: 'managed', link: 'supported'},
    }, {
      key: 'mirror-consumer',
      kind: 'generic',
      discoveryRoot: globalMirrorRoot,
      parkingRoot: path.join(fixture.env.HOME, '.mirror-consumer', '.skillspub-off', 'skills'),
      projectPath: '.mirror-consumer/skills',
      relationship: {support: 'managed', link: 'unsupported'},
    });
    fs.writeFileSync(targetFile, JSON.stringify(targets));
    fs.mkdirSync(consumerRoot, {recursive: true});
    fs.symlinkSync(source, consumer, 'dir');
    mkSkill(mirrorRoot, 'same', '# same');

    const resourceId = fs.realpathSync(source);
    const projectId = fs.realpathSync(fixture.project);
    const sharedSlotId = projectScope
      ? `project:${projectId}:shared\0same`
      : 'global:shared\0same';
    const mirrorSlotId = projectScope
      ? `project:${projectId}:mirror-consumer\0same`
      : 'global:mirror-consumer\0same';
    const catalogState = {
      tags: {[resourceId]: ['reviewed']},
      bundles: {tools: [resourceId]},
      presets: {work: {selectors: [`skill:${resourceId}`]}},
    };
    const policyState = {
      baseIntent: {[sharedSlotId]: 'off'},
      claims: {[sharedSlotId]: ['preset:work']},
      mirrors: {[mirrorSlotId]: {sourceId: resourceId, hash: hashDirectory(source)}},
    };
    const globalStateFile = path.join(fixture.home.configDir, 'state.json');
    if (projectScope) {
      fs.writeFileSync(globalStateFile, JSON.stringify(catalogState));
      const projectStateFile = path.join(fixture.project, '.skillspub', 'state.json');
      fs.mkdirSync(path.dirname(projectStateFile), {recursive: true});
      fs.writeFileSync(projectStateFile, JSON.stringify(policyState));
    } else {
      fs.writeFileSync(globalStateFile, JSON.stringify({...catalogState, ...policyState}));
    }
    Object.assign(process.env, {
      ...fixture.env,
      TUI_NPX_FIND_OUTPUT: [
        'new/repo@same  12 installs',
        '└ https://skills.sh/new/repo/same',
      ].join('\n'),
    });
    const t = await renderApp(fixture.home, 132, 38, projectScope ? fixture.project : undefined);
    await t.send('3');
    await t.send('/');
    await t.send('s');
    await t.send('\r');

    await t.send('a');
    let frame = t.stdout.frame();
    assert.match(frame, /Source Replace plan/);
    assert.match(frame, new RegExp(projectScope ? 'exact Project' : 'Global'));
    assert.match(frame, /Candidate: new\/repo@same/);
    assert.match(frame, /Source Adapter: skills@1\.5\.21/);
    assert.match(frame, /old\/repo.*new\/repo/);
    assert.match(frame, /consume-replacement/);
    assert.match(frame, /mirror-sync/);
    assert.match(frame, /Tags: reviewed/);
    assert.match(frame, /Bundles: tools/);
    assert.match(frame, /Preset claims: preset:work/);
    assert.match(frame, /queued/);
    await t.send('j');
    assert.match(t.stdout.frame(), /Source Replace plan \[2\//);
    await t.send('k');
    await t.send('\x1b');
    assert.doesNotMatch(t.stdout.frame(), /Source Replace plan/);
    assert.equal(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'), '# same');

    await t.send('a');
    await t.send('\r');
    frame = t.stdout.frame();
    assert.match(frame, /Confirm SkillsPub intent/);
    assert.match(frame, /Scope · identity · Slot · Relationships/);
    assert.match(frame, /Vercel skills owns security audit and final Proceed/);
    await t.send('\r');
    assert.match(t.stdout.frame(), /Source operation — running|Source operation — Verify truth/);
    frame = await waitForFrame(t, /Source operation — Verify truth/);
    assert.match(frame, /Verify truth/);
    assert.match(frame, /succeeded/);
    assert.match(frame, /Actual:/);
    assert.match(frame, /Desired:/);
    assert.match(frame, /Drift:/);
    assert.match(frame, /Provenance: https:\/\/github\.com\/new\/repo\.git/);
    assert.match(frame, /Slot: same/);
    assert.match(frame, /Relationships: 3/);
    assert.match(frame, /Drift: .*mirror-sync required/);
    assert.match(frame, /Update availability:/);
    assert.match(frame, /next-load Effective Visibility:/);
    assert.equal(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'), '# new/repo\n');
    assert.equal(fs.realpathSync(consumer), fs.realpathSync(source));
    assert.equal(fs.readFileSync(path.join(mirror, 'SKILL.md'), 'utf8'), '# same');
    const finalCatalog = JSON.parse(fs.readFileSync(globalStateFile, 'utf8'));
    assert.deepEqual(finalCatalog.tags[resourceId], ['reviewed']);
    assert.deepEqual(finalCatalog.bundles.tools, [resourceId]);
    assert.deepEqual(finalCatalog.presets.work.selectors, [`skill:${resourceId}`]);
    const finalPolicy = projectScope
      ? JSON.parse(fs.readFileSync(path.join(fixture.project, '.skillspub', 'state.json'), 'utf8'))
      : finalCatalog;
    assert.equal(finalPolicy.baseIntent[sharedSlotId], 'off');
    assert.deepEqual(finalPolicy.claims[sharedSlotId], ['preset:work']);
    await t.send('\r');
    assert.doesNotMatch(t.stdout.frame(), /Source operation — Verify truth/);
    t.unmount();
  }
});

test('Source Add failure stays in Variant C, retries idempotently, and rejects concurrent plan changes in both scopes', async (context) => {
  const environmentKeys = [
    'HOME', 'PATH', 'TUI_GIT_LOG', 'TUI_NPX_LOG', 'TUI_NPX_FAIL_ONCE', 'TUI_NPX_FIND_OUTPUT',
  ];
  const previousEnv = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  context.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  for (const projectScope of [false, true]) {
    const fixture = setupManagedTui([], projectScope);
    const failMarker = path.join(fixture.project, `fail-once-${projectScope}`);
    Object.assign(process.env, {
      ...fixture.env,
      TUI_NPX_FAIL_ONCE: failMarker,
      TUI_NPX_FIND_OUTPUT: [
        'owner/repo@fresh  1 installs',
        '└ https://skills.sh/owner/repo/fresh',
      ].join('\n'),
    });
    const t = await renderApp(
      fixture.home,
      124,
      36,
      projectScope ? fixture.project : undefined,
    );
    await t.send('3');
    await t.send('/');
    await t.send('f');
    await t.send('\r');
    await t.send('a');
    await t.send('\r');
    await t.send('\r');
    let frame = await waitForFrame(t, /Source operation — failed/);
    assert.match(frame, new RegExp(projectScope ? 'exact Project' : 'Global'));
    assert.match(frame, /failed/);
    assert.match(frame, /Raw log:/);
    assert.match(frame, /t retry/);
    await t.send('t');
    frame = await waitForFrame(t, /Source operation — Verify truth/);
    assert.match(frame, /Source operation — Verify truth/);
    assert.match(frame, /succeeded/);
    assert.ok(fs.existsSync(path.join(fixture.discovery, 'fresh', 'SKILL.md')));
    await t.send('\r');

    await t.send('/');
    await t.send('f');
    await t.send('\r');
    await t.send('a');
    const policyFile = projectScope
      ? path.join(fixture.project, '.skillspub', 'state.json')
      : path.join(fixture.home.configDir, 'state.json');
    fs.mkdirSync(path.dirname(policyFile), {recursive: true});
    fs.writeFileSync(policyFile, JSON.stringify({baseIntent: {}, claims: {}}));
    await t.send('\r');
    await t.send('\r');
    frame = await waitForFrame(t, /Source operation — failed/);
    assert.match(frame, /new preview required/i);
    assert.equal(fs.readFileSync(path.join(fixture.discovery, 'fresh', 'SKILL.md'), 'utf8'), '# owner/repo\n');

    const lockFile = projectScope
      ? path.join(fixture.project, 'skills-lock.json')
      : path.join(fixture.env.HOME, '.agents', '.skill-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    lock.skills.fresh.source = 'third/repo';
    lock.skills.fresh.sourceUrl = 'https://github.com/third/repo.git';
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    await t.send('t');
    frame = await waitForFrame(t, /Source operation — failed/);
    assert.match(frame, /Source intent changed/i);
    assert.match(frame, /New preview required/i);
    assert.equal(fs.readFileSync(path.join(fixture.discovery, 'fresh', 'SKILL.md'), 'utf8'), '# owner/repo\n');
    t.unmount();
  }
});

test('TUI shows a detected built-in missing from an older Target registry without writes', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-tui-forward-targets-'));
  const configDir = path.join(root, 'config');
  const userHome = path.join(root, 'home');
  const grokHome = path.join(userHome, '.grok');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(path.join(grokHome, 'config.toml'), '# detected\n');
  const targetFile = path.join(configDir, 'targets.json');
  fs.writeFileSync(targetFile, `${JSON.stringify({
    version: 1,
    overrides: ['claude', 'shared', 'pi'].map((key) => ({
      key,
      discoveryRoot: path.join(userHome, `.${key}`, 'skills'),
      parkingRoot: path.join(userHome, `.${key}`, '.skillspub-off', 'skills'),
      projectPath: `.${key}/skills`,
    })),
    genericTargets: [],
  }, null, 2)}\n`);
  useFixtureEnv(context, { HOME: userHome, GROK_HOME: grokHome });
  const before = fs.readFileSync(targetFile, 'utf8');
  const beforeEntries = fs.readdirSync(root, { recursive: true }).sort();

  const t = await renderApp({ configDir });
  const frame = t.stdout.frame();
  t.unmount();

  assert.match(frame, /grok \[manageable\]/);
  assert.doesNotMatch(frame, /grok \[managed\]/);
  assert.equal(fs.readFileSync(targetFile, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(root, { recursive: true }).sort(), beforeEntries);
});

test('TUI reports a detected built-in pending explicit legacy migration without writes', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-tui-legacy-built-ins-'));
  const configDir = path.join(root, 'config');
  const userHome = path.join(root, 'home');
  const grokHome = path.join(userHome, '.grok');
  const legacyFile = path.join(configDir, 'runtimes.json');
  fs.mkdirSync(configDir, { recursive: true });
  mkSkill(path.join(userHome, '.claude', 'skills'), 'demo');
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(path.join(grokHome, 'config.toml'), '# detected\n');
  fs.writeFileSync(legacyFile, `${JSON.stringify({
    version: 1,
    runtimes: ['claude', 'shared', 'pi'].map((key) => ({
      key,
      kind: key === 'shared' ? 'shared' : 'agent',
      discoveryRoot: path.join(userHome, `.${key}`, 'skills'),
      parkingRoot: path.join(userHome, `.${key}`, '.skillspub-off', 'skills'),
      projectPath: `.${key}/skills`,
    })),
  }, null, 2)}\n`);
  useFixtureEnv(context, { HOME: userHome, GROK_HOME: grokHome });
  const before = fs.readFileSync(legacyFile, 'utf8');
  const beforeEntries = fs.readdirSync(root, { recursive: true }).sort();

  const wide = await renderApp({ configDir }, 100);
  const wideLines = wide.stdout.frame().split('\n');
  wide.unmount();
  const widePending = wideLines.find((line) => line.includes('Pending migration'));
  const wideHarness = wideLines.find((line) => line.includes('Grok Build [manageable]'));
  const wideTarget = wideLines.find((line) => line.includes('claude [managed]'));
  assert.equal(widePending?.indexOf('Pending migration'), 2);
  assert.equal(wideTarget?.indexOf('claude'), 3);
  assert.equal(wideHarness?.indexOf('Grok Build'), 3);

  const narrow = await renderApp({ configDir }, 36);
  let narrowLines = narrow.stdout.frame().split('\n');
  const narrowPending = narrowLines.find((line) => line.includes('Pending'));
  const narrowHarness = narrowLines.find((line) => line.includes('[manageable]') && !line.includes('pi'));
  const narrowTarget = narrowLines.find((line) => line.includes('claude'));
  assert.equal(narrowPending?.indexOf('Pending'), 2);
  assert.equal(narrowTarget?.indexOf('claude'), 3);
  assert.equal(narrowHarness?.indexOf('G'), 3);
  assert.match(narrowPending ?? '', /Pending migration/);
  assert.ok(narrowHarness?.includes('…'));
  assert.ok(narrowTarget?.includes('[ ON ]'));
  assert.match(narrow.stdout.frame(), /Relationships/);
  await narrow.send('j');
  assert.match(narrow.stdout.frame(), /› shared/);
  await narrow.send('k');
  await narrow.send('l');
  narrowLines = narrow.stdout.frame().split('\n');
  assert.ok(narrowLines.some((line) => line.includes('claude') && line.includes('[ ON ]')));
  narrow.unmount();

  assert.equal(fs.readFileSync(legacyFile, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(root, { recursive: true }).sort(), beforeEntries);

  fs.writeFileSync(path.join(configDir, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [{ key: 'grok', disabled: true }],
    genericTargets: [],
  }));
  const canonical = await renderApp({ configDir });
  const canonicalFrame = canonical.stdout.frame();
  canonical.unmount();
  assert.doesNotMatch(canonicalFrame, /Pending|migration/);
});

test('initial projection: first agent selected, all relationship kinds shown, absent excluded', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  const frame = t.stdout.frame();
  assert.match(frame, /Target/);
  assert.match(frame, /Targets/);
  assert.match(frame, /Relationships/);
  assert.match(frame, /Info/);
  // all relationship kinds for agent a, text-first
  assert.match(frame, /\[ ON \] local\s+grilling/);
  assert.match(frame, /\[ ON \] link\s+linked/);
  assert.match(frame, /\[ OFF \] local\s+parked/);
  assert.match(frame, /\[ ON \] link!\s+broken ->/);
  // same-name variants disambiguated, clean names stay clean
  assert.match(frame, /code-review \(/);
  assert.match(frame, /\[ ON \] local\s+grilling/);
  // completely absent skill of agent b is not listed
  assert.doesNotMatch(frame, /only-b/);
  // selected Target summary is visible on wide terminals
  assert.match(frame, /Type: Skill Target/);
  assert.match(frame, /Path:/);
  // focus starts on the agent column, first agent selected
  assert.match(frame, /› a/);
  t.unmount();
});

test('info panel shows bundle, tag, and preset membership of the selected skill', async () => {
  const { home } = setup();
  const grillingId = fs.realpathSync(path.join(home.configDir, 'a-skills', 'grilling'));
  fs.writeFileSync(
    path.join(home.configDir, 'state.json'),
    JSON.stringify({
      bundles: { tools: [grillingId] },
      tags: { [grillingId]: ['interview'] },
      presets: { work: { selectors: [`skill:${grillingId}`] } },
    }),
  );
  const t = await renderApp(home);
  await t.send('l');
  await t.send('j');
  await t.send('j'); // grilling
  const frame = t.stdout.frame();
  assert.match(frame, /Info/);
  assert.match(frame, /Description: Grill the/);
  assert.match(frame, /Bundles: tools/);
  assert.match(frame, /Tags: interview/);
  assert.match(frame, /Presets: work/);
  t.unmount();
});

test('manage modal adds and removes tags for the selected skill', async () => {
  const { home } = setup();
  mkSkill(path.join(home.configDir, 'a-skills'), 'aardvark');
  const grillingId = fs.realpathSync(path.join(home.configDir, 'a-skills', 'grilling'));
  const t = await renderApp(home);
  await t.send('l');
  await t.send('/');
  for (const input of 'grilling') await t.send(input);
  await t.send('\r');
  await t.send('m');

  let frame = t.stdout.frame();
  assert.match(frame, /Manage: grilling/);
  assert.match(frame, /Tags/);
  assert.match(frame, /Presets/);
  assert.match(frame, /Bundles:/);

  // create-in-flow a tag
  await t.send('a');
  assert.match(t.stdout.frame(), /tag name: /);
  for (const input of 'backend') await t.send(input);
  await t.send('\r');
  frame = t.stdout.frame();
  assert.match(frame, /Tagged grilling: backend/);
  assert.match(frame, /› \[x\] backend/);
  const state = () => JSON.parse(
    fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8'));
  assert.deepEqual(state().tags[grillingId], ['backend']);

  // remove it with x
  await t.send('x');
  assert.match(t.stdout.frame(), /Removed tag backend from grilling/);
  assert.equal(state().tags[grillingId], undefined);

  await t.send('\x1b');
  assert.doesNotMatch(t.stdout.frame(), /Manage: grilling/);
  t.unmount();
});

test('manage modal reuses a tag created on another skill', async () => {
  const { home } = setup();
  const grillingId = fs.realpathSync(path.join(home.configDir, 'a-skills', 'grilling'));
  const linkedId = fs.realpathSync(path.join(home.configDir, 'shared', 'real-linked'));
  const t = await renderApp(home);
  await t.send('l');
  await t.send('j');
  await t.send('j'); // grilling
  await t.send('m');
  await t.send('a');
  for (const input of 'cicd') await t.send(input);
  await t.send('\r');
  await t.send('\x1b');

  await t.send('j'); // linked
  await t.send('m');
  let frame = t.stdout.frame();
  assert.match(frame, /Manage: linked/);
  assert.match(frame, /\[ \] cicd/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8')).tags[linkedId], undefined);

  await t.send(' ');
  frame = t.stdout.frame();
  assert.match(frame, /Tagged linked: cicd/);
  assert.match(frame, /\[x\] cicd/);
  const tags = JSON.parse(fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8')).tags;
  assert.deepEqual(tags[grillingId], ['cicd']);
  assert.deepEqual(tags[linkedId], ['cicd']);
  t.unmount();
});

test('manage modal creates presets in flow and toggles membership', async () => {
  const { home } = setup();
  const grillingId = fs.realpathSync(path.join(home.configDir, 'a-skills', 'grilling'));
  const t = await renderApp(home);
  await t.send('l');
  await t.send('j');
  await t.send('j'); // grilling
  await t.send('m');
  await t.send('\t'); // presets section

  await t.send('a');
  for (const input of 'work') await t.send(input);
  await t.send('\r');
  const frame = t.stdout.frame();
  assert.match(frame, /Created preset work with grilling/);
  assert.match(frame, /\[x\] work/);
  const state = () => JSON.parse(
    fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8'));
  assert.deepEqual(state().presets.work.selectors, [`skill:${grillingId}`]);

  await t.send(' '); // toggle membership off
  assert.match(t.stdout.frame(), /Removed grilling from preset work/);
  assert.deepEqual(state().presets.work.selectors, []);
  t.unmount();
});

test('batch mode marks skills and applies a batch tag', async () => {
  const { home } = setup();
  const grillingId = fs.realpathSync(path.join(home.configDir, 'a-skills', 'grilling'));
  const linkedId = fs.realpathSync(path.join(home.configDir, 'shared', 'real-linked'));
  const t = await renderApp(home);
  await t.send('v');
  assert.match(t.stdout.frame(), /0 marked/);
  await t.send('l');
  await t.send('j');
  await t.send('j'); // grilling
  await t.send(' ');
  assert.match(t.stdout.frame(), /1 marked/);
  await t.send('j'); // linked
  await t.send(' ');
  const frame = t.stdout.frame();
  assert.match(frame, /2 marked/);
  assert.match(frame, /●/);
  await t.send('t');
  for (const input of 'tools') await t.send(input);
  await t.send('\r');
  assert.match(t.stdout.frame(), /Tagged 2 skills: tools/);
  const state = () => JSON.parse(
    fs.readFileSync(path.join(home.configDir, 'state.json'), 'utf8'));
  assert.deepEqual(state().tags[grillingId], ['tools']);
  assert.deepEqual(state().tags[linkedId], ['tools']);
  await t.send('v'); // exit clears marks
  assert.doesNotMatch(t.stdout.frame(), /2 marked/);
  t.unmount();
});

test('batch off previews per-row plans and applies on confirm', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('v');
  await t.send('l');
  await t.send('j');
  await t.send('j'); // grilling
  await t.send(' ');
  await t.send('O');
  const frame = t.stdout.frame();
  assert.match(frame, /Batch off @ a\?/);
  assert.match(frame, /global:a\/grilling {2}on -> off/);
  await t.send('y');
  assert.ok(fs.existsSync(
    path.join(home.configDir, '.skillspub-off', 'a-skills', 'grilling', 'SKILL.md')));
  assert.match(t.stdout.frame(), /Batch off @ a: 1 applied/);
  assert.match(t.stdout.frame(), /1 marked/); // mark survives the move to parking
  t.unmount();
});

test('batch off keeps marks on moved (local) and removed (link) rows', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('v');
  await t.send('l');
  await t.send('j');
  await t.send('j'); // grilling (local)
  await t.send(' ');
  await t.send('j'); // linked (link)
  await t.send(' ');
  await t.send('O');
  await t.send('y');
  assert.match(t.stdout.frame(), /Batch off @ a: 2 applied/);
  assert.match(t.stdout.frame(), /2 marked/);
  t.unmount();
});

test('batch marks clear on tab switch', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('v');
  await t.send('l');
  await t.send('j');
  await t.send('j');
  await t.send(' ');
  assert.match(t.stdout.frame(), /1 marked/);
  await t.send('\t');
  assert.match(t.stdout.frame(), /0 marked/);
  t.unmount();
});

test('project TUI badges the project and intercepts inherited mutations', async () => {
  const { home } = setup();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-proj-'));
  const t = await renderApp(home, 100, 30, projectDir);
  const frame = t.stdout.frame();
  assert.match(frame, /Project:/);
  assert.match(frame, /·global/);
  await t.send('l');
  await t.send('j');
  await t.send('j'); // grilling (inherited global ON)
  await t.send(' ');
  assert.match(t.stdout.frame(), /read-only: inherited from global/);
  assert.doesNotMatch(t.stdout.frame(), / i /);
  t.unmount();
});

test('project TUI Space enables an inherited OFF skill in this project', async () => {
  const { home } = setup();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-proj-'));
  const t = await renderApp(home, 100, 30, projectDir);
  await t.send('l');
  for (let i = 0; i < 4; i++) await t.send('j'); // parked (inherited global OFF)
  assert.match(t.stdout.frame(), /› \[ OFF \] local\s+parked/);
  assert.doesNotMatch(t.stdout.frame(), / i link/);
  await t.send(' ');
  const frame = t.stdout.frame();
  assert.doesNotMatch(frame, /Link relationship\?/);
  assert.match(frame, /parked @ a: on/);
  assert.match(frame, /› \[ ON \] link\s+parked/);
  const link = path.join(projectDir, '.a', 'skills', 'parked');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  t.unmount();
});

test('project TUI Space enables a missing skill in this project', async () => {
  const { home } = setup();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-proj-'));
  const t = await renderApp(home, 100, 30, projectDir);
  await t.send('\t');
  for (let i = 0; i < 5; i++) await t.send('j'); // only-b
  await t.send('l');
  assert.match(t.stdout.frame(), /› a {2}missing/);
  assert.match(t.stdout.frame(), / space on/);
  assert.doesNotMatch(t.stdout.frame(), / i link/);
  await t.send(' ');
  assert.doesNotMatch(t.stdout.frame(), /Link relationship\?/);
  assert.match(t.stdout.frame(), /only-b @ a: on/);
  assert.ok(fs.lstatSync(path.join(projectDir, '.a', 'skills', 'only-b')).isSymbolicLink());
  t.unmount();
});

test('project TUI batch-on skips inherited ON and enables inherited OFF', async () => {
  const { home } = setup();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-proj-'));
  const t = await renderApp(home, 100, 30, projectDir);
  await t.send('v');
  await t.send('l');
  await t.send('j');
  await t.send('j'); // grilling (inherited ON)
  await t.send(' ');
  await t.send('j');
  await t.send('j'); // parked (inherited OFF)
  await t.send(' ');
  await t.send('o');
  const frame = t.stdout.frame();
  assert.match(frame, /Batch on @ a\?/);
  assert.match(frame, /missing -> on/);
  assert.doesNotMatch(frame, /grilling/);
  await t.send('y');
  const after = t.stdout.frame();
  assert.match(after, /Batch on @ a: 1 applied/);
  assert.match(after, /› \[ ON \] link\s+parked/);
  assert.match(after, /2 marked/);
  assert.ok(!fs.existsSync(path.join(projectDir, '.a', 'skills', 'grilling')));
  assert.ok(fs.lstatSync(path.join(projectDir, '.a', 'skills', 'parked')).isSymbolicLink());
  t.unmount();
});

test('project TUI R refresh keeps the project snapshot', async () => {
  const { home } = setup();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-proj-'));
  const t = await renderApp(home, 100, 30, projectDir);
  assert.match(t.stdout.frame(), /Project:/);
  await t.send('R');
  assert.match(t.stdout.frame(), /Project:/); // not reverted to the global snapshot
  t.unmount();
});

test('project TUI intercepts unlink on an inherited link', async () => {
  const { home } = setup();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-proj-'));
  const t = await renderApp(home, 100, 30, projectDir);
  await t.send('l');
  await t.send('j');
  await t.send('j');
  await t.send('j'); // linked (inherited global link)
  await t.send('u');
  assert.match(t.stdout.frame(), /read-only: inherited from global/);
  // the link is untouched
  assert.ok(fs.lstatSync(path.join(home.configDir, 'a-skills', 'linked')).isSymbolicLink());
  t.unmount();
});

test('project TUI toggles a project-scope skill off into project parking', async () => {
  const { home } = setup();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-proj-'));
  const projSkills = path.join(projectDir, '.a', 'skills');
  fs.mkdirSync(projSkills, { recursive: true });
  fs.symlinkSync(
    path.join(home.configDir, 'a-skills', 'grilling'),
    path.join(projSkills, 'grilling'));
  const t = await renderApp(home, 100, 30, projectDir);
  await t.send('\t'); // skill tab
  await t.send('j');
  await t.send('j');
  await t.send('j'); // grilling row
  await t.send('l'); // agents column, a selected
  await t.send(' ');
  const frame = t.stdout.frame();
  assert.match(frame, /grilling @ a: off/);
  assert.match(frame, /› grilling/);
  assert.ok(fs.existsSync(path.join(projectDir, '.skillspub', 'off', 'a', 'grilling')));
  assert.ok(!fs.existsSync(path.join(projSkills, 'grilling')));
  t.unmount();
});

test('horizontal navigation moves focus between actionable columns only', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  assert.match(t.stdout.frame(), /› a/);
  await t.send('l');
  // first entry in registry scan order is the broken symlink row
  assert.match(t.stdout.frame(), /› \[ ON \] link!\s+broken/);
  // the unfocused agent column still marks the selected agent
  assert.match(t.stdout.frame(), /› a/);
  // further right never lands on the passive summary; left returns to agents
  await t.send('l');
  assert.match(t.stdout.frame(), /› \[ ON \] link!\s+broken/);
  await t.send('h');
  assert.match(t.stdout.frame(), /› a/);
  t.unmount();
});

test('narrow terminal hides only the passive summary', async () => {
  const { home } = setup();
  const t = await renderApp(home, 60, 30);
  const frame = t.stdout.frame();
  assert.doesNotMatch(frame, /Info/);
  assert.doesNotMatch(frame, /Source:/);
  // both actionable columns remain
  assert.match(frame, /Targets/);
  assert.match(frame, /\[ ON \] local\s+grilling/);
  // details stay reachable via Enter even with the summary hidden
  await t.send('l');
  await t.send('\r');
  assert.match(t.stdout.frame(), /SKILL\.md — broken/);
  assert.match(t.stdout.frame(), /SKILL.md unavailable/);
  t.unmount();
});

test('Enter opens a scrollable modal; Esc closes it and preserves selection', async () => {
  const { home } = setup();
  const body = ['---', 'description: long', '---', `long-${'x'.repeat(120)}-TAIL`];
  for (let i = 1; i <= 40; i++) body.push(`line-${String(i).padStart(2, '0')}`);
  mkSkill(path.join(home.configDir, 'a-skills'), 'long-doc', body.join('\n'));
  const t = await renderApp(home, 100, 24);
  await t.send('l');
  // select long-doc (entries for agent a: broken, code-review, grilling, linked, long-doc, parked)
  for (let i = 0; i < 4; i++) await t.send('j');
  assert.match(t.stdout.frame(), /› \[ ON \] local\s+long-doc/);
  await t.send('\r');
  let frame = t.stdout.frame();
  assert.match(frame, /SKILL\.md — long-doc\s+\[1\/\d+\]/);
  assert.match(frame, /TAIL/);
  assert.match(frame, /line-01/);
  assert.doesNotMatch(frame, /line-40/);
  // scroll down, then close with Esc
  for (let i = 0; i < 30; i++) await t.send('j');
  frame = t.stdout.frame();
  assert.match(frame, /line-40/);
  await t.send('\x1b');
  frame = t.stdout.frame();
  assert.doesNotMatch(frame, /SKILL\.md — long-doc/);
  assert.match(frame, /› \[ ON \] local\s+long-doc/);
  t.unmount();
});

test('skill tab lists every live instance/variant and per-agent states', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('\t');
  const frame = t.stdout.frame();
  assert.match(frame, /Skills/);
  // every instance/variant gets a row, not one row per name
  assert.equal((frame.match(/│ {2}code-review/g) ?? []).length, 2);
  assert.match(frame, /only-b/);
  // first instance is the broken symlink: broken for a, missing for b (registry order)
  assert.match(frame, /a {2}\[ ON \] link!/);
  assert.match(frame, /b {2}missing/);
  t.unmount();
});

test('skill tab prioritizes long skill names over compact agent statuses', async () => {
  const { home } = setup();
  const name = 'long-skill-name-that-stays-fully-readable';
  mkSkill(path.join(home.configDir, 'a-skills'), name);
  const t = await renderApp(home);
  await t.send('\t');

  assert.match(t.stdout.frame(), new RegExp(name));
  t.unmount();
});

test('TUI keeps multi-word agent names and statuses readable', async () => {
  const { home } = setup();
  const a = path.join(home.configDir, 'a-skills');
  const b = path.join(home.configDir, 'b-skills');
  fs.writeFileSync(
    path.join(home.configDir, 'agents.conf'),
    `claude code = ${a}\ncodex = ${b}\n`,
  );
  const t = await renderApp(home);
  assert.match(t.stdout.frame(), /› claude code/);
  await t.send('\t');
  for (let i = 0; i < 3; i++) await t.send('j'); // grilling
  await t.send('l');

  assert.match(t.stdout.frame(), /› claude code {2}\[ ON \] local/);
  t.unmount();
});

test('skill tab: missing is distinct from off', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('\t');
  // instances: broken, code-review x2, grilling, linked, only-b, parked
  for (let i = 0; i < 6; i++) await t.send('j');
  const frame = t.stdout.frame();
  assert.match(frame, /› parked/);
  // parked is off for a but missing for b — the two states stay distinct
  assert.match(frame, /a {2}\[ OFF \] local/);
  assert.match(frame, /b {2}missing/);
  t.unmount();
});

test('skill tab: horizontal focus moves Skills ↔ Agents, never the summary', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('\t');
  assert.match(t.stdout.frame(), /› broken/);
  await t.send('l');
  assert.match(t.stdout.frame(), /› a {2}\[ ON \] link!/);
  // further right never lands on the passive summary; left returns to skills
  await t.send('l');
  assert.match(t.stdout.frame(), /› a {2}\[ ON \] link!/);
  await t.send('h');
  assert.match(t.stdout.frame(), /› broken/);
  t.unmount();
});

test('skill tab: tab switch preserves the selected instance identity', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('\t');
  for (let i = 0; i < 3; i++) await t.send('j');
  assert.match(t.stdout.frame(), /› grilling/);
  await t.send('\t'); // to agent tab
  assert.match(t.stdout.frame(), /Relationships/);
  await t.send('\t'); // back to skill tab
  const frame = t.stdout.frame();
  assert.match(frame, /Skills/);
  assert.match(frame, /› grilling/);
  t.unmount();
});

test('skill tab: narrow terminal hides only the passive summary', async () => {
  const { home } = setup();
  const t = await renderApp(home, 60, 30);
  await t.send('\t');
  const frame = t.stdout.frame();
  assert.doesNotMatch(frame, /Info/);
  assert.doesNotMatch(frame, /Source:/);
  assert.match(frame, /Skills/);
  assert.match(frame, /b {2}missing/);
  t.unmount();
});

test('skill tab: Enter opens the exact selected variant; Esc returns to tab and selection', async () => {
  const { home } = setup();
  fs.writeFileSync(
    path.join(home.configDir, 'other', 'code-review', 'SKILL.md'),
    '# VARIANT-B',
  );
  const t = await renderApp(home);
  await t.send('\t');
  await t.send('j'); // code-review (a-skills)
  await t.send('j'); // code-review (other)
  await t.send('\r');
  assert.match(t.stdout.frame(), /VARIANT-B/);
  await t.send('\x1b');
  const frame = t.stdout.frame();
  assert.match(frame, /Skills/); // still on the skill tab
  // selection kept the exact variant: reopening shows the same content
  await t.send('\r');
  assert.match(t.stdout.frame(), /VARIANT-B/);
  t.unmount();
});

test('search filters loaded metadata and keeps the selected instance when cleared', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('\t');
  for (let i = 0; i < 3; i++) await t.send('j');
  assert.match(t.stdout.frame(), /› grilling/);

  await t.send('/');
  for (const input of 'GRILL') await t.send(input);
  assert.match(t.stdout.frame(), /Search: GRILL/);
  assert.match(t.stdout.frame(), /› grilling/);
  assert.doesNotMatch(t.stdout.frame(), /only-b/);
  await t.send('\x1b');
  assert.match(t.stdout.frame(), /› grilling/);
  assert.match(t.stdout.frame(), /only-b/);

  await t.send('/');
  for (const input of 'body-only') await t.send(input);
  assert.doesNotMatch(t.stdout.frame(), /grilling/);
  t.unmount();
});

test('s cycles the visible sort order without changing selected identity', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('\t');
  for (let i = 0; i < 3; i++) await t.send('j');
  assert.match(t.stdout.frame(), /› grilling/);

  await t.send('s');
  assert.match(t.stdout.frame(), /Sort: Status/);
  assert.match(t.stdout.frame(), /› grilling/);
  await t.send('s');
  assert.match(t.stdout.frame(), /Sort: Source/);
  assert.match(t.stdout.frame(), /› grilling/);
  await t.send('s');
  assert.match(t.stdout.frame(), /Sort: Name/);
  assert.match(t.stdout.frame(), /› grilling/);
  t.unmount();
});

test('R reloads disk changes and preserves selected skill and agent identities', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('\t');
  for (let i = 0; i < 3; i++) await t.send('j');
  await t.send('l');
  await t.send('j');
  assert.match(t.stdout.frame(), /› b {2}missing/);

  mkSkill(path.join(home.configDir, 'a-skills'), 'new-on-disk');
  await t.send('R');
  assert.match(t.stdout.frame(), /new-on-disk/);
  await t.send('h');
  assert.match(t.stdout.frame(), /› grilling/);
  await t.send('l');
  assert.match(t.stdout.frame(), /› b {2}missing/);

  fs.rmSync(path.join(home.configDir, 'a-skills', 'grilling'), {recursive: true});
  await t.send('R');
  await t.send('h');
  assert.match(t.stdout.frame(), /› broken/);
  await t.send('l');
  assert.match(t.stdout.frame(), /› b {2}missing/);
  t.unmount();
});

test('broken relationships keep activation and resource form visible', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('l');
  assert.match(t.stdout.frame(), /› \[ ON \] link!\s+broken ->/);
  await t.send(' ');
  assert.match(t.stdout.frame(), /› \[ OFF \] link!\s+broken ->/);
  t.unmount();
});

test('Agent projection toggles the selected local relationship immediately', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('l');
  await t.send('j');
  await t.send('j'); // grilling
  await t.send(' ');

  assert.ok(fs.existsSync(path.join(home.configDir, '.skillspub-off', 'a-skills', 'grilling', 'SKILL.md')));
  assert.match(t.stdout.frame(), /grilling @ a: off/);
  assert.match(t.stdout.frame(), /\[ OFF \] local\s+grilling/);
  t.unmount();
});

test('relationship statuses pad to a fixed width so skill names align', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('l');
  const lines = t.stdout.frame().split('\n');
  const grilling = lines.find((l) => l.includes('[ ON ] local') && l.includes('grilling'));
  const linked = lines.find((l) => l.includes('[ ON ] link') && l.includes('linked'));
  const broken = lines.find((l) => l.includes('link!'));
  assert.ok(grilling && linked && broken);
  assert.equal(grilling.indexOf('grilling'), linked.indexOf('linked'));
  assert.equal(linked.indexOf('linked'), broken.indexOf('broken', broken.indexOf('link!')));
  t.unmount();
});

test('agent tab keeps the operated relationship selected after toggle', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('l');
  await t.send('j');
  await t.send('j'); // grilling
  await t.send(' ');

  const frame = t.stdout.frame();
  // the entry moved to parking, but the marker follows it — not back to the first entry
  assert.match(frame, /› \[ OFF \] local\s+grilling/);
  assert.doesNotMatch(frame, /› \[ ON \] link!/);
  t.unmount();
});

test('skill tab keeps the operated instance selected after toggling an agent runtime', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('\t');
  for (let i = 0; i < 3; i++) await t.send('j'); // grilling
  await t.send('l'); // agents column
  await t.send(' '); // toggle grilling off for a: the local dir moves, its realPath changes

  const frame = t.stdout.frame();
  assert.match(frame, /› grilling/);
  assert.match(frame, /› a {2}\[ OFF \] local/);
  t.unmount();
});

test('Agent projection keeps aliases to one instance independently selectable', async () => {
  const { home } = setup();
  const a = path.join(home.configDir, 'a-skills');
  fs.symlinkSync(path.join(a, 'linked'), path.join(a, 'linked-alias'));
  const t = await renderApp(home);
  await t.send('l');
  for (let i = 0; i < 4; i++) await t.send('j');
  assert.match(t.stdout.frame(), /› \[ ON \] link\s+linked-alias/);

  await t.send(' ');
  assert.ok(fs.lstatSync(path.join(a, 'linked')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(home.configDir, '.skillspub-off', 'a-skills', 'linked-alias')).isSymbolicLink());
  t.unmount();
});

test('Agent projection distinguishes on and off entries with the same name and instance', async () => {
  const { home } = setup();
  const a = path.join(home.configDir, 'a-skills');
  const sourceRoot = path.join(home.configDir, 'same-source');
  mkSkill(sourceRoot, 'dual');
  const source = path.join(sourceRoot, 'dual');
  fs.symlinkSync(source, path.join(a, 'dual'));
  fs.symlinkSync(source, path.join(home.configDir, '.skillspub-off', 'a-skills', 'dual'));
  const t = await renderApp(home);
  await t.send('l');
  // discovery entries scan before parking entries: ON dual is selectable separately
  for (let i = 0; i < 2; i++) await t.send('j');
  assert.match(t.stdout.frame(), /› \[ ON \] link\s+dual/);
  await t.send('j');
  assert.match(t.stdout.frame(), /› \[ OFF \] link\s+dual/);

  // on+off in one Target Slot is an on-off-conflict: unlink refuses the ambiguous Slot
  await t.send('u');
  await t.send('y');
  assert.match(t.stdout.frame(), /ambiguous or occupied/);
  assert.ok(fs.lstatSync(path.join(a, 'dual')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(home.configDir, '.skillspub-off', 'a-skills', 'dual')).isSymbolicLink());
  t.unmount();
});

test('Skill projection confirms link and unlink before changing disk', async () => {
  const { home } = setup();
  const target = path.join(home.configDir, 'b-skills', 'grilling');
  const t = await renderApp(home, 60);
  await t.send('\t');
  for (let i = 0; i < 3; i++) await t.send('j'); // grilling
  await t.send('l');
  await t.send('j'); // agent b is missing

  await t.send('i');
  assert.match(t.stdout.frame(), /Link relationship\?/);
  assert.match(t.stdout.frame(), /a-skills/);
  assert.match(t.stdout.frame(), /→/);
  assert.match(t.stdout.frame(), /b-skills/);
  assert.equal((t.stdout.frame().match(/grilling/g) ?? []).length, 2);
  await t.send('n');
  assert.throws(() => fs.lstatSync(target));
  assert.match(t.stdout.frame(), /› b {2}missing/);

  await t.send('i');
  await t.send('y');
  assert.ok(fs.lstatSync(target).isSymbolicLink());
  assert.match(t.stdout.frame(), /Linked/);

  await t.send('u');
  assert.match(t.stdout.frame(), /Unlink relationship\?/);
  await t.send('n');
  assert.ok(fs.lstatSync(target).isSymbolicLink());
  await t.send('u');
  await t.send('y');
  assert.throws(() => fs.lstatSync(target));
  assert.ok(fs.existsSync(path.join(home.configDir, 'a-skills', 'grilling', 'SKILL.md')));
  t.unmount();
});

test('unlinking the sole relationship drops out-of-registry sources from the fresh snapshot', async () => {
  const { home } = setup();
  const source = path.join(home.configDir, 'shared', 'real-linked', 'SKILL.md');
  const t = await renderApp(home);
  await t.send('l');
  for (let i = 0; i < 3; i++) await t.send('j'); // linked
  await t.send('u');
  await t.send('y');
  await t.send('\t');

  assert.ok(fs.existsSync(source));
  assert.doesNotMatch(t.stdout.frame(), /[│]›? ?linked(?:\s|$)/);
  await t.send('R');
  assert.doesNotMatch(t.stdout.frame(), /[│]›? ?linked(?:\s|$)/);
  t.unmount();
});

test('TUI separates Harness capability from current state in the target list and info', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-tui-harnesses-'));
  const piHome = path.join(configDir, 'pi');
  fs.mkdirSync(path.join(piHome, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [
      { key: 'claude', disabled: true },
      { key: 'grok', disabled: true },
      {
        key: 'pi',
        discoveryRoot: path.join(piHome, 'agent', 'skills'),
        parkingRoot: path.join(piHome, 'agent', '.skillspub-off', 'skills'),
      },
      {
        key: 'shared',
        discoveryRoot: path.join(configDir, 'agents', 'skills'),
        parkingRoot: path.join(configDir, 'agents', '.skillspub-off', 'skills'),
        lockFile: path.join(configDir, 'agents', '.skill-lock.json'),
      },
    ],
    genericTargets: [],
  }));

  const t = await renderApp({ configDir });
  let frame = t.stdout.frame();
  assert.doesNotMatch(frame, /Detected Harnesses|Skill Targets/);
  assert.match(frame, /pi\s+\[discoverable\]/);
  assert.doesNotMatch(frame, /pi\s+\[managed\]/);

  await t.send('j'); // pi
  frame = t.stdout.frame();
  assert.match(frame, /Harness:\s*Pi/);
  assert.match(frame, /Detected:\s*yes/);
  assert.match(frame, /Adapter support:/);
  assert.match(frame, /discoverable/);
  assert.match(frame, /Shared consumption:/);
  assert.match(frame, /enabled/);
  assert.match(frame, /Isolation:\s*unmanaged/);
  assert.doesNotMatch(frame, /Managed support: verified|Adapter can control and/);
  assert.match(frame, /Link:\s*supported/);

  const settingsFile = path.join(piHome, 'agent', 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({skills: ['!skills/**']}));
  fs.writeFileSync(path.join(configDir, 'state.json'), JSON.stringify({
    piIsolation: {file: settingsFile, exclusion: '!skills/**'},
  }));
  await t.send('R');
  frame = t.stdout.frame();
  assert.match(frame, /pi\s+\[discoverable\]/);
  assert.doesNotMatch(frame, /pi\s+\[managed\]/);
  assert.match(frame, /Isolation:\s*drift/);
  t.unmount();
});

test('TUI reports Grok managed Mirror capability without writing Grok files', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-tui-grok-'));
  const grokHome = path.join(configDir, 'grok-home');
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(path.join(grokHome, 'config.toml'), '# untouched\n');
  fs.writeFileSync(path.join(configDir, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [
      { key: 'claude', disabled: true },
      { key: 'pi', disabled: true },
      {
        key: 'grok',
        discoveryRoot: path.join(grokHome, 'skills'),
        parkingRoot: path.join(grokHome, '.skillspub-off', 'skills'),
      },
      {
        key: 'shared',
        discoveryRoot: path.join(configDir, 'agents', 'skills'),
        parkingRoot: path.join(configDir, 'agents', '.skillspub-off', 'skills'),
      },
    ],
    genericTargets: [],
  }));
  const before = fs.readdirSync(configDir, { recursive: true }).sort();

  const t = await renderApp({ configDir });
  await t.send('j');
  const frame = t.stdout.frame();
  assert.match(frame, /Harness:\s*Grok Build/);
  assert.match(frame, /Adapter support:\s*managed/);
  assert.match(frame, /Link:\s*unsupported/);
  assert.match(frame, /Mirror:\s*supported/);
  assert.deepEqual(fs.readdirSync(configDir, { recursive: true }).sort(), before);
  t.unmount();
});

test('TUI keeps undetected Harnesses in a compact Available section', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-tui-harness-setup-'));
  const piHome = path.join(configDir, 'pi');
  fs.writeFileSync(path.join(configDir, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [
      { key: 'claude', disabled: true },
      { key: 'grok', disabled: true },
      {
        key: 'pi',
        discoveryRoot: path.join(piHome, 'agent', 'skills'),
        parkingRoot: path.join(piHome, 'agent', '.skillspub-off', 'skills'),
      },
      {
        key: 'shared',
        discoveryRoot: path.join(configDir, 'agents', 'skills'),
        parkingRoot: path.join(configDir, 'agents', '.skillspub-off', 'skills'),
        lockFile: path.join(configDir, 'agents', '.skill-lock.json'),
      },
    ],
    genericTargets: [],
  }));

  for (const columns of [100, 36]) {
    const t = await renderApp({ configDir }, columns);
    const lines = t.stdout.frame().split('\n');
    const heading = lines.find((line) => line.includes('Available'));
    const harness = lines.find((line) => line.includes('Pi'));
    assert.equal(heading?.indexOf('Available'), 2);
    assert.equal(harness?.indexOf('Pi'), 3);
    assert.match(t.stdout.frame(), /\[discover(?:able)?\]/);
    assert.doesNotMatch(t.stdout.frame(), /Pi \[managed\]/);
    assert.doesNotMatch(t.stdout.frame(), /Shared enabled|Isolation unmanaged/);
    t.unmount();
  }
});

test('narrow TUI opens Harness details from a selected Target', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-tui-harness-modal-'));
  const piHome = path.join(configDir, 'pi');
  fs.mkdirSync(path.join(piHome, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'targets.json'), JSON.stringify({
    version: 1,
    overrides: [{ key: 'claude', disabled: true }, { key: 'grok', disabled: true }, {
      key: 'pi',
      discoveryRoot: path.join(piHome, 'agent', 'skills'),
      parkingRoot: path.join(piHome, 'agent', '.skillspub-off', 'skills'),
    }],
    genericTargets: [],
  }));

  const t = await renderApp({ configDir }, 60);
  await t.send('j'); // pi
  await t.send('\r');
  const frame = t.stdout.frame();
  assert.match(frame, /Harness:\s*Pi/);
  assert.match(frame, /Shared consumption:\s*enabled/);
  assert.match(frame, /Isolation:\s*unmanaged/);
  assert.match(frame, /esc close/);
  t.unmount();
});

test('footer reflects available navigation actions and modal state', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  assert.match(t.stdout.frame(), /enter details/);
  assert.match(t.stdout.frame(), /\/ search/);
  assert.match(t.stdout.frame(), /s sort:Name/);
  assert.match(t.stdout.frame(), /R refresh/);
  // read-only slice: no mutation actions in the footer
  assert.doesNotMatch(t.stdout.frame().split('\n').pop() ?? '', /toggle|space|unlink/i);
  await t.send('l');
  assert.match(t.stdout.frame(), /enter SKILL\.md/);
  await t.send('\r');
  assert.match(t.stdout.frame(), /esc close/);
  assert.doesNotMatch(t.stdout.frame(), /R refresh/);
  t.unmount();
});

test('Skill detail shows every built-in Effective Visibility result and not-detected explicitly', async () => {
  const detected = setupVisibilityTui();
  const t = await renderApp(detected.home, 140, 34);
  await t.send('\t');
  let frame = t.stdout.frame();
  assert.match(frame, /Effective Visibility/);
  assert.match(frame, /Claude Code: not-visible/);
  assert.match(frame, /Grok Build: unknown/);
  assert.match(frame, /Pi: unknown/);
  assert.match(frame, /e explain/);
  t.unmount();

  const unavailable = setupVisibilityTui({grokDetected: false});
  const u = await renderApp(unavailable.home, 140, 34);
  await u.send('\t');
  frame = u.stdout.frame();
  assert.match(frame, /Grok Build: unknown · not-detected/);
  u.unmount();
});

test('Explain modal projects evidence and read-only visible/hidden plans for each Harness', async () => {
  const {home, roots} = setupVisibilityTui();
  const before = fs.readdirSync(home.configDir, {recursive: true}).sort();
  const t = await renderApp(home, 120, 38);
  await t.send('\t');
  await t.send('e');

  let frame = t.stdout.frame();
  assert.match(frame, /Explain — demo — Claude Code \[1\/3\]/);
  assert.match(frame, /Result: not-visible/);
  assert.match(frame, /Adapter support: managed/);
  assert.match(frame, /Shared consumption: not-consumed/);
  assert.match(frame, /Isolation: not-required/);
  assert.match(frame, /Evidence:/);
  assert.match(frame, /consumed global\/harness/);
  assert.match(frame, /excluded global\/shared/);

  await t.send('v');
  frame = t.stdout.frame();
  assert.match(frame, /Wanted: visible/);
  assert.match(frame, /Executable: yes/);
  assert.match(frame, /create-link global:claude\/demo/);
  assert.equal(fs.existsSync(path.join(roots.claude, 'demo')), false);

  await t.send('h');
  frame = t.stdout.frame();
  assert.match(frame, /Wanted: hidden/);
  assert.match(frame, /Executable: yes/);

  await t.send('\t');
  frame = t.stdout.frame();
  assert.match(frame, /Explain — demo — Grok Build \[2\/3\]/);
  assert.match(frame, /Result: unknown/);
  for (let i = 0; i < 10; i++) await t.send('j');
  frame = t.stdout.frame();
  assert.match(frame, /warning: Local Grok Build/);
  assert.match(frame, /version was not confirmed/);
  await t.send('v');
  for (let i = 0; i < 20; i++) await t.send('j');
  assert.match(t.stdout.frame(), /blocker: Effective visibility is unknown/);

  await t.send('\t');
  frame = t.stdout.frame();
  assert.match(frame, /Explain — demo — Pi \[3\/3\]/);
  assert.match(frame, /Result: unknown/);
  assert.match(frame, /Adapter support: discoverable/);
  assert.match(frame, /Shared consumption: excluded/);
  assert.match(frame, /on link selected/);
  assert.deepEqual(fs.readdirSync(home.configDir, {recursive: true}).sort(), before);
  t.unmount();
});

test('Explain modal shows Variant conflicts and a consumed Shared bypass', async () => {
  const conflicted = setupVisibilityTui();
  mkSkill(conflicted.roots.claude, 'demo', '# competing demo');
  const c = await renderApp(conflicted.home, 120, 34);
  await c.send('j'); // Shared Target
  await c.send('l'); // selected Shared resource
  assert.match(c.stdout.frame(), /Claude Code: conflicted/);
  await c.send('e');
  assert.match(c.stdout.frame(), /Result: conflicted/);
  assert.match(c.stdout.frame(), /conflict:/);
  assert.match(c.stdout.frame(), /competes in consumed root/);
  await c.send('v');
  assert.match(c.stdout.frame(), /blocker: Resolve same-name Variants/);
  c.unmount();

  const bypass = setupVisibilityTui();
  fs.rmSync(path.join(path.dirname(bypass.roots.pi), 'settings.json'));
  fs.rmSync(path.join(bypass.roots.pi, 'demo'));
  const parked = path.join(path.dirname(bypass.roots.pi), '.skillspub-off', 'skills');
  fs.mkdirSync(parked, {recursive: true});
  fs.symlinkSync(bypass.resource, path.join(parked, 'demo'));
  const b = await renderApp(bypass.home, 120, 34);
  await b.send('\t');
  await b.send('e');
  await b.send('\t');
  await b.send('\t');
  let frame = b.stdout.frame();
  assert.match(frame, /Result: unknown/);
  assert.match(frame, /Adapter support: discoverable/);
  assert.match(frame, /consumed global\/shared/);
  assert.match(frame, /off link selected/);
  for (let i = 0; i < 12; i++) await b.send('j');
  frame = b.stdout.frame();
  assert.match(frame, /on local selected/);
  await b.send('h');
  assert.match(b.stdout.frame(), /blocker: Pi support is not managed/);
  assert.match(b.stdout.frame(), /Effective visibility is unknown/);
  b.unmount();
});

test('Project Explain stays reachable when narrow and Esc preserves exact selection', async () => {
  const {home, resource} = setupVisibilityTui();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-tui-explain-project-'));
  const projectClaude = path.join(project, '.claude', 'skills');
  fs.mkdirSync(projectClaude, {recursive: true});
  fs.symlinkSync(resource, path.join(projectClaude, 'demo'));
  const before = fs.readdirSync(project, {recursive: true}).sort();
  const t = await renderApp(home, 62, 28, project);
  await t.send('\t');
  assert.match(t.stdout.frame(), /› demo/);
  assert.match(t.stdout.frame(), /e explain/);
  await t.send('e');
  let frame = t.stdout.frame();
  assert.match(frame, /Result: visible/);
  assert.match(frame, /j\/k scroll/);
  for (let i = 0; i < 12; i++) await t.send('j');
  frame = t.stdout.frame();
  assert.match(frame, /consumed project\/harness/);
  for (let i = 0; i < 6; i++) await t.send('j');
  assert.match(t.stdout.frame(), /on link selected/);
  await t.send('\x1b');
  frame = t.stdout.frame();
  assert.match(frame, /Skills/);
  assert.match(frame, /› demo/);
  await t.send('s');
  await t.send('R');
  assert.match(t.stdout.frame(), /› demo/);
  assert.deepEqual(fs.readdirSync(project, {recursive: true}).sort(), before);
  t.unmount();
});

test('TUI startup reads availability cache only and shows stale cache as unknown', async (context) => {
  const fixture = setupManagedTui([
    {name: 'cached', source: 'owner/repo', hash: 'cached-hash'},
  ]);
  useFixtureEnv(context, fixture.env);
  process.env.TUI_GIT_TREES = JSON.stringify({
    'https://github.com/owner/repo.git': {'skills/cached': 'cached-hash'},
  });
  sharedRefresh(fixture.home);
  const callsBeforeRender = fs.readFileSync(fixture.gitLog, 'utf8');

  const t = await renderApp(fixture.home, 130, 30);
  await t.send('\t');
  let frame = t.stdout.frame();
  assert.match(frame, /Update availability: current/);
  assert.match(frame, /cached · current @ \d{4}-\d{2}-\d{2}T/);
  assert.equal(fs.readFileSync(fixture.gitLog, 'utf8'), callsBeforeRender);
  await t.send('R');
  assert.equal(fs.readFileSync(fixture.gitLog, 'utf8'), callsBeforeRender);
  t.unmount();

  fs.appendFileSync(path.join(fixture.discovery, 'cached', 'SKILL.md'), '\n# local change');
  const stale = await renderApp(fixture.home, 130, 30);
  await stale.send('\t');
  frame = stale.stdout.frame();
  assert.match(frame, /Update availability: unknown/);
  assert.doesNotMatch(frame, /cached · unknown @/);
  assert.equal(fs.readFileSync(fixture.gitLog, 'utf8'), callsBeforeRender);
  stale.unmount();
});

test('r refreshes Global availability by source and preserves selection through failures', async (context) => {
  const fixture = setupManagedTui([
    {name: 'available', source: 'owner/one', hash: 'available-old'},
    {name: 'current', source: 'owner/one', hash: 'current-hash'},
    {name: 'missing', source: 'owner/one', hash: 'missing-old'},
    {name: 'offline', source: 'owner/offline', hash: 'offline-old'},
  ]);
  useFixtureEnv(context, fixture.env);
  process.env.TUI_GIT_TREES = JSON.stringify({
    'https://github.com/owner/one.git': {
      'skills/available': 'available-new',
      'skills/current': 'current-hash',
    },
  });
  const t = await renderApp(fixture.home, 120, 34);
  await t.send('\t');
  await t.send('j'); // current
  assert.match(t.stdout.frame(), /› current/);
  assert.match(t.stdout.frame(), /Update availability: unknown/);

  await t.send('r');
  let frame = t.stdout.frame();
  assert.match(frame, /Refresh results/);
  assert.match(frame, /checked 4.*current 1.*available 1.*updated 0.*skipped 1.*failed 1/);
  assert.match(frame, /owner\/one[\s\S]*available: available/);
  assert.match(frame, /current: current/);
  assert.match(frame, /missing: upstream-missing/);
  assert.match(frame, /owner\/offline[\s\S]*offline: check-failed/);
  assert.match(frame, /checkedAt=/);
  assert.equal((fs.readFileSync(fixture.gitLog, 'utf8').match(/"clone"/g) ?? []).length, 2);
  await t.send('\x1b');
  frame = t.stdout.frame();
  assert.match(frame, /› current/);
  t.unmount();
});

test('u confirms and updates one available OFF Global Skill without changing Desired state', async (context) => {
  const fixture = setupManagedTui([
    {name: 'off-skill', source: 'owner/repo', hash: 'old-hash', off: true},
  ]);
  useFixtureEnv(context, fixture.env);
  process.env.TUI_GIT_TREES = JSON.stringify({
    'https://github.com/owner/repo.git': {'skills/off-skill': 'new-hash'},
  });
  sharedRefresh(fixture.home);
  const t = await renderApp(fixture.home, 120, 30);
  await t.send('\t');

  await t.send('u');
  assert.match(t.stdout.frame(), /Update 1 Skill\?/);
  assert.match(t.stdout.frame(), /owner\/repo[\s\S]*off-skill: available/);
  assert.equal(fs.existsSync(fixture.npxLog), false);
  await t.send('n');
  assert.equal(fs.existsSync(fixture.npxLog), false);

  await t.send('u');
  await t.send('y');
  const frame = t.stdout.frame();
  assert.match(frame, /Update results/);
  assert.match(frame, /updated 1/);
  assert.match(frame, /off-skill: updated/);
  assert.ok(fs.existsSync(path.join(fixture.parking, 'off-skill', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(fixture.discovery, 'off-skill')), false);
  const call = JSON.parse(fs.readFileSync(fixture.npxLog, 'utf8').trim());
  assert.deepEqual(call.args, ['--yes', 'skills@1.5.21', 'update', 'off-skill', '--global']);
  t.unmount();
});

test('available linked Skills keep update and unlink as distinct actions', async (context) => {
  const fixture = setupManagedTui([
    {name: 'linked-update', source: 'owner/repo', hash: 'old-hash'},
  ]);
  useFixtureEnv(context, fixture.env);
  const consumer = path.join(path.dirname(fixture.discovery), 'consumer');
  fs.mkdirSync(consumer, {recursive: true});
  fs.symlinkSync(path.join(fixture.discovery, 'linked-update'), path.join(consumer, 'linked-update'));
  const targetsFile = path.join(fixture.home.configDir, 'targets.json');
  const targets = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
  targets.genericTargets.push({
    key: 'consumer',
    kind: 'generic',
    discoveryRoot: consumer,
    parkingRoot: path.join(path.dirname(consumer), 'consumer-off'),
    projectPath: '.consumer',
  });
  fs.writeFileSync(targetsFile, JSON.stringify(targets));
  process.env.TUI_GIT_TREES = JSON.stringify({
    'https://github.com/owner/repo.git': {'skills/linked-update': 'new-hash'},
  });
  sharedRefresh(fixture.home);
  const t = await renderApp(fixture.home, 140, 30);
  await t.send('\t');
  await t.send('l');
  await t.send('j');
  let frame = t.stdout.frame();
  assert.match(frame, /x unlink/);
  assert.match(frame, /u update/);

  await t.send('x');
  assert.match(t.stdout.frame(), /Unlink relationship\?/);
  await t.send('n');
  await t.send('u');
  frame = t.stdout.frame();
  assert.match(frame, /Update 1 Skill\?/);
  assert.ok(fs.lstatSync(path.join(consumer, 'linked-update')).isSymbolicLink());
  t.unmount();
});

test('batch u updates only marked available Skills and preserves failed or skipped marks', async (context) => {
  const fixture = setupManagedTui([
    {name: 'a-success', source: 'owner/one', hash: 'success-old'},
    {name: 'b-fail', source: 'owner/two', hash: 'fail-old'},
    {name: 'c-current', source: 'owner/one', hash: 'current-hash'},
  ]);
  useFixtureEnv(context, fixture.env);
  process.env.TUI_GIT_TREES = JSON.stringify({
    'https://github.com/owner/one.git': {
      'skills/a-success': 'success-new',
      'skills/c-current': 'current-hash',
    },
    'https://github.com/owner/two.git': {'skills/b-fail': 'fail-new'},
  });
  process.env.TUI_NPX_FAIL_NAMES = JSON.stringify(['b-fail']);
  sharedRefresh(fixture.home);
  const t = await renderApp(fixture.home, 120, 34);
  await t.send('\t');
  await t.send('v');
  await t.send(' ');
  await t.send('j');
  await t.send(' ');
  await t.send('j');
  await t.send(' ');
  assert.match(t.stdout.frame(), /3 marked/);

  await t.send('u');
  let frame = t.stdout.frame();
  assert.match(frame, /Update 2 Skills\?/);
  assert.match(frame, /available 2.*skipped 1/);
  assert.match(frame, /owner\/one[\s\S]*a-success: available[\s\S]*c-current: skipped \(current\)/);
  assert.match(frame, /owner\/two[\s\S]*b-fail: available/);
  await t.send('y');
  frame = t.stdout.frame();
  assert.match(frame, /Update results/);
  assert.match(frame, /updated 1.*skipped 1.*failed 1/);
  assert.match(frame, /a-success: updated/);
  assert.match(frame, /b-fail: failed/);
  assert.match(frame, /c-current: skipped \(current\)/);
  const calls = fs.readFileSync(fixture.npxLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({args}) => args[3]).sort(), ['a-success', 'b-fail']);
  await t.send('\x1b');
  assert.match(t.stdout.frame(), /2 marked/);
  t.unmount();
});

test('Project TUI update uses the exact project scope', async (context) => {
  const fixture = setupManagedTui([
    {name: 'project-skill', source: 'owner/project', hash: 'old-hash'},
  ], true);
  useFixtureEnv(context, fixture.env);
  process.env.TUI_GIT_TREES = JSON.stringify({
    'https://github.com/owner/project.git': {'skills/project-skill': 'new-hash'},
  });
  sharedRefresh(fixture.home, fixture.project);
  const t = await renderApp(fixture.home, 120, 30, fixture.project);
  await t.send('\t');
  await t.send('u');
  await t.send('y');
  assert.match(t.stdout.frame(), /project-skill: updated/);
  const call = JSON.parse(fs.readFileSync(fixture.npxLog, 'utf8').trim());
  assert.equal(call.cwd, fs.realpathSync(fixture.project));
  assert.equal(call.args.includes('--global'), false);
  t.unmount();
});
