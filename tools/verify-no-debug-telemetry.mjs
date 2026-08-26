#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanRoots = ['core/src', 'ui/workspace/src', 'shell'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx|cs|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

const forbidden = ['127.0.0.1:7742', '7742/ingest'];
const hits = [];
for (const relRoot of scanRoots) {
  const abs = path.join(root, relRoot);
  for (const file of walk(abs)) {
    const text = readFileSync(file, 'utf8');
    for (const needle of forbidden) {
      if (text.includes(needle)) hits.push(`${path.relative(root, file)}:${needle}`);
    }
  }
}

assert.equal(hits.length, 0, `undeclared debug telemetry found:\n${hits.join('\n')}`);
console.log('verify-no-debug-telemetry: PASS');
