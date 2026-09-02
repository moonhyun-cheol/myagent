#!/usr/bin/env node
/**
 * Core vs WorkKitLauncher GitHub releases must not share tag, feed, schema, or zip name.
 * MY Agent updater never lists zip names on a release; it follows channels/stable.json only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  coreUpdateTag,
  isCoreUpdateAssetName,
  isLauncherUpdateAssetName,
  launcherUpdateTag,
} from './update/github-release-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
}

const manifest = readJson('manifest.json');
const launcherManifest = readJson('launcher-manifest.json');
const coreFeed = readJson('channels/stable.json');
const launcherFeed = readJson('channels/launcher-stable.json');
const verifier = readFileSync(path.join(root, 'shell/CqrPa.Shell/UpdateFeedVerifier.cs'), 'utf8');
const polling = readFileSync(path.join(root, 'shell/CqrPa.Shell/UpdatePollingService.cs'), 'utf8');
const launcherPolling = readFileSync(
  path.join(root, 'shell/WorkKitLauncher/LauncherUpdatePollingService.cs'),
  'utf8',
);
const launcherVerifier = readFileSync(
  path.join(root, 'shell/WorkKitLauncher/LauncherUpdateFeedVerifier.cs'),
  'utf8',
);

const coreDoc = coreFeed.document;
const launcherDoc = launcherFeed.document;

assert.equal(coreDoc.schema, 'cqr-pa-update-feed/v1');
assert.equal(launcherDoc.schema, 'my-agent-launcher-feed/v1');
assert.equal(launcherDoc.kind, 'work-kit-launcher');
assert.notEqual(coreDoc.schema, launcherDoc.schema);

assert.match(String(manifest.update_feed_url), /\/channels\/stable\.json$/);
assert.match(String(launcherManifest.update_feed_url), /\/channels\/launcher-stable\.json$/);
assert.notEqual(manifest.update_feed_url, launcherManifest.update_feed_url);

const coreSeq = Number(coreDoc.update_sequence);
const launcherSeq = Number(launcherDoc.update_sequence);
assert.equal(coreDoc.asset.release_tag, coreUpdateTag(coreSeq));
assert.equal(launcherDoc.asset.release_tag, launcherUpdateTag(launcherSeq));
assert.notEqual(coreDoc.asset.release_tag, launcherDoc.asset.release_tag);

assert.equal(isCoreUpdateAssetName(coreDoc.asset.name), true, `core asset ${coreDoc.asset.name}`);
assert.equal(
  isLauncherUpdateAssetName(launcherDoc.asset.name),
  true,
  `launcher asset ${launcherDoc.asset.name}`,
);
assert.notEqual(coreDoc.asset.name, launcherDoc.asset.name);
assert.equal(isLauncherUpdateAssetName(coreDoc.asset.name), false);
assert.equal(isCoreUpdateAssetName(launcherDoc.asset.name), false);

assert.match(verifier, /cqr-pa-update-feed\/v1/);
assert.match(verifier, /update-\{sequence\}/);
assert.equal(verifier.includes('launcher-stable'), false);
assert.equal(verifier.includes('my-agent-launcher-feed'), false);
assert.equal(polling.includes('launcher-stable'), false);
assert.match(launcherVerifier, /my-agent-launcher-feed\/v1/);
assert.match(launcherPolling, /MY_AGENT_UPDATE_POLL_INTERVAL_MS/);
assert.equal(launcherPolling.includes('/system/update-gate'), false);
assert.equal(launcherPolling.includes('MYAgent.Updater'), false);

console.log(
  `verify-update-stream-isolation OK — core ${coreDoc.asset.release_tag}/${coreDoc.asset.name}`
  + ` vs launcher ${launcherDoc.asset.release_tag}/${launcherDoc.asset.name}`,
);
