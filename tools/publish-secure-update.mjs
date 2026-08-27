#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildReleaseFeed,
  createSignedEnvelope,
  sha256Bytes,
  sha256File,
  verifySignedEnvelope,
} from './update/update-signing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'deploy', 'output');
const productManifestPath = path.join(root, 'manifest.json');
const githubRepository = String(
  process.env.MY_AGENT_UPDATE_GITHUB_REPO ?? 'moonhyun-cheol/myagent',
).trim();
const privateKeyPath = path.resolve(
  process.env.MY_AGENT_UPDATE_SIGNING_KEY
  ?? path.join(root, 'tools', 'keys', 'update-private.pem'),
);
const publicKeyPath = path.join(root, 'core', 'config', 'defaults', 'update-public.pem');

function fail(message) {
  console.error(`publish-secure-update: ${message}`);
  process.exit(1);
}

if (!existsSync(privateKeyPath)) {
  fail(`update signing private key missing: ${privateKeyPath}`);
}
if (!existsSync(publicKeyPath)) {
  fail(`update signing public key missing: ${publicKeyPath}`);
}

const product = JSON.parse(readFileSync(productManifestPath, 'utf8'));
const updateSequence = Number(product.update_sequence);
const minimumSupportedSequence = Number(product.minimum_supported_sequence ?? 1);
const version = String(product.version ?? '').trim();
const channel = String(product.update_channel ?? product.build ?? 'beta').trim().toLowerCase();
if (!Number.isSafeInteger(updateSequence) || updateSequence < 1) {
  fail('manifest.json update_sequence must be a positive safe integer');
}
if (!Number.isSafeInteger(minimumSupportedSequence) || minimumSupportedSequence < 1) {
  fail('manifest.json minimum_supported_sequence must be a positive safe integer');
}
if (!version) fail('manifest.json version is required');

const privateKeyPem = readFileSync(privateKeyPath, 'utf8');
const publicKeyPem = readFileSync(publicKeyPath, 'utf8');
const probeEnvelope = createSignedEnvelope({ purpose: 'my-agent-update-key-check' }, privateKeyPem);
if (!verifySignedEnvelope(probeEnvelope, publicKeyPem)) {
  fail('update signing private/public keys do not match');
}

const preflightArgs = [path.join(root, 'tools', 'release-preflight.mjs')];
if (process.env.MY_AGENT_RELEASE_ALLOW_DIRTY === '1') preflightArgs.push('--allow-dirty');
const preflight = spawnSync(process.execPath, preflightArgs, {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (preflight.status !== 0) process.exit(preflight.status ?? 1);

const publish = spawnSync(process.execPath, [path.join(root, 'tools', 'publish-delta.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    MY_AGENT_SECURE_UPDATE: '1',
    MY_AGENT_BUILD_PREFLIGHT_DONE: '1',
    MY_AGENT_UPDATE_SIGNING_KEY: privateKeyPath,
  },
});
if (publish.status !== 0) process.exit(publish.status ?? 1);

const zipPath = path.join(outDir, `MYAgent-v${version}-delta.zip`);
const payloadEnvelopePath = path.join(outDir, 'delta-stage', 'update-payload.json');
if (!existsSync(zipPath)) fail(`delta zip missing: ${zipPath}`);
if (!existsSync(payloadEnvelopePath)) fail(`signed payload manifest missing: ${payloadEnvelopePath}`);

const payloadEnvelopeBytes = readFileSync(payloadEnvelopePath);
const payloadEnvelope = JSON.parse(payloadEnvelopeBytes.toString('utf8'));
if (!verifySignedEnvelope(payloadEnvelope, publicKeyPem)) {
  fail('generated payload manifest signature verification failed');
}
if (payloadEnvelope.document.update_sequence !== updateSequence) {
  fail('generated payload sequence does not match manifest.json');
}

const zipName = path.basename(zipPath);
const publishedAt = String(payloadEnvelope.document.created_at);
const feedDocument = buildReleaseFeed({
  updateSequence,
  minimumSupportedSequence,
  version,
  channel,
  publishedAt,
  repository: githubRepository,
  releaseTag: `update-${updateSequence}`,
  assetName: zipName,
  assetSize: statSync(zipPath).size,
  assetSha256: sha256File(zipPath),
  payloadManifestSha256: sha256Bytes(payloadEnvelopeBytes),
  releaseNotes: process.env.MY_AGENT_UPDATE_RELEASE_NOTES ?? '',
});
const feedEnvelope = createSignedEnvelope(feedDocument, privateKeyPem);
if (!verifySignedEnvelope(feedEnvelope, publicKeyPem)) {
  fail('generated feed signature verification failed');
}

const feedPath = path.join(outDir, `update-feed-${channel}.json`);
writeFileSync(feedPath, `${JSON.stringify(feedEnvelope, null, 2)}\n`, 'utf8');
writeFileSync(
  path.join(outDir, 'LATEST_SECURE_UPDATE.json'),
  `${JSON.stringify({
    channel,
    update_sequence: updateSequence,
    version,
    zip_path: zipPath,
    feed_path: feedPath,
    github_repository: githubRepository,
    github_release_tag: feedDocument.asset.release_tag,
    github_asset_name: feedDocument.asset.name,
  }, null, 2)}\n`,
  'utf8',
);

console.log('Secure update payload ->', zipPath);
console.log('Secure update feed    ->', feedPath);
