#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const absent = [
  'launcher-manifest.json',
  'channels/launcher-stable.json',
  'core/src/updates/launcher-update-feed.ts',
  'tools/launcher-publish.mjs',
  'tools/publish-launcher-install.mjs',
  'tools/publish-launcher-update.mjs',
  'tools/publish-github-launcher-update.mjs',
  'tools/install/install-launcher.ps1',
  'shell/WorkKitLauncher/WorkKitLauncher.csproj',
  'ui/work-kit-launcher/package.json',
];
for (const rel of absent) assert.equal(existsSync(path.join(root, rel)), false, `${rel} must be removed`);

const packageDoc = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(Object.keys(packageDoc.scripts).some((name) => name.includes('launcher')), false);
const publish = readFileSync(path.join(root, 'tools/publish.mjs'), 'utf8');
assert.equal(publish.includes('publishWorkKitLauncher'), false);
assert.match(publish, /ui\/work-kit-launcher/);
assert.match(publish, /WorkKitLauncher\.exe/);
const delta = readFileSync(path.join(root, 'tools/publish-delta.mjs'), 'utf8');
for (const rel of ['WorkKitLauncher.exe', 'bin/work-kit-launcher', 'ui/work-kit-launcher', 'shell/WorkKitLauncher']) {
  assert.ok(delta.includes(`'${rel}'`), `delta deleted list missing ${rel}`);
}
const verifier = readFileSync(path.join(root, 'tools/verify-publish-bundle.mjs'), 'utf8');
assert.match(verifier, /removed launcher artifact is present/);
console.log('verify-work-kit-product-removal: launcher product/update/install paths removed; package exclusion and delta migration declared');
