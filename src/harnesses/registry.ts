import type { Home } from '../core.ts';
import type { SkillTarget } from '../inventory.ts';
import { piAdapter, type HarnessAdapter, type HarnessInspection } from './pi.ts';

const adapters: readonly HarnessAdapter[] = [piAdapter];

export function harnessAdapters(): readonly HarnessAdapter[] {
  return adapters;
}

export function inspectHarnesses(
  home: Home,
  targets: SkillTarget[],
  projectPath?: string,
): { detected: HarnessInspection[]; setup: HarnessInspection[] } {
  const inspections = adapters.map((adapter) => adapter.inspect(home, targets, projectPath));
  return {
    detected: inspections.filter(({ detected }) => detected),
    setup: inspections.filter(({ detected }) => !detected),
  };
}
