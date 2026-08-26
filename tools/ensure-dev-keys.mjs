import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { missingFeatures, readLicenseFeatures, REQUIRED_LICENSE_FEATURES } from './deploy-parity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const privPath = path.join(root, 'tools', 'keys', 'license-private.pem');
const examplePath = path.join(root, 'data', 'vault', 'license.ocx.example');
const admin = path.join(root, 'tools', 'cqr-admin.mjs');

function runAdmin(args) {
  return spawnSync(process.execPath, [admin, ...args], { cwd: root, encoding: 'utf8' });
}

function exampleValid() {
  if (!existsSync(examplePath)) return false;
  const v = runAdmin(['verify', examplePath]);
  if (v.status !== 0) return false;
  const features = readLicenseFeatures(examplePath);
  return missingFeatures(features).length === 0;
}

const exampleOk = exampleValid();

let reason = null;
if (!existsSync(privPath)) reason = 'missing_private';
else if (!exampleOk) reason = 'stale_example';

const exampleFeatures = readLicenseFeatures(examplePath);
const incomplete =
  exampleFeatures && missingFeatures(exampleFeatures).length > 0
    ? missingFeatures(exampleFeatures)
    : null;
if (!reason && incomplete?.length) reason = 'incomplete_features';

if (!reason) {
  console.log('ensure-dev-keys OK');
  process.exit(0);
}

console.log(`ensure-dev-keys: ${reason} — running keygen and refreshing license.ocx.example`);

const keygen = runAdmin(['keygen']);
if (keygen.status !== 0) {
  console.error(keygen.stderr || keygen.stdout);
  process.exit(keygen.status ?? 1);
}

const issue = runAdmin([
  'issue',
  '--org',
  'dev',
  '--out',
  examplePath,
  '--days',
  '3650',
  '--features',
  REQUIRED_LICENSE_FEATURES.join(','),
]);
if (issue.status !== 0) {
  console.error(issue.stderr || issue.stdout);
  process.exit(issue.status ?? 1);
}

console.log('ensure-dev-keys OK');
