import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHarnessTarget } from './target.ts';
import type { HarnessAdapter } from './types.ts';

/** Required-Shared pattern for #171-#173: discoverable + `required`, no isolation write. */

const VERIFIED_VERSION = '0.154.0';
const EVIDENCE = [
  {
    url: 'https://developers.openai.com/codex/skills',
    verifiedVersion: VERIFIED_VERSION,
    detail: 'Codex canonical user skills are $HOME/.agents/skills; repository .agents/skills from CWD to repo root; no root-level Shared exclusion. Symlinked skill folders are followed.',
  },
  {
    url: 'https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/ext/skills/src/host_roots.rs',
    verifiedVersion: VERIFIED_VERSION,
    detail: 'Loader still consumes deprecated $CODEX_HOME/skills and project <config-folder>/skills in addition to $HOME/.agents/skills.',
  },
] as const;

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export const codexAdapter: HarnessAdapter = {
  key: 'codex',
  name: 'Codex',
  targetDefinition() {
    const root = codexHome();
    return {
      key: 'codex',
      kind: 'harness',
      discoveryRoot: path.join(root, 'skills'),
      parkingRoot: path.join(root, '.skillspub-off', 'skills'),
      projectPath: '.codex/skills',
      relationship: { support: 'discoverable', link: 'supported' },
    };
  },
  inspect(_home, targets, projectPath) {
    const codexTarget = resolveHarnessTarget(targets, 'codex', () => codexAdapter.targetDefinition());
    const sharedTarget = targets.find(({ key }) => key === 'shared');
    const projectRoot = projectPath ? path.resolve(projectPath) : undefined;
    const detected = fs.existsSync(codexTarget.discoveryRoot) ||
      fs.existsSync(path.dirname(codexTarget.discoveryRoot)) ||
      Boolean(projectRoot && fs.existsSync(path.join(projectRoot, '.codex')));
    return {
      key: 'codex',
      name: 'Codex',
      detected,
      support: 'discoverable',
      evidence: EVIDENCE,
      targets: [
        { scope: 'global', discoveryRoot: codexTarget.discoveryRoot },
        ...(projectRoot ? [{
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, codexTarget.projectPath),
        }] : []),
      ],
      roots: [
        {
          kind: 'harness',
          targetKey: 'codex',
          scope: 'global',
          discoveryRoot: codexTarget.discoveryRoot,
          consumption: 'consumed',
          reason: 'Codex still discovers deprecated $CODEX_HOME/skills as a user skill root.',
        },
        ...(projectRoot ? [{
          kind: 'harness' as const,
          targetKey: 'codex',
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, codexTarget.projectPath),
          consumption: 'consumed' as const,
          reason: 'Codex discovers project <config-folder>/skills (.codex/skills).',
        }] : []),
        ...(sharedTarget ? [{
          kind: 'shared' as const,
          targetKey: 'shared',
          scope: 'global' as const,
          discoveryRoot: sharedTarget.discoveryRoot,
          consumption: 'consumed' as const,
          reason: 'Codex canonical user skills are $HOME/.agents/skills; there is no official root-level exclusion.',
        }, ...(projectRoot ? [{
          kind: 'shared' as const,
          targetKey: 'shared',
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, sharedTarget.projectPath),
          consumption: 'consumed' as const,
          reason: 'Codex scans repository .agents/skills from CWD to the project root.',
        }] : [])] : []),
      ],
      sharedConsumption: {
        status: 'required',
        detail: 'Codex always reads the Shared Agent Skills directory; SkillsPub does not invent a block.',
      },
      isolation: {
        status: 'unmanaged',
        detail: 'No official root-level Shared exclusion exists; per-skill config is not treated as Target isolation.',
      },
      link: { supported: true },
    };
  },
};
