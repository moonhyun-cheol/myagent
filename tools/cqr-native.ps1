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
