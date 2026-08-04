#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defaultHome,
  loadAgents,
  loadRuntimes,
  buildInventory,
  applyDoctorRepairs,
  doctorGlobalInventory,
  doctorProjectInventory,
  scanGlobalInventory,
  scanProjectInventory,
  setSkill,
  loadState,
  filterRows,
  untagged,
  type DoctorReport,
  type InventoryScanReport,
  type Row,
} from './core.ts';
import {
  sharedAdd,
  sharedDescribe,
  sharedFind,
  sharedRemove,
  sharedUpdate,
} from './shared.ts';
import {
  addBundleMembers,
  addResourceTags,
  applyActivationPlan,
  createBundle,
  expandSelector,
  listBundles,
  listTags,
  planActivation,
  remainingDrift,
  removeBundleMembers,
  removeResourceTags,
  showBundle,
  tagsForResource,
} from './bundles.ts';

const USAGE = `SkillsPub — multi-agent skills on/off manager (disk is the source of truth)

  skillspub ls [--agent A] [--tag T]   skill × agent matrix (+ untagged/deadlink hints)
  skillspub on|off <selector> <target...> [--yes]  update Agent or Runtime relationships
  skillspub status <skill>             per-agent state of one skill
  skillspub bundle ls|show|create|add|rm ...
  skillspub tag add|rm|ls ...          manage global resource Tags
  skillspub shared find|describe|add|update|remove ...  manage the Shared Runtime via skills@1.5.21
  skillspub scan                       explicitly scan Global Runtime inventory
  skillspub doctor [--repair --yes]    diagnose; explicitly confirm safe repairs
  skillspub project <path> scan|doctor|shared ...  operate on the exact Project Runtime roots
  skillspub runtimes                   Runtime registry (~/.config/skillspub/runtimes.json)
  skillspub agents                     legacy Agent registry view
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

function relationships(row: Row, agent: string) {
  return row.relationships.filter((relationship) => relationship.agent === agent);
}

function matrixCell(row: Row, agent: string): string {
  const states = [...new Set(relationships(row, agent).map(({info}) => CELL[info.presence]))];
  return states.join('/') || '·';
}

function printMatrix(rows: Row[], agentNames: string[]): void {
  const w = Math.max(5, ...rows.map((r) => r.displayName.length)) + 2;
  console.log(pad('skill', w) + agentNames.map((a) => pad(a, 9)).join(''));
  for (const r of rows) {
    console.log(
      pad(r.displayName, w) +
        agentNames.map((agent) => pad(matrixCell(r, agent), 9)).join(''),
    );
  }
}

function matchingInstances(rows: Row[], name: string): Row[] {
  return rows.filter((row) =>
    row.relationships.some((relationship) => relationship.name === name),
  );
}

function variantLocation(row: Row): string {
  return row.realPath
    ?? `${row.relationships[0].info.path} -> ${row.relationships[0].info.target ?? '?'}`;
}

function refuseAmbiguousName(rows: Row[], name: string): void {
  const matches = matchingInstances(rows, name);
  if (matches.length < 2) return;
  throw new Error(
    `skill name "${name}" is ambiguous:\n${matches
      .map((row) => `  - ${row.displayName}: ${variantLocation(row)}`)
      .join('\n')}\nUse skillspub tui to select a specific variant.`,
  );
}

function cmdLs(home: ReturnType<typeof defaultHome>, args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { agent: { type: 'string' }, tag: { type: 'string' } },
  });
  if (values.tag && !values.agent) {
    const report = scanGlobalInventory(home, undefined, { persist: false });
    let selected: Set<string>;
    try {
      selected = new Set(expandSelector(home, `tag:${values.tag}`, report).resourceIds);
    } catch (error) {
      if ((error as Error).message === `unknown Tag: ${values.tag}`) {
        console.log('no skills found');
        return;
      }
      throw error;
    }
    const counts = new Map<string, number>();
    for (const resource of report.resources)
      counts.set(resource.name, (counts.get(resource.name) ?? 0) + 1);
    const resources = report.resources.filter(({ id }) => selected.has(id));
    if (resources.length === 0) {
      console.log('no skills found');
      return;
    }
    for (const resource of resources) {
      const name = counts.get(resource.name) === 1
        ? resource.name
        : `${resource.name} (${resource.id})`;
      const relationships = resource.relationships
        .map(({ runtimeId, slot, activation }) => `${runtimeId}/${slot}:${activation}`)
        .join(', ');
      console.log(`${name}\tskill:${resource.id}\t${relationships}`);
    }
    return;
  }
  const agents = loadAgents(home);
  if (values.agent && !agents.some((a) => a.name === values.agent))
    throw new Error(`unknown agent: ${values.agent}`);
  const { tags } = loadState(home);
  const rows = filterRows(
    buildInventory(home, agents).instances,
    { agent: values.agent, tag: values.tag },
    tags,
  );
  const cols = values.agent ? [values.agent] : agents.map((a) => a.name);
  if (rows.length === 0) {
    console.log('no skills found');
    return;
  }
  printMatrix(rows, cols);
  const dead = rows.flatMap((row) =>
    row.relationships
      .filter(({info}) => info.presence === 'deadlink')
      .map(({agent, name, info}) => `${agent}/${name} -> ${info.target ?? '?'}`),
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
  if (skill.startsWith('bundle:') || skill.startsWith('tag:') || skill.startsWith('skill:')) {
    const confirmed = names.includes('--yes');
    const runtimes = names.filter((name) => name !== '--yes');
    const plan = planActivation(home, skill, runtimes, on ? 'on' : 'off');
    console.log('Plan:');
    if (plan.targets.length === 0) console.log('  no current Runtime Slots');
    else for (const target of plan.targets) {
      const intent = target.intent === target.to
        ? ''
        : ` (Base intent ${target.intent}; claimed ${target.to})`;
      console.log(
        `  ${target.runtimeId}/${target.slot}\t${target.from} -> ${target.to}${intent}`,
      );
    }
    if (!confirmed && plan.targets.some((target) =>
      target.from === 'missing' && target.to === 'on')) {
      throw new Error('creating missing Relationships requires --yes');
    }
    try {
      applyActivationPlan(home, plan);
    } catch (error) {
      let drift: string;
      try {
        const remaining = remainingDrift(plan, scanGlobalInventory(home));
        drift = remaining.length > 0 ? remaining.join(', ') : 'none';
      } catch (scanError) {
        drift = `could not rescan: ${(scanError as Error).message}`;
      }
      throw new Error(`${(error as Error).message}\nRemaining drift: ${drift}`);
    }
    scanGlobalInventory(home);
    return;
  }
  const agents = loadAgents(home);
  refuseAmbiguousName(buildInventory(home, agents).instances, skill);
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
  const agents = loadAgents(home);
  const matches = matchingInstances(buildInventory(home, agents).instances, skill);
  if (matches.length === 0) {
    console.error(`warning: ${skill} not found in any agent`);
    process.exitCode = 1;
    return;
  }
  refuseAmbiguousName(matches, skill);
  for (const [index, instance] of matches.entries()) {
    if (matches.length > 1) {
      if (index > 0) console.log('');
      console.log(`${instance.displayName}\t${variantLocation(instance)}`);
    }
    for (const agent of agents) {
      const found = relationships(instance, agent.name);
      if (found.length === 0) {
        console.log(`${agent.name}\t—`);
        continue;
      }
      for (const {name, info} of found) {
        const extra = info.target ? ` -> ${info.target}` : '';
        console.log(`${agent.name}\t${CELL[info.presence]}\t${info.path}${extra}${name === skill ? '' : ` (${name})`}`);
      }
    }
  }
}

function cmdAgents(home: ReturnType<typeof defaultHome>): void {
  for (const a of loadAgents(home)) {
    console.log(`${a.name}\t${a.dir}\t${fs.existsSync(a.dir) ? 'ok' : 'missing dir'}`);
  }
}

function cmdRuntimes(home: ReturnType<typeof defaultHome>): void {
  for (const runtime of loadRuntimes(home)) {
    console.log([
      runtime.key,
      runtime.kind,
      runtime.discoveryRoot,
      runtime.parkingRoot,
    ].join('\t'));
  }
}

function cmdTag(home: ReturnType<typeof defaultHome>, args: string[]): void {
  const [action, resource, ...names] = args;
  switch (action) {
    case 'add': {
      if (!resource || names.length === 0)
        throw new Error('usage: skillspub tag add <resource> <tag...>');
      const added = addResourceTags(home, resource, names);
      console.log(`added ${added} tag${added === 1 ? '' : 's'} to ${resource}`);
      break;
    }
    case 'rm': {
      if (!resource) throw new Error('usage: skillspub tag rm <resource> [<tag...>]');
      const removed = removeResourceTags(home, resource, names);
      console.log(`removed ${removed} tag${removed === 1 ? '' : 's'} from ${resource}`);
      break;
    }
    case 'ls': {
      const { values } = parseArgs({
        args: args.slice(1),
        options: { skill: { type: 'string' } },
      });
      if (values.skill) {
        const resourceTags = tagsForResource(home, values.skill);
        console.log(`${resourceTags.name ?? resourceTags.id}\tskill:${resourceTags.id}${resourceTags.stale ? '\tstale' : ''}`);
        if (resourceTags.tags.length === 0) console.log('  no tags');
        else for (const tag of resourceTags.tags) console.log(`  ${tag}`);
      } else {
        const tags = listTags(home);
        if (tags.length === 0) console.log('no tags found');
        else for (const tag of tags) console.log(`${tag.name}\t${tag.resources}`);
      }
      break;
    }
    default:
      throw new Error('usage: skillspub tag add|rm|ls ...');
  }
}

function cmdBundle(home: ReturnType<typeof defaultHome>, args: string[]): void {
  const [action, name, ...selectors] = args;
  switch (action) {
    case 'ls': {
      if (name) throw new Error('usage: skillspub bundle ls');
      const bundles = listBundles(home);
      if (bundles.length === 0) console.log('no bundles found');
      else for (const bundle of bundles) console.log(`${bundle.name}\t${bundle.members}`);
      break;
    }
    case 'show': {
      if (!name || selectors.length > 0)
        throw new Error('usage: skillspub bundle show <name>');
      console.log(name);
      const members = showBundle(home, name);
      if (members.length === 0) console.log('  no members');
      else for (const member of members) {
        console.log(`  ${member.name ?? member.id}\tskill:${member.id}${member.stale ? '\tstale' : ''}`);
      }
      break;
    }
    case 'create': {
      if (!name) throw new Error('usage: skillspub bundle create <name> [<skill>...]');
      const count = createBundle(home, name, selectors);
      console.log(`created bundle ${name} with ${count} member${count === 1 ? '' : 's'}`);
      break;
    }
    case 'add': {
      if (!name || selectors.length === 0)
        throw new Error('usage: skillspub bundle add <name> <skill...>');
      const added = addBundleMembers(home, name, selectors);
      console.log(`added ${added} member${added === 1 ? '' : 's'} to ${name}`);
      break;
    }
    case 'rm': {
      if (!name) throw new Error('usage: skillspub bundle rm <name> [<skill>...]');
      const removed = removeBundleMembers(home, name, selectors);
      console.log(removed === undefined
        ? `removed bundle ${name}`
        : `removed ${removed} member${removed === 1 ? '' : 's'} from ${name}`);
      break;
    }
    default:
      throw new Error('usage: skillspub bundle ls|show|create|add|rm ...');
  }
}

function cmdShared(
  home: ReturnType<typeof defaultHome>,
  args: string[],
  projectPath?: string,
): void {
  const [action, ...rest] = args;
  switch (action) {
    case 'find':
      sharedFind(home, rest, projectPath);
      break;
    case 'describe':
      if (rest.length !== 1)
        throw new Error('usage: skillspub shared describe <source>');
      sharedDescribe(home, rest[0], projectPath);
      break;
    case 'add': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          skill: { type: 'string' },
          replace: { type: 'boolean' },
        },
        allowPositionals: true,
        strict: true,
      });
      if (positionals.length !== 1 || !values.skill)
        throw new Error('usage: skillspub shared add <source> --skill <name> [--replace]');
      const result = sharedAdd(home, positionals[0], values.skill, Boolean(values.replace), projectPath);
      console.log(`Actual: ${result.actual}`);
      console.log(`Remaining drift: ${result.drift.join(', ') || 'none'}`);
      console.log('Running Agents must reload/restart to read the final Shared Runtime state.');
      break;
    }
    case 'update': {
      if (rest.some((arg) => arg.startsWith('-')))
        throw new Error('usage: skillspub shared update [<managed-name>...]');
      const result = sharedUpdate(home, rest, projectPath);
      console.log(`Actual: ${result.actual}`);
      console.log(`Remaining drift: ${result.drift.join(', ') || 'none'}`);
      console.log('Running Agents must reload/restart to read the final Shared Runtime state.');
      break;
    }
    case 'remove': {
      if (rest.length === 0 || rest.some((arg) => arg.startsWith('-')))
        throw new Error('usage: skillspub shared remove <managed-name...>');
      const result = sharedRemove(home, rest, projectPath);
      console.log(`Actual: ${result.actual}`);
      console.log(`Remaining drift: ${result.drift.join(', ') || 'none'}`);
      console.log('Running Agents must reload/restart to read the final Shared Runtime state.');
      break;
    }
    default:
      throw new Error('usage: skillspub shared find|describe|add|update|remove ...');
  }
}

function printDoctor(report: DoctorReport): void {
  console.log(report.scope === 'project'
    ? `Project Doctor: ${report.projectPath}`
    : 'Global Doctor');
  console.log('Structural anomalies:');
  const findings = report.findings.filter(({ category }) => category === 'structural');
  if (findings.length === 0) console.log('  none');
  else for (const finding of findings) console.log(`  - ${finding.message}`);
  console.log('Safe repair plan:');
  if (report.repairs.length === 0) console.log('  none');
  for (const repair of report.repairs) {
    const action = repair.kind === 'retarget-link' ? 'retarget Link' : 'remove broken link';
    console.log(`  - ${action}: ${repair.path}: ${repair.from}${repair.to ? ` -> ${repair.to}` : ''}`);
  }
}

function cmdDoctor(
  home: ReturnType<typeof defaultHome>,
  args: string[],
  projectPath?: string,
): void {
  const { values } = parseArgs({
    args,
    options: {
      repair: { type: 'boolean' },
      yes: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.yes && !values.repair)
    throw new Error('usage: skillspub doctor [--repair --yes]');
  const diagnose = (): DoctorReport => projectPath
    ? doctorProjectInventory(home, projectPath)
    : doctorGlobalInventory(home);
  const report = diagnose();
  printDoctor(report);
  if (!values.repair || report.repairs.length === 0) return;
  if (!values.yes)
    throw new Error('repairs require confirmation; rerun with --repair --yes');

  const result = applyDoctorRepairs(report.repairs);
  console.log(`Applied repairs: ${result.completed.length}`);
  if (result.failed) {
    console.error(`Repair failed: ${result.failed.repair.path}: ${result.failed.error}`);
    printDoctor(diagnose());
    throw new Error('repair stopped; remaining anomalies are shown above');
  }
  printDoctor(diagnose());
}

function printScan(report: InventoryScanReport): void {
  console.log(report.scope === 'project'
    ? `Project scan: ${report.projectPath}`
    : 'Global scan');
  console.log('Runtime roots:');
  for (const runtime of report.runtimes) {
    const source = runtime.scope === 'global' ? 'Global' : runtime.sourceDirectory;
    const access = runtime.writable ? 'writable' : `read-only from ${source}`;
    console.log(`  - ${runtime.id} [${access}] ${runtime.discoveryRoot} | OFF ${runtime.parkingRoot}`);
  }
  console.log('Relationships:');
  if (report.relationships.length === 0) console.log('  none');
  for (const relationship of report.relationships) {
    const runtime = report.runtimes.find(({ id }) => id === relationship.runtimeId);
    const source = runtime?.scope === 'global' ? 'Global' : runtime?.sourceDirectory;
    const access = relationship.readOnly ? `read-only from ${source}` : 'writable';
    const target = relationship.target ? ` -> ${relationship.target}` : '';
    console.log(
      `  - ${relationship.name} @ ${relationship.runtimeId}: ` +
      `${relationship.activation} ${relationship.form} [${access}] ${relationship.path}${target}`,
    );
  }
  console.log(`Missing relationships: ${report.missing.length}`);
  const sections = [
    ['Structural anomalies', 'structural'],
    ['Uncategorized metadata', 'metadata'],
    ['External changes', 'change'],
  ] as const;
  for (const [title, category] of sections) {
    console.log(`${title}:`);
    const findings = report.findings.filter((finding) => finding.category === category);
    if (findings.length === 0) console.log('  none');
    else for (const finding of findings) console.log(`  - ${finding.message}`);
  }
}

async function main(
  args: string[] = process.argv.slice(2),
  stdinIsTty = Boolean(process.stdin.isTTY),
  stdoutIsTty = Boolean(process.stdout.isTTY),
): Promise<void> {
  const [cmd, ...rest] = args;
  const readOnlyShared = (command: string | undefined) =>
    command === 'find' || command === 'describe';
  const readOnly = cmd === 'doctor' ||
    (cmd === 'shared' && readOnlyShared(rest[0])) ||
    (cmd === 'project' && (rest[1] === 'doctor' ||
      (rest[1] === 'shared' && readOnlyShared(rest[2]))));
  const home = defaultHome({ migrate: !readOnly });
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
      case 'bundle':
        cmdBundle(home, rest);
        break;
      case 'tag':
        cmdTag(home, rest);
        break;
      case 'shared':
        cmdShared(home, rest);
        break;
      case 'scan':
        if (rest.length > 0) throw new Error('usage: skillspub scan');
        printScan(scanGlobalInventory(home));
        break;
      case 'doctor':
        cmdDoctor(home, rest);
        break;
      case 'project': {
        const [projectPath, projectCommand, ...projectArgs] = rest;
        if (!projectPath) throw new Error('usage: skillspub project <path> scan|doctor|shared');
        if (projectCommand === 'scan' && projectArgs.length === 0)
          printScan(scanProjectInventory(home, projectPath));
        else if (projectCommand === 'doctor') cmdDoctor(home, projectArgs, projectPath);
        else if (projectCommand === 'shared') cmdShared(home, projectArgs, projectPath);
        else throw new Error('usage: skillspub project <path> scan|doctor|shared');
        break;
      }
      case 'runtimes':
        if (rest.length > 0) throw new Error('usage: skillspub runtimes');
        cmdRuntimes(home);
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
