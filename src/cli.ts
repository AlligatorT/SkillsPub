#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defaultHome,
  loadAgents,
  scanAll,
  scanAgent,
  setSkill,
  loadState,
  filterRows,
  untagged,
  type Row,
} from './core.ts';

const USAGE = `SkillsPub — multi-agent skills on/off manager (disk is the source of truth)

  skillspub ls [--agent A] [--tag T]   skill × agent matrix (+ untagged/deadlink hints)
  skillspub on|off <skill> <agent...>  move skill between skills/ and skills/.off/
  skillspub status <skill>             per-agent state of one skill
  skillspub agents                     agent registry (~/.config/skillspub/agents.conf)
  skillspub tui                        interactive full-screen skill browser
`;

export function shouldRunTui(
  command: string | undefined,
  stdinIsTty: boolean,
  stdoutIsTty: boolean,
): boolean {
  return command === 'tui' ||
    (command === undefined && stdinIsTty && stdoutIsTty);
}

const CELL: Record<string, string> = { on: 'on', off: 'off', deadlink: '!' };

function pad(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - s.length));
}

function printMatrix(rows: Row[], agentNames: string[]): void {
  const w = Math.max(5, ...rows.map((r) => r.name.length)) + 2;
  console.log(pad('skill', w) + agentNames.map((a) => pad(a, 9)).join(''));
  for (const r of rows) {
    console.log(
      pad(r.name, w) +
        agentNames
          .map((a) => pad(CELL[r.agents[a]?.presence ?? ''] ?? '·', 9))
          .join(''),
    );
  }
}

function cmdLs(home: ReturnType<typeof defaultHome>, args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { agent: { type: 'string' }, tag: { type: 'string' } },
  });
  const agents = loadAgents(home);
  if (values.agent && !agents.some((a) => a.name === values.agent))
    throw new Error(`unknown agent: ${values.agent}`);
  const { tags } = loadState(home);
  const rows = filterRows(
    scanAll(agents),
    { agent: values.agent, tag: values.tag },
    tags,
  );
  const cols = values.agent ? [values.agent] : agents.map((a) => a.name);
  if (rows.length === 0) {
    console.log('no skills found');
    return;
  }
  printMatrix(rows, cols);
  const dead = rows.flatMap((r) =>
    Object.entries(r.agents)
      .filter(([, i]) => i?.presence === 'deadlink')
      .map(([a, i]) => `${a}/${r.name} -> ${i?.target ?? '?'}`),
  );
  const unt = untagged(rows, tags);
  if (dead.length > 0) console.log(`\n死链 (doctor 清理): ${dead.join(', ')}`);
  if (unt.length > 0)
    console.log(`未分类 (skillspub tag add): ${unt.join(', ')}`);
}

function cmdOnOff(
  home: ReturnType<typeof defaultHome>,
  on: boolean,
  args: string[],
): void {
  const [skill, ...names] = args;
  if (!skill || names.length === 0)
    throw new Error(
      `usage: skillspub ${on ? 'on' : 'off'} <skill> <agent...>`,
    );
  const agents = loadAgents(home);
  for (const name of names) {
    const agent = agents.find((a) => a.name === name);
    if (!agent) throw new Error(`unknown agent: ${name}`);
    const result = setSkill(agent, skill, on);
    console.log(
      result === 'already'
        ? `${skill} @ ${name}: already ${on ? 'on' : 'off'}`
        : `${skill} @ ${name}: ${result}`,
    );
  }
}

function cmdStatus(
  home: ReturnType<typeof defaultHome>,
  args: string[],
): void {
  const [skill] = args;
  if (!skill) throw new Error('usage: skillspub status <skill>');
  let any = false;
  for (const agent of loadAgents(home)) {
    const info = scanAgent(agent).get(skill);
    if (!info) {
      console.log(`${agent.name}\t—`);
      continue;
    }
    any = true;
    const where = info.presence === 'off' ? `${agent.dir}/.off/${skill}` : `${agent.dir}/${skill}`;
    const extra = info.target ? ` -> ${info.target}` : '';
    console.log(`${agent.name}\t${CELL[info.presence]}\t${where}${extra}`);
  }
  if (!any) {
    console.error(`warning: ${skill} not found in any agent`);
    process.exitCode = 1;
  }
}

function cmdAgents(home: ReturnType<typeof defaultHome>): void {
  for (const a of loadAgents(home)) {
    console.log(`${a.name}\t${a.dir}\t${fs.existsSync(a.dir) ? 'ok' : 'missing dir'}`);
  }
}

async function main(
  args: string[] = process.argv.slice(2),
  stdinIsTty = Boolean(process.stdin.isTTY),
  stdoutIsTty = Boolean(process.stdout.isTTY),
): Promise<void> {
  const home = defaultHome();
  const [cmd, ...rest] = args;
  try {
    if (shouldRunTui(cmd, stdinIsTty, stdoutIsTty)) {
      if (cmd === 'tui' && rest.length > 0)
        throw new Error('usage: skillspub tui');
      await (await import('./tui.ts')).runTui(home);
    } else switch (cmd) {
      case 'ls':
        cmdLs(home, rest);
        break;
      case 'on':
        cmdOnOff(home, true, rest);
        break;
      case 'off':
        cmdOnOff(home, false, rest);
        break;
      case 'status':
        cmdStatus(home, rest);
        break;
      case 'agents':
        cmdAgents(home);
        break;
      default:
        process.stderr.write(USAGE);
        process.exit(cmd === undefined ? 0 : 1);
    }
  } catch (err) {
    console.error(`skillspub: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) await main();
