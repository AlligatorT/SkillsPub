import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHarnessTarget } from './target.ts';
import type { HarnessAdapter } from './types.ts';

/** Required-Shared pattern: discoverable + `required`, no isolation write. */

const VERIFIED_VERSION = 'docs-2026-09-10';
const EVIDENCE = [
  {
    url: 'https://cursor.com/docs/skills',
    verifiedVersion: VERIFIED_VERSION,
    detail: 'Cursor loads ~/.cursor/skills, project .cursor/skills, ~/.agents/skills, and project .agents/skills. No root-level Shared exclusion is documented. Claude/Codex directories are compatibility roots, not Cursor-owned writable Targets.',
  },
  {
    url: 'https://cursor.com/help/customization/skills',
    verifiedVersion: VERIFIED_VERSION,
    detail: 'Help lists the same user and project roots, including global ~/.agents/skills. Bundled ~/.cursor/skills-cursor is Cursor-managed and is not a Skill Target.',
  },
] as const;

function cursorHome(): string {
  return path.join(os.homedir(), '.cursor');
}

export const cursorAdapter: HarnessAdapter = {
  key: 'cursor',
  name: 'Cursor',
  targetDefinition() {
    const root = cursorHome();
    return {
      key: 'cursor',
      kind: 'harness',
      discoveryRoot: path.join(root, 'skills'),
      parkingRoot: path.join(root, '.skillspub-off', 'skills'),
      projectPath: '.cursor/skills',
      relationship: { support: 'discoverable', link: 'supported' },
    };
  },
  inspect(_home, targets, projectPath) {
    const cursorTarget = resolveHarnessTarget(targets, 'cursor', () => cursorAdapter.targetDefinition());
    const sharedTarget = targets.find(({ key }) => key === 'shared');
    const projectRoot = projectPath ? path.resolve(projectPath) : undefined;
    const detected = fs.existsSync(cursorTarget.discoveryRoot) ||
      fs.existsSync(path.dirname(cursorTarget.discoveryRoot)) ||
      Boolean(projectRoot && fs.existsSync(path.join(projectRoot, '.cursor')));
    return {
      key: 'cursor',
      name: 'Cursor',
      detected,
      support: 'discoverable',
      evidence: EVIDENCE,
      targets: [
        { scope: 'global', discoveryRoot: cursorTarget.discoveryRoot },
        ...(projectRoot ? [{
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, cursorTarget.projectPath),
        }] : []),
      ],
      roots: [
        {
          kind: 'harness',
          targetKey: 'cursor',
          scope: 'global',
          discoveryRoot: cursorTarget.discoveryRoot,
          consumption: 'consumed',
          reason: 'Cursor discovers ~/.cursor/skills as a user skill root.',
        },
        ...(projectRoot ? [{
          kind: 'harness' as const,
          targetKey: 'cursor',
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, cursorTarget.projectPath),
          consumption: 'consumed' as const,
          reason: 'Cursor discovers project .cursor/skills.',
        }] : []),
        ...(sharedTarget ? [{
          kind: 'shared' as const,
          targetKey: 'shared',
          scope: 'global' as const,
          discoveryRoot: sharedTarget.discoveryRoot,
          consumption: 'consumed' as const,
          reason: 'Cursor loads user-level ~/.agents/skills; there is no official root-level exclusion.',
        }, ...(projectRoot ? [{
          kind: 'shared' as const,
          targetKey: 'shared',
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, sharedTarget.projectPath),
          consumption: 'consumed' as const,
          reason: 'Cursor loads project-level .agents/skills.',
        }] : [])] : []),
      ],
      sharedConsumption: {
        status: 'required',
        detail: 'Cursor always reads the Shared Agent Skills directory; SkillsPub does not invent a block.',
      },
      isolation: {
        status: 'unmanaged',
        detail: 'No official root-level Shared exclusion exists; third-party compatibility toggles are not Shared Target isolation.',
      },
      link: { supported: true },
    };
  },
};
