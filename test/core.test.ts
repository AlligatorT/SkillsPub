import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultHome, migrateLegacyConfig } from '../src/core.ts';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-core-'));
}

test('migrateLegacyConfig copies legacy data without overwriting canonical files', () => {
  const root = tmpdir();
  const config = path.join(root, 'config');
  const legacy = path.join(root, 'legacy');
  fs.mkdirSync(path.join(legacy, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'state.json'), '{"tags":{}}');
  fs.writeFileSync(path.join(legacy, 'nested', 'data'), 'legacy');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'state.json'), '{"tags":{"x":["y"]}}');

  migrateLegacyConfig(config, legacy);

  assert.equal(
    fs.readFileSync(path.join(config, 'state.json'), 'utf8'),
    '{"tags":{"x":["y"]}}',
  );
  assert.equal(fs.readFileSync(path.join(config, 'nested', 'data'), 'utf8'), 'legacy');

  migrateLegacyConfig(config, config); // no-op on identical paths
  migrateLegacyConfig(config, path.join(root, 'missing')); // no-op when absent
});

test('defaultHome honors SKILLSPUB_CONFIG_DIR and migrates SKM legacy config', () => {
  const root = tmpdir();
  const config = path.join(root, 'config');
  const skm = path.join(root, 'skm');
  fs.mkdirSync(skm, { recursive: true });
  fs.writeFileSync(path.join(skm, 'runtimes.json'), '{"version":1,"runtimes":[]}');

  const env = { ...process.env, SKILLSPUB_CONFIG_DIR: config, SKM_CONFIG_DIR: skm };
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    const home = defaultHome();
    assert.deepEqual(home, { configDir: config });
    assert.equal(
      fs.readFileSync(path.join(config, 'runtimes.json'), 'utf8'),
      '{"version":1,"runtimes":[]}',
    );
  } finally {
    process.env = previous;
  }
});
