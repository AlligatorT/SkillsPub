import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterRows,
  projectRows,
  searchRows,
  sortRows,
  untagged,
  viewAgents,
} from '../src/view.ts';
import type {
  InventoryScanReport,
  RuntimeRelationship,
  ScannedRuntime,
} from '../src/inventory.ts';

function runtime(key: string, kind: 'agent' | 'shared' = 'agent'): ScannedRuntime {
  return {
    key,
    kind,
    discoveryRoot: `/roots/${key}/skills`,
    parkingRoot: `/roots/${key}/.skillspub-off/skills`,
    projectPath: `.${key}/skills`,
    id: `global:${key}`,
    scope: 'global',
    writable: true,
  };
}

function relationship(overrides: Partial<RuntimeRelationship>): RuntimeRelationship {
  const runtimeId = overrides.runtimeId ?? 'global:claude';
  return {
    runtimeId,
    runtimeKey: runtimeId.replace('global:', ''),
    slot: 'grilling',
    name: 'grilling',
    activation: 'on',
    form: 'local',
    path: `/roots/claude/skills/grilling`,
    realPath: '/src/grilling',
    resourceId: '/src/grilling',
    readOnly: false,
    ...overrides,
  };
}

function report(pieces: {
  scope?: InventoryScanReport['scope'];
  runtimes?: ScannedRuntime[];
  relationships?: RuntimeRelationship[];
  slots?: InventoryScanReport['slots'];
}): InventoryScanReport {
  const relationships = pieces.relationships ?? [];
  const resources = [...new Map(
    relationships
      .filter((rel) => rel.realPath)
      .map((rel) => [rel.realPath as string, {
        id: rel.realPath as string,
        name: rel.name,
        realPath: rel.realPath as string,
        hash: 'x',
        cliCoupled: false,
        relationships: relationships.filter((r) => r.realPath === rel.realPath),
      }]),
  ).values()];
  return {
    scope: pieces.scope ?? 'global',
    runtimes: pieces.runtimes ?? [runtime('claude'), runtime('pi')],
    resources,
    slots: pieces.slots ?? [],
    relationships,
    missing: [],
    findings: [],
    stateFile: '/nowhere/state.json',
  };
}

test('projection maps Relationship activation and form to matrix presence', () => {
  const rows = projectRows(report({
    relationships: [
      relationship({}),
      relationship({
        runtimeId: 'global:pi',
        runtimeKey: 'pi',
        activation: 'off',
        form: 'link',
        path: '/roots/pi/.skillspub-off/skills/grilling',
        target: '/src/grilling',
      }),
      relationship({
        name: 'broken',
        slot: 'broken',
        path: '/roots/claude/skills/broken',
        realPath: undefined,
        resourceId: undefined,
        form: 'link',
        target: '/gone',
      }),
    ],
  }));

  const grilling = rows.find((row) => row.name === 'grilling');
  assert.ok(grilling);
  assert.deepEqual(
    { on: grilling.agents.claude?.presence, off: grilling.agents.pi?.presence },
    { on: 'on', off: 'off' },
  );
  assert.equal(grilling.agents.pi?.linked, true);
  assert.equal(grilling.agents.pi?.underOff, true);
  assert.equal(grilling.relationships.length, 2);
  assert.equal(grilling.relationships[1].runtimeId, 'global:pi');
  assert.equal(grilling.relationships[1].slot, 'grilling');

  const broken = rows.find((row) => row.name === 'broken');
  assert.ok(broken);
  assert.equal(broken.id, 'broken:/roots/claude/skills/broken');
  assert.equal(broken.agents.claude?.presence, 'deadlink');
  assert.equal(broken.agents.pi, undefined);
});

test('agents map prefers the ON occupant of a conflicted slot', () => {
  const rows = projectRows(report({
    runtimes: [runtime('claude')],
    relationships: [
      relationship({}),
      relationship({
        activation: 'off',
        path: '/roots/claude/.skillspub-off/skills/grilling',
      }),
    ],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agents.claude?.presence, 'on');
  assert.equal(rows[0].relationships.length, 2);
});

test('same-name variants are disambiguated with a source suffix', () => {
  const rows = projectRows(report({
    relationships: [
      relationship({}),
      relationship({
        runtimeId: 'global:pi',
        runtimeKey: 'pi',
        realPath: '/other/grilling',
        resourceId: '/other/grilling',
        path: '/roots/pi/skills/grilling',
      }),
    ],
  }));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.displayName.startsWith('grilling (')));
  assert.ok(rows.some((row) => row.displayName.includes('/src/grilling')));
  assert.ok(rows.some((row) => row.displayName.includes('/other/grilling')));
});

