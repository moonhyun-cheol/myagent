#!/usr/bin/env node
/**
 * Verifies the producer side of the install-root pointer contract
 * (%LOCALAPPDATA%\MYAgent\install-root.json):
 *  1) installer writes it right after INSTALL-DONE.txt (PowerShell writer + install.ps1 wiring)
 *  2) core boot writes it (createApiServer) and self-heals after deletion
 *  3) unwritable LOCALAPPDATA never blocks install/boot
 *  4) moved root -> pointer updated to the new path
 * Run after `tsc -p tsconfig.json` (imports core/dist).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'myagent-pointer-'));
const results = [];
const pass = (name, detail) => { results.push(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

const { writeInstallRootPointer, resolveInstallRootPointerPath } = await import(
  pathToFileURL(path.join(repo, 'core', 'dist', 'setup', 'install-root-pointer.js')).href
);
const readPointer = (local) => JSON.parse(readFileSync(resolveInstallRootPointerPath(local), 'utf8'));

function makeRoot(name, version) {
  const root = path.join(tmp, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ version }), 'utf8');
  return root;
}

function runPs(script, env) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return r;
}

try {
  // ---- (1) installer side -------------------------------------------------------------
  const install = readFileSync(path.join(repo, 'tools', 'install', 'install.ps1'), 'utf8');
  const markerAt = install.indexOf('Move-Item -LiteralPath $completionTemp -Destination $completionMarker -Force');
  const pointerAt = install.indexOf('Write-InstallRootPointer -Root $targetFull');
  const commitAt = install.indexOf('Complete-InstallProductTransaction $installTransaction');
  assert.ok(markerAt > 0 && pointerAt > markerAt && pointerAt < commitAt, 'install.ps1 must write pointer right after INSTALL-DONE.txt');
  assert.match(install.slice(markerAt, commitAt), /try \{[\s\S]*Write-InstallRootPointer[\s\S]*\} catch \{/, 'installer pointer write must be wrapped');

  const psLocal = path.join(tmp, 'ps-local');
  const psRoot = makeRoot('ps-install', '9.9.9');
  const writer = path.join(repo, 'tools', 'install', 'install-root-pointer.ps1');
  let r = runPs(`. '${writer}'; $ok = Write-InstallRootPointer -Root '${psRoot}'; Write-Output "RESULT=$ok"; exit 0`, { LOCALAPPDATA: psLocal });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESULT=True/);
  let doc = readPointer(psLocal);
  assert.equal(doc.install_root, psRoot);
  assert.equal(doc.cqr_root, psRoot);
  assert.equal(doc.manifest_version, '9.9.9');
  assert.match(doc.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  pass('installer writes pointer after INSTALL-DONE', doc.install_root);

  // Unwritable LOCALAPPDATA: "MYAgent" exists as a FILE, so CreateDirectory must fail.
  const psBad = path.join(tmp, 'ps-bad');
  mkdirSync(psBad, { recursive: true });
  writeFileSync(path.join(psBad, 'MYAgent'), 'blocker');
  r = runPs(`$ErrorActionPreference='Stop'; . '${writer}'; $ok = Write-InstallRootPointer -Root '${psRoot}'; Write-Output "RESULT=$ok"; Write-Output 'INSTALL_CONTINUED'; exit 0`, { LOCALAPPDATA: psBad });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESULT=False/);
  assert.match(r.stdout, /INSTALL_CONTINUED/);
  assert.match(r.stdout + r.stderr, /INSTALL_ROOT_POINTER_WRITE_FAILED/);
  pass('installer non-blocking when LOCALAPPDATA unwritable (ErrorActionPreference=Stop)');

  // ---- (2)(4) core writer unit --------------------------------------------------------
  const local = path.join(tmp, 'local');
  const rootA = makeRoot('rootA', '1.0.0');
  let res = writeInstallRootPointer(rootA, { localAppData: local });
  assert.equal(res.ok, true, res.error);
  assert.equal(readPointer(local).install_root, rootA);
  rmSync(res.path);
  res = writeInstallRootPointer(rootA, { localAppData: local });
  assert.equal(res.ok, true);
  assert.equal(readPointer(local).install_root, rootA);
  pass('core writer self-heals deleted pointer');
  const rootB = path.join(tmp, 'rootB-moved');
  cpSync(rootA, rootB, { recursive: true });
  rmSync(rootA, { recursive: true, force: true });
  res = writeInstallRootPointer(rootB, { localAppData: local });
  assert.equal(readPointer(local).install_root, rootB);
  assert.ok(!readFileSync(res.path, 'utf8').includes('rootA'));
  pass('moved root updates pointer', rootB);
  const leftovers = (await import('node:fs')).readdirSync(path.dirname(res.path)).filter((f) => f.endsWith('.tmp'));
  assert.equal(leftovers.length, 0, 'atomic write must not leave temp files');
  const bad = path.join(tmp, 'bad');
  mkdirSync(bad);
  writeFileSync(path.join(bad, 'MYAgent'), 'blocker');
  const logged = [];
  res = writeInstallRootPointer(rootB, { localAppData: bad, log: (l) => logged.push(l) });
  assert.equal(res.ok, false);
  assert.ok(logged.length === 1);
  pass('core writer swallows errors + logs');

  // ---- (2)(3) real core boot (createApiServer) ----------------------------------------
  const bootScript = (local) => `
    process.env.LOCALAPPDATA = ${JSON.stringify(local)};
    const { createApiServer } = await import(${JSON.stringify(pathToFileURL(path.join(repo, 'core', 'dist', 'api-server.js')).href)});
    const server = await createApiServer(0);
    await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
    console.log('BOOT_LISTENING');
    server.close();
    setTimeout(() => process.exit(0), 300);
  `;
  const boot = (localDir) => spawnSync(process.execPath, ['--input-type=module', '-e', bootScript(localDir)], {
    cwd: repo,
    env: { ...process.env, MY_AGENT_ROOT: repo, LOCALAPPDATA: localDir },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const bootLocal = path.join(tmp, 'boot-local');
  let b = boot(bootLocal);
  assert.match(b.stdout, /BOOT_LISTENING/, b.stderr);
  assert.equal(readPointer(bootLocal).install_root, repo);
  pass('core boot writes pointer', readPointer(bootLocal).install_root);
  rmSync(resolveInstallRootPointerPath(bootLocal));
  b = boot(bootLocal);
  assert.match(b.stdout, /BOOT_LISTENING/, b.stderr);
  assert.ok(existsSync(resolveInstallRootPointerPath(bootLocal)));
  pass('core reboot recreates deleted pointer (self-heal)');
  const bootBad = path.join(tmp, 'boot-bad');
  mkdirSync(bootBad);
  writeFileSync(path.join(bootBad, 'MYAgent'), 'blocker');
  b = boot(bootBad);
  assert.match(b.stdout, /BOOT_LISTENING/, b.stderr);
  pass('core boot non-blocking when LOCALAPPDATA unwritable');

  console.log(results.join('\n'));
  console.log('verify-install-root-pointer: OK');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
