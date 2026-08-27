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
assert.match(publish, /skipExactFiles/);
assert.match(publish, /'PORT\.md'/);
assert.match(publish, /'repo-target\.json'/);
assert.match(publish, /tools', 'install', 'install\.bat'/);

const localBuild = read('tools/build-windows-exe.mjs');
assert.match(localBuild, /path\.join\(root, 'MYAgent\.exe'\)/);
assert.match(localBuild, /publishShell/);
assert.match(localBuild, /MYAgent\.Updater\.exe/);
assert.match(localBuild, /publishUpdater/);

const packageDoc = JSON.parse(read('package.json'));
assert.equal(packageDoc.scripts['build:exe'], 'node tools/build-windows-exe.mjs');
assert.equal(packageDoc.scripts.start, 'node tools/dev-run.mjs');

assert.deepEqual(
  readdirSync(root).filter((name) => name.toLowerCase().endsWith('.bat')).sort(),
  ['UPDATE.bat'],
  'root must not expose install.bat (release zip only)',
);
assert.equal(existsSync(path.join(root, 'install.bat')), false, 'install.bat belongs in the release zip, not git root');
const installBat = read('tools/install/install.bat');
assert.match(installBat, /This folder is source, not the install package/);
assert.match(installBat, /app\\MYAgent\.exe/);
assert.ok(
  installBat.indexOf('This folder is source, not the install package')
    < installBat.indexOf(':run_install'),
  'source-tree refusal must run before the installer UI',
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
  'dev-run.bat',
  'create-dev-shortcut.bat',
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
assert.match(shortcut, /\[switch\]\$Dev/);
assert.match(shortcut, /MY Agent Dev\.lnk/);
assert.doesNotMatch(shortcut, /\$shortcut\.TargetPath = \$powershell/);

const installer = read('tools/install/install.ps1');
assert.match(installer, /The git clone has no install\.bat/);
assert.match(installer, /Copy finished but MYAgent\.exe is missing/);
assert.doesNotMatch(installer, /MYAgent\.exe not found — desktop shortcut was not created/);
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
assert.match(installer, /Programs\\MYAgent/);

const installUi = read('tools/install/install-ui.ps1');
assert.match(installUi, /function Get-ProductInstallDir/);
assert.match(installUi, /function Remove-EmptyDirIfExists/);
assert.match(installUi, /\[IO\.Path\]::Combine\(\$t, 'MYAgent'\)/);
assert.match(installUi, /Programs\\MYAgent/);
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
assert.match(bundleVerify, /path: '\.gitignore'/);
assert.match(bundleVerify, /path: '\.github'/);

const updater = read('tools/update/apply-delta.ps1');
assert.match(updater, /'MYAgent\.exe'/);
assert.match(updater, /'MYAgent\.Updater\.exe'/);

console.log('verify-windows-entrypoint: ok');
