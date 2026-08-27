#!/usr/bin/env node
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { publishUpdater } from './updater-publish.mjs';
import {
  buildPayloadManifest,
  buildReleaseFeed,
  createSignedEnvelope,
  sha256Bytes,
  sha256File,
} from './update/update-signing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const updaterOut = path.join(root, 'bin', 'cqr-pa-updater');
const published = publishUpdater({ root, outDir: updaterOut, label: 'verify-updater' });
assert.equal(published.ok, true, published.reason);

const temp = mkdtempSync(path.join(os.tmpdir(), 'cqr-pa-updater-'));
try {
  const payloadStage = path.join(temp, 'payload');
  const installRoot = path.join(temp, 'install');
  mkdirSync(path.join(payloadStage, 'core', 'dist'), { recursive: true });
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(path.join(payloadStage, 'core', 'dist', 'main.js'), 'console.log("fixture");\n');
  writeFileSync(path.join(payloadStage, 'core', 'dist', '업데이트.js'), 'console.log("한글");\n');

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPath = path.join(temp, 'update-public.pem');
  writeFileSync(publicKeyPath, publicPem);

  const payloadDocument = buildPayloadManifest(payloadStage, {
    updateSequence: 2,
    minimumSupportedSequence: 1,
    version: '0.9.1-beta',
    channel: 'beta',
    createdAt: '2026-08-26T00:00:00.000Z',
  });
  const payloadEnvelopePath = path.join(payloadStage, 'update-payload.json');
  writeFileSync(
    payloadEnvelopePath,
    `${JSON.stringify(createSignedEnvelope(payloadDocument, privatePem), null, 2)}\n`,
  );

  const zipPath = path.join(temp, 'fixture-update.zip');
  const zip = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `[IO.Compression.ZipFile]::CreateFromDirectory('${payloadStage.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}', [IO.Compression.CompressionLevel]::Optimal, $false, [Text.Encoding]::UTF8)`,
      ].join('; '),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(zip.status, 0, `${zip.stdout ?? ''}${zip.stderr ?? ''}`);

  const payloadEnvelopeBytes = readFileSync(payloadEnvelopePath);
  const feedDocument = buildReleaseFeed({
    updateSequence: 2,
    minimumSupportedSequence: 1,
    version: '0.9.1-beta',
    channel: 'beta',
    publishedAt: payloadDocument.created_at,
    repository: 'moonhyun-cheol/myagent',
    releaseTag: 'update-2',
    assetName: path.basename(zipPath),
    assetSize: statSync(zipPath).size,
    assetSha256: sha256File(zipPath),
    payloadManifestSha256: sha256Bytes(payloadEnvelopeBytes),
    releaseNotes: '한글 경로 서명 검증',
  });
  const feedPath = path.join(temp, 'update-feed-beta.json');
  writeFileSync(
    feedPath,
    `${JSON.stringify(createSignedEnvelope(feedDocument, privatePem), null, 2)}\n`,
  );

  const verify = spawnSync(
    published.executable,
    [
      '--root', installRoot,
      '--feed', feedPath,
      '--zip', zipPath,
      '--public-key', publicKeyPath,
      '--verify-only',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(verify.status, 0, `${verify.stdout ?? ''}${verify.stderr ?? ''}`);

  const tampered = JSON.parse(readFileSync(feedPath, 'utf8'));
  tampered.document.update_sequence = 3;
  const tamperedFeedPath = path.join(temp, 'tampered-feed.json');
  writeFileSync(tamperedFeedPath, `${JSON.stringify(tampered, null, 2)}\n`);
  const rejected = spawnSync(
    published.executable,
    [
      '--root', installRoot,
      '--feed', tamperedFeedPath,
      '--zip', zipPath,
      '--public-key', publicKeyPath,
      '--verify-only',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(rejected.status, 0, 'Updater must reject a tampered signed feed');
  assert.match(`${rejected.stdout ?? ''}${rejected.stderr ?? ''}`, /signature verification failed/i);

  console.log('verify-updater: ok');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
