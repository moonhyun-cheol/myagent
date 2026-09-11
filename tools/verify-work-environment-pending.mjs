#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateWorkEnvironmentPending } from '../core/dist/system/work-environment-pending.js';
import { evaluateUpdateGate } from '../core/dist/system/update-gate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dispatch = readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8');
const shellPolling = readFileSync(path.join(root, 'shell/CqrPa.Shell/WorkEnvironmentUpdatePollingService.cs'), 'utf8');
const shellApp = readFileSync(path.join(root, 'shell/CqrPa.Shell/App.xaml.cs'), 'utf8');

assert.match(dispatch, /\/system\/work-environment\/pending/);
assert.match(dispatch, /evaluateWorkEnvironmentPending/);
assert.match(shellPolling, /\/system\/work-environment\/pending/);
assert.match(shellPolling, /\/system\/update-gate/);
assert.match(shellPolling, /MessageBoxButton\.YesNo/);
assert.equal(shellPolling.includes('--companion-update'), false);
assert.equal(shellPolling.includes('WorkKitLauncher.exe'), false);
assert.match(shellApp, /WorkEnvironmentUpdatePollingService/);

const gateBusy = evaluateUpdateGate({
  license: { getStatus: () => ({ mode: 'full' }) },
  personalScheduler: { countActiveRuns: () => 1 },
  personalSchedulerRuntime: { isBusy: () => true },
});
assert.equal(gateBusy.ready, false);
assert.ok(gateBusy.reasons.includes('scheduler_busy'));

const temp = mkdtempSync(path.join(os.tmpdir(), 'work-env-pending-'));
try {
  mkdirSync(path.join(temp, 'core', 'config', 'defaults'), { recursive: true });
  writeFileSync(path.join(temp, 'manifest.json'), JSON.stringify({ version: '1.0.3' }, null, 2));
  writeFileSync(path.join(temp, 'core', 'config', 'defaults', 'deploy-defaults.json'), JSON.stringify({
    work_kit_catalog_feed_url: null,
  }));
  const pending = await evaluateWorkEnvironmentPending(temp);
  assert.equal(pending.any_pending, false);
  assert.equal('launcher' in pending, false);
  assert.equal(pending.catalog.update_available, false);
  console.log('verify-work-environment-pending: catalog-only ok');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
