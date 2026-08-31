// THROWAWAY PROTOTYPE: three terminal Source-lifecycle variants, switched with ←/→ or 1/2/3.
// Run: npm run prototype:source
// Question: which interaction and information architecture makes Global/Project Source operations safe and understandable?
// biome-ignore-all lint/style/noNestedTernary: compact throwaway render-state selection is intentional.

import assert from 'node:assert/strict';
import {createElement as h, useEffect, useMemo, useState} from 'react';
import type {ReactNode} from 'react';
import {Box, Text, render, useApp, useInput, useStdout} from 'ink';

const VARIANTS = [
  {key: 'A', name: 'Guided rail', tests: 'sequential teaching, explicit boundaries, one recommended next action'},
  {key: 'B', name: 'Operations workbench', tests: 'persistent three-pane context, direct manipulation, batch safety'},
  {key: 'C', name: 'Audit timeline', tests: 'command-first speed, provenance ledger, failure/retry trace'},
] as const;

const PROJECT_PATH = process.cwd();
const GLOBAL_PATH = '~/.agents/skills';

type Scope = 'global' | 'project';
type Surface = 'catalog' | 'inventory';
type UpdateState = 'unknown' | 'current' | 'available' | 'check-failed' | 'upstream-missing';
type DriftState = 'none' | 'activation' | 'mirror-sync';
type OperationKind = 'add' | 'refresh' | 'update' | 'batch-update' | 'remove';
type Tone = 'cyan' | 'green' | 'yellow' | 'red' | 'magenta' | 'gray';

interface Candidate {
  key: string;
  name: string;
  source: string;
  skillPath: string;
  description: string;
  installs: string;
  detailUrl: string;
}

interface Relationship {
  target: string;
  form: 'local' | 'link' | 'mirror';
  activation: 'ON' | 'OFF';
  path: string;
}

interface Installed {
  id: string;
  scope: Scope;
  name: string;
  source: string;
  skillPath: string;
  actual: 'ON' | 'OFF';
  desired: 'ON' | 'OFF';
  drift: DriftState;
  update: UpdateState;
  checkedAt?: string;
  error?: string;
  relationships: Relationship[];
}

interface Plan {
  kind: Exclude<OperationKind, 'refresh'>;
  title: string;
  scope: Scope;
  lines: string[];
  confirmations: string[];
  confirmIndex: number;
  resourceIds: string[];
  candidateKey?: string;
  replaceId?: string;
}

interface Operation {
  kind: OperationKind;
  title: string;
  scope: Scope;
  steps: string[];
  index: number;
  status: 'running' | 'failed' | 'done';
  resourceIds: string[];
  candidateKey?: string;
  replaceId?: string;
  failAt?: number;
  error?: string;
  result?: string[];
}

interface Result {
  title: string;
  scope: Scope;
  lines: string[];
}

interface AuditEvent {
  id: number;
  scope: Scope | 'both';
  label: string;
  tone: Tone;
}

const CANDIDATES: Candidate[] = [
  {
    key: 'acme/ops-skills#release-notes',
    name: 'release-notes',
    source: 'acme/ops-skills',
    skillPath: 'skills/release-notes',
    description: 'Draft release notes from merged work and issue context.',
    installs: '9.6k',
    detailUrl: 'https://skills.sh/acme/ops-skills/release-notes',
  },
  {
    key: 'orbit/product-skills#release-notes',
    name: 'release-notes',
    source: 'orbit/product-skills',
    skillPath: 'release/release-notes',
    description: 'A product-led release narrative workflow with launch checks.',
    installs: '2.1k',
    detailUrl: 'https://skills.sh/orbit/product-skills/release-notes',
  },
  {
    key: 'graph-labs/agent-skills#dependency-map',
    name: 'dependency-map',
    source: 'graph-labs/agent-skills',
    skillPath: 'skills/dependency-map',
    description: 'Map package, service, and ownership dependencies before a change.',
    installs: '6.4k',
    detailUrl: 'https://skills.sh/graph-labs/agent-skills/dependency-map',
  },
  {
    key: 'inclusive-dev/skills#accessibility-audit',
    name: 'accessibility-audit',
    source: 'inclusive-dev/skills',
    skillPath: 'web/accessibility-audit',
    description: 'Run a focused accessibility review with reproducible findings.',
    installs: '12.8k',
    detailUrl: 'https://skills.sh/inclusive-dev/skills/accessibility-audit',
  },
];

