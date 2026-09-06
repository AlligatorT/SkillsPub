import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
  .toString()
  .split('\0')
  .filter(Boolean);
const patterns = [
  ['private key', new RegExp(['BEGIN ', '(?:RSA |OPENSSH |EC )?', 'PRIVATE KEY'].join(''))],
  ['GitHub token', new RegExp(['gh', '[pousr]_[A-Za-z0-9_]{20,}'].join(''))],
  ['npm token', new RegExp(['npm', '_[A-Za-z0-9]{36,}'].join(''))],
  ['AWS access key', new RegExp(['AK', 'IA[0-9A-Z]{16}'].join(''))],
  ['Google API key', new RegExp(['AI', 'za[0-9A-Za-z_-]{35}'].join(''))],
  ['Slack token', new RegExp(['xo', 'x[baprs]-[0-9A-Za-z-]{20,}'].join(''))],
  ['macOS user path', /\/Users\/[A-Za-z0-9._-]+\//],
  ['Linux user path', /\/home\/[A-Za-z0-9._-]+\//],
];
const findings = [];

function parseJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch (error) {
    throw new Error(`${file} contains invalid JSON`, { cause: error });
  }
}

for (const file of tracked) {
  const content = fs.readFileSync(path.join(root, file));
  if (content.includes(0)) continue;
  const text = content.toString('utf8');
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) findings.push(`${file}: ${label}`);
  }
}
assert.deepEqual(findings, [], `tracked-file privacy/secret audit failed:\n${findings.join('\n')}`);

const manifest = parseJson('package.json');
const { harnessAdapters } = await import(
  pathToFileURL(path.join(root, 'dist', 'harnesses', 'registry.js')).href
);
assert.deepEqual(
  harnessAdapters()
    .map((adapter) => [adapter.key, adapter.targetDefinition().relationship.support])
    .sort(([left], [right]) => left.localeCompare(right)),
  [
    ['claude', 'managed'],
    ['grok', 'managed'],
    ['pi', 'discoverable'],
  ],
  'v0.1.0 Harness boundary changed',
);
const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
assert.equal(manifest.license, 'MIT');
assert.match(license, /^MIT License\n/);
assert.match(license, /Copyright \(c\) 2026 AlligatorT/);
assert.match(license, /Permission is hereby granted, free of charge/);

const lock = parseJson('package-lock.json');
const licenseProblems = Object.entries(lock.packages)
  .filter(([location, metadata]) => location && metadata.dev !== true)
  .flatMap(([location, metadata]) => {
    if (!metadata.license) return [`${location}: missing license metadata`];
    if (/\b(?:A?GPL)\b/i.test(metadata.license))
      return [`${location}: incompatible license ${metadata.license}`];
    return [];
  });
assert.deepEqual(licenseProblems, [], `runtime dependency license audit failed:\n${licenseProblems.join('\n')}`);

process.stdout.write(
  `release audit passed: ${tracked.length} tracked files, v0.1.0 Harness boundary and runtime dependency licenses checked\n`,
);
