# Apply MY Agent delta zip - preserves data/, logs/, runtime/
# Shell binaries (bin/my-agent) are often locked by a running MYAgent.exe;
# stop that process first and prefer in-place overwrite over wipe+copy.
param(
  [Parameter(Mandatory = $false)]
  [string]$Root = '',
  [Parameter(Mandatory = $false)]
  [string]$ZipPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  if ($PSScriptRoot) {
    $Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  } else {
    Write-Host 'Root could not be determined. Pass -Root explicitly.'
    exit 1
  }
}

# Normalize paths passed from cmd.exe (trailing backslash before " causes C:\path\")
$Root = $Root.Trim().Trim('"').TrimEnd('\', '/')
while ($Root.EndsWith('"')) { $Root = $Root.TrimEnd('"') }

if (-not (Test-Path -LiteralPath $Root)) {
  Write-Host "Root not found: $Root"
  exit 1
}
$Root = (Resolve-Path -LiteralPath $Root).Path

if (-not $ZipPath) {
  $candidates = Get-ChildItem -Path $Root -Filter 'MYAgent-v*-delta.zip' -File | Sort-Object LastWriteTime -Descending
  if ($candidates.Count -eq 0) {
    Write-Host 'delta zip not found. Pass -ZipPath or place MYAgent-v*-delta.zip in install folder.'
    exit 1
  }
  $ZipPath = $candidates[0].FullName
}

if (-not (Test-Path $ZipPath)) {
  Write-Host "Zip not found: $ZipPath"
  exit 1
}

function Get-MyAgentPidsUnderRoot {
  param([string]$InstallRoot)
  $pids = @()
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -ieq 'MYAgent.exe'
  } | ForEach-Object {
    $cmd = [string]$_.CommandLine
    $exe = [string]$_.ExecutablePath
    $hit =
      ($exe -and $exe.StartsWith($InstallRoot, [StringComparison]::OrdinalIgnoreCase)) -or
      ($cmd -and $cmd.IndexOf($InstallRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    if ($hit -or (-not $exe -and -not $cmd)) {
      # No path info: still stop - delta cannot replace WebView2Loader while MY Agent holds it.
      $pids += $_.ProcessId
    }
  }
  return @($pids | Select-Object -Unique)
}

function Stop-MyAgentForDelta {
  param([string]$InstallRoot)
  $pids = Get-MyAgentPidsUnderRoot -InstallRoot $InstallRoot
  if (-not $pids.Count) {
    # Fallback: either legacy or product entry process (path often blank under some hosts)
    $pids = @(
      Get-Process -Name 'MYAgent' -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Id
    )
  }
  if (-not $pids.Count) { return $false }
  Write-Host ("Stopping MYAgent.exe (pid {0}) so the application can be updated..." -f ($pids -join ', '))
  foreach ($procId in $pids) {
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  return $true
}

function Clear-ReadOnlyRecursive {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
    try { $_.Attributes = $_.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly) } catch { }
  }
  try {
    $item = Get-Item -LiteralPath $Path -Force
    $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
  } catch { }
}

function Backup-ChatDataBeforeUpdate {
  param(
    [string]$InstallRoot,
    [int]$Keep = 5
  )
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupRoot = Join-Path $InstallRoot 'data\backups'
  $dest = Join-Path $backupRoot ("pre-update-$stamp")
  $copied = @()

  foreach ($rel in @('data\sessions', 'data\projects')) {
    $src = Join-Path $InstallRoot $rel
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $hasFiles = @(Get-ChildItem -LiteralPath $src -Force -ErrorAction SilentlyContinue | Select-Object -First 1).Count -gt 0
    if (-not $hasFiles) { continue }
    $target = Join-Path $dest ($rel -replace '^data\\', '')
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $src '*') -Destination $target -Recurse -Force -ErrorAction SilentlyContinue
    $copied += $rel
  }

  if (-not $copied.Count) {
    Write-Host '[SKIP] chat backup - no sessions/projects yet'
    return $null
  }

  Write-Host ("[OK] chat backup -> data\backups\pre-update-{0} ({1})" -f $stamp, ($copied -join ', '))

  # Rotate: keep newest $Keep pre-update-* folders
  $old = @(Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'pre-update-*' } |
    Sort-Object Name -Descending)
  if ($old.Count -gt $Keep) {
    $old | Select-Object -Skip $Keep | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  return $dest
}

