#requires -Version 5.1
<#
.SYNOPSIS
  ASCII-first install locations. Prefer a folder on the system drive so Hangul
  user profiles (C:\Users\박소미\...) are not the default runtime path.
  Never pick the drive root itself (C:\). Creating C:\MYAgent is allowed when
  the employee account can write there; otherwise fall back.
#>

function Get-ProductInstallFolderName {
  return 'MYAgent'
}

function Get-InstallPathCandidates {
  if ($env:MY_AGENT_INSTALL_DEFAULT) {
    return @($env:MY_AGENT_INSTALL_DEFAULT)
  }
  $name = Get-ProductInstallFolderName
  $sys = $env:SystemDrive
  if (-not $sys) { $sys = 'C:' }
  $out = @((Join-Path $sys $name))
  if ($env:PUBLIC) {
    $out += (Join-Path $env:PUBLIC $name)
  }
  $local = [Environment]::GetFolderPath('LocalApplicationData')
  if ($local) {
    $out += (Join-Path (Join-Path $local 'Programs') $name)
  }
  return $out
}

function Test-InstallPathCandidateWritable([string]$folder) {
  if (-not $folder) { return $false }
  try {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
    $probe = Join-Path $folder ".my-agent-install-probe-$PID.tmp"
    [IO.File]::WriteAllText($probe, 'probe')
    Remove-Item -LiteralPath $probe -Force
    return $true
  } catch {
    Remove-Item -LiteralPath (Join-Path $folder ".my-agent-install-probe-$PID.tmp") -Force -ErrorAction SilentlyContinue
    return $false
  }
}

function Get-DefaultInstallPath {
  param([string]$AvoidPath = '')
  $avoid = ''
  if ($AvoidPath) {
    try { $avoid = [IO.Path]::GetFullPath($AvoidPath).TrimEnd('\') } catch { $avoid = '' }
  }
  $candidates = @(Get-InstallPathCandidates)
  $fallback = $null
  foreach ($c in $candidates) {
    if (-not $c) { continue }
    $full = $null
    try { $full = [IO.Path]::GetFullPath($c).TrimEnd('\') } catch { continue }
    if ($avoid) {
      if ($full -eq $avoid) { continue }
      if ($full.Length -gt $avoid.Length -and $full.StartsWith($avoid + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
    }
    if (-not $fallback) { $fallback = $full }
    if (Test-InstallPathCandidateWritable $full) { return $full }
  }
  if ($fallback) { return $fallback }
  $sys = $env:SystemDrive
  if (-not $sys) { $sys = 'C:' }
  return (Join-Path $sys (Get-ProductInstallFolderName))
}
