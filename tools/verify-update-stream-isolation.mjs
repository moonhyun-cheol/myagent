#!/usr/bin/env node
/** Core, organization module, and work-kit catalog remain separate streams. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreUpdateTag, isCoreUpdateAssetName } from './update/github-release-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
}

const manifest = readJson('manifest.json');
const coreFeed = readJson('channels/stable.json');
const verifier = readFileSync(path.join(root, 'shell/CqrPa.Shell/UpdateFeedVerifier.cs'), 'utf8');
const polling = readFileSync(path.join(root, 'shell/CqrPa.Shell/UpdatePollingService.cs'), 'utf8');
const deployDefaults = readJson('core/config/defaults/deploy-defaults.json');

const coreDoc = coreFeed.document;
assert.equal(coreDoc.schema, 'cqr-pa-update-feed/v1');

assert.match(String(manifest.update_feed_url), /\/channels\/stable\.json$/);
const coreSeq = Number(coreDoc.update_sequence);
assert.equal(coreDoc.asset.release_tag, coreUpdateTag(coreSeq));
assert.equal(isCoreUpdateAssetName(coreDoc.asset.name), true, `core asset ${coreDoc.asset.name}`);

assert.match(verifier, /cqr-pa-update-feed\/v1/);
assert.match(verifier, /update-\{sequence\}/);
assert.equal(verifier.includes('launcher-stable'), false);
assert.equal(verifier.includes('my-agent-launcher-feed'), false);
assert.equal(polling.includes('launcher-stable'), false);
assert.match(String(deployDefaults.organization_module_feed_url), /channels\//);
assert.match(String(deployDefaults.work_kit_catalog_feed_url), /work-kits\.json$/);
assert.notEqual(deployDefaults.organization_module_feed_url, deployDefaults.work_kit_catalog_feed_url);

console.log(`verify-update-stream-isolation OK — core + organization module + work-kit catalog; no launcher stream`);
