#requires -Version 5.1
# Shared validation for the three production dependencies required by core/dist.

function Test-CoreNpmDependencies {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [switch]$Quiet
  )

  $required = @(
    'node_modules\@modelcontextprotocol\sdk\package.json',
    'node_modules\mammoth\package.json',
    'node_modules\pdf-parse\package.json'
  )
  foreach ($rel in $required) {
    $candidate = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $candidate)) {
      if (-not $Quiet) { Write-Host "CORE_DEPENDENCY_MISSING: $candidate" }
      return $false
    }
  }
  if (-not (Test-Path -LiteralPath $NodeExe)) {
    if (-not $Quiet) { Write-Host "CORE_NODE_MISSING: $NodeExe" }
    return $false
  }

  $verifyScript = Join-Path $Root '.core-deps-verify.mjs'
  $verifyJs = "await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'), import('mammoth'), import('pdf-parse')]);"
  try {
    [IO.File]::WriteAllText($verifyScript, $verifyJs + "`n", [Text.UTF8Encoding]::new($false))
    & $NodeExe $verifyScript
    return ($LASTEXITCODE -eq 0)
  } catch {
    if (-not $Quiet) { Write-Host "CORE_DEPENDENCY_LOAD_FAILED: $($_.Exception.Message)" }
    return $false
  } finally {
    Remove-Item -LiteralPath $verifyScript -Force -ErrorAction SilentlyContinue
  }
}

function Assert-CoreNpmDependencies {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$NodeExe
  )
  if (-not (Test-CoreNpmDependencies -Root $Root -NodeExe $NodeExe)) {
    throw "CORE_DEPENDENCY_LOAD_FAILED: required runtime packages are missing or cannot be loaded from $Root"
  }
}
