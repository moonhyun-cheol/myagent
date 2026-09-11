#requires -Version 5.1
<#
.SYNOPSIS
  Run a native exe without PowerShell Stop treating stderr (npm notice/warn) as terminating.
  Returns the process exit code. stdout/stderr lines are written via Write-Host.
#>
function Invoke-CqrNative {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @()
  )
  if (-not (Test-Path -LiteralPath $FilePath)) {
    Write-Error "Invoke-CqrNative: not found: $FilePath"
    return 1
  }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $code = 0
  try {
    # 2>&1 + Continue: npm/pip stderr becomes ErrorRecord objects, not terminating errors.
    $lines = & $FilePath @ArgumentList 2>&1
    if ($null -ne $LASTEXITCODE) { $code = [int]$LASTEXITCODE }
    foreach ($line in @($lines)) {
      if ($null -eq $line) { continue }
      $text = if ($line -is [System.Management.Automation.ErrorRecord]) {
        $line.ToString()
      } else {
        "$line"
      }
      if ($text -ne '') { Write-Host $text }
    }
  } catch {
    Write-Host ("Invoke-CqrNative: " + $_.Exception.Message)
    $code = 1
  } finally {
    $ErrorActionPreference = $prev
  }
  return $code
}

<#
.SYNOPSIS
  Run a native exe bounded by a wall-clock timeout so a stalled child (hung npm
  install / browser download / pip) can never block the installer forever.
  Returns the process exit code, or 124 after killing the process tree on timeout.
#>
function Invoke-CqrNativeTimed {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [int]$TimeoutSec = 600,
    [string]$WorkingDirectory = ''
  )
  if (-not (Test-Path -LiteralPath $FilePath)) {
    Write-Host "Invoke-CqrNativeTimed: not found: $FilePath"
    return 1
  }
  $spArgs = @{ FilePath = $FilePath; NoNewWindow = $true; PassThru = $true }
  if ($ArgumentList -and $ArgumentList.Count -gt 0) { $spArgs.ArgumentList = $ArgumentList }
  if ($WorkingDirectory -and (Test-Path -LiteralPath $WorkingDirectory)) { $spArgs.WorkingDirectory = $WorkingDirectory }
  $proc = Start-Process @spArgs
  if (-not $proc.WaitForExit([int]([Math]::Max(1, $TimeoutSec) * 1000))) {
    Write-Host "Invoke-CqrNativeTimed: step exceeded ${TimeoutSec}s -> aborting hung process (pid=$($proc.Id))"
    try { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null } catch { }
    return 124
  }
  try { $proc.WaitForExit() } catch { }
  return [int]$proc.ExitCode
}

<#
.SYNOPSIS
  Verify a folder can be created + written + deleted before a long download, so a
  blocked path (antivirus / Controlled Folder Access / inherited ACL) surfaces
  immediately with actionable text instead of a silent mid-download stall.
#>
function Test-CqrPathWritable([string]$Folder) {
  try {
    New-Item -ItemType Directory -Force -Path $Folder | Out-Null
    $probe = Join-Path $Folder ('.cqr-probe-{0}-{1}' -f $PID, [Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($probe, 'probe')
    Remove-Item -LiteralPath $probe -Force
    return $true
  } catch {
    return $false
  }
}

<#
.SYNOPSIS
  Download a URL to a file bounded by a wall-clock timeout (Invoke-WebRequest has
  no hard cap and can hang on a dead/slow connection). Returns 0 on success, 1 on
  request failure, or 124 on timeout (partial file removed).
#>
function Invoke-CqrDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [int]$TimeoutSec = 600
  )
  $job = Start-Job -ScriptBlock {
    param($u, $o)
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $u -OutFile $o -UseBasicParsing
  } -ArgumentList $Uri, $OutFile
  if (Wait-Job $job -Timeout ([int][Math]::Max(1, $TimeoutSec))) {
    $failed = ($job.State -eq 'Failed')
    try { Receive-Job $job -ErrorAction SilentlyContinue | Out-Host } catch { $failed = $true }
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    if ($failed) {
      if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }
      return 1
    }
    return 0
  }
  Stop-Job $job -ErrorAction SilentlyContinue
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }
  return 124
}
