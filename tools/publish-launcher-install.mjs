#!/usr/bin/env node
/**
 * Build a WorkKitLauncher-only install zip for existing MY Agent installs.
 *
 * Usage: node tools/publish-launcher-install.mjs [--skip-build]
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { publishWorkKitLauncher } from './launcher-publish.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'deploy', 'output');
const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');

const launcherManifestPath = path.join(root, 'launcher-manifest.json');
const launcherManifest = JSON.parse(readFileSync(launcherManifestPath, 'utf8'));
const version = String(launcherManifest.version ?? '').trim();
if (!version) {
  console.error('publish-launcher-install: launcher-manifest.json version is required');
  process.exit(1);
}

if (!skipBuild) {
  const published = publishWorkKitLauncher({ root, label: 'publish-launcher-install' });
  if (!published.ok) {
    console.error(published.reason);
    process.exit(1);
  }
}

const exePath = path.join(root, 'bin', 'work-kit-launcher', 'WorkKitLauncher.exe');
const uiDist = path.join(root, 'ui', 'work-kit-launcher', 'dist');
if (!existsSync(exePath)) {
  console.error(`publish-launcher-install: WorkKitLauncher.exe missing: ${exePath}`);
  process.exit(1);
}
if (!existsSync(path.join(uiDist, 'index.html'))) {
  console.error(`publish-launcher-install: launcher UI missing: ${uiDist}`);
  process.exit(1);
}

const stageDir = path.join(outDir, 'launcher-install-stage');
const appDir = path.join(stageDir, 'app');
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

cpSync(exePath, path.join(appDir, 'WorkKitLauncher.exe'));
cpSync(launcherManifestPath, path.join(appDir, 'launcher-manifest.json'));

const stagedLauncherDir = path.join(appDir, 'bin', 'work-kit-launcher');
mkdirSync(path.join(appDir, 'bin'), { recursive: true });
cpSync(path.join(root, 'bin', 'work-kit-launcher'), stagedLauncherDir, { recursive: true });

const stagedLauncherUi = path.join(appDir, 'ui', 'work-kit-launcher', 'dist');
mkdirSync(path.dirname(stagedLauncherUi), { recursive: true });
cpSync(uiDist, stagedLauncherUi, { recursive: true });

const readme = `WorkKitLauncher v${version} (install only)
=====================================

기존 MY Agent 설치에 작업 환경 프로그램만 추가·갱신합니다.
MY Agent 코어(MYAgent.exe)는 포함하지 않습니다.

1. install-launcher.bat 실행 (더블클릭)
2. MY Agent 설치 폴더를 자동으로 찾아 WorkKitLauncher.exe 를 복사합니다.
   - 기본 후보: %SystemDrive%\\MYAgent, 바탕화면 "MY Agent" 바로가기, MY_AGENT_ROOT
3. 바탕화면에 "MY Agent 작업 환경" 바로가기가 생성됩니다.

수동 경로가 필요하면 환경 변수 MY_AGENT_ROOT 를 manifest.json 이 있는 폴더로 설정한 뒤 다시 실행하세요.
런처 UI 하단 「관리 · 설치 루트」에서 현재 연결된 경로를 복사할 수 있습니다.

자동 업데이트: channels/launcher-stable.json (launcher-update 스트림)
`;
writeFileSync(path.join(stageDir, 'README-launcher-install.txt'), readme, 'utf8');
cpSync(path.join(root, 'tools', 'install', 'install-launcher.bat'), path.join(stageDir, 'install-launcher.bat'));
mkdirSync(path.join(stageDir, 'tools', 'install'), { recursive: true });
cpSync(
  path.join(root, 'tools', 'install', 'install-launcher.ps1'),
  path.join(stageDir, 'tools', 'install', 'install-launcher.ps1'),
);
cpSync(
  path.join(root, 'tools', 'install', 'install-paths.ps1'),
  path.join(stageDir, 'tools', 'install', 'install-paths.ps1'),
);

mkdirSync(outDir, { recursive: true });
const zipName = `WorkKitLauncher-v${version}-install.zip`;
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
  console.error(`publish-launcher-install: zip failed: ${zip.stdout ?? ''}${zip.stderr ?? ''}`);
  process.exit(1);
}

writeFileSync(
  path.join(outDir, 'LATEST_LAUNCHER_INSTALL.json'),
  `${JSON.stringify({
    kind: 'work-kit-launcher-install',
    version,
    zip_path: zipPath,
  }, null, 2)}\n`,
  'utf8',
);

console.log('Launcher install zip ->', zipPath);
