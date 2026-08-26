import {createElement as h, useEffect, useMemo, useState} from 'react';
import type {ReactNode} from 'react';
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
  sharedOutdated,
  sharedRefresh,
  sharedUpdate,
  type SharedUpdateAvailabilityEntry,
} from './shared.ts';

/** Below this width the passive summary column is hidden. */
const WIDE_MIN = 80;

type Tab = 'target' | 'skill';

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
  const rows = [
    ...targets.map(({name}) => {
      const support = detected.get(name)?.support;
      return `  ${name}${support ? ` [${support}]` : ''}`;
    }),
    ...(pending.length === 0 ? [] : [' Pending migration']),
    ...(harnesses.available.length === 0 ? [] : [' Available']),
    ...[...pending, ...harnesses.available]
      .map(({name, support}) => `   ${name} [${support}]`),
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
        harness ? h(Text, {dimColor: true}, ` [${harness.support}]`) : null,
      );
    }),
    ...(pending.length === 0
      ? []
      : [
          h(Text, {key: 'pending-migration', dimColor: true, wrap: 'truncate-end'}, ' Pending migration'),
          ...pending.map((harness) => h(
            Text,
            {key: `pending:${harness.key}`, dimColor: true, wrap: 'truncate-end'},
            `   ${harness.name} [${harness.support}]`,
          )),
        ]),
    ...(harnesses.available.length === 0
      ? []
      : [
          h(Text, {key: 'available', dimColor: true, wrap: 'truncate-end'}, ' Available'),
          ...harnesses.available.map((harness) => h(
            Text,
            {key: `available:${harness.key}`, dimColor: true, wrap: 'truncate-end'},
            `   ${harness.name} [${harness.support}]`,
          )),
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
      h(Text, {key: 'support'}, ' ', h(Text, {bold: true}, 'Support:'), ` ${harness.support}`),
      h(Text, {key: 'shared'}, ' ', h(Text, {bold: true}, 'Shared:'), ` ${harness.sharedConsumption.status}`),
      h(Text, {key: 'isolation'}, ' ', h(Text, {bold: true}, 'Isolation:'), ` ${harness.isolation.status}`),
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
    !row
      ? h(Text, {dimColor: true}, '  nothing selected')
      : [
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
        ],
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
    `Support: ${harness.support}`,
    `Shared: ${harness.sharedConsumption.status} — ${harness.sharedConsumption.detail}`,
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
    const row = keep.targetId !== undefined
      ? next.rows.find((candidate) => candidate.relationships.some((rel) =>
          rel.targetId === keep.targetId && rel.slot === keep.slot))
      : keep.rowId !== undefined
        ? next.rows.find((candidate) => candidate.id === keep.rowId)
        : undefined;
    if (row) setInstanceId(row.id);
    const rel = keep.targetId !== undefined
      ? row?.relationships.find((candidate) =>
          candidate.targetId === keep.targetId && candidate.slot === keep.slot)
      : keep.target
        ? row?.relationships.find((candidate) => candidate.target === keep.target)
        : undefined;
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
      if (key.return) return setSearching(false);
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
    tab === 'target'
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
      h(Text, {inverse: tab === 'target'}, ' Target '),
      ' ',
      h(Text, {inverse: tab === 'skill'}, ' Skill '),
      snapshot.project ? h(Text, {color: 'cyan'}, `  Project: ${snapshot.project}`) : null,
      `  Sort: ${sortLabel(sort)}${query ? `  Search: ${query}` : ''}`,
    ),
    targetInfoOpen && target
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
              maxWidth: Math.max(10, Math.floor(width / 2)),
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
      targetInfoOpen
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
          ? ` search: ${query || '…'}  enter apply  esc clear `
          : ` ${feedback}${feedback ? '  ' : ''}${tab}:${columnName}  ←→/hl  ↑↓/jk${actionHint}${updateHint}  enter ${tab === 'target' && focusColumn === 0 ? 'details' : 'SKILL.md'}${selectedRow?.realPath ? '  e explain' : ''}  m manage  / search  s sort:${sortLabel(sort)}  r updates  R refresh  tab  q `,
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
