#!/usr/bin/env node
/**
 * Compare the private 1.4 checkout against this core tree.
 * Ignores CRLF-only diffs. Prints where each real diff should be applied.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepRuleFor, loadPortKeepPolicy } from './port-keep-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = JSON.parse(readFileSync(path.join(root, 'repo-target.json'), 'utf8'));
const legacyRoot = path.resolve(
  process.env.MY_AGENT_LEGACY_ROOT
    || path.join(root, '..', target.legacy?.local_folder || 'CQR_PA'),
);

const KEEP = /^(core\/|ui\/workspace\/src\/|shell\/|tools\/|manifest\.json|install\.bat|activation-server\/|AGENTS\.md|README\.md|VERSION\.txt)/;
const ORG_HINT = /(brand_concept|market_research|org:|agent-module|prompt_concept|CQR_MARKET|CQR_BRAND|CQR_INTERNAL)/i;

function gitFiles(cwd) {
  const result = spawnSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 50_000_000 });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed in ${cwd}: ${result.stderr || result.status}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function norm(buf) {
  return buf.toString('utf8').replace(/\r\n/g, '\n');
}

function classify(relative) {
  if (ORG_HINT.test(relative)) return 'org';
  return 'core';
}

if (!existsSync(legacyRoot)) {
  console.error(`port-status: legacy checkout not found: ${legacyRoot}`);
  console.error('Set MY_AGENT_LEGACY_ROOT to the private 1.4 folder.');
  process.exit(1);
}

const legacyFiles = gitFiles(legacyRoot).filter((file) => KEEP.test(file));
const here = new Set(gitFiles(root));
const crlfOnly = [];
const missingHere = [];
const diffs = [];
const policy = loadPortKeepPolicy(root);

for (const file of legacyFiles) {
  const dest = path.join(root, file);
  if (!here.has(file) || !existsSync(dest)) {
    missingHere.push({ file, apply: classify(file) });
    continue;
  }
  const a = readFileSync(path.join(legacyRoot, file));
  const b = readFileSync(dest);
  if (Buffer.compare(a, b) === 0) continue;
  if (norm(a) === norm(b)) {
    crlfOnly.push(file);
    continue;
  }
  diffs.push({ file, apply: classify(file) });
}

function keepMeta(file) {
  const rule = keepRuleFor(file, policy);
  return rule ? { file, keep: rule.id, reason: rule.reason } : null;
}

const coreDiffs = diffs.filter((row) => row.apply === 'core');
const keepLocal = coreDiffs.map((row) => keepMeta(row.file)).filter(Boolean);
const keepIds = new Set(keepLocal.map((row) => row.file));
const applyCore = coreDiffs.filter((row) => !keepIds.has(row.file)).map((row) => row.file);
const missingCore = missingHere.filter((row) => row.apply === 'core');
const keepMissing = missingCore.map((row) => keepMeta(row.file)).filter(Boolean);
const keepMissingIds = new Set(keepMissing.map((row) => row.file));
const missingInCore = missingCore.filter((row) => !keepMissingIds.has(row.file)).map((row) => row.file);

const report = {
  schema: 'my-agent-port-status/v1',
  target: {
    role: target.role,
    version: target.version,
    update_sequence: target.update_sequence,
    github: target.github,
  },
  legacy: {
    root: legacyRoot,
    version: target.legacy?.version,
    update_sequence: target.legacy?.update_sequence,
    github: target.legacy?.github,
  },
  counts: {
    compared: legacyFiles.length,
    content_differ: diffs.length,
    crlf_only: crlfOnly.length,
    keep_local: keepLocal.length,
    apply_core: applyCore.length,
    missing_in_core: missingInCore.length,
  },
  keep_local: keepLocal,
  apply_core: applyCore,
  apply_org: [
    ...diffs.filter((row) => row.apply === 'org').map((row) => row.file),
    ...missingHere.filter((row) => row.apply === 'org').map((row) => row.file),
  ],
  missing_in_core: missingInCore,
};

console.log(JSON.stringify(report, null, 2));
console.log('');
console.log(`port-status: CQR_PA ${report.legacy.version} seq ${report.legacy.update_sequence} → ${report.target.github} ${report.target.version} seq ${report.target.update_sequence}`);
console.log(`keep local (policy):    ${report.keep_local.length}  (do not copy)`);
console.log(`content diffs for CORE: ${report.apply_core.length}  (apply in this repo)`);
console.log(`content diffs for ORG:  ${report.apply_org.length}  (apply in myagent-org agent-module/)`);
console.log(`CRLF-only ignored:      ${report.counts.crlf_only}`);
if (report.missing_in_core.length) {
  console.log(`legacy-only files:      ${report.missing_in_core.length}`);
}
