import os from 'node:os';
import path from 'node:path';
import type { TargetDefinition } from '../inventory.ts';

export function sharedTargetDefinition(): TargetDefinition {
  const home = os.homedir();
  return {
    key: 'shared',
    kind: 'shared',
    discoveryRoot: path.join(home, '.agents', 'skills'),
    parkingRoot: path.join(home, '.agents', '.skillspub-off', 'skills'),
    projectPath: '.agents/skills',
    lockFile: path.join(home, '.agents', '.skill-lock.json'),
  };
}
