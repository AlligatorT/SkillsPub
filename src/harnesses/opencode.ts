import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAdapter } from './claude.ts';
import { resolveHarnessTarget } from './target.ts';
import type { HarnessAdapter } from './types.ts';

/** Required-Shared pattern from #170 (Codex): discoverable + `required`, no isolation write. */

const VERIFIED_VERSION = '1.18.31';
const EVIDENCE = [
  {
    url: 'https://opencode.ai/docs/skills/',
    verifiedVersion: VERIFIED_VERSION,
    detail: 'OpenCode discovers skills in .opencode/skills and ~/.config/opencode/skills plus Claude-compatible .claude/skills and agent-compatible .agents/skills (global and project walk-up); symlinked skill folders are followed; no root-level exclusion setting exists.',
  },
  {
    url: 'https://github.com/sst/opencode/blob/v1.18.31/packages/opencode/src/skill/index.ts',
    verifiedVersion: VERIFIED_VERSION,
    detail: 'Loader scans config directories with {skill,skills}/**/SKILL.md (symlink: true) and external .claude/.agents roots; only the per-process OPENCODE_DISABLE_EXTERNAL_SKILLS and OPENCODE_DISABLE_CLAUDE_CODE_SKILLS environment flags disable external roots (runtime-flags.ts), so exclusion is launch-scoped, not a persistent configuration seam.',
  },
  {
    url: 'https://github.com/sst/opencode/blob/v1.18.31/packages/core/src/global.ts',
    verifiedVersion: VERIFIED_VERSION,
    detail: 'Global config directory resolves to OPENCODE_CONFIG_DIR or the XDG config home (default ~/.config) plus /opencode; external roots resolve against the user home.',
  },
] as const;

function opencodeConfigHome(): string {
  return process.env.OPENCODE_CONFIG_DIR ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
}

export const opencodeAdapter: HarnessAdapter = {
  key: 'opencode',
  name: 'OpenCode',
  targetDefinition() {
    const root = opencodeConfigHome();
    return {
      key: 'opencode',
      kind: 'harness',
      discoveryRoot: path.join(root, 'skills'),
      parkingRoot: path.join(root, '.skillspub-off', 'skills'),
      projectPath: '.opencode/skills',
      relationship: { support: 'discoverable', link: 'supported' },
    };
  },
  inspect(_home, targets, projectPath) {
    const opencodeTarget = resolveHarnessTarget(targets, 'opencode', () => opencodeAdapter.targetDefinition());
    const sharedTarget = targets.find(({ key }) => key === 'shared');
    const claudeTarget = resolveHarnessTarget(targets, 'claude', () => claudeAdapter.targetDefinition());
    const projectRoot = projectPath ? path.resolve(projectPath) : undefined;
    const detected = fs.existsSync(opencodeTarget.discoveryRoot) ||
      fs.existsSync(path.dirname(opencodeTarget.discoveryRoot)) ||
      Boolean(projectRoot && fs.existsSync(path.join(projectRoot, '.opencode')));
    return {
      key: 'opencode',
      name: 'OpenCode',
      detected,
      support: 'discoverable',
      evidence: EVIDENCE,
      targets: [
        { scope: 'global', discoveryRoot: opencodeTarget.discoveryRoot },
        ...(projectRoot ? [{
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, opencodeTarget.projectPath),
        }] : []),
      ],
      roots: [
        {
          kind: 'harness',
          targetKey: 'opencode',
          scope: 'global',
          discoveryRoot: opencodeTarget.discoveryRoot,
          consumption: 'consumed',
          reason: 'OpenCode discovers ~/.config/opencode/skills (OPENCODE_CONFIG_DIR/skills when set).',
        },
        ...(projectRoot ? [{
          kind: 'harness' as const,
          targetKey: 'opencode',
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, opencodeTarget.projectPath),
          consumption: 'consumed' as const,
          reason: 'OpenCode discovers project .opencode/skills while walking up to the worktree.',
        }] : []),
        ...(sharedTarget ? [{
          kind: 'shared' as const,
          targetKey: 'shared',
          scope: 'global' as const,
          discoveryRoot: sharedTarget.discoveryRoot,
          consumption: 'consumed' as const,
          reason: 'OpenCode discovers ~/.agents/skills; only the per-process OPENCODE_DISABLE_EXTERNAL_SKILLS flag can disable it.',
        }, ...(projectRoot ? [{
          kind: 'shared' as const,
          targetKey: 'shared',
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, sharedTarget.projectPath),
          consumption: 'consumed' as const,
          reason: 'OpenCode scans project and ancestor .agents/skills while walking up to the worktree.',
        }] : [])] : []),
        {
          kind: 'compatibility',
          targetKey: 'claude',
          scope: 'global',
          discoveryRoot: claudeTarget.discoveryRoot,
          consumption: 'consumed',
          reason: 'OpenCode discovers Claude-compatible ~/.claude/skills; only per-process environment flags can disable it.',
        },
        ...(projectRoot ? [{
          kind: 'compatibility' as const,
          targetKey: 'claude',
          scope: 'project' as const,
          discoveryRoot: path.join(projectRoot, claudeTarget.projectPath),
          consumption: 'consumed' as const,
          reason: 'OpenCode discovers Claude-compatible project .claude/skills while walking up to the worktree.',
        }] : []),
      ],
      sharedConsumption: {
        status: 'required',
        detail: 'OpenCode always reads the Shared Agent Skills directory; the only official exclusion is the per-process OPENCODE_DISABLE_EXTERNAL_SKILLS environment flag, which is launch-scoped. SkillsPub does not invent a block.',
      },
      isolation: {
        status: 'unmanaged',
        detail: 'No persistent configuration seam excludes Shared or Claude-compatible roots; per-skill permission rules are not Target isolation.',
      },
      link: { supported: true },
    };
  },
};
