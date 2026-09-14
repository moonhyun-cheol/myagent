#requires -Version 5.1
# Shared optional-runtime catalog + install helpers (ASCII script; labels live in UTF-8 JSON).

function Get-OptionalRuntimeIds {
  return @('playwright', 'ffmpeg', 'markitdown', 'repomix', 'ast_grep')
}

function Expand-OptionalRuntimeId([string]$Id) {
  $clean = ([string]$Id).Trim().ToLowerInvariant()
  if ($clean -eq 'oss_sidecars') { return @('markitdown', 'repomix', 'ast_grep') }
  return @($clean)
}

function Get-OptionalRuntimeCatalogPath([string]$Root) {
  if (-not $Root) { return $null }
  return Join-Path $Root 'core\config\defaults\optional-runtimes.json'
}

function Get-OptionalRuntimeCatalog([string]$Root) {
  $path = Get-OptionalRuntimeCatalogPath $Root
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $raw = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false))
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function ConvertTo-OptionalRuntimeIdList([string]$Csv) {
  if (-not $Csv) { return @() }
  $valid = Get-OptionalRuntimeIds
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($part in $Csv.Split(@(',', ';'), [StringSplitOptions]::RemoveEmptyEntries)) {
    foreach ($id in @(Expand-OptionalRuntimeId $part)) {
      if ($id -and ($valid -contains $id) -and -not $out.Contains($id)) {
        [void]$out.Add($id)
      }
    }
  }
  return @($out)
}

function Get-OptionalRuntimeSelectionPath([string]$Root) {
  return Join-Path $Root 'data\config\optional-runtimes.json'
}

function Read-OptionalRuntimeSelection([string]$Root) {
  $path = Get-OptionalRuntimeSelectionPath $Root
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $raw = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false))
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-DefaultOptionalRuntimeIds([string]$Root) {
  $fallback = @('repomix', 'ast_grep')
  $catalog = Get-OptionalRuntimeCatalog $Root
  if (-not $catalog) { return $fallback }
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($item in @($catalog.optional_runtimes)) {
    $id = [string]$item.id
    if ($id -and [bool]$item.default_selected) { [void]$out.Add($id) }
  }
  if ($out.Count -eq 0) { return $fallback }
  return @($out)
}

function Test-OptionalRuntimeSelected {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Id
  )
  $doc = Read-OptionalRuntimeSelection $Root
  $selected = New-Object System.Collections.Generic.List[string]
  if ($doc) {
    foreach ($raw in @($doc.selected)) {
      foreach ($id in @(Expand-OptionalRuntimeId $raw)) {
        if ($id -and -not $selected.Contains($id)) { [void]$selected.Add($id) }
      }
    }
  } else {
    foreach ($id in @(Get-DefaultOptionalRuntimeIds $Root)) {
      if ($id -and -not $selected.Contains($id)) { [void]$selected.Add($id) }
    }
  }
  foreach ($id in @(Expand-OptionalRuntimeId $Id)) {
    if ($selected -contains $id) { return $true }
  }
  return $false
}

function ConvertTo-JsonStringArray([string[]]$Items) {
  $bits = New-Object System.Collections.Generic.List[string]
  foreach ($item in @($Items)) {
    if ($null -eq $item) { continue }
    $s = [string]$item
    if (-not $s) { continue }
    [void]$bits.Add(('"' + ($s -replace '\\', '\\' -replace '"', '\"') + '"'))
  }
  if ($bits.Count -eq 0) { return '[]' }
  return '[' + ($bits -join ',') + ']'
}

function Save-OptionalRuntimeSelection {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string[]]$Selected = @()
  )
  $valid = Get-OptionalRuntimeIds
  $sel = New-Object System.Collections.Generic.List[string]
  foreach ($id in @($Selected)) {
    foreach ($clean in @(Expand-OptionalRuntimeId $id)) {
      if ($clean -and ($valid -contains $clean) -and -not $sel.Contains($clean)) {
        [void]$sel.Add($clean)
      }
    }
  }
  $skipped = New-Object System.Collections.Generic.List[string]
  foreach ($id in $valid) {
    if (-not $sel.Contains($id)) { [void]$skipped.Add($id) }
  }
  $destDir = Join-Path $Root 'data\config'
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  $stamp = Get-Date -Format o
  $json = @"
{
  "version": 1,
  "selected": $(ConvertTo-JsonStringArray @($sel)),
  "skipped": $(ConvertTo-JsonStringArray @($skipped)),
  "updated_at": "$stamp"
}
"@
  [IO.File]::WriteAllText((Get-OptionalRuntimeSelectionPath $Root), $json.Trim() + "`n", [Text.UTF8Encoding]::new($false))
}

