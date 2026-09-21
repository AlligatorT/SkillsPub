#!/usr/bin/env node
// harness-watch: compare each Harness adapter's verifiedVersion pins against
// upstream reality (npm latest / GitHub HEAD / docs content). Findings become
// GitHub issues (label: harness-watch); humans verify before bumping pins.
// Usage: node scripts/check-harness-upstream.mjs [--dry-run]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dryRun = process.argv.includes('--dry-run');
const hashesFile = path.join(root, 'scripts/harness-watch/hashes.json');

// Curated upstream source per adapter key (checked against src/harnesses/<key>.ts pins).
const UPSTREAM = {
  pi: { kind: 'npm', package: '@earendil-works/pi-coding-agent' },
  codex: { kind: 'npm', package: '@openai/codex' },
  opencode: { kind: 'npm', package: 'opencode-ai' },
  hermes: { kind: 'github-release', repo: 'NousResearch/hermes-agent' },
  grok: { kind: 'github-head', repo: 'xai-org/grok-build' },
};

async function fetchJson(url) {
  const headers = { 'user-agent': 'skillspub-harness-watch' };
  if (process.env.GITHUB_TOKEN && url.includes('api.github.com'))
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'skillspub-harness-watch' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.text();
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readAdapters() {
  const dir = path.join(root, 'src/harnesses');
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && !['registry.ts', 'target.ts', 'types.ts'].includes(file))
    .map((file) => {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      const consts = Object.fromEntries(
        [...source.matchAll(/const (VERIFIED_\w+) = '([^']+)'/g)].map((m) => [m[1], m[2]]),
      );
      const versions = [...new Set(
        [...source.matchAll(/verifiedVersion: (?:'([^']+)'|(\w+))/g)]
          .map((m) => m[1] ?? consts[m[2]]).filter(Boolean),
      )];
      const urls = [...source.matchAll(/url: (?:'([^']+)'|`([^`]+)`)/g)]
        .map((m) => (m[1] ?? m[2]).replace(/\$\{(\w+)\}/g, (_, name) => consts[name] ?? ''));
      const name = /name: '([^']+)'/.exec(source)?.[1] ?? file;
      return { key: file.replace(/\.ts$/, ''), name, versions, urls };
    });
}

// Pinned URLs are immutable; only watch mutable pages.
const PINNED = [
  /\/blob\/[0-9a-f]{40}\//, // commit-pinned blob
  /\/blob\/[^/]*\d[^/]*\//, // tag-pinned blob (tags carry digits)
  /\/releases\/tag\//,
  /\/commit\/[0-9a-f]{7,40}/,
];
const isMutableDocsUrl = (url) => !PINNED.some((pattern) => pattern.test(url));

async function checkVersion(adapter, findings) {
  const upstream = UPSTREAM[adapter.key];
  const pin = adapter.versions[0];
  if (!upstream || !pin) return;
  try {
    if (upstream.kind === 'npm') {
      const latest = (await fetchJson(
        `https://registry.npmjs.org/${upstream.package.replace('/', '%2f')}/latest`,
      )).version;
      if (latest !== pin) findings.push({
        kind: 'version-behind',
        detail: `adapter verified against \`${pin}\`, upstream npm latest is \`${latest}\``,
        url: `https://www.npmjs.com/package/${upstream.package}?activeTab=versions`,
      });
    } else if (upstream.kind === 'github-head') {
      const head = (await fetchJson(`https://api.github.com/repos/${upstream.repo}/commits/main`)).sha;
      if (!head.startsWith(pin) && !pin.startsWith(head)) findings.push({
        kind: 'revision-behind',
        detail: `adapter pinned to \`${pin.slice(0, 12)}\`, upstream main HEAD is \`${head.slice(0, 12)}\``,
        url: `https://github.com/${upstream.repo}/compare/${pin}...main`,
      });
    } else if (upstream.kind === 'github-release') {
      const tag = (await fetchJson(`https://api.github.com/repos/${upstream.repo}/releases/latest`)).tag_name;
      const pinnedTag = adapter.urls.map((u) => /\/blob\/(v[^/]+)\//.exec(u)?.[1]).find(Boolean);
      if (pinnedTag && tag !== pinnedTag) findings.push({
        kind: 'release-behind',
        detail: `adapter evidence pinned to \`${pinnedTag}\` (verifiedVersion \`${pin}\`), latest release is \`${tag}\``,
        url: `https://github.com/${upstream.repo}/releases`,
      });
    }
  } catch (error) {
    console.error(`warn: ${adapter.key} version check failed: ${error.message}`);
  }
}

async function checkDocs(adapter, hashes, findings) {
  for (const url of adapter.urls.filter(isMutableDocsUrl)) {
    let body;
    try {
      body = await fetchText(url);
    } catch (error) {
      console.error(`warn: ${adapter.key} docs fetch failed: ${error.message}`);
      continue;
    }
    const hash = sha256(body);
    if (!hashes[url]) {
      hashes[url] = hash; // first sighting becomes the baseline
      console.error(`seed: baseline hash recorded for ${url}`);
    } else if (hashes[url] !== hash) findings.push({
      kind: 'docs-changed',
      detail: `evidence page content changed since baseline \`${hashes[url].slice(0, 8)}\``,
      url,
    });
  }
}

function gh(args) {
  return execFileSync('gh', args, { cwd: root, encoding: 'utf8' });
}

function fileFindings(key, name, findings) {
  const open = JSON.parse(gh([
    'issue', 'list', '--label', 'harness-watch', '--state', 'open',
    '--search', `${key} in:title`, '--json', 'number,title',
  ]));
  const body = [
    `harness-watch detected upstream drift for **${name}** (${new Date().toISOString().slice(0, 10)}):`,
    '',
    ...findings.map((f) => `- **${f.kind}**: ${f.detail}\n  ${f.url}`),
    '',
    'Before bumping `verifiedVersion` or the docs baseline, verify the adapter against the upstream change (config schema, discovery roots, symlink/ignore semantics). See #204.',
  ].join('\n');
  if (open.length > 0) {
    gh(['issue', 'comment', String(open[0].number), '--body', body]);
    console.log(`comment: #${open[0].number} <- ${key}`);
  } else {
    const url = gh([
      'issue', 'create', '--title', `harness-watch: ${name} upstream drift (${key})`,
      '--label', 'harness-watch', '--label', 'needs-triage', '--body', body,
    ]).trim();
    console.log(`created: ${url}`);
  }
}

const hashes = fs.existsSync(hashesFile)
  ? JSON.parse(fs.readFileSync(hashesFile, 'utf8'))
  : {};
const adapters = readAdapters();
const allFindings = [];
for (const adapter of adapters) {
  const findings = [];
  await checkVersion(adapter, findings);
  await checkDocs(adapter, hashes, findings);
  if (findings.length > 0) allFindings.push({ adapter, findings });
}
fs.mkdirSync(path.dirname(hashesFile), { recursive: true });
fs.writeFileSync(hashesFile, `${JSON.stringify(hashes, null, 2)}\n`);

for (const { adapter, findings } of allFindings) {
  console.log(`\n${adapter.name} (${adapter.key}):`);
  for (const f of findings) console.log(`  [${f.kind}] ${f.detail}\n    ${f.url}`);
  if (!dryRun) fileFindings(adapter.key, adapter.name, findings);
}
console.log(`\n${allFindings.length === 0 ? 'ok: all pins match upstream' : `${allFindings.length} adapter(s) with findings`}${dryRun ? ' (dry-run, no issues filed)' : ''}`);
