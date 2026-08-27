#!/usr/bin/env node
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  UPDATE_FEED_SCHEMA,
  UPDATE_PAYLOAD_SCHEMA,
  buildPayloadManifest,
  buildReleaseFeed,
  canonicalJson,
  createSignedEnvelope,
  normalizeUpdatePath,
  sha256Bytes,
  verifySignedEnvelope,
} from './update/update-signing.mjs';
import { buildGitHubReleasePlan } from './update/github-release-plan.mjs';

const temp = mkdtempSync(path.join(os.tmpdir(), 'cqr-pa-secure-update-'));

try {
  mkdirSync(path.join(temp, 'core', 'dist'), { recursive: true });
  mkdirSync(path.join(temp, 'ui', 'workspace', 'dist'), { recursive: true });
  writeFileSync(path.join(temp, 'core', 'dist', 'main.js'), 'console.log("ok");\n');
  writeFileSync(path.join(temp, 'ui', 'workspace', 'dist', 'index.html'), '<main>ok</main>\n');

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const payload = buildPayloadManifest(temp, {
    updateSequence: 7,
    minimumSupportedSequence: 3,
    version: '0.9.1-beta',
    channel: 'beta',
    createdAt: '2026-08-25T00:00:00.000Z',
    deleted: ['core/dist/obsolete.js'],
  });
  assert.equal(payload.schema, UPDATE_PAYLOAD_SCHEMA);
  assert.equal(payload.files.length, 2);
  assert.deepEqual(
    payload.files.map((file) => file.path),
    ['core/dist/main.js', 'ui/workspace/dist/index.html'],
  );

  const payloadEnvelope = createSignedEnvelope(payload, privatePem);
  assert.equal(verifySignedEnvelope(payloadEnvelope, publicPem), true);
  const tamperedPayload = structuredClone(payloadEnvelope);
  tamperedPayload.document.update_sequence = 8;
  assert.equal(verifySignedEnvelope(tamperedPayload, publicPem), false);

  const payloadEnvelopeBytes = Buffer.from(`${JSON.stringify(payloadEnvelope, null, 2)}\n`);
  const assetSha = sha256Bytes(Buffer.from('zip fixture'));
  const feed = buildReleaseFeed({
    updateSequence: 7,
    minimumSupportedSequence: 3,
    version: '0.9.1-beta',
    channel: 'beta',
    publishedAt: payload.created_at,
    repository: 'moonhyun-cheol/myagent',
    releaseTag: 'update-7',
    assetName: 'MYAgent-v0.9.1-beta-delta.zip',
    assetSize: 11,
    assetSha256: assetSha,
    payloadManifestSha256: sha256Bytes(payloadEnvelopeBytes),
    releaseNotes: 'Fixture release',
  });
  assert.equal(feed.schema, UPDATE_FEED_SCHEMA);
  assert.equal(feed.asset.release_tag, 'update-7');
  const feedEnvelope = createSignedEnvelope(feed, privatePem);
  assert.equal(verifySignedEnvelope(feedEnvelope, publicPem), true);

  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, b: 3 } }),
    '{"a":{"b":3,"y":2},"z":1}',
  );
  assert.throws(() => normalizeUpdatePath('../data/vault/license.ocx'), /unsafe update path/);
  assert.throws(() => normalizeUpdatePath('C:\\Windows\\system32\\x.dll'), /unsafe update path/);
  assert.throws(() => normalizeUpdatePath('data/vault/license.ocx'), /protected update path/);
  assert.throws(() => normalizeUpdatePath('runtime/node/node.exe'), /protected update path/);
  assert.throws(
    () => buildReleaseFeed({
      updateSequence: 7,
      minimumSupportedSequence: 3,
      version: '0.9.1-beta',
      channel: 'beta',
      publishedAt: payload.created_at,
      repository: 'moonhyun-cheol/myagent',
      releaseTag: 'update-8',
      assetName: 'bad.zip',
      assetSize: 1,
      assetSha256: assetSha,
      payloadManifestSha256: sha256Bytes(payloadEnvelopeBytes),
    }),
    /release tag must be update-7/,
  );

  const releasePlan = buildGitHubReleasePlan({
    repository: feed.asset.repository,
    defaultBranch: 'main',
    channel: 'beta',
    updateSequence: feed.update_sequence,
    version: feed.version,
    zipPath: `C:\\release\\${feed.asset.name}`,
    feedPath: 'C:\\release\\update-feed-beta.json',
    releaseNotes: 'Fixture release',
  });
  assert.equal(releasePlan.tag, 'update-7');
  assert.equal(
    releasePlan.raw_feed_url,
    'https://raw.githubusercontent.com/moonhyun-cheol/myagent/main/channels/beta.json',
  );
  assert.equal(releasePlan.release_args.includes('--prerelease'), true);
  assert.throws(
    () => buildGitHubReleasePlan({
      repository: 'moonhyun-cheol/myagent',
      defaultBranch: '../main',
      channel: 'beta',
      updateSequence: 7,
      version: '0.9.1-beta',
      zipPath: 'payload.zip',
      feedPath: 'update-feed-beta.json',
    }),
    /unsafe GitHub default branch/,
  );

  console.log('verify-secure-update: ok');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
