#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultHome } from './core.ts';
import {
  applyTargetMigration,
  loadTargets,
  planTargetMigration,
  applyDoctorRepairs,
  doctorGlobalInventory,
  doctorProjectInventory,
  scanGlobalInventory,
  scanProjectInventory,
  type DoctorReport,
  type InventoryScanReport,
} from './inventory.ts';
import {
  filterRows,
  projectRows,
  readViewState,
  untagged,
  viewTargets,
  type Row,
} from './view.ts';
import {
  sharedAdd,
  sharedDescribe,
  sharedFind,
  sharedRemove,
  sharedUpdate,
} from './shared.ts';
import {
  addBundleMembers,
  addPresetSelectors,
  addResourceTags,
  createBundle,
  createPreset,
  expandSelector,
  listBundles,
  listPresets,
  listTags,
  removeBundleMembers,
  removePresetSelectors,
  removeResourceTags,
  showBundle,
  showPreset,
  tagsForResource,
} from './catalog.ts';
import {
  activatePreset,
  applyActivationPlan,
  applyPresetReconcile,
  deactivatePreset,
  deletePreset,
  planActivation,
  planPresetReconcile,
  remainingDrift,
  type PresetReconcilePlan,
  type PresetScope,
} from './reconcile.ts';

const USAGE = `SkillsPub — multi-agent skills on/off manager (disk is the source of truth)

  skillspub ls [--target T] [--tag T]  skill × Target matrix (+ untagged/deadlink hints)
  skillspub on|off <selector> <target...> [--yes]  update Skill Target relationships
  skillspub status <skill>             per-Target state of one skill
  skillspub bundle ls|show|create|add|rm ...
  skillspub tag add|rm|ls ...          manage global resource Tags
  skillspub preset create|add|rm|ls|show|activate|deactivate|reconcile|delete ...
  skillspub shared find|describe|add|update|remove ...  manage the Shared Target via skills@1.5.21
  skillspub scan                       explicitly scan Global Skill Target inventory
  skillspub doctor [--repair --yes]    diagnose; explicitly confirm safe repairs
  skillspub project <path> scan|doctor|shared|preset ...  operate on the exact Project Skill Targets
  skillspub targets                    list resolved Skill Targets
  skillspub migrate targets [--yes]    preview or migrate runtimes.json to targets.json
  skillspub tui [--project [path]]     interactive full-screen skill browser
                                       (--project: project-scope view, cwd when path omitted)
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

function relationships(row: Row, target: string) {
  return row.relationships.filter((relationship) => relationship.target === target);
}

function matrixCell(row: Row, target: string): string {
  const states = [...new Set(relationships(row, target).map(({info}) => CELL[info.presence]))];
  return states.join('/') || '·';
}

function printMatrix(rows: Row[], targetNames: string[]): void {
  const w = Math.max(5, ...rows.map((r) => r.displayName.length)) + 2;
  console.log(pad('skill', w) + targetNames.map((a) => pad(a, 9)).join(''));
  for (const r of rows) {
    console.log(
      pad(r.displayName, w) +
        targetNames.map((target) => pad(matrixCell(r, target), 9)).join(''),
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
    options: { target: { type: 'string' }, agent: { type: 'string' }, tag: { type: 'string' } },
  });
  if (values.target && values.agent)
    throw new Error('usage: skillspub ls [--target T] [--tag T]');
  if (values.agent) console.error('warning: --agent is deprecated; use --target');
  const target = values.target ?? values.agent;
  if (values.tag && !target) {
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
        .map(({ targetId, slot, activation }) => `${targetId}/${slot}:${activation}`)
        .join(', ');
      console.log(`${name}\tskill:${resource.id}\t${relationships}`);
    }
    return;
  }
  const report = scanGlobalInventory(home, undefined, { persist: false });
  const targets = viewTargets(report);
  if (target && !targets.some((candidate) => candidate.name === target))
    throw new Error(`unknown target: ${target}`);
  const { tags } = readViewState(home);
  const rows = filterRows(
    projectRows(report),
    { target, tag: values.tag },
    tags,
  );
  const cols = target ? [target] : targets.map((candidate) => candidate.name);
  if (rows.length === 0) {
    console.log('no skills found');
    return;
  }
  printMatrix(rows, cols);
  const dead = rows.flatMap((row) =>
    row.relationships
      .filter(({info}) => info.presence === 'deadlink')
      .map(({target, name, info}) => `${target}/${name} -> ${info.target ?? '?'}`),
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
      `usage: skillspub ${on ? 'on' : 'off'} <skill> <target...>`,
    );
  if (!skill.startsWith('bundle:') && !skill.startsWith('tag:') && !skill.startsWith('skill:')) {
    const rows = projectRows(scanGlobalInventory(home, undefined, { persist: false }));
    refuseAmbiguousName(rows, skill);
  }
  const confirmed = names.includes('--yes');
  const targets = names.filter((name) => name !== '--yes');
  const plan = planActivation(home, skill, targets, on ? 'on' : 'off');
  console.log('Plan:');
  if (plan.targets.length === 0) console.log('  no current Target Slots');
  else for (const target of plan.targets) {
    const intent = target.intent === target.to
      ? ''
      : ` (Base intent ${target.intent}; claimed ${target.to})`;
    console.log(
      `  ${target.targetId}/${target.slot}\t${target.from} -> ${target.to}${intent}`,
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
}

function cmdStatus(
  home: ReturnType<typeof defaultHome>,
  args: string[],
): void {
  const [skill] = args;
  if (!skill) throw new Error('usage: skillspub status <skill>');
  const report = scanGlobalInventory(home, undefined, { persist: false });
  const targets = viewTargets(report);
  const matches = matchingInstances(projectRows(report), skill);
  if (matches.length === 0) {
    console.error(`warning: ${skill} not found in any Target`);
    process.exitCode = 1;
    return;
  }
  refuseAmbiguousName(matches, skill);
  for (const [index, instance] of matches.entries()) {
    if (matches.length > 1) {
      if (index > 0) console.log('');
      console.log(`${instance.displayName}\t${variantLocation(instance)}`);
    }
    for (const target of targets) {
      const found = relationships(instance, target.name);
      if (found.length === 0) {
        console.log(`${target.name}\t—`);
        continue;
      }
      for (const {name, info} of found) {
        const extra = info.target ? ` -> ${info.target}` : '';
        console.log(`${target.name}\t${CELL[info.presence]}\t${info.path}${extra}${name === skill ? '' : ` (${name})`}`);
      }
    }
  }
}

function cmdTargets(home: ReturnType<typeof defaultHome>, args: string[]): void {
  if (args.length > 0) throw new Error('usage: skillspub targets');
  for (const target of loadTargets(home)) {
    console.log([
      target.key,
      target.kind,
      target.discoveryRoot,
      target.parkingRoot,
    ].join('\t'));
  }
}

function printTargetMigration(home: ReturnType<typeof defaultHome>): ReturnType<typeof planTargetMigration> {
  const plan = planTargetMigration(home);
  if (plan.status === 'already-migrated') {
    console.log('Target registry already migrated.');
    return plan;
  }
  console.log('Target migration plan:');
  if (plan.overrides.length === 0) console.log('  no Target Definition overrides');
  else for (const override of plan.overrides)
    console.log(`  ${override.disabled ? 'disabled' : 'override'}\t${override.key}`);
  if (plan.genericTargets.length === 0) console.log('  no Generic Targets');
  else for (const target of plan.genericTargets)
    console.log(`  generic\t${target.key}`);
  console.log(`  write\t${plan.targetFile}`);
  console.log(`  backup\t${plan.backupFile}`);
  return plan;
}

function cmdMigrate(home: ReturnType<typeof defaultHome>, args: string[]): void {
  const [subject, ...rest] = args;
  if (subject !== 'targets' || rest.some((arg) => arg !== '--yes'))
    throw new Error('usage: skillspub migrate targets [--yes]');
  const plan = printTargetMigration(home);
  if (plan.status === 'already-migrated') return;
  if (!rest.includes('--yes')) return;
  applyTargetMigration(home, plan);
  console.log(`Migrated Target registry: ${plan.targetFile}`);
}

function prepareGlobalMutation(home: ReturnType<typeof defaultHome>): void {
  scanGlobalInventory(home);
}

function cmdTag(home: ReturnType<typeof defaultHome>, args: string[]): void {
  const [action, resource, ...names] = args;
  switch (action) {
    case 'add': {
      if (!resource || names.length === 0)
        throw new Error('usage: skillspub tag add <resource> <tag...>');
      prepareGlobalMutation(home);
      const added = addResourceTags(home, resource, names);
      console.log(`added ${added} tag${added === 1 ? '' : 's'} to ${resource}`);
      break;
    }
    case 'rm': {
      if (!resource) throw new Error('usage: skillspub tag rm <resource> [<tag...>]');
      prepareGlobalMutation(home);
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

function printPresetPlan(plan: PresetReconcilePlan): void {
  console.log('Plan:');
  if (plan.targets.length === 0) console.log('  no Target Slot changes');
  else for (const target of plan.targets) {
    const intent = target.intent === target.to
      ? ''
      : ` (Base intent ${target.intent}; claimed ${target.to})`;
    console.log(
      `  ${target.targetId}/${target.slot}\t${target.from} -> ${target.to}${intent}`,
    );
  }
  if (plan.staleResourceIds.length > 0) {
    console.log('Stale selectors:');
    for (const id of plan.staleResourceIds) console.log(`  - skill:${id}`);
  }
}

function runPresetPlan(
  home: ReturnType<typeof defaultHome>,
  plan: PresetReconcilePlan,
  scope: PresetScope,
): void {
  printPresetPlan(plan);
  try {
    applyPresetReconcile(home, plan, scope);
  } catch (error) {
    let drift: string;
    try {
      const report = scope.projectPath
        ? scanProjectInventory(home, scope.projectPath)
        : scanGlobalInventory(home);
      drift = remainingDrift(plan, report).join(', ') || 'none';
    } catch (scanError) {
      drift = `could not rescan: ${(scanError as Error).message}`;
    }
    throw new Error(`${(error as Error).message}\nRemaining drift: ${drift}`);
  }
  if (scope.projectPath) scanProjectInventory(home, scope.projectPath);
  else scanGlobalInventory(home);
}

function cmdPreset(
  home: ReturnType<typeof defaultHome>,
  args: string[],
  projectPath?: string,
): void {
  const scope: PresetScope = projectPath ? { projectPath } : {};
  const [action, name, ...rest] = args;
  switch (action) {
    case 'ls': {
      if (name) throw new Error('usage: skillspub preset ls');
      const presets = listPresets(home);
      if (presets.length === 0) console.log('no presets found');
      else for (const preset of presets)
        console.log(`${preset.name}\t${preset.selectors}`);
      break;
    }
    case 'show': {
      if (!name || rest.length > 0)
        throw new Error('usage: skillspub preset show <name>');
      console.log(name);
      const selectors = showPreset(home, name);
      if (selectors.length === 0) console.log('  no selectors');
      else for (const item of selectors) console.log(`  ${item.selector}`);
      break;
    }
    case 'create': {
      if (!name) throw new Error('usage: skillspub preset create <name> [<selector...>]');
      prepareGlobalMutation(home);
      const count = createPreset(home, name, rest);
      console.log(`created preset ${name} with ${count} selector${count === 1 ? '' : 's'}`);
      break;
    }
    case 'add': {
      if (!name || rest.length === 0)
        throw new Error('usage: skillspub preset add <name> <selector...>');
      prepareGlobalMutation(home);
      const added = addPresetSelectors(home, name, rest);
      console.log(`added ${added} selector${added === 1 ? '' : 's'} to ${name}`);
      break;
    }
    case 'rm': {
      if (!name) throw new Error('usage: skillspub preset rm <name> [<selector...>]');
      prepareGlobalMutation(home);
      const removed = removePresetSelectors(home, name, rest);
      console.log(removed === undefined
        ? `removed preset ${name}`
        : `removed ${removed} selector${removed === 1 ? '' : 's'} from ${name}`);
      break;
    }
    case 'activate': {
      if (!name || rest.length === 0)
        throw new Error('usage: skillspub preset activate <name> <target...>');
      runPresetPlan(home, activatePreset(home, name, rest, scope), scope);
      break;
    }
    case 'deactivate': {
      if (!name || rest.length === 0)
        throw new Error('usage: skillspub preset deactivate <name> <target...>');
      runPresetPlan(home, deactivatePreset(home, name, rest, scope), scope);
      break;
    }
    case 'reconcile': {
      const presetName = name;
      const targets = rest;
      runPresetPlan(
        home,
        planPresetReconcile(home, presetName, targets.length > 0 ? targets : undefined, scope),
        scope,
      );
      break;
    }
    case 'delete': {
      if (!name) throw new Error('usage: skillspub preset delete <name> [--yes]');
      const yes = rest.includes('--yes');
      if (rest.some((arg) => arg !== '--yes'))
        throw new Error('usage: skillspub preset delete <name> [--yes]');
      deletePreset(home, name, { yes, projectPath });
      console.log(`deleted preset ${name}`);
      break;
    }
    default:
      throw new Error(
        'usage: skillspub preset ls|show|create|add|rm|activate|deactivate|reconcile|delete ...',
      );
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
      prepareGlobalMutation(home);
      const count = createBundle(home, name, selectors);
      console.log(`created bundle ${name} with ${count} member${count === 1 ? '' : 's'}`);
      break;
    }
    case 'add': {
      if (!name || selectors.length === 0)
        throw new Error('usage: skillspub bundle add <name> <skill...>');
      prepareGlobalMutation(home);
      const added = addBundleMembers(home, name, selectors);
      console.log(`added ${added} member${added === 1 ? '' : 's'} to ${name}`);
      break;
    }
    case 'rm': {
      if (!name) throw new Error('usage: skillspub bundle rm <name> [<skill>...]');
      prepareGlobalMutation(home);
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
      console.log('Running Harnesses must reload/restart to read the final Shared Target state.');
      break;
    }
    case 'update': {
      if (rest.some((arg) => arg.startsWith('-')))
        throw new Error('usage: skillspub shared update [<managed-name>...]');
      const result = sharedUpdate(home, rest, projectPath);
      console.log(`Actual: ${result.actual}`);
      console.log(`Remaining drift: ${result.drift.join(', ') || 'none'}`);
      console.log('Running Harnesses must reload/restart to read the final Shared Target state.');
      break;
    }
    case 'remove': {
      if (rest.length === 0 || rest.some((arg) => arg.startsWith('-')))
        throw new Error('usage: skillspub shared remove <managed-name...>');
      const result = sharedRemove(home, rest, projectPath);
      console.log(`Actual: ${result.actual}`);
      console.log(`Remaining drift: ${result.drift.join(', ') || 'none'}`);
      console.log('Running Harnesses must reload/restart to read the final Shared Target state.');
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
    const action = repair.kind === 'retarget-link'
      ? 'retarget Link'
      : repair.kind === 'migrate-legacy-off'
        ? 'migrate legacy OFF'
        : 'remove broken link';
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
  console.log('Target roots:');
  for (const target of report.targets) {
    const source = target.scope === 'global' ? 'Global' : target.sourceDirectory;
    const access = target.writable ? 'writable' : `read-only from ${source}`;
    console.log(`  - ${target.id} [${access}] ${target.discoveryRoot} | OFF ${target.parkingRoot}`);
  }
  console.log('Relationships:');
  if (report.relationships.length === 0) console.log('  none');
  for (const relationship of report.relationships) {
    const target = report.targets.find(({ id }) => id === relationship.targetId);
    const source = target?.scope === 'global' ? 'Global' : target?.sourceDirectory;
    const access = relationship.readOnly ? `read-only from ${source}` : 'writable';
    const linkTarget = relationship.target ? ` -> ${relationship.target}` : '';
    console.log(
      `  - ${relationship.name} @ ${relationship.targetId}: ` +
      `${relationship.activation} ${relationship.form} [${access}] ${relationship.path}${linkTarget}`,
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
  const home = defaultHome({ migrate: false });
  try {
    if (shouldRunTui(cmd, stdinIsTty, stdoutIsTty)) {
      let projectPath: string | undefined;
      const args = [...rest];
      while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--project') projectPath = args.shift() ?? process.cwd();
        else throw new Error('usage: skillspub tui [--project [path]]');
      }
      await (await import('./tui.ts')).runTui(home, { projectPath });
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
      case 'preset':
        cmdPreset(home, rest);
        break;
      case 'shared':
        cmdShared(home, rest);
        break;
      case 'scan':
        if (rest.length > 0) throw new Error('usage: skillspub scan');
        printScan(scanGlobalInventory(home, undefined, { persist: false }));
        break;
      case 'doctor':
        cmdDoctor(home, rest);
        break;
      case 'project': {
        const [projectPath, projectCommand, ...projectArgs] = rest;
        if (!projectPath) throw new Error('usage: skillspub project <path> scan|doctor|shared|preset');
        if (projectCommand === 'scan' && projectArgs.length === 0)
          printScan(scanProjectInventory(home, projectPath, undefined, { persist: false }));
        else if (projectCommand === 'doctor') cmdDoctor(home, projectArgs, projectPath);
        else if (projectCommand === 'shared') cmdShared(home, projectArgs, projectPath);
        else if (projectCommand === 'preset') cmdPreset(home, projectArgs, projectPath);
        else throw new Error('usage: skillspub project <path> scan|doctor|shared|preset');
        break;
      }
      case 'targets':
        cmdTargets(home, rest);
        break;
      case 'migrate':
        cmdMigrate(home, rest);
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
