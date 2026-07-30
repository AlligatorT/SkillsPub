import {createElement as h, useEffect, useMemo, useState} from 'react';
import type {ReactNode} from 'react';
import {Box, Text, render, useApp, useInput, useStdout} from 'ink';
import {
  defaultHome,
  skillDetail,
  tuiSnapshot,
  type Home,
  type Row,
  type SkillInfo,
  type SkillRelationship,
  type TuiSnapshot,
} from './core.ts';

/** Below this width the passive summary column is hidden. */
const WIDE_MIN = 80;

type Tab = 'agent' | 'skill';

interface RelEntry {
  row: Row;
  relationship: SkillRelationship;
  key: string;
}

/** Existing relationships of one agent, in inventory order (absent skills excluded). */
function entriesFor(rows: Row[], agentName: string): RelEntry[] {
  return rows.flatMap((row) =>
    row.relationships
      .filter((relationship) => relationship.agent === agentName)
      .map((relationship) => ({
        row,
        relationship,
        key: `${row.id}${relationship.name}`,
      })),
  );
}

function statusText(info: SkillInfo): string {
  if (info.presence === 'deadlink') return 'broken';
  const state = info.presence === 'on' ? '[ ON ]' : '[ OFF ]';
  return `${state} ${info.linked ? 'link' : 'local'}`;
}