function Copy-DeltaTree {
  param(
    [string]$Src,
    [string]$Dst,
    [string]$Rel
  )
  $isDir = Test-Path -LiteralPath $Src -PathType Container
  if (-not $isDir) {
    $dstDir = Split-Path $Dst -Parent
    if (-not (Test-Path -LiteralPath $dstDir)) {
      New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
    }
    Copy-Item -LiteralPath $Src -Destination $Dst -Force
    return
  }

  if (-not (Test-Path -LiteralPath $Dst)) {
    New-Item -ItemType Directory -Path $Dst -Force | Out-Null
  }

  # Prefer robocopy in-place overwrite (no wipe). Locked DLLs still need process stop.
  $robocopy = Get-Command robocopy.exe -ErrorAction SilentlyContinue
  if ($robocopy) {
    Clear-ReadOnlyRecursive -Path $Dst
    & robocopy.exe $Src $Dst /E /IS /IT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    $code = $LASTEXITCODE
    # robocopy: 0-7 success-ish; >=8 failure
    if ($code -ge 8) {
      throw "robocopy failed for $Rel (exit $code)"
    }
    return
  }

  # Fallback: remove then copy, with retries after stopping shell.
  Clear-ReadOnlyRecursive -Path $Dst
  $tries = 0
  while ($tries -lt 3) {
    $tries++
    try {
      if (Test-Path -LiteralPath $Dst) {
        Remove-Item -LiteralPath $Dst -Recurse -Force -ErrorAction Stop
      }
      Copy-Item -LiteralPath $Src -Destination $Dst -Recurse -Force
      return
    } catch {
      if ($tries -ge 3) { throw }
      Write-Host ("[RETRY] $Rel locked - stopping MY Agent and retrying ($tries/3)...")
      [void](Stop-MyAgentForDelta -InstallRoot $Root)
      Start-Sleep -Seconds 1
    }
  }
}

$temp = Join-Path $env:TEMP ("my-agent-delta-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $temp | Out-Null

$failed = @()
$ok = @()

try {
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $temp -Force

  # Always free shell locks before touching bin\my-agent (and early, so later copies are safe).
  [void](Stop-MyAgentForDelta -InstallRoot $Root)

  # Snapshot chat before any file replaces (data/ itself is never overwritten by allowlist,
  # but explicit backup protects against accidental wipe / bad manual install).
  [void](Backup-ChatDataBeforeUpdate -InstallRoot $Root -Keep 5)

  # Allowlist only - never touch data/, logs/, runtime/ (ffmpeg/node/playwright/oss-sidecars stay local)
  $allowed = @(
    'core\dist',
    'core\config\defaults',
    'ui\workspace\dist',
    'MYAgent.exe',
    'MYAgent.Updater.exe',
    'bin\my-agent',
    'manifest.json',
    'VERSION.txt',
    'rulebook',
    '.rulebook-link.yml',
    'UPDATE.bat',
    'tools\update\apply-delta.ps1',
    'tools\bootstrap-ffmpeg.ps1',
    'tools\bootstrap-ffmpeg-if-needed.ps1',
    'tools\bootstrap-oss-sidecars.ps1',
    'tools\bootstrap-oss-sidecars-if-needed.ps1',
    'tools\requirements-oss-sidecars.txt',
    'tools\oss-sidecars-package.json'
  )

  foreach ($rel in $allowed) {
    $src = Join-Path $temp $rel
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $dst = Join-Path $Root $rel
    try {
      if ($rel -eq 'bin\my-agent' -or $rel -eq 'MYAgent.exe') {
        [void](Stop-MyAgentForDelta -InstallRoot $Root)
      }
      Copy-DeltaTree -Src $src -Dst $dst -Rel $rel
      Write-Host "[OK] $rel"
      $ok += $rel
    } catch {
      $msg = $_.Exception.Message
      Write-Host "[FAIL] $rel - $msg"
      $failed += [pscustomobject]@{ Rel = $rel; Error = $msg }
      # Do not abort the whole delta - core/UI may already be updated.
    }
  }

  # Optional extras only when the install checklist selected them.
  $optionalHelper = Join-Path $Root 'tools\install\optional-runtimes.ps1'
  $wantSidecars = @()
  if (Test-Path -LiteralPath $optionalHelper) {
    . $optionalHelper
    foreach ($id in @('markitdown', 'repomix', 'ast_grep')) {
      if (Test-OptionalRuntimeSelected -Root $Root -Id $id) { $wantSidecars += $id }
    }
  }
  if ($wantSidecars.Count -gt 0 -and $env:MY_AGENT_UPDATE_SKIP_OPTIONAL -ne '1' -and $env:MY_AGENT_INSTALL_SKIP_OPTIONAL -ne '1') {
    Write-Host ''
    Write-Host 'Ensuring selected document/code helpers...'
    try {
      Install-SelectedOptionalRuntimes -Root $Root -Selected $wantSidecars
    } catch {
      Write-Warning "Optional sidecars bootstrap deferred: $($_.Exception.Message)"
    }
  }

  Write-Host ''
  if ($failed.Count -eq 0) {
    Write-Host 'Delta applied. data/ preserved (chat also snapshotted under data\backups\). Restart with MYAgent.exe'
    exit 0
  }

  Write-Host 'Delta partially applied.'
  Write-Host 'Failed:'
  foreach ($f in $failed) {
    Write-Host ("  - {0}: {1}" -f $f.Rel, $f.Error)
  }
  if ($failed.Rel -contains 'bin\my-agent' -or $failed.Rel -contains 'MYAgent.exe') {
    Write-Host ''
    Write-Host 'bin\my-agent was locked. Close MY Agent completely (Task Manager -> MYAgent.exe),'
    Write-Host 'then run UPDATE.bat again. Core/UI updates above are already on disk.'
  }
  exit 1
} finally {
  if (Test-Path -LiteralPath $temp) {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
