#!/usr/bin/env node
/**
 * Copy shared engine files from the legacy CQR_PA checkout into this repo.
 * Product-owned paths are skipped per tools/port-keep-policy.json.
 * Usage: MY_AGENT_LEGACY_ROOT=/path/to/CQR_PA node tools/port-apply.mjs [--dry-run]
 */
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keepRuleFor, loadPortKeepPolicy } from './port-keep-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const policy = loadPortKeepPolicy(root);
const target = JSON.parse(readFileSync(path.join(root, 'repo-target.json'), 'utf8'));
const legacyRoot = path.resolve(
  process.env.MY_AGENT_LEGACY_ROOT
    || path.join(root, '..', target.legacy?.local_folder || 'CQR_PA'),
);

if (!existsSync(legacyRoot)) {
  console.error(`port-apply: legacy checkout not found: ${legacyRoot}`);
  process.exit(1);
}

const status = spawnSync(process.execPath, [path.join(root, 'tools', 'port-status.mjs')], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, MY_AGENT_LEGACY_ROOT: legacyRoot },
});
if (status.status !== 0) {
  console.error(status.stderr || status.stdout);
  process.exit(status.status ?? 1);
}
const report = JSON.parse(status.stdout.split('\n\n')[0]);
const extra = Array.isArray(policy.extra_from_legacy) ? policy.extra_from_legacy : [];
const candidates = [...new Set([...report.apply_core, ...report.missing_in_core, ...extra])];

let copied = 0;
let kept = 0;
let skipped = 0;
for (const file of candidates) {
  const rule = keepRuleFor(file, policy);
  if (rule) {
    kept += 1;
    console.log(`keep ${rule.id}: ${file}`);
    continue;
  }
  const src = path.join(legacyRoot, file);
  const dest = path.join(root, file);
  if (!existsSync(src)) {
    skipped += 1;
    console.log(`skip missing legacy: ${file}`);
    continue;
  }
  if (dryRun) {
    console.log(`would copy: ${file}`);
    copied += 1;
    continue;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest);
  console.log(`copied: ${file}`);
  copied += 1;
}

console.log(
  `port-apply: ${dryRun ? 'would copy' : 'copied'} ${copied}, kept ${kept} (policy), skipped missing ${skipped}`,
);
