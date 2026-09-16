import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterRows,
  harnessStatusBadge,
  projectRows,
  projectSourceLayers,
  searchRows,
  sortRows,
  untagged,
  viewTargets,
} from '../src/view.ts';
import type {
  InventoryScanReport,
  TargetRelationship,
  ScannedTarget,
} from '../src/inventory.ts';

function runtime(key: string, kind: 'harness' | 'shared' = 'harness'): ScannedTarget {
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

function relationship(overrides: Partial<TargetRelationship>): TargetRelationship {
  const targetId = overrides.targetId ?? 'global:claude';
  return {
    targetId,
    targetKey: targetId.replace('global:', ''),
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
  targets?: ScannedTarget[];
  relationships?: TargetRelationship[];
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
    targets: pieces.targets ?? [runtime('claude'), runtime('pi')],
    resources,
    slots: pieces.slots ?? [],
    relationships,
    missing: [],
    findings: [],
    stateFile: '/nowhere/state.json',
  };
}

test('Harness badge separates Adapter capability from isolation state', () => {
  const badge = (
    support: 'managed' | 'discoverable' | 'unsupported',
    isolation: 'not-required' | 'unmanaged' | 'managed' | 'drift' | 'unknown',
  ) => harnessStatusBadge({support, isolation: {status: isolation, detail: ''}});

  assert.deepEqual(badge('managed', 'unmanaged'), {text: '[manageable]', tone: 'muted'});
  assert.deepEqual(badge('managed', 'managed'), {text: '[managed]', tone: 'success'});
  assert.deepEqual(badge('managed', 'not-required'), {text: '[managed]', tone: 'success'});
  assert.deepEqual(badge('managed', 'drift'), {text: '[drift]', tone: 'danger'});
  assert.deepEqual(badge('managed', 'unknown'), {text: '[unknown]', tone: 'warning'});
  assert.deepEqual(badge('discoverable', 'managed'), {text: '[discoverable]', tone: 'muted'});
  assert.deepEqual(badge('unsupported', 'managed'), {text: '[unsupported]', tone: 'muted'});
});

test('projection maps Relationship activation and form to matrix presence', () => {
  const rows = projectRows(report({
    relationships: [
      relationship({}),
      relationship({
        targetId: 'global:pi',
        targetKey: 'pi',
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
    { on: grilling.targets.claude?.presence, off: grilling.targets.pi?.presence },
    { on: 'on', off: 'off' },
  );
  assert.equal(grilling.targets.pi?.linked, true);
  assert.equal(grilling.targets.pi?.underOff, true);
  assert.equal(grilling.relationships.length, 2);
  assert.equal(grilling.relationships[1].targetId, 'global:pi');
  assert.equal(grilling.relationships[1].slot, 'grilling');

  const broken = rows.find((row) => row.name === 'broken');
  assert.ok(broken);
  assert.equal(broken.id, 'broken:/roots/claude/skills/broken');
  assert.equal(broken.targets.claude?.presence, 'deadlink');
  assert.equal(broken.targets.pi, undefined);
});

test('agents map prefers the ON occupant of a conflicted slot', () => {
  const rows = projectRows(report({
    targets: [runtime('claude')],
    relationships: [
      relationship({}),
      relationship({
        activation: 'off',
        path: '/roots/claude/.skillspub-off/skills/grilling',
      }),
    ],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targets.claude?.presence, 'on');
  assert.equal(rows[0].relationships.length, 2);
});

test('same-name variants are disambiguated with a source suffix', () => {
  const rows = projectRows(report({
    relationships: [
      relationship({}),
      relationship({
        targetId: 'global:pi',
        targetKey: 'pi',
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
      targetId: 'global:claude',
      targetKey: 'claude',
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

test('view targets come from the runtime registry, keyed by runtime key', () => {
  const targets = viewTargets(report({ targets: [runtime('claude'), runtime('shared', 'shared')] }));
  assert.deepEqual(targets, [
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
  assert.deepEqual(filterRows(rows, { target: 'pi' }, {}), []);
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
    targets: [project, global],
    relationships: [relationship({ targetId: 'global:claude', targetKey: 'claude' })],
  }));
  assert.equal(rows[0].targets.claude?.scope, 'global');
  assert.equal(rows[0].targets.claude?.readOnly, true);
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
    targets: [project, parent, global],
    relationships: [
      relationship({
        targetId: 'project:/p:claude',
        targetKey: 'claude',
        activation: 'off',
        path: '/p/.skillspub/off/claude/grilling',
        readOnly: false,
      }),
      relationship({
        targetId: 'parent:/parent:claude',
        targetKey: 'claude',
        path: '/parent/.claude/skills/grilling',
        readOnly: true,
      }),
      relationship({
        targetId: 'global:claude',
        targetKey: 'claude',
        path: '/roots/claude/skills/grilling',
        readOnly: true,
      }),
    ],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].relationships.length, 1);
  assert.equal(rows[0].targets.claude?.scope, 'parent');
  assert.equal(rows[0].targets.claude?.presence, 'on');
  assert.equal(rows[0].targets.claude?.readOnly, true);
  assert.equal(rows[0].relationships[0].scope, 'parent');
  assert.equal(rows[0].relationships[0].readOnly, true);
});


test('Source layering: default layer answers decisions without developer detail', () => {
  const layers = projectSourceLayers({
    kind: 'resource',
    name: 'grilling',
    sourceLabel: 'https://github.com/owner/repo.git',
    update: 'available',
    actual: 'ON local',
    desired: 'ON',
    drift: 'none observed',
    relationships: 1,
    effectiveVisibility: 'visible',
    identity: '/src/grilling',
    realPath: '/src/grilling',
    updateError: 'installer lock lacks skillPath',
    details: ['local global: /roots/shared/skills/grilling'],
  });

  // 用户态: 能否更新、版本差异、来源链接 — and no hash/path-resolution detail.
  const userFacing = [layers.status.selected, layers.status.truth, ...layers.user].join('\n');
  assert.match(userFacing, /https:\/\/github\.com\/owner\/repo\.git/);
  assert.match(userFacing, /available/);
  assert.doesNotMatch(userFacing, /\/src\/grilling/);
  assert.doesNotMatch(userFacing, /Identity/);
  assert.doesNotMatch(userFacing, /\/roots\/shared\/skills/);
  assert.doesNotMatch(userFacing, /installer lock/);

  // 开发态: a superset with the full original detail.
  const developer = layers.developer.join('\n');
  assert.match(developer, /Identity: \/src\/grilling/);
  assert.match(developer, /Real path: \/src\/grilling/);
  assert.match(developer, /Provenance: https:\/\/github\.com\/owner\/repo\.git/);
  assert.match(developer, /Update availability: available/);
  assert.match(developer, /Update check: installer lock lacks skillPath/);
  assert.match(developer, /local global: \/roots\/shared\/skills\/grilling/);
  assert.match(developer, /Effective visibility: visible/);
});

test('Source layering: candidate layer keeps Slot resolution and links in developer detail', () => {
  const layers = projectSourceLayers({
    kind: 'candidate',
    name: 'shared-name',
    sourceLabel: 'https://skills.sh/owner/one/shared-name',
    update: 'unknown',
    actual: 'not installed',
    desired: 'not applicable',
    drift: 'not applicable',
    relationships: 0,
    effectiveVisibility: 'not applicable',
    identity: 'owner/one@shared-name',
    details: [
      'Source: owner/one',
      'Destination Slot: shared-name',
      'Installs: 10',
      'Detail: https://skills.sh/owner/one/shared-name',
    ],
  });

  const userFacing = [layers.status.selected, layers.status.truth, ...layers.user].join('\n');
  assert.match(userFacing, /https:\/\/skills\.sh\/owner\/one\/shared-name/);
  assert.match(userFacing, /not installed/);
  assert.doesNotMatch(userFacing, /Destination Slot/);

  const developer = layers.developer.join('\n');
  assert.match(developer, /Identity: owner\/one@shared-name/);
  assert.match(developer, /Destination Slot: shared-name/);
  assert.match(developer, /Installs: 10/);
});
