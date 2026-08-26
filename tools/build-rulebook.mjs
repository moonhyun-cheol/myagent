#!/usr/bin/env node
/**
 * Stitch rulebook docs into rulebook/docs/generated/RULEBOOK_MY_AGENT_MAIN_v{version}.md
 * Version from manifest.json. Called from build.mjs, publish, publish-delta.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'rulebook', 'docs');
const genDir = path.join(docsDir, 'generated');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version ?? '1.0.0';
const outName = `RULEBOOK_MY_AGENT_MAIN_v${version}.md`;
const outPath = path.join(genDir, outName);

const ORDER = [
  '00_PROJECT_BRIEF.md',
  '02_ALWAYS_ON_RULES.md',
  '01_CURRENT_STATUS.md',
];

function readIfExists(rel) {
  const p = path.join(docsDir, rel);
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8').trim();
}

function collectSpecs(subdir) {
  const base = path.join(docsDir, 'specs', subdir);
  if (!existsSync(base)) return [];
  const files = [];
  for (const name of readdirSync(base).sort()) {
    if (name.endsWith('.md')) files.push(path.join('specs', subdir, name));
  }
  return files;
}

function pruneOldGenerated(keepName) {
  if (!existsSync(genDir)) return;
  for (const name of readdirSync(genDir)) {
    if (name.startsWith('RULEBOOK_MY_AGENT_MAIN_v') && name !== keepName) {
      unlinkSync(path.join(genDir, name));
    }
  }
}

mkdirSync(genDir, { recursive: true });

const parts = [];
parts.push(`# MY Agent Rulebook (MAIN) v${version}\n`);
parts.push(`> Generated: ${new Date().toISOString().slice(0, 10)} — do not edit directly; edit rulebook/docs/*.md\n`);

for (const rel of ORDER) {
  const text = readIfExists(rel);
  if (text) parts.push('\n---\n\n' + text);
}

for (const sub of ['user-flow', 'technical', 'admin']) {
  for (const rel of collectSpecs(sub)) {
    const text = readIfExists(rel);
    if (text) parts.push('\n---\n\n' + text);
  }
}

const decisionsDir = path.join(docsDir, 'decisions');
if (existsSync(decisionsDir)) {
  for (const name of readdirSync(decisionsDir).sort()) {
    if (!name.endsWith('.md')) continue;
    const text = readIfExists(path.join('decisions', name));
    if (text) parts.push('\n---\n\n' + text);
  }
}

const index = readIfExists('03_RULE_INDEX.md');
if (index) parts.push('\n---\n\n' + index);

const changelog = readIfExists('changelog/CHANGELOG.md');
if (changelog) {
  const recent = changelog.split('\n---\n').slice(-1)[0] ?? changelog;
  parts.push('\n---\n\n' + recent.trim());
}

parts.push('\n---\n\n## 변경 이력\n\n');
parts.push(`- v${version}: manifest 동기화 generated 빌드\n`);

writeFileSync(outPath, parts.join('') + '\n', 'utf8');
pruneOldGenerated(outName);

console.log(`build-rulebook: ${outName}`);
