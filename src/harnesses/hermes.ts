import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHarnessTarget } from './target.ts';
import type { HarnessAdapter } from './types.ts';

/** Discoverable adapter: own Targets are manageable; Shared is opt-in, not required. */

const VERIFIED_VERSION = '0.21.3';
const EVIDENCE = [
  {
    url: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/skills',
    verifiedVersion: VERIFIED_VERSION,
    detail: 'Hermes primary skills are $HERMES_HOME/skills (default ~/.hermes/skills). Global Shared ~/.agents/skills is opt-in via skills.external_dirs. Project .hermes/skills and .agents/skills load only when the repo is trusted. Skill-folder symlinks are followed.',
  },
  {
    url: 'https://github.com/NousResearch/hermes-agent/blob/v2026.9.14/agent/skill_utils.py',
    verifiedVersion: VERIFIED_VERSION,
    detail: 'Loader get_skills_dir is HERMES_HOME/skills; get_external_skills_dirs is empty without config; PROJECT_SKILLS_SUBDIRS are .hermes/skills and .agents/skills behind trust; iter_skill_index_files uses os.walk(..., followlinks=True).',
  },
] as const;

function hermesHome(): string {
  return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
}

export const hermesAdapter: HarnessAdapter = {
  key: 'hermes',
  name: 'Hermes',
  targetDefinition() {
    const root = hermesHome();
    return {
      key: 'hermes',
      kind: 'harness',
      discoveryRoot: path.join(root, 'skills'),
      parkingRoot: path.join(root, '.skillspub-off', 'skills'),
      projectPath: '.hermes/skills',
      relationship: { support: 'discoverable', link: 'supported' },
    };
  },
  inspect(_home, targets, projectPath) {
    const hermesTarget = resolveHarnessTarget(targets, 'hermes', () => hermesAdapter.targetDefinition());
    const sharedTarget = targets.find(({ key }) => key === 'shared');
    const projectRoot = projectPath ? path.resolve(projectPath) : undefined;
    const detected = fs.existsSync(hermesTarget.discoveryRoot) ||
      fs.existsSync(path.dirname(hermesTarget.discoveryRoot)) ||
      Boolean(projectRoot && fs.existsSync(path.join(projectRoot, '.hermes')));
    return {
      key: 'hermes',
      name: 'Hermes',
      detected,
      support: 'discoverable',
      evidence: EVIDENCE,
      targets: [
        { scope: 'global', discoveryRoot: hermesTarget.discoveryRoot },
        ...(projectRoot ? [{
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, hermesTarget.projectPath),
        }] : []),
      ],
      roots: [
        {
          kind: 'harness',
          targetKey: 'hermes',
          scope: 'global',
          discoveryRoot: hermesTarget.discoveryRoot,
          consumption: 'consumed',
          reason: 'Hermes discovers $HERMES_HOME/skills as its primary skill root.',
        },
        ...(projectRoot ? [{
          kind: 'harness' as const,
          targetKey: 'hermes',
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, hermesTarget.projectPath),
          consumption: 'consumed' as const,
          reason: 'Hermes discovers project .hermes/skills when the repo is trusted.',
        }] : []),
        ...(sharedTarget ? [{
          kind: 'shared' as const,
          targetKey: 'shared',
          scope: 'global' as const,
          discoveryRoot: sharedTarget.discoveryRoot,
          consumption: 'excluded' as const,
          reason: 'Hermes does not scan the Shared Agent Skills root unless skills.external_dirs lists it.',
        }, ...(projectRoot ? [{
          kind: 'shared' as const,
          targetKey: 'shared',
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, sharedTarget.projectPath),
          consumption: 'unknown' as const,
          reason: 'Project .agents/skills loads only after hermes skills trust; SkillsPub does not own that launch/trust gate.',
        }] : [])] : []),
      ],
      sharedConsumption: {
        status: 'not-consumed',
        detail: 'Hermes does not scan the Shared Agent Skills root unless skills.external_dirs lists it; SkillsPub does not invent a block.',
      },
      isolation: {
        status: 'not-required',
        detail: 'Global Shared is opt-in via skills.external_dirs; no configuration write is required.',
      },
      link: { supported: true },
    };
  },
};
