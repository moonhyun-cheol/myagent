#!/usr/bin/env node
/**
 * Dev test env must match deploy activation env (features, policy, defaults).
 * Usage: node tools/verify-deploy-parity.mjs [--app-dir PATH] [--skip-dev-license]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeployParity, formatParityReport } from './deploy-parity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function getArg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

const appDir = path.resolve(getArg('--app-dir') ?? root);
const skipDevLicense = process.argv.includes('--skip-dev-license');

console.log('verify-deploy-parity: dev === deploy activation\n');

const result = checkDeployParity(root, { appDir, skipDevLicense });

for (const w of result.warnings) console.warn(w);
for (const e of result.errors) console.error(e);

if (!result.ok) {
  console.error('\nverify-deploy-parity FAILED');
  console.error(formatParityReport(result));
  console.error(
    '\nFix: activation-server/policy.json features, deploy-defaults.json URLs, license.ocx.example (npm run admin:issue)',
  );
  process.exit(1);
}

console.log('\nverify-deploy-parity OK — deploy PCs get same tool unlock as dev test');
process.exit(0);
