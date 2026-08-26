#!/usr/bin/env node
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishShell } from './shell-publish.mjs';
import { publishUpdater } from './updater-publish.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'bin', 'my-agent');
const result = publishShell({
  root,
  projPath: path.join(root, 'shell', 'CqrPa.Shell', 'CqrPa.Shell.csproj'),
  outDir,
  label: 'build:exe',
});

if (!result.ok) {
  console.error(result.reason);
  process.exit(1);
}

const publishedExe = path.join(outDir, 'MYAgent.exe');
const productExe = path.join(root, 'MYAgent.exe');
if (!existsSync(publishedExe)) {
  console.error(`build:exe: missing publish output: ${publishedExe}`);
  process.exit(1);
}
cpSync(publishedExe, productExe);
console.log(`build:exe: ${productExe}`);

const updaterOut = path.join(root, 'bin', 'my-agent-updater');
const updater = publishUpdater({
  root,
  outDir: updaterOut,
  label: 'build:exe',
});
if (!updater.ok) {
  console.error(updater.reason);
  process.exit(1);
}
const productUpdater = path.join(root, 'MYAgent.Updater.exe');
cpSync(updater.executable, productUpdater);
console.log(`build:exe: ${productUpdater}`);
