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
  write(chunk: unknown): boolean {
    const s = String(chunk);
    // Each interactive render starts with erase/clear control sequences.
    if (/\x1b\[(2K|2J|3J|1A|\d+F)/.test(s)) this.current = s;
    else this.current += s;
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
  mkSkill(path.join(a, '.off'), 'parked');
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

async function renderApp(home: { configDir: string }, columns = 100, rows = 30) {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout(columns, rows);
  const app = render(h(App, { home }), {
    stdin: stdin as never,
    stdout: stdout as never,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const flush = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 80));
  await flush();
  const send = async (input: string) => {
    stdin.write(input);
    await flush();
  };
  return { stdin, stdout, send, flush, unmount: () => app.unmount() };
}

test('initial projection: first agent selected, all relationship kinds shown, absent excluded', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  const frame = t.stdout.frame();
  assert.match(frame, /Agent/);
  assert.match(frame, /Agents/);
  assert.match(frame, /Relationships/);
  assert.match(frame, /Summary/);
  // all relationship kinds for agent a, text-first
  assert.match(frame, /\[ ON \] local\s+grilling/);
  assert.match(frame, /\[ ON \] link\s+linked/);
  assert.match(frame, /\[ OFF \] local\s+parked/);
  assert.match(frame, /broken\s+broken ->/);
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

test('horizontal navigation moves focus between actionable columns only', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  assert.match(t.stdout.frame(), /› a/);
  await t.send('l');
  // first entry in registry scan order is the broken symlink row
  assert.match(t.stdout.frame(), /› broken broken/);
  assert.doesNotMatch(t.stdout.frame(), /› a/);
  // further right never lands on the passive summary; left returns to agents
  await t.send('l');
  assert.match(t.stdout.frame(), /› broken broken/);
  await t.send('h');
  assert.match(t.stdout.frame(), /› a/);
  t.unmount();
});

test('narrow terminal hides only the passive summary', async () => {
  const { home } = setup();
  const t = await renderApp(home, 60, 30);
  const frame = t.stdout.frame();
  assert.doesNotMatch(frame, /Summary/);
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
  const body = ['---', 'description: long', '---'];
  for (let i = 1; i <= 40; i++) body.push(`line-${String(i).padStart(2, '0')}`);
  mkSkill(path.join(home.configDir, 'a-skills'), 'long-doc', body.join('\n'));
  const t = await renderApp(home, 100, 24);
  await t.send('l');
  // select long-doc (entries for agent a: broken, code-review, grilling, linked, long-doc, parked)
  for (let i = 0; i < 4; i++) await t.send('j');
  assert.match(t.stdout.frame(), /› \[ ON \] local\s+long-doc/);
  await t.send('\r');
  let frame = t.stdout.frame();
  assert.match(frame, /SKILL\.md — long-doc\s+\[1\/43\]/);
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
  assert.match(frame, /a {2}broken/);
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
  assert.match(t.stdout.frame(), /› a {2}broken/);
  // further right never lands on the passive summary; left returns to skills
  await t.send('l');
  assert.match(t.stdout.frame(), /› a {2}broken/);
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
  assert.doesNotMatch(frame, /Summary/);
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

test('Agent projection toggles the selected local relationship immediately', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('l');
  await t.send('j');
  await t.send('j'); // grilling
  await t.send(' ');

  assert.ok(fs.existsSync(path.join(home.configDir, 'a-skills', '.off', 'grilling', 'SKILL.md')));
  assert.match(t.stdout.frame(), /grilling @ a: off/);
  assert.match(t.stdout.frame(), /\[ OFF \] local\s+grilling/);
  t.unmount();
});

test('Skill projection confirms link and unlink before changing disk', async () => {
  const { home } = setup();
  const target = path.join(home.configDir, 'b-skills', 'grilling');
  const t = await renderApp(home);
  await t.send('\t');
  for (let i = 0; i < 3; i++) await t.send('j'); // grilling
  await t.send('l');
  await t.send('j'); // agent b is missing

  await t.send('i');
  assert.match(t.stdout.frame(), /Link relationship\?/);
  assert.match(t.stdout.frame(), /a-skills\/grilling/);
  assert.match(t.stdout.frame(), /→/);
  assert.match(t.stdout.frame(), /b-skills\/grilling/);
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

test('unlinking the sole link keeps its surviving source available to re-link', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  await t.send('l');
  for (let i = 0; i < 3; i++) await t.send('j'); // linked
  await t.send('u');
  await t.send('y');

  assert.match(t.stdout.frame(), /linked/);
  await t.send('\t');
  assert.match(t.stdout.frame(), /linked/);
  assert.match(t.stdout.frame(), /› a {2}missing/);
  assert.match(t.stdout.frame(), /i link/);
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
