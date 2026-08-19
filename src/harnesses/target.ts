import type { SkillTarget, TargetScope } from '../inventory.ts';

export function resolveHarnessTarget(
  targets: Array<SkillTarget & { scope?: TargetScope }>,
  key: string,
  fallback: () => SkillTarget,
): SkillTarget {
  return targets.find((target) => target.key === key && target.scope === 'global')
    ?? targets.find((target) => target.key === key)
    ?? fallback();
}
