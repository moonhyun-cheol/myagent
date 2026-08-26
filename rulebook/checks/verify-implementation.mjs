#!/usr/bin/env node
/**
 * Rulebook implementation gate — owner final verification entry.
 * Runs packages A/B/C from rulebook/implementation/ then the full contract suite.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const record = process.argv.includes('--record');

function run(label, script, args = []) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `${label} failed with exit ${result.status}`);
}

run('package A — no undeclared telemetry', 'tools/verify-no-debug-telemetry.mjs');
run('package B — browser URL boundary (via contracts)', 'rulebook/checks/verify-contracts.mjs', record ? ['--record'] : []);
run('package C — in-app browser call path', 'tools/verify-in-app-browser-path.mjs');

console.log('\nrulebook implementation gate: PASS');
console.log('RC-006 desktop click remains manual — see rulebook/implementation/package-c-in-app-browser/MANUAL.md');
