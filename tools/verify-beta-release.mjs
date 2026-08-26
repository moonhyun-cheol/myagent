#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

assert.equal(manifest.update_channel, 'beta');
assert.match(manifest.version, /^\d+\.\d+\.\d+-beta\.\d+$/);
assert.ok(Number.isSafeInteger(manifest.update_sequence) && manifest.update_sequence > 0);
assert.equal(pkg.version, manifest.version);
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages?.['']?.version, manifest.version);

const updateService = read('shell/CqrPa.Shell/UpdateService.cs');
assert.match(updateService, /update\.Sequence <= _currentSequence/);
assert.doesNotMatch(updateService, /Version\.TryParse|SemanticVersion|SemVer/);

const publishDelta = read('tools/publish-delta.mjs');
assert.match(publishDelta, /MY_AGENT_BUILD_PREFLIGHT_DONE/);
assert.match(publishDelta, /--assert-fresh/);
const publishGitHub = read('tools/publish-github-update.mjs');
assert.match(publishGitHub, /existing secure update artifacts do not match manifest\.json/);

function run(script, args = []) {
  return spawnSync(process.execPath, [path.join(root, 'tools', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MY_AGENT_RELEASE_ALLOW_DIRTY: '1' },
  });
}

const noOp = run('build-smart.mjs');
assert.equal(noOp.status, 0, noOp.stderr || noOp.stdout);
const noOpJson = JSON.parse(noOp.stdout.slice(noOp.stdout.indexOf('{')));
assert.deepEqual(noOpJson.built, []);

const fresh = run('release-preflight.mjs', ['--check-only', '--allow-dirty']);
assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);

const receiptPath = path.join(root, '.build', 'build-receipt.json');
const originalReceipt = readFileSync(receiptPath, 'utf8');
try {
  const damaged = JSON.parse(originalReceipt);
  damaged.lanes.core.output = '0'.repeat(64);
  writeFileSync(receiptPath, `${JSON.stringify(damaged, null, 2)}\n`, 'utf8');
  const stale = run('release-preflight.mjs', ['--check-only', '--allow-dirty']);
  assert.notEqual(stale.status, 0, 'release preflight must reject a stale receipt');
  assert.match(`${stale.stdout}\n${stale.stderr}`, /stale release artifacts: core:output_changed/);
} finally {
  writeFileSync(receiptPath, originalReceipt, 'utf8');
}

console.log(
  `verify-beta-release OK: ${manifest.version} sequence=${manifest.update_sequence}, smart no-op, stale blocked`,
);
