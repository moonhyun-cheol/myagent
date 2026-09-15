#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'tools', 'release-critical-ui-journeys.json');
const validateOnly = process.argv.includes('--validate-only');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const preflightSource = readFileSync(path.join(root, 'tools', 'release-preflight.mjs'), 'utf8');
const installPublisherSource = readFileSync(path.join(root, 'tools', 'publish.mjs'), 'utf8');
const deltaPublisherSource = readFileSync(path.join(root, 'tools', 'publish-delta.mjs'), 'utf8');

assert.match(preflightSource, /runNode\('tools\/verify-release-critical-ui-journeys\.mjs'\)/, 'release preflight must execute the journey registry');
assert.match(installPublisherSource, /release-preflight\.mjs/, 'install publisher must not bypass release preflight');
assert.match(deltaPublisherSource, /release-preflight\.mjs/, 'delta publisher must not bypass release preflight');
assert.equal(manifest.schema, 'my-agent-release-critical-ui-journeys/v1');
assert.match(String(manifest.policy ?? ''), /merged, replaced, or removed/);
assert.ok(Array.isArray(manifest.journeys) && manifest.journeys.length > 0, 'critical UI journeys are required');

const ids = new Set();
const verifiers = new Set();
for (const journey of manifest.journeys) {
  assert.match(String(journey.id ?? ''), /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'journey id must be stable kebab-case');
  assert.ok(!ids.has(journey.id), `duplicate journey id: ${journey.id}`);
  ids.add(journey.id);
  assert.ok(['browser', 'contract-and-bundle'].includes(journey.verification), `invalid verification level: ${journey.id}`);
  assert.ok(Array.isArray(journey.preserves) && journey.preserves.length > 0, `preserved capabilities required: ${journey.id}`);
  assert.ok(journey.preserves.every((item) => typeof item === 'string' && item.trim().length >= 12), `capabilities must describe outcomes: ${journey.id}`);
  assert.match(String(journey.verifier ?? ''), /^tools\/verify-[a-z0-9-]+\.mjs$/);
  assert.ok(!verifiers.has(journey.verifier), `one verifier must own one journey: ${journey.verifier}`);
  verifiers.add(journey.verifier);
  assert.ok(existsSync(path.join(root, journey.verifier)), `missing verifier: ${journey.verifier}`);
}

if (!validateOnly) {
  for (const journey of manifest.journeys) {
    console.log(`release-critical-ui: ${journey.id} (${journey.verification})`);
    const result = spawnSync(process.execPath, [path.join(root, journey.verifier)], { cwd: root, stdio: 'inherit' });
    assert.equal(result.status, 0, `${journey.id} failed via ${journey.verifier}`);
  }
}

console.log(`release-critical UI journeys: PASS (${manifest.journeys.length}${validateOnly ? ' validated' : ' exercised'})`);
