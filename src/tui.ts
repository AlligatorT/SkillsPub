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

function Summary({entry, width}: {entry?: RelEntry; width: number}): ReactNode {
  const info = entry?.relationship.info;
  return h(
    ListColumn,
    {title: 'Summary', focused: false, width},
    !entry || !info
      ? h(Text, {dimColor: true}, '  nothing selected')
      : [
          h(Text, {key: 'name', bold: true, wrap: 'truncate-end'}, ` ${entry.row.displayName}`),
          h(Text, {key: 'desc', wrap: 'truncate-end'}, ` ${entry.row.description ?? '—'}`),
          h(Text, {key: 'source', wrap: 'truncate-end'}, ` Source: ${entry.row.sourceLabel}`),
          h(
            Text,
            {key: 'path', wrap: 'truncate-end', dimColor: info.presence === 'deadlink'},
            ` ${entry.row.realPath ?? `${info.path}${info.target ? ` -> ${info.target}` : ''}`}`,
          ),
        ],
  );
}

function DetailModal({
  entry,
  content,
  scroll,
  height,
}: {
  entry: RelEntry;
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
      `SKILL.md — ${entry.row.displayName}  [${Math.min(scroll + 1, lines.length)}/${lines.length}]`,
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
  const [focusColumn, setFocusColumn] = useState<0 | 1>(0);
  const [agentIndex, setAgentIndex] = useState(0);
  const [skillIndex, setSkillIndex] = useState(0);
  const [modal, setModal] = useState<{entry: RelEntry; scroll: number} | null>(null);

  const agents = snapshot.agents;
  const agent = agents[Math.min(agentIndex, Math.max(0, agents.length - 1))];
  const entries = useMemo(
    () => (agent ? entriesFor(snapshot.rows, agent.name) : []),
    [snapshot.rows, agent],
  );
  const skill = Math.min(skillIndex, Math.max(0, entries.length - 1));
  const entry = entries[skill];

  const wide = width >= WIDE_MIN;
  const bodyHeight = Math.max(3, height - 2);
  const listHeight = Math.max(1, bodyHeight - 3);
  const agentWidth = Math.max(
    10,
    Math.min(24, Math.max(0, ...agents.map((a) => a.name.length)) + 6),
  );
  const summaryWidth = Math.max(24, Math.floor(width * 0.3));
  const modalContent = modal
    ? (skillDetail(home, agents, modal.entry.row.id)?.content ?? 'SKILL.md unavailable')
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
    if (key.rightArrow || input === 'l') return setFocusColumn(1);
    if (key.leftArrow || input === 'h') return setFocusColumn(0);
    if (key.downArrow || input === 'j') {
      if (focusColumn === 0)
        setAgentIndex((value) => Math.min(Math.max(0, agents.length - 1), value + 1));
      else setSkillIndex((value) => Math.min(Math.max(0, entries.length - 1), value + 1));
      return;
    }
    if (key.upArrow || input === 'k') {
      if (focusColumn === 0) setAgentIndex((value) => Math.max(0, value - 1));
      else setSkillIndex((value) => Math.max(0, value - 1));
      return;
    }
    if (key.return && entry) setModal({entry, scroll: 0});
  });

  return h(
    Box,
    {flexDirection: 'column', width, height},
    h(Text, null, h(Text, {inverse: true}, ' Agent ')),
    modal
      ? h(
          Box,
          {height: bodyHeight, paddingLeft: 2, paddingRight: 2, paddingTop: 1},
          h(DetailModal, {entry: modal.entry, content: modalContent, scroll: modal.scroll, height}),
        )
      : h(
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
          wide ? h(Summary, {entry, width: summaryWidth}) : null,
        ),
    h(
      Text,
      {inverse: true, wrap: 'truncate-end'},
      modal
        ? ' ↑↓/jk scroll  PgUp/PgDn page  esc close '
        : ' ←→/hl column  ↑↓/jk select  enter SKILL.md  q quit ',
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
