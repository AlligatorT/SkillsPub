import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
assert.ok(process.argv.length <= 3, 'usage: node scripts/check-package.mjs [candidate.tgz]');
const candidate = process.argv[2] ? path.resolve(root, process.argv[2]) : undefined;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'skillspub-package-'));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
}

function pack(destination) {
  fs.mkdirSync(destination);
  const [result] = parseJson(run('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    destination,
  ]), 'npm pack');
  return {
    archive: path.join(destination, result.filename),
    files: result.files.map(({ path: file }) => file).sort(),
  };
}

function runtimeFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory()
      ? runtimeFiles(path.join(directory, entry.name), relative)
      : [`dist/${relative}`];
  });
}

try {
  const manifest = parseJson(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    'package.json',
  );
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.bin?.skillspub, 'dist/cli.js');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.repository?.url, 'git+https://github.com/AlligatorT/SkillsPub.git');
  assert.equal(manifest.homepage, 'https://github.com/AlligatorT/SkillsPub');
  assert.equal(manifest.publishConfig?.access, 'public');
  assert.deepEqual(manifest.engines, { node: '>=22.20.0' });
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    'ink',
    'react',
    'smol-toml',
    'wrap-ansi',
  ]);
  assert.equal(manifest.devDependencies?.skills, '1.5.21');

  run('npm', ['run', 'build']);
  const entrypoint = path.join(root, manifest.bin.skillspub);
  assert.match(fs.readFileSync(entrypoint, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  const expected = [
    'LICENSE',
    'README.md',
    'package.json',
    ...runtimeFiles(path.join(root, 'dist')),
  ].sort();
  assert.ok(
    expected.filter((file) => file.startsWith('dist/')).every((file) => file.endsWith('.js')),
    'dist must contain emitted JavaScript only',
  );
  const first = pack(path.join(temporary, 'first'));
  run('npm', ['run', 'build']);
  const second = pack(path.join(temporary, 'second'));
  assert.deepEqual(first.files, expected, 'npm tarball contents changed');
  assert.deepEqual(second.files, expected, 'second npm tarball contents changed');

  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const verifiedDigest = digest(first.archive);
  assert.equal(verifiedDigest, digest(second.archive), 'npm tarball is not deterministic');
  if (candidate) {
    assert.ok(fs.existsSync(candidate), `candidate tarball does not exist: ${candidate}`);
    assert.equal(digest(candidate), verifiedDigest, 'candidate tarball differs from verified package');
  }

  const prefix = path.join(temporary, 'install');
  run('npm', ['install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', first.archive]);
  const bin = path.join(prefix, 'node_modules', '.bin', 'skillspub');
  const installedEntrypoint = path.join(prefix, 'node_modules', 'skillspub', manifest.bin.skillspub);
  assert.ok(fs.statSync(installedEntrypoint).mode & 0o111, 'installed CLI entrypoint must be executable');
  const isolated = path.join(temporary, 'config');
  const env = { ...process.env, HOME: temporary, SKILLSPUB_CONFIG_DIR: isolated };
  const launched = spawnSync(bin, [], { cwd: temporary, env, encoding: 'utf8' });
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stderr, /^SkillsPub/m);
  const result = parseJson(
    run(bin, ['targets', '--json'], { cwd: temporary, env }),
    'installed skillspub',
  );
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.data));

  process.stdout.write(
    `package verified: ${expected.length} files, sha256 ${verifiedDigest}${candidate ? ', candidate matched' : ''}\n`,
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
