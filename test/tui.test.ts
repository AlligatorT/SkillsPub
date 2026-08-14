import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { createElement as h } from 'react';
import { render } from 'ink';
import { App } from '../src/tui.ts';

const stripAnsi = (s: string): string =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][0-9A-B]/g, '');

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
    if (/\x1b\[(2K|2J|3J|1A|\d+F)/.test(s)) this.current = s;
    else this.current += s;
    const done = typeof encoding === 'function'
      ? encoding as () => void
      : typeof cb === 'function' ? cb as () => void : undefined;
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

test('initial projection: first agent selected, all relationship kinds shown, absent excluded', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  const frame = t.stdout.frame();
  assert.match(frame, /Agent/);
  assert.match(frame, /Agents/);
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
  // summary of first entry visible on wide terminal
  assert.match(frame, /Source:/);
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
  const grillingId = fs.realpathSync(path.join(home.configDir, 'a-skills', 'grilling'));
  const t = await renderApp(home);
  await t.send('l');
  await t.send('j');
  await t.send('j'); // grilling
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
  assert.match(frame, /› backend/);
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
  assert.match(frame, /Agents/);
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
  assert.equal((frame.match(/code-review \(/g) ?? []).length, 2);
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
    `claude code = ${a}\ncodex = ${b}\nHermes Agent = ${b}\n`,
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

  // on+off in one Runtime Slot is an on-off-conflict: unlink refuses the ambiguous Slot
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

test('footer reflects available navigation actions and modal state', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  assert.match(t.stdout.frame(), /enter SKILL\.md/);
  assert.match(t.stdout.frame(), /\/ search/);
  assert.match(t.stdout.frame(), /s sort:Name/);
  assert.match(t.stdout.frame(), /R refresh/);
  // read-only slice: no mutation actions in the footer
  assert.doesNotMatch(t.stdout.frame().split('\n').pop() ?? '', /toggle|space|unlink/i);
  await t.send('l');
  await t.send('\r');
  assert.match(t.stdout.frame(), /esc close/);
  assert.doesNotMatch(t.stdout.frame(), /R refresh/);
  t.unmount();
});