test('slot provenance flows into the projected row', () => {
  const rep = report({
    relationships: [relationship({})],
    slots: [{
      id: 'global:claude\0grilling',
      runtimeId: 'global:claude',
      runtimeKey: 'claude',
      name: 'grilling',
      relationships: [],
      provenance: { source: 'acme/tools', sourceUrl: 'https://skills.sh/acme/tools/grilling' },
    }],
  });
  const rows = projectRows(rep);
  assert.equal(rows[0].provenance.source, 'acme/tools');
  assert.equal(rows[0].sourceLabel, 'https://skills.sh/acme/tools/grilling');
  assert.equal(rows[0].provenance.skillPath, undefined);
});

test('view agents come from the runtime registry, keyed by runtime key', () => {
  const agents = viewAgents(report({ runtimes: [runtime('claude'), runtime('shared', 'shared')] }));
  assert.deepEqual(agents, [
    { name: 'claude', dir: '/roots/claude/skills' },
    { name: 'shared', dir: '/roots/shared/skills' },
  ]);
});

test('search/sort/filter/untagged operate on projected rows', () => {
  const rows = projectRows(report({
    relationships: [
      relationship({}),
      relationship({
        name: 'zebra',
        slot: 'zebra',
        path: '/roots/claude/skills/zebra',
        realPath: '/src/zebra',
        resourceId: '/src/zebra',
      }),
    ],
  }));
  assert.deepEqual(searchRows(rows, 'ZEB').map((row) => row.name), ['zebra']);
  assert.deepEqual(sortRows(rows, 'name').map((row) => row.name), ['grilling', 'zebra']);
  assert.deepEqual(filterRows(rows, { agent: 'pi' }, {}), []);
  assert.deepEqual(filterRows(rows, { tag: 'tools' }, { '/src/zebra': ['tools'] })
    .map((row) => row.name), ['zebra']);
  assert.deepEqual(untagged(rows, { '/src/zebra': ['tools'] }), ['grilling']);
});

test('projectRows propagates runtime scope and read-only flags', () => {
  const project = {
    ...runtime('claude'),
    id: 'project:/p:claude',
    scope: 'project' as const,
    writable: true,
  };
  const global = {
    ...runtime('claude'),
    id: 'global:claude',
    scope: 'global' as const,
    writable: false,
  };
  const rows = projectRows(report({
    runtimes: [project, global],
    relationships: [relationship({ runtimeId: 'global:claude', runtimeKey: 'claude' })],
  }));
  assert.equal(rows[0].agents.claude?.scope, 'global');
  assert.equal(rows[0].agents.claude?.readOnly, true);
  assert.equal(rows[0].relationships[0].scope, 'global');
  assert.equal(rows[0].relationships[0].readOnly, true);
});

test('project scope keeps one effective cell per Skill and Target', () => {
  const project = {
    ...runtime('claude'),
    id: 'project:/p:claude',
    scope: 'project' as const,
    writable: true,
  };
  const parent = {
    ...runtime('claude'),
    id: 'parent:/parent:claude',
    scope: 'parent' as const,
    writable: false,
  };
  const global = {
    ...runtime('claude'),
    id: 'global:claude',
    scope: 'global' as const,
    writable: false,
  };
  const rows = projectRows(report({
    scope: 'project',
    runtimes: [project, parent, global],
    relationships: [
      relationship({
        runtimeId: 'project:/p:claude',
        runtimeKey: 'claude',
        activation: 'off',
        path: '/p/.skillspub/off/claude/grilling',
        readOnly: false,
      }),
      relationship({
        runtimeId: 'parent:/parent:claude',
        runtimeKey: 'claude',
        path: '/parent/.claude/skills/grilling',
        readOnly: true,
      }),
      relationship({
        runtimeId: 'global:claude',
        runtimeKey: 'claude',
        path: '/roots/claude/skills/grilling',
        readOnly: true,
      }),
    ],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].relationships.length, 1);
  assert.equal(rows[0].agents.claude?.scope, 'parent');
  assert.equal(rows[0].agents.claude?.presence, 'on');
  assert.equal(rows[0].agents.claude?.readOnly, true);
  assert.equal(rows[0].relationships[0].scope, 'parent');
  assert.equal(rows[0].relationships[0].readOnly, true);
});

