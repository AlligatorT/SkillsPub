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
  selected,
  focused,
  width,
  height,
}: {
  targets: TuiSnapshot['targets'];
  harnesses: TuiSnapshot['harnesses'];
  selected: number;
  focused: boolean;
  width: number;
  height: number;
}): ReactNode {
  const start = windowStart(targets.length, selected, height);
  return h(
    ListColumn,
    {title: 'Targets', focused, width},
    h(Text, {dimColor: true}, ' Detected Harnesses'),
    ...(harnesses.detected.length === 0
      ? [h(Text, {key: 'none', dimColor: true}, '   none')]
      : harnesses.detected.map((harness) =>
        h(Text, {key: harness.key}, `   ${harness.name} [${harness.support}] Shared ${harness.sharedConsumption.status} Isolation ${harness.isolation.status}`))),
    ...(harnesses.setup.length === 0
      ? []
      : [
        h(Text, {key: 'setup', dimColor: true}, ' Setup'),
        ...harnesses.setup.map((harness) =>
          h(Text, {key: `setup:${harness.key}`, dimColor: true}, `   ${harness.name} [${harness.support}]`)),
      ]),
    h(Text, {dimColor: true}, ' Skill Targets'),
    ...targets.slice(start, start + height).map((target, index) =>
      h(
        RowLine,
        {key: `target:${target.name}`, active: start + index === selected, focused},
        target.name,
      ),
    ),
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

function InfoPanel({
  row,
  info,
  membership,
  width,
}: {
  row?: Row;
  info?: SkillInfo;
  membership?: Membership;
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
  const tags = catalog.tags[row.id] ?? [];
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
    ...tags.map((tag, index) =>
      h(Text, {key: `tag-${tag}`, inverse: active('tags', index)},
        `${marker(active('tags', index))} ${tag}`)),
    h(Text, {key: 'tag-add', inverse: active('tags', tags.length)},
      `${marker(active('tags', tags.length))} + add tag`),
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
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [manage, setManage] = useState<ManageState | null>(null);
  const [batch, setBatch] = useState<{ marks: Set<string> } | null>(null);
  const [batchConfirm, setBatchConfirm] = useState<BatchConfirm | null>(null);
  const [batchTag, setBatchTag] = useState<{ action: 'add' | 'rm'; value: string } | null>(null);
  const [feedback, setFeedback] = useState('');

  const targets = snapshot.targets;
  const target = targets[Math.min(targetIndex, Math.max(0, targets.length - 1))];
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
  const targetWidth = Math.max(
    18,
    Math.min(32, Math.max(0, ...targets.map((a) => a.name.length)) + 6),
  );
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
  };

  useInput((input, key) => {
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
      const tags = snapshot.catalog.tags[row.id] ?? [];
      const presetNames = Object.keys(snapshot.catalog.presets)
        .sort((a, b) => a.localeCompare(b));
      const rowCount = (manage.section === 'tags' ? tags.length : presetNames.length) + 1;
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
        if (input === 'x' && !onActionRow && tags[manage.index] !== undefined) {
          const tag = tags[manage.index];
          try {
            prepareMutation();
            removeResourceTags(home, selector, [tag]);
            refresh({rowId: row.id});
            setFeedback(`Removed tag ${tag} from ${row.name}`);
          } catch (err) {
            setFeedback((err as Error).message);
          }
          return setManage({...manage, index: Math.min(manage.index, tags.length - 1)});
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
      if (input === 'i' || input === 'u' || input === 'r' || input === 'o' || input === 'c' || input === 'm')
        return setFeedback('exit batch mode first (v)');
    }
    if (input === 'v') return setBatch({marks: new Set()});
    if (input === 'm' && selectedRow?.realPath)
      return setManage({rowId: selectedRow.id, section: 'tags', index: 0});
    if (input === 'q' || (key.ctrl && input === 'c')) return exit();
    if (input === '/') return setSearching(true);
    if (input === 's')
      return setSort((value) => value === 'name' ? 'status' : value === 'status' ? 'source' : 'name');
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
      (input === 'r' || input === 'o' || input === 'c' || input === 'u')) {
      if (selectedRel.readOnly)
        return setFeedback(`read-only: inherited from ${selectedRel.scope}`);
      const kind = input === 'r'
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
    if (input === 'u' && actionable && selectedInfo?.linked && selectedRel) {
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
        ? ` space ${selectedInfo.underOff ? 'on' : 'off'}${selectedInfo.mirrored ? '  r sync  o overwrite  c convert  u remove' : selectedInfo.linked ? '  u unlink' : ''}`
        : selectedRow.realPath
          ? projectPath ? ' space on' : ' i link'
          : ''
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
    modal
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
              selected: targetIndex,
              focused: focusColumn === 0,
              width: targetWidth,
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
              ? h(InfoPanel, {
                  row: entry?.row,
                  info: entry?.relationship.info,
                  membership,
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
      modal
        ? ' ↑↓/jk scroll  PgUp/PgDn page  esc close '
        : manage
          ? ` ${feedback}${feedback ? '  ' : ''}j/k move  tab section  space toggle  a add  x rm tag  esc close `
        : batchConfirm
          ? ' y confirm  n/esc cancel '
        : batchTag
          ? ` tag ${batchTag.action === 'add' ? 'add' : 'rm'}: ${batchTag.value}`
        : batch
          ? ` ${feedback}${feedback ? '  ' : ''}v/esc exit  space mark  o on  O off  t tag  T untag  ${batch.marks.size} marked `
        : confirmation
          ? ' y confirm  n/esc cancel '
        : searching
          ? ` search: ${query || '…'}  enter apply  esc clear `
          : ` ${feedback}${feedback ? '  ' : ''}${tab}:${columnName}  ←→/hl  ↑↓/jk${actionHint}  enter SKILL.md  m manage  / search  s sort:${sortLabel(sort)}  R refresh  tab  q `,
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
