#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectBuildLanes, RELEASE_BUILD_LANES, runBuildLanes } from './build-lanes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check-only');
const allowDirty = args.has('--allow-dirty') || process.env.MY_AGENT_RELEASE_ALLOW_DIRTY === '1';

function fail(message) {
  throw new Error(message);
}

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
}

function runNode(relative, extra = []) {
  const result = spawnSync(process.execPath, [path.join(root, relative), ...extra], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) fail(`${relative} failed`);
}

function validateVersionState() {
  const manifest = readJson('manifest.json');
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const version = String(manifest.version ?? '').trim();
  const channel = String(manifest.update_channel ?? '').trim().toLowerCase();
  const sequence = Number(manifest.update_sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) fail('invalid update_sequence');
  if (channel === 'beta' && !/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) {
    fail('beta release requires x.y.z-beta.N');
  }
  if (channel === 'stable' && !/^\d+\.\d+\.\d+$/.test(version)) {
    fail('stable release requires x.y.z');
  }
  if (pkg.version !== version || lock.version !== version || lock.packages?.['']?.version !== version) {
    fail('manifest/package/package-lock versions differ');
  }
  return { manifest, version, channel, sequence };
}

function assertCleanSource() {
  if (allowDirty) return;
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (status.status !== 0) fail('git status failed');
  if (status.stdout.trim()) fail('release requires a clean working tree');
}

function assertFresh(status) {
  const stale = RELEASE_BUILD_LANES.filter((lane) => status[lane].stale);
  if (stale.length) {
    fail(`stale release artifacts: ${stale.map((lane) => `${lane}:${status[lane].reason}`).join(', ')}`);
  }
}

try {
  const versionState = validateVersionState();
  assertCleanSource();
  let status;
  let built = [];
  if (checkOnly) {
    status = inspectBuildLanes(root);
  } else {
    const result = runBuildLanes(root, { lanes: RELEASE_BUILD_LANES });
    status = result.status;
    built = result.built;
  }
  assertFresh(status);

  if (String(readJson('package.json').name ?? '') === 'my-custom-codex') {
    runNode('tools/verify-public-boundary.mjs', ['--strict']);
  } else {
    console.warn('release-preflight: public-boundary strict gate skipped for non-core package');
  }

  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const record = {
    schema: 'my-agent-release-preflight/v1',
    created_at: new Date().toISOString(),
    revision: revision.status === 0 ? revision.stdout.trim() : null,
    version: versionState.version,
    channel: versionState.channel,
    update_sequence: versionState.sequence,
    built,
    lane_hashes: Object.fromEntries(
      RELEASE_BUILD_LANES.map((lane) => [
        lane,
        { source: status[lane].source, output: status[lane].output },
      ]),
    ),
  };
  const output = path.join(root, 'deploy', 'output', 'release-preflight.json');
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  if (!existsSync(output)) fail('release preflight record was not written');
  console.log(`release-preflight OK: ${record.version} sequence=${record.update_sequence}`);
} catch (error) {
  console.error(`release-preflight FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
