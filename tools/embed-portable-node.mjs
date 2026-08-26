#!/usr/bin/env node
/**
 * Copy current Node.js binary into runtime/node/ for portable installs.
 * Windows: copyFileSync fails (EBUSY) when source is the running node.exe — use read/write.
 */
import {
  mkdirSync,
  copyFileSync,
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destDir = path.join(root, 'runtime', 'node');
const destExe = path.join(destDir, 'node.exe');
const versionFile = path.join(destDir, 'node.version.txt');

const srcExe = process.execPath;
if (!existsSync(srcExe)) {
  console.error('embed-portable-node: node executable not found');
  process.exit(1);
}

function sameFileSize(a, b) {
  try {
    return statSync(a).size === statSync(b).size;
  } catch {
    return false;
  }
}

/** @returns {'skipped' | 'copied'} */
function copyFileRobust(src, dest) {
  if (existsSync(dest) && sameFileSize(src, dest)) {
    return 'skipped';
  }
  try {
    copyFileSync(src, dest);
    return 'copied';
  } catch (err) {
    if (err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES') {
      writeFileSync(dest, readFileSync(src));
      return 'copied';
    }
    throw err;
  }
}

mkdirSync(destDir, { recursive: true });

const nodeResult = copyFileRobust(srcExe, destExe);
writeFileSync(versionFile, `${process.version}\n${process.arch}\n`, 'utf8');

const srcDir = path.dirname(srcExe);
for (const name of readdirSync(srcDir)) {
  if (/^(node|icu).*\.(dll|exe)$/i.test(name) && name.toLowerCase() !== path.basename(srcExe).toLowerCase()) {
    const s = path.join(srcDir, name);
    if (statSync(s).isFile()) {
      copyFileRobust(s, path.join(destDir, name));
    }
  }
}

const mb = (statSync(destExe).size / (1024 * 1024)).toFixed(1);
const note = nodeResult === 'skipped' ? ' (unchanged, skipped)' : '';
console.log(`embed-portable-node OK -> ${destExe} (${mb} MB)${note} ${process.version}`);