function initialInstalled(projectPath: string): Installed[] {
  return [
    {
      id: 'global:release-notes',
      scope: 'global',
      name: 'release-notes',
      source: 'acme/ops-skills',
      skillPath: 'skills/release-notes',
      actual: 'ON',
      desired: 'ON',
      drift: 'none',
      update: 'available',
      checkedAt: '18m ago',
      relationships: [
        {target: 'Shared · Global', form: 'local', activation: 'ON', path: '~/.agents/skills/release-notes'},
        {target: 'Pi · Global', form: 'link', activation: 'ON', path: '~/.pi/agent/skills/release-notes'},
        {target: 'Claude Code · Global', form: 'link', activation: 'ON', path: '~/.claude/skills/release-notes'},
      ],
    },
    {
      id: 'global:accessibility-audit',
      scope: 'global',
      name: 'accessibility-audit',
      source: 'inclusive-dev/skills',
      skillPath: 'web/accessibility-audit',
      actual: 'OFF',
      desired: 'OFF',
      drift: 'none',
      update: 'current',
      checkedAt: '18m ago',
      relationships: [
        {target: 'Shared · Global', form: 'local', activation: 'OFF', path: '~/.agents/.skillspub-off/skills/accessibility-audit'},
        {target: 'Grok · Global', form: 'mirror', activation: 'OFF', path: '~/.grok/.skillspub-off/accessibility-audit'},
      ],
    },
    {
      id: 'project:api-contract',
      scope: 'project',
      name: 'api-contract',
      source: 'octo-labs/engineering-skills',
      skillPath: 'skills/api-contract',
      actual: 'ON',
      desired: 'ON',
      drift: 'none',
      update: 'available',
      checkedAt: 'unknown age',
      relationships: [
        {target: 'Shared · exact Project', form: 'local', activation: 'ON', path: `${projectPath}/.agents/skills/api-contract`},
        {target: 'Pi · exact Project', form: 'link', activation: 'ON', path: `${projectPath}/.pi/skills/api-contract`},
        {target: 'Grok · exact Project', form: 'mirror', activation: 'ON', path: `${projectPath}/.grok/skills/api-contract`},
      ],
    },
    {
      id: 'project:risk-radar',
      scope: 'project',
      name: 'risk-radar',
      source: 'safety-first/agent-skills',
      skillPath: 'skills/risk-radar',
      actual: 'ON',
      desired: 'OFF',
      drift: 'activation',
      update: 'check-failed',
      checkedAt: '6m ago',
      error: 'remote comparison timed out',
      relationships: [
        {target: 'Shared · exact Project', form: 'local', activation: 'ON', path: `${projectPath}/.agents/skills/risk-radar`},
      ],
    },
  ];
}

const OPERATION_STEPS: Record<OperationKind, string[]> = {
  add: [
    'Acquire scope operation lock',
    'Recheck Slot, source, ON/OFF, and path preconditions',
    'Vercel skills@1.5.21 security audit + Shared copy',
    'Rescan the selected Shared Skill Target',
    'Compute final Actual / Desired / Drift',
  ],
  refresh: [
    'Read fixed-lock provenance for this scope',
    'Compare remote source and folder hashes',
    'Cache current / available / missing / failed observations',
    'Render scope truth without changing Actual or Desired',
  ],
  update: [
    'Acquire Source operation lock',
    'Temporarily restore desired-OFF managed entries',
    'Vercel skills@1.5.21 updates the named Slot',
    'Restore Desired activation and verify dependencies',
    'Rescan final Actual / Desired / Drift',
  ],
  'batch-update': [
    'Acquire one scope operation lock',
    'Recheck every marked available Slot',
    'Vercel skills@1.5.21 updates named Slots only',
    'Restore each Desired activation independently',
    'Report updated / skipped / failed and remaining Drift',
  ],
  remove: [
    'Recheck source identity and dependency manifest',
    'Remove known dependent Links and Mirrors',
    'Vercel skills@1.5.21 removes the named source Slot',
    'Rescan filesystem truth and warn about unopened Projects',
  ],
};

function scopeLabel(scope: Scope): string {
  return scope === 'global' ? 'Global' : 'exact Project';
}

function scopeRoot(scope: Scope): string {
  return scope === 'global' ? GLOBAL_PATH : `${PROJECT_PATH}/.agents/skills`;
}

function driftText(item: Installed): string {
  return item.drift === 'none'
    ? 'none'
    : item.drift === 'mirror-sync'
      ? 'mirror source changed; explicit reconcile required'
      : `Actual ${item.actual} ≠ Desired ${item.desired}`;
}

function statusTone(value: string): Tone {
  if (value === 'none' || value === 'current' || value === 'ON' || value === 'done') return 'green';
  if (value === 'available' || value === 'OFF' || value === 'unknown') return 'yellow';
  if (value === 'check-failed' || value === 'upstream-missing' || value === 'failed') return 'red';
  return 'cyan';
}

function Panel({title, active = false, width, flexGrow, children}: {
  title: string;
  active?: boolean;
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
      borderColor: active ? 'cyan' : 'gray',
      paddingX: 1,
      overflow: 'hidden',
    },
    h(Text, {bold: true, color: active ? 'cyan' : undefined, wrap: 'truncate-end'}, title),
    children,
  );
}

function CandidateDetail({candidate, occupying, scope}: {candidate?: Candidate; occupying?: Installed; scope: Scope}): ReactNode {
  if (!candidate) return h(Text, {dimColor: true}, 'No candidate matches this search.');
  const exact = occupying?.source === candidate.source && occupying.skillPath === candidate.skillPath;
  return h(
    Box,
    {flexDirection: 'column'},
    h(Text, {bold: true, color: 'cyan'}, candidate.name),
    h(Text, {wrap: 'truncate-end'}, `Candidate identity: ${candidate.source} + ${candidate.skillPath}`),
    h(Text, {wrap: 'truncate-end'}, `Description: ${candidate.description}`),
    h(Text, null, `Installs: ${candidate.installs}`),
    h(Text, {wrap: 'truncate-end'}, `Detail: ${candidate.detailUrl}`),
    h(Text, {color: 'magenta'}, 'Source owner: Vercel skills via SkillsPub Source Adapter · fixed skills@1.5.21'),
    occupying
      ? h(Text, {color: exact ? 'green' : 'yellow'}, exact
          ? `Slot: already installed from this source in ${scopeLabel(occupying.scope)}`
          : `Slot: occupied by ${occupying.source}; add requires explicit Replace`)
      : h(Text, {color: 'green'}, `Slot: free at ${scopeRoot(scope)}/${candidate.name}`),
  );
}

