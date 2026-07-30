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

test('footer reflects read-only context and modal state', async () => {
  const { home } = setup();
  const t = await renderApp(home);
  assert.match(t.stdout.frame(), /enter SKILL\.md/);
  assert.match(t.stdout.frame(), /q quit/);
  // read-only slice: no mutation actions in the footer
  assert.doesNotMatch(t.stdout.frame().split('\n').pop() ?? '', /toggle|space|unlink/i);
  await t.send('l');
  await t.send('\r');
  assert.match(t.stdout.frame(), /esc close/);
  t.unmount();
});