function statusColor(info: SkillInfo): string {
  if (info.presence === 'deadlink') return 'red';
  return info.presence === 'on' ? 'green' : 'yellow';
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
  children,
}: {
  active: boolean;
  focused: boolean;
  children?: ReactNode;
}): ReactNode {
  return h(
    Text,
    {inverse: active && focused, wrap: 'truncate-end'},
    `${active && focused ? '›' : ' '} `,
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
        entry.row.displayName,
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
        {key: row.id, active: start + index === selected, focused},
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
  height,
}: {
  agents: TuiSnapshot['agents'];
  row?: Row;
  selected: number;
  focused: boolean;
  height: number;
}): ReactNode {
  const start = windowStart(agents.length, selected, height);
  return h(
    ListColumn,
    {title: 'Agents', focused, flexGrow: 1},
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

function Summary({
  row,
  info,
  width,
}: {
  row?: Row;
  info?: SkillInfo;
  width: number;
}): ReactNode {
  return h(
    ListColumn,
    {title: 'Summary', focused: false, width},
    !row
      ? h(Text, {dimColor: true}, '  nothing selected')
      : [
          h(Text, {key: 'name', bold: true, wrap: 'truncate-end'}, ` ${row.displayName}`),
          h(Text, {key: 'desc', wrap: 'truncate-end'}, ` ${row.description ?? '—'}`),
          h(Text, {key: 'source', wrap: 'truncate-end'}, ` Source: ${row.sourceLabel}`),
          h(
            Text,
            {key: 'path', wrap: 'truncate-end', dimColor: info?.presence === 'deadlink'},
            ` ${row.realPath ?? (info ? `${info.path}${info.target ? ` -> ${info.target}` : ''}` : '—')}`,
          ),
        ],
  );
}

function DetailModal({
  row,
  content,
  scroll,
  height,
}: {
  row: Row;
  content: string;
  scroll: number;
  height: number;
}): ReactNode {
  const lines = content.split('\n');
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

  const [snapshot] = useState<TuiSnapshot>(() => tuiSnapshot(home));
  const [tab, setTab] = useState<Tab>('agent');
  const [focusColumn, setFocusColumn] = useState<0 | 1>(0);
  const [agentIndex, setAgentIndex] = useState(0);
  const [skillIndex, setSkillIndex] = useState(0);
  // Skill-tab selection is tracked by instance id so tab switches keep identity.
  const [instanceId, setInstanceId] = useState<string>();
  const [instanceAgentIndex, setInstanceAgentIndex] = useState(0);
  const [modal, setModal] = useState<{row: Row; scroll: number} | null>(null);

  const agents = snapshot.agents;
  const rows = snapshot.rows;
  const agent = agents[Math.min(agentIndex, Math.max(0, agents.length - 1))];
  const entries = useMemo(
    () => (agent ? entriesFor(rows, agent.name) : []),
    [rows, agent],
  );
  const skill = Math.min(skillIndex, Math.max(0, entries.length - 1));
  const entry = entries[skill];

  const found = rows.findIndex((row) => row.id === instanceId);
  const instanceIndex = found === -1 ? 0 : found; // deterministic fallback: first row
  const instance = rows[instanceIndex];
  const instAgent = Math.min(instanceAgentIndex, Math.max(0, agents.length - 1));

  const wide = width >= WIDE_MIN;
  const bodyHeight = Math.max(3, height - 2);
  const listHeight = Math.max(1, bodyHeight - 3);
  const agentWidth = Math.max(
    10,
    Math.min(24, Math.max(0, ...agents.map((a) => a.name.length)) + 6),
  );
  const instanceWidth = Math.max(
    10,
    Math.min(36, Math.max(0, ...rows.map((row) => row.displayName.length)) + 4),
  );
  const summaryWidth = Math.max(24, Math.floor(width * 0.3));
  const modalContent = modal
    ? (skillDetail(home, agents, modal.row.id)?.content ?? 'SKILL.md unavailable')
    : '';
  const modalLines = modal ? modalContent.split('\n').length : 0;
  const modalPage = Math.max(1, height - 6);

  useEffect(() => setSkillIndex(0), [agent?.name]);

  useInput((input, key) => {
    if (modal) {
      if (key.escape) return setModal(null);
      if (key.downArrow || input === 'j')
        return setModal({...modal, scroll: Math.min(modalLines - 1, modal.scroll + 1)});
      if (key.upArrow || input === 'k')
        return setModal({...modal, scroll: Math.max(0, modal.scroll - 1)});
      if (key.pageDown || (key.ctrl && input === 'd'))
        return setModal({...modal, scroll: Math.min(modalLines - 1, modal.scroll + modalPage)});
      if (key.pageUp || (key.ctrl && input === 'u'))
        return setModal({...modal, scroll: Math.max(0, modal.scroll - modalPage)});
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) return exit();
    if (key.tab) return setTab((value) => (value === 'agent' ? 'skill' : 'agent'));
    if (key.rightArrow || input === 'l') return setFocusColumn(1);
    if (key.leftArrow || input === 'h') return setFocusColumn(0);
    if (key.downArrow || input === 'j') {
      if (tab === 'agent') {
        if (focusColumn === 0)
          setAgentIndex((value) => Math.min(Math.max(0, agents.length - 1), value + 1));
        else setSkillIndex((value) => Math.min(Math.max(0, entries.length - 1), value + 1));
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
        else setSkillIndex((value) => Math.max(0, value - 1));
      } else if (focusColumn === 0) {
        const next = rows[Math.max(0, instanceIndex - 1)];
        if (next) setInstanceId(next.id);
      } else {
        setInstanceAgentIndex((value) => Math.max(0, value - 1));
      }
      return;
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

  return h(
    Box,
    {flexDirection: 'column', width, height},
    h(
      Text,
      null,
      h(Text, {inverse: tab === 'agent'}, ' Agent '),
      ' ',
      h(Text, {inverse: tab === 'skill'}, ' Skill '),
    ),
    modal
      ? h(
          Box,
          {height: bodyHeight, paddingLeft: 2, paddingRight: 2, paddingTop: 1},
          h(DetailModal, {row: modal.row, content: modalContent, scroll: modal.scroll, height}),
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
              selected: skill,
              focused: focusColumn === 1,
              height: listHeight,
            }),
            wide ? h(Summary, {row: entry?.row, info: entry?.relationship.info, width: summaryWidth}) : null,
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
            h(AgentStatusList, {
              agents,
              row: instance,
              selected: instAgent,
              focused: focusColumn === 1,
              height: listHeight,
            }),
            wide
              ? h(Summary, {
                  row: instance,
                  info: instance?.agents[agents[instAgent]?.name ?? ''],
                  width: summaryWidth,
                })
              : null,
          ),
    h(
      Text,
      {inverse: true, wrap: 'truncate-end'},
      modal
        ? ' ↑↓/jk scroll  PgUp/PgDn page  esc close '
        : ` ${tab}:${columnName}  ←→/hl column  ↑↓/jk select  enter SKILL.md  tab switch  q quit `,
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