function ResourceDetail({item}: {item?: Installed}): ReactNode {
  if (!item) return h(Text, {dimColor: true}, 'No installed resource in this scope.');
  return h(
    Box,
    {flexDirection: 'column'},
    h(Text, {bold: true, color: 'cyan'}, item.name),
    h(Text, {wrap: 'truncate-end'}, `Provenance: ${item.source} + ${item.skillPath}`),
    h(Text, null, 'Actual ', h(Text, {color: statusTone(item.actual)}, item.actual), '  Desired ', h(Text, {color: statusTone(item.desired)}, item.desired)),
    h(Text, null, 'Drift ', h(Text, {color: item.drift === 'none' ? 'green' : 'red'}, driftText(item))),
    h(Text, null, 'Update ', h(Text, {color: statusTone(item.update)}, item.update), item.checkedAt ? ` · ${item.checkedAt}` : ''),
    item.error ? h(Text, {color: 'red'}, `Check error: ${item.error}`) : null,
    h(Text, {dimColor: true}, `Known dependents: ${Math.max(0, item.relationships.length - 1)}`),
    ...item.relationships.map((relationship) => h(
      Text,
      {key: `${item.id}:${relationship.target}`, wrap: 'truncate-end'},
      ` ${relationship.activation.padEnd(3)} ${relationship.form.padEnd(6)} ${relationship.target} → ${relationship.path}`,
    )),
  );
}

function PlanView({plan}: {plan: Plan}): ReactNode {
  return h(
    Box,
    {flexDirection: 'column'},
    h(Text, {bold: true, color: 'yellow'}, `PLAN · ${plan.title}`),
    h(Text, {color: 'magenta'}, 'SIMULATION ONLY — no command, file, lock, or Harness configuration will be touched.'),
    ...plan.lines.map((line, index) => h(Text, {key: index, wrap: 'truncate-end'}, ` ${index + 1}. ${line}`)),
    h(Text, null, ''),
    h(Text, {bold: true}, `Confirmation ${plan.confirmIndex + 1}/${plan.confirmations.length}`),
    h(Text, {color: 'yellow', wrap: 'wrap'}, plan.confirmations[plan.confirmIndex]),
    h(Text, {inverse: true}, ' y confirm   n/esc cancel '),
  );
}

function OperationView({operation}: {operation: Operation}): ReactNode {
  return h(
    Box,
    {flexDirection: 'column'},
    h(Text, {bold: true, color: operation.status === 'failed' ? 'red' : 'cyan'}, `SIMULATED ${operation.title}`),
    ...operation.steps.map((step, index) => {
      const failed = operation.status === 'failed' && index === operation.index;
      const done = operation.status === 'done' || index < operation.index;
      const active = operation.status === 'running' && index === operation.index;
      return h(
        Text,
        {key: step, color: failed ? 'red' : done ? 'green' : active ? 'cyan' : 'gray'},
        `${failed ? '✕' : done ? '✓' : active ? '›' : '○'} ${step}`,
      );
    }),
    operation.error ? h(Text, {color: 'red', wrap: 'wrap'}, `Failure: ${operation.error}`) : null,
    ...(operation.result ?? []).map((line, index) => h(Text, {key: `result-${index}`, wrap: 'truncate-end'}, line)),
    operation.status === 'failed'
      ? h(Text, {inverse: true}, ' t retry same idempotent plan   esc keep state ')
      : operation.status === 'done'
        ? h(Text, {inverse: true}, ' enter/esc return to scope state ')
        : h(Text, {dimColor: true}, 'running stub timer…'),
  );
}

function ResultView({result}: {result?: Result}): ReactNode {
  if (!result) return h(Text, {dimColor: true}, 'No action yet. Every result will restate final filesystem truth.');
  return h(
    Box,
    {flexDirection: 'column'},
    h(Text, {bold: true, color: 'green'}, result.title),
    h(Text, {dimColor: true}, `Scope: ${scopeLabel(result.scope)}`),
    ...result.lines.map((line, index) => h(Text, {key: index, wrap: 'truncate-end'}, line)),
  );
}

function ScopeTruth({items, selected}: {items: Installed[]; selected?: Installed}): ReactNode {
  return h(
    Box,
    {flexDirection: 'column'},
    h(Text, {bold: true}, `${items.length} installed resource${items.length === 1 ? '' : 's'}`),
    ...items.slice(0, 5).map((item) => h(
      Text,
      {key: item.id, inverse: item.id === selected?.id, wrap: 'truncate-end'},
      `${item.actual === item.desired ? '✓' : '!'} ${item.name.padEnd(21)} A:${item.actual} D:${item.desired} Δ:${item.drift} U:${item.update}`,
    )),
    items.length === 0 ? h(Text, {dimColor: true}, 'empty Shared Target') : null,
  );
}

