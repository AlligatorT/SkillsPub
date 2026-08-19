import type { Home } from '../core.ts';
import type { SkillTarget, TargetDefinition, TargetScope } from '../inventory.ts';

type SupportLevel = 'managed' | 'discoverable' | 'unsupported';
type SharedConsumption = 'not-consumed' | 'required' | 'enabled' | 'excluded' | 'unknown';
export type HarnessOperation = 'setup' | 'reconcile';

export interface HarnessEvidence {
  url: string;
  verifiedVersion: string;
  detail: string;
}

interface ResolvedHarnessTarget {
  scope: Extract<TargetScope, 'global' | 'project'>;
  discoveryRoot: string;
}

export interface HarnessInspection {
  key: string;
  name: string;
  detected: boolean;
  support: SupportLevel;
  evidence: readonly HarnessEvidence[];
  targets: ResolvedHarnessTarget[];
  sharedConsumption: { status: SharedConsumption; detail: string };
  isolation: { status: 'not-required' | 'unmanaged' | 'managed' | 'drift'; detail: string };
  link: { supported: boolean };
}

export interface HarnessOperationPlan {
  title: string;
  lines: readonly string[];
  apply(): void;
  verify(): HarnessInspection;
}

export interface HarnessAdapter {
  key: string;
  name: string;
  targetDefinition(): TargetDefinition;
  inspect(home: Home, targets: SkillTarget[], projectPath?: string): HarnessInspection;
  operations?: Partial<Record<HarnessOperation, (
    home: Home,
    targets: SkillTarget[],
  ) => HarnessOperationPlan>>;
}
