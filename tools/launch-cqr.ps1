#requires -Version 5.1
<#
.SYNOPSIS
  MY Agent launcher - first-run bootstrap with splash, then start shell.
#>
param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'

function Get-NormalizedRoot([string]$path) {
  if (-not $path) { throw 'Root path is required.' }
  $clean = $path.Trim().TrimEnd('"').Trim()
  if ($clean.EndsWith('\.')) { $clean = $clean.Substring(0, $clean.Length - 2) }
  if (-not $clean.EndsWith('\')) { $clean += '\' }
  $full = [IO.Path]::GetFullPath($clean)
  if (-not $full.EndsWith('\')) { $full += '\' }
  return $full
}

function Test-NeedsFirstRunBootstrap([string]$AppRoot) {
  if (-not (Test-Path -LiteralPath (Join-Path $AppRoot 'runtime\node\node.exe'))) { return $true }

  if (-not (Test-Path -LiteralPath (Join-Path $AppRoot 'core\dist\main.js'))) { return $true }

  $shellCandidates = @(
    (Join-Path $AppRoot 'bin\cqr-pa\cqr-pa.exe'),
    (Join-Path $AppRoot 'shell\CqrPa.Shell\bin\Release\net8.0-windows\cqr-pa.exe')
  )
  foreach ($candidate in $shellCandidates) {
    if (Test-Path -LiteralPath $candidate) { return $false }
  }
  return $true
}

function Resolve-ShellExe([string]$AppRoot) {
  $candidates = @(
    (Join-Path $AppRoot 'bin\cqr-pa\cqr-pa.exe'),
    (Join-Path $AppRoot 'shell\CqrPa.Shell\bin\Release\net8.0-windows\cqr-pa.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  $outDir = Join-Path $AppRoot 'bin\cqr-pa'
  $csproj = Join-Path $AppRoot 'shell\CqrPa.Shell\CqrPa.Shell.csproj'
  if (-not (Test-Path -LiteralPath $csproj)) {
    throw "WebView2 shell missing. Expected: $($candidates[0])"
  }

  $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
  if (-not $dotnet -or -not $dotnet.Source) {
    throw 'WebView2 shell missing and .NET SDK (dotnet) not found. Reinstall from the published zip (bin\cqr-pa), or install .NET 8 SDK.'
  }
  & $dotnet.Source publish $csproj -c Release -o $outDir -v q
  if ($LASTEXITCODE -ne 0) {
    throw 'WebView2 shell publish failed. Install .NET 8 SDK and run: dotnet publish shell\CqrPa.Shell\CqrPa.Shell.csproj -c Release -o bin\cqr-pa'
  }

  $published = Join-Path $outDir 'cqr-pa.exe'
  if (-not (Test-Path -LiteralPath $published)) {
    throw "Missing shell after publish: $published"
  }
  return $published
}

function Invoke-ExternalStep {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$StepLabel,
    [string]$WorkingDirectory
  )

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $quotedArgs = $ArgumentList | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
  }
  $psi.Arguments = $quotedArgs -join ' '

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  $stdout = New-Object System.Text.StringBuilder
  $stderr = New-Object System.Text.StringBuilder
  $proc.add_OutputDataReceived({
    if ($null -ne $EventArgs.Data) { [void]$stdout.AppendLine($EventArgs.Data) }
  })
  $proc.add_ErrorDataReceived({
    if ($null -ne $EventArgs.Data) { [void]$stderr.AppendLine($EventArgs.Data) }
  })
  if (-not $proc.Start()) { throw "$StepLabel failed to start." }
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()
  # Keep the first-run WinForms splash responsive while large downloads run.
  # A blocking WaitForExit/direct `& script.ps1` froze the marquee for minutes.
  while (-not $proc.HasExited) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 80
  }
  try { $proc.WaitForExit(2000) | Out-Null } catch { }
  if ($proc.ExitCode -ne 0) {
    $detail = (($stderr.ToString() + "`n" + $stdout.ToString()).Trim())
    if ($detail.Length -gt 900) { $detail = '...' + $detail.Substring($detail.Length - 900) }
    if ($detail) {
      throw "$StepLabel failed (exit $($proc.ExitCode)).`n$detail"
    }
    throw "$StepLabel failed (exit $($proc.ExitCode))."
  }
}

function Invoke-BootstrapScript {
  param(
    [string]$ScriptPath,
    [string]$StepLabel,
    [string]$AppRoot
  )
  if (-not (Test-Path -LiteralPath $ScriptPath)) {
    throw "$StepLabel script missing: $ScriptPath"
  }
  $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Invoke-ExternalStep `
    -FilePath $powershellExe `
    -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', $ScriptPath,
      '-Root', $AppRoot
    ) `
    -StepLabel $StepLabel `
    -WorkingDirectory $AppRoot
}

function Invoke-BootstrapWithSplash {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'MY Agent'
  $form.Size = New-Object System.Drawing.Size(460, 170)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.TopMost = $true
  $form.ShowInTaskbar = $true

  $title = New-Object System.Windows.Forms.Label
  $title.AutoSize = $false
  $title.Size = New-Object System.Drawing.Size(420, 28)
  $title.Location = New-Object System.Drawing.Point(20, 18)
  $title.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $title.Text = 'MY Agent first-run setup'
  $title.TextAlign = 'MiddleCenter'
  $form.Controls.Add($title)

  $status = New-Object System.Windows.Forms.Label
  $status.AutoSize = $false
  $status.Size = New-Object System.Drawing.Size(420, 48)
  $status.Location = New-Object System.Drawing.Point(20, 52)
  $status.TextAlign = 'MiddleCenter'
  $status.Text = 'Starting...'
  $form.Controls.Add($status)

  $bar = New-Object System.Windows.Forms.ProgressBar
  $bar.Style = 'Marquee'
  $bar.MarqueeAnimationSpeed = 30
  $bar.Size = New-Object System.Drawing.Size(420, 18)
  $bar.Location = New-Object System.Drawing.Point(20, 108)
  $form.Controls.Add($bar)

  $script:setStatus = {
    param([string]$Message)
    $status.Text = $Message
    [System.Windows.Forms.Application]::DoEvents()
  }

  $form.Add_Shown({
    try {
      & $setStatus 'Checking Node runtime...'
      $bootstrapNode = Join-Path $Root 'tools\bootstrap-node-if-needed.ps1'
      Invoke-BootstrapScript -ScriptPath $bootstrapNode -StepLabel 'Node bootstrap' -AppRoot $Root.TrimEnd('\')

      $nodeExe = Join-Path $Root 'runtime\node\node.exe'
      if (-not (Test-Path -LiteralPath $nodeExe)) {
        throw 'Portable Node missing: runtime\node\node.exe'
      }

      $optionalHelper = Join-Path $Root 'tools\install\optional-runtimes.ps1'
      if (Test-Path -LiteralPath $optionalHelper) {
        . $optionalHelper
        $wanted = @()
        $sel = Read-OptionalRuntimeSelection $Root.TrimEnd('\')
        if ($sel) {
          $wanted = @($sel.selected | Where-Object { $_ })
        } else {
          $wanted = @(Get-DefaultOptionalRuntimeIds $Root.TrimEnd('\'))
        }
        if ($wanted.Count -gt 0) {
          & $setStatus 'Installing selected optional features...'
          Install-SelectedOptionalRuntimes -Root $Root.TrimEnd('\') -Selected $wanted
        }
      }

      $bootstrapNpmDeps = Join-Path $Root 'tools\bootstrap-npm-deps-if-needed.ps1'
      & $setStatus 'Installing runtime npm dependencies...'
      Invoke-BootstrapScript -ScriptPath $bootstrapNpmDeps -StepLabel 'Runtime npm dependency bootstrap' -AppRoot $Root.TrimEnd('\')

      $mainJs = Join-Path $Root 'core\dist\main.js'
      if (-not (Test-Path -LiteralPath $mainJs)) {
        & $setStatus 'Building app...'
        $buildScript = Join-Path $Root 'tools\build.mjs'
        Invoke-ExternalStep -FilePath $nodeExe -ArgumentList @($buildScript) -StepLabel 'App build' -WorkingDirectory $Root.TrimEnd('\')
      }

      $shellExe = Join-Path $Root 'bin\cqr-pa\cqr-pa.exe'
      $altShell = Join-Path $Root 'shell\CqrPa.Shell\bin\Release\net8.0-windows\cqr-pa.exe'
      if (-not (Test-Path -LiteralPath $shellExe) -and -not (Test-Path -LiteralPath $altShell)) {
        & $setStatus 'Preparing UI shell...'
      }

      & $setStatus 'Launching MY Agent...'
      $shell = Resolve-ShellExe $Root
      Start-Process -FilePath $shell -WorkingDirectory $Root.TrimEnd('\')
      $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
    } catch {
      [System.Windows.Forms.MessageBox]::Show(
        $_.Exception.Message,
        'MY Agent launch failed',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
      ) | Out-Null
      $form.DialogResult = [System.Windows.Forms.DialogResult]::Abort
    } finally {
      $form.Close()
    }
  })

  [void]$form.ShowDialog()
  $form.Dispose()

  if ($form.DialogResult -eq [System.Windows.Forms.DialogResult]::Abort) { exit 1 }
}

$Root = Get-NormalizedRoot $Root
$env:MY_AGENT_ROOT = $Root.TrimEnd('\')
Set-Location -LiteralPath $Root.TrimEnd('\')

if (Test-NeedsFirstRunBootstrap $Root) {
  Invoke-BootstrapWithSplash
  exit 0
}

$bootstrapPlaywright = Join-Path $Root 'tools\bootstrap-playwright-if-needed.ps1'
$optionalHelper = Join-Path $Root 'tools\install\optional-runtimes.ps1'
$wantPlaywright = $false
if (Test-Path -LiteralPath $optionalHelper) {
  . $optionalHelper
  $wantPlaywright = Test-OptionalRuntimeSelected -Root $Root.TrimEnd('\') -Id 'playwright'
}
if ((Test-Path -LiteralPath $bootstrapPlaywright) -and $wantPlaywright) {
  & $bootstrapPlaywright -Root $Root.TrimEnd('\') | Out-Null
}

if ((Test-Path -LiteralPath $optionalHelper) -and $env:MY_AGENT_INSTALL_SKIP_OPTIONAL -ne '1') {
  $sidecarIds = @()
  foreach ($id in @('markitdown', 'repomix', 'ast_grep')) {
    if (Test-OptionalRuntimeSelected -Root $Root.TrimEnd('\') -Id $id) { $sidecarIds += $id }
  }
  if ($sidecarIds.Count -gt 0) {
    Install-SelectedOptionalRuntimes -Root $Root.TrimEnd('\') -Selected $sidecarIds
  }
}

$bootstrapNpmDeps = Join-Path $Root 'tools\bootstrap-npm-deps-if-needed.ps1'
if (Test-Path -LiteralPath $bootstrapNpmDeps) {
  & $bootstrapNpmDeps -Root $Root.TrimEnd('\')
  if ($LASTEXITCODE -ne 0) {
    Write-Warning 'Runtime npm dependencies missing — API may fail to start until tools\bootstrap-npm-deps.ps1 succeeds.'
  }
}

$shellExe = Resolve-ShellExe $Root
Start-Process -FilePath $shellExe -WorkingDirectory $Root.TrimEnd('\')
exit 0
