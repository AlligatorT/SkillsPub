import type { Home } from '../core.ts';
import type { SkillTarget } from '../inventory.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { cursorAdapter } from './cursor.ts';
import { grokAdapter } from './grok.ts';
import { hermesAdapter } from './hermes.ts';
import { opencodeAdapter } from './opencode.ts';
import { piAdapter } from './pi.ts';
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessOperation,
  HarnessOperationPlan,
} from './types.ts';

const adapters: readonly HarnessAdapter[] = [claudeAdapter, grokAdapter, piAdapter, codexAdapter, cursorAdapter, hermesAdapter, opencodeAdapter];

export function harnessAdapters(): readonly HarnessAdapter[] {
  return adapters;
}

function harnessAdapter(key: string): HarnessAdapter {
  const adapter = adapters.find((candidate) => candidate.key === key);
  if (!adapter) throw new Error(`unknown Harness: ${key}`);
  return adapter;
}

export function inspectHarness(
  key: string,
  home: Home,
  targets: SkillTarget[],
  projectPath?: string,
): HarnessInspection {
  return harnessAdapter(key).inspect(home, targets, projectPath);
}

export function planHarnessOperation(
  key: string,
  operation: HarnessOperation,
  home: Home,
  targets: SkillTarget[],
  projectPath?: string,
): HarnessOperationPlan {
  const adapter = harnessAdapter(key);
  const plan = adapter.operations?.[operation];
  if (!plan)
    throw new Error(`${adapter.name} does not support ${operation}; no configuration write is required.`);
  return plan(home, targets, projectPath);
}

export function inspectHarnesses(
  home: Home,
  targets: SkillTarget[],
  projectPath?: string,
): { detected: HarnessInspection[]; available: HarnessInspection[] } {
  const inspections = adapters.map((adapter) => adapter.inspect(home, targets, projectPath));
  return {
    detected: inspections.filter(({ detected }) => detected),
    available: inspections.filter(({ detected }) => !detected),
  };
}
