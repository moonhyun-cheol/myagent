#!/usr/bin/env node
/**
 * Build WorkKitLauncher UI + publish WPF exe to bin/work-kit-launcher.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(thisFile), '..');

function run(cmd, args, cwd, label) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    return { ok: false, reason: `launcher-publish: ${label} failed` };
  }
  return { ok: true };
}

export function publishWorkKitLauncher({
  root = defaultRoot,
  outDir = path.join(root, 'bin', 'work-kit-launcher'),
  label = 'launcher-publish',
} = {}) {
  const uiDir = path.join(root, 'ui', 'work-kit-launcher');
  const proj = path.join(root, 'shell', 'WorkKitLauncher', 'WorkKitLauncher.csproj');
  const uiDist = path.join(uiDir, 'dist');
  if (!existsSync(path.join(uiDir, 'package.json'))) {
    return { ok: false, reason: `${label}: missing ui/work-kit-launcher` };
  }
  if (!existsSync(proj)) {
    return { ok: false, reason: `${label}: missing ${proj}` };
  }

  const ci = run('npm', ['ci'], uiDir, 'npm ci (work-kit-launcher)');
  if (!ci.ok) return ci;
  const vite = run('npm', ['run', 'build'], uiDir, 'vite build');
  if (!vite.ok) return vite;
  if (!existsSync(path.join(uiDist, 'index.html'))) {
    return { ok: false, reason: `${label}: missing ${uiDist}/index.html` };
  }

  mkdirSync(outDir, { recursive: true });
  const publish = run(
    'dotnet',
    ['publish', proj, '-c', 'Release', '-o', outDir, '-v', 'q'],
    root,
    'dotnet publish WorkKitLauncher',
  );
  if (!publish.ok) return publish;

  const executable = path.join(outDir, 'WorkKitLauncher.exe');
  if (!existsSync(executable)) {
    return { ok: false, reason: `${label}: missing ${executable}` };
  }
  return { ok: true, executable, outDir, uiDist };
}

const launchedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (launchedDirectly) {
  const result = publishWorkKitLauncher({ root: defaultRoot });
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
  console.log(`launcher-publish OK → ${result.executable}`);
}
