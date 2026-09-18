#requires -Version 5.1
# Shared completion checks for the isolated Playwright package and Chromium bundle.

$script:MyAgentPlaywrightVersion = '1.52.0'

function Get-PlaywrightBrowserExecutable {
  param([Parameter(Mandatory = $true)][string]$BrowsersDir)
  if (-not (Test-Path -LiteralPath $BrowsersDir)) { return $null }
  return Get-ChildItem -LiteralPath $BrowsersDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'chrome.exe' -or $_.Name -eq 'headless_shell.exe' } |
    Select-Object -First 1
}

function Test-PlaywrightChromiumBundle {
  param([Parameter(Mandatory = $true)][string]$BrowsersDir)
  $marker = Join-Path $BrowsersDir '.chromium-installed'
  return (Test-Path -LiteralPath $marker) -and $null -ne (Get-PlaywrightBrowserExecutable -BrowsersDir $BrowsersDir)
}

function Test-PlaywrightRuntime {
  param([Parameter(Mandatory = $true)][string]$Root)
  $packageJson = Join-Path $Root 'runtime\playwright\package\node_modules\playwright\package.json'
  if (-not (Test-Path -LiteralPath $packageJson)) { return $false }
  try {
    $version = [string](([IO.File]::ReadAllText($packageJson, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json).version)
    if ($version -ne $script:MyAgentPlaywrightVersion) { return $false }
  } catch {
    return $false
  }
  return Test-PlaywrightChromiumBundle -BrowsersDir (Join-Path $Root 'runtime\playwright\browsers')
}

function Enable-PlaywrightLocalhostPolicy {
  param([Parameter(Mandatory = $true)][string]$Root)
  $configPath = Join-Path $Root 'data\config\user-overrides.json'
  $configDir = Split-Path -Parent $configPath
  if (-not (Test-Path -LiteralPath $configDir)) {
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  }
  $overridesObj = $null
  if (Test-Path -LiteralPath $configPath) {
    try {
      $overridesObj = [IO.File]::ReadAllText($configPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    } catch {
      $invalidBackup = $configPath + '.invalid-' + (Get-Date -Format 'yyyyMMddHHmmssfff') + '.bak'
      Copy-Item -LiteralPath $configPath -Destination $invalidBackup -Force
      throw "PLAYWRIGHT_POLICY_CONFIG_INVALID: preserved the invalid user-overrides.json unchanged at $invalidBackup"
    }
  }
  if (-not $overridesObj) { $overridesObj = New-Object PSObject }
  if ($overridesObj.playwright_allow_localhost -eq $true) { return }
  $overridesObj | Add-Member -NotePropertyName playwright_allow_localhost -NotePropertyValue $true -Force
  $temp = $configPath + '.playwright-policy.tmp'
  try {
    [IO.File]::WriteAllText($temp, (($overridesObj | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $configPath -Force
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
  Write-Host 'bootstrap-playwright: enabled playwright_allow_localhost in data\config\user-overrides.json'
}
