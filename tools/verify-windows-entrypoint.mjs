#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const project = read('shell/CqrPa.Shell/CqrPa.Shell.csproj');
for (const marker of [
  '<OutputType>WinExe</OutputType>',
  '<RuntimeIdentifier>win-x64</RuntimeIdentifier>',
  '<SelfContained>true</SelfContained>',
  '<PublishSingleFile>true</PublishSingleFile>',
  '<IncludeNativeLibrariesForSelfExtract>true</IncludeNativeLibrariesForSelfExtract>',
]) {
  assert.ok(project.includes(marker), `shell publish contract missing: ${marker}`);
}

const updaterProject = read('shell/CqrPa.Updater/CqrPa.Updater.csproj');
for (const marker of [
  '<OutputType>Exe</OutputType>',
  '<RuntimeIdentifier>win-x64</RuntimeIdentifier>',
  '<SelfContained>true</SelfContained>',
  '<PublishSingleFile>true</PublishSingleFile>',
]) {
  assert.ok(updaterProject.includes(marker), `updater publish contract missing: ${marker}`);
}

const publish = read('tools/publish.mjs');
assert.match(publish, /path\.join\(appDir, 'MYAgent\.exe'\)/);
assert.match(publish, /cpSync\(publishedExe, productExe\)/);
assert.match(publish, /MYAgent\.Updater\.exe/);
assert.match(publish, /publishUpdater/);

const localBuild = read('tools/build-windows-exe.mjs');
assert.match(localBuild, /path\.join\(root, 'MYAgent\.exe'\)/);
assert.match(localBuild, /publishShell/);
assert.match(localBuild, /MYAgent\.Updater\.exe/);
assert.match(localBuild, /publishUpdater/);

const packageDoc = JSON.parse(read('package.json'));
assert.equal(packageDoc.scripts['build:exe'], 'node tools/build-windows-exe.mjs');

assert.deepEqual(
  readdirSync(root).filter((name) => name.toLowerCase().endsWith('.bat')).sort(),
  ['UPDATE.bat', 'install.bat'],
  'root must expose only install and update BAT files',
);
for (const command of [
  'activation-autostart-install.bat',
  'activation-autostart-remove.bat',
  'activation-server.bat',
  'diagnostics.bat',
  'publish-delta.bat',
  'publish-full.bat',
  'publish-slim.bat',
  'refresh-shortcut.bat',
  'reset-first-run.bat',
  'setup-vault.bat',
  'start-legacy.bat',
]) {
  const body = read(`tools/commands/${command}`);
  assert.match(body, /%~dp0\.\.\\\.\./, `${command} must resolve the project root`);
}
assert.equal(existsSync(path.join(root, 'tsconfig.tsbuildinfo')), false);

const delta = read('tools/publish-delta.mjs');
assert.match(delta, /path\.join\(stageDir, 'MYAgent\.exe'\)/);
assert.match(delta, /path\.join\(stageDir, 'MYAgent\.Updater\.exe'\)/);

const shortcut = read('tools/desktop-shortcut.ps1');
assert.match(shortcut, /\$shortcut\.TargetPath = \$productExe/);
assert.doesNotMatch(shortcut, /\$shortcut\.TargetPath = \$powershell/);

const installer = read('tools/install/install.ps1');
assert.match(installer, /Join-Path \$targetFull 'MYAgent\.exe'/);
assert.match(installer, /\$shortcut\.TargetPath = \$productExe/);
assert.match(installer, /Test-IsDriveRoot/);
assert.match(installer, /Test-IsNewFolderOnDriveRoot/);
assert.match(installer, /Test-IsElevated/);
assert.match(installer, /Test-IsProtectedSystemFolder/);
assert.match(installer, /Test-IsShellDumpFolder/);
assert.match(installer, /Grant-CurrentUserModify/);
assert.match(installer, /npm_config_cache/);
assert.match(installer, /cannot be inside the unzipped app folder/);
assert.doesNotMatch(
  installer,
  /Source folder cannot be inside the install target/,
  'must allow install to a parent of the unzipped zip (e.g. C:\\app while zip lives in C:\\app\\MY Agent-*-install-slim\\app)',
);

const installUi = read('tools/install/install-ui.ps1');
for (const m of installUi.matchAll(/-match\s+'([^']*)'/g)) {
  assert.ok(
    !/[^\x00-\x7F]/.test(m[1]),
    `install-ui.ps1 -match must be ASCII-only (PS 5.1 no-BOM Korean becomes nested-quantifier crash): ${m[1]}`,
  );
}

assert.equal(existsSync(path.join(root, 'START.bat')), false, 'root START.bat must stay removed');
const start = read('tools/commands/start-legacy.bat');
const exeBranch = start.indexOf('MYAgent.exe');
const legacyLauncher = start.indexOf('launch-cqr.ps1');
assert.ok(exeBranch >= 0 && legacyLauncher > exeBranch, 'legacy launcher must prefer MYAgent.exe');

const bundleVerify = read('tools/verify-publish-bundle.mjs');
assert.match(bundleVerify, /path: 'MYAgent\.exe'/);
assert.match(bundleVerify, /path: 'MYAgent\.Updater\.exe'/);

const updater = read('tools/update/apply-delta.ps1');
assert.match(updater, /'MYAgent\.exe'/);
assert.match(updater, /'MYAgent\.Updater\.exe'/);

console.log('verify-windows-entrypoint: ok');