function ListRows({surface, candidates, items, candidate, item, marks}: {
  surface: Surface;
  candidates: Candidate[];
  items: Installed[];
  candidate?: Candidate;
  item?: Installed;
  marks: Set<string>;
}): ReactNode {
  if (surface === 'catalog') return h(
    Box,
    {flexDirection: 'column'},
    ...candidates.map((entry) => h(
      Text,
      {key: entry.key, inverse: entry.key === candidate?.key, wrap: 'truncate-end'},
      `${entry.key === candidate?.key ? '›' : ' '} ${entry.name} · ${entry.source} · ${entry.installs}`,
    )),
    candidates.length === 0 ? h(Text, {dimColor: true}, ' no candidates') : null,
  );
  return h(
    Box,
    {flexDirection: 'column'},
    ...items.map((entry) => h(
      Text,
      {key: entry.id, inverse: entry.id === item?.id, bold: marks.has(entry.id), wrap: 'truncate-end'},
      `${marks.has(entry.id) ? '●' : entry.id === item?.id ? '›' : ' '} ${entry.name} · ${entry.actual}/${entry.desired} · ${entry.update}`,
    )),
    items.length === 0 ? h(Text, {dimColor: true}, ' no installed resources') : null,
  );
}

function ActiveContent({plan, operation, surface, candidate, item, occupying, result, scope}: {
  plan: Plan | null;
  operation: Operation | null;
  surface: Surface;
  candidate?: Candidate;
  item?: Installed;
  occupying?: Installed;
  result?: Result;
  scope: Scope;
}): ReactNode {
  if (plan) return h(PlanView, {plan});
  if (operation) return h(OperationView, {operation});
  if (surface === 'catalog') return h(CandidateDetail, {candidate, occupying, scope});
  return h(Box, {flexDirection: 'column'}, h(ResourceDetail, {item}), h(Text, null, ''), h(ResultView, {result}));
}

function Header({variantIndex, scope, surface, query, searching, failNext}: {
  variantIndex: number;
  scope: Scope;
  surface: Surface;
  query: string;
  searching: boolean;
  failNext: boolean;
}): ReactNode {
  return h(
    Box,
    {flexDirection: 'column'},
    h(Text, {inverse: true, color: 'yellow'}, ' THROWAWAY · IN-MEMORY · ZERO SOURCE OR FILESYSTEM OPERATIONS '),
    h(
      Text,
      null,
      ...VARIANTS.flatMap((variant, index) => [
        h(Text, {key: variant.key, bold: index === variantIndex, color: index === variantIndex ? 'cyan' : 'gray'}, `[${variant.key} ${variant.name}]`),
        ' ',
      ]),
    ),
    h(Text, {wrap: 'truncate-end'},
      `Scope: ${scopeLabel(scope)} · ${scopeRoot(scope)}  |  Focus: ${surface}${query ? `  |  Search: ${query}` : ''}${searching ? '▌' : ''}${failNext ? '  |  FAULT INJECTION ARMED' : ''}`),
  );
}

function Footer({variantIndex, feedback}: {variantIndex: number; feedback: string}): ReactNode {
  const variant = VARIANTS[variantIndex]!;
  return h(
    Box,
    {flexDirection: 'column'},
    h(Text, {inverse: true, wrap: 'truncate-end'}, ` ${feedback || 'tab catalog/inventory  j/k select  / search  a add  r refresh  u update  space mark  b batch  d remove  x fail next  g/p scope  q quit'} `),
    h(Text, {bold: true, color: 'cyan', wrap: 'truncate-end'}, ` ←/→ or 1/2/3 switch · ${variant.key} — ${variant.name} · tests ${variant.tests}`),
  );
}

function variantA(props: VariantProps): ReactNode {
  const stage = props.plan
    ? 2
    : props.operation?.status === 'running'
      ? 3
      : props.operation?.status === 'failed' || props.operation?.status === 'done'
        ? 4
        : props.surface === 'catalog'
          ? 1
          : 3;
  const stages = ['1 Discover', '2 Inspect & plan', '3 Confirm ownership', '4 Run & maintain', '5 Verify truth'];
  return h(
    Box,
    {flexGrow: 1, flexDirection: 'row', overflow: 'hidden'},
    h(
      Panel,
      {title: 'GUIDED RAIL', active: true, width: 24},
      ...stages.map((label, index) => h(Text, {key: label, inverse: index === stage, color: index < stage ? 'green' : undefined}, `${index < stage ? '✓' : index === stage ? '›' : '○'} ${label}`)),
      h(Text, null, ''),
      h(Text, {bold: true}, 'Recommended now'),
      h(Text, {color: 'yellow', wrap: 'wrap'}, props.recommendation),
      h(Text, null, ''),
      h(Text, {dimColor: true, wrap: 'wrap'}, 'This variant asks whether a novice-safe lifecycle should feel like one linear review.'),
    ),
    h(
      Panel,
      {title: props.plan || props.operation ? 'CURRENT BOUNDARY' : props.surface === 'catalog' ? 'CANDIDATE DETAIL' : 'RESOURCE DETAIL', active: true, flexGrow: 1},
      h(ActiveContent, props),
    ),
    h(
      Panel,
      {title: 'ALWAYS-VISIBLE SCOPE TRUTH', width: 46},
      h(ScopeTruth, {items: props.items, selected: props.item}),
      h(Text, null, ''),
      h(Text, {bold: true}, 'Selection'),
      h(ListRows, props),
    ),
  );
}

