import {createElement as h, useEffect, useMemo, useState} from 'react';
import type {ReactNode} from 'react';
import {Box, Text, render, useApp, useInput} from 'ink';
import {
  defaultHome,
  skillDetail,
  toggleSkill,
  tuiSnapshot,
  type Agent,
  type Home,
  type Presence,
  type Row,
  type SkillDetail,
  type SkillInfo,
  type TuiSnapshot,
} from './core.ts';

const CELL: Record<Presence, {mark: string; color: string}> = {
  on: {mark: '●', color: 'green'},
  off: {mark: '○', color: 'yellow'},
  deadlink: {mark: '!', color: 'red'},
};

function useTerminalSize(): {width: number; height: number} {
  const read = () => ({
    width: process.stdout.columns ?? 100,
    height: process.stdout.rows ?? 30,
  });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const resize = () => setSize(read());
    process.stdout.on('resize', resize);
    return () => {
      process.stdout.off('resize', resize);
    };
  }, []);
  return size;
}

function Indicator({info}: {info?: SkillInfo}): ReactNode {
  if (!info) return h(Text, {dimColor: true}, '·');
  const cell = CELL[info.presence];
  return h(Text, {color: cell.color}, cell.mark);
}

function SkillList({
  rows,
  agents,
  selected,
  selectedAgent,
  width,
  height,
}: {
  rows: Row[];
  agents: Agent[];
  selected: number;
  selectedAgent: number;
  width: number;
  height: number;
}): ReactNode {
  const columnWidths = agents.map((agent) => Math.max(3, agent.name.length + 1));
  const nameWidth = Math.max(8, width - columnWidths.reduce((a, b) => a + b, 0) - 3);
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), rows.length - height));
  const visible = rows.slice(start, start + height);

  return h(
    Box,
    {flexDirection: 'column', width},
    h(
      Box,
      null,
      h(Text, {bold: true, color: 'cyan', wrap: 'truncate-end'}, 'skill'.padEnd(nameWidth)),
      ...agents.map((agent, index) =>
        h(
          Text,
          {
            key: agent.name,
            bold: index === selectedAgent,
            color: index === selectedAgent ? 'cyan' : undefined,
            wrap: 'truncate-end',
          },
          agent.name.padEnd(columnWidths[index]),
        ),
      ),
    ),
    ...visible.map((row, visibleIndex) => {
      const active = start + visibleIndex === selected;
      return h(
        Box,
        {key: row.name},
        h(
          Text,
          {inverse: active, bold: active, wrap: 'truncate-end'},
          `${active ? '›' : ' '} ${row.name}`.padEnd(nameWidth),
        ),
        ...agents.map((agent, index) =>
          h(
            Box,
            {key: agent.name, width: columnWidths[index]},
            h(Indicator, {info: row.agents[agent.name]}),
          ),
        ),
      );
    }),
    rows.length === 0 ? h(Text, {dimColor: true}, '  no matching skills') : null,
  );
}

function stateLabel(info?: SkillInfo): string {
  if (!info) return '—';
  if (info.presence === 'deadlink') return info.underOff ? 'deadlink (.off)' : 'deadlink';
  return info.presence;
}

function DetailPane({
  detail,
  agents,
  selectedAgent,
  scroll,
  height,
}: {
  detail?: SkillDetail;
  agents: Agent[];
  selectedAgent: number;
  scroll: number;
  height: number;
}): ReactNode {
  if (!detail) return h(Text, {dimColor: true}, 'Select a skill');
  const content = (detail.content ?? 'SKILL.md unavailable').split('\n');
  const metadataHeight = 9 + detail.realPaths.length + agents.length;
  const contentHeight = Math.max(3, height - metadataHeight);
  const visible = content.slice(scroll, scroll + contentHeight);

  return h(
    Box,
    {flexDirection: 'column', flexGrow: 1, paddingLeft: 1},
    h(Text, {bold: true, color: 'cyan'}, detail.name),
    h(
      Box,
      null,
      h(Text, {bold: true}, 'State: '),
      ...agents.flatMap((agent, index) => [
        h(Text, {key: `${agent.name}-name`, bold: index === selectedAgent, color: index === selectedAgent ? 'cyan' : undefined}, `${agent.name}=`),
        h(Indicator, {key: `${agent.name}-state`, info: detail.agents[agent.name]}),
        h(Text, {key: `${agent.name}-space`}, '  '),
      ]),
    ),
    h(Text, null, h(Text, {bold: true}, 'Source / author: '), detail.source ?? 'unknown'),
    h(Text, null, h(Text, {bold: true}, 'Bundles: '), detail.bundles.join(', ') || '—'),
    h(Text, null, h(Text, {bold: true}, 'Tags: '), detail.tags.join(', ') || '—'),
    h(Text, {bold: true}, 'Resolved install path(s):'),
    ...(detail.realPaths.length > 0
      ? detail.realPaths.map((realPath) => h(Text, {key: realPath, wrap: 'truncate-end'}, `  ${realPath}`))
      : [h(Text, {key: 'none', dimColor: true}, '  unavailable')]),
    h(Text, {bold: true}, 'Agent roots / links:'),
    ...agents.map((agent) => {
      const info = detail.agents[agent.name];
      const suffix = info?.linked && info.realPath ? ` -> ${info.realPath}` : '';
      return h(
        Text,
        {key: agent.name, wrap: 'truncate-end'},
        `  ${agent.name}: ${stateLabel(info)}  ${info?.path ?? agent.dir}${suffix}`,
      );
    }),
    h(
      Text,
      {bold: true},
      `SKILL.md${detail.contentPath ? ` — ${detail.contentPath}` : ''}  [${Math.min(scroll + 1, content.length)}/${content.length}]`,
    ),
    h(
      Box,
      {flexDirection: 'column', flexGrow: 1, overflow: 'hidden'},
      ...visible.map((line, index) => h(Text, {key: scroll + index, wrap: 'truncate-end'}, line || ' ')),
    ),
  );
}