function Resolve-OptionalRuntimeSelection {
  param(
    [string]$Root = '',
    [string]$OptionalRuntimes = '',
    [switch]$AllOptional,
    [switch]$ApplyCatalogDefaults
  )
  if ($env:MY_AGENT_INSTALL_SKIP_OPTIONAL -eq '1') { return @() }
  if ($AllOptional) { return Get-OptionalRuntimeIds }
  if ($OptionalRuntimes) { return ConvertTo-OptionalRuntimeIdList $OptionalRuntimes }
  if ($env:MY_AGENT_INSTALL_OPTIONAL) { return ConvertTo-OptionalRuntimeIdList $env:MY_AGENT_INSTALL_OPTIONAL }
  if ($ApplyCatalogDefaults) { return Get-DefaultOptionalRuntimeIds $Root }
  return @()
}

function Install-SelectedOptionalRuntimes {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string[]]$Selected = @()
  )
  $map = @{
    playwright   = 'tools\bootstrap-playwright-if-needed.ps1'
    ffmpeg       = 'tools\bootstrap-ffmpeg-if-needed.ps1'
    markitdown   = 'tools\bootstrap-markitdown-if-needed.ps1'
    repomix      = 'tools\bootstrap-repomix-if-needed.ps1'
    ast_grep     = 'tools\bootstrap-ast-grep-if-needed.ps1'
  }
  $labels = @{
    playwright   = 'Installing Playwright (browser tools, ~300MB)...'
    ffmpeg       = 'Installing ffmpeg (video attachment keyframes)...'
    markitdown   = 'Installing MarkItDown (Excel/PPT/email)...'
    repomix      = 'Installing Repomix (repo pack)...'
    ast_grep     = 'Installing ast-grep (structural search)...'
  }

  # Optional runtimes are best-effort: a failed/aborted optional (offline,
  # proxy, antivirus, or download timeout) must never abort the core install.
  # Run each optional bootstrap in an isolated child PowerShell process so a
  # child `exit` or terminating error cannot kill this installer, then downgrade
  # any non-zero result to a warning. Only the core (Node, npm deps) hard-fails.
  $psHost = $null
  try { $psHost = (Get-Process -Id $PID -ErrorAction SilentlyContinue).Path } catch { }
  if (-not $psHost -or -not (Test-Path -LiteralPath $psHost)) {
    $psHost = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  }
  if (-not (Test-Path -LiteralPath $psHost)) { $psHost = 'powershell.exe' }
  $optionalFailures = New-Object System.Collections.Generic.List[string]

  foreach ($id in @(Get-OptionalRuntimeIds)) {
    if (@($Selected) -notcontains $id) {
      Write-Host ""
      Write-Host "[SKIP] $id (not selected)"
      continue
    }
    $rel = $map[$id]
    $scriptPath = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $scriptPath)) {
      Write-Host ""
      Write-Host "WARN: missing $rel — skip $id"
      continue
    }
    Write-Host ""
    Write-Host $labels[$id]
    & $psHost -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Root $Root
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    if ($code -ne 0) {
      Write-Warning "optional runtime '$id' did not finish (exit $code). The core app is still installed; add it later from Settings > Features or by re-running the installer with internet access."
      [void]$optionalFailures.Add("$id (exit $code)")
    }
  }

  if ($optionalFailures.Count -gt 0) {
    Write-Host ""
    Write-Host ("Optional runtimes skipped or incomplete: " + ($optionalFailures -join ', '))
    Write-Host "These are optional. The core app is installed. Re-run the installer or use Settings > Features (with internet) to add them."
  }
}
