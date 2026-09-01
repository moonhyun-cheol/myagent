#!/usr/bin/env node
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { publishShell } from './shell-publish.mjs';
import {
  buildReleaseFeed,
  createSignedEnvelope,
  sha256Bytes,
} from './update/update-signing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFileSync(path.join(root, relative), 'utf8');
const appSource = read('shell/CqrPa.Shell/App.xaml.cs');
const serviceSource = read('shell/CqrPa.Shell/UpdateService.cs');
const verifierSource = read('shell/CqrPa.Shell/UpdateFeedVerifier.cs');
const singleInstanceSource = read('shell/CqrPa.Shell/SingleInstanceGuard.cs');
const updaterSource = read('shell/CqrPa.Updater/UpdateRunner.cs');
const processStopSource = read('shell/CqrPa.Updater/ProductProcessStop.cs');
const updaterUiSource = read('shell/CqrPa.Updater/UpdateApplyWindow.xaml');
const pollingSource = read('shell/CqrPa.Shell/UpdatePollingService.cs');
const dispatchSource = read('core/src/routes/dispatch.ts');
const updateGateSource = read('core/src/system/update-gate.ts');
assert.match(appSource, /ContentRendered/);
assert.match(appSource, /UpdatePollingService/);
assert.match(pollingSource, /MY_AGENT_UPDATE_POLL_INTERVAL_MS/);
assert.match(pollingSource, /\/system\/update-gate/);
assert.match(pollingSource, /PowerModeChanged/);
assert.match(pollingSource, /MessageBoxButton\.YesNo/);
assert.match(pollingSource, /LaunchUpdater/);
assert.match(pollingSource, /PrepareForUpdateExit/);
assert.match(
  pollingSource,
  /DisableCancel\(\)[\s\S]*AllowClose\(\)[\s\S]*PrepareForUpdateExit[\s\S]*LaunchUpdater[\s\S]*Shutdown\(0\)/,
);
assert.match(dispatchSource, /\/system\/update-gate/);
assert.match(dispatchSource, /\/system\/ui-busy/);
assert.match(updateGateSource, /agent_busy/);
assert.match(updateGateSource, /scheduler_busy/);
assert.match(updateGateSource, /automaton_background/);
assert.match(appSource, /SingleInstanceGuard/);
assert.match(singleInstanceSource, /TryBecomePrimary/);
assert.match(singleInstanceSource, /EventWaitHandle/);
assert.match(serviceSource, /MY_AGENT_UPDATE_TRUSTED_HOSTS/);
assert.match(serviceSource, /MY_AGENT_UPDATE_ASSET_URL_TEMPLATE/);
assert.match(serviceSource, /IsTrustedFeedHost/);
assert.match(serviceSource, /IsTrustedAssetHost/);
assert.match(serviceSource, /raw\.githubusercontent\.com/); // default allowlist (compat)
assert.match(serviceSource, /--parent-pid/);
assert.match(serviceSource, /CryptographicOperations\.FixedTimeEquals/);
assert.match(updaterSource, /ProductProcessStop\.StopAll/);
assert.match(updaterSource, /cqr_root/);
assert.match(processStopSource, /entireProcessTree: true/);
assert.match(processStopSource, /StopAllMyAgentProcesses/);
assert.match(processStopSource, /ShouldStopNodeOnPort/);
assert.match(processStopSource, /api-port\.json/);
assert.match(updaterUiSource, /MY Agent 업데이트/);
assert.match(updaterUiSource, /IsIndeterminate="True"/);
assert.match(verifierSource, /RSA-PSS-SHA256/);
assert.match(verifierSource, /RSASignaturePadding\.Pss/);

const shellOut = path.join(root, 'bin', 'my-agent');
const published = publishShell({
  root,
  projPath: path.join(root, 'shell', 'CqrPa.Shell', 'CqrPa.Shell.csproj'),
  outDir: shellOut,
  label: 'verify-shell-update',
});
assert.equal(published.ok, true, published.reason);

const temp = mkdtempSync(path.join(os.tmpdir(), 'my-agent-shell-update-'));
try {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPath = path.join(temp, 'update-public.pem');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(publicKeyPath, publicPem);

  const feed = buildReleaseFeed({
    updateSequence: 2,
    minimumSupportedSequence: 1,
    version: '0.9.1-beta',
    channel: 'beta',
    publishedAt: '2026-08-26T00:00:00.000Z',
    repository: 'moonhyun-cheol/MY_CUSTOM_CODEX',
    releaseTag: 'update-2',
    assetName: 'MYAgent-v0.9.1-beta-delta.zip',
    assetSize: 123,
    assetSha256: sha256Bytes(Buffer.from('asset')),
    payloadManifestSha256: sha256Bytes(Buffer.from('payload')),
    releaseNotes: '한글 업데이트 안내',
  });
  const feedPath = path.join(temp, 'update-feed-beta.json');
  writeFileSync(
    feedPath,
    `${JSON.stringify(createSignedEnvelope(feed, privatePem), null, 2)}\n`,
  );

  const executable = path.join(shellOut, 'MYAgent.exe');
  const commandArgs = [
    '--verify-update-feed',
    '--feed', feedPath,
    '--public-key', publicKeyPath,
    '--repository', 'moonhyun-cheol/MY_CUSTOM_CODEX',
    '--channel', 'beta',
  ];
  const verified = spawnSync(executable, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MY_AGENT_ROOT: root },
  });
  assert.equal(verified.status, 0, `${verified.stdout ?? ''}${verified.stderr ?? ''}`);

  const tampered = JSON.parse(readFileSync(feedPath, 'utf8'));
  tampered.document.version = '9.9.9';
  const tamperedPath = path.join(temp, 'tampered-feed.json');
  writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
  const rejected = spawnSync(
    executable,
    commandArgs.map(value => value === feedPath ? tamperedPath : value),
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, MY_AGENT_ROOT: root },
    },
  );
  assert.notEqual(rejected.status, 0, 'WPF shell must reject a tampered update feed');

  console.log('verify-shell-update: ok');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
