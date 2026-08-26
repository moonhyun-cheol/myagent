#requires -Version 5.1
<#
.SYNOPSIS
  Download ffmpeg essentials into runtime/ffmpeg if missing (optional, needs internet).
#>
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [switch]$SkipIfExists
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path

$destDir = Join-Path $Root 'runtime\ffmpeg'
$ffmpegExe = Join-Path $destDir 'ffmpeg.exe'
$ffprobeExe = Join-Path $destDir 'ffprobe.exe'

if ($SkipIfExists -and (Test-Path -LiteralPath $ffmpegExe)) {
  Write-Host "bootstrap-ffmpeg: skipped (exists) -> $ffmpegExe"
  exit 0
}

New-Item -ItemType Directory -Force -Path $destDir | Out-Null

$zip = Join-Path $env:TEMP ("cqr-ffmpeg-essentials-" + [guid]::NewGuid().ToString('n') + '.zip')
$extract = Join-Path $env:TEMP ("cqr-ffmpeg-extract-" + [guid]::NewGuid().ToString('n'))
$url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

try {
  Write-Host "bootstrap-ffmpeg: downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  New-Item -ItemType Directory -Force -Path $extract | Out-Null
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force

  $bin = Get-ChildItem -Path $extract -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
  $probe = Get-ChildItem -Path $extract -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1
  if (-not $bin) {
    Write-Error 'bootstrap-ffmpeg: ffmpeg.exe not found in archive'
  }
  Copy-Item -LiteralPath $bin.FullName -Destination $ffmpegExe -Force
  if ($probe) {
    Copy-Item -LiteralPath $probe.FullName -Destination $ffprobeExe -Force
  }

  & $ffmpegExe -version | Select-Object -First 1
  Write-Host "bootstrap-ffmpeg OK -> $destDir"
  exit 0
} catch {
  Write-Warning "bootstrap-ffmpeg failed: $($_.Exception.Message)"
  exit 1
} finally {
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue }
}
