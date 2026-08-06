import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Home {
  configDir: string;
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function migrateLegacyConfig(configDir: string, legacyDir: string): void {
  if (configDir === legacyDir || !fs.existsSync(legacyDir)) return;
  fs.mkdirSync(configDir, { recursive: true });
  for (const entry of fs.readdirSync(legacyDir)) {
    const destination = path.join(configDir, entry);
    if (!lexists(destination))
      fs.cpSync(path.join(legacyDir, entry), destination, { recursive: true });
  }
}

export function defaultHome(options: { migrate?: boolean } = {}): Home {
  const configDir =
    process.env.SKILLSPUB_CONFIG_DIR ??
    path.join(os.homedir(), '.config', 'skillspub');
  // Migration-only: legacy data is copied into canonical config, never used directly.
  if (options.migrate !== false &&
    (process.env.SKM_CONFIG_DIR || !process.env.SKILLSPUB_CONFIG_DIR))
    migrateLegacyConfig(
      configDir,
      process.env.SKM_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'skm'),
    );
  return { configDir };
}