function variantB(props: VariantProps): ReactNode {
  return h(
    Box,
    {flexGrow: 1, flexDirection: 'column', overflow: 'hidden'},
    h(Text, {color: 'cyan'}, 'OPERATIONS WORKBENCH · every object stays visible while the plan occupies the inspector'),
    h(
      Box,
      {flexGrow: 1, flexDirection: 'row', overflow: 'hidden'},
      h(
        Panel,
        {title: `CATALOG / SEARCH${props.surface === 'catalog' ? ' · FOCUS' : ''}`, active: props.surface === 'catalog', width: 34},
        h(ListRows, {...props, surface: 'catalog'}),
      ),
      h(
        Panel,
        {title: `SCOPE INVENTORY${props.surface === 'inventory' ? ' · FOCUS' : ''}`, active: props.surface === 'inventory', width: 40},
        h(ListRows, {...props, surface: 'inventory'}),
        h(Text, null, ''),
        h(Text, {dimColor: true}, `${props.marks.size} marked · batch uses marked + available only`),
      ),
      h(
        Panel,
        {title: props.plan ? 'PLAN / CONFIRM' : props.operation ? 'PROGRESS / RESULT' : 'INSPECTOR', active: true, flexGrow: 1},
        h(ActiveContent, props),
      ),
    ),
    h(
      Box,
      {height: 5, flexDirection: 'row'},
      h(Panel, {title: 'ACTUAL / DESIRED / DRIFT STRIP', flexGrow: 1}, h(ScopeTruth, {items: props.items, selected: props.item})),
      h(Panel, {title: 'LAST FINAL STATE', width: 58}, h(ResultView, {result: props.result})),
    ),
  );
}

function variantC(props: VariantProps): ReactNode {
  return h(
    Box,
    {flexGrow: 1, flexDirection: 'column', overflow: 'hidden'},
    h(Text, {inverse: true, color: 'cyan'}, ' / SEARCH   A PREVIEW/ADD   R REFRESH   U UPDATE   B BATCH   D REMOVE   X FAIL-NEXT   T RETRY '),
    h(
      Box,
      {flexGrow: 1, flexDirection: 'row', overflow: 'hidden'},
      h(
        Panel,
        {title: props.plan ? 'PENDING COMMAND' : props.operation ? 'COMMAND EXECUTION' : 'FOCUS OBJECT', active: true, width: 58},
        h(ActiveContent, props),
      ),
      h(
        Panel,
        {title: 'AUDIT TIMELINE · NEWEST FIRST', flexGrow: 1},
        ...props.events.slice(0, 12).map((event) => h(
          Text,
          {key: event.id, color: event.tone, wrap: 'truncate-end'},
          `#${String(event.id).padStart(2, '0')} [${event.scope === 'both' ? 'ALL' : scopeLabel(event.scope)}] ${event.label}`,
        )),
      ),
    ),
    h(
      Box,
      {height: 8, flexDirection: 'row'},
      h(Panel, {title: 'FILESYSTEM TRUTH LEDGER', flexGrow: 1}, h(ScopeTruth, {items: props.items, selected: props.item})),
      h(
        Panel,
        {title: `COMMAND INPUT · ${props.surface.toUpperCase()}`, width: 50},
        h(ListRows, props),
      ),
    ),
  );
}

interface VariantProps {
  plan: Plan | null;
  operation: Operation | null;
  scope: Scope;
  surface: Surface;
  candidates: Candidate[];
  items: Installed[];
  candidate?: Candidate;
  item?: Installed;
  occupying?: Installed;
  result?: Result;
  marks: Set<string>;
  events: AuditEvent[];
  recommendation: string;
}

