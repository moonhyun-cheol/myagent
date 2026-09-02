#!/usr/bin/env node
/**
 * Sign a WorkKitLauncher update zip + channels/launcher-stable.json feed.
 * Does not touch MY Agent core delta / channels/stable.json.
 *
 * Usage: node tools/publish-launcher-update.mjs [--skip-build] [--write-channel]
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { publishWorkKitLauncher } from './launcher-publish.mjs';
import { launcherUpdateTag } from './update/github-release-plan.mjs';
import {
  buildLauncherPayloadManifest,
  buildLauncherReleaseFeed,
  createSignedEnvelope,
  sha256Bytes,
  sha256File,
  verifySignedEnvelope,
} from './update/update-signing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'deploy', 'output');
const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const writeChannel = args.has('--write-channel');

const launcherManifestPath = path.join(root, 'launcher-manifest.json');
const launcherManifest = JSON.parse(readFileSync(launcherManifestPath, 'utf8'));
const githubRepository = String(
  process.env.MY_AGENT_UPDATE_GITHUB_REPO
  ?? launcherManifest.update_repository
  ?? 'moonhyun-cheol/myagent',
).trim();
const privateKeyPath = path.resolve(
  process.env.MY_AGENT_UPDATE_SIGNING_KEY
  ?? path.join(root, 'tools', 'keys', 'update-private.pem'),
);
const publicKeyPath = path.join(root, 'core', 'config', 'defaults', 'update-public.pem');

function fail(message) {
  console.error(`publish-launcher-update: ${message}`);
  process.exit(1);
}

if (!existsSync(privateKeyPath)) {
  fail(`update signing private key missing: ${privateKeyPath}`);
}
if (!existsSync(publicKeyPath)) {
  fail(`update signing public key missing: ${publicKeyPath}`);
}

const updateSequence = Number(launcherManifest.update_sequence);
const minimumSupportedSequence = Number(launcherManifest.minimum_supported_sequence ?? 1);
const version = String(launcherManifest.version ?? '').trim();
const channel = String(launcherManifest.update_channel ?? 'stable').trim().toLowerCase();
if (!Number.isSafeInteger(updateSequence) || updateSequence < 1) {
  fail('launcher-manifest.json update_sequence must be a positive safe integer');
}
if (!Number.isSafeInteger(minimumSupportedSequence) || minimumSupportedSequence < 1) {
  fail('launcher-manifest.json minimum_supported_sequence must be a positive safe integer');
}
if (!version) fail('launcher-manifest.json version is required');
if (launcherManifest.kind !== 'work-kit-launcher') {
  fail('launcher-manifest.json kind must be work-kit-launcher');
}

const privateKeyPem = readFileSync(privateKeyPath, 'utf8');
const publicKeyPem = readFileSync(publicKeyPath, 'utf8');
const probeEnvelope = createSignedEnvelope({ purpose: 'my-agent-launcher-update-key-check' }, privateKeyPem);
if (!verifySignedEnvelope(probeEnvelope, publicKeyPem)) {
  fail('update signing private/public keys do not match');
}

if (!skipBuild) {
  const published = publishWorkKitLauncher({ root, label: 'publish-launcher-update' });
  if (!published.ok) fail(published.reason);
}

const exePath = path.join(root, 'bin', 'work-kit-launcher', 'WorkKitLauncher.exe');
const webDirCandidates = [
  path.join(root, 'bin', 'work-kit-launcher', 'web'),
  path.join(root, 'ui', 'work-kit-launcher', 'dist'),
];
const webDir = webDirCandidates.find((dir) => existsSync(path.join(dir, 'index.html')));
if (!existsSync(exePath)) fail(`WorkKitLauncher.exe missing: ${exePath}`);
if (!webDir) fail('launcher UI index.html missing (bin/work-kit-launcher/web or ui/work-kit-launcher/dist)');

mkdirSync(outDir, { recursive: true });
const stageDir = path.join(outDir, 'launcher-update-stage');
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
cpSync(exePath, path.join(stageDir, 'WorkKitLauncher.exe'));
cpSync(launcherManifestPath, path.join(stageDir, 'launcher-manifest.json'));
cpSync(webDir, path.join(stageDir, 'web'), { recursive: true });

const createdAt = new Date().toISOString();
const payloadDocument = buildLauncherPayloadManifest(stageDir, {
  updateSequence,
  minimumSupportedSequence,
  version,
  channel,
  createdAt,
});
const payloadEnvelope = createSignedEnvelope(payloadDocument, privateKeyPem);
if (!verifySignedEnvelope(payloadEnvelope, publicKeyPem)) {
  fail('generated launcher payload signature verification failed');
}
const payloadEnvelopePath = path.join(stageDir, 'launcher-payload.json');
const payloadEnvelopeText = `${JSON.stringify(payloadEnvelope, null, 2)}\n`;
writeFileSync(payloadEnvelopePath, payloadEnvelopeText, 'utf8');

const zipName = `WorkKitLauncher-v${version}-update-${updateSequence}.zip`;
const zipPath = path.join(outDir, zipName);
rmSync(zipPath, { force: true });
const zip = spawnSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `[IO.Compression.ZipFile]::CreateFromDirectory('${stageDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}', [IO.Compression.CompressionLevel]::Optimal, $false, [Text.Encoding]::UTF8)`,
    ].join('; '),
  ],
  { encoding: 'utf8' },
);
if (zip.status !== 0) {
  fail(`zip failed: ${zip.stdout ?? ''}${zip.stderr ?? ''}`);
}

const feedDocument = buildLauncherReleaseFeed({
  updateSequence,
  minimumSupportedSequence,
  version,
  channel,
  publishedAt: createdAt,
  repository: githubRepository,
  releaseTag: launcherUpdateTag(updateSequence),
  assetName: zipName,
  assetSize: statSync(zipPath).size,
  assetSha256: sha256File(zipPath),
  payloadManifestSha256: sha256Bytes(Buffer.from(payloadEnvelopeText)),
  releaseNotes: process.env.MY_AGENT_LAUNCHER_UPDATE_RELEASE_NOTES
    ?? process.env.MY_AGENT_UPDATE_RELEASE_NOTES
    ?? '',
});
const feedEnvelope = createSignedEnvelope(feedDocument, privateKeyPem);
if (!verifySignedEnvelope(feedEnvelope, publicKeyPem)) {
  fail('generated launcher feed signature verification failed');
}

const feedPath = path.join(outDir, `launcher-feed-${channel}.json`);
const feedText = `${JSON.stringify(feedEnvelope, null, 2)}\n`;
writeFileSync(feedPath, feedText, 'utf8');
if (writeChannel) {
  const channelName = channel === 'stable' ? 'launcher-stable.json' : `launcher-${channel}.json`;
  writeFileSync(path.join(root, 'channels', channelName), feedText, 'utf8');
}

writeFileSync(
  path.join(outDir, 'LATEST_LAUNCHER_UPDATE.json'),
  `${JSON.stringify({
    kind: 'work-kit-launcher',
    channel,
    update_sequence: updateSequence,
    version,
    zip_path: zipPath,
    feed_path: feedPath,
    github_repository: githubRepository,
    github_release_tag: feedDocument.asset.release_tag,
    github_asset_name: feedDocument.asset.name,
    channel_written: writeChannel,
  }, null, 2)}\n`,
  'utf8',
);

console.log('Launcher update zip  ->', zipPath);
console.log('Launcher update feed ->', feedPath);
if (writeChannel) console.log('Wrote channels/launcher-stable.json (or launcher-{channel}.json)');
else console.log('Channel file left unchanged (pass --write-channel to replace channels/launcher-*.json)');
