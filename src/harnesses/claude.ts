import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHarnessTarget } from './target.ts';
import type { HarnessAdapter } from './types.ts';

const EVIDENCE = [
  {
    url: 'https://docs.anthropic.com/en/docs/claude-code/skills',
    verifiedVersion: 'docs-2026-08-12',
    detail: 'Claude Code discovers personal and project skills in .claude/skills and supports symlinks.',
  },
  {
    url: 'https://docs.anthropic.com/en/docs/claude-code/settings',
    verifiedVersion: 'docs-2026-08-12',
    detail: 'Claude Code settings do not add the Shared Agent Skills directory.',
  },
] as const;

export const claudeAdapter: HarnessAdapter = {
  key: 'claude',
  name: 'Claude Code',
  targetDefinition() {
    const root = path.join(os.homedir(), '.claude');
    return {
      key: 'claude',
      kind: 'harness',
      discoveryRoot: path.join(root, 'skills'),
      parkingRoot: path.join(root, '.skillspub-off', 'skills'),
      projectPath: '.claude/skills',
      relationship: { support: 'managed', link: 'supported' },
    };
  },
  inspect(_home, targets, projectPath) {
    const claudeTarget = resolveHarnessTarget(targets, 'claude', () => claudeAdapter.targetDefinition());
    const sharedTarget = targets.find(({ key }) => key === 'shared');
    const projectRoot = projectPath ? path.resolve(projectPath) : undefined;
    const detected = fs.existsSync(claudeTarget.discoveryRoot) ||
      fs.existsSync(path.dirname(claudeTarget.discoveryRoot)) ||
      Boolean(projectRoot && fs.existsSync(path.join(projectRoot, '.claude')));
    return {
      key: 'claude',
      name: 'Claude Code',
      detected,
      support: 'managed',
      evidence: EVIDENCE,
      targets: [
        { scope: 'global', discoveryRoot: claudeTarget.discoveryRoot },
        ...(projectRoot ? [{
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, claudeTarget.projectPath),
        }] : []),
      ],
      roots: [
        {
          kind: 'harness',
          targetKey: 'claude',
          scope: 'global',
          discoveryRoot: claudeTarget.discoveryRoot,
          consumption: 'consumed',
          reason: 'Claude Code discovers its Global Skill Target.',
        },
        ...(projectRoot ? [{
          kind: 'harness' as const,
          targetKey: 'claude',
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, claudeTarget.projectPath),
          consumption: 'consumed' as const,
          reason: 'Claude Code discovers the exact Project Skill Target.',
        }] : []),
        ...(sharedTarget ? [{
          kind: 'shared' as const,
          targetKey: 'shared',
          scope: 'global' as const,
          discoveryRoot: sharedTarget.discoveryRoot,
          consumption: 'excluded' as const,
          reason: 'Claude Code does not consume the Shared Agent Skills root.',
        }, ...(projectRoot ? [{
          kind: 'shared' as const,
          targetKey: 'shared',
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, sharedTarget.projectPath),
          consumption: 'excluded' as const,
          reason: 'Claude Code does not consume the Project Shared Agent Skills root.',
        }] : [])] : []),
      ],
      sharedConsumption: {
        status: 'not-consumed',
        detail: 'Claude Code does not discover the Shared Agent Skills directory.',
      },
      isolation: {
        status: 'not-required',
        detail: 'No setup or Harness configuration write is required for independent visibility.',
      },
      link: { supported: true },
    };
  },
};
