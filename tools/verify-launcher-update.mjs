#!/usr/bin/env node
/**
 * R-617: launcher feed signing, zip hash, polling/apply isolation from core updater.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  LAUNCHER_FEED_SCHEMA,
  LAUNCHER_KIND,
  LAUNCHER_PAYLOAD_SCHEMA,
  UPDATE_FEED_SCHEMA,
  buildLauncherPayloadManifest,
  buildLauncherReleaseFeed,
  buildReleaseFeed,
  createSignedEnvelope,
  normalizeLauncherUpdatePath,
  sha256Bytes,
  sha256File,
  verifySignedEnvelope,
} from './update/update-signing.mjs';
import {
  buildGitHubLauncherReleasePlan,
  coreUpdateTag,
  isCoreUpdateAssetName,
  isLauncherUpdateAssetName,
  launcherUpdateTag,
} from './update/github-release-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

const appSource = read('shell/WorkKitLauncher/App.xaml.cs');
const serviceSource = read('shell/WorkKitLauncher/LauncherUpdateService.cs');
const verifierSource = read('shell/WorkKitLauncher/LauncherUpdateFeedVerifier.cs');
const pollingSource = read('shell/WorkKitLauncher/LauncherUpdatePollingService.cs');
const applierSource = read('shell/WorkKitLauncher/LauncherUpdateApplier.cs');
const coreVerifier = read('shell/CqrPa.Shell/UpdateFeedVerifier.cs');
const corePolling = read('shell/CqrPa.Shell/UpdatePollingService.cs');
const coreUpdater = read('shell/CqrPa.Updater/UpdateRunner.cs');

assert.match(appSource, /LauncherUpdatePollingService/);
assert.match(appSource, /--verify-launcher-feed/);
assert.match(appSource, /--apply-update/);
assert.match(appSource, /ContentRendered/);
assert.match(pollingSource, /MY_AGENT_UPDATE_POLL_INTERVAL_MS/);
assert.match(pollingSource, /PowerModeChanged/);
assert.match(pollingSource, /MessageBoxButton\.YesNo/);
assert.equal(pollingSource.includes('/system/update-gate'), false);
assert.equal(pollingSource.includes('MYAgent.Updater'), false);
assert.equal(pollingSource.includes('ProductProcessStop'), false);
assert.match(serviceSource, /launcher-manifest\.json/);
assert.match(serviceSource, /MY_AGENT_UPDATE_CHECK/);
assert.match(serviceSource, /CryptographicOperations\.FixedTimeEquals/);
assert.match(serviceSource, /MY_AGENT_UPDATE_TRUSTED_HOSTS/);
assert.match(verifierSource, /my-agent-launcher-feed\/v1/);
assert.match(verifierSource, /work-kit-launcher/);
assert.match(readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8'), /sendLauncherIndex/);
assert.match(readFileSync(path.join(root, 'core/src/routes/dispatch.ts'), 'utf8'), /\/launcher\/assets\//);
assert.match(verifierSource, /launcher-update-\{sequence\}/);
assert.match(verifierSource, /RSASignaturePadding\.Pss/);
assert.match(applierSource, /WorkKitLauncher\.exe/);
assert.match(applierSource, /myagent\.exe/);
assert.equal(applierSource.includes('ProductProcessStop'), false);
assert.equal(applierSource.includes('MYAgent.Updater'), false);
assert.equal(applierSource.includes('StopAllMyAgentProcesses'), false);

assert.match(coreVerifier, /cqr-pa-update-feed\/v1/);
assert.equal(coreVerifier.includes('my-agent-launcher-feed'), false);
assert.equal(corePolling.includes('launcher-stable'), false);
assert.match(coreUpdater, /ProductProcessStop\.StopAll/);

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

assert.throws(
  () => normalizeLauncherUpdatePath('MYAgent.exe'),
  /cannot include/,
);
assert.throws(
  () => normalizeLauncherUpdatePath('core/dist/main.js'),
  /core files/,
);
assert.throws(
  () => normalizeLauncherUpdatePath('manifest.json'),
  /product manifest/,
);
assert.equal(normalizeLauncherUpdatePath('WorkKitLauncher.exe'), 'WorkKitLauncher.exe');
assert.equal(normalizeLauncherUpdatePath('web/index.html'), 'web/index.html');

const temp = mkdtempSync(path.join(os.tmpdir(), 'launcher-update-'));
try {
  mkdirSync(path.join(temp, 'web', 'assets'), { recursive: true });
  writeFileSync(path.join(temp, 'WorkKitLauncher.exe'), 'new-launcher-bytes\n');
  writeFileSync(path.join(temp, 'launcher-manifest.json'), '{"kind":"work-kit-launcher","update_sequence":2}\n');
  writeFileSync(path.join(temp, 'web', 'index.html'), '<main>launcher</main>\n');
  writeFileSync(path.join(temp, 'web', 'assets', 'app.js'), 'console.log(1)\n');

  const payload = buildLauncherPayloadManifest(temp, {
    updateSequence: 2,
    minimumSupportedSequence: 1,
    version: '1.0.0',
    channel: 'stable',
    createdAt: '2026-09-02T00:00:00.000Z',
  });
  assert.equal(payload.schema, LAUNCHER_PAYLOAD_SCHEMA);
  assert.equal(payload.kind, LAUNCHER_KIND);
  assert.ok(payload.files.some((file) => file.path === 'WorkKitLauncher.exe'));
  assert.ok(payload.files.some((file) => file.path === 'web/index.html'));
  assert.equal(payload.files.some((file) => /myagent/i.test(file.path)), false);

  const payloadEnvelope = createSignedEnvelope(payload, privatePem);
  assert.equal(verifySignedEnvelope(payloadEnvelope, publicPem), true);
  const payloadBytes = Buffer.from(`${JSON.stringify(payloadEnvelope, null, 2)}\n`);
  const assetSha = sha256Bytes(Buffer.from('zip fixture'));
  const feed = buildLauncherReleaseFeed({
    updateSequence: 2,
    minimumSupportedSequence: 1,
    version: '1.0.0',
    channel: 'stable',
    publishedAt: payload.created_at,
    repository: 'moonhyun-cheol/myagent',
    releaseTag: 'launcher-update-2',
    assetName: 'WorkKitLauncher-v1.0.0-update-2.zip',
    assetSize: 11,
    assetSha256: assetSha,
    payloadManifestSha256: sha256Bytes(payloadBytes),
    releaseNotes: 'Launcher fixture',
  });
  assert.equal(feed.schema, LAUNCHER_FEED_SCHEMA);
  assert.equal(feed.kind, LAUNCHER_KIND);
  assert.equal(feed.asset.release_tag, launcherUpdateTag(2));
  assert.equal(isLauncherUpdateAssetName(feed.asset.name), true);
  assert.equal(isCoreUpdateAssetName(feed.asset.name), false);

  assert.throws(
    () => buildLauncherReleaseFeed({
      updateSequence: 2,
      minimumSupportedSequence: 1,
      version: '1.0.0',
      channel: 'stable',
      publishedAt: payload.created_at,
      repository: 'moonhyun-cheol/myagent',
      releaseTag: 'update-2',
      assetName: 'WorkKitLauncher-v1.0.0-update-2.zip',
      assetSize: 11,
      assetSha256: assetSha,
      payloadManifestSha256: sha256Bytes(payloadBytes),
    }),
    /launcher-update-2/,
  );
  assert.throws(
    () => buildReleaseFeed({
      updateSequence: 2,
      minimumSupportedSequence: 1,
      version: '1.0.0',
      channel: 'stable',
      publishedAt: payload.created_at,
      repository: 'moonhyun-cheol/myagent',
      releaseTag: 'launcher-update-2',
      assetName: 'MYAgent-v1.0.0-delta.zip',
      assetSize: 11,
      assetSha256: assetSha,
      payloadManifestSha256: sha256Bytes(payloadBytes),
    }),
    /release tag must be update-2/,
  );
  assert.equal(coreUpdateTag(2), 'update-2');

  const launcherPlan = buildGitHubLauncherReleasePlan({
    repository: 'moonhyun-cheol/myagent',
    defaultBranch: 'main',
    channel: 'stable',
    updateSequence: 2,
    version: '1.0.0',
    zipPath: 'C:\\release\\WorkKitLauncher-v1.0.0-update-2.zip',
    feedPath: 'C:\\release\\launcher-feed-stable.json',
    releaseNotes: 'Launcher fixture',
  });
  assert.equal(launcherPlan.tag, 'launcher-update-2');
  assert.equal(launcherPlan.raw_feed_url.endsWith('/channels/launcher-stable.json'), true);
  assert.equal(launcherPlan.release_args.includes('update-2'), false);

  const feedPath = path.join(temp, 'launcher-feed-stable.json');
  writeFileSync(feedPath, `${JSON.stringify(createSignedEnvelope(feed, privatePem), null, 2)}\n`);

  const built = buildLauncher();
  const publicKeyPath = path.join(temp, 'update-public.pem');
  writeFileSync(publicKeyPath, publicPem);
  const verified = spawnSync(
    built,
    [
      '--verify-launcher-feed',
      '--feed', feedPath,
      '--public-key', publicKeyPath,
      '--repository', 'moonhyun-cheol/myagent',
      '--channel', 'stable',
    ],
    { cwd: root, encoding: 'utf8', env: { ...process.env, MY_AGENT_ROOT: root } },
  );
  assert.equal(verified.status, 0, `verify-launcher-feed failed: ${verified.stdout ?? ''}${verified.stderr ?? ''}`);

  const tampered = JSON.parse(readFileSync(feedPath, 'utf8'));
  tampered.document.version = '9.9.9';
  const tamperedPath = path.join(temp, 'tampered-feed.json');
  writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
  const rejected = spawnSync(
    built,
    [
      '--verify-launcher-feed',
      '--feed', tamperedPath,
      '--public-key', publicKeyPath,
      '--repository', 'moonhyun-cheol/myagent',
      '--channel', 'stable',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.notEqual(rejected.status, 0, 'launcher must reject a tampered feed');

  const coreFeed = buildReleaseFeed({
    updateSequence: 2,
    minimumSupportedSequence: 1,
    version: '1.0.0',
    channel: 'stable',
    publishedAt: payload.created_at,
    repository: 'moonhyun-cheol/myagent',
    releaseTag: 'update-2',
    assetName: 'MYAgent-v1.0.0-delta.zip',
    assetSize: 11,
    assetSha256: assetSha,
    payloadManifestSha256: sha256Bytes(payloadBytes),
  });
  const coreFeedPath = path.join(temp, 'core-feed.json');
  writeFileSync(coreFeedPath, `${JSON.stringify(createSignedEnvelope(coreFeed, privatePem), null, 2)}\n`);
  const coreAsLauncher = spawnSync(
    built,
    [
      '--verify-launcher-feed',
      '--feed', coreFeedPath,
      '--public-key', publicKeyPath,
      '--repository', 'moonhyun-cheol/myagent',
      '--channel', 'stable',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.notEqual(coreAsLauncher.status, 0, 'launcher verifier must reject a core feed');

  const installRoot = path.join(temp, 'install');
  mkdirSync(path.join(installRoot, 'core', 'dist'), { recursive: true });
  writeFileSync(path.join(installRoot, 'manifest.json'), '{"version":"1.0.3","update_sequence":20}\n');
  writeFileSync(path.join(installRoot, 'MYAgent.exe'), 'core-sentinel\n');
  writeFileSync(path.join(installRoot, 'WorkKitLauncher.exe'), 'old-launcher\n');
  writeFileSync(path.join(installRoot, 'core', 'dist', 'main.js'), 'core-js\n');

  const zipStage = path.join(temp, 'zip-stage');
  mkdirSync(path.join(zipStage, 'web'), { recursive: true });
  writeFileSync(path.join(zipStage, 'WorkKitLauncher.exe'), 'new-launcher-bytes\n');
  writeFileSync(
    path.join(zipStage, 'launcher-manifest.json'),
    JSON.stringify({ kind: 'work-kit-launcher', version: '1.0.0', update_sequence: 2 }, null, 2),
  );
  writeFileSync(path.join(zipStage, 'web', 'index.html'), '<main>new-ui</main>\n');
  const zipPath = path.join(temp, 'WorkKitLauncher-v1.0.0-update-2.zip');
  zipDirectory(zipStage, zipPath);

  const applied = spawnSync(
    built,
    [
      '--apply-update',
      '--root', installRoot,
      '--zip', zipPath,
      '--no-restart',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(applied.status, 0, `apply-update failed: ${applied.stdout ?? ''}${applied.stderr ?? ''}`);
  assert.equal(readFileSync(path.join(installRoot, 'MYAgent.exe'), 'utf8'), 'core-sentinel\n');
  assert.equal(readFileSync(path.join(installRoot, 'core', 'dist', 'main.js'), 'utf8'), 'core-js\n');
  assert.equal(readFileSync(path.join(installRoot, 'WorkKitLauncher.exe'), 'utf8'), 'new-launcher-bytes\n');
  assert.equal(
    readFileSync(path.join(installRoot, 'bin', 'work-kit-launcher', 'web', 'index.html'), 'utf8'),
    '<main>new-ui</main>\n',
  );
  assert.equal(
    readFileSync(path.join(installRoot, 'ui', 'work-kit-launcher', 'dist', 'index.html'), 'utf8'),
    '<main>new-ui</main>\n',
  );

  const poisonStage = path.join(temp, 'poison');
  mkdirSync(poisonStage, { recursive: true });
  writeFileSync(path.join(poisonStage, 'MYAgent.exe'), 'hijack\n');
  const poisonZip = path.join(temp, 'poison.zip');
  zipDirectory(poisonStage, poisonZip);
  const poisonInstall = path.join(temp, 'poison-install');
  mkdirSync(poisonInstall, { recursive: true });
  writeFileSync(path.join(poisonInstall, 'manifest.json'), '{"version":"1.0.3"}\n');
  writeFileSync(path.join(poisonInstall, 'MYAgent.exe'), 'core-sentinel\n');
  const poison = spawnSync(
    built,
    ['--apply-update', '--root', poisonInstall, '--zip', poisonZip, '--no-restart'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.notEqual(poison.status, 0, 'apply must reject a zip that contains MYAgent.exe');
  assert.equal(readFileSync(path.join(poisonInstall, 'MYAgent.exe'), 'utf8'), 'core-sentinel\n');

  console.log('verify-launcher-update: ok');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function buildLauncher() {
  const proj = path.join(root, 'shell', 'WorkKitLauncher', 'WorkKitLauncher.csproj');
  const build = spawnSync(
    'dotnet',
    ['build', proj, '-c', 'Release', '-v', 'q'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(build.status, 0, `dotnet build WorkKitLauncher failed: ${build.stdout ?? ''}${build.stderr ?? ''}`);
  const exe = path.join(
    root,
    'shell',
    'WorkKitLauncher',
    'bin',
    'Release',
    'net8.0-windows',
    'win-x64',
    'WorkKitLauncher.exe',
  );
  assert.equal(existsSync(exe), true, `missing ${exe}`);
  return exe;
}

function zipDirectory(sourceDir, zipPath) {
  rmSync(zipPath, { force: true });
  const zip = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `[IO.Compression.ZipFile]::CreateFromDirectory('${sourceDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}', [IO.Compression.CompressionLevel]::Optimal, $false, [Text.Encoding]::UTF8)`,
      ].join('; '),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(zip.status, 0, `${zip.stdout ?? ''}${zip.stderr ?? ''}`);
  assert.ok(sha256File(zipPath));
}
