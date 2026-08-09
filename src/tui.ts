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
  tuiSnapshot,
  type Agent,
  type Row,
  type SkillInfo,
  type SortOrder,
  type SkillRelationship,
  type TuiSnapshot,
} from './view.ts';
import {
  applyActivationPlan,
  planLink,
  planToggle,
  planUnlink,
} from './reconcile.ts';
import {
  addPresetSelectors,
  addResourceTags,
  createPreset,
  removePresetSelectors,
  removeResourceTags,
} from './catalog.ts';

/** Below this width the passive summary column is hidden. */
const WIDE_MIN = 80;

type Tab = 'agent' | 'skill';

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

interface Confirmation {
  kind: 'link' | 'unlink';
  row: Row;
  agent: Agent;
  info?: SkillInfo;
  runtimeId: string;
  slot: string;
  source: string;
  target: string;
}

/** Existing relationships of one agent, in inventory order (absent skills excluded). */
function entriesFor(rows: Row[], agentName: string): RelEntry[] {
  return rows.flatMap((row) =>
    row.relationships
      .filter((relationship) => relationship.agent === agentName)
      .map((relationship) => ({
        row,
        relationship,
        key: relationship.info.path,
      })),
  );
}

/** Fixed-width status column so skill names align; deadlink gets '!' (red + target suffix carry the rest). */
function statusText(info: SkillInfo): string {
  const base = `${info.underOff ? '[ OFF ]' : '[ ON ]'} ${info.linked ? 'link' : 'local'}`;
  const text = info.presence === 'deadlink' ? `${base}!` : base;
  return text.padEnd('[ OFF ] local'.length);
}

function statusColor(info: SkillInfo): string {
  if (info.presence === 'deadlink') return 'red';
  return info.presence === 'on' ? 'green' : 'yellow';
}

function statusSortValue(info?: SkillInfo): string {
  if (!info) return '3:missing';
  const rank = info.presence === 'on' ? '0' : info.presence === 'off' ? '1' : '2';
  return `${rank}:${info.linked ? 'link' : 'local'}`;
}

function sortLabel(sort: SortOrder): string {
  return sort[0].toUpperCase() + sort.slice(1);
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
  wrap = 'truncate-end',
  children,
}: {
  active: boolean;
  focused: boolean;
  wrap?: 'truncate-end' | 'wrap';
  children?: ReactNode;
}): ReactNode {
  return h(
    Text,
    {inverse: active && focused, bold: active && !focused, wrap},
    `${active ? '›' : ' '} `,
    children,
  );
}

function AgentList({
  agents,
  selected,
  focused,
  width,
  height,
}: {
  agents: TuiSnapshot['agents'];
  selected: number;
  focused: boolean;
  width: number;
  height: number;
}): ReactNode {
  const start = windowStart(agents.length, selected, height);
  return h(
    ListColumn,
    {title: 'Agents', focused, width},
    ...agents.slice(start, start + height).map((agent, index) =>
      h(
        RowLine,
        {key: agent.name, active: start + index === selected, focused},
        agent.name,
      ),
    ),
  );
}

function RelationshipList({
  entries,
  selected,
  focused,
  height,
}: {
  entries: RelEntry[];
  selected: number;
  focused: boolean;
  height: number;
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
        {key: entry.key, active, focused},
        h(Text, {color: statusColor(info)}, statusText(info)),
        ' ',
        entry.relationship.name === entry.row.name
          ? entry.row.displayName
          : `${entry.relationship.name} → ${entry.row.displayName}`,
        info.presence === 'deadlink' && info.target
          ? h(Text, {dimColor: true}, ` -> ${info.target}`)
          : null,
      );
    }),
    entries.length === 0
      ? h(Text, {dimColor: true}, '  no skills for this agent')
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
}: {
  rows: Row[];
  selected: number;
  focused: boolean;
  width: number;
  height: number;
}): ReactNode {
  const start = windowStart(rows.length, selected, height);
  return h(
    ListColumn,
    {title: 'Skills', focused, width},
    ...rows.slice(start, start + height).map((row, index) =>
      h(
        RowLine,
        {key: row.id, active: start + index === selected, focused, wrap: 'wrap'},
        row.displayName,
      ),
    ),
    rows.length === 0
      ? h(Text, {dimColor: true}, '  no skills on disk')
      : null,
  );
}

