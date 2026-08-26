#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$Root
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path

$ffmpegExe = Join-Path $Root 'runtime\ffmpeg\ffmpeg.exe'
if (Test-Path -LiteralPath $ffmpegExe) { exit 0 }

Write-Host 'bootstrap-ffmpeg-if-needed: first-run ffmpeg setup (internet required)'
& (Join-Path $PSScriptRoot 'bootstrap-ffmpeg.ps1') -Root $Root -SkipIfExists
exit $LASTEXITCODE
