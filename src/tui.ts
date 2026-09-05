import {createElement as h, useEffect, useMemo, useState} from 'react';
import type {ReactNode} from 'react';
import fs from 'node:fs';
import path from 'node:path';
import {Box, Text, render, useApp, useInput, useStdout} from 'ink';
import wrapAnsi from 'wrap-ansi';
import {
  defaultHome,
  type Home,
} from './core.ts';
import {
  searchRows,
  skillDetail,
  sortRows,
  harnessStatusBadge,
  projectTuiSnapshot,
  tuiSnapshot,
  type Target,
  type Row,
  type SkillInfo,
  type SortOrder,
  type SkillRelationship,
  type TuiSnapshot,
} from './view.ts';
import {
  applyActivationPlan,
  planActivation,
  planLink,
  planMirrorAction,
  planToggle,
  planUnlink,
  type ActivationPlan,
  type PresetScope,
} from './reconcile.ts';
import {
  hashDirectory,
  scanGlobalInventory,
  scanProjectInventory,
} from './inventory.ts';
import {
  addPresetSelectors,
  addResourceTags,
  createPreset,
  removePresetSelectors,
  removeResourceTags,
} from './catalog.ts';
import {
  explainVisibility,
  type VisibilityExplanation,
  type WantedVisibility,
} from './explain.ts';
import {
  planSharedAdd,
  planSharedRemove,
  sharedAdd,
  sharedFind,
  sharedRemove,
  sharedRemoveCascade,
  sharedOutdated,
  sharedRefresh,
  sharedUpdate,
  type SharedCommandResult,
  type SharedMutationPlan,
  type SharedRemovalPlan,
  type SharedUpdateAvailabilityEntry,
} from './shared.ts';
import {
  normalizeNpxSkillsName,
  readNpxSkillsLock,
  type NpxSkillsCandidate,
} from './npx-skills.ts';

/** Below this width the passive summary column is hidden. */
const WIDE_MIN = 80;
const MANAGED_SUPPORT_EXPLANATION = 'Managed support: verified Adapter can control and explain this Harness; it does not mean optional setup/reconcile was applied.';

type Tab = 'target' | 'skill' | 'source';
type SourceScope = 'global' | 'project';
type SourceSurface = 'catalog' | 'inventory';
type HarnessSummary = TuiSnapshot['harnesses']['detected'][number];

interface RelEntry {
  row: Row;
  relationship: SkillRelationship;
  key: string;
}

interface ManageState {
  rowId: string;
  section: 'tags' | 'presets';
  index: number;
  input?: { kind: 'tag' | 'preset'; value: string };
}

interface BatchConfirm {
  intent: 'on' | 'off';
  targetName: string;
  plans: ActivationPlan[];
  errors: string[];
}

interface Confirmation {
  kind: 'link' | 'unlink' | 'mirror-create' | 'mirror-sync' | 'mirror-overwrite' | 'mirror-convert' | 'mirror-remove';
  row: Row;
  target: Target;
  info?: SkillInfo;
  targetId: string;
  slot: string;
  source: string;
  destination: string;
}

interface ExplainModalState {
  row: Row;
  harness: string;
  want?: WantedVisibility;
  scroll: number;
}

type UpdateOutcome = 'updated' | 'skipped' | 'failed';

interface UpdateItem extends SharedUpdateAvailabilityEntry {
  outcome?: UpdateOutcome;
  mark?: string;
}

interface UpdateModalState {
  kind: 'refresh' | 'confirm' | 'result';
  items: UpdateItem[];
  scroll: number;
}

type SourceOperationPhase = 'preview' | 'confirm' | 'source-confirm' | 'run' | 'verify' | 'failed';
type SourceStepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';

interface SourceVerifiedTruth {
  resource: string;
  provenance: string;
  slot: string;
  relationships: string[];
  actual: string;
  desired: string;
  drift: string;
  updateAvailability: string;
  effectiveVisibility: string;
}

interface SourceOperationState {
  phase: SourceOperationPhase;
  plan: SharedMutationPlan | SharedRemovalPlan;
  candidate?: NpxSkillsCandidate;
  runStep?: 'cascade' | 'source';
  steps: Array<{name: string; status: SourceStepStatus}>;
  scroll: number;
  retry?: boolean;
  result?: SharedCommandResult;
  truth?: SourceVerifiedTruth;
  error?: string;
  log?: string;
}

/** Existing relationships of one target, in inventory order (absent skills excluded). */
function entriesFor(rows: Row[], targetName: string): RelEntry[] {
  return rows.flatMap((row) =>
    row.relationships
      .filter((relationship) => relationship.target === targetName)
      .map((relationship) => ({
        row,
        relationship,
        key: relationship.info.path,
      })),
  );
}

/** Fixed-width status column so skill names align; deadlink gets '!' (red + target suffix carry the rest). */
function statusText(info: SkillInfo): string {
  const form = info.mirrored ? 'mirror' : info.linked ? 'link' : 'local';
  const base = `${info.underOff ? '[ OFF ]' : '[ ON ]'} ${form}`;
  const text = info.presence === 'deadlink' ? `${base}!` : info.diverged ? `${base}!` : base;
  return text.padEnd('[ OFF ] local'.length);
}

