#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFileSync(path.join(root, relative), 'utf8');
const temp = mkdtempSync(path.join(os.tmpdir(), 'cqr-pa-update-bridge-'));

try {
  const privatePath = path.join(temp, 'update-private.pem');
  const publicPath = path.join(temp, 'update-public.pem');
  const keygenArgs = [
    path.join(root, 'tools', 'update-admin.mjs'),
    'keygen',
    '--private', privatePath,
    '--public', publicPath,
  ];
  const generated = spawnSync(process.execPath, keygenArgs, { encoding: 'utf8' });
  assert.equal(generated.status, 0, `${generated.stdout ?? ''}${generated.stderr ?? ''}`);
  assert.equal(existsSync(privatePath), true);
  assert.equal(existsSync(publicPath), true);
  assert.doesNotMatch(readFileSync(privatePath, 'utf8'), /PUBLIC KEY/);
  assert.match(readFileSync(publicPath, 'utf8'), /BEGIN PUBLIC KEY/);

  const status = spawnSync(
    process.execPath,
    [
      path.join(root, 'tools', 'update-admin.mjs'),
      'status',
      '--private', privatePath,
      '--public', publicPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(status.status, 0, `${status.stdout ?? ''}${status.stderr ?? ''}`);
  assert.match(status.stdout, /Update signing key: VALID/);

  const overwrite = spawnSync(process.execPath, keygenArgs, { encoding: 'utf8' });
  assert.notEqual(overwrite.status, 0, 'keygen must refuse to overwrite an existing signing key');

  const delta = read('tools/publish-delta.mjs');
  assert.match(delta, /stageDir, 'MYAgent\.Updater\.exe'/);
  assert.match(delta, /stageDir, 'bin', 'my-agent', 'MYAgent\.Updater\.exe'/);
  const updateService = read('shell/CqrPa.Shell/UpdateService.cs');
  assert.match(updateService, /Path\.Combine\(root, "MYAgent\.Updater\.exe"\)/);
  assert.match(updateService, /Path\.Combine\(root, "bin", "my-agent", "MYAgent\.Updater\.exe"\)/);
  const apply = read('tools/update/apply-delta.ps1');
  assert.match(apply, /'bin\\my-agent'/, 'renamed shell path must remain allowlisted');
  const bridge = read('tools/publish-update-bridge.mjs');
  assert.match(bridge, /update_sequence 1/);
  assert.match(bridge, /LATEST_UPDATE_BRIDGE\.json/);
  assert.match(bridge, /run UPDATE\.bat once/);

  console.log('verify-update-bridge: ok');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
