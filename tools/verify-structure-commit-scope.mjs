#!/usr/bin/env node
/**
 * Block refactor(structure) staging that mixes intentional behavior-change files.
 * Usage:
 *   node tools/verify-structure-commit-scope.mjs
 *   node tools/verify-structure-commit-scope.mjs --staged
 * Exit 0 when no behavior allowlist paths are in the checked set.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Paths that must NOT appear in a refactor(structure) commit. */
export const BEHAVIOR_CHANGE_PATHS = [
  'core/src/agent/agent-work-mode.ts',
  'core/src/agent/agent-outcome-gate.ts',
  'core/src/agent/outcome-runtime.ts',
  'core/src/agent/agent-tool-protocol.ts',
  'core/config/defaults/deploy-defaults.json',
  'core/config/defaults/providers.json',
  'core/config/defaults/openwebui-model-curate.json',
  'data/vault/provider-keys.json',
];

function norm(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function listPaths(stagedOnly) {
  const args = stagedOnly
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR']
    : ['status', '--porcelain', '-u'];
  const out = execSync(`git ${args.join(' ')}`, { cwd: root, encoding: 'utf8' });
  if (stagedOnly) {
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map(norm);
  }
  const paths = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // porcelain: XY PATH or XY ORIG -> PATH
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    const p = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    paths.push(norm(p.replace(/^"|"$/g, '')));
  }
  return paths;
}

const stagedOnly = process.argv.includes('--staged');
const paths = listPaths(stagedOnly);
const hits = BEHAVIOR_CHANGE_PATHS.filter((b) =>
  paths.some((p) => p === b || p.endsWith(`/${b}`) || p.endsWith(b)),
);

if (hits.length) {
  console.error('verify-structure-commit-scope: FAIL — behavior paths in scope:');
  for (const h of hits) console.error(`  - ${h}`);
  console.error(
    stagedOnly
      ? 'Unstage these before refactor(structure), or use fix(*/chore(config) commits.'
      : 'Pass --staged to check the index only. Working tree still has mixed tracks (expected until split).',
  );
  process.exit(1);
}

console.log(
  `verify-structure-commit-scope: ok (${stagedOnly ? 'staged' : 'working-tree'} paths=${paths.length}, behavior hits=0)`,
);
