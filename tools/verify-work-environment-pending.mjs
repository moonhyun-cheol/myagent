#!/usr/bin/env node
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateWorkEnvironmentPending } from '../core/dist/system/work-environment-pending.js';
import { evaluateUpdateGate } from '../core/dist/system/update-gate.js';
import { verifyLauncherFeedEnvelope } from '../core/dist/updates/launcher-update-feed.js';
import {
  LAUNCHER_FEED_SCHEMA,
  LAUNCHER_KIND,
  createSignedEnvelope,
  verifySignedEnvelope,
} from './update/update-signing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dispatch = readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8');
const shellPolling = readFileSync(path.join(root, 'shell/CqrPa.Shell/WorkEnvironmentUpdatePollingService.cs'), 'utf8');
const shellApp = readFileSync(path.join(root, 'shell/CqrPa.Shell/App.xaml.cs'), 'utf8');
const launcherApp = readFileSync(path.join(root, 'shell/WorkKitLauncher/App.xaml.cs'), 'utf8');

assert.match(dispatch, /\/system\/work-environment\/pending/);
assert.match(dispatch, /evaluateWorkEnvironmentPending/);
assert.match(shellPolling, /\/system\/work-environment\/pending/);
assert.match(shellPolling, /\/system\/update-gate/);
assert.match(shellPolling, /MessageBoxButton\.YesNo/);
assert.match(shellPolling, /--companion-update/);
assert.match(shellApp, /WorkEnvironmentUpdatePollingService/);
assert.match(launcherApp, /--companion-update/);

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

const temp = mkdtempSync(path.join(os.tmpdir(), 'work-env-pending-'));
try {
  mkdirSync(path.join(temp, 'core', 'config', 'defaults'), { recursive: true });
  writeFileSync(path.join(temp, 'manifest.json'), JSON.stringify({ version: '1.0.3' }, null, 2));
  writeFileSync(path.join(temp, 'launcher-manifest.json'), JSON.stringify({
    kind: LAUNCHER_KIND,
    version: '1.0.0',
    update_channel: 'stable',
    update_sequence: 1,
    minimum_supported_sequence: 1,
    update_repository: 'moonhyun-cheol/myagent',
    update_feed_url: 'https://example.test/channels/launcher-stable.json',
  }, null, 2));
  writeFileSync(path.join(temp, 'core', 'config', 'defaults', 'update-public.pem'), publicPem);

  const feedDocument = {
    schema: LAUNCHER_FEED_SCHEMA,
    kind: LAUNCHER_KIND,
    update_sequence: 2,
    minimum_supported_sequence: 1,
    version: '1.0.1',
    channel: 'stable',
    published_at: '2026-09-02T00:00:00.000Z',
    asset: {
      repository: 'moonhyun-cheol/myagent',
      release_tag: 'launcher-update-2',
      name: 'WorkKitLauncher-v1.0.1-update-2.zip',
      size: 123,
      sha256: 'a'.repeat(64),
    },
    release_notes: 'Fixture',
  };
  const envelope = createSignedEnvelope(feedDocument, privatePem);
  assert.equal(verifySignedEnvelope(envelope, publicPem), true);
  const verified = verifyLauncherFeedEnvelope(
    envelope,
    publicPem,
    'moonhyun-cheol/myagent',
    'stable',
  );
  assert.equal(verified.update_sequence, 2);

  const gateBusy = evaluateUpdateGate({
    license: { getStatus: () => ({ mode: 'full' }) },
    personalScheduler: { countActiveRuns: () => 1 },
    personalSchedulerRuntime: { isBusy: () => true },
  });
  assert.equal(gateBusy.ready, false);
  assert.ok(gateBusy.reasons.includes('scheduler_busy'));

  const pending = await evaluateWorkEnvironmentPending(temp);
  assert.equal(pending.any_pending, false);
  assert.equal(pending.launcher.update_available, false);

  console.log('verify-work-environment-pending: ok');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
