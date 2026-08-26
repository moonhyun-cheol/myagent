#requires -Version 5.1
<#
.SYNOPSIS
  Reset MY Agent user state for a clean first-run experience.
#>
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root

$targets = @(
    'data\vault\license.ocx',
    'data\vault\provider-keys.json',
    'data\vault\keys-bundle.enc',
    'data\vault\activation.json',
    'data\config\user-overrides.json',
    'data\sessions',
    'data\attachments',
    'data\outputs',
    'data\webview-user-data',
    'license.ocx',
    'keys-bundle.enc'
)

$ensureDirs = @(
    'data\vault',
    'data\config',
    'data\sessions',
    'data\attachments',
    'data\outputs\images',
    'data\outputs\research'
)

if (-not $Force) {
    Write-Host ''
    Write-Host 'MY Agent first-run reset' -ForegroundColor Cyan
    Write-Host 'Removes license, API keys, chats, attachments, settings, WebView profile.'
    Write-Host 'Keeps: core/, ui/, runtime/, local GGUF under models/ (if any).'
    Write-Host ''
    $answer = Read-Host 'Continue? [y/N]'
    if ($answer -notmatch '^[yY]') {
        Write-Host 'Cancelled.'
        exit 0
    }
}

$removed = 0
foreach ($rel in $targets) {
    $full = Join-Path $root $rel
    if (-not (Test-Path -LiteralPath $full)) { continue }
    Remove-Item -LiteralPath $full -Recurse -Force
    Write-Host "[removed] $rel"
    $removed++
}

foreach ($rel in $ensureDirs) {
    $full = Join-Path $root $rel
    if (-not (Test-Path -LiteralPath $full)) {
        New-Item -ItemType Directory -Force -Path $full | Out-Null
        Write-Host "[created] $rel"
    }
}

Write-Host ''
Write-Host "Reset complete ($removed item(s) removed)." -ForegroundColor Green
Write-Host 'Next: MYAgent.exe (activation server should be running for auto license).'