/** Skill tab: every agent in registry order with its state for the selected instance. */
function AgentStatusList({
  agents,
  row,
  selected,
  focused,
  width,
  height,
}: {
  agents: TuiSnapshot['agents'];
  row?: Row;
  selected: number;
  focused: boolean;
  width: number;
  height: number;
}): ReactNode {
  const start = windowStart(agents.length, selected, height);
  return h(
    ListColumn,
    {title: 'Agents', focused, width},
    ...agents.slice(start, start + height).map((agent, index) => {
      const info = row?.agents[agent.name];
      return h(
        RowLine,
        {key: agent.name, active: start + index === selected, focused},
        `${agent.name}  `,
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
    h(Text, {bold: true}, `${confirmation.kind === 'link' ? 'Link' : 'Unlink'} relationship?`),
    h(Text, {wrap: 'wrap'}, ` ${confirmation.source} → ${confirmation.target}`),
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

export function App({home}: {home: Home}): ReactNode {
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

  const [snapshot, setSnapshot] = useState<TuiSnapshot>(() => tuiSnapshot(home));
  const [tab, setTab] = useState<Tab>('agent');
  const [focusColumn, setFocusColumn] = useState<0 | 1>(0);
  const [agentIndex, setAgentIndex] = useState(0);
  const [relationshipKey, setRelationshipKey] = useState<string>();
  // Skill-tab selection is tracked by instance id so tab switches keep identity.
  const [instanceId, setInstanceId] = useState<string>();
  const [instanceAgentIndex, setInstanceAgentIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<SortOrder>('name');
  const [modal, setModal] = useState<{row: Row; scroll: number} | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [manage, setManage] = useState<ManageState | null>(null);
  const [feedback, setFeedback] = useState('');

  const agents = snapshot.agents;
  const agent = agents[Math.min(agentIndex, Math.max(0, agents.length - 1))];
  const instAgent = Math.min(instanceAgentIndex, Math.max(0, agents.length - 1));
  const instanceAgent = agents[instAgent];
  const rows = useMemo(
    () => sortRows(
      searchRows(snapshot.rows, query),
      sort,
      (row) => statusSortValue(row.agents[(tab === 'agent' ? agent : instanceAgent)?.name ?? '']),
    ),
    [snapshot.rows, query, sort, tab, agent, instanceAgent],
  );
  const entries = useMemo(
    () => (agent ? entriesFor(rows, agent.name) : []),
    [rows, agent],
  );
  const relationshipFound = entries.findIndex((entry) => entry.key === relationshipKey);
  const relationshipIndex = relationshipFound === -1 ? 0 : relationshipFound;
  const entry = entries[relationshipIndex];

  const found = rows.findIndex((row) => row.id === instanceId);
  const instanceIndex = found === -1 ? 0 : found; // deterministic fallback: first row
  const instance = rows[instanceIndex];

  const wide = width >= WIDE_MIN;
  const bodyHeight = Math.max(3, height - 2);
  const listHeight = Math.max(1, bodyHeight - 3);
  const agentWidth = Math.max(
    18,
    Math.min(32, Math.max(0, ...agents.map((a) => a.name.length)) + 6),
  );
  const agentStatusWidth = Math.max(
    28,
    Math.min(40, Math.max(0, ...agents.map((agent) => agent.name.length)) + 24),
  );
  // Info is capped (its text wraps); name lists flex with what remains (long names win).
  const infoWidth = wide ? Math.max(28, Math.min(48, Math.floor(width * 0.28))) : 0;
  const instanceWidth = Math.max(
    10,
    width - agentStatusWidth - infoWidth,
  );
  const modalContent = modal
    ? (skillDetail(home, modal.row.id)?.content ?? 'SKILL.md unavailable')
    : '';
  const modalLines = modal ? detailLines(modalContent, Math.max(1, width - 8)) : [];
  const modalPage = Math.max(1, height - 6);

  const selectedRow = tab === 'agent' ? entry?.row : instance;
  const selectedAgent = tab === 'agent' ? agent : agents[instAgent];
  const selectedInfo = tab === 'agent'
    ? entry?.relationship.info
    : selectedRow?.agents[selectedAgent?.name ?? ''];
  const selectedRel = tab === 'agent'
    ? entry?.relationship
    : selectedRow?.relationships.find((relationship) =>
        relationship.agent === selectedAgent?.name &&
        relationship.info.path === selectedInfo?.path);
  const actionable = focusColumn === 1 && selectedRow && selectedAgent;
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
   *  the fresh row/relationship by (runtimeId, slot) or stable row id. */
  const refresh = (keep?: { rowId?: string; runtimeId?: string; slot?: string }) => {
    const next = tuiSnapshot(home);
    setSnapshot(next);
    if (!keep) return;
    const row = keep.rowId !== undefined
      ? next.rows.find((candidate) => candidate.id === keep.rowId)
      : next.rows.find((candidate) => candidate.relationships.some((rel) =>
          rel.runtimeId === keep.runtimeId && rel.slot === keep.slot));
    if (row) setInstanceId(row.id);
    const rel = keep.runtimeId !== undefined
      ? row?.relationships.find((candidate) =>
          candidate.runtimeId === keep.runtimeId && candidate.slot === keep.slot)
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
    if (confirmation) {
      if (input === 'y') {
        const neighbor = tab === 'agent'
          ? entries[relationshipIndex + 1] ?? entries[relationshipIndex - 1]
          : undefined;
        try {
          if (confirmation.kind === 'link') {
            applyActivationPlan(home, planLink(home, confirmation.row.id, confirmation.agent.name));
          } else {
            applyActivationPlan(home, planUnlink(home, confirmation.runtimeId, confirmation.slot));
          }
          refresh({rowId: confirmation.row.id});
          if (neighbor) setRelationshipKey(neighbor.key);
          setFeedback(`${confirmation.kind === 'link' ? 'Linked' : 'Unlinked'} ${confirmation.row.name} @ ${confirmation.agent.name}`);
        } catch (err) {
          setFeedback((err as Error).message);
        }
        return setConfirmation(null);
      }
      if (input === 'n' || key.escape) return setConfirmation(null);
      return;
    }
    if (input === 'm' && selectedRow?.realPath)
      return setManage({rowId: selectedRow.id, section: 'tags', index: 0});
    if (input === 'q' || (key.ctrl && input === 'c')) return exit();
    if (input === '/') return setSearching(true);
    if (input === 's')
      return setSort((value) => value === 'name' ? 'status' : value === 'status' ? 'source' : 'name');
    if (input === 'R') {
      const currentAgent = agent?.name;
      const currentInstanceAgent = instanceAgent?.name;
      const next = tuiSnapshot(home);
      setSnapshot(next);
      setAgentIndex(Math.max(0, next.agents.findIndex(({name}) => name === currentAgent)));
      setInstanceAgentIndex(Math.max(0, next.agents.findIndex(({name}) => name === currentInstanceAgent)));
      return;
    }
    if (key.tab) return setTab((value) => (value === 'agent' ? 'skill' : 'agent'));
    if (key.rightArrow || input === 'l') return setFocusColumn(1);
    if (key.leftArrow || input === 'h') return setFocusColumn(0);
    if (key.downArrow || input === 'j') {
      if (tab === 'agent') {
        if (focusColumn === 0)
          setAgentIndex((value) => Math.min(Math.max(0, agents.length - 1), value + 1));
        else {
          const next = entries[Math.min(entries.length - 1, relationshipIndex + 1)];
          if (next) setRelationshipKey(next.key);
        }
      } else if (focusColumn === 0) {
        const next = rows[Math.min(rows.length - 1, instanceIndex + 1)];
        if (next) setInstanceId(next.id);
      } else {
        setInstanceAgentIndex((value) => Math.min(Math.max(0, agents.length - 1), value + 1));
      }
      return;
    }
    if (key.upArrow || input === 'k') {
      if (tab === 'agent') {
        if (focusColumn === 0) setAgentIndex((value) => Math.max(0, value - 1));
        else {
          const next = entries[Math.max(0, relationshipIndex - 1)];
          if (next) setRelationshipKey(next.key);
        }
      } else if (focusColumn === 0) {
        const next = rows[Math.max(0, instanceIndex - 1)];
        if (next) setInstanceId(next.id);
      } else {
        setInstanceAgentIndex((value) => Math.max(0, value - 1));
      }
      return;
    }
    if (input === ' ' && actionable && selectedInfo && selectedRel) {
      try {
        applyActivationPlan(home, planToggle(home, selectedRel.runtimeId, selectedRel.slot));
        refresh({runtimeId: selectedRel.runtimeId, slot: selectedRel.slot});
        setFeedback(`${selectedRow.name} @ ${selectedAgent.name}: ${selectedInfo.underOff ? 'on' : 'off'}`);
      } catch (err) {
        setFeedback((err as Error).message);
      }
      return;
    }
    if (input === 'i' && actionable && !selectedInfo) {
      if (!selectedRow.realPath) return setFeedback('Link unavailable: selected skill has no directory');
      return setConfirmation({
        kind: 'link',
        row: selectedRow,
        agent: selectedAgent,
        runtimeId: '',
        slot: '',
        source: selectedRow.realPath,
        target: path.join(selectedAgent.dir, selectedRow.name),
      });
    }
    if (input === 'u' && actionable && selectedInfo?.linked && selectedRel) {
      return setConfirmation({
        kind: 'unlink',
        row: selectedRow,
        agent: selectedAgent,
        info: selectedInfo,
        runtimeId: selectedRel.runtimeId,
        slot: selectedRel.slot,
        source: selectedInfo.path,
        target: selectedInfo.target ?? '?',
      });
    }
    if (key.return) {
      const row = tab === 'agent' ? entry?.row : instance;
      if (row) setModal({row, scroll: 0});
    }
  });

  const columnName =
    tab === 'agent'
      ? focusColumn === 0
        ? 'agents'
        : 'relationships'
      : focusColumn === 0
        ? 'skills'
        : 'agents';
  const actionHint = actionable
    ? selectedInfo
      ? ` space ${selectedInfo.underOff ? 'on' : 'off'}${selectedInfo.linked ? '  u unlink' : ''}`
      : selectedRow.realPath
        ? ' i link'
        : ''
    : '';

  return h(
    Box,
    {flexDirection: 'column', width, height},
    h(
      Text,
      null,
      h(Text, {inverse: tab === 'agent'}, ' Agent '),
      ' ',
      h(Text, {inverse: tab === 'skill'}, ' Skill '),
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
      : confirmation
        ? h(
            Box,
            {height: bodyHeight, paddingLeft: 2, paddingRight: 2, paddingTop: 1},
            h(ConfirmationModal, {confirmation}),
          )
      : tab === 'agent'
        ? h(
            Box,
            {height: bodyHeight},
            h(AgentList, {
              agents,
              selected: agentIndex,
              focused: focusColumn === 0,
              width: agentWidth,
              height: listHeight,
            }),
            h(RelationshipList, {
              entries,
              selected: relationshipIndex,
              focused: focusColumn === 1,
              height: listHeight,
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
            }),
            wide
              ? h(InfoPanel, {
                  row: instance,
                  info: instance?.agents[agents[instAgent]?.name ?? ''],
                  membership,
                  width: infoWidth,
                })
              : null,
            h(AgentStatusList, {
              agents,
              row: instance,
              selected: instAgent,
              focused: focusColumn === 1,
              width: agentStatusWidth,
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
          : confirmation
            ? ' y confirm  n/esc cancel '
            : searching
            ? ` search: ${query || '…'}  enter apply  esc clear `
            : ` ${feedback}${feedback ? '  ' : ''}${tab}:${columnName}  ←→/hl  ↑↓/jk${actionHint}  enter SKILL.md  m manage  / search  s sort:${sortLabel(sort)}  R refresh  tab  q `,
    ),
  );
}

export async function runTui(home: Home = defaultHome()): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('skillspub tui requires an interactive terminal');
  }
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
  try {
    const app = render(h(App, {home}), {exitOnCtrlC: false, patchConsole: false});
    await app.waitUntilExit();
  } finally {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
}
