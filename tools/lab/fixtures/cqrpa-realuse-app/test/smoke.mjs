#!/usr/bin/env node
/**
 * Fixture-level smoke — no browser. Validates DOM ids ↔ app boot + pure math.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
const mathPath = path.join(root, 'src', 'lib', 'math.js');

for (const id of ['title', 'status', 'a', 'b', 'calc', 'result']) {
  assert.match(html, new RegExp(`id="${id}"`));
  assert.ok(
    app.includes(`$('${id}')`) || app.includes(`$("${id}")`) || app.includes(`getElementById('${id}')`),
    `app.js must reference #${id}`,
  );
}

assert.ok(existsSync(mathPath));
const { sum } = await import(pathToFileURL(mathPath).href);
assert.equal(sum(2, 3), 5);
assert.equal(sum(-1, 1), 0);

console.log('cqrpa-realuse-app test OK');
