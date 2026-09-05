import type { Home } from '../core.ts';
import type {
  Activation,
  ResourceForm,
  SkillTarget,
  TargetDefinition,
  TargetScope,
} from '../inventory.ts';

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

export interface HarnessDiscoveryRoot {
  kind: 'harness' | 'shared' | 'compatibility';
  targetKey: string;
  scope: TargetScope;
  discoveryRoot: string;
  consumption: 'consumed' | 'excluded' | 'unknown';
  reason: string;
}

export interface HarnessInspection {
  key: string;
  name: string;
  detected: boolean;
  support: SupportLevel;
  evidence: readonly HarnessEvidence[];
  targets: ResolvedHarnessTarget[];
  roots: HarnessDiscoveryRoot[];
  sharedConsumption: { status: SharedConsumption; detail: string };
  isolation: { status: 'not-required' | 'unmanaged' | 'managed' | 'drift' | 'unknown'; detail: string };
  link: { supported: boolean };
  mirror?: { supported: boolean };
}

export interface HarnessRelationshipEffect {
  scope: TargetScope;
  targetId: string;
  targetKey: string;
  resourceId: string;
  name: string;
  slot: string;
  form: ResourceForm;
  activation: Activation;
  sourcePath: string;
  targetPath: string;
  plannedAction: 'unlink' | 'retain';
  sourcePreserved: true;
}

export interface HarnessRelationshipGroup {
  scope: TargetScope;
  targetId: string;
  targetKey: string;
  relationships: readonly HarnessRelationshipEffect[];
}

export interface HarnessRelationshipImpact {
  summary: {
    affectedRelationships: number;
    unlinkedRelationships: number;
    retainedRelationships: number;
    preservedSourceResources: number;
  };
  actual: {
    relationshipCount: number;
    isolation: HarnessInspection['isolation']['status'];
  };
  desired: {
    relationshipCount: number;
    isolation: 'managed';
  };
  drift: {
    relationships: readonly HarnessRelationshipEffect[];
    isolation: boolean;
  };
  groups: readonly HarnessRelationshipGroup[];
  configuration: {
    path: string;
    plannedAction: 'write' | 'retain';
    originalHash: string;
    backupPath: string;
  };
  recovery: {
    manifestPath: string;
    instructions: readonly string[];
  };
}

export interface HarnessOperationResult {
  inspection: HarnessInspection;
  actual: {
    unlinkedRelationships: number;
    retainedRelationships: number;
    preservedSourceResources: number;
  };
  desired: {
    unlinkedRelationships: number;
    retainedRelationships: number;
    preservedSourceResources: number;
  };
  drift: {
    relationships: readonly HarnessRelationshipEffect[];
    isolation: boolean;
  };
  isolation: HarnessInspection['isolation'];
  relationshipEffects: readonly (HarnessRelationshipEffect & {
    outcome: 'unlinked' | 'retained' | 'drift';
  })[];
  recovery: HarnessRelationshipImpact['recovery'] & {
    configBackupPreserved: boolean;
    manifestPreserved: boolean;
  };
}

export interface HarnessOperationPlan {
  title: string;
  lines: readonly string[];
  recovery?: readonly string[];
  relationshipImpact?: HarnessRelationshipImpact;
  apply(): void;
  verify(): HarnessInspection;
  result?(inspection: HarnessInspection): HarnessOperationResult;
}

export interface HarnessAdapter {
  key: string;
  name: string;
  targetDefinition(): TargetDefinition;
  inspect(home: Home, targets: SkillTarget[], projectPath?: string): HarnessInspection;
  operations?: Partial<Record<HarnessOperation, (
    home: Home,
    targets: SkillTarget[],
    projectPath?: string,
  ) => HarnessOperationPlan>>;
}