function App({home}: {home: Home}): ReactNode {
  const {exit} = useApp();
  const {width, height} = useTerminalSize();
  const [snapshot, setSnapshot] = useState<TuiSnapshot>(() => tuiSnapshot(home));
  const [selected, setSelected] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [message, setMessage] = useState('');

  const rows = useMemo(() => {
    const needle = query.toLowerCase();
    return snapshot.rows.filter((row) => row.name.toLowerCase().includes(needle));
  }, [query, snapshot]);
  const row = rows[selected];
  const detail = useMemo(
    () => row ? skillDetail(home, snapshot.agents, row.name) : undefined,
    [home, row, snapshot.agents],
  );
  const leftWidth = Math.max(30, Math.floor(width * 0.43));
  const bodyHeight = Math.max(6, height - 3);
  const contentLines = (detail?.content ?? 'SKILL.md unavailable').split('\n').length;
  let searchStatus = ' ';
  if (searching) searchStatus = `/${query}▌`;
  else if (query) searchStatus = `filter: ${query}`;

  useEffect(() => {
    if (selected >= rows.length) setSelected(Math.max(0, rows.length - 1));
  }, [rows.length, selected]);
  useEffect(() => setScroll(0), [row?.name]);
  useEffect(() => {
    if (scroll >= contentLines) setScroll(Math.max(0, contentLines - 1));
  }, [contentLines, scroll]);

  useInput((input, key) => {
    if (searching) {
      if (key.escape || key.return) setSearching(false);
      else if (key.backspace || key.delete) setQuery((value) => value.slice(0, -1));
      else if (key.ctrl && input === 'u') setQuery('');
      else if (!key.ctrl && !key.meta && input) setQuery((value) => value + input);
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) return exit();
    if (input === '/') return setSearching(true);
    if (key.escape) {
      setQuery('');
      setMessage('');
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelected((value) => Math.min(Math.max(0, rows.length - 1), value + 1));
      return;
    }
    if (key.upArrow || input === 'k') {
      setSelected((value) => Math.max(0, value - 1));
      return;
    }
    if (key.home) return setSelected(0);
    if (key.end) return setSelected(Math.max(0, rows.length - 1));
    if (key.tab || key.rightArrow || input === 'l') {
      if (snapshot.agents.length > 0)
        setSelectedAgent((value) => (value + 1) % snapshot.agents.length);
      return;
    }
    if (key.leftArrow || input === 'h') {
      if (snapshot.agents.length > 0)
        setSelectedAgent((value) => (value - 1 + snapshot.agents.length) % snapshot.agents.length);
      return;
    }
    if (key.pageDown || (key.ctrl && input === 'd')) {
      setScroll((value) =>
        Math.min(contentLines - 1, value + Math.max(1, Math.floor(bodyHeight / 2))),
      );
      return;
    }
    if (key.pageUp || (key.ctrl && input === 'u')) {
      setScroll((value) => Math.max(0, value - Math.max(1, Math.floor(bodyHeight / 2))));
      return;
    }
    if ((input === ' ' || key.return) && row) {
      const agent = snapshot.agents[selectedAgent];
      if (!agent) return;
      try {
        const result = toggleSkill(agent, row.name);
        setSnapshot(tuiSnapshot(home));
        setMessage(`${row.name} @ ${agent.name}: ${result}`);
      } catch (error) {
        setMessage((error as Error).message);
      }
    }
  });

  return h(
    Box,
    {flexDirection: 'column', width, height},
    h(
      Box,
      {height: bodyHeight},
      h(SkillList, {
        rows,
        agents: snapshot.agents,
        selected,
        selectedAgent,
        width: leftWidth,
        height: bodyHeight - 1,
      }),
      h(Box, {borderStyle: 'single', borderTop: false, borderBottom: false, borderRight: false}),
      h(DetailPane, {detail, agents: snapshot.agents, selectedAgent, scroll, height: bodyHeight}),
    ),
    h(Text, {color: searching ? 'cyan' : undefined}, searchStatus),
    h(
      Text,
      {inverse: true, wrap: 'truncate-end'},
      message || ' ↑↓/jk skill  ←→/hl/tab agent  space/enter toggle  / search  PgUp/PgDn detail  q quit ',
    ),
  );
}

export async function runTui(home: Home = defaultHome()): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('skm tui requires an interactive terminal');
  }
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
  try {
    const app = render(h(App, {home}), {exitOnCtrlC: false, patchConsole: false});
    await app.waitUntilExit();
  } finally {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
}
