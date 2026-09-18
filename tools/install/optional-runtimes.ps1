#requires -Version 5.1
# Shared optional-runtime catalog + install helpers (ASCII script; labels live in UTF-8 JSON).

function Get-OptionalRuntimeIds {
  return @('playwright', 'ffmpeg', 'markitdown', 'repomix', 'ast_grep')
}

function Test-OptionalRuntimeCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @('--version')
  )
  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { return $false }
  try {
    if (-not (Get-Command Invoke-CqrNativeTimed -ErrorAction SilentlyContinue)) {
      . (Join-Path $Root 'tools\cqr-native.ps1')
    }
    return (Invoke-CqrNativeTimed -FilePath $FilePath -ArgumentList $ArgumentList -TimeoutSec 20 -WorkingDirectory $Root) -eq 0
  } catch {
    return $false
  }
}

function Test-OptionalRuntimeInstalled {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Id
  )
  switch ($Id) {
    'playwright' {
      $pkg = Join-Path $Root 'runtime\playwright\package\node_modules\playwright\package.json'
      $marker = Join-Path $Root 'runtime\playwright\browsers\.chromium-installed'
      $versionOk = $false
      if (Test-Path -LiteralPath $pkg) {
        try { $versionOk = ([string]((Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).version) -eq '1.52.0') } catch { $versionOk = $false }
      }
      $browser = @(Get-ChildItem -LiteralPath (Join-Path $Root 'runtime\playwright\browsers') -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('chrome.exe', 'headless_shell.exe') } | Select-Object -First 1)
      return $versionOk -and (Test-Path -LiteralPath $marker) -and $browser.Count -gt 0
    }
    'ffmpeg' { return Test-OptionalRuntimeCommand -Root $Root -FilePath (Join-Path $Root 'runtime\ffmpeg\ffmpeg.exe') -ArgumentList @('-version') }
    'markitdown' { return Test-OptionalRuntimeCommand -Root $Root -FilePath (Join-Path $Root 'runtime\oss-sidecars\venv\Scripts\markitdown.exe') -ArgumentList @('--help') }
    'repomix' {
      $packageRoot = Join-Path $Root 'runtime\oss-sidecars\node_modules\repomix'
      $pkgPath = Join-Path $packageRoot 'package.json'
      $nodeExe = Join-Path $Root 'runtime\node\node.exe'
      if (-not (Test-Path -LiteralPath $pkgPath) -or -not (Test-Path -LiteralPath $nodeExe)) { return $false }
      try {
        $pkg = [IO.File]::ReadAllText($pkgPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
        $binRel = if ($pkg.bin -is [string]) { [string]$pkg.bin } else { [string]$pkg.bin.repomix }
        if (-not $binRel) { return $false }
        return Test-OptionalRuntimeCommand -Root $Root -FilePath $nodeExe -ArgumentList @((Join-Path $packageRoot $binRel), '--version')
      } catch { return $false }
    }
    'ast_grep' { return Test-OptionalRuntimeCommand -Root $Root -FilePath (Join-Path $Root 'runtime\oss-sidecars\bin\ast-grep.exe') -ArgumentList @('--version') }
    default { return $false }
  }
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
  # Missing/corrupt catalog data must not trigger any implicit network install.
  # A valid catalog below may still opt in explicitly safe defaults.
  $fallback = @()
  $catalog = Get-OptionalRuntimeCatalog $Root
  if (-not $catalog) { return $fallback }
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($item in @($catalog.optional_runtimes)) {
    $id = [string]$item.id
    if ($id -and [bool]$item.default_selected) { [void]$out.Add($id) }
  }
  # A valid catalog may intentionally select nothing. Fall back only when the
  # catalog itself is unavailable or invalid, not when its default set is empty.
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
    [string[]]$Selected = @(),
    [string[]]$Installed = @(),
    [string[]]$Failed = @()
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
  "version": 2,
  "selected": $(ConvertTo-JsonStringArray @($sel)),
  "requested": $(ConvertTo-JsonStringArray @($sel)),
  "installed": $(ConvertTo-JsonStringArray @($Installed)),
  "failed": $(ConvertTo-JsonStringArray @($Failed)),
  "skipped": $(ConvertTo-JsonStringArray @($skipped)),
  "updated_at": "$stamp"
}
"@
  $destPath = Get-OptionalRuntimeSelectionPath $Root
  $tempPath = $destPath + '.tmp'
  [IO.File]::WriteAllText($tempPath, $json.Trim() + "`n", [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tempPath -Destination $destPath -Force
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
  if ($ApplyCatalogDefaults) {
    $existing = Read-OptionalRuntimeSelection $Root
    if ($existing) {
      return ConvertTo-OptionalRuntimeIdList (@($existing.selected) -join ',')
    }
    return Get-DefaultOptionalRuntimeIds $Root
  }
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
  $optionalInstalled = New-Object System.Collections.Generic.List[string]

  foreach ($id in @(Get-OptionalRuntimeIds)) {
    if (@($Selected) -notcontains $id) {
      Write-Host ""
      Write-Host "[SKIP] $id (not selected)"
      if (Test-OptionalRuntimeInstalled -Root $Root -Id $id) { [void]$optionalInstalled.Add($id) }
      continue
    }
    $rel = $map[$id]
    $scriptPath = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $scriptPath)) {
      Write-Host ""
      Write-Host "WARN: missing $rel — skip $id"
      [void]$optionalFailures.Add($id)
      continue
    }
    Write-Host ""
    Write-Host $labels[$id]
    $code = 1
    $previousErrorAction = $ErrorActionPreference
    try {
      # Child tools legitimately write progress/notices to stderr. Keep those
      # records visible without allowing one optional installer to terminate the
      # required product transaction.
      $ErrorActionPreference = 'Continue'
      & $psHost -NoProfile -ExecutionPolicy Bypass -File $scriptPath -Root $Root 2>&1 |
        ForEach-Object { Write-Host ([string]$_) }
      if ($null -ne $LASTEXITCODE) { $code = [int]$LASTEXITCODE }
    } catch {
      Write-Warning "optional runtime '$id' could not start: $($_.Exception.Message)"
      $code = 1
    } finally {
      $ErrorActionPreference = $previousErrorAction
    }
    if ($code -ne 0 -or -not (Test-OptionalRuntimeInstalled -Root $Root -Id $id)) {
      Write-Warning "optional runtime '$id' did not finish (exit $code). The core app is still installed; add it later from Settings > Features or by re-running the installer with internet access."
      [void]$optionalFailures.Add($id)
    } else {
      [void]$optionalInstalled.Add($id)
    }
  }

  if ($optionalFailures.Count -gt 0) {
    Write-Host ""
    Write-Host ("Optional runtimes skipped or incomplete: " + ($optionalFailures -join ', '))
    Write-Host "These are optional. The core app is installed. Re-run the installer or use Settings > Features (with internet) to add them."
  }
  return [pscustomobject]@{ Installed = @($optionalInstalled); Failed = @($optionalFailures) }
}
