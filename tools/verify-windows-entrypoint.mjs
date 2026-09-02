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
assert.match(installer, /Get-DefaultInstallPath/);
assert.doesNotMatch(
  installer,
  /Test-IsNewFolderOnDriveRoot/,
  'C:\\MYAgent must be allowed when writable; do not block new folders on the drive root',
);
assert.match(installer, /Test-IsElevated/);
assert.match(installer, /Test-IsProtectedSystemFolder/);
assert.match(installer, /Test-IsShellDumpFolder/);
assert.match(installer, /Grant-CurrentUserModify/);
assert.match(installer, /npm_config_cache/);
assert.match(installer, /cannot be inside the unzipped app folder/);
assert.match(installer, /OptionalRuntimes/);
assert.match(installer, /Save-OptionalRuntimeSelection/);
assert.match(installer, /Install-SelectedOptionalRuntimes/);
assert.match(installer, /install-paths\.ps1/);

const installPaths = read('tools/install/install-paths.ps1');
assert.match(installPaths, /function Get-DefaultInstallPath/);
assert.match(installPaths, /Join-Path \$sys \$name/);
assert.match(installPaths, /\$env:PUBLIC/);
assert.match(installPaths, /Get-ProductInstallFolderName/);

const optionalCatalog = JSON.parse(read('core/config/defaults/optional-runtimes.json'));
assert.ok(Array.isArray(optionalCatalog.core_features) && optionalCatalog.core_features.length >= 5);
assert.deepEqual(
  optionalCatalog.optional_runtimes.map((item) => item.id).sort(),
  ['ast_grep', 'ffmpeg', 'markitdown', 'playwright', 'repomix'],
);
const optionalHelper = read('tools/install/optional-runtimes.ps1');
assert.match(optionalHelper, /function Get-OptionalRuntimeCatalog/);
assert.match(optionalHelper, /function Get-DefaultOptionalRuntimeIds/);
assert.match(optionalHelper, /ApplyCatalogDefaults/);
assert.match(optionalHelper, /function Save-OptionalRuntimeSelection/);
assert.match(read('tools/install/install-optional.ps1'), /Install-SelectedOptionalRuntimes/);

const launchCqr = read('tools/launch-cqr.ps1');
assert.match(launchCqr, /Read-OptionalRuntimeSelection/);
assert.doesNotMatch(launchCqr, /bootstrap-pipeline-if-needed/);
assert.doesNotMatch(launchCqr, /runtime\\ffmpeg\\ffmpeg\.exe/);
assert.doesNotMatch(
  installer,
  /Source folder cannot be inside the install target/,
  'must allow install to a parent of the unzipped zip (e.g. C:\\app while zip lives in C:\\app\\MY Agent-*-install-slim\\app)',
);

const playwrightBootstrap = read('tools/bootstrap-playwright.ps1');
assert.match(
  playwrightBootstrap,
  /Invoke-CqrNative -FilePath \$nodeExe -ArgumentList @\(\$cliJs, 'install', 'chromium'\)/,
);
assert.doesNotMatch(
  playwrightBootstrap,
  /Join-Path \$Root 'runtime\\node\\npx\.cmd'/,
  'Chromium install must not call npx.cmd (Hangul profile / no PATH node)',
);

const installUi = read('tools/install/install-ui.ps1');
assert.match(installUi, /Could not run Node \(not a network error\)/);
assert.match(installUi, /Get-DefaultInstallPath/);
assert.doesNotMatch(installUi, /Test-IsNewFolderOnDriveRoot/);
assert.match(installUi, /function Show-FeatureChecklist/);
assert.match(installUi, /\$script:featureHelpMap/);
assert.match(installUi, /DefaultSelected/);
assert.match(installUi, /passOptionalRuntimesArg/);
assert.match(installUi, /What this is/);
for (const m of installUi.matchAll(/-match\s+'([^']*)'/g)) {
  assert.ok(
    !/[^\x00-\x7F]/.test(m[1]),
    `install-ui.ps1 -match must be ASCII-only (PS 5.1 no-BOM Korean becomes nested-quantifier crash): ${m[1]}`,
  );
}

const installLauncherUi = read('tools/install/install-launcher-ui.ps1');
assert.match(installLauncherUi, /Show-TargetPickerForm/);
assert.match(installLauncherUi, /Get-LauncherUiText/);
assert.match(installLauncherUi, /Format-LauncherLogLineForUi/);
assert.match(installLauncherUi, /-NoInteractive/);
for (const m of installLauncherUi.matchAll(/-match\s+'([^']*)'/g)) {
  assert.ok(
    !/[^\x00-\x7F]/.test(m[1]),
    `install-launcher-ui.ps1 -match must be ASCII-only: ${m[1]}`,
  );
}

const installLauncherBat = read('tools/install/install-launcher.bat');
assert.match(installLauncherBat, /install-launcher-ui\.ps1/);

const installLauncherPs1 = read('tools/install/install-launcher.ps1');
assert.match(installLauncherPs1, /function Copy-LauncherPayload/);
assert.doesNotMatch(
  installLauncherPs1,
  /Copy-Item\s+-LiteralPath\s+\(Join-Path\s+\$SourceAppDir\s+'\*'\)/,
  'install-launcher.ps1 must not use LiteralPath with wildcards (silent no-copy bug on PS 5.1)',
);

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

const portPolicy = JSON.parse(read('tools/port-keep-policy.json'));
assert.ok(
  portPolicy.keep.some((rule) => (rule.prefixes || []).includes('tools/install/')),
  'port-apply must not overwrite the install checklist',
);
assert.match(read('tools/port-apply.mjs'), /from '\.\/port-keep-policy\.mjs'/);

console.log('verify-windows-entrypoint: ok');
