#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const ps = (value) => `'${value.replaceAll("'", "''")}'`;
const install = read('tools/install/install.ps1');
for (const check of ['Assert-InstallWebView2Runtime', 'Assert-InstallDiskSpace']) {
  assert.ok(install.indexOf(check) < install.indexOf('Recover-PendingInstallTransaction'), `${check} must precede recovery/mutation`);
}
assert.ok(install.includes("'tools\\lab'"));
const publish = read('tools/publish.mjs');
const filterSource = publish.slice(publish.indexOf('const skipDirs ='), publish.indexOf('function copyTree('));
const shouldCopy = vm.runInNewContext(`${filterSource}\nshouldCopy`);
for (const rel of ['tools/lab', 'tools/lab/a/bin/Debug/file.dll', 'tools\\lab\\file.txt']) {
  assert.equal(shouldCopy(rel), false, `developer experiment leaked: ${rel}`);
}
for (const rel of ['tools/install/install-preflight.ps1', 'tools/playwright-runtime.ps1', 'core/dist/main.js']) {
  assert.equal(shouldCopy(rel), true, `required product file excluded: ${rel}`);
}

const fixture = mkdtempSync(path.join(os.tmpdir(), 'my-agent-installer-safety-'));
try {
  const script = path.join(fixture, 'verify.ps1');
  writeFileSync(script, `
$ErrorActionPreference = 'Stop'
. ${ps(path.join(root, 'tools/install/install-paths.ps1'))}
. ${ps(path.join(root, 'tools/install/install-preflight.ps1'))}
function Expect-Error([scriptblock]$Action, [string]$Pattern) {
  $caught = $false
  try { & $Action } catch { if ($_.Exception.Message -like $Pattern) { $caught = $true } else { throw } }
  if (-not $caught) { throw ('Expected error: ' + $Pattern) }
}
$fixture = ${ps(fixture)}
foreach ($file in @(${['install-paths.ps1', 'install-preflight.ps1', 'install.ps1', 'install-ui.ps1'].map((name) => ps(path.join(root, 'tools/install', name))).join(',')})) {
  $tokens = $null; $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
}
# Redirect the pointer to an isolated user profile; never write real registry/profile state.
$env:LOCALAPPDATA = Join-Path $fixture 'profile'
$env:MY_AGENT_INSTALL_DEFAULT = ''
$existing = Join-Path $fixture 'existing & custom'
$pointer = Join-Path $env:LOCALAPPDATA 'MYAgent\\install-root.json'
New-Item -ItemType Directory -Force -Path $existing,(Split-Path $pointer -Parent) | Out-Null
[IO.File]::WriteAllText((Join-Path $existing 'MYAgent.exe'), 'fixture')
[IO.File]::WriteAllText((Join-Path $existing 'manifest.json'), '{}')
[IO.File]::WriteAllText((Join-Path $existing 'user-data.txt'), 'must-survive')
[IO.File]::WriteAllText($pointer, (@{install_root=$existing}|ConvertTo-Json))
if ((Get-DefaultInstallPath) -ne $existing) { throw 'existing path not preferred' }
$env:MY_AGENT_INSTALL_DEFAULT = Join-Path $fixture 'override'
if ((Get-DefaultInstallPath) -ne $env:MY_AGENT_INSTALL_DEFAULT) { throw 'explicit override lost' }
$env:MY_AGENT_INSTALL_DEFAULT = ''
# Avoid the extracted source, its children, and its parents without probing real defaults.
function Get-CurrentUserInstallPath { return (Join-Path $fixture 'per-user') }
function Get-InstallPathCandidates { return @($existing, (Join-Path $fixture 'fallback')) }
if ((Get-DefaultInstallPath -AvoidPath $existing) -eq $existing) { throw 'source path selected' }
if ((Get-DefaultInstallPath -AvoidPath (Join-Path $existing 'app')) -eq $existing) { throw 'source parent selected' }
function Test-InstallPathCandidateWritable([string]$folder) { return $false }
Expect-Error { Get-DefaultInstallPath } 'EXISTING_INSTALL_NOT_WRITABLE:*'
[IO.File]::WriteAllText($pointer, '{invalid')
if ($null -ne (Get-RecordedInstallPath)) { throw 'corrupt pointer accepted' }
[IO.File]::WriteAllText($pointer, (@{install_root=(Join-Path $fixture 'missing')}|ConvertTo-Json))
if ($null -ne (Get-RecordedInstallPath)) { throw 'stale pointer accepted' }
[IO.File]::WriteAllText($pointer, (@{install_root='relative'}|ConvertTo-Json))
if ($null -ne (Get-RecordedInstallPath)) { throw 'relative pointer accepted' }
[IO.File]::WriteAllText($pointer, (@{cqr_root=$existing}|ConvertTo-Json))
if ((Get-RecordedInstallPath) -ne $existing) { throw 'legacy pointer rejected' }

if (-not (Test-WebView2Registration @{name='Microsoft Edge WebView2 Runtime';pv='130.0.1.2'})) { throw 'valid WebView registration rejected' }
if (-not (Test-WebView2Registration @{name=('Microsoft Edge WebView2 ' + [char]0xB7F0 + [char]0xD0C0 + [char]0xC784);pv='130.0.1.2'})) { throw 'localized WebView registration rejected' }
foreach ($registration in @(@{name='Microsoft Edge';pv='130.0.1.2'}, @{name='Microsoft Edge WebView2 Runtime';pv='0.0.0.0'}, @{name='Microsoft Edge WebView2 Runtime';pv='invalid'})) {
  if (Test-WebView2Registration $registration) { throw 'invalid/Edge-only registration accepted' }
}
# Exercise the real read-only registry scan as well as the missing/present branches.
$actualWebView = Test-InstallWebView2Runtime
Write-Host ('WebView2 registered on test PC: ' + $actualWebView)
function Test-InstallWebView2Runtime { return $false }
Expect-Error { Assert-InstallWebView2Runtime } 'WEBVIEW2_RUNTIME_MISSING:*'
function Test-InstallWebView2Runtime { return $true }
Assert-InstallWebView2Runtime

$source = Join-Path $fixture 'payload'
New-Item -ItemType Directory -Force -Path (Join-Path $source 'nm'),(Join-Path $source 'tools\\lab') | Out-Null
[IO.File]::WriteAllBytes((Join-Path $source 'product.bin'), (New-Object byte[] 100))
[IO.File]::WriteAllBytes((Join-Path $source 'nm\\module.bin'), (New-Object byte[] 40))
[IO.File]::WriteAllBytes((Join-Path $source 'tools\\lab\\junk.bin'), (New-Object byte[] 2000))
function Should-SkipRel([string]$rel) { return $rel.StartsWith('tools\\lab\\') }
if ((Get-InstallRequiredBytes $source) -ne (1GB + 320)) { throw 'disk estimate does not match filtered payload/restore reserve' }
if ((Get-InstallAvailableBytes $fixture) -le 0) { throw 'real quota-aware disk probe failed' }
Expect-Error { Get-InstallAvailableBytes (Join-Path $fixture 'nonexistent\\folder') } 'INSTALL_DISK_SPACE_UNKNOWN:*'
function Get-InstallAvailableBytes([string]$TargetRoot) { return 1 }
Expect-Error { Assert-InstallDiskSpace $source $existing } 'INSTALL_DISK_SPACE_LOW:*'
function Get-InstallAvailableBytes([string]$TargetRoot) { return (1GB + 320) }
Assert-InstallDiskSpace $source $existing
if ([IO.File]::ReadAllText((Join-Path $existing 'user-data.txt')) -ne 'must-survive') { throw 'preflight touched existing data' }
# Execute just the real UI completion handler without opening a window or running install.
$uiAst = [System.Management.Automation.Language.Parser]::ParseFile(${ps(path.join(root, 'tools/install/install-ui.ps1'))}, [ref]$null, [ref]$null)
$handler = $uiAst.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Complete-Install'}, $true)
Invoke-Expression $handler.Extent.Text
foreach ($case in @(@{error='WEBVIEW2_RUNTIME_MISSING: fixture';expected='*WebView2 Runtime*'}, @{error='INSTALL_DISK_SPACE_LOW: fixture';expected='*disk space*'})) {
  $script:st = @{Timer=$null;Completed=$false;Proc=[pscustomobject]@{ExitCode=1};Bar=$null;LastLine=$case.error;LogPath=(Join-Path $fixture 'no-log');Title=[pscustomobject]@{Text=''};Status=[pscustomobject]@{Text=''};Detail=[pscustomobject]@{Text=''};Elapsed=[pscustomobject]@{Text=''}}
  Complete-Install
  if ($script:st.Status.Text -notlike $case.expected) { throw ('Wrong UI failure guidance: ' + $script:st.Status.Text) }
}
'installer-safety-runtime: PASS'
`, 'utf8');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.match(result.stdout, /installer-safety-runtime: PASS/);
  console.log(result.stdout.trim());

  // Execute the actual BAT entry point with a harmless installer child.
  // ! remains literal even when the parent CMD has delayed expansion enabled.
  for (const folder of ['R&D (installer)!', 'percent%TEST% folder', "quote's & path"]) {
    const dir = path.join(fixture, folder);
    const tools = path.join(dir, 'app/tools/install');
    mkdirSync(tools, { recursive: true });
    writeFileSync(path.join(dir, 'app/MYAgent.exe'), 'fixture');
    writeFileSync(path.join(tools, 'install.ps1'), '# fixture entry marker\n');
    writeFileSync(path.join(dir, 'install.bat'), read('tools/install/install.bat'));
    writeFileSync(path.join(tools, 'install-ui.ps1'), `param([string]$SourceDir)\n[IO.File]::WriteAllText($env:MY_AGENT_BAT_PROBE, $SourceDir)\nexit 0\n`);
    const output = path.join(fixture, 'bat-result.txt');
    rmSync(output, { force: true });
    const bat = spawnSync('cmd.exe', ['/d', '/v:on', '/c', 'install.bat'], {
      cwd: dir, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, MY_AGENT_BAT_PROBE: output, TEST: 'MUST_NOT_EXPAND' },
    });
    assert.equal(bat.status, 0, bat.error?.message || bat.stderr || bat.stdout);
    assert.equal(readFileSync(output, 'utf8'), path.join(dir, 'app'), `BAT corrupted path: ${folder}`);
  }
  console.log('installer-bat-special-paths: PASS (3 paths)');

  // A tiny synthetic package proves the stage AND final-ZIP gates, without
  // rebuilding/replacing any real release asset or running its executables.
  const bundle = path.join(fixture, 'bundle');
  const app = path.join(bundle, 'app');
  const put = (rel, content = 'fixture') => {
    const file = path.join(app, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  for (const rel of ['MYAgent.exe', 'MYAgent.Updater.exe', 'core/dist/main.js', 'ui/workspace/dist/index.html',
    'runtime/node/node.exe', 'tools/install/install.ps1', 'tools/install/install-ui.ps1',
    'tools/install/install-preflight.ps1', ...['@modelcontextprotocol/sdk', 'mammoth', 'pdf-parse'].map((p) => `nm/${p}/package.json`)]) put(rel);
  for (const rel of ['core/config/defaults/deploy-defaults.json', 'core/config/defaults/skills/manifest.json',
    'core/config/defaults/license-public.pem']) put(rel, read(rel));
  put('core/dist/config/defaults/license-public.pem', read('core/config/defaults/license-public.pem'));
  writeFileSync(path.join(bundle, 'install.bat'), '@echo off\r\n');
  const zip = path.join(fixture, 'fixture-install.zip');
  const pack = () => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Compress-Archive -Path ${ps(path.join(bundle, '*'))} -DestinationPath ${ps(zip)} -Force`], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  const verify = () => spawnSync(process.execPath, [path.join(root, 'tools/verify-publish-bundle.mjs'),
    '--app-dir', app, '--zip-path', zip], { encoding: 'utf8', timeout: 30_000 });
  pack();
  const good = verify();
  assert.equal(good.status, 0, good.stderr || good.stdout);
  put('tools/lab/experiment/bin/Debug/junk.dll');
  pack();
  const bad = verify();
  assert.equal(bad.status, 1, bad.stderr || bad.stdout);
  assert.match(bad.stderr, /developer-only directory must not ship: tools\/lab/);
  assert.match(bad.stderr, /final ZIP contains developer-only files/);
  console.log('installer-package-guards: PASS (clean accepted, lab rejected in stage and ZIP)');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
console.log('verify-installer-safety: ok');
