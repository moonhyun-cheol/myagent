#!/usr/bin/env node
/**
 * One-command developer launch from a git clone.
 * Product users still use MYAgent-v*-install.zip — not this script.
 */
import { cpSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, label) {
  console.log(`dev-run: ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`dev-run: ${label} failed`);
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(path.join(root, 'node_modules'))) {
  run('npm', ['install'], 'npm install');
}
if (!existsSync(path.join(root, 'ui', 'workspace', 'node_modules'))) {
  run('npm', ['--prefix', 'ui/workspace', 'install'], 'workspace npm install');
}

run(process.execPath, [path.join(root, 'tools', 'build-smart.mjs')], 'build:smart');

const publishedExe = path.join(root, 'bin', 'my-agent', 'MYAgent.exe');
const productExe = path.join(root, 'MYAgent.exe');
if (!existsSync(publishedExe)) {
  run(process.execPath, [path.join(root, 'tools', 'build-windows-exe.mjs')], 'build:exe');
} else {
  cpSync(publishedExe, productExe);
}

if (!existsSync(productExe)) {
  console.error('dev-run: MYAgent.exe missing after build (.NET 8 SDK required for first shell publish)');
  process.exit(1);
}

console.log(`dev-run: launch ${productExe}`);
const child = spawn(productExe, [], {
  cwd: root,
  detached: true,
  stdio: 'ignore',
});
child.unref();
