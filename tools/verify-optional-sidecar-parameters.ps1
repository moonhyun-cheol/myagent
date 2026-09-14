#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$files = @(
  'tools/bootstrap-oss-sidecars.ps1',
  'tools/bootstrap-markitdown-if-needed.ps1',
  'tools/bootstrap-repomix-if-needed.ps1',
  'tools/bootstrap-ast-grep-if-needed.ps1'
)
foreach ($relativePath in $files) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $root $relativePath),
    [ref]$tokens,
    [ref]$errors
  )
  if ($errors.Count) {
    throw "$relativePath parse failure: $($errors[0].Message)"
  }
}

# Validate the -Only* parameter contract on EVERY bootstrap-oss-sidecars.ps1 in
# the repo, including staged/published copies under deploy/output. A stale
# receiver there is exactly what shipped the install crash:
#   "매개 변수 이름 'OnlyMarkitdown'과(와) 일치하는 매개 변수를 찾을 수 없습니다"
# because bootstrap-markitdown-if-needed.ps1 calls it with -OnlyMarkitdown.
$required = @('OnlyMarkitdown', 'OnlyRepomix', 'OnlyAstGrep')
# Only the product's own trees: source tools/ and staged/published deploy/output.
# Exclude read-only mirrors (.my_agent_remote) and dependency folders.
$scanRoots = @(
  (Join-Path $root 'tools'),
  (Join-Path $root 'deploy/output')
) | Where-Object { Test-Path -LiteralPath $_ }
$receivers = @(
  foreach ($scanRoot in $scanRoots) {
    Get-ChildItem -Path $scanRoot -Recurse -File -Filter 'bootstrap-oss-sidecars.ps1' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '[\\/](\.my_agent_remote|node_modules)[\\/]' }
  }
)
if ($receivers.Count -eq 0) {
  throw 'no bootstrap-oss-sidecars.ps1 found under repo root'
}
foreach ($receiver in $receivers) {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $receiver.FullName,
    [ref]$tokens,
    [ref]$errors
  )
  if ($errors.Count) {
    throw "$($receiver.FullName) parse failure: $($errors[0].Message)"
  }
  $parameterNames = @($ast.ParamBlock.Parameters.Name.VariablePath.UserPath)
  foreach ($name in $required) {
    if ($parameterNames -notcontains $name) {
      throw "$($receiver.FullName) is missing -$name (stale copy would crash the installer)"
    }
  }
}

Write-Host "optional sidecar installer parameter contract: PASS ($($receivers.Count) receiver script(s))"
