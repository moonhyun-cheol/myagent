#!/usr/bin/env node
/**
 * Build delta (간략) update zip.
 * Includes: core/dist, core/config/defaults, UI, shell (MYAgent.exe + bin/my-agent),
 * manifest, and rulebook. Legacy local-only brand sources are never put in a
 * public secure-update package.
 * Preserves data/ + runtime/ on apply. Large binaries (ffmpeg/node/playwright) stay runtime-bootstrap.
 */
import { readFileSync, mkdirSync, cpSync, existsSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publishShell } from './shell-publish.mjs';
import { publishUpdater } from './updater-publish.mjs';
import {
  buildPayloadManifest,
  createSignedEnvelope,
  verifySignedEnvelope,
} from './update/update-signing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'deploy', 'output');
const stageDir = path.join(outDir, 'delta-stage');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const ver = manifest.version ?? '1.0.0';
const secureUpdate = process.env.MY_AGENT_SECURE_UPDATE === '1';
const preflightDone = process.env.MY_AGENT_BUILD_PREFLIGHT_DONE === '1';

const build = spawnSync(
  process.execPath,
  [
    path.join(root, 'tools', preflightDone ? 'build-smart.mjs' : 'build.mjs'),
    ...(preflightDone ? ['--assert-fresh'] : []),
  ],
  { cwd: root, stdio: 'inherit' },
);
if (build.status !== 0) process.exit(build.status ?? 1);

if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

function copyRel(rel) {
  const src = path.join(root, rel);
  const dst = path.join(stageDir, rel);
  if (!existsSync(src)) {
    console.error('missing:', rel);
    process.exit(1);
  }
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
}

function copyTrackedTree(rel) {
  const listed = spawnSync('git', ['ls-files', '-z', '--', rel], {
    cwd: root,
  });
  if (listed.status !== 0) {
    console.error(`publish-delta: failed to enumerate tracked ${rel} files`);
    process.exit(listed.status ?? 1);
  }
  const files = listed.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  if (files.length === 0) {
    console.error(`publish-delta: no tracked files found under ${rel}`);
    process.exit(1);
  }
  for (const file of files) {
    if (existsSync(path.join(root, file))) copyRel(file);
  }
}

copyRel('core/dist');
if (!existsSync(path.join(root, 'core', 'config', 'defaults', 'deploy-defaults.json'))) {
  console.error('missing: core/config/defaults (run npm run build)');
  process.exit(1);
}
copyRel('core/config/defaults');
if (!existsSync(path.join(root, 'ui', 'workspace', 'dist', 'index.html'))) {
  console.error('missing: ui/workspace/dist (run workspace build)');
  process.exit(1);
}
copyRel('ui/workspace/dist');
copyRel('manifest.json');
if (secureUpdate) {
  copyTrackedTree('rulebook');
  copyRel(`rulebook/docs/generated/RULEBOOK_MY_AGENT_MAIN_v${ver}.md`);
} else {
  copyRel('rulebook');
}
if (existsSync(path.join(root, '.rulebook-link.yml'))) {
  copyRel('.rulebook-link.yml');
}
copyRel('UPDATE.bat');
copyRel('tools/update/apply-delta.ps1');
copyRel('tools/bootstrap-ffmpeg.ps1');
copyRel('tools/bootstrap-ffmpeg-if-needed.ps1');
copyRel('tools/bootstrap-oss-sidecars.ps1');
copyRel('tools/bootstrap-oss-sidecars-if-needed.ps1');
copyRel('tools/requirements-oss-sidecars.txt');
copyRel('tools/oss-sidecars-package.json');

console.log('publish-delta: organization modules are excluded from the neutral core update');

// Shell chrome (title bar) — must ship with delta or installs keep the old window.
const shellProj = path.join(root, 'shell', 'CqrPa.Shell', 'CqrPa.Shell.csproj');
const shellOut = path.join(root, 'bin', 'my-agent');
if (!existsSync(shellProj)) {
  console.error('missing: shell/CqrPa.Shell/CqrPa.Shell.csproj');
  process.exit(1);
}
if (!preflightDone) {
  const shellPub = publishShell({
    root,
    projPath: shellProj,
    outDir: shellOut,
    label: 'publish-delta',
  });
  if (!shellPub.ok) {
    console.error(shellPub.reason);
    process.exit(1);
  }
}
copyRel('bin/my-agent');
const publishedExe = path.join(shellOut, 'MYAgent.exe');
if (!existsSync(publishedExe)) {
  console.error('publish-delta: shell executable missing after publish');
  process.exit(1);
}
cpSync(publishedExe, path.join(stageDir, 'MYAgent.exe'));

