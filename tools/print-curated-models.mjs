#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(path.join(root, 'data', 'owui-models-snapshot.json'), 'utf8').replace(/^\uFEFF/, '');
const ids = JSON.parse(raw);
const mod = await import(
  pathToFileURL(path.join(root, 'core', 'dist', 'providers', 'remote-model-curate.js')).href
);
const curated = mod.curateRemoteModels(ids);
for (const m of curated) {
  console.log(m.displayName);
}
console.log('---', curated.length, 'of', ids.length);