function App(): ReactNode {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const [size, setSize] = useState({width: stdout.columns ?? 130, height: stdout.rows ?? 38});
  useEffect(() => {
    const resize = () => setSize({width: stdout.columns ?? 130, height: stdout.rows ?? 38});
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
    };
  }, [stdout]);

  const [variantIndex, setVariantIndex] = useState(0);
  const [scope, setScope] = useState<Scope>('global');
  const [surface, setSurface] = useState<Surface>('catalog');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [itemIndex, setItemIndex] = useState(0);
  const [installed, setInstalled] = useState(() => initialInstalled(PROJECT_PATH));
  const [marks, setMarks] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<Plan | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [result, setResult] = useState<Result>();
  const [failNext, setFailNext] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [events, setEvents] = useState<AuditEvent[]>([
    {id: 2, scope: 'both', label: 'Loaded stub catalog and Actual/Desired/Drift fixtures', tone: 'cyan'},
    {id: 1, scope: 'both', label: 'Prototype booted; all Source and filesystem adapters are disabled', tone: 'magenta'},
  ]);

  const log = (label: string, tone: Tone = 'cyan', eventScope: Scope | 'both' = scope) => {
    setEvents((current) => [{id: (current[0]?.id ?? 0) + 1, scope: eventScope, label, tone}, ...current]);
  };

  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? CANDIDATES.filter((candidate) =>
          `${candidate.name} ${candidate.source} ${candidate.description}`.toLowerCase().includes(needle))
      : CANDIDATES;
  }, [query]);
  const items = installed.filter((item) => item.scope === scope);
  const selectedCandidate = candidates[Math.min(candidateIndex, Math.max(0, candidates.length - 1))];
  const selectedItem = items[Math.min(itemIndex, Math.max(0, items.length - 1))];
  const occupying = selectedCandidate
    ? items.find((item) => item.name === selectedCandidate.name)
    : undefined;

  const closeOperation = () => setOperation(null);

  const finishOperation = (current: Operation): string[] => {
    let lines: string[] = [];
    if (current.kind === 'refresh') {
      setInstalled((all) => all.map((item) => item.scope === current.scope ? {
        ...item,
        update: item.name === 'risk-radar' ? 'check-failed' : item.name === 'accessibility-audit' ? 'current' : 'available',
        checkedAt: 'just now',
        error: item.name === 'risk-radar' ? 'upstream comparison returned HTTP 503' : undefined,
      } : item));
      lines = ['Actual: unchanged', 'Desired: unchanged', 'Drift: unchanged', 'Update availability: cache replaced for this exact scope'];
    } else if (current.kind === 'add') {
      const candidate = CANDIDATES.find((entry) => entry.key === current.candidateKey)!;
      const root = current.scope === 'global' ? GLOBAL_PATH : `${PROJECT_PATH}/.agents/skills`;
      const added: Installed = {
        id: `${current.scope}:${candidate.name}`,
        scope: current.scope,
        name: candidate.name,
        source: candidate.source,
        skillPath: candidate.skillPath,
        actual: 'ON',
        desired: 'ON',
        drift: 'none',
        update: 'unknown',
        relationships: [{
          target: current.scope === 'global' ? 'Shared · Global' : 'Shared · exact Project',
          form: 'local',
          activation: 'ON',
          path: `${root}/${candidate.name}`,
        }],
      };
      setInstalled((all) => [...all.filter((item) => item.id !== current.replaceId && item.id !== added.id), added]);
      lines = [
        `Actual: Shared local ON at ${root}/${candidate.name}`,
        'Desired: ON',
        'Drift: none',
        'Harness-specific Relationships: none (Source Adapter stops at Shared)',
      ];
    } else if (current.kind === 'remove') {
      const removed = installed.filter((item) => current.resourceIds.includes(item.id));
      setInstalled((all) => all.filter((item) => !current.resourceIds.includes(item.id)));
      lines = [
        `Actual: source absent; ${removed.flatMap((item) => item.relationships.slice(1)).length} known dependent Relationships absent`,
        'Desired: source and known Relationships absent',
        'Drift: none in this scan',
        'Warning: unopened Projects may retain broken Links; no central Project registry exists',
      ];
    } else {
      const changing = installed.filter((item) => current.resourceIds.includes(item.id));
      setInstalled((all) => all.map((item) => {
        if (!current.resourceIds.includes(item.id)) return item;
        return {
          ...item,
          update: 'current',
          checkedAt: 'just now',
          error: undefined,
          drift: item.relationships.some((relationship) => relationship.form === 'mirror') ? 'mirror-sync' : item.drift,
        };
      }));
      const mirrors = changing.filter((item) => item.relationships.some((relationship) => relationship.form === 'mirror')).length;
      lines = [
        `Actual: ${changing.length} Shared source${changing.length === 1 ? '' : 's'} updated`,
        'Desired: activation restored per Slot',
        `Drift: ${mirrors > 0 ? `${mirrors} Mirror relationship${mirrors === 1 ? '' : 's'} need explicit reconcile` : 'none'}`,
        `Result: ${changing.length} updated · 0 skipped · 0 failed`,
      ];
    }
    const nextResult = {title: `${current.title} · final state`, scope: current.scope, lines};
    setResult(nextResult);
    log(`${current.title} completed; final Actual/Desired/Drift rendered`, 'green', current.scope);
    return lines;
  };

  useEffect(() => {
    if (!operation || operation.status !== 'running') return;
    const timer = setTimeout(() => {
      if (operation.failAt === operation.index) {
        const lines = [
          'Actual: completed steps are preserved; no guessed rollback',
          'Desired: preserved',
          'Drift: remaining work is explicit',
          'Retry: rerun the same idempotent plan with t',
        ];
        setResult({title: `${operation.title} · failed safely`, scope: operation.scope, lines});
        setOperation({...operation, status: 'failed', error: 'stubbed upstream process exited 1 after a transient network error', result: lines});
        log(`${operation.title} failed; Desired preserved; retry available`, 'red', operation.scope);
        return;
      }
      if (operation.index >= operation.steps.length - 1) {
        const lines = finishOperation(operation);
        setOperation({...operation, status: 'done', result: lines});
      } else {
        setOperation({...operation, index: operation.index + 1});
      }
    }, 420);
    return () => clearTimeout(timer);
  }, [operation]);

  const startOperation = (details: Omit<Operation, 'index' | 'status' | 'steps' | 'failAt'>) => {
    const shouldFail = failNext;
    setFailNext(false);
    setPlan(null);
    setOperation({
      ...details,
      steps: OPERATION_STEPS[details.kind],
      index: 0,
      status: 'running',
      failAt: shouldFail ? Math.min(2, OPERATION_STEPS[details.kind].length - 1) : undefined,
    });
    log(`${details.title} started${shouldFail ? ' with armed failure path' : ''}`, shouldFail ? 'yellow' : 'cyan', details.scope);
  };

  const startFromPlan = (approved: Plan) => startOperation({
    kind: approved.kind,
    title: approved.title,
    scope: approved.scope,
    resourceIds: approved.resourceIds,
    candidateKey: approved.candidateKey,
    replaceId: approved.replaceId,
  });

  const previewAdd = () => {
    if (!selectedCandidate) return setFeedback('No candidate selected.');
    if (occupying?.source === selectedCandidate.source && occupying.skillPath === selectedCandidate.skillPath)
      return setFeedback('This exact candidate already occupies the Slot.');
    const replacing = occupying && occupying.source !== selectedCandidate.source;
    setPlan({
      kind: 'add',
      title: `${replacing ? 'Replace' : 'Add'} ${selectedCandidate.name} → ${scopeLabel(scope)} Shared`,
      scope,
      lines: [
        `Candidate: ${selectedCandidate.source} + ${selectedCandidate.skillPath}`,
        `Destination Slot: ${scopeRoot(scope)}/${selectedCandidate.name}`,
        replacing ? `Replace existing source: ${occupying.source} + ${occupying.skillPath}` : 'Slot preflight: free',
        'SkillsPub owns preflight and orchestration; Vercel skills owns audit, copy, lock, update, and remove',
        'No Harness-specific Link or Mirror will be created',
      ],
      confirmations: [
        'Confirm the SkillsPub preflight, scope, provenance, and one-Slot replacement boundary.',
        'Simulate Vercel skills security audit + final Proceed. This is the upstream confirmation boundary.',
      ],
      confirmIndex: 0,
      resourceIds: [],
      candidateKey: selectedCandidate.key,
      replaceId: replacing ? occupying.id : undefined,
    });
    log(`${replacing ? 'Replace' : 'Add'} plan previewed for ${selectedCandidate.name}`, 'yellow');
  };

  const previewUpdate = (batch: boolean) => {
    const selected = batch
      ? items.filter((item) => marks.has(item.id) && item.update === 'available')
      : selectedItem?.update === 'available' ? [selectedItem] : [];
    if (selected.length === 0)
      return setFeedback(batch ? 'Mark at least one available resource.' : 'Selected resource is not marked available; refresh with r.');
    setPlan({
      kind: batch ? 'batch-update' : 'update',
      title: `${batch ? 'Batch update' : 'Update'} ${selected.map((item) => item.name).join(', ')}`,
      scope,
      lines: [
        `Named Slots only: ${selected.map((item) => item.name).join(', ')}`,
        'Operation lock + preflight; desired-OFF entries may be temporarily visible',
        'Vercel skills owns remote update and lock content',
        'SkillsPub restores Desired activation, verifies known dependencies, and rescans Actual/Drift',
        `Mirror warning: ${selected.some((item) => item.relationships.some((relationship) => relationship.form === 'mirror')) ? 'source update will create Mirror Drift' : 'no known Mirrors'}`,
      ],
      confirmations: ['Confirm the named update plan. Unmarked, current, failed-check, and upstream-missing Slots are excluded.'],
      confirmIndex: 0,
      resourceIds: selected.map((item) => item.id),
    });
    log(`${batch ? 'Batch' : 'Single'} update plan previewed`, 'yellow');
  };

  const previewRemove = () => {
    if (!selectedItem) return setFeedback('No installed resource selected.');
    const dependencies = selectedItem.relationships.slice(1);
    setPlan({
      kind: 'remove',
      title: `Remove ${selectedItem.name} from ${scopeLabel(scope)}`,
      scope,
      lines: [
        `Source: ${selectedItem.source} + ${selectedItem.skillPath}`,
        `Shared local: ${selectedItem.relationships[0]?.path ?? 'unknown'}`,
        ...dependencies.map((relationship) => `Cascade ${relationship.form}: ${relationship.target} → ${relationship.path}`),
        'Unknown unopened Projects: may retain broken Links because SkillsPub has no central Project registry',
        'Vercel skills removes only this named managed Slot after known dependencies are removed',
      ],
      confirmations: [
        `Confirm dependency impact: ${dependencies.length} known Link/Mirror relationship${dependencies.length === 1 ? '' : 's'} will be removed first.`,
        'Second confirmation: remove the Shared source after the known dependency cascade.',
      ],
      confirmIndex: 0,
      resourceIds: [selectedItem.id],
    });
    log(`Dependency-aware remove previewed for ${selectedItem.name}`, 'yellow');
  };

  useInput((input, key) => {
    if (searching) {
      if (key.escape) {
        setQuery('');
        setCandidateIndex(0);
        return setSearching(false);
      }
      if (key.return) return setSearching(false);
      if (key.backspace || key.delete || input === '\x7f') {
        setCandidateIndex(0);
        return setQuery((value) => value.slice(0, -1));
      }
      if (input && !key.ctrl && !key.meta) {
        setCandidateIndex(0);
        return setQuery((value) => value + input);
      }
      return;
    }

    if (key.leftArrow) return setVariantIndex((value) => (value + VARIANTS.length - 1) % VARIANTS.length);
    if (key.rightArrow) return setVariantIndex((value) => (value + 1) % VARIANTS.length);
    if (input === '1' || input === '2' || input === '3') return setVariantIndex(Number(input) - 1);
    if (input === 'q' || (key.ctrl && input === 'c')) return exit();

    if (plan) {
      if (input === 'y') {
        if (plan.confirmIndex < plan.confirmations.length - 1)
          return setPlan({...plan, confirmIndex: plan.confirmIndex + 1});
        return startFromPlan(plan);
      }
      if (input === 'n' || key.escape) {
        setFeedback('Plan cancelled; Actual and Desired unchanged.');
        log(`${plan.title} cancelled before apply`, 'gray', plan.scope);
        return setPlan(null);
      }
      return;
    }

    if (operation) {
      if (operation.status === 'failed' && input === 't') {
        setFeedback('Retrying the same idempotent plan.');
        log(`${operation.title} retry requested`, 'yellow', operation.scope);
        return setOperation({...operation, index: 0, status: 'running', failAt: undefined, error: undefined, result: undefined});
      }
      if ((key.escape || key.return) && operation.status !== 'running') return closeOperation();
      return;
    }

    if (input === 'g' || input === 'p') {
      const nextScope: Scope = input === 'g' ? 'global' : 'project';
      setScope(nextScope);
      setItemIndex(0);
      setMarks(new Set());
      setFeedback(`${scopeLabel(nextScope)} scope selected; state is isolated in memory.`);
      return;
    }
    if (key.tab) {
      setSurface((value) => value === 'catalog' ? 'inventory' : 'catalog');
      return;
    }
    if (input === '/') {
      setSurface('catalog');
      return setSearching(true);
    }
    if (key.downArrow || input === 'j') {
      if (surface === 'catalog') setCandidateIndex((value) => Math.min(Math.max(0, candidates.length - 1), value + 1));
      else setItemIndex((value) => Math.min(Math.max(0, items.length - 1), value + 1));
      return;
    }
    if (key.upArrow || input === 'k') {
      if (surface === 'catalog') setCandidateIndex((value) => Math.max(0, value - 1));
      else setItemIndex((value) => Math.max(0, value - 1));
      return;
    }
    if (input === ' ') {
      if (!selectedItem || surface !== 'inventory') return setFeedback('Switch to Inventory and select a resource to mark it.');
      const next = new Set(marks);
      if (next.has(selectedItem.id)) next.delete(selectedItem.id);
      else next.add(selectedItem.id);
      setMarks(next);
      return setFeedback(`${next.size} resource${next.size === 1 ? '' : 's'} marked.`);
    }
    if (input === 'a') return previewAdd();
    if (input === 'r') return startOperation({kind: 'refresh', title: `Refresh ${scopeLabel(scope)} update availability`, scope, resourceIds: []});
    if (input === 'u') return previewUpdate(false);
    if (input === 'b') return previewUpdate(true);
    if (input === 'd') return previewRemove();
    if (input === 'x') {
      setFailNext((value) => !value);
      return setFeedback(failNext ? 'Failure path disarmed.' : 'Next simulated operation will fail once; press t to retry.');
    }
  });

  const recommendation = plan
    ? `Review confirmation ${plan.confirmIndex + 1}/${plan.confirmations.length}; y advances, n cancels.`
    : operation?.status === 'failed'
      ? 'Press t to retry the same idempotent plan.'
      : operation
        ? 'Watch progress, then inspect final Actual / Desired / Drift.'
        : surface === 'catalog'
          ? 'Use / to search, j/k to compare same-name provenance, then a to preview add.'
          : 'Use r to refresh, u for one update, space+b for batch, or d for dependency-aware remove.';

  const variantProps: VariantProps = {
    plan,
    operation,
    scope,
    surface,
    candidates,
    items,
    candidate: selectedCandidate,
    item: selectedItem,
    occupying,
    result,
    marks,
    events,
    recommendation,
  };

  const body = variantIndex === 0 ? variantA(variantProps) : variantIndex === 1 ? variantB(variantProps) : variantC(variantProps);
  return h(
    Box,
    {flexDirection: 'column', width: size.width, height: size.height},
    h(Header, {variantIndex, scope, surface, query, searching, failNext}),
    size.width < 100 || size.height < 28
      ? h(Text, {color: 'yellow'}, 'Best compared at ≥100×28; resize keeps all state in memory.')
      : null,
    body,
    h(Footer, {variantIndex, feedback}),
  );
}

function selfCheck(): void {
  assert.equal(VARIANTS.length, 3);
  assert.equal(new Set(VARIANTS.map((variant) => variant.name)).size, 3);
  assert.ok(initialInstalled('/tmp/project').some((item) => item.scope === 'global'));
  assert.ok(initialInstalled('/tmp/project').some((item) => item.scope === 'project'));
  assert.ok(initialInstalled('/tmp/project').some((item) => item.relationships.length > 1));
  assert.deepEqual(Object.keys(OPERATION_STEPS).sort(), ['add', 'batch-update', 'refresh', 'remove', 'update']);
  console.log('source lifecycle prototype self-check: ok');
}

async function run(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Run this prototype in an interactive terminal.');
  const app = render(h(App), {alternateScreen: true, exitOnCtrlC: false, patchConsole: false});
  await app.waitUntilExit();
}

if (process.argv.includes('--check')) selfCheck();
else await run();
