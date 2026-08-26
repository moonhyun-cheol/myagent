#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { verifySignedEnvelope } from './update/update-signing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'deploy', 'output');
const stageDir = path.join(outDir, 'delta-stage');
const product = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const sequence = Number(product.update_sequence);
const publicKeyPath = path.join(root, 'core', 'config', 'defaults', 'update-public.pem');

function fail(message) {
  console.error(`publish-update-bridge: ${message}`);
  process.exit(1);
}

if (sequence !== 1) {
  fail('the one-time bridge release must use manifest.json update_sequence 1');
}
if (!existsSync(publicKeyPath)) {
  fail('update-public.pem missing; run npm run admin:update-keygen first');
}

const publish = spawnSync(
  process.execPath,
  [path.join(root, 'tools', 'publish-secure-update.mjs')],
  { cwd: root, stdio: 'inherit', env: process.env },
);
if (publish.status !== 0) process.exit(publish.status ?? 1);

const requiredStageFiles = [
  'MYAgent.exe',
  'MYAgent.Updater.exe',
  'bin/cqr-pa/MYAgent.Updater.exe',
  'core/config/defaults/update-public.pem',
  'manifest.json',
  'update-payload.json',
];
for (const relative of requiredStageFiles) {
  if (!existsSync(path.join(stageDir, ...relative.split('/')))) {
    fail(`bridge payload missing: ${relative}`);
  }
}

const stagedProduct = JSON.parse(readFileSync(path.join(stageDir, 'manifest.json'), 'utf8'));
if (
  stagedProduct.update_sequence !== 1
  || !stagedProduct.update_repository
  || !stagedProduct.update_feed_url
) {
  fail('bridge manifest is missing update sequence/repository/feed configuration');
}

const payloadEnvelope = JSON.parse(readFileSync(path.join(stageDir, 'update-payload.json'), 'utf8'));
const publicPem = readFileSync(publicKeyPath, 'utf8');
if (!verifySignedEnvelope(payloadEnvelope, publicPem)) {
  fail('bridge payload signature verification failed');
}
const inventory = new Set(payloadEnvelope.document.files.map(file => file.path.toLowerCase()));
for (const relative of requiredStageFiles.filter(file => file !== 'update-payload.json')) {
  if (!inventory.has(relative.toLowerCase())) {
    fail(`signed bridge inventory missing: ${relative}`);
  }
}

const latest = JSON.parse(readFileSync(path.join(outDir, 'LATEST_SECURE_UPDATE.json'), 'utf8'));
const bridgeRecord = {
  kind: 'cqr-pa-update-bridge/v1',
  update_sequence: 1,
  version: stagedProduct.version,
  delta_zip: latest.zip_path,
  signed_feed: latest.feed_path,
  manual_install: 'Place the delta ZIP in the installed MY Agent folder and run UPDATE.bat once.',
  automatic_updates_begin_after: 1,
};
const bridgePath = path.join(outDir, 'LATEST_UPDATE_BRIDGE.json');
writeFileSync(bridgePath, `${JSON.stringify(bridgeRecord, null, 2)}\n`, 'utf8');
console.log('Bridge update ready ->', bridgePath);
console.log(bridgeRecord.manual_install);
