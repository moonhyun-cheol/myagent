import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundleRuntimePackage } from './bundle-runtime-package.mjs';
import { buildPayloadManifest } from './update/update-signing.mjs';

const root = process.cwd();
const temp = mkdtempSync(path.join(os.tmpdir(), 'myagent-delta-ssh-'));
try {
  bundleRuntimePackage(root, temp, 'ssh2');
  writeFileSync(path.join(temp, 'probe.cjs'), `const ssh = require('ssh2'); const assert = require('node:assert/strict'); assert.equal(typeof ssh.Client, 'function'); assert.equal(typeof ssh.Server, 'function'); assert(ssh.utils.parseKey(ssh.utils.generateKeyPairSync('ed25519').private)); console.log('isolated SSH runtime: PASS');`);
  const run = spawnSync(process.execPath, [path.join(temp, 'probe.cjs')], {
    cwd: temp, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const files = buildPayloadManifest(temp, {
    updateSequence: 75, minimumSupportedSequence: 1, version: '1.1.27', channel: 'stable', deleted: [],
  }).files;
  assert(files.some((file) => file.path === 'node_modules/ssh2/package.json'));
  assert(!files.some((file) => file.path.endsWith('.node')));
  assert.match(readFileSync(path.join(root, 'tools/publish-delta.mjs'), 'utf8'), /bundleRuntimePackage\(root, stageDir, 'ssh2'\)/);
  console.log('PASS isolated SSH client/server/key generation, signed-payload paths and no native ABI dependency');
} finally {
  rmSync(temp, { recursive: true, force: true });
}