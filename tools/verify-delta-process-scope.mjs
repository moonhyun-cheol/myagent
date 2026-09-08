import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Load only function ASTs: never execute the updater or stop a real process.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'tools/update/apply-delta.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Get-MyAgentPidsUnderRoot', 'Stop-MyAgentForDelta')) {
  $fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if (-not $fn) { throw "Missing function $name" }
  . ([scriptblock]::Create($fn.Extent.Text))
}
function Get-CimInstance { param($ClassName, $ErrorAction) $script:processes }
function Get-Process { throw 'Unscoped process fallback is forbidden' }
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) $script:stopped += $Id }
function Start-Sleep { param($Seconds) }
function Fixture($id, $exe, $cmd = '', $name = 'MYAgent.exe') {
  [pscustomobject]@{ProcessId=$id; ExecutablePath=$exe; CommandLine=$cmd; Name=$name}
}
$target = Join-Path (Get-Location) 'data/scope-install'
$script:processes = @(
  (Fixture 1 "$target\MYAgent.exe"),
  (Fixture 2 "$target\bin\my-agent\MYAgent.exe"),
  (Fixture 3 "$target-other\MYAgent.exe"),
  (Fixture 4 ''),
  (Fixture 5 '' "MYAgent.exe --root $target"),
  (Fixture 6 'C:\other\MYAgent.exe' "MYAgent.exe --root $target"),
  (Fixture 7 "$target\node.exe" '' 'node.exe'),
  (Fixture 8 "$($target.ToUpperInvariant())\MYAgent.exe")
)
$script:stopped = @()
$ids = @(Get-MyAgentPidsUnderRoot $target)
if (($ids -join ',') -ne '1,2,8') { throw "Wrong target ids: $ids" }
if (-not (Stop-MyAgentForDelta "$target\")) { throw 'Expected targeted stop' }
if (($script:stopped -join ',') -ne '1,2,8') { throw "Wrong stopped ids: $script:stopped" }
$script:processes = @($script:processes | Where-Object { $_.ProcessId -in 3,4,5,6,7 })
$script:stopped = @()
if (Stop-MyAgentForDelta $target) { throw 'Unrelated install stopped' }
if ($script:stopped.Count) { throw 'Unexpected stop' }
Write-Output 'PASS: delta process scope, path boundary/case, unknown/argument-only paths, no global fallback'
`;
const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 30000,
});
process.stdout.write(r.stdout ?? '');
process.stderr.write(r.stderr ?? '');
assert.equal(r.status, 0, r.error?.message ?? 'delta scope regression failed');