/** Mark identity that survives on/off moves: configDir-relative path with the off-parking prefix stripped. */
function markKey(configDir: string, realPath: string): string {
  return path.relative(configDir, realPath).replace(/^\.skillspub-off\//, '');
}

function statusColor(info: SkillInfo): string {
  if (info.presence === 'deadlink') return 'red';
  return info.presence === 'on' ? 'green' : 'yellow';
}

function updateText(row: Row): string | undefined {
  const update = row.updateAvailability;
  if (!update) return undefined;
  return `${update.status}${update.checkedAt ? ` @ ${update.checkedAt}` : ''}`;
}

function updateColor(row: Row): string | undefined {
  const status = row.updateAvailability?.status;
  return status === 'available'
    ? 'yellow'
    : status === 'current'
      ? 'green'
      : status === 'check-failed' || status === 'upstream-missing'
        ? 'red'
        : undefined;
}

function statusSortValue(info?: SkillInfo): string {
  if (!info) return '3:missing';
  const rank = info.presence === 'on' ? '0' : info.presence === 'off' ? '1' : '2';
  return `${rank}:${info.mirrored ? 'mirror' : info.linked ? 'link' : 'local'}`;
}

function sortLabel(sort: SortOrder): string {
  return sort[0].toUpperCase() + sort.slice(1);
}

function inheritedOn(info?: SkillInfo): boolean {
  return Boolean(info?.readOnly && info.presence === 'on');
}

/** Visible window [start, start+height) that keeps `selected` on screen. */
function windowStart(length: number, selected: number, height: number): number {
  return Math.max(
    0,
    Math.min(selected - Math.floor(height / 2), length - height),
  );
}

function ListColumn({
  title,
  focused,
  width,
  flexGrow,
  children,
}: {
  title: string;
  focused: boolean;
  width?: number;
  flexGrow?: number;
  children?: ReactNode;
}): ReactNode {
  return h(
    Box,
    {
      flexDirection: 'column',
      width,
      flexGrow,
      flexShrink: width === undefined ? 1 : 0,
      borderStyle: 'single',
      borderColor: focused ? 'cyan' : 'gray',
    },
    h(
      Text,
      {bold: focused, color: focused ? 'cyan' : undefined},
      ` ${title}`,
    ),
    children,
  );
}

function RowLine({
  active,
  focused,
  marked,
  wrap = 'truncate-end',
  children,
}: {
  active: boolean;
  focused: boolean;
  marked?: boolean;
  wrap?: 'truncate-end' | 'wrap';
  children?: ReactNode;
}): ReactNode {
  return h(
    Text,
    {inverse: active && focused, bold: (active && !focused) || marked, wrap},
    `${active ? '›' : marked ? '●' : ' '} `,
    children,
  );
}

export function HarnessBadge({
  harness,
  compact = false,
}: {
  harness: Pick<HarnessSummary, 'support' | 'isolation'>;
  compact?: boolean;
}): ReactNode {
  const badge = harnessStatusBadge(harness);
  const text = compact && harness.support === 'discoverable' ? '[discover]' : badge.text;
  return h(Text, {
    color: badge.tone === 'success' ? 'green' : badge.tone === 'danger' ? 'red' : badge.tone === 'warning' ? 'yellow' : undefined,
    dimColor: badge.tone === 'muted',
  }, ` ${text}`);
}

function HarnessRow({harness}: {harness: HarnessSummary}): ReactNode {
  return h(
    Box,
    {width: '100%'},
    h(Box, {flexGrow: 1, flexShrink: 1}, h(Text, {dimColor: true, wrap: 'truncate-end'}, `  ${harness.name}`)),
    h(Box, {flexShrink: 0}, h(HarnessBadge, {harness, compact: true})),
  );
}

function TargetList({
  targets,
  harnesses,
  pendingTargetKeys,
  selected,
  focused,
  maxWidth,
  height,
}: {
  targets: TuiSnapshot['targets'];
  harnesses: TuiSnapshot['harnesses'];
  pendingTargetKeys: TuiSnapshot['pendingTargetKeys'];
  selected: number;
  focused: boolean;
  maxWidth: number;
  height: number;
}): ReactNode {
  const start = windowStart(targets.length, selected, height);
  const detected = new Map(harnesses.detected.map((harness) => [harness.key, harness]));
  const pendingKeys = new Set(pendingTargetKeys);
  const pending = harnesses.detected.filter(({ key }) => pendingKeys.has(key));
  const rowText = (name: string, harness?: HarnessSummary) =>
    `  ${name}${harness ? ` ${harnessStatusBadge(harness).text}` : ''}`;
  const rows = [
    ...targets.map(({name}) => rowText(name, detected.get(name))),
    ...(pending.length === 0 ? [] : [' Pending migration']),
    ...(harnesses.available.length === 0 ? [] : [' Available']),
    ...[...pending, ...harnesses.available].map((harness) => rowText(harness.name, harness)),
  ];
  const width = Math.min(maxWidth, 32, Math.max(18, ...rows.map((row) => row.length + 2)));
  return h(
    ListColumn,
    {title: 'Targets', focused, width},
    ...targets.slice(start, start + height).map((target, index) => {
      const harness = detected.get(target.name);
      return h(
        RowLine,
        {key: `target:${target.name}`, active: start + index === selected, focused},
        target.name,
        harness ? h(HarnessBadge, {harness}) : null,
      );
    }),
    ...(pending.length === 0
      ? []
      : [
          h(Text, {key: 'pending-migration', dimColor: true, wrap: 'truncate-end'}, ' Pending migration'),
          ...pending.map((harness) => h(HarnessRow, {key: `pending:${harness.key}`, harness})),
        ]),
    ...(harnesses.available.length === 0
      ? []
      : [
          h(Text, {key: 'available', dimColor: true, wrap: 'truncate-end'}, ' Available'),
          ...harnesses.available.map((harness) => h(HarnessRow, {key: `available:${harness.key}`, harness})),
        ]),
  );
}

function RelationshipList({
  entries,
  selected,
  focused,
  height,
  marks,
  showScope,
}: {
  entries: RelEntry[];
  selected: number;
  focused: boolean;
  height: number;
  marks?: Set<string>;
  showScope?: boolean;
}): ReactNode {
  const start = windowStart(entries.length, selected, height);
  return h(
    ListColumn,
    {title: 'Relationships', focused, flexGrow: 1},
    ...entries.slice(start, start + height).map((entry, index) => {
      const info = entry.relationship.info;
      const active = start + index === selected;
      return h(
        RowLine,
        {key: entry.key, active, focused, marked: marks?.has(entry.row.id)},
        h(Text, {color: statusColor(info)}, statusText(info)),
        ' ',
        entry.relationship.name === entry.row.name
          ? entry.row.displayName
          : `${entry.relationship.name} → ${entry.row.displayName}`,
        info.presence === 'deadlink' && info.target
          ? h(Text, {dimColor: true}, ` -> ${info.target}`)
          : null,
        showScope && entry.relationship.scope && entry.relationship.scope !== 'project'
          ? h(Text, {dimColor: true}, ` ·${entry.relationship.scope}`)
          : null,
        updateText(entry.row)
          ? h(Text, {color: updateColor(entry.row)}, ` · ${updateText(entry.row)}`)
          : null,
      );
    }),
    entries.length === 0
      ? h(Text, {dimColor: true}, '  no skills for this target')
      : null,
  );
}

/** Skill tab: every live skill instance/variant, one row each. */
function InstanceList({
  rows,
  selected,
  focused,
  width,
  height,
  marks,
}: {
  rows: Row[];
  selected: number;
  focused: boolean;
  width: number;
  height: number;
  marks?: Set<string>;
}): ReactNode {
  const start = windowStart(rows.length, selected, height);
  return h(
    ListColumn,
    {title: 'Skills', focused, width},
    ...rows.slice(start, start + height).map((row, index) =>
      h(
        RowLine,
        {
          key: row.id,
          active: start + index === selected,
          focused,
          marked: marks?.has(row.id),
          wrap: 'wrap',
        },
        row.displayName,
        updateText(row)
          ? h(Text, {color: updateColor(row)}, ` · ${updateText(row)}`)
          : null,
      ),
    ),
    rows.length === 0
      ? h(Text, {dimColor: true}, '  no skills on disk')
      : null,
  );
}

/** Skill tab: every target in registry order with its state for the selected instance. */
function TargetStatusList({
  targets,
  row,
  selected,
  focused,
  width,
  height,
}: {
  targets: TuiSnapshot['targets'];
  row?: Row;
  selected: number;
  focused: boolean;
  width: number;
  height: number;
}): ReactNode {
  const start = windowStart(targets.length, selected, height);
  return h(
    ListColumn,
    {title: 'Targets', focused, width},
    ...targets.slice(start, start + height).map((target, index) => {
      const info = row?.targets[target.name];
      return h(
        RowLine,
        {key: target.name, active: start + index === selected, focused},
        `${target.name}  `,
        info
          ? h(Text, {color: statusColor(info)}, statusText(info))
          : h(Text, {dimColor: true}, 'missing'),
      );
    }),
  );
}

interface Membership {
  bundles: string[];
  tags: string[];
  presets: string[];
}

function TargetInfoPanel({
  target,
  harness,
  width,
}: {
  target: Target;
  harness?: TuiSnapshot['harnesses']['detected'][number];
  width: number;
}): ReactNode {
  const rows: ReactNode[] = [
    h(Text, {key: 'target-name', bold: true, wrap: 'wrap'}, ` ${target.name}`),
    h(Text, {key: 'target-gap'}, ''),
    h(Text, {key: 'type'}, ' ', h(Text, {bold: true}, 'Type:'), ' Skill Target'),
    h(Text, {key: 'path', wrap: 'wrap'}, ' ', h(Text, {bold: true}, 'Path:'), ` ${target.dir}`),
  ];
  if (harness) {
    rows.push(
      h(Text, {key: 'harness-gap'}, ''),
      h(Text, {key: 'harness'}, ' ', h(Text, {bold: true, color: 'cyan'}, 'Harness:'), ` ${harness.name}`),
      h(Text, {key: 'detected'}, ' ', h(Text, {bold: true}, 'Detected:'), ` ${harness.detected ? 'yes' : 'no'}`),
      h(Text, {key: 'support'}, ' ', h(Text, {bold: true}, 'Adapter support:'), ` ${harness.support}`),
      h(Text, {key: 'shared'}, ' ', h(Text, {bold: true}, 'Shared consumption:'), ` ${harness.sharedConsumption.status}`),
      h(Text, {key: 'isolation'}, ' ', h(Text, {bold: true}, 'Isolation:'), ` ${harness.isolation.status}`),
      ...(harness.support === 'managed'
        ? [h(Text, {key: 'support-explanation', wrap: 'wrap'}, ` ${MANAGED_SUPPORT_EXPLANATION}`)]
        : []),
      h(Text, {key: 'link'}, ' ', h(Text, {bold: true}, 'Link:'), ` ${harness.link.supported ? 'supported' : 'unsupported'}`),
      ...(harness.mirror
        ? [h(Text, {key: 'mirror'}, ' ', h(Text, {bold: true}, 'Mirror:'), ` ${harness.mirror.supported ? 'supported' : 'unsupported'}`)]
        : []),
    );
  }
  return h(ListColumn, {title: 'Info', focused: false, width}, ...rows);
}

function InfoPanel({
  row,
  info,
  membership,
  visibility,
  width,
}: {
  row?: Row;
  info?: SkillInfo;
  membership?: Membership;
  visibility?: VisibilityExplanation;
  width: number;
}): ReactNode {
  const inner = Math.max(8, width - 2); // column borders
  /** OSC 8 terminal hyperlink: every wrapped line maps to the full URL, so
   *  cmd+click never opens a truncated first-line fragment. */
  const osc8 = (href: string, text: string): string =>
    `\x1b]8;;${href}\x07${text}\x1b]8;;\x07`;
  /** Pre-wrap a `Label: value` row; continuation lines align with the label, and
   *  unbroken strings (paths) hard-wrap inside the panel instead of overflowing it. */
  const labeled = (label: string, value: string | undefined, color?: string, href?: string): ReactNode[] => {
    const text = `${label}: ${value && value.length > 0 ? value : '—'}`;
    const lines = wrapAnsi(text, Math.max(4, inner - 1), {
      wordWrap: true,
      trim: true,
      hard: true,
    }).split('\n');
    const linkify = (part: string): string => href ? osc8(href, part) : part;
    return lines.map((part, index) => {
      if (index === 0 && part.startsWith(`${label}:`)) {
        return h(
          Text,
          {key: label},
          ' ',
          h(Text, {bold: true, color}, `${label}:`),
          linkify(part.slice(label.length + 1)),
        );
      }
      return h(Text, {key: `${label}-${index}`}, ` ${linkify(part)}`);
    });
  };
  return h(
    ListColumn,
    {title: 'Info', focused: false, width},
    row
      ? [
          h(Text, {key: 'name', bold: true, wrap: 'wrap'}, ` ${row.displayName}`),
          h(Text, {key: 'gap-top'}, ''),
          ...labeled('Description', row.description),
          ...labeled(
            'Source',
            row.provenance.sourceUrl
              ? row.sourceLabel.replace(/^(?:git\+)?https?:\/\//, '')
              : row.sourceLabel,
            undefined,
            row.provenance.sourceUrl,
          ),
          ...labeled(
            'Path',
            row.realPath ?? (info ? `${info.path}${info.target ? ` -> ${info.target}` : ''}` : undefined),
          ),
          h(Text, {key: 'gap-cat'}, ''),
          ...labeled('Bundles', membership?.bundles.join(', '), 'cyan'),
          ...labeled('Tags', membership?.tags.join(', '), 'green'),
          ...labeled('Presets', membership?.presets.join(', '), 'magenta'),
          h(Text, {key: 'gap-update'}, ''),
          ...labeled('Update availability', row.updateAvailability?.status, updateColor(row)),
          ...labeled('Checked at', row.updateAvailability?.checkedAt),
          ...(row.updateAvailability?.error
            ? labeled('Update error', row.updateAvailability.error, 'red')
            : []),
          h(Text, {key: 'gap-visibility'}, ''),
          h(Text, {key: 'visibility', bold: true, color: 'cyan'}, ' Effective Visibility'),
          ...(visibility?.harnesses.map((harness) =>
            h(
              Text,
              {key: `visibility-${harness.key}`, wrap: 'wrap'},
              ` ${harness.name}: ${harness.effectiveVisibility}${harness.detected ? '' : ' · not-detected'}`,
            )) ?? []),
        ]
      : h(Text, {dimColor: true}, '  nothing selected'),
  );
}

function BatchActivationModal({confirm}: {confirm: BatchConfirm}): ReactNode {
  const lines = confirm.plans.flatMap((plan) =>
    plan.targets.map((target) =>
      `  ${target.targetId}/${target.slot}  ${target.from} -> ${target.to}`));
  return h(
    Box,
    {flexGrow: 1, flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, justifyContent: 'center'},
    h(Text, {bold: true}, `Batch ${confirm.intent} @ ${confirm.targetName}?`),
    ...confirm.errors.map((error, index) => h(Text, {key: `err-${index}`, color: 'red'}, `  ${error}`)),
    ...lines.slice(0, 12).map((line, index) => h(Text, {key: `line-${index}`}, line)),
    lines.length > 12 ? h(Text, {dimColor: true}, `  … ${lines.length - 12} more`) : null,
    h(Text, {color: 'yellow'}, ' y confirm  n/esc cancel '),
  );
}

function updateModalLines(modal: UpdateModalState): string[] {
  const checked = modal.items.filter(({status}) => status !== 'unknown').length;
  const current = modal.items.filter(({status}) => status === 'current').length;
  const available = modal.items.filter(({status}) => status === 'available').length;
  const updated = modal.items.filter(({outcome}) => outcome === 'updated').length;
  const skipped = modal.kind === 'refresh'
    ? modal.items.filter(({status}) => status === 'upstream-missing').length
    : modal.items.filter(({outcome}) => outcome === 'skipped').length;
  const failed = modal.kind === 'refresh'
    ? modal.items.filter(({status}) => status === 'check-failed').length
    : modal.items.filter(({outcome}) => outcome === 'failed').length;
  const lines = [
    `checked ${checked}  current ${current}  available ${available}  updated ${updated}  skipped ${skipped}  failed ${failed}`,
    '',
  ];
  const groups = new Map<string, UpdateItem[]>();
  for (const item of modal.items)
    groups.set(item.source, [...(groups.get(item.source) ?? []), item]);
  for (const [source, items] of groups) {
    lines.push(source);
    for (const item of items) {
      const result = item.outcome === 'skipped'
        ? `skipped (${item.status})`
        : item.outcome ?? item.status;
      lines.push(
        `  ${item.name}: ${result}` +
        (item.checkedAt ? `  checkedAt=${item.checkedAt}` : '') +
        (item.error ? `  ${item.error}` : ''),
      );
    }
    lines.push('');
  }
  return lines;
}

function UpdateModal({
  modal,
  height,
}: {
  modal: UpdateModalState;
  height: number;
}): ReactNode {
  const lines = updateModalLines(modal);
  const available = modal.items.filter(({status, outcome}) =>
    status === 'available' && outcome !== 'skipped').length;
  const title = modal.kind === 'refresh'
    ? 'Refresh results'
    : modal.kind === 'confirm'
      ? `Update ${available} Skill${available === 1 ? '' : 's'}?`
      : 'Update results';
  const viewHeight = Math.max(1, height - 8);
  return h(
    Box,
    {
      flexGrow: 1,
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: modal.kind === 'confirm' ? 'yellow' : 'cyan',
      paddingX: 1,
      overflow: 'hidden',
    },
    h(Text, {bold: true}, title),
    ...lines.slice(modal.scroll, modal.scroll + viewHeight).map((line, index) =>
      h(Text, {key: modal.scroll + index, wrap: 'truncate-end'}, line || ' ')),
    modal.kind === 'confirm'
      ? h(Text, {color: 'yellow'}, ' y confirm  n/esc cancel ')
      : null,
  );
}

function knownTagNames(tags: Record<string, string[]>): string[] {
  return [...new Set(Object.values(tags).flat())].sort((a, b) => a.localeCompare(b));
}

function ManageModal({
  row,
  catalog,
  bundles,
  manage,
}: {
  row: Row;
  catalog: TuiSnapshot['catalog'];
  bundles: string[];
  manage: ManageState;
}): ReactNode {
  const assigned = new Set(catalog.tags[row.id] ?? []);
  const tagNames = knownTagNames(catalog.tags);
  const selector = `skill:${row.id}`;
  const presetNames = Object.keys(catalog.presets).sort((a, b) => a.localeCompare(b));
  const active = (section: ManageState['section'], index: number) =>
    manage.section === section && manage.index === index;
  const marker = (on: boolean) => (on ? '›' : ' ');
  const sectionTitle = (title: string, on: boolean) =>
    h(Text, {bold: on, color: on ? 'cyan' : undefined}, ` ${title}`);
  return h(
    Box,
    {flexGrow: 1, flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1},
    h(Text, {bold: true, wrap: 'truncate-end'}, ` Manage: ${row.displayName}`),
    h(Text, {dimColor: true, wrap: 'truncate-end'},
      ` Bundles: ${bundles.length > 0 ? bundles.join(', ') : '—'}`),
    h(Text, null, ''),
    sectionTitle('Tags', manage.section === 'tags'),
    ...tagNames.map((tag, index) =>
      h(Text, {key: `tag-${tag}`, inverse: active('tags', index)},
        `${marker(active('tags', index))} [${assigned.has(tag) ? 'x' : ' '}] ${tag}`)),
    h(Text, {key: 'tag-add', inverse: active('tags', tagNames.length)},
      `${marker(active('tags', tagNames.length))} + add tag`),
    h(Text, null, ''),
    sectionTitle('Presets', manage.section === 'presets'),
    ...presetNames.map((name, index) => {
      const member = (catalog.presets[name]?.selectors ?? []).includes(selector);
      return h(Text, {key: `preset-${name}`, inverse: active('presets', index)},
        `${marker(active('presets', index))} [${member ? 'x' : ' '}] ${name}`);
    }),
    h(Text, {key: 'preset-add', inverse: active('presets', presetNames.length)},
      `${marker(active('presets', presetNames.length))} + new preset`),
    manage.input
      ? h(Text, null,
          ` ${manage.input.kind === 'tag' ? 'tag' : 'preset'} name: ${manage.input.value}`)
      : null,
  );
}

function ConfirmationModal({
  confirmation,
}: {
  confirmation: Confirmation;
}): ReactNode {
  return h(
    Box,
    {
      flexGrow: 1,
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'yellow',
      paddingX: 1,
      justifyContent: 'center',
    },
    h(Text, {bold: true}, `${confirmation.kind === 'link' ? 'Link' : confirmation.kind === 'unlink' ? 'Unlink' : confirmation.kind.replace('mirror-', 'Mirror ')} relationship?`),
    h(Text, {wrap: 'wrap'}, ` ${confirmation.source} → ${confirmation.destination}`),
    h(Text, {color: 'yellow'}, ' y confirm  n/esc cancel '),
  );
}

function detailLines(content: string, width: number): string[] {
  return wrapAnsi(content, width, {hard: true, trim: false, wordWrap: false}).split('\n');
}

function DetailModal({
  row,
  lines,
  scroll,
  height,
}: {
  row: Row;
  lines: string[];
  scroll: number;
  height: number;
}): ReactNode {
  // header + footer + modal chrome/title leave this many content rows
  const viewHeight = Math.max(1, height - 8);
  const visible = lines.slice(scroll, scroll + viewHeight);
  return h(
    Box,
    {
      flexGrow: 1,
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'cyan',
      paddingX: 1,
      overflow: 'hidden',
    },
    h(
      Text,
      {bold: true, wrap: 'truncate-end'},
      `SKILL.md — ${row.displayName}  [${Math.min(scroll + 1, lines.length)}/${lines.length}]`,
    ),
    ...visible.map((line, index) =>
      h(Text, {key: scroll + index, wrap: 'truncate-end'}, line || ' '),
    ),
  );
}

function sourceRelationships(row: Row | undefined): SkillRelationship[] {
  return (row?.observedRelationships ?? row?.relationships ?? [])
    .filter(({target}) => target === 'shared');
}

function sourceDesiredTruth(
  home: Home,
  row: Row | undefined,
  scope: SourceScope,
  projectPath: string,
): {desired: string; drift: string} {
  if (!row) return {desired: 'not applicable', drift: 'not applicable'};
  const relationships = sourceRelationships(row);
  let state: Record<string, unknown> = {};
  try {
    const file = scope === 'global'
      ? path.join(home.configDir, 'state.json')
      : path.join(projectPath, '.skillspub', 'state.json');
    if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {desired: 'unknown', drift: 'unknown'};
  }
  const baseIntent = state.baseIntent && typeof state.baseIntent === 'object' && !Array.isArray(state.baseIntent)
    ? state.baseIntent as Record<string, unknown>
    : {};
  const claims = state.claims && typeof state.claims === 'object' && !Array.isArray(state.claims)
    ? state.claims as Record<string, unknown>
    : {};
  let observedDrift = false;
  const desired = relationships.map((relationship) => {
    const actual = relationship.info.underOff ? 'OFF' : 'ON';
    if (relationship.info.presence === 'deadlink' || relationship.info.diverged)
      observedDrift = true;
    if (relationship.readOnly) return `read-only ${actual}`;
    const slotId = `${relationship.targetId}\0${relationship.slot}`;
    const activation = Array.isArray(claims[slotId]) && claims[slotId].length > 0
      ? 'ON'
      : baseIntent[slotId] === 'off'
        ? 'OFF'
        : baseIntent[slotId] === 'on'
          ? 'ON'
          : actual;
    if (activation !== actual) observedDrift = true;
    return activation;
  });
  return {
    desired: [...new Set(desired)].join('/') || 'unknown',
    drift: observedDrift ? 'observed' : 'none observed',
  };
}

function sourceInventoryRows(snapshot: TuiSnapshot): Row[] {
  return snapshot.rows.filter((row) => sourceRelationships(row).length > 0);
}

function verifiedSourceTruth(
  home: Home,
  snapshot: TuiSnapshot,
  plan: SharedMutationPlan | SharedRemovalPlan,
  scope: SourceScope,
  projectPath: string,
): SourceVerifiedTruth {
  const slot = plan.operation === 'shared.remove'
    ? plan.source.slot
    : plan.candidate?.normalizedSlot ?? plan.slots[0] ?? 'unknown';
  const row = sourceInventoryRows(snapshot).find((candidate) =>
    sourceRelationships(candidate).some((relationship) =>
      relationship.targetId === plan.targetId && relationship.slot === slot));
  const relationships = row?.observedRelationships ?? row?.relationships ?? [];
  const removalLockRemains = plan.operation === 'shared.remove' &&
    readNpxSkillsLock(plan.target.lockFile).some(({slot: lockSlot}) => lockSlot === slot);
  const removalDependenciesRemain = plan.operation === 'shared.remove'
    ? plan.dependencies.filter(({path: dependencyPath}) => fs.lstatSync(dependencyPath, {throwIfNoEntry: false}))
    : [];
  const removalSourceRemains = plan.operation === 'shared.remove' && Boolean(row);
  const desiredTruth = plan.operation === 'shared.remove'
    ? {
        desired: 'removed',
        drift: removalSourceRemains || removalLockRemains || removalDependenciesRemain.length > 0
          ? 'observed'
          : 'none',
      }
    : sourceDesiredTruth(home, row, scope, projectPath);
  const visibility = resolveVisibility(
    home,
    row,
    scope === 'project' ? projectPath : undefined,
  );
  const actual = relationships.map(({targetId, slot: relationshipSlot, info}) =>
    `${targetId}/${relationshipSlot}=${info.presence === 'deadlink' ? 'broken' : info.underOff ? 'off' : 'on'}/${info.form}`);
  const effectiveVisibility = [...new Set(
    visibility?.harnesses.map(({effectiveVisibility: state}) => state) ?? ['unknown'],
  )].join('/');
  const driftEvidence = relationships.flatMap(({targetId, slot: relationshipSlot, info}) => {
    if (info.presence === 'deadlink') return [`${targetId}/${relationshipSlot}: broken`];
    if (info.diverged) return [`${targetId}/${relationshipSlot}: diverged mirror`];
    if (info.mirrored && row?.realPath) {
      try {
        if (hashDirectory(info.path) !== hashDirectory(row.realPath))
          return [`${targetId}/${relationshipSlot}: mirror-sync required`];
      } catch {
        return [`${targetId}/${relationshipSlot}: mirror truth unreadable`];
      }
    }
    return [];
  });
  if (plan.operation === 'shared.remove') {
    if (removalSourceRemains) driftEvidence.push('Shared source remains');
    if (removalLockRemains) driftEvidence.push('Vercel skills lock entry remains');
    for (const dependency of removalDependenciesRemain)
      driftEvidence.push(`dependent Relationship remains: ${dependency.targetId}/${dependency.slot}`);
  } else if (desiredTruth.drift === 'observed') driftEvidence.push('Actual differs from Desired');
  const mirrorDrift = driftEvidence.filter((item) => item.includes('mirror')).length;
  const drift = mirrorDrift > 0
    ? `mirror-sync required (${mirrorDrift}); ${driftEvidence.join(', ')}`
    : driftEvidence.join(', ') || 'none observed';
  return {
    resource: row?.realPath ?? 'missing',
    provenance: row?.sourceLabel ?? (plan.operation === 'shared.remove'
      ? plan.source.provenance
      : 'Source unknown'),
    slot,
    relationships: relationships.map(({targetId, slot: relationshipSlot, info}) =>
      `${targetId}/${relationshipSlot} ${info.form}/${info.underOff ? 'off' : 'on'} ${info.path}`),
    actual: actual.join(', ') || `${plan.targetId}/${slot}=missing`,
    desired: desiredTruth.desired,
    drift,
    updateAvailability: row?.updateAvailability?.status ?? 'unknown',
    effectiveVisibility,
  };
}

function sameSourceIntent(original: SharedMutationPlan, fresh: SharedMutationPlan): boolean {
  const originalEffects = (original.relationshipEffects ?? []).map((effect) => ({
    ...effect,
    plannedAction: 'preserve-intent',
  }));
  const freshEffects = (fresh.relationshipEffects ?? []).map((effect) => ({
    ...effect,
    plannedAction: 'preserve-intent',
  }));
  const sourceStillExpected = fresh.replacement
    ? fresh.replacement.from === original.replacement?.from
    : fresh.currentSource === original.source || (!fresh.currentSource && !original.currentSource);
  return fresh.targetId === original.targetId &&
    fresh.candidate?.identity === original.candidate?.identity &&
    JSON.stringify(fresh.slots) === JSON.stringify(original.slots) &&
    JSON.stringify(fresh.scope) === JSON.stringify(original.scope) &&
    JSON.stringify(fresh.intentPreservation) === JSON.stringify(original.intentPreservation) &&
    JSON.stringify(freshEffects) === JSON.stringify(originalEffects) &&
    (fresh.blockers?.length ?? 0) === 0 &&
    sourceStillExpected;
}

function candidateId(candidate: NpxSkillsCandidate): string {
  return `${candidate.source}\0${candidate.name}`;
}

function sourceDetailLines(
  candidate: NpxSkillsCandidate | undefined,
  row: Row | undefined,
): string[] {
  if (candidate) return [
    `Identity: ${candidate.source}@${candidate.name}`,
    `Source: ${candidate.source}`,
    `Skill path/name: ${candidate.name}`,
    `Destination Slot: ${normalizeNpxSkillsName(candidate.name)}`,
    `Installs: ${candidate.installs ?? 'unknown'}`,
    `Detail: ${candidate.detailUrl}`,
  ];
  if (!row) return ['No resource selected.'];
  const relationships = sourceRelationships(row);
  return [
    `Identity: ${row.realPath ?? row.id}`,
    `Name: ${row.name}`,
    `Provenance: ${row.sourceLabel}`,
    `Real path: ${row.realPath ?? 'unresolved'}`,
    `Update availability: ${row.updateAvailability?.status ?? 'unknown'}`,
    ...relationships.map((relationship) =>
      `${relationship.readOnly ? 'Read-only inherited' : relationship.info.form} ${relationship.scope ?? 'global'}: ${relationship.info.path}`),
  ];
}

function SourceDetail({
  title,
  lines,
  bordered = false,
  wrap = 'truncate-end',
}: {
  title: string;
  lines: string[];
  bordered?: boolean;
  wrap?: 'wrap' | 'truncate-end';
}): ReactNode {
  return h(
    Box,
    {
      flexDirection: 'column',
      flexGrow: 1,
      ...(bordered ? {borderStyle: 'round' as const, borderColor: 'cyan', paddingX: 1} : {}),
    },
    h(Text, {bold: true}, title),
    ...lines.map((line, index) => h(Text, {key: index, wrap}, line)),
  );
}

function relationshipEffectLines(effects: NonNullable<SharedMutationPlan['relationshipEffects']>): string[] {
  const lines: string[] = [];
  let group = '';
  for (const effect of effects) {
    const nextGroup = `${effect.scope}\0${effect.targetId}`;
    if (nextGroup !== group) {
      lines.push(`Scope ${effect.scope} · Skill Target ${effect.targetKey} (${effect.targetId})`);
      group = nextGroup;
    }
    lines.push(
      `${effect.plannedAction}: ${effect.form}/${effect.activation} ` +
      `source=${effect.sourcePath} target=${effect.targetPath}`,
    );
  }
  return lines;
}

function sourceOperationHint(operation: SourceOperationState): string {
  switch (operation.phase) {
    case 'preview':
      return (operation.plan.blockers?.length ?? 0) > 0
        ? ' ↑↓/j/k scroll  l log/evidence  blocked — esc cancel '
        : ' ↑↓/j/k scroll  l log/evidence  enter continue  esc cancel ';
    case 'confirm':
      return ' ↑↓/j/k scroll  enter confirm cascade  esc cancel ';
    case 'source-confirm':
      return ' ↑↓/j/k scroll  l log/evidence  enter confirm source deletion  esc keep source ';
    case 'run':
      return ' running — unrelated actions disabled ';
    case 'verify':
      return ' ↑↓/j/k scroll  l log/evidence  enter acknowledge Verify truth ';
    case 'failed':
      return ' ↑↓/j/k scroll  l log/evidence  t retry  esc acknowledge remaining Drift ';
  }
}

function sourceOperationLines(operation: SourceOperationState): {title: string; lines: string[]} {
  const plan = operation.plan;
  const scope = plan.scope?.kind === 'project' ? 'exact Project' : 'Global';
  const timeline = `Timeline: ${operation.steps.map(({name, status}) => `${name} ${status}`).join(' → ')}`;
  let states = 'States: queued · running · failed · skipped';
  if (operation.phase === 'preview' || operation.phase === 'confirm') states = 'States: queued';
  else if (operation.phase === 'run') states = 'States: queued · running';
  else if (operation.phase === 'verify') states = 'States: queued · running · succeeded';
  if (plan.operation === 'shared.remove') {
    const dependencies = plan.dependencies;
    if (operation.phase === 'preview') return {
      title: 'Source Remove plan',
      lines: [
        `Scope: ${scope} — ${plan.scope.path}`,
        `Source: ${plan.source.provenance} name=${plan.source.name}`,
        `Shared Slot: ${plan.source.slot}`,
        `Source path: ${plan.source.path}`,
        `Source fingerprint: ${plan.source.fingerprint}`,
        `Source Adapter: ${plan.sourceAdapter.package}`,
        `Permissions: source=${plan.preconditions.permissions.source} state=${plan.preconditions.permissions.state} lock=${plan.preconditions.permissions.lock}`,
        ...plan.preconditions.permissions.dependencies.map(({path: dependencyPath, status}) =>
          `Dependency permission: ${status} ${dependencyPath}`),
        ...plan.selection.included.map(({identity, reason}) => `Included: ${identity} — ${reason}`),
        ...plan.selection.excluded.map(({identity, reason}) => `Excluded: ${identity} — ${reason}`),
        `Relationship effects: ${dependencies.length}`,
        ...dependencies.map((dependency) =>
          `${dependency.targetKey} (${dependency.targetId}) ${dependency.form}/${dependency.activation} ` +
          `source=${dependency.source} target=${dependency.path} action=${dependency.plannedAction} ` +
          `fingerprint=${dependency.fingerprint}`),
        `Blockers: ${plan.blockers.join('; ') || 'none'}`,
        ...plan.warnings.map((warning) => `Warning: ${warning}`),
        `Recovery: manifest=${plan.recovery.manifest}; ${plan.recovery.evidence.join(', ')}`,
        `Current Actual: ${plan.currentTruth.actual}; Desired=${plan.currentTruth.desired}; Drift=${plan.currentTruth.drift}`,
        `Expected final truth: ${plan.expectedFinalTruth.actual}; Desired=${plan.expectedFinalTruth.desired}; Drift=${plan.expectedFinalTruth.drift}`,
        states,
        timeline,
      ],
    };
    if (operation.phase === 'confirm') return {
      title: 'Source removal — cascade confirmation',
      lines: [
        'Confirm complete Relationship cascade.',
        `Source remains: ${plan.source.path}`,
        `Dependencies to delete: ${dependencies.length}`,
        ...dependencies.map(({targetId, slot, form, activation, path: dependencyPath}) =>
          `${targetId}/${slot} ${form}/${activation} ${dependencyPath}`),
        'Vercel skills source deletion will require a separate confirmation.',
        states,
        timeline,
      ],
    };
    if (operation.phase === 'source-confirm') return {
      title: 'Source removal — source confirmation',
      lines: [
        'Relationship cascade succeeded.',
        `Completed work: ${operation.result?.completedWork?.join(', ') || 'no dependent Relationships'}`,
        `Recovery manifest: ${operation.result?.recoveryManifest ?? plan.recovery.manifest}`,
        `Confirm Vercel skills source deletion: ${plan.source.name}`,
        `Only this proven managed name will be passed; remove --all is forbidden.`,
        states,
        timeline,
      ],
    };
    if (operation.phase === 'run') return {
      title: 'Source removal — running',
      lines: [states, timeline, `Stage: ${operation.runStep}`, `Recovery manifest: ${plan.recovery.manifest}`],
    };
    const succeeded = operation.phase === 'verify';
    const truth = operation.truth;
    return {
      title: succeeded ? 'Source operation — Verify truth' : 'Source operation — failed',
      lines: [
        states,
        timeline,
        ...operation.steps.map(({name, status}) => `Step: ${name} ${status}`),
        ...(succeeded ? [] : [`Error: ${operation.error}`, `Raw log: ${operation.log ?? operation.error}`]),
        `Resource: ${truth?.resource ?? 'missing'}`,
        `Provenance: ${truth?.provenance ?? plan.source.provenance}`,
        `Actual: ${truth?.actual ?? operation.result?.actual ?? 'rescan unavailable'}`,
        `Desired: ${truth?.desired ?? 'removed'}`,
        `Drift: ${truth?.drift ?? (operation.result?.drift.join(', ') || 'see error')}`,
        `Relationship effects: ${dependencies.length} planned; completed=${operation.result?.completedWork?.join(', ') || 'unknown'}`,
        `Update availability: ${truth?.updateAvailability ?? 'unknown'}`,
        `next-load Effective Visibility: ${truth?.effectiveVisibility ?? 'unknown'}; running Harness not reloaded`,
        `Artifacts: lock=${plan.target.lockFile}; manifest=${plan.recovery.manifest}`,
        succeeded ? 'Enter acknowledge Verify truth' : 't retry · Esc acknowledge remaining Drift',
      ],
    };
  }
  const candidate = operation.candidate!;
  const effects = plan.relationshipEffects ?? [];
  if (operation.phase === 'preview') return {
    title: `Source ${plan.replacement ? 'Replace' : 'Add'} plan`,
    lines: [
      `Scope: ${scope} — ${plan.scope?.path}`,
      `Candidate: ${candidate.source}@${candidate.name}`,
      `Provenance: ${candidate.source}`,
      `Shared Slot: ${plan.candidate?.normalizedSlot}`,
      `Source Adapter: ${plan.sourceAdapter?.package}`,
      `Ownership: SkillsPub scope/identity/Slot/Relationships; Vercel skills security audit + Proceed`,
      ...(plan.replacement ? [`Replace: ${plan.replacement.from} → ${plan.replacement.to}`] : []),
      `Current Actual: ${plan.currentTruth?.actual}; Desired=${plan.currentTruth?.desired}; Drift=${plan.currentTruth?.drift}`,
      `Relationship effects: ${effects.map(({plannedAction}) => plannedAction).join(', ')}`,
      ...relationshipEffectLines(effects),
      `Hashes: source=${plan.preconditions?.sourceEntry.hash} lock=${plan.preconditions?.lock.hash} policy=${plan.preconditions?.policy.hash}`,
      `Permissions: target=${plan.preconditions?.permissions.target} lock=${plan.preconditions?.permissions.lock}`,
      `Lock ownership: ${plan.preconditions?.lock.owner}`,
      `Blockers: ${plan.blockers?.join('; ') || 'none'}`,
      `Preserve Slot intent: ${plan.intentPreservation?.baseIntent}`,
      `Tags: ${plan.intentPreservation?.tags.join(', ') || 'none'}`,
      `Bundles: ${plan.intentPreservation?.bundles.join(', ') || 'none'}`,
      `Preset claims: ${plan.intentPreservation?.presetClaims.join(', ') || 'none'}`,
      `Preset selectors: ${plan.intentPreservation?.presetSelectors.join(', ') || 'none'}`,
      `Recovery: ${plan.recovery?.evidence.join(', ')}`,
      `Expected final truth: ${plan.expectedFinalTruth?.actual}; Desired=${plan.expectedFinalTruth?.desired}; Drift=${plan.expectedFinalTruth?.drift}`,
      states,
      timeline,
    ],
  };
  if (operation.phase === 'confirm') return {
    title: 'Source operation — confirmation',
    lines: [
      'Confirm SkillsPub intent.',
      'Scope · identity · Slot · Relationships',
      `Candidate: ${candidate.source}@${candidate.name}`,
      `Scope: ${scope} — ${plan.scope?.path}`,
      `Slot: ${plan.candidate?.normalizedSlot}`,
      `Relationships: ${effects.length}; no Harness-specific Link or Mirror will be created`,
      'Vercel skills owns security audit and final Proceed.',
      states,
      timeline,
      'Enter confirm · Esc cancel',
    ],
  };
  if (operation.phase === 'run') return {
    title: 'Source operation — running',
    lines: [
      states,
      timeline,
      'Upstream ownership handoff: Vercel skills security audit and Proceed',
      `Artifact: ${plan.target?.lockFile}`,
      'Final filesystem rescan queued',
    ],
  };
  const succeeded = operation.phase === 'verify';
  const truth = operation.truth;
  return {
    title: succeeded ? 'Source operation — Verify truth' : 'Source operation — failed',
    lines: [
      states,
      timeline,
      ...(succeeded ? [] : [
        ...(/new preview required/i.test(operation.error ?? '') ? ['New preview required.'] : []),
        `Error: ${operation.error}`,
        `Raw log: ${operation.log ?? operation.error}`,
      ]),
      `Resource: ${truth?.resource ?? 'missing'}`,
      `Provenance: ${truth?.provenance ?? 'Source unknown'}`,
      `Slot: ${truth?.slot ?? plan.candidate?.normalizedSlot}`,
      `Relationships: ${truth?.relationships.length ?? 0}`,
      ...(truth?.relationships ?? []).map((relationship) => `Relationship truth: ${relationship}`),
      `Actual: ${truth?.actual ?? operation.result?.actual ?? 'rescan unavailable'}`,
      `Desired: ${truth?.desired ?? 'unknown'}`,
      `Drift: ${truth?.drift ?? (operation.result?.drift.join(', ') || (succeeded ? 'none' : 'see error'))}`,
      `Update availability: ${truth?.updateAvailability ?? 'unknown'}`,
      `next-load Effective Visibility: ${truth?.effectiveVisibility ?? 'unknown'}; running Harness not reloaded`,
      `Artifacts: lock=${plan.target?.lockFile}; recovery=${plan.recovery?.evidence.join(', ')}`,
      succeeded ? 'Enter acknowledge Verify truth' : 't retry · Esc acknowledge remaining Drift · a new preview required if intent changed',
    ],
  };
}

function SourceWorkspace({
  scope,
  scopePath,
  surface,
  candidates,
  candidateIndex,
  inventory,
  inventoryIndex,
  marks,
  visibility,
  desired,
  drift,
  operation,
  width,
  height,
}: {
  scope: SourceScope;
  scopePath: string;
  surface: SourceSurface;
  candidates: NpxSkillsCandidate[];
  candidateIndex: number;
  inventory: Row[];
  inventoryIndex: number;
  marks: Set<string>;
  visibility?: VisibilityExplanation;
  desired: string;
  drift: string;
  operation?: SourceOperationState;
  width: number;
  height: number;
}): ReactNode {
  const candidate = surface === 'catalog' ? candidates[candidateIndex] : undefined;
  const row = surface === 'inventory' ? inventory[inventoryIndex] : undefined;
  const relationships = sourceRelationships(row);
  const idleDetail = sourceDetailLines(surface === 'catalog' ? candidate : undefined, surface === 'inventory' ? row : undefined);
  const activeDetail = operation ? sourceOperationLines(operation) : undefined;
  const operationPage = Math.max(3, height - 8);
  const operationScroll = operation?.scroll ?? 0;
  const detail = activeDetail
    ? activeDetail.lines.slice(operationScroll, operationScroll + operationPage)
    : idleDetail;
  const detailTitle = activeDetail
    ? `${activeDetail.title} [${Math.min(operationScroll + 1, activeDetail.lines.length)}/${activeDetail.lines.length}]`
    : surface === 'catalog' ? 'Selected candidate' : 'Selected resource';
  const idleActual = row
    ? relationships.map(({info}) =>
        `${info.presence === 'deadlink' ? 'BROKEN' : info.underOff ? 'OFF' : 'ON'} ${info.form}`).join(', ')
    : candidate ? 'not installed' : 'none selected';
  const idleEffective = row
    ? [...new Set(visibility?.harnesses.map(({effectiveVisibility}) => effectiveVisibility) ?? ['unknown'])].join('/')
    : 'not applicable';
  const actual = operation?.truth?.actual ?? operation?.plan.currentTruth?.actual ?? idleActual;
  const displayedDesired = operation?.truth?.desired ?? operation?.plan.currentTruth?.desired ?? desired;
  const displayedDrift = operation?.truth?.drift ?? operation?.plan.currentTruth?.drift ?? drift;
  const displayedUpdate = operation?.truth?.updateAvailability ?? row?.updateAvailability?.status ?? 'unknown';
  const effective = operation?.truth?.effectiveVisibility ?? idleEffective;
  const displayedRelationships = operation?.truth?.relationships.length ?? relationships.length;
  const selectedIndex = surface === 'catalog' ? candidateIndex : inventoryIndex;
  const list = surface === 'catalog'
    ? candidates.map((item, index) => h(RowLine, {
        key: candidateId(item),
        active: index === candidateIndex,
        focused: true,
      }, `${item.source}@${item.name}${item.installs ? `  ${item.installs}` : ''}`))
    : inventory.map((item, index) => {
        const rel = sourceRelationships(item)[0];
        const inherited = rel?.readOnly ? `  [inherited ${rel.scope}: ${path.dirname(rel.info.path)}]` : '';
        return h(RowLine, {
          key: item.id,
          active: index === inventoryIndex,
          focused: true,
          marked: marks.has(item.id),
        }, `${item.displayName}  ${item.sourceLabel}${inherited}`);
      });
  return h(
    Box,
    {height, flexDirection: 'column'},
    h(Text, {wrap: 'wrap'}, `Scope: ${scope === 'global' ? 'Global' : 'exact Project'}  Path: ${scopePath}`),
    h(Text, {color: 'cyan', wrap: 'wrap'}, 'Discover → Inspect & plan → Confirm ownership → Run & maintain → Verify truth'),
    h(
      Box,
      {flexGrow: 1, overflow: 'hidden'},
      h(ListColumn, {title: surface === 'catalog' ? 'Catalog' : 'Inventory', focused: true, flexGrow: 1},
        ...(list.length > 0
          ? list.slice(
              windowStart(list.length, selectedIndex, Math.max(1, height - 8)),
              windowStart(list.length, selectedIndex, Math.max(1, height - 8)) + Math.max(1, height - 8),
            )
          : [h(Text, {key: 'empty', dimColor: true}, surface === 'catalog' ? ' / search the pinned Source' : ' No Shared resources')]),
      ),
      width >= WIDE_MIN
        ? h(Box, {width: Math.max(34, Math.floor(width * 0.42)), paddingX: 1},
            h(SourceDetail, {title: detailTitle, lines: detail}))
        : null,
    ),
    width < WIDE_MIN
      ? h(SourceDetail, {
          title: detailTitle,
          lines: detail,
        })
      : null,
    h(Text, {wrap: 'wrap'}, `Selected: ${idleDetail[0] ?? 'none'}  Actual: ${actual}  Desired: ${displayedDesired}`),
    h(Text, {wrap: 'wrap'}, `Drift: ${displayedDrift}  Update: ${displayedUpdate}  Relationship: ${displayedRelationships}  Effective Visibility: ${effective}`),
  );
}

function resolveVisibility(
  home: Home,
  row: Row | undefined,
  projectPath?: string,
  harness?: string,
  want?: WantedVisibility,
): VisibilityExplanation | undefined {
  if (!row?.realPath) return undefined;
  try {
    return explainVisibility(home, `skill:${row.id}`, {projectPath, harness, want});
  } catch {
    return undefined;
  }
}

function explanationLines(explanation: VisibilityExplanation | undefined): string[] {
  const harness = explanation?.harnesses[0];
  if (!harness) return ['Explain unavailable; refresh Inventory and try again.'];
  const lines = [
    `Result: ${harness.effectiveVisibility}${harness.detected ? '' : ' · not-detected'}`,
    `Detected: ${harness.detected ? 'yes' : 'no'}`,
    `Adapter support: ${harness.support}`,
    `Shared consumption: ${harness.sharedConsumption.status} — ${harness.sharedConsumption.detail}`,
    `Isolation: ${harness.isolation.status} — ${harness.isolation.detail}`,
    '',
    'Evidence:',
    ...harness.evidence.map((evidence) =>
      `  ${evidence.verifiedVersion} — ${evidence.detail} — ${evidence.url}`),
    ...harness.reasons.map((reason) => `reason: ${reason.message}`),
    ...harness.warnings.map((warning) => `warning: ${warning.message}`),
    ...harness.conflicts.map((conflict) => `conflict: ${conflict.message}`),
  ];
  if (harness.plan) {
    lines.push(
      '',
      `Wanted: ${explanation.wanted}`,
      `Executable: ${harness.plan.executable ? 'yes' : 'no'}`,
      ...harness.plan.steps.flatMap((step) => [
        `step: ${step.operation} ${step.targetId}/${step.slot} (${step.from} -> ${step.to}${step.form ? `, ${step.form}` : ''})`,
        ...step.preconditions.map((condition) => `  precondition: ${condition.message}`),
      ]),
      ...harness.plan.blockers.map((blocker) => `blocker: ${blocker.message}`),
    );
  }
  lines.push('', 'Roots:');
  for (const root of harness.roots) {
    lines.push(
      `${root.consumption} ${root.scope}/${root.kind}: ${root.path}`,
      `  reason: ${root.reason}`,
      ...root.relationships.map((relationship) =>
        `  ${relationship.activation} ${relationship.form}${relationship.selected ? ' selected' : ''}: ${relationship.path}`),
    );
  }
  return lines;
}

function ExplainModal({
  row,
  harnessName,
  harnessIndex,
  harnessCount,
  lines,
  scroll,
  height,
}: {
  row: Row;
  harnessName: string;
  harnessIndex: number;
  harnessCount: number;
  lines: string[];
  scroll: number;
  height: number;
}): ReactNode {
  const viewHeight = Math.max(1, height - 8);
  return h(
    Box,
    {
      flexGrow: 1,
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'cyan',
      paddingX: 1,
      overflow: 'hidden',
    },
    h(
      Text,
      {bold: true, wrap: 'truncate-end'},
      `Explain — ${row.name} — ${harnessName} [${harnessIndex + 1}/${harnessCount}]`,
    ),
    ...lines.slice(scroll, scroll + viewHeight).map((line, index) =>
      h(Text, {key: scroll + index, wrap: 'truncate-end'}, line || ' '),
    ),
  );
}

export function App({home, projectPath}: {home: Home; projectPath?: string}): ReactNode {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const readSize = () => ({
    width: stdout.columns ?? 100,
    height: stdout.rows ?? 30,
  });
  const [size, setSize] = useState(readSize);
  useEffect(() => {
    const resize = () => setSize(readSize());
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout]);
  const {width, height} = size;

  const takeSnapshot = () =>
    projectPath ? projectTuiSnapshot(home, projectPath) : tuiSnapshot(home);
  const [snapshot, setSnapshot] = useState<TuiSnapshot>(takeSnapshot);
  const exactProjectPath = projectPath ?? process.cwd();
  const initialSourceScope: SourceScope = projectPath ? 'project' : 'global';
  const sourceTakeSnapshot = (scope: SourceScope) =>
    scope === 'project' ? projectTuiSnapshot(home, exactProjectPath) : tuiSnapshot(home);
  const [sourceScope, setSourceScope] = useState<SourceScope>(initialSourceScope);
  const [sourceSnapshot, setSourceSnapshot] = useState<TuiSnapshot>(snapshot);
  const [sourceSurface, setSourceSurface] = useState<SourceSurface>('catalog');
  const [sourceCandidates, setSourceCandidates] = useState<NpxSkillsCandidate[]>([]);
  const [sourceCandidateId, setSourceCandidateId] = useState<string>();
  const [sourceResourceId, setSourceResourceId] = useState<string>();
  const [sourceMarks, setSourceMarks] = useState<Set<string>>(new Set());
  const [sourceDetailOpen, setSourceDetailOpen] = useState(false);
  const [sourceLogOpen, setSourceLogOpen] = useState(false);
  const [sourceOperation, setSourceOperation] = useState<SourceOperationState>();
  const planScope: PresetScope = projectPath ? { projectPath } : {};
  const prepareMutation = () => {
    if (projectPath) scanProjectInventory(home, projectPath);
    else scanGlobalInventory(home);
  };
  const [tab, setTab] = useState<Tab>('target');
  const [focusColumn, setFocusColumn] = useState<0 | 1>(0);
  const [targetIndex, setTargetIndex] = useState(0);
  const [relationshipKey, setRelationshipKey] = useState<string>();
  // Skill-tab selection is tracked by instance id so tab switches keep identity.
  const [instanceId, setInstanceId] = useState<string>();
  const [instanceTargetIndex, setInstanceTargetIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<SortOrder>('name');
  const [modal, setModal] = useState<{row: Row; scroll: number} | null>(null);
  const [explainModal, setExplainModal] = useState<ExplainModalState | null>(null);
  const [targetInfoOpen, setTargetInfoOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [manage, setManage] = useState<ManageState | null>(null);
  const [batch, setBatch] = useState<{ marks: Set<string> } | null>(null);
  const [batchConfirm, setBatchConfirm] = useState<BatchConfirm | null>(null);
  const [updateModal, setUpdateModal] = useState<UpdateModalState | null>(null);
  const [batchTag, setBatchTag] = useState<{ action: 'add' | 'rm'; value: string } | null>(null);
  const [feedback, setFeedback] = useState('');

  const targets = snapshot.targets;
  const target = targets[Math.min(targetIndex, Math.max(0, targets.length - 1))];
  const targetHarness = target
    ? [...snapshot.harnesses.detected, ...snapshot.harnesses.available]
        .find((harness) => harness.key === target.name)
    : undefined;
  const instTarget = Math.min(instanceTargetIndex, Math.max(0, targets.length - 1));
  const instanceTarget = targets[instTarget];
  const rows = useMemo(
    () => sortRows(
      searchRows(snapshot.rows, query),
      sort,
      (row) => statusSortValue(row.targets[(tab === 'target' ? target : instanceTarget)?.name ?? '']),
    ),
    [snapshot.rows, query, sort, tab, target, instanceTarget],
  );
  const entries = useMemo(
    () => (target ? entriesFor(rows, target.name) : []),
    [rows, target],
  );
  const sourceInventory = useMemo(() => sourceInventoryRows(sourceSnapshot), [sourceSnapshot]);
  const sourceCandidateFound = sourceCandidates.findIndex((candidate) =>
    candidateId(candidate) === sourceCandidateId);
  const sourceCandidateIndex = sourceCandidateFound < 0 ? 0 : sourceCandidateFound;
  const sourceResourceFound = sourceInventory.findIndex(({id}) => id === sourceResourceId);
  const sourceResourceIndex = sourceResourceFound < 0
    ? sourceResourceId === '' ? -1 : 0
    : sourceResourceFound;
  const sourceCandidate = sourceCandidates[sourceCandidateIndex];
  const sourceResource = sourceInventory[sourceResourceIndex];
  const relationshipFound = entries.findIndex((entry) => entry.key === relationshipKey);
  const relationshipIndex = relationshipFound === -1 ? 0 : relationshipFound;
  const entry = entries[relationshipIndex];

  const found = rows.findIndex((row) => row.id === instanceId);
  const instanceIndex = found === -1 ? 0 : found; // deterministic fallback: first row
  const instance = rows[instanceIndex];

  const wide = width >= WIDE_MIN;
  const markedIds = batch
    ? new Set(
        rows
          .filter((row) => row.realPath && batch.marks.has(markKey(home.configDir, row.realPath)))
          .map((row) => row.id),
      )
    : undefined;
  const bodyHeight = Math.max(3, height - 2);
  const listHeight = Math.max(1, bodyHeight - 3);
  const targetStatusWidth = Math.max(
    28,
    Math.min(40, Math.max(0, ...targets.map((target) => target.name.length)) + 24),
  );
  // Info is capped (its text wraps); name lists flex with what remains (long names win).
  const infoWidth = wide ? Math.max(28, Math.min(48, Math.floor(width * 0.28))) : 0;
  const instanceWidth = Math.max(
    10,
    width - targetStatusWidth - infoWidth,
  );
  const modalContent = modal
    ? (skillDetail(home, modal.row.id, projectPath)?.content ?? 'SKILL.md unavailable')
    : '';
  const modalLines = modal ? detailLines(modalContent, Math.max(1, width - 8)) : [];
  const modalPage = Math.max(1, height - 6);
  const sourceDetailContent = sourceDetailLines(
    sourceSurface === 'catalog' ? sourceCandidate : undefined,
    sourceSurface === 'inventory' ? sourceResource : undefined,
  );
  const sourceLogContent = sourceOperation
    ? [
        `Raw log: ${sourceOperation.log ?? 'No subprocess output captured.'}`,
        ...(sourceOperation.plan.recovery?.evidence ?? []).map((evidence) => `Evidence: ${evidence}`),
        ...(sourceOperation.plan.operation === 'shared.remove'
          ? sourceOperation.plan.dependencies.map((dependency) =>
              `Dependency: ${dependency.targetId}/${dependency.slot} ${dependency.form}/${dependency.activation} ` +
              `${dependency.path} fingerprint=${dependency.fingerprint} action=${dependency.plannedAction}`)
          : []),
      ]
    : [];

  const selectedRow = tab === 'target' ? entry?.row : instance;
  const selectedTarget = tab === 'target' ? target : targets[instTarget];
  const selectedInfo = tab === 'target'
    ? entry?.relationship.info
    : selectedRow?.targets[selectedTarget?.name ?? ''];
  const selectedRel = tab === 'target'
    ? entry?.relationship
    : selectedRow?.relationships.find((relationship) =>
        relationship.target === selectedTarget?.name &&
        relationship.info.path === selectedInfo?.path);
  const visibility = useMemo(
    () => resolveVisibility(home, selectedRow, projectPath),
    [home, projectPath, selectedRow, snapshot],
  );
  const activeSourceResource = sourceSurface === 'inventory' ? sourceResource : undefined;
  const sourceVisibility = useMemo(
    () => resolveVisibility(
      home,
      activeSourceResource,
      sourceScope === 'project' ? exactProjectPath : undefined,
    ),
    [home, exactProjectPath, activeSourceResource, sourceScope, sourceSnapshot],
  );
  const sourceTruth = useMemo(
    () => sourceDesiredTruth(home, activeSourceResource, sourceScope, exactProjectPath),
    [home, activeSourceResource, sourceScope, exactProjectPath, sourceSnapshot],
  );
  const sourceTarget = sourceSnapshot.targets.find(({name}) => name === 'shared');
  const sourceRelationship = sourceRelationships(activeSourceResource).find((relationship) =>
    !relationship.readOnly && relationship.info.form === 'local');
  const sourceRemovable = Boolean(
    activeSourceResource && sourceRelationship && activeSourceResource.sourceLabel !== 'Source unknown',
  );
  const sourcePath = sourceTarget?.dir ?? (sourceSnapshot.project ?? home.configDir);
  const explained = useMemo(
    () => resolveVisibility(
      home,
      explainModal?.row,
      projectPath,
      explainModal?.harness,
      explainModal?.want,
    ),
    [home, projectPath, explainModal?.row, explainModal?.harness, explainModal?.want],
  );
  const explainedHarness = explained?.harnesses[0];
  const explainHarnesses = visibility?.harnesses ?? [];
  const explainHarnessIndex = Math.max(
    0,
    explainHarnesses.findIndex(({key}) => key === explainModal?.harness),
  );
  const explainDetailLines = detailLines(
    explanationLines(explained).join('\n'),
    Math.max(1, width - 8),
  );
  const actionable = focusColumn === 1 && selectedRow && selectedTarget;
  const manageRow = manage ? rows.find((candidate) => candidate.id === manage.rowId) : undefined;
  const membership = useMemo((): Membership | undefined => {
    if (!selectedRow) return undefined;
    const { bundles, tags, presets } = snapshot.catalog;
    const unambiguousName = rows.filter((row) => row.name === selectedRow.name).length === 1;
    return {
      bundles: Object.entries(bundles)
        .filter(([, members]) =>
          members.includes(selectedRow.id) ||
          (unambiguousName && members.includes(selectedRow.name)))
        .map(([name]) => name)
        .sort((a, b) => a.localeCompare(b)),
      tags: tags[selectedRow.id] ?? [],
      // Definition membership, same semantics as Bundles/Tags and the manage modal —
      // active claims are a separate concept (they only exist for activated Presets).
      presets: Object.entries(presets)
        .filter(([, preset]) => preset.selectors.includes(`skill:${selectedRow.id}`))
        .map(([name]) => name)
        .sort((a, b) => a.localeCompare(b)),
    };
  }, [selectedRow, snapshot.catalog, rows]);
  /** Re-read disk, then re-anchor selection: mutation moves entries, so locate
   *  the fresh row/relationship by (targetId, slot) or stable row id. */
  const refresh = (keep?: { rowId?: string; targetId?: string; slot?: string; target?: string }) => {
    const next = takeSnapshot();
    setSnapshot(next);
    if (!keep) return;
    const row = keep.targetId === undefined
      ? keep.rowId === undefined
        ? undefined
        : next.rows.find((candidate) => candidate.id === keep.rowId)
      : next.rows.find((candidate) => candidate.relationships.some((rel) =>
          rel.targetId === keep.targetId && rel.slot === keep.slot));
    if (row) setInstanceId(row.id);
    const rel = keep.targetId === undefined
      ? keep.target
        ? row?.relationships.find((candidate) => candidate.target === keep.target)
        : undefined
      : row?.relationships.find((candidate) =>
          candidate.targetId === keep.targetId && candidate.slot === keep.slot);
    if (rel) setRelationshipKey(rel.info.path);
    return next;
  };

  const refreshUpdates = (): void => {
    try {
      const result = sharedRefresh(home, projectPath);
      refresh({
        rowId: selectedRow?.id,
        targetId: selectedRel?.targetId,
        slot: selectedRel?.slot,
      });
      setUpdateModal({kind: 'refresh', items: result.entries, scroll: 0});
    } catch (error) {
      setFeedback((error as Error).message);
    }
  };

  const sourceSteps = (
    operation: SharedMutationPlan['operation'] | SharedRemovalPlan['operation'],
    status: SourceStepStatus = 'queued',
  ): SourceOperationState['steps'] => operation === 'shared.remove'
    ? [
        {name: 'plan recheck', status},
        {name: 'Relationship cascade', status},
        {name: 'recovery manifest', status},
        {name: 'Vercel skills remove', status},
        {name: 'provenance verification', status},
        {name: 'final rescan', status},
      ]
    : [
        {name: 'plan recheck', status},
        {name: 'upstream ownership handoff', status},
        {name: 'Vercel skills add', status},
        {name: 'Desired state preservation', status},
        {name: 'provenance verification', status},
        {name: 'final rescan', status},
      ];

  const applySourceOperation = (operation: SourceOperationState): void => {
    const project = sourceScope === 'project' ? exactProjectPath : undefined;
    let plan = operation.plan;
    try {
      if (plan.operation === 'shared.remove') {
        const result = operation.runStep === 'source'
          ? sharedRemove(home, [plan.source.name], {
              sourceConfirmed: true,
              projectPath: project,
              expected: plan,
            })
          : sharedRemoveCascade(home, [plan.source.name], plan, project);
        const finalSnapshot = sourceTakeSnapshot(sourceScope);
        const truth = verifiedSourceTruth(home, finalSnapshot, plan, sourceScope, exactProjectPath);
        setSourceSnapshot(finalSnapshot);
        if (operation.runStep !== 'source') {
          const steps = sourceSteps(plan.operation);
          for (const step of steps.slice(0, 3)) step.status = 'succeeded';
          setSourceOperation({
            ...operation,
            phase: 'source-confirm',
            result,
            truth,
            retry: false,
            scroll: 0,
            steps,
            log: 'Known Relationship cascade completed; source preserved pending confirmation.',
          });
          return;
        }
        setSourceOperation({
          ...operation,
          phase: 'verify',
          result,
          truth,
          retry: false,
          scroll: 0,
          steps: sourceSteps(plan.operation, 'succeeded'),
          log: 'Pinned Vercel skills remove completed; final filesystem rescan succeeded.',
        });
        return;
      }
      const candidate = operation.candidate!;
      if (operation.retry) {
        const fresh = planSharedAdd(
          home,
          candidate.source,
          candidate.name,
          Boolean(plan.replacement),
          project,
        );
        if (!sameSourceIntent(plan, fresh))
          throw new Error('Source intent changed; new preview required.');
        plan = fresh;
      }
      const result = sharedAdd(
        home,
        candidate.source,
        candidate.name,
        Boolean(plan.replace),
        project,
        plan,
      );
      const finalSnapshot = sourceTakeSnapshot(sourceScope);
      const truth = verifiedSourceTruth(home, finalSnapshot, plan, sourceScope, exactProjectPath);
      setSourceSnapshot(finalSnapshot);
      setSourceOperation({
        ...operation,
        phase: 'verify',
        plan,
        result,
        truth,
        retry: false,
        scroll: 0,
        steps: sourceSteps(plan.operation, 'succeeded'),
        log: 'Pinned Vercel skills handoff completed; final filesystem rescan succeeded.',
      });
    } catch (error) {
      const failure = error as Error & {
        code?: string;
        details?: {stage?: 'upstream' | 'verify'};
      };
      const message = failure.message;
      const preflightFailure = failure.code === 'concurrent_modification' ||
        /changed after preview|new preview required|operation already in progress/i.test(message);
      const failureStage = preflightFailure ? 'preflight' : failure.details?.stage ?? 'preflight';
      let truth: SourceVerifiedTruth | undefined;
      let rescanSucceeded = false;
      try {
        const finalSnapshot = sourceTakeSnapshot(sourceScope);
        truth = verifiedSourceTruth(home, finalSnapshot, plan, sourceScope, exactProjectPath);
        setSourceSnapshot(finalSnapshot);
        rescanSucceeded = true;
      } catch {
        // The operation error remains primary; failure truth reports the unavailable rescan.
      }
      const steps = sourceSteps(plan.operation);
      if (plan.operation === 'shared.remove') {
        if (operation.runStep === 'source') {
          for (const step of steps.slice(0, 3)) step.status = 'succeeded';
          if (steps[3]) steps[3].status = 'failed';
          if (steps[4]) steps[4].status = 'skipped';
          if (steps[5]) steps[5].status = rescanSucceeded ? 'succeeded' : 'failed';
        } else if (failureStage === 'preflight') {
          if (steps[0]) steps[0].status = 'failed';
          for (const step of steps.slice(1, 5)) step.status = 'skipped';
          if (steps[5]) steps[5].status = rescanSucceeded ? 'succeeded' : 'failed';
        } else {
          if (steps[0]) steps[0].status = 'succeeded';
          if (steps[1]) steps[1].status = 'failed';
          for (const step of steps.slice(2, 5)) step.status = 'skipped';
          if (steps[5]) steps[5].status = rescanSucceeded ? 'succeeded' : 'failed';
        }
      } else if (failureStage === 'preflight') {
        if (steps[0]) steps[0].status = 'failed';
        for (const step of steps.slice(1)) step.status = 'skipped';
      } else if (failureStage === 'upstream') {
        if (steps[0]) steps[0].status = 'succeeded';
        if (steps[1]) steps[1].status = 'succeeded';
        if (steps[2]) steps[2].status = 'failed';
        if (steps[3]) steps[3].status = 'succeeded';
        if (steps[4]) steps[4].status = 'skipped';
        if (steps[5]) steps[5].status = rescanSucceeded ? 'succeeded' : 'failed';
      } else {
        for (const step of steps.slice(0, 4)) step.status = 'succeeded';
        if (steps[4]) steps[4].status = 'failed';
        if (steps[5]) steps[5].status = rescanSucceeded ? 'succeeded' : 'failed';
      }
      setSourceOperation({
        ...operation,
        phase: 'failed',
        plan,
        truth,
        retry: false,
        scroll: 0,
        error: preflightFailure ? `${message} New preview required.` : message,
        log: message,
        steps,
      });
    }
  };

  useEffect(() => {
    if (sourceOperation?.phase !== 'run') return;
    const pending = sourceOperation;
    const timer = setTimeout(() => applySourceOperation(pending), 0);
    return () => clearTimeout(timer);
    // The run phase owns one immutable operation; later state transitions must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceOperation?.phase]);

  const beginUpdate = (): void => {
    const marked = Boolean(batch && batch.marks.size > 0);
    const candidates = marked
      ? snapshot.rows.filter((row) =>
          row.realPath && batch?.marks.has(markKey(home.configDir, row.realPath)))
      : selectedRow ? [selectedRow] : [];
    const unique = new Map<string, UpdateItem>();
    for (const row of candidates) {
      const update = row.updateAvailability ?? {
        name: row.name,
        slot: row.id,
        source: row.sourceLabel,
        status: 'unknown' as const,
      };
      const item: UpdateItem = {
        ...update,
        ...(update.status === 'available' ? {} : {outcome: 'skipped' as const}),
        ...(marked && row.realPath ? {mark: markKey(home.configDir, row.realPath)} : {}),
      };
      unique.set(`${update.source}\0${update.slot}`, item);
    }
    const items = [...unique.values()];
    const available = items.filter(({status}) => status === 'available').length;
    if (available === 0) {
      setFeedback(marked
        ? 'Batch update: no marked Skills have an available update'
        : 'Update unavailable: selected Skill is not available');
      return;
    }
    setUpdateModal({kind: 'confirm', items, scroll: 0});
  };

  useInput((input, key) => {
    if (sourceOperation) {
      if (sourceLogOpen) {
        if (key.escape) setSourceLogOpen(false);
        return;
      }
      if (input === 'l') {
        setSourceLogOpen(true);
        return;
      }
      const operationLines = sourceOperationLines(sourceOperation).lines;
      if (sourceOperation.phase !== 'run' && (key.downArrow || input === 'j')) {
        setSourceOperation({
          ...sourceOperation,
          scroll: Math.min(Math.max(0, operationLines.length - 1), sourceOperation.scroll + 1),
        });
        return;
      }
      if (sourceOperation.phase !== 'run' && (key.upArrow || input === 'k')) {
        setSourceOperation({...sourceOperation, scroll: Math.max(0, sourceOperation.scroll - 1)});
        return;
      }
      if (sourceOperation.phase === 'preview') {
        if (key.escape) setSourceOperation(undefined);
        else if (key.return && (sourceOperation.plan.blockers?.length ?? 0) === 0)
          setSourceOperation({...sourceOperation, phase: 'confirm', scroll: 0});
        return;
      }
      if (sourceOperation.phase === 'confirm') {
        if (key.escape) setSourceOperation(undefined);
        else if (key.return) setSourceOperation({
          ...sourceOperation,
          phase: 'run',
          runStep: sourceOperation.plan.operation === 'shared.remove' ? 'cascade' : undefined,
          retry: false,
          scroll: 0,
          steps: sourceSteps(sourceOperation.plan.operation).map((step, index) => ({
            ...step,
            status: index === 0 ? 'running' : 'queued',
          })),
        });
        return;
      }
      if (sourceOperation.phase === 'source-confirm') {
        if (key.escape) {
          setSourceSnapshot(sourceTakeSnapshot(sourceScope));
          setFeedback('Source preserved; Relationship cascade remains complete.');
          setSourceOperation(undefined);
        } else if (key.return) setSourceOperation({
          ...sourceOperation,
          phase: 'run',
          runStep: 'source',
          retry: false,
          scroll: 0,
          steps: sourceOperation.steps.map((step, index) => ({
            ...step,
            status: index === 3 ? 'running' : step.status,
          })),
        });
        return;
      }
      if (sourceOperation.phase === 'verify') {
        if (key.return || key.escape) setSourceOperation(undefined);
        return;
      }
      if (sourceOperation.phase === 'failed' && input === 't') {
        setSourceOperation({
          ...sourceOperation,
          phase: 'run',
          retry: true,
          scroll: 0,
          steps: sourceSteps(sourceOperation.plan.operation).map((step, index) => ({
            ...step,
            status: index === 0 ? 'running' : 'queued',
          })),
        });
      } else if (sourceOperation.phase === 'failed' && key.escape) setSourceOperation(undefined);
      return;
    }
    if (sourceDetailOpen) {
      if (key.escape) setSourceDetailOpen(false);
      return;
    }
    if (targetInfoOpen) {
      if (key.escape) setTargetInfoOpen(false);
      return;
    }
    if (explainModal) {
      if (key.escape) return setExplainModal(null);
      if (key.tab && explainHarnesses.length > 0) {
        const next = explainHarnesses[(explainHarnessIndex + 1) % explainHarnesses.length];
        if (next) return setExplainModal({...explainModal, harness: next.key, scroll: 0});
      }
      if (input === 'v') return setExplainModal({...explainModal, want: 'visible', scroll: 0});
      if (input === 'h') return setExplainModal({...explainModal, want: 'hidden', scroll: 0});
      if (input === 'd') {
        const {want: _, ...diagnosis} = explainModal;
        return setExplainModal({...diagnosis, scroll: 0});
      }
      if (key.downArrow || input === 'j')
        return setExplainModal({...explainModal, scroll: Math.min(Math.max(0, explainDetailLines.length - 1), explainModal.scroll + 1)});
      if (key.upArrow || input === 'k')
        return setExplainModal({...explainModal, scroll: Math.max(0, explainModal.scroll - 1)});
      if (key.pageDown || (key.ctrl && input === 'd'))
        return setExplainModal({...explainModal, scroll: Math.min(Math.max(0, explainDetailLines.length - 1), explainModal.scroll + modalPage)});
      if (key.pageUp || (key.ctrl && input === 'u'))
        return setExplainModal({...explainModal, scroll: Math.max(0, explainModal.scroll - modalPage)});
      return;
    }
    if (modal) {
      if (key.escape) return setModal(null);
      if (key.downArrow || input === 'j')
        return setModal({...modal, scroll: Math.min(modalLines.length - 1, modal.scroll + 1)});
      if (key.upArrow || input === 'k')
        return setModal({...modal, scroll: Math.max(0, modal.scroll - 1)});
      if (key.pageDown || (key.ctrl && input === 'd'))
        return setModal({...modal, scroll: Math.min(modalLines.length - 1, modal.scroll + modalPage)});
      if (key.pageUp || (key.ctrl && input === 'u'))
        return setModal({...modal, scroll: Math.max(0, modal.scroll - modalPage)});
      return;
    }
    if (manage) {
      const current = rows.find((candidate) => candidate.id === manage.rowId);
      if (!current) return setManage(null);
      const row = current;
      const selector = `skill:${row.id}`;
      const assignedTags = snapshot.catalog.tags[row.id] ?? [];
      const tagNames = knownTagNames(snapshot.catalog.tags);
      const presetNames = Object.keys(snapshot.catalog.presets)
        .sort((a, b) => a.localeCompare(b));
      const rowCount = (manage.section === 'tags' ? tagNames.length : presetNames.length) + 1;
      const draft = manage.input;
      if (draft) {
        if (key.escape) return setManage({...manage, input: undefined});
        if (key.return) {
          const value = draft.value.trim();
          if (value) {
            try {
              prepareMutation();
              if (draft.kind === 'tag') {
                addResourceTags(home, selector, [value]);
                setFeedback(`Tagged ${row.name}: ${value}`);
              } else {
                createPreset(home, value, [selector]);
                setFeedback(`Created preset ${value} with ${row.name}`);
              }
              refresh({rowId: row.id});
            } catch (err) {
              setFeedback((err as Error).message);
            }
          }
          return setManage({...manage, input: undefined});
        }
        if (key.backspace || key.delete || input === '\x7f')
          return setManage({...manage, input: {...draft, value: draft.value.slice(0, -1)}});
        if (input && !key.ctrl && !key.meta)
          return setManage({...manage, input: {...draft, value: draft.value + input}});
        return;
      }
      if (key.escape) return setManage(null);
      if (key.tab)
        return setManage({
          ...manage,
          section: manage.section === 'tags' ? 'presets' : 'tags',
          index: 0,
        });
      if (key.downArrow || input === 'j')
        return setManage({...manage, index: Math.min(rowCount - 1, manage.index + 1)});
      if (key.upArrow || input === 'k')
        return setManage({...manage, index: Math.max(0, manage.index - 1)});
      const onActionRow = manage.index === rowCount - 1;
      if (manage.section === 'tags') {
        if ((key.return || input === 'a') && onActionRow)
          return setManage({...manage, input: {kind: 'tag', value: ''}});
        const tag = tagNames[manage.index];
        if (!onActionRow && tag !== undefined && (input === ' ' || input === 'x')) {
          const assigned = assignedTags.includes(tag);
          if (input === 'x' && !assigned) return;
          try {
            prepareMutation();
            if (assigned) removeResourceTags(home, selector, [tag]);
            else addResourceTags(home, selector, [tag]);
            refresh({rowId: row.id});
            setFeedback(assigned
              ? `Removed tag ${tag} from ${row.name}`
              : `Tagged ${row.name}: ${tag}`);
          } catch (err) {
            setFeedback((err as Error).message);
          }
          return setManage({...manage, index: Math.min(manage.index, Math.max(0, tagNames.length - 1))});
        }
        return;
      }
      if ((key.return || input === 'a') && onActionRow)
        return setManage({...manage, input: {kind: 'preset', value: ''}});
      if (input === ' ' && !onActionRow) {
        const name = presetNames[manage.index];
        if (name !== undefined) {
          try {
            prepareMutation();
            const member = (snapshot.catalog.presets[name]?.selectors ?? []).includes(selector);
            if (member) removePresetSelectors(home, name, [selector]);
            else addPresetSelectors(home, name, [selector]);
            refresh({rowId: row.id});
            setFeedback(member
              ? `Removed ${row.name} from preset ${name}`
              : `Added ${row.name} to preset ${name}`);
          } catch (err) {
            setFeedback((err as Error).message);
          }
        }
        return;
      }
      return;
    }
    if (searching) {
      if (key.escape) {
        setQuery('');
        return setSearching(false);
      }
      if (key.return) {
        if (tab === 'source') {
          try {
            const result = sharedFind(
              home,
              query.trim().split(/\s+/).filter(Boolean),
              sourceScope === 'project' ? exactProjectPath : undefined,
              false,
            );
            setSourceCandidates(result.candidates);
            setSourceCandidateId(result.candidates[0]
              ? candidateId(result.candidates[0])
              : undefined);
            setFeedback(result.raw ? 'Source returned unstructured output' : `${result.candidates.length} candidates`);
          } catch (error) {
            setFeedback((error as Error).message);
          }
        }
        return setSearching(false);
      }
      if (key.backspace || key.delete || input === '\x7f')
        return setQuery((value) => value.slice(0, -1));
      if (input && !key.ctrl && !key.meta) return setQuery((value) => value + input);
      return;
    }
    if (updateModal) {
      const lines = updateModalLines(updateModal);
      if (key.downArrow || input === 'j')
        return setUpdateModal({...updateModal, scroll: Math.min(Math.max(0, lines.length - 1), updateModal.scroll + 1)});
      if (key.upArrow || input === 'k')
        return setUpdateModal({...updateModal, scroll: Math.max(0, updateModal.scroll - 1)});
      if (updateModal.kind === 'confirm' && input === 'y') {
        let latest: Map<string, SharedUpdateAvailabilityEntry>;
        try {
          latest = new Map(sharedOutdated(home, projectPath).entries.map((item) => [item.slot, item]));
        } catch (error) {
          setFeedback((error as Error).message);
          return;
        }
        const results: UpdateItem[] = [];
        for (const item of updateModal.items) {
          if (item.outcome === 'skipped') {
            results.push(item);
            continue;
          }
          const current = latest.get(item.slot);
          if (current?.status !== 'available') {
            results.push({...item, ...(current ?? {}), outcome: 'skipped'});
            continue;
          }
          try {
            sharedUpdate(home, [item.name], projectPath);
            results.push({...item, outcome: 'updated'});
          } catch (error) {
            results.push({...item, outcome: 'failed', error: (error as Error).message});
          }
        }
        const completed = new Set(results
          .filter(({outcome, mark}) => outcome === 'updated' && mark)
          .map(({mark}) => mark as string));
        if (completed.size > 0)
          setBatch((current) => current
            ? {marks: new Set([...current.marks].filter((mark) => !completed.has(mark)))}
            : current);
        refresh({
          rowId: selectedRow?.id,
          targetId: selectedRel?.targetId,
          slot: selectedRel?.slot,
        });
        return setUpdateModal({kind: 'result', items: results, scroll: 0});
      }
      if (input === 'n' || key.escape) return setUpdateModal(null);
      return;
    }
    if (batchConfirm) {
      if (input === 'y') {
        let applied = 0;
        const failures: string[] = [];
        for (const plan of batchConfirm.plans) {
          try {
            applyActivationPlan(home, plan);
            applied++;
          } catch (err) {
            failures.push((err as Error).message);
          }
        }
        refresh({
          rowId: selectedRow?.id,
          target: selectedTarget?.name,
        });
        setFeedback(
          `Batch ${batchConfirm.intent} @ ${batchConfirm.targetName}: ${applied} applied` +
          (failures.length > 0 ? `, ${failures.length} failed` : ''),
        );
        return setBatchConfirm(null);
      }
      if (input === 'n' || key.escape) return setBatchConfirm(null);
      return;
    }
    if (batchTag) {
      if (key.escape) return setBatchTag(null);
      if (key.return) {
        const value = batchTag.value.trim();
        if (value && batch) {
          const markedRows = rows.filter(
          (row) => row.realPath && batch.marks.has(markKey(home.configDir, row.realPath)));
          try {
            prepareMutation();
          } catch (err) {
            setFeedback((err as Error).message);
            return setBatchTag(null);
          }
          let count = 0;
          const failures: string[] = [];
          for (const row of markedRows) {
            try {
              if (batchTag.action === 'add') addResourceTags(home, `skill:${row.id}`, [value]);
              else removeResourceTags(home, `skill:${row.id}`, [value]);
              count++;
            } catch (err) {
              failures.push((err as Error).message);
            }
          }
          refresh();
          setFeedback(
            `${batchTag.action === 'add' ? 'Tagged' : 'Untagged'} ${count} skills: ${value}` +
            (failures.length > 0 ? ` (${failures.length} failed)` : ''),
          );
        }
        return setBatchTag(null);
      }
      if (key.backspace || key.delete || input === '\x7f')
        return setBatchTag({...batchTag, value: batchTag.value.slice(0, -1)});
      if (input && !key.ctrl && !key.meta)
        return setBatchTag({...batchTag, value: batchTag.value + input});
      return;
    }
    if (confirmation) {
      if (input === 'y') {
        const neighbor = tab === 'target'
          ? entries[relationshipIndex + 1] ?? entries[relationshipIndex - 1]
          : undefined;
        try {
          if (confirmation.kind === 'link' || confirmation.kind === 'mirror-create') {
            applyActivationPlan(home, planLink(home, confirmation.row.id, confirmation.target.name, planScope));
          } else if (confirmation.kind === 'unlink') {
            applyActivationPlan(home, planUnlink(home, confirmation.targetId, confirmation.slot, planScope));
          } else {
            applyActivationPlan(home, planMirrorAction(
              home,
              confirmation.targetId,
              confirmation.slot,
              confirmation.kind.replace('mirror-', '') as 'sync' | 'overwrite' | 'convert' | 'remove',
              planScope,
            ));
          }
          refresh({rowId: confirmation.row.id});
          if (neighbor) setRelationshipKey(neighbor.key);
          setFeedback(`${confirmation.kind === 'link' || confirmation.kind === 'mirror-create' ? 'Linked' : confirmation.kind === 'unlink' ? 'Unlinked' : confirmation.kind.replace('mirror-', 'Mirror ')} ${confirmation.row.name} @ ${confirmation.target.name}`);
        } catch (err) {
          setFeedback((err as Error).message);
        }
        return setConfirmation(null);
      }
      if (input === 'n' || key.escape) return setConfirmation(null);
      return;
    }
    if (input === '1' || input === '2' || input === '3') {
      setBatch(null);
      setQuery('');
      if (input === '3') {
        try {
          setSourceSnapshot(sourceTakeSnapshot(sourceScope));
        } catch (error) {
          setFeedback((error as Error).message);
        }
      }
      setTab(input === '1' ? 'target' : input === '2' ? 'skill' : 'source');
      return;
    }
    if (tab === 'source') {
      if (input === 'q' || (key.ctrl && input === 'c')) return exit();
      if (input === 'g' || input === 'p') {
        const scope: SourceScope = input === 'g' ? 'global' : 'project';
        try {
          const next = sourceTakeSnapshot(scope);
          setSourceScope(scope);
          setSourceSnapshot(next);
          setSourceCandidates([]);
          setSourceCandidateId(undefined);
          setSourceResourceId(undefined);
          setSourceMarks(new Set());
          setSourceOperation(undefined);
          setQuery('');
          setFeedback('');
        } catch (error) {
          setFeedback((error as Error).message);
        }
        return;
      }
      if (key.tab) {
        setSourceSurface((value) => value === 'catalog' ? 'inventory' : 'catalog');
        return;
      }
      if (input === '/') {
        setSourceSurface('catalog');
        setQuery('');
        setSearching(true);
        return;
      }
      if (input === 'a' && sourceSurface === 'catalog' && sourceCandidate) {
        try {
          const project = sourceScope === 'project' ? exactProjectPath : undefined;
          const initial = planSharedAdd(
            home,
            sourceCandidate.source,
            sourceCandidate.name,
            false,
            project,
          );
          const plan = initial.replacement
            ? planSharedAdd(home, sourceCandidate.source, sourceCandidate.name, true, project)
            : initial;
          setSourceOperation({
            phase: 'preview',
            plan,
            candidate: sourceCandidate,
            steps: sourceSteps(plan.operation),
            scroll: 0,
          });
        } catch (error) {
          setFeedback((error as Error).message);
        }
        return;
      }
      if (input === 'r') {
        try {
          const result = sharedRefresh(
            home,
            sourceScope === 'project' ? exactProjectPath : undefined,
          );
          const keep = sourceResource?.id;
          const next = sourceTakeSnapshot(sourceScope);
          const validIds = new Set(sourceInventoryRows(next).map(({id}) => id));
          setSourceSnapshot(next);
          setSourceResourceId(keep && validIds.has(keep) ? keep : '');
          setSourceMarks((marks) => new Set([...marks].filter((id) => validIds.has(id))));
          setFeedback(`Refreshed ${result.entries.length} managed resources`);
        } catch (error) {
          setFeedback((error as Error).message);
        }
        return;
      }
      if (key.downArrow || input === 'j') {
        if (sourceSurface === 'catalog') {
          const next = sourceCandidates[Math.min(sourceCandidates.length - 1, sourceCandidateIndex + 1)];
          if (next) setSourceCandidateId(candidateId(next));
        } else {
          const next = sourceInventory[Math.min(sourceInventory.length - 1, sourceResourceIndex + 1)];
          if (next) setSourceResourceId(next.id);
        }
        return;
      }
      if (key.upArrow || input === 'k') {
        if (sourceSurface === 'catalog') {
          const next = sourceCandidates[Math.max(0, sourceCandidateIndex - 1)];
          if (next) setSourceCandidateId(candidateId(next));
        } else {
          const next = sourceInventory[Math.max(0, sourceResourceIndex - 1)];
          if (next) setSourceResourceId(next.id);
        }
        return;
      }
      if (input === 'd' && sourceSurface === 'inventory' && sourceResource) {
        if (!sourceRemovable)
          return setFeedback('Remove unavailable: select a proven Vercel-managed local Shared source');
        try {
          const project = sourceScope === 'project' ? exactProjectPath : undefined;
          const plan = planSharedRemove(home, [sourceResource.name], project);
          setSourceOperation({
            phase: 'preview',
            plan,
            steps: sourceSteps(plan.operation),
            scroll: 0,
          });
        } catch (error) {
          setFeedback((error as Error).message);
        }
        return;
      }
      if (input === ' ' && sourceSurface === 'inventory' && sourceResource) {
        const marks = new Set(sourceMarks);
        if (marks.has(sourceResource.id)) marks.delete(sourceResource.id);
        else marks.add(sourceResource.id);
        setSourceMarks(marks);
        return;
      }
      if (key.return && (sourceCandidate || sourceResource)) {
        setSourceDetailOpen(true);
        return;
      }
      return;
    }
    if (batch) {
      if (input === 'v' || key.escape) return setBatch(null);
      if (input === 'r') return refreshUpdates();
      if (input === 'u') return beginUpdate();
      if (key.tab) {
        setBatch({marks: new Set()});
        return setTab((value) => (value === 'target' ? 'skill' : 'target'));
      }
      if (input === ' ' && selectedRow?.realPath) {
        const marks = new Set(batch.marks);
        const key = markKey(home.configDir, selectedRow.realPath);
        if (marks.has(key)) marks.delete(key);
        else marks.add(key);
        return setBatch({marks});
      }
      if (input === ' ') return setFeedback('cannot mark a broken relationship');
      if (input === 'o' || input === 'O') {
        const intent = input === 'o' ? 'on' : 'off';
        const target = selectedTarget;
        const markedRows = rows.filter(
          (row) => row.realPath && batch.marks.has(markKey(home.configDir, row.realPath)));
        if (!target || markedRows.length === 0)
          return setFeedback('Batch: mark at least one skill with a directory');
        const plans: ActivationPlan[] = [];
        const errors: string[] = [];
        for (const row of markedRows) {
          if (intent === 'on' && inheritedOn(row.targets[target.name])) continue;
          if (intent === 'off' && (!row.targets[target.name] || inheritedOn(row.targets[target.name])))
            continue;
          try {
            plans.push(planActivation(home, `skill:${row.id}`, [target.name], intent, planScope));
          } catch (err) {
            errors.push(`${row.name}: ${(err as Error).message}`);
          }
        }
        if (plans.length === 0 && errors.length === 0)
          return setFeedback(`Batch ${intent}: skipped already-effective entries`);
        return setBatchConfirm({intent, targetName: target.name, plans, errors});
      }
      if (input === 't' || input === 'T')
        return setBatchTag({action: input === 't' ? 'add' : 'rm', value: ''});
      if (input === 'i' || input === 'o' || input === 'c' || input === 'm')
        return setFeedback('exit batch mode first (v)');
    }
    if (input === 'v') return setBatch({marks: new Set()});
    if (input === 'm' && selectedRow?.realPath)
      return setManage({rowId: selectedRow.id, section: 'tags', index: 0});
    if (input === 'e') {
      const harness = visibility?.harnesses[0];
      if (!selectedRow?.realPath || !harness)
        return setFeedback('Explain unavailable: select an installed Skill resource');
      return setExplainModal({row: selectedRow, harness: harness.key, scroll: 0});
    }
    if (input === 'q' || (key.ctrl && input === 'c')) return exit();
    if (input === '/') return setSearching(true);
    if (input === 's')
      return setSort((value) => value === 'name' ? 'status' : value === 'status' ? 'source' : 'name');
    if (input === 'r') return refreshUpdates();
    if (input === 'u' && selectedRow?.updateAvailability?.status === 'available')
      return beginUpdate();
    if (input === 'R') {
      const currentTarget = target?.name;
      const currentInstanceTarget = instanceTarget?.name;
      const next = takeSnapshot();
      setSnapshot(next);
      setTargetIndex(Math.max(0, next.targets.findIndex(({name}) => name === currentTarget)));
      setInstanceTargetIndex(Math.max(0, next.targets.findIndex(({name}) => name === currentInstanceTarget)));
      return;
    }
    if (key.tab) return setTab((value) => (value === 'target' ? 'skill' : 'target'));
    if (key.rightArrow || input === 'l') return setFocusColumn(1);
    if (key.leftArrow || input === 'h') return setFocusColumn(0);
    if (key.downArrow || input === 'j') {
      if (tab === 'target') {
        if (focusColumn === 0)
          setTargetIndex((value) => Math.min(Math.max(0, targets.length - 1), value + 1));
        else {
          const next = entries[Math.min(entries.length - 1, relationshipIndex + 1)];
          if (next) setRelationshipKey(next.key);
        }
      } else if (focusColumn === 0) {
        const next = rows[Math.min(rows.length - 1, instanceIndex + 1)];
        if (next) setInstanceId(next.id);
      } else {
        setInstanceTargetIndex((value) => Math.min(Math.max(0, targets.length - 1), value + 1));
      }
      return;
    }
    if (key.upArrow || input === 'k') {
      if (tab === 'target') {
        if (focusColumn === 0) setTargetIndex((value) => Math.max(0, value - 1));
        else {
          const next = entries[Math.max(0, relationshipIndex - 1)];
          if (next) setRelationshipKey(next.key);
        }
      } else if (focusColumn === 0) {
        const next = rows[Math.max(0, instanceIndex - 1)];
        if (next) setInstanceId(next.id);
      } else {
        setInstanceTargetIndex((value) => Math.max(0, value - 1));
      }
      return;
    }
    if (input === ' ' && actionable) {
      if (inheritedOn(selectedInfo))
        return setFeedback(`read-only: inherited from ${selectedRel?.scope}`);
      const canEnable = Boolean(projectPath) && selectedRow.realPath &&
        (!selectedInfo || selectedInfo.readOnly);
      if (!selectedInfo && !canEnable) return;
      if (!selectedRow.realPath && !selectedInfo)
        return setFeedback('cannot enable a broken relationship');
      try {
        if (selectedInfo && !selectedInfo.readOnly && selectedRel) {
          applyActivationPlan(home, planToggle(home, selectedRel.targetId, selectedRel.slot, planScope));
          refresh({targetId: selectedRel.targetId, slot: selectedRel.slot, rowId: selectedRow.id});
          setFeedback(`${selectedRow.name} @ ${selectedTarget.name}: ${selectedInfo.underOff ? 'on' : 'off'}`);
        } else if (canEnable) {
          const plan = planActivation(home, `skill:${selectedRow.id}`, [selectedTarget.name], 'on', planScope);
          if (plan.targets[0]?.createForm === 'mirror') {
            return setConfirmation({
              kind: 'mirror-create',
              row: selectedRow,
              target: selectedTarget,
              targetId: '',
              slot: '',
              source: selectedRow.realPath ?? '',
              destination: path.join(selectedTarget.dir, selectedRow.name),
            });
          }
          applyActivationPlan(home, plan);
          refresh({rowId: selectedRow.id, target: selectedTarget.name});
          setFeedback(`${selectedRow.name} @ ${selectedTarget.name}: on`);
        }
      } catch (err) {
        setFeedback((err as Error).message);
      }
      return;
    }
    if (input === 'i' && actionable && !selectedInfo && !projectPath) {
      if (!selectedRow.realPath) return setFeedback('Link unavailable: selected skill has no directory');
      try {
        const plan = planLink(home, selectedRow.id, selectedTarget.name, planScope);
        return setConfirmation({
          kind: plan.targets[0]?.createForm === 'mirror' ? 'mirror-create' : 'link',
          row: selectedRow,
          target: selectedTarget,
          targetId: '',
          slot: '',
          source: selectedRow.realPath,
          destination: path.join(selectedTarget.dir, selectedRow.name),
        });
      } catch (err) {
        return setFeedback((err as Error).message);
      }
    }
    if (actionable && selectedInfo?.mirrored && selectedRel &&
      (input === 'S' || input === 'o' || input === 'c' || input === 'u' || input === 'x')) {
      if (selectedRel.readOnly)
        return setFeedback(`read-only: inherited from ${selectedRel.scope}`);
      const kind = input === 'S'
        ? 'mirror-sync'
        : input === 'o'
          ? 'mirror-overwrite'
          : input === 'c'
            ? 'mirror-convert'
            : 'mirror-remove';
      return setConfirmation({
        kind,
        row: selectedRow,
        target: selectedTarget,
        info: selectedInfo,
        targetId: selectedRel.targetId,
        slot: selectedRel.slot,
        source: selectedInfo.path,
        destination: selectedRow.realPath ?? '?',
      });
    }
    if ((input === 'u' || input === 'x') && actionable && selectedInfo?.linked && selectedRel) {
      if (selectedRel.readOnly)
        return setFeedback(`read-only: inherited from ${selectedRel.scope}`);
      return setConfirmation({
        kind: 'unlink',
        row: selectedRow,
        target: selectedTarget,
        info: selectedInfo,
        targetId: selectedRel.targetId,
        slot: selectedRel.slot,
        source: selectedInfo.path,
        destination: selectedInfo.target ?? '?',
      });
    }
    if (key.return) {
      if (tab === 'target' && focusColumn === 0 && target)
        return setTargetInfoOpen(true);
      const row = tab === 'target' ? entry?.row : instance;
      if (row) setModal({row, scroll: 0});
    }
  });

  const columnName =
    tab === 'source'
      ? sourceSurface
      : tab === 'target'
        ? focusColumn === 0
          ? 'targets'
          : 'relationships'
        : focusColumn === 0
          ? 'skills'
          : 'targets';
  const actionHint = actionable
    ? inheritedOn(selectedInfo)
      ? ''
      : selectedInfo && !selectedInfo.readOnly
        ? ` space ${selectedInfo.underOff ? 'on' : 'off'}${selectedInfo.mirrored
          ? `  S sync  o overwrite  c convert  ${selectedRow.updateAvailability?.status === 'available' ? 'x' : 'u'} remove`
          : selectedInfo.linked
            ? `  ${selectedRow.updateAvailability?.status === 'available' ? 'x' : 'u'} unlink`
            : ''}`
        : selectedRow.realPath
          ? projectPath ? ' space on' : ' i link'
          : ''
    : '';
  const updateHint = selectedRow?.updateAvailability?.status === 'available'
    ? '  u update'
    : '';

  return h(
    Box,
    {flexDirection: 'column', width, height},
    h(
      Text,
      null,
      h(Text, {inverse: tab === 'target'}, ' 1 Target '),
      ' ',
      h(Text, {inverse: tab === 'skill'}, ' 2 Skill '),
      ' ',
      h(Text, {inverse: tab === 'source'}, ' 3 Source '),
      snapshot.project && tab !== 'source' ? h(Text, {color: 'cyan'}, `  Project: ${snapshot.project}`) : null,
      tab === 'source'
        ? `  ${sourceSurface === 'catalog' ? 'Catalog' : 'Inventory'}`
        : `  Sort: ${sortLabel(sort)}${query ? `  Search: ${query}` : ''}`,
    ),
    sourceLogOpen && sourceOperation
      ? h(
          Box,
          {height: bodyHeight, paddingLeft: 2, paddingRight: 2, paddingTop: 1},
          h(SourceDetail, {
            title: 'Source operation log & evidence',
            lines: sourceLogContent,
            bordered: true,
            wrap: 'wrap',
          }),
        )
      : sourceDetailOpen
      ? h(
          Box,
          {height: bodyHeight, paddingLeft: 2, paddingRight: 2, paddingTop: 1},
          h(SourceDetail, {
            title: sourceSurface === 'catalog' ? 'Candidate detail' : 'Resource detail',
            lines: sourceDetailContent,
            bordered: true,
          }),
        )
      : targetInfoOpen && target
      ? h(
          Box,
          {height: bodyHeight, paddingLeft: 2, paddingRight: 2, paddingTop: 1},
          h(TargetInfoPanel, {
            target,
            harness: targetHarness,
            width: Math.max(12, width - 4),
          }),
        )
      : explainModal
        ? h(
            Box,
            {height: bodyHeight, paddingLeft: 2, paddingRight: 2, paddingTop: 1},
            h(ExplainModal, {
              row: explainModal.row,
              harnessName: explainedHarness?.name ?? explainModal.harness,
              harnessIndex: explainHarnessIndex,
              harnessCount: Math.max(1, explainHarnesses.length),
              lines: explainDetailLines,
              scroll: explainModal.scroll,
              height,
            }),
          )
      : modal
        ? h(
            Box,
            {height: bodyHeight, paddingLeft: 2, paddingRight: 2, paddingTop: 1},
            h(DetailModal, {row: modal.row, lines: modalLines, scroll: modal.scroll, height}),
          )
      : manage && manageRow
        ? h(
            Box,
            {height: bodyHeight, paddingLeft: 2, paddingRight: 2, paddingTop: 1},
            h(ManageModal, {
              row: manageRow,
              catalog: snapshot.catalog,
              bundles: membership?.bundles ?? [],
              manage,
            }),
          )
      : updateModal
        ? h(
            Box,
            {height: bodyHeight, paddingLeft: 2, paddingRight: 2, paddingTop: 1},
            h(UpdateModal, {modal: updateModal, height}),
          )
      : batchConfirm
        ? h(
            Box,
            {height: bodyHeight, paddingLeft: 2, paddingRight: 2, paddingTop: 1},
            h(BatchActivationModal, {confirm: batchConfirm}),
          )
      : confirmation
        ? h(
            Box,
            {height: bodyHeight, paddingLeft: 2, paddingRight: 2, paddingTop: 1},
            h(ConfirmationModal, {confirmation}),
          )
      : tab === 'source'
        ? h(SourceWorkspace, {
            scope: sourceScope,
            scopePath: sourcePath,
            surface: sourceSurface,
            candidates: sourceCandidates,
            candidateIndex: sourceCandidateIndex,
            inventory: sourceInventory,
            inventoryIndex: sourceResourceIndex,
            marks: sourceMarks,
            visibility: sourceVisibility,
            desired: sourceTruth.desired,
            drift: sourceTruth.drift,
            operation: sourceOperation,
            width,
            height: bodyHeight,
          })
      : tab === 'target'
        ? h(
            Box,
            {height: bodyHeight},
            h(TargetList, {
              targets,
              harnesses: snapshot.harnesses,
              pendingTargetKeys: snapshot.pendingTargetKeys,
              selected: targetIndex,
              focused: focusColumn === 0,
              maxWidth: Math.max(10, Math.floor(width / 2) + 2),
              height: listHeight,
            }),
            h(RelationshipList, {
              entries,
              selected: relationshipIndex,
              focused: focusColumn === 1,
              height: listHeight,
              marks: markedIds,
              showScope: snapshot.project !== undefined,
            }),
            wide
              ? focusColumn === 0
                ? h(TargetInfoPanel, {
                    target,
                    harness: targetHarness,
                    width: infoWidth,
                  })
                : h(InfoPanel, {
                    row: entry?.row,
                    info: entry?.relationship.info,
                    membership,
                    visibility,
                    width: infoWidth,
                  })
              : null,
          )
        : h(
            Box,
            {height: bodyHeight},
            h(InstanceList, {
              rows,
              selected: instanceIndex,
              focused: focusColumn === 0,
              width: instanceWidth,
              height: listHeight,
              marks: markedIds,
            }),
            wide
              ? h(InfoPanel, {
                  row: instance,
                  info: instance?.targets[targets[instTarget]?.name ?? ''],
                  membership,
                  visibility,
                  width: infoWidth,
                })
              : null,
            h(TargetStatusList, {
              targets,
              row: instance,
              selected: instTarget,
              focused: focusColumn === 1,
              width: targetStatusWidth,
              height: listHeight,
            }),
          ),
    h(
      Text,
      {inverse: true, wrap: 'truncate-end'},
      sourceLogOpen
        ? ' esc close log/evidence '
        : sourceDetailOpen
        ? ' esc close '
        : targetInfoOpen
        ? ' esc close '
        : explainModal
          ? ' tab Harness  v visible  h hidden  d diagnosis  ↑↓/j/k scroll  PgUp/PgDn page  esc close '
        : modal
          ? ' ↑↓/jk scroll  PgUp/PgDn page  esc close '
        : manage
          ? ` ${feedback}${feedback ? '  ' : ''}j/k move  tab section  space toggle  a add  x rm tag  esc close `
        : updateModal
          ? updateModal.kind === 'confirm'
            ? ' y confirm  n/esc cancel '
            : ' ↑↓/j/k scroll  esc close '
        : batchConfirm
          ? ' y confirm  n/esc cancel '
        : batchTag
          ? ` tag ${batchTag.action === 'add' ? 'add' : 'rm'}: ${batchTag.value}`
        : batch
          ? ` ${feedback}${feedback ? '  ' : ''}${batch.marks.size} marked  v/esc exit  space mark  u update  r updates  o on  O off  t tag  T untag `
        : confirmation
          ? ' y confirm  n/esc cancel '
        : searching
          ? ` search: ${query || '…'}  enter ${tab === 'source' ? 'search Source' : 'apply'}  esc clear `
          : tab === 'source'
            ? sourceOperation
              ? sourceOperationHint(sourceOperation)
              : ` ${feedback}${feedback ? '  ' : ''}source:${columnName}  g Global  p exact Project  tab Catalog/Inventory  / search  ↑↓/jk  enter detail${sourceSurface === 'catalog' && sourceCandidate ? '  a add/replace' : ''}  r refresh${sourceSurface === 'inventory' ? `  space mark (${sourceMarks.size})${sourceRemovable ? '  d remove' : ''}` : ''}  1/2 matrices  q `
            : ` ${feedback}${feedback ? '  ' : ''}${tab}:${columnName}  ←→/hl  ↑↓/jk${actionHint}${updateHint}  enter ${tab === 'target' && focusColumn === 0 ? 'details' : 'SKILL.md'}${selectedRow?.realPath ? '  e explain' : ''}  m manage  / search  s sort:${sortLabel(sort)}  r updates  R refresh  tab  1/2/3 workspace  q `,
    ),
  );
}

export async function runTui(
  home: Home = defaultHome({ migrate: false }),
  options: { projectPath?: string } = {},
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('skillspub tui requires an interactive terminal');
  }
  const app = render(h(App, {home, projectPath: options.projectPath}), {
    exitOnCtrlC: false,
    patchConsole: false,
    alternateScreen: true,
  });
  await app.waitUntilExit();
}
