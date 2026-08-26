#!/usr/bin/env node
/** Schema/golden checks for capability-scorecard catalog. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(root, 'tools/fpv/scorecard/capability-scorecard.json');
assert.ok(existsSync(catalogPath), 'catalog missing');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

assert.equal(catalog.version, 1);
assert.ok(Array.isArray(catalog.items));
assert.ok(catalog.items.length >= 20, 'expect ≥20 capability items');
assert.equal(catalog.rubric.total, 100);

const ids = new Set();
for (const item of catalog.items) {
  assert.ok(item.id && item.label, 'id/label required');
  assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
  ids.add(item.id);
  assert.ok(item.baseline >= 0 && item.baseline <= 100);
  assert.ok(['P0', 'P1', 'P2', 'P3'].includes(item.priority));
  assert.ok(item.evidence && typeof item.evidence === 'object');
  assert.ok(Array.isArray(item.improveIds) && item.improveIds.length >= 1);
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const item of catalog.items) {
  for (const v of item.evidence.verifies || []) {
    assert.ok(pkg.scripts?.[v], `package.json missing script ${v} (from ${item.id})`);
  }
}

console.log(`verify-capability-scorecard: ok (${catalog.items.length} items)`);
