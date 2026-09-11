#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const pathsScript = read('tools/install/install-paths.ps1');
const installer = read('tools/install/install.ps1');
const installerUi = read('tools/install/install-ui.ps1');

assert.match(pathsScript, /function Get-CurrentUserInstallPath/);
assert.match(pathsScript, /LocalApplicationData/);
assert.doesNotMatch(pathsScript, /\$env:PUBLIC/);
assert.match(pathsScript, /Move-Item -LiteralPath \$source -Destination \$moved/);
assert.match(installer, /does not allow create, rename, and delete/);
assert.match(installer, /Installed folder is not fully writable/);
for (const required of ["'data\\vault'", "'data\\config'", "'data\\sessions'"]) {
  assert.ok(installer.includes(required), `missing post-copy writable probe: ${required}`);
}
assert.match(installerUi, /Controlled Folder Access/);
assert.match(installerUi, /Folder permission blocked installation/);

const temp = mkdtempSync(path.join(os.tmpdir(), 'my-agent-install-permissions-'));
try {
  const scriptPath = path.join(root, 'tools', 'install', 'install-paths.ps1');
  const writable = path.join(temp, 'writable');
  const notDirectory = path.join(temp, 'not-a-directory');
  writeFileSync(notDirectory, 'x');
  const escapePs = (value) => value.replaceAll("'", "''");
  const scriptFiles = [
    path.join(root, 'tools', 'install', 'install-paths.ps1'),
    path.join(root, 'tools', 'install', 'install.ps1'),
    path.join(root, 'tools', 'install', 'install-ui.ps1'),
  ];
  const parserCommand = [
    `$failed = $false`,
    ...scriptFiles.map((file) => {
      const escaped = escapePs(file);
      return `$tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; $failed = $true }`;
    }),
    `if ($failed) { exit 1 }`,
    `'initial-install-powershell-parse: PASS'`,
  ].join('; ');
  const parseResult = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', parserCommand], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(parseResult.status, 0, parseResult.stderr || parseResult.stdout);
  assert.match(parseResult.stdout, /initial-install-powershell-parse: PASS/);

  const command = [
    `. '${escapePs(scriptPath)}'`,
    `$ok = Test-InstallPathCandidateWritable '${escapePs(writable)}'`,
    `$blocked = Test-InstallPathCandidateWritable '${escapePs(notDirectory)}'`,
    `if (-not $ok) { throw 'writable probe failed' }`,
    `if ($blocked) { throw 'non-directory target was accepted' }`,
    `$env:MY_AGENT_INSTALL_DEFAULT = '${escapePs(writable)}'`,
    `$picked = Get-DefaultInstallPath`,
    `if ($picked -ne '${escapePs(writable)}') { throw ('override mismatch: ' + $picked) }`,
    `'initial-install-permission-runtime: PASS'`,
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /initial-install-permission-runtime: PASS/);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('verify-initial-install-permissions: ok');
