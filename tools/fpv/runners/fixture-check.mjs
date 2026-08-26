#!/usr/bin/env node
/** Fixture contract check (required aliases on disk). */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OUT_DIR } from '../lib/paths.mjs';
import { checkFixtureContract } from '../lib/fixture-contract.mjs';

mkdirSync(OUT_DIR, { recursive: true });
const result = checkFixtureContract();
writeFileSync(path.join(OUT_DIR, 'fixture-contract.json'), `${JSON.stringify(result, null, 2)}\n`);

console.log('FPV fixture contract');
for (const r of result.rows) {
  const mark = r.ok ? 'OK' : r.tag === 'env-note' ? 'NOTE' : 'FAIL';
  console.log(`  [${mark}] ${r.key} → ${r.path || r.reason || r.tag}`);
}
if (!result.ok) {
  console.error('\nHard fails (env-red):');
  for (const f of result.hardFail) console.error(`  - ${f.key}: ${f.reason}`);
  process.exit(1);
}
console.log('\nok');
process.exit(0);
