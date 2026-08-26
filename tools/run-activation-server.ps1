#requires -Version 5.1
<#
.SYNOPSIS
  Background runner for MY Agent activation server (no pause window).
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root

$node = 'node'
$portable = Join-Path $root 'runtime\node\node.exe'
if (Test-Path -LiteralPath $portable) {
    $node = $portable
}

$script = Join-Path $root 'tools\activation-server.mjs'
if (-not (Test-Path -LiteralPath $script)) {
    Write-Error "Missing $script"
}

& $node $script
