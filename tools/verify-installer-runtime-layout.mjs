#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const install = read('tools/install/install.ps1');
const installTransaction = read('tools/install/install-transaction.ps1');
const bootstrapNode = read('tools/bootstrap-node.ps1');
const bootstrapNodeIfNeeded = read('tools/bootstrap-node-if-needed.ps1');
const restore = read('tools/restore-core-npm-deps.ps1');
const playwright = read('tools/bootstrap-playwright.ps1');
const playwrightIfNeeded = read('tools/bootstrap-playwright-if-needed.ps1');
const playwrightRuntime = read('tools/playwright-runtime.ps1');
const probe = read('core/src/browser/playwright-probe.ts');
const optionalHelpers = read('tools/install/optional-runtimes.ps1');
const installOptional = read('tools/install/install-optional.ps1');
const installUi = read('tools/install/install-ui.ps1');
const ossSidecars = read('tools/bootstrap-oss-sidecars.ps1');
const catalog = JSON.parse(read('core/config/defaults/optional-runtimes.json'));

assert.ok(
  install.indexOf('Restoring bundled runtime npm dependencies') < install.indexOf('Install-SelectedOptionalRuntimes'),
  'core restore must run before optional runtime installers',
);
assert.match(install, /CORE_BUNDLE_MISSING/);
assert.doesNotMatch(install, /will try npm install/);
assert.match(restore, /node_modules\.installing/);
assert.match(restore, /node_modules\.previous/);
assert.match(restore, /Assert-CoreNpmDependencies/);
assert.match(bootstrapNodeIfNeeded, /process\.versions\.node/);
assert.doesNotMatch(
  bootstrapNodeIfNeeded,
  /if \(Test-Path -LiteralPath \$nodeExe\) \{ exit 0 \}/,
  'a corrupt or unexpected node.exe must not be accepted by existence alone',
);
assert.match(bootstrapNode, /\.installing/);
assert.match(bootstrapNode, /\.previous/);
assert.match(bootstrapNode, /cached\/downloaded archive is invalid and was removed/);
assert.match(bootstrapNode, /Test-NodeRuntimeVersion -Folder \$staging/);
assert.match(bootstrapNode, /unverified downloads are not allowed/);
assert.match(bootstrapNodeIfNeeded, /ignoring CQR_NODE_VERSION in a release install/);
assert.match(bootstrapNodeIfNeeded, /ALLOW-NODE-VERSION-OVERRIDE/);
assert.match(playwright, /runtime\\playwright\\package/);
assert.doesNotMatch(playwright, /Join-Path \$Root 'node_modules\\playwright/);
assert.match(playwrightIfNeeded, /Test-PlaywrightRuntime/);
assert.match(playwrightIfNeeded, /Enable-PlaywrightLocalhostPolicy/);
assert.match(playwrightRuntime, /PLAYWRIGHT_POLICY_CONFIG_INVALID/);
assert.match(playwrightRuntime, /MyAgentPlaywrightVersion = '1\.52\.0'/);
assert.match(playwrightRuntime, /Get-PlaywrightBrowserExecutable/);
assert.doesNotMatch(playwright, /if \(\$code -ne 0\) \{\s*\$sysNpm/s, 'a failed portable npm run must not be repeated with system npm');
assert.match(restore, /failed directory move may leave a target entry/);
assert.match(probe, /runtime', 'playwright', 'package', 'node_modules'/);
assert.ok(optionalHelpers.includes('catalog itself is unavailable or invalid'));
assert.doesNotMatch(optionalHelpers, /\$fallback = @\('[^']+'/,
  'catalog failure must not enable any implicit network download');
assert.match(installOptional, /OPTIONAL_RUNTIME_INSTALL_FAILED/);
assert.match(installOptional, /Enter-InstallTargetLock/);
assert.match(optionalHelpers, /\$existing = Read-OptionalRuntimeSelection \$Root/);
assert.match(install, /Assert-NoRunningInstalledProcess/);
assert.match(install, /Start-InstallProductTransaction/);
assert.ok(
  install.indexOf('Start-InstallProductTransaction') < install.indexOf('$selectedOptionals = Resolve-OptionalRuntimeSelection'),
  'fresh installs must resolve catalog defaults after the new product catalog is applied',
);
assert.ok(
  install.indexOf('$existingOptionalSelection = Read-OptionalRuntimeSelection') < install.indexOf('Start-InstallProductTransaction'),
  'reinstall selection must be captured before its state file is moved into the transaction backup',
);
assert.match(install, /\$useExistingOptionalSelection/);
assert.match(optionalHelpers, /optional runtime '\$id' could not start/);
assert.match(optionalHelpers, /\$ErrorActionPreference = 'Continue'/);
assert.match(install, /Complete-InstallProductTransaction/);
assert.ok(
  install.indexOf('Complete-InstallProductTransaction') < install.indexOf('$optionalResult = Install-SelectedOptionalRuntimes'),
  'required product transaction must commit before optional downloads begin',
);
assert.match(install, /Repair-CopiedProductFiles/);
assert.doesNotMatch(install, /Repair-CopiedTree \$targetFull/);
assert.match(install, /sourceIsDevTree/);
assert.match(install, /data\\_model_bakeoff\\summary\.json/);
assert.match(install, /Undo-InstallTransaction/);
assert.match(install, /Recover-PendingInstallTransaction/);
assert.match(install, /Enter-InstallTargetLock/);
assert.match(install, /Test-IsSubPath \$source \$targetFull/);
assert.match(install, /data\\config\\user-overrides\.json/);
assert.match(installTransaction, /\.install-transaction\.json/);
assert.match(installTransaction, /\.install-product-files\.json/);
assert.match(installTransaction, /node_modules\.previous/);
assert.ok(
  installTransaction.lastIndexOf('Get-InstallTransactionStatePath') < installTransaction.lastIndexOf("Join-Path $Transaction.TargetRoot 'node_modules.previous'"),
  'transaction state must commit before the old core runtime backup is deleted',
);
assert.match(installTransaction, /Installs created before manifests existed/);
assert.match(installTransaction, /@\('core', 'ui', 'shell', 'tools'\)/);
assert.match(installTransaction, /INSTALL_RECOVERY_STAGE_PATH_INVALID/);
assert.match(installTransaction, /INSTALL_RECOVERY_BACKUP_PATH_INVALID/);
assert.match(installTransaction, /INSTALL_RECOVERY_RUN_ID_INVALID/);
assert.match(installTransaction, /INSTALL-DONE\.\*\.tmp/);
assert.match(installTransaction, /node_modules\.installing/);
assert.match(installTransaction, /\.core-deps-verify/);
assert.match(restore, /RetainBackup/);
assert.match(playwright, /Chromium launch smoke failed/);
assert.match(playwrightRuntime, /preserved the invalid user-overrides\.json unchanged/);
assert.match(playwright, /Enable-PlaywrightLocalhostPolicy/);
assert.match(optionalHelpers, /ForEach-Object \{ Write-Host/);
assert.match(install, /Run id: \$InstallRunId/);
assert.ok(
  install.indexOf('$targetFull = Get-FullPath $target') < install.indexOf("$completionMarker = Join-Path $targetFull 'INSTALL-DONE.txt'"),
  'completion marker setup must happen only after the target path is resolved',
);
assert.match(install, /'INSTALL-DONE\.txt'/, 'a completion marker from the payload must never be copied into the target');
assert.match(install, /data\\config\\optional-runtimes\.json/, 'transactional payload copy must preserve the prior optional selection document');
assert.match(installUi, /Show-FeatureChecklist \$sourceFull \$TargetDir/);
assert.match(installUi, /Installation complete with optional issues/);
assert.match(installUi, /OPTIONAL_RUNTIME_STATE_WRITE_FAILED/);
assert.doesNotMatch(installUi, /treating as success/, 'a stale completion marker must never override a failed exit code');
assert.match(optionalHelpers, /"version": 2/);
assert.match(optionalHelpers, /"requested"/);
assert.match(optionalHelpers, /"installed"/);
assert.match(optionalHelpers, /"failed"/);
assert.match(optionalHelpers, /Test-OptionalRuntimeInstalled/);
assert.match(optionalHelpers, /Test-OptionalRuntimeCommand/);
assert.match(optionalHelpers, /ffmpeg\.exe.*-version/s);
assert.match(optionalHelpers, /markitdown\.exe.*--help/s);
assert.match(optionalHelpers, /ast-grep\.exe.*--version/s);
assert.match(ossSidecars, /requested features are incomplete/);
assert.match(read('tools/cqr-native.ps1'), /ConvertTo-CqrNativeArgument/);
assert.match(playwright, /ConvertTo-CqrNativeArgument/);

const repomix = catalog.optional_runtimes.find((item) => item.id === 'repomix');
const playwrightCatalog = catalog.optional_runtimes.find((item) => item.id === 'playwright');
assert.equal(repomix?.default_selected, false, 'Repomix must not trigger online npm by default');
assert.ok(
  playwrightCatalog?.markers?.includes('runtime/playwright/package/node_modules/playwright/package.json'),
  'Playwright marker must use isolated package root',
);

const psFiles = [
  'tools/core-npm-deps.ps1',
  'tools/bootstrap-node-if-needed.ps1',
  'tools/bootstrap-node.ps1',
  'tools/playwright-runtime.ps1',
  'tools/restore-core-npm-deps.ps1',
  'tools/bootstrap-npm-deps-if-needed.ps1',
  'tools/bootstrap-npm-deps.ps1',
  'tools/bootstrap-playwright-if-needed.ps1',
  'tools/bootstrap-playwright.ps1',
  'tools/bootstrap-oss-sidecars.ps1',
  'tools/bootstrap-repomix-if-needed.ps1',
  'tools/bootstrap-markitdown-if-needed.ps1',
  'tools/bootstrap-ast-grep-if-needed.ps1',
  'tools/install/install-paths.ps1',
  'tools/install/install-transaction.ps1',
  'tools/install/install.ps1',
  'tools/install/install-ui.ps1',
  'tools/install/install-optional.ps1',
  'tools/install/optional-runtimes.ps1',
].map((rel) => path.join(root, rel));
const escapePs = (value) => value.replaceAll("'", "''");
const parseCommand = [
  '$failed = $false',
  ...psFiles.map((file) => `$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${escapePs(file)}',[ref]$t,[ref]$e);if($e.Count){$e|%{Write-Error $_.Message};$failed=$true}`),
  "if($failed){exit 1};'installer-powershell-parse: PASS'",
].join(';');
const parsed = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', parseCommand], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);

const playwrightCheck = [
  `. '${escapePs(path.join(root, 'tools', 'playwright-runtime.ps1'))}'`,
  `$fixture='${escapePs(path.join(os.tmpdir(), `my-agent-pw-marker-${process.pid}`))}'`,
  'Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue',
  "$pkg=Join-Path $fixture 'runtime\\playwright\\package\\node_modules\\playwright'",
  "$browsers=Join-Path $fixture 'runtime\\playwright\\browsers'",
  'New-Item -ItemType Directory -Force -Path $pkg,$browsers|Out-Null',
  `Set-Content -LiteralPath (Join-Path $pkg 'package.json') -Value '{"name":"playwright","version":"1.52.0"}'`,
  "Set-Content -LiteralPath (Join-Path $browsers '.chromium-installed') -Value ok",
  'if(Test-PlaywrightRuntime -Root $fixture){throw "stale marker accepted without browser executable"}',
  "$chrome=Join-Path $browsers 'chromium-test\\chrome-win'",
  'New-Item -ItemType Directory -Force -Path $chrome|Out-Null',
  "Set-Content -LiteralPath (Join-Path $chrome 'chrome.exe') -Value fixture",
  'if(-not (Test-PlaywrightRuntime -Root $fixture)){throw "complete fixture rejected"}',
  `Set-Content -LiteralPath (Join-Path $pkg 'package.json') -Value '{"name":"playwright","version":"9.9.9"}'`,
  'if(Test-PlaywrightRuntime -Root $fixture){throw "wrong package version accepted"}',
  'Remove-Item -LiteralPath $fixture -Recurse -Force',
  "'playwright-completion-check: PASS'",
].join(';');
const playwrightChecked = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', playwrightCheck], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(playwrightChecked.status, 0, playwrightChecked.stderr || playwrightChecked.stdout);

const playwrightPolicyCheck = [
  `. '${escapePs(path.join(root, 'tools', 'playwright-runtime.ps1'))}'`,
  `$fixture='${escapePs(path.join(os.tmpdir(), `my-agent-pw-policy-${process.pid}`))}'`,
  'Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue',
  "$configDir=Join-Path $fixture 'data\\config';New-Item -ItemType Directory -Force -Path $configDir|Out-Null",
  "$config=Join-Path $configDir 'user-overrides.json';Set-Content -LiteralPath $config -Value '{invalid'",
  "$rejected=$false;try{Enable-PlaywrightLocalhostPolicy -Root $fixture}catch{if($_.Exception.Message -match 'PLAYWRIGHT_POLICY_CONFIG_INVALID'){$rejected=$true}else{throw}}",
  "if(-not $rejected){throw 'invalid user overrides were accepted'}",
  "if((Get-Content -LiteralPath $config -Raw).Trim() -ne '{invalid'){throw 'invalid user overrides were overwritten'}",
  "if(@(Get-ChildItem -LiteralPath $configDir -Filter 'user-overrides.json.invalid-*.bak').Count -ne 1){throw 'invalid user overrides backup missing'}",
  "Set-Content -LiteralPath $config -Value '{}'",
  'Enable-PlaywrightLocalhostPolicy -Root $fixture',
  "$doc=Get-Content -LiteralPath $config -Raw|ConvertFrom-Json;if($doc.playwright_allow_localhost -ne $true){throw 'playwright policy was not persisted on retry'}",
  'Remove-Item -LiteralPath $fixture -Recurse -Force',
  "'playwright-policy-retry-check: PASS'",
].join(';');
const playwrightPolicyChecked = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', playwrightPolicyCheck], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(playwrightPolicyChecked.status, 0, playwrightPolicyChecked.stderr || playwrightPolicyChecked.stdout);

const optionalStateCheck = [
  `. '${escapePs(path.join(root, 'tools', 'install', 'optional-runtimes.ps1'))}'`,
  `$fixture='${escapePs(path.join(os.tmpdir(), `my-agent-optional-state-${process.pid}`))}'`,
  'Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue',
  'New-Item -ItemType Directory -Force -Path $fixture|Out-Null',
  "Save-OptionalRuntimeSelection -Root $fixture -Selected @('repomix','ast_grep') -Installed @('ast_grep') -Failed @('repomix')",
  '$doc=Read-OptionalRuntimeSelection $fixture',
  "if($doc.version -ne 2){throw 'optional state schema was not upgraded'}",
  "if(@($doc.requested) -notcontains 'repomix'){throw 'requested state missing'}",
  "if(@($doc.installed) -notcontains 'ast_grep'){throw 'installed state missing'}",
  "if(@($doc.failed) -notcontains 'repomix'){throw 'failed state missing'}",
  'Remove-Item -LiteralPath $fixture -Recurse -Force',
  "'optional-runtime-state-check: PASS'",
].join(';');
const optionalStateChecked = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', optionalStateCheck], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(optionalStateChecked.status, 0, optionalStateChecked.stderr || optionalStateChecked.stdout);

const nativeArgCheck = [
  `. '${escapePs(path.join(root, 'tools', 'cqr-native.ps1'))}'`,
  `$fixture='${escapePs(path.join(os.tmpdir(), `my agent native args ${process.pid}`))}'`,
  'Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue',
  'New-Item -ItemType Directory -Force -Path $fixture|Out-Null',
  `$script=Join-Path $fixture 'echo args.cjs';$out=Join-Path $fixture 'args output.txt'`,
  `[IO.File]::WriteAllText($script, 'require("fs").writeFileSync(process.argv[2], process.argv[3], "utf8");')`,
  `$code=Invoke-CqrNativeTimed -FilePath '${escapePs(process.execPath)}' -ArgumentList @($script,$out,'hello world') -TimeoutSec 10`,
  "if($code -ne 0){throw \"native argument fixture failed: $code\"}",
  "if((Get-Content -LiteralPath $out -Raw) -ne 'hello world'){throw 'space-containing argument was split'}",
  'Remove-Item -LiteralPath $fixture -Recurse -Force',
  "'native-space-argument-check: PASS'",
].join(';');
const nativeArgChecked = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', nativeArgCheck], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(nativeArgChecked.status, 0, nativeArgChecked.stderr || nativeArgChecked.stdout);

const nodeBootstrapRoot = mkdtempSync(path.join(os.tmpdir(), 'my-agent-node-bootstrap-'));
try {
  const toolsDir = path.join(nodeBootstrapRoot, 'tools');
  const cacheDir = path.join(toolsDir, 'cache');
  const archiveRoot = path.join(nodeBootstrapRoot, `node-v${process.versions.node}-win-x64`);
  const destination = path.join(nodeBootstrapRoot, 'runtime', 'node');
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(archiveRoot, { recursive: true });
  mkdirSync(destination, { recursive: true });
  copyFileSync(path.join(root, 'tools', 'bootstrap-node.ps1'), path.join(toolsDir, 'bootstrap-node.ps1'));
  copyFileSync(path.join(root, 'tools', 'cqr-native.ps1'), path.join(toolsDir, 'cqr-native.ps1'));
  copyFileSync(process.execPath, path.join(archiveRoot, 'node.exe'));
  copyFileSync(process.execPath, path.join(destination, 'node.exe'));
  writeFileSync(path.join(destination, 'old-runtime.txt'), 'old');
  const archivePath = path.join(cacheDir, `node-v${process.versions.node}-win-x64.zip`);
  const compressed = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Compress-Archive -LiteralPath '${escapePs(archiveRoot)}' -DestinationPath '${escapePs(archivePath)}' -Force`,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(compressed.status, 0, compressed.stderr || compressed.stdout);
  const fixtureArchiveSha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex');

  const installed = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(toolsDir, 'bootstrap-node.ps1'),
    '-Dest', destination, '-Version', process.versions.node, '-ExpectedArchiveSha256', fixtureArchiveSha256,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.ok(!existsSync(path.join(destination, 'old-runtime.txt')), 'verified Node staging must replace the old runtime');
  assert.ok(!existsSync(`${destination}.previous`), 'successful Node swap must remove its backup');

  writeFileSync(archivePath, 'not a zip');
  const corrupt = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(toolsDir, 'bootstrap-node.ps1'),
    '-Dest', destination, '-Version', process.versions.node, '-ExpectedArchiveSha256', fixtureArchiveSha256,
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(corrupt.status, 0, 'a corrupt cached Node archive must fail');
  assert.ok(!existsSync(archivePath), 'a corrupt Node cache must be removed so the next attempt can redownload');
  assert.ok(existsSync(path.join(destination, 'node.exe')), 'archive validation failure must preserve the current Node runtime');
} finally {
  rmSync(nodeBootstrapRoot, { recursive: true, force: true });
}

const optionalFailureIsolationCheck = [
  `$fixture='${escapePs(path.join(os.tmpdir(), `my-agent-optional-failure-${process.pid}`))}'`,
  'Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue',
  "New-Item -ItemType Directory -Force -Path (Join-Path $fixture 'tools')|Out-Null",
  `Copy-Item -LiteralPath '${escapePs(path.join(root, 'tools', 'install', 'optional-runtimes.ps1'))}' -Destination (Join-Path $fixture 'optional-runtimes.ps1')`,
  `$child=Join-Path $fixture 'tools\\bootstrap-ffmpeg-if-needed.ps1'`,
  "[IO.File]::WriteAllText($child, \"param([string]`$Root)`nWrite-Error 'fixture failure'`nexit 7`n\")",
  `. (Join-Path $fixture 'optional-runtimes.ps1')`,
  `$ErrorActionPreference='Stop'`,
  `$result=Install-SelectedOptionalRuntimes -Root $fixture -Selected @('ffmpeg')`,
  "if(@($result.Failed) -notcontains 'ffmpeg'){throw 'optional failure escaped or was not recorded'}",
  'Remove-Item -LiteralPath $fixture -Recurse -Force',
  "'optional-failure-isolation-check: PASS'",
].join(';');
const optionalFailureIsolated = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', optionalFailureIsolationCheck], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(optionalFailureIsolated.status, 0, optionalFailureIsolated.stderr || optionalFailureIsolated.stdout);

const fullTransactionCheck = [
  "$ErrorActionPreference='Stop'",
  `. '${escapePs(path.join(root, 'tools', 'install', 'install-transaction.ps1'))}'`,
  'function Should-SkipRel([string]$rel){return $false}',
  `$fixture='${escapePs(path.join(os.tmpdir(), `my-agent-full-transaction-${process.pid}`))}'`,
  "$src=Join-Path $fixture 'source';$dst=Join-Path $fixture 'target'",
  'Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue',
  'New-Item -ItemType Directory -Force -Path $src,$dst|Out-Null',
  "Set-Content -LiteralPath (Join-Path $src 'a.txt') -Value new-a",
  "Set-Content -LiteralPath (Join-Path $dst 'a.txt') -Value old-a",
  "New-Item -ItemType Directory -Force -Path (Join-Path $dst 'core')|Out-Null",
  "Set-Content -LiteralPath (Join-Path $dst 'core\\stale.txt') -Value old-stale",
  "Set-Content -LiteralPath (Join-Path $dst 'INSTALL-DONE.txt') -Value old-marker",
  "New-Item -ItemType Directory -Force -Path (Join-Path $dst 'node_modules')|Out-Null",
  "Set-Content -LiteralPath (Join-Path $dst 'node_modules\\old-core.txt') -Value old-core",
  '$tx=Start-InstallProductTransaction -SourceRoot $src -TargetRoot $dst -RunId fullfail01',
  "if((Get-Content -LiteralPath (Join-Path $dst 'a.txt') -Raw).Trim() -ne 'new-a'){throw 'new payload missing'}",
  "if(Test-Path -LiteralPath (Join-Path $dst 'core\\stale.txt')){throw 'stale managed file was not removed'}",
  "if(Test-Path -LiteralPath (Join-Path $dst 'INSTALL-DONE.txt')){throw 'old completion marker remained during transaction'}",
  "Move-Item -LiteralPath (Join-Path $dst 'node_modules') -Destination (Join-Path $dst 'node_modules.previous')",
  "New-Item -ItemType Directory -Force -Path (Join-Path $dst 'node_modules')|Out-Null",
  "Set-Content -LiteralPath (Join-Path $dst 'node_modules\\new-core.txt') -Value new-core",
  'Undo-InstallTransaction $tx',
  "if((Get-Content -LiteralPath (Join-Path $dst 'a.txt') -Raw).Trim() -ne 'old-a'){throw 'product rollback failed'}",
  "if((Get-Content -LiteralPath (Join-Path $dst 'core\\stale.txt') -Raw).Trim() -ne 'old-stale'){throw 'stale rollback failed'}",
  "if((Get-Content -LiteralPath (Join-Path $dst 'INSTALL-DONE.txt') -Raw).Trim() -ne 'old-marker'){throw 'completion marker rollback failed'}",
  "if(-not (Test-Path -LiteralPath (Join-Path $dst 'node_modules\\old-core.txt'))){throw 'core runtime rollback failed'}",
  '$tx=Start-InstallProductTransaction -SourceRoot $src -TargetRoot $dst -RunId fullok001',
  "Set-Content -LiteralPath (Join-Path $dst 'INSTALL-DONE.txt') -Value new-marker",
  'Complete-InstallProductTransaction $tx',
  "if(Test-Path -LiteralPath (Join-Path $dst '.install-transaction.json')){throw 'committed state was not cleared'}",
  "if(Test-Path -LiteralPath (Join-Path $dst 'core\\stale.txt')){throw 'stale file returned after commit'}",
  "Set-Content -LiteralPath (Join-Path $src 'a.txt') -Value interrupted-a",
  '$tx=Start-InstallProductTransaction -SourceRoot $src -TargetRoot $dst -RunId interrupt01',
  'Recover-PendingInstallTransaction $dst',
  "if((Get-Content -LiteralPath (Join-Path $dst 'a.txt') -Raw).Trim() -ne 'new-a'){throw 'interrupted install was not recovered'}",
  "Set-Content -LiteralPath (Join-Path $dst 'untouched.txt') -Value untouched",
  "$earlyStage=Join-Path $dst '.install-payload-early0001';$earlyBackup=Join-Path $dst '.install-backup-early0001'",
  'New-Item -ItemType Directory -Force -Path $earlyStage,$earlyBackup|Out-Null',
  "$early=[pscustomobject]@{RunId='early0001';TargetRoot=$dst;StageRoot=$earlyStage;BackupRoot=$earlyBackup;Affected=@('untouched.txt','never-created.txt');PreviouslyExisting=@('untouched.txt');CoreHadPrevious=$true;StartedAt=(Get-Date -Format o)}",
  'Write-InstallTransactionState $early',
  'Recover-PendingInstallTransaction $dst',
  "if((Get-Content -LiteralPath (Join-Path $dst 'untouched.txt') -Raw).Trim() -ne 'untouched'){throw 'pre-move recovery deleted an untouched old file'}",
  "$unsafeState=@{version=2;run_id='unsafe001';target_root=$dst;stage_root=(Join-Path $dst 'data');backup_root=(Join-Path $dst 'data');affected=@('sessions');previously_existing=@('sessions');core_had_previous=$true;started_at=(Get-Date -Format o)}|ConvertTo-Json",
  "Set-Content -LiteralPath (Join-Path $dst '.install-transaction.json') -Value $unsafeState",
  "$unsafeRejected=$false;try{Recover-PendingInstallTransaction $dst}catch{if($_.Exception.Message -match 'INSTALL_RECOVERY_(STAGE|BACKUP)_PATH_INVALID'){$unsafeRejected=$true}else{throw}}",
  "if(-not $unsafeRejected){throw 'unsafe in-target recovery roots were accepted'}",
  "Remove-Item -LiteralPath (Join-Path $dst '.install-transaction.json') -Force",
  "$migrationSrc=Join-Path $fixture 'migration-source';$migrationDst=Join-Path $fixture 'migration-target'",
  "New-Item -ItemType Directory -Force -Path (Join-Path $migrationSrc 'shape'),$migrationDst|Out-Null",
  "Set-Content -LiteralPath (Join-Path $migrationSrc 'shape\\child.txt') -Value child",
  "Set-Content -LiteralPath (Join-Path $migrationDst 'shape') -Value old-file",
  "$oldManifest=@{version=1;files=@('shape')}|ConvertTo-Json;Set-Content -LiteralPath (Join-Path $migrationDst '.install-product-files.json') -Value $oldManifest",
  '$tx=Start-InstallProductTransaction -SourceRoot $migrationSrc -TargetRoot $migrationDst -RunId migrate01',
  "if((Get-Content -LiteralPath (Join-Path $migrationDst 'shape\\child.txt') -Raw).Trim() -ne 'child'){throw 'file-to-directory migration failed'}",
  'Undo-InstallTransaction $tx',
  "if((Get-Content -LiteralPath (Join-Path $migrationDst 'shape') -Raw).Trim() -ne 'old-file'){throw 'file-to-directory rollback failed'}",
  "$reverseSrc=Join-Path $fixture 'reverse-source';$reverseDst=Join-Path $fixture 'reverse-target'",
  "New-Item -ItemType Directory -Force -Path $reverseSrc,(Join-Path $reverseDst 'shape')|Out-Null",
  "Set-Content -LiteralPath (Join-Path $reverseSrc 'shape') -Value new-file",
  "Set-Content -LiteralPath (Join-Path $reverseDst 'shape\\old.txt') -Value old-child",
  "$reverseManifest=@{version=1;files=@('shape\\old.txt')}|ConvertTo-Json;Set-Content -LiteralPath (Join-Path $reverseDst '.install-product-files.json') -Value $reverseManifest",
  '$tx=Start-InstallProductTransaction -SourceRoot $reverseSrc -TargetRoot $reverseDst -RunId reverse01',
  "if(-not (Test-Path -LiteralPath (Join-Path $reverseDst 'shape') -PathType Leaf)){throw 'directory-to-file migration failed'}",
  "if((Get-Content -LiteralPath (Join-Path $reverseDst 'shape') -Raw).Trim() -ne 'new-file'){throw 'directory-to-file payload mismatch'}",
  'Undo-InstallTransaction $tx',
  "if((Get-Content -LiteralPath (Join-Path $reverseDst 'shape\\old.txt') -Raw).Trim() -ne 'old-child'){throw 'directory-to-file rollback failed'}",
  'Remove-Item -LiteralPath $fixture -Recurse -Force',
  "'full-install-transaction-check: PASS'",
].join(';');
const fullTransactionChecked = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', fullTransactionCheck], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(fullTransactionChecked.status, 0, fullTransactionChecked.stderr || fullTransactionChecked.stdout);

function seedModule(base, rel, pkg, extra = {}) {
  const dir = path.join(base, 'nm', ...rel.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0', type: 'module', main: 'index.js', ...extra }));
  writeFileSync(path.join(dir, 'index.js'), 'export const ok = true;\n');
  return dir;
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'my-agent-core-restore-'));
try {
  const tools = path.join(temp, 'tools');
  const runtimeNode = path.join(temp, 'runtime', 'node');
  mkdirSync(tools, { recursive: true });
  mkdirSync(runtimeNode, { recursive: true });
  for (const name of ['core-npm-deps.ps1', 'restore-core-npm-deps.ps1']) {
    copyFileSync(path.join(root, 'tools', name), path.join(tools, name));
  }
  copyFileSync(process.execPath, path.join(runtimeNode, 'node.exe'));

  const sdk = seedModule(temp, '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk', {
    exports: { './client/index.js': './client/index.js' },
  });
  mkdirSync(path.join(sdk, 'client'), { recursive: true });
  writeFileSync(path.join(sdk, 'client', 'index.js'), 'export const ok = true;\n');
  seedModule(temp, 'mammoth', 'mammoth');
  seedModule(temp, 'pdf-parse', 'pdf-parse');
  mkdirSync(path.join(temp, 'node_modules'), { recursive: true });
  writeFileSync(path.join(temp, 'node_modules', 'old-runtime.txt'), 'old');

  const run = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'restore-core-npm-deps.ps1'), '-Root', temp,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.ok(existsSync(path.join(temp, 'node_modules', 'mammoth', 'package.json')));
  assert.ok(!existsSync(path.join(temp, 'node_modules', 'old-runtime.txt')), 'old runtime must be atomically replaced');
  assert.ok(!existsSync(path.join(temp, 'node_modules.previous')), 'backup must be removed after verification');

  rmSync(path.join(temp, 'nm', 'pdf-parse'), { recursive: true, force: true });
  writeFileSync(path.join(temp, 'node_modules', 'keep-on-failure.txt'), 'keep');
  const failed = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'restore-core-npm-deps.ps1'), '-Root', temp,
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(failed.status, 0, 'corrupt bundle must fail');
  assert.ok(existsSync(path.join(temp, 'node_modules', 'keep-on-failure.txt')), 'failed staging validation must preserve current runtime');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const builtProbePath = path.join(root, 'core', 'dist', 'browser', 'playwright-probe.js');
if (existsSync(builtProbePath)) {
  const isolated = mkdtempSync(path.join(os.tmpdir(), 'my-agent-playwright-isolated-'));
  try {
    const packageDir = path.join(isolated, 'runtime', 'playwright', 'package', 'node_modules', 'playwright');
    const browserDir = path.join(isolated, 'runtime', 'playwright', 'browsers', 'chromium-test', 'chrome-win');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(browserDir, { recursive: true });
    writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.52.0', main: 'index.js' }));
    writeFileSync(path.join(packageDir, 'index.js'), 'module.exports={chromium:{isolated:true}};\n');
    writeFileSync(path.join(isolated, 'runtime', 'playwright', 'browsers', '.chromium-installed'), 'ok');
    writeFileSync(path.join(browserDir, 'chrome.exe'), 'fixture');
    const builtProbe = await import(`${pathToFileURL(builtProbePath).href}?t=${Date.now()}`);
    const result = builtProbe.probePlaywright(isolated);
    assert.equal(result.available, true);
    assert.match(result.module_path, /runtime[\\/]playwright[\\/]package/);
    const loaded = await builtProbe.importPlaywright(isolated);
    assert.equal(loaded.chromium.isolated, true, 'runtime loader must import from isolated package root');
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
}

console.log('verify-installer-runtime-layout: ok');
