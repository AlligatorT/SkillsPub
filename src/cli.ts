#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultHome } from './core.ts';
import {
  ExplainError,
  explainVisibility,
  type VisibilityExplanation,
  type WantedVisibility,
} from './explain.ts';
import {
  inspectHarness,
  inspectHarnesses,
  planHarnessOperation,
} from './harnesses/registry.ts';
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
  planSharedRemove,
  sharedRemove,
  sharedRefresh,
  sharedOutdated,
  sharedUpdate,
  type SharedDescribeResult,
  type SharedFindResult,
  type SharedUpdateAvailabilityResult,
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
  planMirrorAction,
  planPresetReconcile,
  remainingDrift,
  type PresetReconcilePlan,
  type PresetScope,
} from './reconcile.ts';

const USAGE = `SkillsPub — multi-agent skills on/off manager (disk is the source of truth)

  skillspub ls [--target T] [--tag T]  skill × Target matrix (+ untagged/deadlink hints)
  skillspub on|off <selector> <target...> [--yes]  update Skill Target relationships
  skillspub status <skill>             per-Target state of one skill
  skillspub explain <selector> [--harness H] [--want visible|hidden]
  skillspub mirror sync|overwrite|remove|convert <target-id> <slot> [--yes]
  skillspub bundle ls|show|create|add|rm ...
  skillspub tag add|rm|ls ...          manage global resource Tags
  skillspub preset create|add|rm|ls|show|activate|deactivate|reconcile|delete ...
  skillspub shared find|describe|refresh|outdated|add|update|remove ...  manage the Shared Target via skills@1.5.21
  skillspub scan                       explicitly scan Global Skill Target inventory
  skillspub doctor [--repair --yes]    diagnose; explicitly confirm safe repairs
  skillspub project <path> scan|doctor|explain|shared|preset|mirror|harnesses ...  operate on exact Project Skill Targets
  skillspub targets                    list resolved Skill Targets
  skillspub harnesses [name inspect|setup|reconcile [--yes]]  inspect or configure a Harness
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

type JsonData = Record<string, unknown>;

class CliError extends Error {
  readonly code: string;
  readonly exitCode: 1 | 2;
  readonly details?: JsonData;

  constructor(code: string, message: string, exitCode: 1 | 2, details?: JsonData) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

interface LsData extends JsonData {
  targets: string[];
  rows: Array<{
    name: string;
    resourceId: string;
    relationships: Array<{
      target: string;
      slot: string;
      presence: string;
      form: string;
    }>;
  }>;
  deadlinks: string[];
  untagged: string[];
  warnings: string[];
}

function writeJson(document: JsonData): void {
  process.stdout.write(`${JSON.stringify(document)}\n`);
}

function errorInfo(error: unknown): {
  code: string;
  exitCode: 1 | 2;
  details: JsonData;
} {
  if (error instanceof CliError)
    return { code: error.code, exitCode: error.exitCode, details: error.details ?? {} };
  const err = error as Error & { code?: string };
  return err.code?.startsWith('ERR_PARSE_ARGS') || err.message.startsWith('usage:')
    ? { code: 'usage_error', exitCode: 2, details: {} }
    : { code: 'runtime_error', exitCode: 1, details: {} };
}

const MUTATING_COMMANDS = new Set(['on', 'off', 'mirror', 'migrate']);
const MUTATING_ACTIONS: Record<string, ReadonlySet<string>> = {
  harnesses: new Set(['setup', 'reconcile']),
  bundle: new Set(['create', 'add', 'rm']),
  tag: new Set(['add', 'rm']),
  preset: new Set(['create', 'add', 'rm', 'activate', 'deactivate', 'reconcile', 'delete']),
  shared: new Set(['add', 'update', 'remove']),
};

function supportsReadOnlyJson(command: string | undefined, args: string[]): boolean {
  if (command === 'project') {
    const [, projectCommand, ...projectArgs] = args;
    return supportsReadOnlyJson(projectCommand, projectArgs);
  }
  if (!command || !MUTATING_COMMANDS.has(command)) {
    if (command === 'doctor') return !args.includes('--repair');
    const actions = MUTATING_ACTIONS[command ?? ''];
    return !actions?.has(args[command === 'harnesses' ? 1 : 0] ?? '');
  }
  return false;
}

function printExplanation(explanation: VisibilityExplanation): void {
  const scope = explanation.scope.projectPath
    ? `Project ${explanation.scope.projectPath}`
    : 'Global';
  console.log(`${explanation.resource.name} (${explanation.resource.realPath})`);
  console.log(`Scope: ${scope}`);
  for (const harness of explanation.harnesses) {
    console.log(`\n${harness.name}: ${harness.effectiveVisibility}${harness.detected ? '' : ' (not detected)'}`);
    console.log(`  support: ${harness.support}`);
    console.log(`  Shared: ${harness.sharedConsumption.status} — ${harness.sharedConsumption.detail}`);
    console.log(`  isolation: ${harness.isolation.status} — ${harness.isolation.detail}`);
    for (const evidence of harness.evidence)
      console.log(`  evidence: ${evidence.verifiedVersion} ${evidence.url} — ${evidence.detail}`);
    for (const reason of harness.reasons) console.log(`  reason: ${reason.message}`);
    for (const warning of harness.warnings) console.log(`  warning: ${warning.message}`);
    for (const conflict of harness.conflicts) console.log(`  conflict: ${conflict.message}`);
    for (const root of harness.roots) {
      console.log(`  ${root.consumption}: ${root.path} — ${root.reason}`);
      for (const relationship of root.relationships)
        console.log(`    ${relationship.activation} ${relationship.form} ${relationship.path}${relationship.selected ? ' (selected)' : ''}`);
    }
    if (harness.plan) {
      console.log(`  wanted: ${explanation.wanted}; executable: ${harness.plan.executable}`);
      for (const step of harness.plan.steps)
        console.log(`  step: ${step.operation} ${step.targetId}/${step.slot}`);
      for (const blocker of harness.plan.blockers) console.log(`  blocker: ${blocker.message}`);
    }
  }
}

function cmdExplain(
  home: ReturnType<typeof defaultHome>,
  args: string[],
  projectPath?: string,
  json = false,
): VisibilityExplanation {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      harness: { type: 'string' },
      want: { type: 'string' },
    },
  });
  if (parsed.positionals.length !== 1)
    throw new Error('usage: skillspub explain <selector> [--harness H] [--want visible|hidden]');
  if (parsed.values.want !== undefined &&
    parsed.values.want !== 'visible' && parsed.values.want !== 'hidden')
    throw new Error('usage: --want must be visible or hidden');
  try {
    const result = explainVisibility(home, parsed.positionals[0], {
      projectPath,
      harness: parsed.values.harness,
      want: parsed.values.want as WantedVisibility | undefined,
    });
    if (!json) printExplanation(result);
    return result;
  } catch (error) {
    if (!(error instanceof ExplainError)) throw error;
    throw new CliError(
      error.code,
      error.message,
      error.code === 'unknown_harness' ? 2 : 1,
      error.details,
    );
  }
}

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

function matchingInstances(rows: Row[], selector: string): Row[] {
  if (selector.startsWith('skill:')) {
    const resourceId = selector.slice('skill:'.length);
    return rows.filter((row) => row.realPath === resourceId);
  }
  return rows.filter((row) =>
    row.relationships.some((relationship) => relationship.name === selector),
  );
}

function variantLocation(row: Row): string {
  return row.realPath
    ?? `${row.relationships[0].info.path} -> ${row.relationships[0].info.target ?? '?'}`;
}

function refuseAmbiguousName(rows: Row[], name: string): void {
  const matches = matchingInstances(rows, name);
  if (matches.length < 2) return;
  const details = {
    name,
    matches: matches.map((row) => ({
      name: row.displayName,
      selector: `skill:${row.realPath ?? variantLocation(row)}`,
      location: variantLocation(row),
    })),
  };
  throw new CliError(
    'ambiguous_selector',
    `skill name "${name}" is ambiguous:\n${matches
      .map((row) => `  - ${row.displayName}: ${variantLocation(row)}`)
      .join('\n')}\nUse skillspub tui to select a specific variant.`,
    1,
    details,
  );
}

function cmdLs(
  home: ReturnType<typeof defaultHome>,
  args: string[],
  json = false,
): LsData | undefined {
  const { values } = parseArgs({
    args,
    options: { target: { type: 'string' }, agent: { type: 'string' }, tag: { type: 'string' } },
  });
  if (values.target && values.agent)
    throw new Error('usage: skillspub ls [--target T] [--tag T]');
  const warnings = values.agent ? ['--agent is deprecated; use --target'] : [];
  if (!json && warnings.length > 0) console.error(`warning: ${warnings[0]}`);
  const target = values.target ?? values.agent;
  const report = scanGlobalInventory(home, undefined, { persist: false });
  const targets = viewTargets(report);
  if (target && !targets.some((candidate) => candidate.name === target))
    throw new CliError('unknown_target', `unknown target: ${target}`, 1, { target });
  const { tags } = readViewState(home);
  let rows = filterRows(projectRows(report), { target, tag: values.tag }, tags);
  if (values.tag && !target) {
    try {
      const selected = new Set(expandSelector(home, `tag:${values.tag}`, report).resourceIds);
      rows = rows.filter((row) => row.realPath && selected.has(row.realPath));
    } catch (error) {
      if ((error as Error).message !== `unknown Tag: ${values.tag}`) throw error;
      rows = [];
    }
  }
  const cols = target ? [target] : targets.map((candidate) => candidate.name);
  const deadlinks = rows.flatMap((row) =>
    row.relationships
      .filter(({info}) => info.presence === 'deadlink')
      .map(({target, name, info}) => `${target}/${name} -> ${info.target ?? '?'}`),
  );
  const untaggedRows = untagged(rows, tags);
  const data: LsData = {
    targets: cols,
    rows: rows.map((row) => ({
      name: row.displayName,
      resourceId: row.realPath ?? row.relationships[0].info.path,
      relationships: row.relationships.map(({ target, name, info }) => ({
        target,
        slot: name,
        presence: info.presence,
        form: info.form,
      })),
    })),
    deadlinks,
    untagged: untaggedRows,
    warnings,
  };
  if (json) return data;
  if (rows.length === 0) {
    console.log('no skills found');
    return;
  }
  if (values.tag && !target) {
    for (const row of data.rows) {
      const relationships = row.relationships
        .map(({ target, slot, presence }) => `global:${target}/${slot}:${presence}`)
        .join(', ');
      console.log(`${row.name}\tskill:${row.resourceId}\t${relationships}`);
    }
    return;
  }
  printMatrix(rows, cols);
  if (deadlinks.length > 0) console.log(`\n死链 (doctor 清理): ${deadlinks.join(', ')}`);
  if (untaggedRows.length > 0)
    console.log(`未分类 (skillspub tag add): ${untaggedRows.join(', ')}`);
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
    const mirror = target.createForm === 'mirror'
      ? ' (create Mirror)'
      : target.syncMirror ? ' (synchronize Mirror)' : '';
    console.log(
      `  ${target.targetId}/${target.slot}\t${target.from} -> ${target.to}${intent}${mirror}`,
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

function cmdMirror(home: ReturnType<typeof defaultHome>, args: string[], projectPath?: string): void {
  const [action, targetId, slot, ...rest] = args;
  if (!['sync', 'overwrite', 'remove', 'convert'].includes(action ?? '') || !targetId || !slot ||
    rest.some((arg) => arg !== '--yes'))
    throw new Error('usage: skillspub mirror sync|overwrite|remove|convert <target-id> <slot> [--yes]');
  const plan = planMirrorAction(home, targetId, slot, action as 'sync' | 'overwrite' | 'remove' | 'convert',
    projectPath ? { projectPath } : {});
  const target = plan.targets[0];
  console.log(`Mirror plan: ${action} ${target?.targetId}/${target?.slot}`);
  if (!rest.includes('--yes')) return;
  applyActivationPlan(home, plan);
  if (projectPath) scanProjectInventory(home, projectPath);
  else scanGlobalInventory(home);
}

function cmdStatus(
  home: ReturnType<typeof defaultHome>,
  args: string[],
  json = false,
): JsonData | undefined {
  const [skill] = args;
  if (!skill || args.length !== 1) throw new Error('usage: skillspub status <skill>');
  const report = scanGlobalInventory(home, undefined, { persist: false });
  const targets = viewTargets(report);
  const matches = matchingInstances(projectRows(report), skill);
  if (matches.length === 0) {
    if (json) throw new CliError(
      'resource_not_found',
      `${skill} not found in any Target`,
      1,
      { selector: skill },
    );
    console.error(`warning: ${skill} not found in any Target`);
    process.exitCode = 1;
    return;
  }
  refuseAmbiguousName(matches, skill);
  if (json) {
    const instance = matches[0];
    return {
      name: skill,
      resourceId: instance.realPath ?? variantLocation(instance),
      targets: targets.map((target) => ({
        target: target.name,
        relationships: relationships(instance, target.name).map(({ name, info }) => ({
          slot: name,
          presence: info.presence,
          form: info.form,
          path: info.path,
          ...(info.target ? { linkTarget: info.target } : {}),
        })),
      })),
    };
  }
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

function cmdTargets(
  home: ReturnType<typeof defaultHome>,
  args: string[],
  json = false,
): ReturnType<typeof loadTargets> | undefined {
  if (args.length > 0) throw new Error('usage: skillspub targets');
  const targets = loadTargets(home);
  if (json) return targets;
  for (const target of targets) {
    console.log([
      target.key,
      target.kind,
      target.discoveryRoot,
      target.parkingRoot,
    ].join('\t'));
  }
}

function printHarnesses(
  title: string,
  harnesses: ReturnType<typeof inspectHarnesses>['detected'],
): void {
  console.log(title);
  if (harnesses.length === 0) {
    console.log('  none');
    return;
  }
  for (const harness of harnesses) {
    console.log(`${harness.key}\t${harness.support}\tShared ${harness.sharedConsumption.status}\tIsolation ${harness.isolation.status}\tLink ${harness.link.supported ? 'supported' : 'unsupported'}${harness.mirror ? `\tMirror ${harness.mirror.supported ? 'supported' : 'unsupported'}` : ''}`);
    console.log(`  Shared: ${harness.sharedConsumption.detail}`);
    console.log(`  Isolation: ${harness.isolation.detail}`);
    for (const target of harness.targets)
      console.log(`  target\t${target.scope}\t${target.discoveryRoot}`);
    for (const evidence of harness.evidence)
      console.log(`  evidence\tv${evidence.verifiedVersion}\t${evidence.url}`);
  }
}

function cmdHarnesses(
  home: ReturnType<typeof defaultHome>,
  args: string[],
  projectPath?: string,
  json = false,
): ReturnType<typeof inspectHarnesses> | ReturnType<typeof inspectHarness> | undefined {
  const targets = loadTargets(home);
  const selectedProject = projectPath ? fs.realpathSync(projectPath) : undefined;
  if (args.length === 0) {
    const report = inspectHarnesses(home, targets, selectedProject);
    if (json) return report;
    printHarnesses('Detected Harnesses:', report.detected);
    printHarnesses('Available Harnesses:', report.available);
    return;
  }
  const [harness, action, ...rest] = args;
  if (!harness || !['inspect', 'setup', 'reconcile'].includes(action ?? '') ||
    rest.some((arg) => arg !== '--yes') || (action === 'inspect' && rest.length > 0))
    throw new Error('usage: skillspub harnesses [name inspect|setup|reconcile [--yes]]');
  if (action === 'inspect') {
    const inspection = inspectHarness(harness, home, targets, selectedProject);
    if (json) return inspection;
    printHarnesses(`${harness} Harness:`, [inspection]);
    return;
  }
  const plan = planHarnessOperation(
    harness,
    action as 'setup' | 'reconcile',
    home,
    targets,
    selectedProject,
  );
  console.log(plan.title);
  for (const line of plan.lines) console.log(`  ${line}`);
  if (!rest.includes('--yes')) return;
  plan.apply();
  if (plan.recovery?.length) {
    console.log('Manual recovery:');
    for (const line of plan.recovery) console.log(`  ${line}`);
  }
  const inspection = plan.verify();
  console.log(`${inspection.name} ${action} verified.`);
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

function cmdTag(
  home: ReturnType<typeof defaultHome>,
  args: string[],
  json = false,
): ReturnType<typeof tagsForResource> | ReturnType<typeof listTags> | undefined {
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
        if (json) return resourceTags;
        console.log(`${resourceTags.name ?? resourceTags.id}\tskill:${resourceTags.id}${resourceTags.stale ? '\tstale' : ''}`);
        if (resourceTags.tags.length === 0) console.log('  no tags');
        else for (const tag of resourceTags.tags) console.log(`  ${tag}`);
      } else {
        const tags = listTags(home);
        if (json) return tags;
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
  json = false,
): JsonData | ReturnType<typeof listPresets> | undefined {
  const scope: PresetScope = projectPath ? { projectPath } : {};
  const [action, name, ...rest] = args;
  switch (action) {
    case 'ls': {
      if (name) throw new Error('usage: skillspub preset ls');
      const presets = listPresets(home);
      if (json) return presets;
      if (presets.length === 0) console.log('no presets found');
      else for (const preset of presets)
        console.log(`${preset.name}\t${preset.selectors}`);
      break;
    }
    case 'show': {
      if (!name || rest.length > 0)
        throw new Error('usage: skillspub preset show <name>');
      const selectors = showPreset(home, name);
      if (json) return { name, selectors };
      console.log(name);
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

function cmdBundle(
  home: ReturnType<typeof defaultHome>,
  args: string[],
  json = false,
): JsonData | ReturnType<typeof listBundles> | undefined {
  const [action, name, ...selectors] = args;
  switch (action) {
    case 'ls': {
      if (name) throw new Error('usage: skillspub bundle ls');
      const bundles = listBundles(home);
      if (json) return bundles;
      if (bundles.length === 0) console.log('no bundles found');
      else for (const bundle of bundles) console.log(`${bundle.name}\t${bundle.members}`);
      break;
    }
    case 'show': {
      if (!name || selectors.length > 0)
        throw new Error('usage: skillspub bundle show <name>');
      const members = showBundle(home, name);
      if (json) return { name, members };
      console.log(name);
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
  json = false,
): SharedFindResult | SharedDescribeResult | SharedUpdateAvailabilityResult | undefined {
  const [action, ...rest] = args;
  switch (action) {
    case 'find':
      return sharedFind(home, rest, projectPath, !json);
    case 'describe':
      if (rest.length !== 1 || rest[0].startsWith('-'))
        throw new Error('usage: skillspub shared describe <source>');
      return sharedDescribe(home, rest[0], projectPath, !json);
    case 'refresh':
    case 'outdated': {
      if (rest.length > 0) throw new Error(`usage: skillspub shared ${action}`);
      const result = action === 'refresh'
        ? sharedRefresh(home, projectPath)
        : sharedOutdated(home, projectPath);
      if (!json) for (const entry of result.entries)
        console.log([
          entry.status,
          entry.name,
          entry.source,
          entry.checkedAt ?? '-',
          entry.error ?? '',
        ].join('\t'));
      return result;
    }
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
      const { values, positionals } = parseArgs({
        args: rest,
        options: { yes: { type: 'boolean' } },
        allowPositionals: true,
        strict: true,
      });
      if (positionals.length === 0)
        throw new Error('usage: skillspub shared remove <managed-name...> [--yes]');
      const preview = planSharedRemove(home, positionals, projectPath);
      console.log('Removal plan:');
      if (preview.dependencies.length === 0) console.log('  no scanned dependent Relationships');
      else for (const dependency of preview.dependencies)
        console.log(`  - ${dependency.targetId}/${dependency.slot}: ${dependency.form} ${dependency.path}`);
      console.log('Warning: SkillsPub has no central project index; projects outside this scan may retain broken Links.');
      const result = sharedRemove(home, positionals, {
        cascadeConfirmed: Boolean(values.yes),
        projectPath,
        expected: preview,
      });
      console.log(`Actual: ${result.actual}`);
      console.log(`Remaining drift: ${result.drift.join(', ') || 'none'}`);
      console.log('Running Harnesses must reload/restart to read the final Shared Target state.');
      break;
    }
    default:
      throw new Error('usage: skillspub shared find|describe|refresh|outdated|add|update|remove ...');
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
  json = false,
): DoctorReport | undefined {
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
  if (json) return report;
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

function printHarnessDrift(
  home: ReturnType<typeof defaultHome>,
  targets: InventoryScanReport['targets'],
): void {
  const harnesses = inspectHarnesses(home, targets);
  const drift = [...harnesses.detected, ...harnesses.available]
    .filter((harness) => harness.isolation.status === 'drift');
  console.log('Harness drift:');
  if (drift.length === 0) console.log('  none');
  else for (const harness of drift)
    console.log(`  - ${harness.name} Shared isolation: ${harness.isolation.detail}`);
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
  const json = args.includes('--json');
  const [cmd, ...rest] = args.filter((arg) => arg !== '--json');
  const home = defaultHome({ migrate: false });
  try {
    let data: unknown;
    if (json && cmd === 'tui')
      throw new CliError('usage_error', 'skillspub tui does not support --json', 2);
    if (json && !supportsReadOnlyJson(cmd, rest))
      throw new CliError(
        'json_not_supported',
        'JSON mode for mutating commands is not available yet',
        2,
      );
    if (!json && shouldRunTui(cmd, stdinIsTty, stdoutIsTty)) {
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
        data = cmdLs(home, rest, json);
        break;
      case 'on':
        cmdOnOff(home, true, rest);
        break;
      case 'off':
        cmdOnOff(home, false, rest);
        break;
      case 'status':
        data = cmdStatus(home, rest, json);
        break;
      case 'explain':
        data = cmdExplain(home, rest, undefined, json);
        break;
      case 'mirror':
        cmdMirror(home, rest);
        break;
      case 'bundle':
        data = cmdBundle(home, rest, json);
        break;
      case 'tag':
        data = cmdTag(home, rest, json);
        break;
      case 'preset':
        data = cmdPreset(home, rest, undefined, json);
        break;
      case 'shared':
        data = cmdShared(home, rest, undefined, json);
        break;
      case 'scan': {
        if (rest.length > 0) throw new Error('usage: skillspub scan');
        const report = scanGlobalInventory(home, undefined, { persist: false });
        if (json) data = { inventory: report, harnesses: inspectHarnesses(home, report.targets) };
        else {
          printScan(report);
          printHarnessDrift(home, report.targets);
        }
        break;
      }
      case 'doctor':
        data = cmdDoctor(home, rest, undefined, json);
        break;
      case 'project': {
        const [projectPath, projectCommand, ...projectArgs] = rest;
        if (!projectPath) throw new Error('usage: skillspub project <path> scan|doctor|explain|shared|preset|mirror|harnesses');
        if (projectCommand === 'scan' && projectArgs.length === 0) {
          const report = scanProjectInventory(home, projectPath, undefined, { persist: false });
          if (json) data = report;
          else printScan(report);
        } else if (projectCommand === 'doctor')
          data = cmdDoctor(home, projectArgs, projectPath, json);
        else if (projectCommand === 'explain')
          data = cmdExplain(home, projectArgs, projectPath, json);
        else if (projectCommand === 'shared')
          data = cmdShared(home, projectArgs, projectPath, json);
        else if (projectCommand === 'preset')
          data = cmdPreset(home, projectArgs, projectPath, json);
        else if (projectCommand === 'mirror') cmdMirror(home, projectArgs, projectPath);
        else if (projectCommand === 'harnesses')
          data = cmdHarnesses(home, projectArgs, projectPath, json);
        else throw new Error('usage: skillspub project <path> scan|doctor|explain|shared|preset|mirror|harnesses');
        break;
      }
      case 'targets':
        data = cmdTargets(home, rest, json);
        break;
      case 'harnesses':
        data = cmdHarnesses(home, rest, undefined, json);
        break;
      case 'migrate':
        cmdMigrate(home, rest);
        break;
      default:
        if (json) throw new Error(`usage: ${cmd ? `unknown command ${cmd}` : 'skillspub <command>'}`);
        process.stderr.write(USAGE);
        process.exitCode = cmd === undefined ? 0 : 2;
        return;
    }
    if (json) writeJson({ schemaVersion: 1, ok: true, data });
  } catch (err) {
    if (json) {
      const { code, exitCode, details } = errorInfo(err);
      writeJson({
        schemaVersion: 1,
        ok: false,
        error: {
          code,
          message: (err as Error).message,
          details,
        },
      });
      process.exitCode = exitCode;
    } else {
      console.error(`skillspub: ${(err as Error).message}`);
      process.exitCode = errorInfo(err).exitCode;
    }
  }
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) await main();