const updaterOut = path.join(root, 'bin', 'my-agent-updater');
let updaterExecutable = path.join(updaterOut, 'MYAgent.Updater.exe');
if (!preflightDone) {
  const updater = publishUpdater({
    root,
    outDir: updaterOut,
    label: 'publish-delta',
  });
  if (!updater.ok) {
    console.error(updater.reason);
    process.exit(1);
  }
  updaterExecutable = updater.executable;
}
if (!existsSync(updaterExecutable)) {
  console.error('publish-delta: updater executable missing after preflight');
  process.exit(1);
}
cpSync(updaterExecutable, path.join(stageDir, 'MYAgent.Updater.exe'));
cpSync(
  updaterExecutable,
  path.join(stageDir, 'bin', 'my-agent', 'MYAgent.Updater.exe'),
);

// Personal pack backup/restore (survives outside data/; data/ itself never in delta)
const optionalTools = [
  'tools/personal-pack-export.mjs',
  'package.json',
];
for (const rel of optionalTools) {
  if (existsSync(path.join(root, rel))) copyRel(rel);
  else console.warn('publish-delta: optional missing:', rel);
}

writeFileSync(
  path.join(stageDir, 'VERSION.txt'),
  [
    `MY Agent delta v${ver}`,
    'components: desktop shell, updater, core/dist, core/config/defaults, ui/workspace/dist, manifest.json, rulebook/, update/bootstrap tools',
    'data/ NOT included — local skills/plugins/MCP/vault stay on disk after apply-delta',
    'runtime/ NOT included — oss-sidecars/ffmpeg/playwright/node stay local; START/apply-delta re-bootstraps if missing',
    'same-experience: no token-gated MCP in shipped defaults; secrets never required for parity features',
    'optional backup: node tools/personal-pack-export.mjs --export',
    '',
  ].join('\n'),
  'utf8',
);

if (secureUpdate) {
  const privateKeyPath = path.resolve(
    process.env.MY_AGENT_UPDATE_SIGNING_KEY
    ?? path.join(root, 'tools', 'keys', 'update-private.pem'),
  );
  const publicKeyPath = path.join(root, 'core', 'config', 'defaults', 'update-public.pem');
  if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
    console.error('publish-delta: secure update signing keys are missing');
    process.exit(1);
  }
  const updateSequence = Number(manifest.update_sequence);
  const minimumSupportedSequence = Number(manifest.minimum_supported_sequence ?? 1);
  const channel = String(manifest.update_channel ?? manifest.build ?? 'beta').trim().toLowerCase();
  const payloadDocument = buildPayloadManifest(stageDir, {
    updateSequence,
    minimumSupportedSequence,
    version: ver,
    channel,
  });
  const envelope = createSignedEnvelope(
    payloadDocument,
    readFileSync(privateKeyPath, 'utf8'),
  );
  if (!verifySignedEnvelope(envelope, readFileSync(publicKeyPath, 'utf8'))) {
    console.error('publish-delta: generated update payload signature verification failed');
    process.exit(1);
  }
  writeFileSync(
    path.join(stageDir, 'update-payload.json'),
    `${JSON.stringify(envelope, null, 2)}\n`,
    'utf8',
  );
}

mkdirSync(outDir, { recursive: true });
const zipName = `MYAgent-v${ver}-delta.zip`;
const zipPath = path.join(outDir, zipName);
if (existsSync(zipPath)) rmSync(zipPath, { force: true });

if (process.platform === 'win32') {
  if (secureUpdate) {
    // tar.exe can omit ZIP's UTF-8 filename flag on Windows. The signed manifest
    // keeps Unicode paths, so use the explicit .NET UTF-8 overload.
    const ps = spawnSync(
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
      { stdio: 'inherit' },
    );
    if (ps.status !== 0) process.exit(ps.status ?? 1);
  } else {
    // Keep the established manual-delta path for compatibility.
    const tar = spawnSync(
      'tar',
      ['-a', '-c', '-f', zipPath, '-C', stageDir, '.'],
      { stdio: 'inherit' },
    );
    if (tar.status !== 0 || !existsSync(zipPath)) {
      const ps = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          [
            "$ErrorActionPreference = 'Stop'",
            `Compress-Archive -Path '${stageDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
            `if (-not (Test-Path -LiteralPath '${zipPath.replace(/'/g, "''")}')) { throw 'delta zip missing after Compress-Archive' }`,
          ].join('; '),
        ],
        { stdio: 'inherit' },
      );
      if (ps.status !== 0) process.exit(ps.status ?? 1);
    }
  }
} else {
  console.error('publish-delta: Windows required');
  process.exit(1);
}

if (!existsSync(zipPath) || (statSync(zipPath).size ?? 0) < 1000) {
  console.error('publish-delta: zip missing or too small:', zipPath);
  process.exit(1);
}

writeFileSync(path.join(outDir, 'LATEST_DELTA_ZIP.txt'), zipPath + '\n');
console.log('Delta published ->', zipPath);
